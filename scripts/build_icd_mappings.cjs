const fs = require('fs');
const path = require('path');
const { pinyin } = require('pinyin-pro');

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
    const firstToken = line.match(/^\S+/)?.[0];
    const code = normalize(firstToken);
    if (code) {
      out[code] = true;
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

function buildExpandedCrosswalk(clinicalDir, insuranceDir, crosswalkDir, type) {
  const glPath = path.join(clinicalDir, 'raw', `${type}GL.dat`);
  const ybPath = path.join(insuranceDir, 'raw', `${type}YB.dat`);
  const explicitPath = path.join(crosswalkDir, 'raw', `${type}GL2YB.explicit.dat`);
  const expandedPath = path.join(crosswalkDir, 'raw', `${type}GL2YB.expanded.dat`);
  const glCodes = readCodeSet(glPath, 'clinical ICD source');
  const ybCodes = readCodeSet(ybPath, 'insurance ICD source');
  const explicit = readExplicitCrosswalk(explicitPath);
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
  fs.writeFileSync(expandedPath, `${entries.map(([gl, yb]) => `${gl} ${yb}`).join('\n')}\n`, 'utf8');
  console.log(
    `Expanded crosswalk generated: ${path.basename(expandedPath)} ` +
    `(${entries.length} entries, ${fallbackCount} fallbacks, ${unmatchedCount} unmatched)`
  );
  return path.basename(expandedPath);
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

function parseNamePackage(packageDir, filenames) {
  const names = {};
  for (const filename of filenames) {
    const sourcePath = path.join(packageDir, 'raw', filename);
    if (!fs.existsSync(sourcePath)) throw new Error(`Missing ICD package source: ${sourcePath}`);
    for (const line of readDatFile(sourcePath)) {
      const match = line.match(/^(\S+)\s+(.*)$/);
      if (!match) continue;
      const code = normalize(match[1]);
      if (code && !names[code]) names[code] = match[2].trim();
    }
  }
  return names;
}

function withInitials(nameMap) {
  return { ...nameMap, _initials: buildInitialsMap(nameMap) };
}

function ensureGeneratedDir(packageDir) {
  fs.mkdirSync(path.join(packageDir, 'generated'), { recursive: true });
}

function buildClinicalPackage(packageId) {
  const packageDir = path.resolve(__dirname, `../src/data/icd-datasets/clinical/${packageId}`);
  const names = parseNamePackage(packageDir, ['ICD10GL.dat', 'ICD9GL.dat']);
  const { diag, proc } = splitNameDBs(names);
  ensureGeneratedDir(packageDir);
  fs.writeFileSync(path.join(packageDir, 'generated/icd_gl_names_diag.json'), JSON.stringify(withInitials(diag), null, 2), 'utf8');
  fs.writeFileSync(path.join(packageDir, 'generated/icd_gl_names_proc.json'), JSON.stringify(withInitials(proc), null, 2), 'utf8');
  console.log(`Clinical ICD package generated: ${packageId} (${Object.keys(names).length} names)`);
}

function buildInsurancePackage(packageId) {
  const packageDir = path.resolve(__dirname, `../src/data/icd-datasets/insurance/${packageId}`);
  const names = parseNamePackage(packageDir, ['ICD10YB.dat', 'ICD9YB.dat']);
  const { diag, proc } = splitNameDBs(names);
  ensureGeneratedDir(packageDir);
  fs.writeFileSync(path.join(packageDir, 'generated/icd_yb_names_diag.json'), JSON.stringify(withInitials(diag), null, 2), 'utf8');
  fs.writeFileSync(path.join(packageDir, 'generated/icd_yb_names_proc.json'), JSON.stringify(withInitials(proc), null, 2), 'utf8');
  for (const [source, output] of [
    ['ICD10YB-灰码.dat', 'icd10_gray_codes.json'],
    ['ICD9YB-灰码.dat', 'icd9_gray_codes.json'],
  ]) {
    const sourcePath = path.join(packageDir, 'raw', source);
    if (!fs.existsSync(sourcePath)) throw new Error(`Missing insurance ICD source: ${sourcePath}`);
    fs.writeFileSync(path.join(packageDir, 'generated', output), JSON.stringify(buildGrayCodeMap(sourcePath), null, 2), 'utf8');
  }
  console.log(`Insurance ICD package generated: ${packageId} (${Object.keys(names).length} names)`);
}

function readGeneratedNames(packageDir, filenames) {
  const names = {};
  for (const filename of filenames) {
    const filePath = path.join(packageDir, 'generated', filename);
    if (!fs.existsSync(filePath)) throw new Error(`Missing generated ICD dependency: ${filePath}`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [code, name] of Object.entries(data)) {
      if (code !== '_initials') names[code] = name;
    }
  }
  return names;
}

function buildCrosswalkPackage(clinicalId, insuranceId) {
  const clinicalDir = path.resolve(__dirname, `../src/data/icd-datasets/clinical/${clinicalId}`);
  const insuranceDir = path.resolve(__dirname, `../src/data/icd-datasets/insurance/${insuranceId}`);
  const combination = `${clinicalId}__${insuranceId}`;
  const crosswalkDir = path.resolve(__dirname, `../src/data/crosswalks/${combination}`);
  const clinicalNames = readGeneratedNames(clinicalDir, ['icd_gl_names_diag.json', 'icd_gl_names_proc.json']);
  const insuranceNames = readGeneratedNames(insuranceDir, ['icd_yb_names_diag.json', 'icd_yb_names_proc.json']);
  const files = [
    buildExpandedCrosswalk(clinicalDir, insuranceDir, crosswalkDir, 'ICD10'),
    buildExpandedCrosswalk(clinicalDir, insuranceDir, crosswalkDir, 'ICD9'),
  ];
  const { icd10Map, icd9Map } = buildCrosswalkMaps(path.join(crosswalkDir, 'raw'), files, clinicalNames, insuranceNames);
  fs.mkdirSync(path.join(crosswalkDir, 'generated'), { recursive: true });
  for (const [mapping, filename] of [
    [icd10Map, 'icd_gl_yb_map.json'],
    [icd9Map, 'icd9cm3_gl_yb_map.json'],
  ]) {
    const compact = {};
    for (const [code, entry] of Object.entries(mapping)) {
      if (entry?.ybCode && entry.ybCode !== code) compact[code] = entry.ybCode;
    }
    fs.writeFileSync(path.join(crosswalkDir, 'generated', filename), JSON.stringify({ mapping: compact }, null, 2), 'utf8');
  }
  console.log(`Crosswalk generated: ${combination}`);
}

function readConfiguredPackages() {
  const versionsDir = path.resolve(__dirname, '../src/data/versions');
  return fs.readdirSync(versionsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => JSON.parse(fs.readFileSync(path.join(versionsDir, entry.name, 'config.json'), 'utf8')).packages);
}

function buildConfiguredPackages() {
  const packages = readConfiguredPackages();
  const clinicalIds = [...new Set(packages.map(item => item.clinicalIcd))].sort();
  const insuranceIds = [...new Set(packages.map(item => item.insuranceIcd))].sort();
  const combinations = [...new Set(packages.map(item => `${item.clinicalIcd}__${item.insuranceIcd}`))].sort();
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
