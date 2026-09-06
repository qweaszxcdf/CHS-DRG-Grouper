const fs = require('fs');
const path = require('path');
const { pinyin } = require('pinyin-pro');
const { createDrgConfigResolver } = require('./lib/drg_config.cjs');
const { parseIcdPackageDatLine, resolvePackageChain } = require('./lib/icd_package.cjs');
const { writeFileIfChanged } = require('./lib/write_if_changed.cjs');

const projectRoot = path.resolve(__dirname, '..');
const configResolver = createDrgConfigResolver(projectRoot);
const icdDatasetRoot = path.join(projectRoot, 'src/data/icd-datasets');
const clinicalPackageRoot = path.join(icdDatasetRoot, 'clinical');
const insurancePackageRoot = path.join(icdDatasetRoot, 'insurance');

const ROMAN_TO_ARABIC = {
  '\u2160':'1','\u2161':'2','\u2162':'3','\u2163':'4','\u2164':'5',
  '\u2165':'6','\u2166':'7','\u2167':'8','\u2168':'9','\u2169':'10',
  '\u216A':'11','\u216B':'12','\u216C':'50','\u216D':'100','\u216E':'500','\u216F':'1000',
  '\u2170':'1','\u2171':'2','\u2172':'3','\u2173':'4','\u2174':'5',
  '\u2175':'6','\u2176':'7','\u2177':'8','\u2178':'9','\u2179':'10',
  '\u217A':'11','\u217B':'12','\u217C':'50','\u217D':'100','\u217E':'500','\u217F':'1000',
};
const ROMAN_REGEX = /[\u2160-\u2188]/g;

/**
 * Compute pinyin initials string for a name.
 * Roman numerals → Arabic digits; symbols stripped; Latin letters kept.
 */
function computeInitials(name) {
  if (!name) return '';
  try {
    const romanReplaced = name.replace(ROMAN_REGEX, ch => ROMAN_TO_ARABIC[ch] || ch);
    const cleaned = romanReplaced.replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]/g, '');
    return pinyin(cleaned, { pattern: 'first', toneType: 'none', separator: '', nonZh: 'consecutive' }).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Build an initials map from a name map (code -> name).
 * Returns { code: initials } — entries with empty initials are omitted.
 */
function buildInitialsMap(nameMap) {
  const out = {};
  for (const [code, name] of Object.entries(nameMap)) {
    const ini = computeInitials(name);
    if (ini) out[code] = ini;
  }
  return out;
}

/**
 * Normalize an ICD code token.
 * - trim, strip surrounding quotes
 * - normalize dagger (†) to plus ('+')
 * - remove common invisible characters
 * @param {string} code
 * @returns {string|null}
 */
function normalize(code) {
  if (!code) return null;
  return String(code)
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\u2020|†/g, '+')
    .replace(/[\uFEFF\u200B]/g, '');
}

function normalizeCrosswalkCode(code) {
  const normalized = normalize(code)?.replace(/\s+/g, '');
  if (!normalized) return null;
  const tumorMatch = normalized.match(/^(.+?)M\d{5}\/\d+$/);
  return tumorMatch ? tumorMatch[1] : normalized;
}

// Parse package-scoped ICD .dat files to build independent datasets.
/**
 * Read a .dat file and return non-empty trimmed lines.
 * Required package inputs fail the build when missing or unreadable.
 * @param {string} filePath
 * @returns {string[]}
 */
function readDatFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required DAT file: ${filePath}`);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`Unable to read required DAT file ${filePath}: ${error.message}`, { cause: error });
  }
}

function buildGrayCodeMap(filePath) {
  const out = {};
  for (const line of readDatFile(filePath)) {
    const entry = parseIcdPackageDatLine(line);
    const code = normalize(entry?.code);
    if (code) {
      out[code] = !entry.removed;
    }
  }
  return out;
}

const ALLOWED_CROSSWALKS = new Set([
  'ICD9GL2YB.expanded.dat',
  'ICD10GL2YB.expanded.dat'
]);

function readCodeSet(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  const codes = new Set();
  for (const line of readDatFile(filePath)) {
    const code = normalizeCrosswalkCode(line.match(/^\S+/)?.[0]);
    if (code) codes.add(code);
  }
  return codes;
}

function readExplicitCrosswalk(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing explicit crosswalk source: ${filePath}`);
  const mapping = new Map();
  for (const line of readDatFile(filePath)) {
    const match = line.match(/^(\S+)\s+(\S+)$/);
    if (!match) continue;
    const glCode = normalizeCrosswalkCode(match[1]);
    const ybCode = normalizeCrosswalkCode(match[2]);
    if (glCode && ybCode && !mapping.has(glCode)) mapping.set(glCode, ybCode);
  }
  return mapping;
}

function hasExplicitCrosswalkSources(crosswalkDir) {
  return ['ICD10', 'ICD9'].every(type => (
    fs.existsSync(path.join(crosswalkDir, 'raw', `${type}GL2YB.explicit.dat`))
  ));
}

function readEffectiveExplicitCrosswalk(clinicalId, insuranceId, type, cache = new Map()) {
  const combination = `${clinicalId}__${insuranceId}`;
  const cacheKey = `${combination}:${type}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const clinicalChain = resolvePackageChain(clinicalPackageRoot, clinicalId);
  const insuranceChain = resolvePackageChain(insurancePackageRoot, insuranceId);
  const parentClinicalId = clinicalChain.length > 1
    ? clinicalChain[clinicalChain.length - 2].id
    : clinicalId;
  const parentInsuranceId = insuranceChain.length > 1
    ? insuranceChain[insuranceChain.length - 2].id
    : insuranceId;
  const crosswalkDir = path.join(projectRoot, 'src/data/crosswalks', combination);
  const explicitPath = path.join(crosswalkDir, 'raw', `${type}GL2YB.explicit.dat`);
  let mapping;

  if (parentClinicalId === clinicalId && parentInsuranceId === insuranceId) {
    mapping = readExplicitCrosswalk(explicitPath);
  } else {
    mapping = new Map(readEffectiveExplicitCrosswalk(
      parentClinicalId,
      parentInsuranceId,
      type,
      cache,
    ));
    if (fs.existsSync(explicitPath)) {
      for (const [glCode, ybCode] of readExplicitCrosswalk(explicitPath)) {
        mapping.set(glCode, ybCode);
      }
    }
  }

  cache.set(cacheKey, mapping);
  return mapping;
}

function readPackageCodeSet(packageRoot, packageId, filename, label) {
  const chain = resolvePackageChain(packageRoot, packageId);
  const codes = new Set();
  const removedCodes = new Set();

  for (const [index, packageInfo] of chain.entries()) {
    const sourcePath = path.join(packageInfo.dir, 'raw', filename);
    if (!fs.existsSync(sourcePath)) {
      if (index === 0) throw new Error(`Missing ${label}: ${sourcePath}`);
      continue;
    }
    for (const line of readDatFile(sourcePath)) {
      const entry = parseIcdPackageDatLine(line);
      const code = normalizeCrosswalkCode(entry?.code);
      if (!code) continue;
      if (entry.removed) removedCodes.add(code);
      else codes.add(code);
    }
  }

  for (const code of removedCodes) codes.delete(code);
  return codes;
}

function collectExpandedCrosswalk(
  clinicalId,
  insuranceId,
  crosswalkSourceDir,
  type,
  explicitMapping = null,
) {
  const explicitPath = path.join(crosswalkSourceDir, 'raw', `${type}GL2YB.explicit.dat`);
  const glCodes = readPackageCodeSet(clinicalPackageRoot, clinicalId, `${type}GL.dat`, 'clinical ICD source');
  const ybCodes = readPackageCodeSet(insurancePackageRoot, insuranceId, `${type}YB.dat`, 'insurance ICD source');
  const explicit = explicitMapping || readExplicitCrosswalk(explicitPath);
  const entries = [];
  let fallbackCount = 0;
  let unmatchedCount = 0;

  for (const glCode of glCodes) {
    const ybCode = explicit.get(glCode) || glCode;
    if (!explicit.has(glCode)) {
      fallbackCount++;
      if (!ybCodes.has(glCode)) unmatchedCount++;
    }
    entries.push([glCode, ybCode]);
  }

  entries.sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }));
  return { entries, fallbackCount, unmatchedCount };
}

function buildExpandedCrosswalk(
  clinicalId,
  insuranceId,
  crosswalkSourceDir,
  crosswalkOutputDir,
  type,
) {
  const expandedPath = path.join(crosswalkOutputDir, 'raw', `${type}GL2YB.expanded.dat`);
  const result = collectExpandedCrosswalk(
    clinicalId,
    insuranceId,
    crosswalkSourceDir,
    type,
  );
  const { entries, fallbackCount, unmatchedCount } = result;
  writeFileIfChanged(expandedPath, `${entries.map(([gl, yb]) => `${gl} ${yb}`).join('\n')}\n`, 'utf8');
  console.log(
    `Expanded crosswalk generated: ${path.basename(expandedPath)} ` +
    `(${entries.length} entries, ${fallbackCount} fallbacks, ${unmatchedCount} unmatched)`
  );
  return path.basename(expandedPath);
}

function buildCrosswalkMap(entries, nameDB_gl, nameDB_yb, sourceFile) {
  const mapping = {};
  for (const [glCode, ybCode] of entries) {
    mapping[glCode] = {
      glCode,
      ybCode,
      glName: nameDB_gl[glCode] || null,
      ybName: nameDB_yb[ybCode] || null,
      sourceFile,
    };
  }
  return mapping;
}

function compactCrosswalkMap(mapping) {
  const compact = {};
  for (const [code, entry] of Object.entries(mapping)) {
    if (entry?.ybCode && entry.ybCode !== code) compact[code] = entry.ybCode;
  }
  return compact;
}

function readCompactCrosswalkMap(crosswalkDir, filename, { required = true } = {}) {
  const filePath = path.join(crosswalkDir, 'generated', filename);
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Missing generated crosswalk dependency: ${filePath}`);
    return {};
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data && typeof data.mapping === 'object' && !Array.isArray(data.mapping)
    ? data.mapping
    : {};
}

function readEffectiveCrosswalkMap(clinicalId, insuranceId, filename, cache = new Map()) {
  const combination = `${clinicalId}__${insuranceId}`;
  const cacheKey = `${combination}:${filename}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const clinicalChain = resolvePackageChain(clinicalPackageRoot, clinicalId);
  const insuranceChain = resolvePackageChain(insurancePackageRoot, insuranceId);
  const crosswalkDir = path.join(projectRoot, 'src/data/crosswalks', combination);

  const parentClinicalId = clinicalChain.length > 1
    ? clinicalChain[clinicalChain.length - 2].id
    : clinicalId;
  const parentInsuranceId = insuranceChain.length > 1
    ? insuranceChain[insuranceChain.length - 2].id
    : insuranceId;
  let mapping;

  if (parentClinicalId === clinicalId && parentInsuranceId === insuranceId) {
    if (!fs.existsSync(crosswalkDir)) {
      throw new Error(`Missing generated crosswalk dependency: ${crosswalkDir}`);
    }
    mapping = readCompactCrosswalkMap(crosswalkDir, filename);
  } else {
    mapping = {
      ...readEffectiveCrosswalkMap(parentClinicalId, parentInsuranceId, filename, cache),
      ...readCompactCrosswalkMap(crosswalkDir, filename, { required: false }),
    };
    const removedPath = path.join(crosswalkDir, 'generated', 'removed_codes.json');
    if (fs.existsSync(removedPath)) {
      const removed = JSON.parse(fs.readFileSync(removedPath, 'utf8'));
      const field = filename === 'icd_gl_yb_map.json' ? 'icdGlToYbRaw' : 'icd9GlToYbRaw';
      for (const code of removed[field] ?? []) delete mapping[code];
    }
  }

  cache.set(cacheKey, mapping);
  return mapping;
}

function buildCrosswalkDiff(mapping, inheritedMapping) {
  const current = compactCrosswalkMap(mapping);
  const patch = {};
  for (const [code, ybCode] of Object.entries(current)) {
    if (inheritedMapping[code] !== ybCode) patch[code] = ybCode;
  }
  const removed = Object.keys(inheritedMapping)
    .filter(code => !Object.prototype.hasOwnProperty.call(current, code))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return { mapping: patch, removed };
}

function writeCrosswalkMap(crosswalkDir, filename, mapping) {
  writeFileIfChanged(
    path.join(crosswalkDir, 'generated', filename),
    JSON.stringify({ mapping: compactCrosswalkMap(mapping) }, null, 2),
    'utf8',
  );
}

function writeCrosswalkDiff(crosswalkDir, filename, diff) {
  const outputPath = path.join(crosswalkDir, 'generated', filename);
  if (Object.keys(diff.mapping).length === 0) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }
  writeFileIfChanged(
    outputPath,
    JSON.stringify({ mapping: diff.mapping }, null, 2),
    'utf8',
  );
}

function writeCrosswalkRemovedCodes(crosswalkDir, removedCodes) {
  const outputPath = path.join(crosswalkDir, 'generated', 'removed_codes.json');
  const payload = Object.fromEntries(
    Object.entries(removedCodes).filter(([, codes]) => codes.length > 0),
  );
  if (Object.keys(payload).length === 0) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }
  writeFileIfChanged(outputPath, JSON.stringify(payload, null, 2), 'utf8');
}

function removeDerivedCrosswalkArtifacts(crosswalkDir) {
  for (const relativePath of [
    'raw/ICD10GL2YB.expanded.dat',
    'raw/ICD9GL2YB.expanded.dat',
    'generated/ICD10GL2YB_gray.csv',
    'generated/ICD9GL2YB_gray.csv',
  ]) {
    const filePath = path.join(crosswalkDir, relativePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  for (const directory of [
    path.join(crosswalkDir, 'raw'),
    path.join(crosswalkDir, 'generated'),
    crosswalkDir,
  ]) {
    if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
  }
}

/**
 * Build crosswalk maps (GL -> YB) using approved crosswalk files.
 * Returns { icd10Map, icd9Map } where keys are GL codes.
 */
function buildCrosswalkMaps(datasetDir, files, nameDB_gl, nameDB_yb) {
  const icd10Map = {};
  const icd9Map = {};
  const crosswalks = files.filter(f => ALLOWED_CROSSWALKS.has(f));
  if (crosswalks.length === 0) throw new Error(`No allowed crosswalk files found in ${datasetDir}`);

  for (const f of crosswalks) {
    const p = path.join(datasetDir, f);
    const lines = readDatFile(p);
    const isICD9 = /icd9|icd-9|9cm3/i.test(f);
    for (const line of lines) {
      const m = line.match(/^(\S+)\s+(\S+)$/);
      if (!m) continue;
      const left = normalize(m[1]);
      const right = normalize(m[2]);
      const entry = {
        glCode: left,
        ybCode: right,
        glName: nameDB_gl[left] || null,
        ybName: nameDB_yb[right] || null,
        sourceFile: f
      };
      if (isICD9) icd9Map[left] = entry; else icd10Map[left] = entry;
    }
  }

  return { icd10Map, icd9Map };
}

/**
 * Split a combined name DB into `diag` and `proc` maps by code prefix.
 * Diagnosis codes commonly start with a letter; procedures start with a digit.
 * @param {Object} nameDB
 * @returns {{diag:Object,proc:Object}}
 */
function splitNameDBs(nameDB) {
  const diag = {};
  const proc = {};
  for (const [code, name] of Object.entries(nameDB)) {
    if (/^[A-Za-z]/.test(code)) diag[code] = name; else proc[code] = name;
  }
  return { diag, proc };
}

function parseNamePackage(packageRoot, packageId, filenames, { deltaOnly = false } = {}) {
  const chain = resolvePackageChain(packageRoot, packageId);
  const packageEntries = deltaOnly ? [chain[chain.length - 1]] : chain;
  const names = {};

  for (const [index, packageInfo] of packageEntries.entries()) {
    const packageNames = {};
    const requireAll = index === 0 && (chain.length === 1 || !deltaOnly);
    for (const filename of filenames) {
      const sourcePath = path.join(packageInfo.dir, 'raw', filename);
      if (!fs.existsSync(sourcePath)) {
        if (requireAll) throw new Error(`Missing ICD package source: ${sourcePath}`);
        continue;
      }
      for (const line of readDatFile(sourcePath)) {
        const entry = parseIcdPackageDatLine(line);
        if (!entry || entry.removed || !entry.value) continue;
        const code = normalize(entry.code);
        if (code && !packageNames[code]) packageNames[code] = entry.value;
      }
    }
    Object.assign(names, packageNames);
  }

  return names;
}

function readRemovedCodes(packageDir, filenames) {
  const removed = new Set();
  for (const filename of filenames) {
    const sourcePath = path.join(packageDir, 'raw', filename);
    if (!fs.existsSync(sourcePath)) continue;
    for (const line of readDatFile(sourcePath)) {
      const entry = parseIcdPackageDatLine(line);
      const code = normalize(entry?.code);
      if (entry?.removed && code) removed.add(code);
    }
  }
  return removed;
}

function writeNameMaps(packageDir, prefix, maps, isOverlay) {
  for (const [map, output] of [
    [maps.diag, `icd_${prefix}_names_diag.json`],
    [maps.proc, `icd_${prefix}_names_proc.json`],
  ]) {
    const outputPath = path.join(packageDir, 'generated', output);
    if (isOverlay && Object.keys(map).length === 0) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      continue;
    }
    writeFileIfChanged(outputPath, JSON.stringify(withInitials(map), null, 2), 'utf8');
  }
}

function writeRemovedCodes(packageDir, filenames) {
  const outputPath = path.join(packageDir, 'generated', 'removed_codes.json');
  const removed = [...readRemovedCodes(packageDir, filenames)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (removed.length === 0) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    return;
  }
  writeFileIfChanged(outputPath, JSON.stringify(removed, null, 2), 'utf8');
}

function withInitials(nameMap) {
  return { ...nameMap, _initials: buildInitialsMap(nameMap) };
}

function ensureGeneratedDir(packageDir) {
  fs.mkdirSync(path.join(packageDir, 'generated'), { recursive: true });
}

function buildClinicalPackage(packageId) {
  const packageDir = path.join(clinicalPackageRoot, packageId);
  const chain = resolvePackageChain(clinicalPackageRoot, packageId);
  const isOverlay = chain.length > 1;
  const names = parseNamePackage(
    clinicalPackageRoot,
    packageId,
    ['ICD10GL.dat', 'ICD9GL.dat'],
    { deltaOnly: isOverlay },
  );
  ensureGeneratedDir(packageDir);
  writeNameMaps(packageDir, 'gl', splitNameDBs(names), isOverlay);
  writeRemovedCodes(packageDir, ['ICD10GL.dat', 'ICD9GL.dat']);
  console.log(`Clinical ICD package generated: ${packageId} (${Object.keys(names).length} names)`);
}

function buildInsurancePackage(packageId) {
  const packageDir = path.join(insurancePackageRoot, packageId);
  const chain = resolvePackageChain(insurancePackageRoot, packageId);
  const isOverlay = chain.length > 1;
  const names = parseNamePackage(
    insurancePackageRoot,
    packageId,
    ['ICD10YB.dat', 'ICD9YB.dat'],
    { deltaOnly: isOverlay },
  );
  const maps = splitNameDBs(names);
  ensureGeneratedDir(packageDir);
  writeNameMaps(packageDir, 'yb', maps, isOverlay);
  writeRemovedCodes(packageDir, ['ICD10YB.dat', 'ICD9YB.dat']);
  for (const [source, output] of [
    ['ICD10YB-灰码.dat', 'icd10_gray_codes.json'],
    ['ICD9YB-灰码.dat', 'icd9_gray_codes.json'],
  ]) {
    const sourcePath = path.join(packageDir, 'raw', source);
    const outputPath = path.join(packageDir, 'generated', output);
    if (!fs.existsSync(sourcePath)) {
      if (!isOverlay) throw new Error(`Missing insurance ICD source: ${sourcePath}`);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      continue;
    }
    const grayCodes = buildGrayCodeMap(sourcePath);
    if (isOverlay && Object.keys(grayCodes).length === 0) {
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      continue;
    }
    writeFileIfChanged(outputPath, JSON.stringify(grayCodes, null, 2), 'utf8');
  }
  console.log(`Insurance ICD package generated: ${packageId} (${Object.keys(names).length} names)`);
}

function readGeneratedNames(packageRoot, packageId, filenames) {
  const chain = resolvePackageChain(packageRoot, packageId);
  const names = {};
  const removedCodes = new Set();
  for (const [index, packageInfo] of chain.entries()) {
    for (const filename of filenames) {
      const filePath = path.join(packageInfo.dir, 'generated', filename);
      if (!fs.existsSync(filePath)) {
        if (index === 0) throw new Error(`Missing generated ICD dependency: ${filePath}`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [code, name] of Object.entries(data)) {
        if (code !== '_initials') names[code] = name;
      }
    }
    const removedPath = path.join(packageInfo.dir, 'generated', 'removed_codes.json');
    if (fs.existsSync(removedPath)) {
      for (const code of JSON.parse(fs.readFileSync(removedPath, 'utf8'))) {
        removedCodes.add(code);
      }
    }
  }
  for (const code of removedCodes) {
    delete names[code];
  }
  return names;
}

function readGeneratedGrayCodes(packageRoot, packageId, filename) {
  const chain = resolvePackageChain(packageRoot, packageId);
  const codes = new Set();
  for (const [index, packageInfo] of chain.entries()) {
    const filePath = path.join(packageInfo.dir, 'generated', filename);
    if (!fs.existsSync(filePath)) {
      if (index === 0) throw new Error(`Missing generated ICD dependency: ${filePath}`);
      continue;
    }
    const patch = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [code, enabled] of Object.entries(patch)) {
      if (enabled === true) codes.add(code);
      else if (enabled === false) codes.delete(code);
      else throw new Error(`Gray-code index value must be boolean: ${filePath} (${code})`);
    }
  }
  return codes;
}

function escapeCsv(value) {
  const raw = value == null ? '' : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

function writeCrosswalkCsv(mapping, grayCodes, outputPath) {
  const rows = Object.values(mapping)
    .sort((a, b) => a.glCode.localeCompare(b.glCode, 'en', { numeric: true }));
  const lines = ['GL,GL_NAME,YB,YB_NAME,YB_GRAY'];
  for (const entry of rows) {
    lines.push([
      entry.glCode,
      escapeCsv(entry.glName),
      entry.ybCode,
      escapeCsv(entry.ybName),
      grayCodes.has(entry.ybCode) ? '1' : '0',
    ].join(','));
  }
  writeFileIfChanged(outputPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  console.log(`Crosswalk CSV generated: ${path.basename(outputPath)} (${rows.length} rows)`);
}

function buildCrosswalkPackage(clinicalId, insuranceId) {
  const combination = `${clinicalId}__${insuranceId}`;
  const crosswalkDir = path.join(projectRoot, 'src/data/crosswalks', combination);
  const clinicalChain = resolvePackageChain(clinicalPackageRoot, clinicalId);
  const insuranceChain = resolvePackageChain(insurancePackageRoot, insuranceId);
  const isOverlay = clinicalChain.length > 1 || insuranceChain.length > 1;
  const parentClinicalId = clinicalChain.length > 1
    ? clinicalChain[clinicalChain.length - 2].id
    : clinicalId;
  const parentInsuranceId = insuranceChain.length > 1
    ? insuranceChain[insuranceChain.length - 2].id
    : insuranceId;
  const parentCombination = `${parentClinicalId}__${parentInsuranceId}`;
  const parentCrosswalkDir = path.join(projectRoot, 'src/data/crosswalks', parentCombination);
  let crosswalkSourceDir = crosswalkDir;
  let baseCrosswalkDir = null;
  if (isOverlay) {
    const parentGeneratedDir = path.join(parentCrosswalkDir, 'generated');
    if (!fs.existsSync(parentGeneratedDir)) {
      buildCrosswalkPackage(parentClinicalId, parentInsuranceId);
    }
    const baseCombination = `${clinicalChain[0].id}__${insuranceChain[0].id}`;
    baseCrosswalkDir = path.join(projectRoot, 'src/data/crosswalks', baseCombination);
    if (!hasExplicitCrosswalkSources(baseCrosswalkDir)) {
      throw new Error(`Missing inherited crosswalk source: ${baseCrosswalkDir}`);
    }
    if (!hasExplicitCrosswalkSources(crosswalkSourceDir)) {
      console.log(`Crosswalk source inherited: ${combination} <- ${baseCombination}`);
      crosswalkSourceDir = baseCrosswalkDir;
    }
  }
  const clinicalNames = readGeneratedNames(clinicalPackageRoot, clinicalId, ['icd_gl_names_diag.json', 'icd_gl_names_proc.json']);
  const insuranceNames = readGeneratedNames(insurancePackageRoot, insuranceId, ['icd_yb_names_diag.json', 'icd_yb_names_proc.json']);
  const icd10GrayCodes = readGeneratedGrayCodes(insurancePackageRoot, insuranceId, 'icd10_gray_codes.json');
  const icd9GrayCodes = readGeneratedGrayCodes(insurancePackageRoot, insuranceId, 'icd9_gray_codes.json');

  if (!isOverlay) {
    fs.mkdirSync(path.join(crosswalkDir, 'generated'), { recursive: true });
    const files = [
      buildExpandedCrosswalk(clinicalId, insuranceId, crosswalkSourceDir, crosswalkDir, 'ICD10'),
      buildExpandedCrosswalk(clinicalId, insuranceId, crosswalkSourceDir, crosswalkDir, 'ICD9'),
    ];
    const { icd10Map, icd9Map } = buildCrosswalkMaps(path.join(crosswalkDir, 'raw'), files, clinicalNames, insuranceNames);
    writeCrosswalkMap(crosswalkDir, 'icd_gl_yb_map.json', icd10Map);
    writeCrosswalkMap(crosswalkDir, 'icd9cm3_gl_yb_map.json', icd9Map);
    writeCrosswalkCsv(icd10Map, icd10GrayCodes, path.join(crosswalkDir, 'generated', 'ICD10GL2YB_gray.csv'));
    writeCrosswalkCsv(icd9Map, icd9GrayCodes, path.join(crosswalkDir, 'generated', 'ICD9GL2YB_gray.csv'));
    console.log(`Crosswalk generated: ${combination}`);
    return;
  }

  const explicitCache = new Map();
  const icd10Entries = collectExpandedCrosswalk(
    clinicalId,
    insuranceId,
    crosswalkSourceDir,
    'ICD10',
    readEffectiveExplicitCrosswalk(clinicalId, insuranceId, 'ICD10', explicitCache),
  ).entries;
  const icd9Entries = collectExpandedCrosswalk(
    clinicalId,
    insuranceId,
    crosswalkSourceDir,
    'ICD9',
    readEffectiveExplicitCrosswalk(clinicalId, insuranceId, 'ICD9', explicitCache),
  ).entries;
  const icd10Map = buildCrosswalkMap(icd10Entries, clinicalNames, insuranceNames, 'ICD10GL2YB.expanded.dat');
  const icd9Map = buildCrosswalkMap(icd9Entries, clinicalNames, insuranceNames, 'ICD9GL2YB.expanded.dat');
  const icd10Diff = buildCrosswalkDiff(
    icd10Map,
    readEffectiveCrosswalkMap(parentClinicalId, parentInsuranceId, 'icd_gl_yb_map.json'),
  );
  const icd9Diff = buildCrosswalkDiff(
    icd9Map,
    readEffectiveCrosswalkMap(parentClinicalId, parentInsuranceId, 'icd9cm3_gl_yb_map.json'),
  );
  const hasDiff = Object.keys(icd10Diff.mapping).length > 0
    || icd10Diff.removed.length > 0
    || Object.keys(icd9Diff.mapping).length > 0
    || icd9Diff.removed.length > 0;
  if (hasDiff) {
    fs.mkdirSync(path.join(crosswalkDir, 'generated'), { recursive: true });
  }
  writeCrosswalkDiff(crosswalkDir, 'icd_gl_yb_map.json', icd10Diff);
  writeCrosswalkDiff(crosswalkDir, 'icd9cm3_gl_yb_map.json', icd9Diff);
  writeCrosswalkRemovedCodes(crosswalkDir, {
    icdGlToYbRaw: icd10Diff.removed,
    icd9GlToYbRaw: icd9Diff.removed,
  });
  removeDerivedCrosswalkArtifacts(crosswalkDir);
  console.log(
    `Crosswalk diff generated: ${combination} <- ${parentCombination} ` +
    `(ICD10 +${Object.keys(icd10Diff.mapping).length}/-${icd10Diff.removed.length}, ` +
    `ICD9 +${Object.keys(icd9Diff.mapping).length}/-${icd9Diff.removed.length})`,
  );
}

function readConfiguredPackages() {
  return configResolver.listResolvedVersionConfigs().map(config => ({
    clinicalIcd: config.clinicalIcd,
    insuranceIcd: config.insuranceIcd,
  }));
}

function buildConfiguredPackages() {
  const packages = readConfiguredPackages();
  const clinicalIds = [...new Set(packages.map(item => item.clinicalIcd))].sort();
  const insuranceIds = [...new Set(packages.map(item => item.insuranceIcd))].sort();
  const combinations = [...new Set(packages.map(item => `${item.clinicalIcd}__${item.insuranceIcd}`))]
    .sort((left, right) => {
      const getDepth = combination => {
        const separator = combination.indexOf('__');
        const clinicalId = combination.slice(0, separator);
        const insuranceId = combination.slice(separator + 2);
        return resolvePackageChain(clinicalPackageRoot, clinicalId).length
          + resolvePackageChain(insurancePackageRoot, insuranceId).length;
      };
      return getDepth(left) - getDepth(right) || left.localeCompare(right);
    });
  for (const packageId of clinicalIds) buildClinicalPackage(packageId);
  for (const packageId of insuranceIds) buildInsurancePackage(packageId);
  for (const combination of combinations) {
    const separator = combination.indexOf('__');
    buildCrosswalkPackage(combination.slice(0, separator), combination.slice(separator + 2));
  }
}

if (require.main === module) {
  const [scope = 'all', firstId, secondId] = process.argv.slice(2);
  if (scope === 'all') buildConfiguredPackages();
  else if (scope === 'clinical' && firstId) buildClinicalPackage(firstId);
  else if (scope === 'insurance' && firstId) buildInsurancePackage(firstId);
  else if (scope === 'crosswalk' && firstId && secondId) buildCrosswalkPackage(firstId, secondId);
  else throw new Error('Usage: build_icd_mappings.cjs [all | clinical <id> | insurance <id> | crosswalk <clinical-id> <insurance-id>]');
}
