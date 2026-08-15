// Node.js build script to generate browser-friendly JSON files for rules and code lists
const fs = require('fs');
const path = require('path');
const { createDrgConfigResolver } = require('./lib/drg_config.cjs');

// Generic DAT loader: supports 'index' (code->value), and 'simple'/'gray' (code->true)
function loadDat(filePath, type) {
  const isIndex = type === 'index';
  const isCodeOnly = type === 'simple' || type === 'gray';
  if (!isIndex && !isCodeOnly) throw new Error(`Unsupported DAT type '${type}' for ${filePath}`);
  if (!fs.existsSync(filePath)) throw new Error(`Missing required DAT file: ${filePath}`);

  const index = {};
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch (error) {
    throw new Error(`Unable to read required DAT file ${filePath}: ${error.message}`, { cause: error });
  }
  for (const raw of lines) {
    const s = raw.trim();
    if (!s) continue;

    const firstSpace = s.search(/\s/);
    const code = firstSpace < 0 ? s : s.slice(0, firstSpace);
    if (!code) continue;

    if (isCodeOnly) {
      index[code] = true;
      continue;
    }

    const value = s.slice(firstSpace).trim();
    if (!value) continue;
    index[code] = value;
  }

  return index;
}

const projectRoot = path.resolve(__dirname, '..');
const configResolver = createDrgConfigResolver(projectRoot);
const dataDir = path.join(projectRoot, 'src/data');
const versionsDir = path.join(dataDir, 'versions');
const commonPackagesDir = path.join(dataDir, 'drg-common');

let version;
let versionConfig;
let subgroupConditions;
let rulesDir;
let commonRulesDir;
let outputDir;
let commonOutputDir;
let buildScope;

// Module-level regex constants — compiled once, reused across all calls
const _hanRe = /[\p{Script=Han}]/u;
const _icdLikeRe = /^[A-Za-z0-9][A-Za-z0-9.+\-*xX/†]*$/;
const _firstTokenRe = /^\S+/;
const _codeStartRe = /^[A-Za-z]\d|^\d/;
const _codeExtractRe = /^([A-Za-z0-9.+\-*xX/†]+)/;
const _suffixRe = /_([nab])$/;   // DRG variant suffix: n=new-technique, a=alternate, b=backup
const _upperStartRe = /^[A-Z]/;  // diagnosis prefix cluster (ICD alpha)
const _digitStartRe = /^[0-9]/;  // procedure prefix cluster (ICD-9-CM-3 numeric)

let ccCodes;
let mccCodes;
let cceCodes;
let zdInvalid;
let ssInvalid;

/**
 * Read DRG.dat and return a map: code -> { description, weight, weightTier2 }
 *
 * The first weight column is the base weight; the second (optional)
 * column is the tier‑2 hospital weight.  A literal slash (`/`) in either
 * column indicates a special‑payment DRG and is retained verbatim in the
 * resulting map rather than being converted to `null` or a number.
 *
 * @param {string} filePath
 * @returns {Object}
 */
function readDrgDat(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing required DRG file: ${filePath}`);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read required DRG file ${filePath}: ${error.message}`, { cause: error });
  }
  const lines = raw.split(/\r?\n/);
  const quotePattern = /^"|"$/g;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const code = parts[0].trim();
    const desc = parts[1].trim().replace(quotePattern, '');
    if (Object.prototype.hasOwnProperty.call(out, code)) {
      throw new Error(`Duplicate DRG code '${code}' in DRG.dat at line ${lineIndex + 1}`);
    }
    // first weight column is the "base" weight, second (optional) column is
    // the tier‑2 hospital weight.  In the old format there was only one
    // value; new DAT files have two numbers separated by tabs.
    const rawWeight = parts.length >= 3 ? parts[2].trim().replace(quotePattern, '') : null;
    const rawWeight2 = parts.length >= 4 ? parts[3].trim().replace(quotePattern, '') : null;

    // helper within loop for clarity
    const parseWeight = (val) => {
      if (!val) return null;
      if (val === '/') return '/';
      const n = parseFloat(val);
      return isNaN(n) ? null : n;
    };

    const weight = parseWeight(rawWeight);
    const weightTier2 = parseWeight(rawWeight2);

    out[code] = {
      description: desc,
      weight: weight === null ? null : weight,
      // optional extra field for tier‑2 hospitals; slash marker already
      // resides in the variable if present, so mirror the null check.
      weightTier2: weightTier2 === null ? null : weightTier2
    };
  }
  if (Object.keys(out).length === 0) throw new Error(`Required DRG file contains no valid entries: ${filePath}`);
  return out;
}

let drgMap;

/**
 * Read rule files from a directory and return parsed entries.
 * Expected filename format: <CODE>_<Name>.<ext>
 * Returns an array of { code, name, type, filename, content }.
 * @param {string} dirPath
 * @param {string} type
 * @param {Iterable<string>|null} knownCodes Optional codes used for filenames whose codes contain underscores.
 * @returns {Array}
 */
function getRulesFromDir(dirPath, type, knownCodes = null) {
  if (!fs.existsSync(dirPath)) throw new Error(`Missing required ${type} rules directory: ${dirPath}`);
  if (!fs.statSync(dirPath).isDirectory()) throw new Error(`Expected ${type} rules directory: ${dirPath}`);
  const files = fs.readdirSync(dirPath).filter(f => !f.startsWith('.')).sort();
  const results = [];
  const codeCandidates = knownCodes
    ? [...knownCodes].sort((left, right) => right.length - left.length || left.localeCompare(right))
    : null;

  for (const file of files) {
    const parsed = path.parse(file);
    const baseName = parsed.name; // filename without extension
    const knownCode = codeCandidates?.find(candidate => baseName.startsWith(`${candidate}_`)) || null;
    const firstUnderscoreIndex = knownCode ? knownCode.length : baseName.indexOf('_');
    if (firstUnderscoreIndex <= 0 || (codeCandidates && !knownCode)) {
      throw new Error(`Invalid ${type} rule filename '${file}' in ${dirPath}; expected <code>_<name>`);
    }

    const code = knownCode || baseName.substring(0, firstUnderscoreIndex);
    const name = baseName.substring(firstUnderscoreIndex + 1);
    const filePath = path.join(dirPath, file);

    let stat;
    let content;
    try {
      stat = fs.statSync(filePath);
      content = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new Error(`Unable to read ${type} rule ${filePath}: ${error.message}`, { cause: error });
    }
    if (!stat.isFile()) throw new Error(`Expected ${type} rule file: ${filePath}`);
    results.push({ code, name, type, filename: file, content });
  }

  if (results.length === 0) throw new Error(`Required ${type} rules directory contains no rule files: ${dirPath}`);
  return results;
}

/**
 * Validate that expected rules directories exist (ADRG, MDC).
 * Returns an array of missing directories (empty = all present).
 * @param {string} baseRulesDir
 */
function validateRulesDir(baseRulesDir) {
  const missing = [];
  const expected = ['ADRG', 'MDC'];
  for (const d of expected) {
    if (!fs.existsSync(path.join(baseRulesDir, d))) missing.push(d);
  }
  return missing;
}
function removeRedundantPrimaryPrefix(rule, { condition, prefixesField, category }) {
  const prefixes = rule[prefixesField];
  const sections = rule.adrgRule?.sections;
  if (!Array.isArray(prefixes) || prefixes.length === 0 || !sections || typeof sections !== 'object') return;

  const categorySections = Object.entries(sections).filter(([sectionName]) => (
    category === 'diagnosis'
      ? sectionName.includes('诊断')
      : sectionName.includes('手术') || sectionName.includes('操作')
  ));
  if (categorySections.length === 0 || categorySections.some(([sectionName]) => !sectionName.includes('主要'))) return;

  const exactCodes = categorySections.flatMap(([, codes]) => Array.isArray(codes) ? codes : []);
  if (exactCodes.length === 0 || !exactCodes.every(code => prefixes.some(prefix => code.startsWith(prefix)))) return;

  rule.conditions = rule.conditions.filter(value => value !== condition);
  rule[prefixesField] = [];
}

// Derive subgroup rule logic (same as before)
function deriveSubgroupRule(drgCode, drgName, adrgData) {
  const adrgCodeInput = adrgData.code;
  const rule = {
    drgCode,
    drgName,
    adrgCode: adrgCodeInput,
    conditions: [],
    diagnosisCodes: [],
    procedureCodes: [],
    diagnosisPrefixes: [],
    procedurePrefixes: []
  };
  const normalizedDrgName = String(drgName || '').replace(/\s+/g, ' ').trim();
  const nameConditions = [];

  const agePatterns = [
    [/小于等于\s*(\d+)\s*岁/, 'AGE_LE_'],
    [/[＜<]\s*(\d+)\s*岁/, 'AGE_LT_'],
    [/小于\s*(\d+)\s*岁/, 'AGE_LT_'],
    [/大于等于\s*(\d+)\s*岁/, 'AGE_GE_'],
    [/[＞>]\s*(\d+)\s*岁/, 'AGE_GT_'],
    [/大于\s*(\d+)\s*岁/, 'AGE_GT_'],
    [/(\d+)\s*岁以上/, 'AGE_GE_'],
  ];
  for (const [pattern, conditionPrefix] of agePatterns) {
    const match = normalizedDrgName.match(pattern);
    if (match) {
      nameConditions.push(conditionPrefix + match[1]);
      break;
    }
  }
  if (/不伴(?:严重|一般)?(?:合并症或并发症|并发症或合并症)/.test(normalizedDrgName)) nameConditions.push('NO_CC');
  else if (/伴严重(?:合并症或并发症|并发症或合并症)/.test(normalizedDrgName)) nameConditions.push('WITH_MCC');
  else if (/伴(?:一般)?(?:合并症或并发症|并发症或合并症)/.test(normalizedDrgName)) nameConditions.push('WITH_CC');
  if (/死亡转归/.test(normalizedDrgName)) nameConditions.push('DEATH');
  if (/伴重症监护/.test(normalizedDrgName)) nameConditions.push('INTENSIVE_CARE');

  const nameComplicationConditions = nameConditions.filter(condition => ['WITH_MCC', 'WITH_CC', 'NO_CC'].includes(condition));
  const nameAgeConditions = nameConditions.filter(condition => condition.startsWith('AGE_'));
  const nameOtherConditions = nameConditions.filter(condition => !condition.startsWith('AGE_') && !['WITH_MCC', 'WITH_CC', 'NO_CC'].includes(condition));
  rule.conditions.push(...nameAgeConditions, ...nameComplicationConditions, ...nameOtherConditions);
  const char4 = drgCode.charAt(3);
  const configuredCondition = subgroupConditions[char4];
  if (configuredCondition) {
    rule.conditions.push(configuredCondition);
  } else if (char4 === '_') {
    const clusterPart = drgCode.substring(4);
    if (clusterPart && clusterPart !== '9') {
      const parts = clusterPart.split('_');
      const cleanPrefix = parts[0] || '';
      if (_upperStartRe.test(cleanPrefix)) {
        rule.conditions.push('SPECIFIC_DIAGNOSIS_PREFIX');
        rule.diagnosisPrefixes.push(cleanPrefix);
      } else if (_digitStartRe.test(cleanPrefix) && cleanPrefix !== '9') {
        rule.conditions.push('SPECIFIC_PROCEDURE_PREFIX');
        rule.procedurePrefixes.push(cleanPrefix);
      }
    } else if (clusterPart === '9') {
      rule.conditions.push('ADRG_ONLY');
    }
  } else if (/机器人辅助手术$/.test(normalizedDrgName) || /椎管内镇痛$/.test(normalizedDrgName)) {
    rule.conditions.push('NEW_TECHNIQUE');
  }

  const suffixMatch = drgCode.match(_suffixRe);
  const suffix = suffixMatch ? suffixMatch[1] : null;
  if (suffix) {
    if (suffix === 'n') { if (!rule.conditions.includes('NEW_TECHNIQUE')) rule.conditions.push('NEW_TECHNIQUE'); }
  }
  const invalidConditionIndex = rule.conditions.findIndex(condition => typeof condition !== 'string');
  if (invalidConditionIndex >= 0) {
    const invalidCondition = rule.conditions[invalidConditionIndex];
    throw new TypeError(`Invalid subgroup condition for ${drgCode} at index ${invalidConditionIndex}: expected string, received ${invalidCondition === null ? 'null' : typeof invalidCondition}`);
  }
  if (rule.conditions.length === 0) rule.conditions.push('ADRG_ONLY');
  rule.conditions = [...new Set(rule.conditions)];
  for (const field of ['diagnosisCodes', 'procedureCodes', 'diagnosisPrefixes', 'procedurePrefixes']) {
    if (rule[field].length === 0) delete rule[field];
  }
  return rule;
}

/**
 * parseMDCCodes — readable, regex-based parser for MDC token lists.
 * - Splits on newlines or commas, trims each segment,
 *   extracts the first whitespace-delimited token and validates it.
 * - Returns a deduplicated array of ICD-like tokens (preserves token case).
 */
function parseMDCCodes(text) {
  if (!text) return [];

  const seen = new Set();
  const out = [];

  // Split into human-friendly segments and validate each token declaratively.
  const parts = String(text).split(/[\n,]/);
  for (let i = 0; i < parts.length; i++) {
    const part = String(parts[i] || '').trim();
    if (!part) continue;
    const m = _firstTokenRe.exec(part);
    if (!m) continue;
    const token = m[0];
    // skip non-code tokens (Chinese headers, descriptions)
    if (_hanRe.test(token)) continue;
    // require entire token to match ICD-like shape
    if (!_icdLikeRe.test(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }

  return out;
}

/**
 * parseMDCZRule — declarative, regex-based parser for MDCZ rule text.
 * - Splits text into lines, trims them, skips lines containing '包含以下',
 *   treats non-code-starting lines as category headers, and extracts
 *   the leading ICD-like token from code lines.
 */
function parseMDCZRule(text) {
  if (typeof text !== 'string' || !text.trim()) return {};

  const result = {};
  let currentCategory = '未分类';
  result[currentCategory] = [];

  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.indexOf('包含以下') !== -1) continue;
    // header if it doesn't look like a code line
    if (!_codeStartRe.test(line)) {
      currentCategory = line;
      if (!result[currentCategory]) result[currentCategory] = [];
      continue;
    }
    // extract leading token (captures †, *, +, / etc.)
    const m = line.match(_codeExtractRe);
    if (m) result[currentCategory].push(m[1]);
  }

  if (result['未分类'] && result['未分类'].length === 0) delete result['未分类'];
  return result;
}

// Helpers: small, focused functions used by main
async function writeJsonFiles(writeJobs) {
  const pfs = fs.promises;
  try {
    await pfs.mkdir(path.dirname(writeJobs[0][0]), { recursive: true });
    await Promise.all(writeJobs.map(([fp, content]) => pfs.writeFile(fp, content)));
  } catch (err) {
    console.error('Error writing JSON files:', err && err.message ? err.message : err);
    process.exitCode = 1;
    throw err;
  }
}

async function buildMdcRules(mdcRulesRaw) {
  const mdcRules = [];
  for (const item of mdcRulesRaw) {
    const copy = { ...item };
    try {
      if (copy.type === 'MDC') {
        if (copy.code === 'MDCZ') copy.mdczCategories = parseMDCZRule(copy.content);
        else if (copy.code !== 'MDCA' && copy.code !== 'MDCP') copy.identifyingDiagnoses = parseMDCCodes(copy.content);
        else copy.identifyingDiagnoses = [];
      }
    } catch (e) {
      console.warn(`Error parsing MDC '${copy.code}':`, e && e.message ? e.message : e);
      copy.identifyingDiagnoses = copy.identifyingDiagnoses || [];
    }
    mdcRules.push(copy);
  }
  return mdcRules;
}

async function buildAdrgRules(adrgRulesRaw, parseRule, ruleKind = 'ADRG') {
  const adrgRules = [];
  const adrgParseErrors = [];
  const adrgValidationErrors = [];

  for (const item of adrgRulesRaw) {
    const copy = { ...item };
    try {
      if (copy.type === 'ADRG') {
        copy.rule = parseRule(copy.content);
        // The official ADRG name is the source of this explicit rule flag.
        const isMultiSiteAdrg = String(copy.name || '').includes('多部位');
        if (isMultiSiteAdrg) copy.rule.multiSite = true;
        if (copy.rule && copy.rule._logicCompileError) {
          adrgValidationErrors.push({ code: copy.code, filename: copy.filename, error: copy.rule._logicCompileError });
        }
      }
    } catch (e) {
      adrgParseErrors.push({ code: copy.code, filename: copy.filename, error: e && e.message ? e.message : String(e) });
    }
    adrgRules.push(copy);
  }

  if (adrgParseErrors.length > 0 || adrgValidationErrors.length > 0) {
    console.error(`${ruleKind} build-time errors detected:`);
    if (adrgParseErrors.length > 0) {
      console.error('Parsing errors:');
      for (const err of adrgParseErrors) console.error(`${err.filename}: ${err.error}`);
    }
    if (adrgValidationErrors.length > 0) {
      console.error('Validation/logic compilation errors:');
      for (const err of adrgValidationErrors) console.error(`${err.filename}: ${err.error}`);
    }
    process.exitCode = 1;
    throw new Error(`${ruleKind} rule parse/validation errors`);
  }

  return adrgRules;
}

function deriveSubgroupRules(drgMap, adrgRules) {
  const adrgContext = {};
  for (const a of adrgRules) adrgContext[a.code] = a;

  const subgroupRules = [];
  const skippedDRGList = [];

  for (const [drgCode, drgInfo] of Object.entries(drgMap)) {
    const adrgCode = drgCode.substring(0, 3);
    const adrgData = adrgContext[adrgCode];
    if (!adrgData) { skippedDRGList.push(drgCode); continue; }
    const rule = deriveSubgroupRule(drgCode, drgInfo.description, adrgData);
    subgroupRules.push(rule);
  }

  return { subgroupRules, skippedDRGList };
}

function orderSubgroupRules(rules) {
  const complicationConditions = new Set(['WITH_MCC', 'WITH_CC', 'NO_CC']);
  const rulesByAdrg = new Map();

  const getBaseCode = (rule, adrgCode) => {
    const normalizedCode = rule.drgCode.replace(_suffixRe, '');
    const lastChar = normalizedCode.at(-1);
    if (lastChar < 'A' || lastChar > 'H') return normalizedCode;

    const conditions = rule.conditions || [];
    if (conditions.includes('WITH_MCC')) return `${adrgCode}1`;
    if (conditions.includes('WITH_CC')) return `${adrgCode}3`;
    if (conditions.includes('NO_CC')) return `${adrgCode}5`;
    return `${adrgCode}9`;
  };

  const getPriority = rule => {
    const conditions = rule.conditions || [];
    if (conditions.some(condition => complicationConditions.has(condition))) return 1;
    if (rule.adrgRule || conditions.some(condition => condition !== 'ADRG_ONLY')) return 0;
    return 1;
  };

  for (const [sourceIndex, rule] of rules.entries()) {
    const adrgCode = rule.drgCode.slice(0, 3);
    if (!rulesByAdrg.has(adrgCode)) {
      rulesByAdrg.set(adrgCode, []);
    }
    rulesByAdrg.get(adrgCode).push({
      rule,
      sourceIndex,
      baseCode: getBaseCode(rule, adrgCode),
    });
  }

  const orderedRules = [];
  for (const entries of rulesByAdrg.values()) {
    const groupFirstIndex = new Map();
    for (const entry of entries) {
      if (!groupFirstIndex.has(entry.baseCode)) groupFirstIndex.set(entry.baseCode, entry.sourceIndex);
    }

    entries.sort((left, right) => {
      const priorityDelta = getPriority(left.rule) - getPriority(right.rule);
      if (priorityDelta !== 0) return priorityDelta;

      const groupDelta = groupFirstIndex.get(left.baseCode) - groupFirstIndex.get(right.baseCode);
      if (groupDelta !== 0) return groupDelta;

      const baseDelta = Number(left.rule.drgCode === left.baseCode)
        - Number(right.rule.drgCode === right.baseCode);
      if (baseDelta !== 0) return baseDelta;

      return left.sourceIndex - right.sourceIndex;
    });
    orderedRules.push(...entries.map(entry => entry.rule));
  }

  return orderedRules;
}

async function buildExplicitSubgroupRules(parseRule, prepareExplicitSubgroupRuleContent) {
  const sourceDir = path.join(rulesDir, 'subgroup_rules');
  if (!fs.existsSync(sourceDir)) return [];

  const seenCodes = new Set();
  const subgroupSourceEntries = getRulesFromDir(sourceDir, 'ADRG', Object.keys(drgMap)).map(item => {
    const drgCode = item.code;
    if (seenCodes.has(drgCode)) throw new Error(`Duplicate explicit subgroup rule: ${drgCode}`);
    seenCodes.add(drgCode);
    const drg = drgMap[drgCode];
    if (!drg) throw new Error(`Explicit subgroup rule ${drgCode} is absent from DRG.dat`);
    return {
      ...item,
      name: String(drg.description || '').trim(),
      content: prepareExplicitSubgroupRuleContent(item.content),
    };
  });

  const parsedRules = await buildAdrgRules(subgroupSourceEntries, parseRule, 'explicit subgroup');
  return parsedRules.map(item => ({
    drgCode: item.code,
    drgName: item.name,
    baseAdrg: item.code.slice(0, 3),
    rule: item.rule,
  }));
}

function logRuleSummary(mdcRules, adrgRules, drgRules) {
  const conditionCounts = new Map();
  for (const rule of drgRules) {
    for (const condition of rule.conditions || []) {
      conditionCounts.set(condition, (conditionCounts.get(condition) || 0) + 1);
    }
  }

  console.log(`Rule summary: MDC=${mdcRules.length}, ADRG=${adrgRules.length}, DRG=${drgRules.length}`);
  console.log('Condition counts:');
  for (const [condition, count] of [...conditionCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${condition}: ${count}`);
  }
}

function configureBuildContext(scope, config, commonPackage) {
  version = config.id;
  versionConfig = config;
  subgroupConditions = versionConfig.subgroupConditions || {};
  buildScope = scope;

  const versionDir = path.join(versionsDir, version);
  const commonPackageDir = path.join(commonPackagesDir, commonPackage);
  rulesDir = path.join(versionDir, 'raw');
  commonRulesDir = path.join(commonPackageDir, 'raw');
  outputDir = path.join(versionDir, 'generated');
  commonOutputDir = path.join(commonPackageDir, 'generated');

  for (const [target, description] of [
    [rulesDir, `DRG version ${version}`],
    [commonRulesDir, `DRG common package ${commonPackage}`],
  ]) {
    if (!fs.existsSync(target)) throw new Error(`Missing ${description}: ${target}`);
  }

  ccCodes = loadDat(path.join(commonRulesDir, 'CC.dat'), 'index');
  mccCodes = loadDat(path.join(commonRulesDir, 'MCC.dat'), 'index');
  cceCodes = loadDat(path.join(commonRulesDir, 'CCE.dat'), 'index');
  zdInvalid = loadDat(path.join(commonRulesDir, 'ZD_INVALID.dat'), 'gray');
  ssInvalid = loadDat(path.join(commonRulesDir, 'SS_INVALID.dat'), 'gray');
  drgMap = readDrgDat(path.join(rulesDir, 'DRG.dat'));
}

// Main build flow
async function buildPackage(scope, config, commonPackage) {
  configureBuildContext(scope, config, commonPackage);
  const buildCommon = buildScope === 'all' || buildScope === 'common';
  const buildVersion = buildScope === 'all' || buildScope === 'version';
  console.log(`\n=== Building DRG rules (${version}) [${buildScope.toUpperCase()}] ===`);
  console.log(buildCommon
    ? 'Preparing parsed MDC/ADRG rules in build step...'
    : 'Loading generated ADRG rules from the DRG common package...');

  // Dynamic import of the lightweight parsing core so build scripts don't import UI/runtime-only code.
  let mdcRules = [];
  let adrgRules = [];
  let parseRule = null;
  let prepareExplicitSubgroupRuleContent = null;
  const subgroupRulesSourceDir = path.join(rulesDir, 'subgroup_rules');
  const hasSubgroupRulesSource = fs.existsSync(subgroupRulesSourceDir)
    && fs.readdirSync(subgroupRulesSourceDir).some(filename => filename.endsWith('.dat'));
  if (buildCommon || (buildVersion && hasSubgroupRulesSource)) {
    const ruleParserPath = pathToFileUrl(path.resolve(__dirname, '../src/lib/ruleParserCore.js'));
    try {
      const rp = await import(ruleParserPath);
      parseRule = rp.parseRule;
      if (typeof parseRule !== 'function') throw new Error('ruleParserCore must export parseRule');
      prepareExplicitSubgroupRuleContent = rp.prepareExplicitSubgroupRuleContent;
      if (typeof prepareExplicitSubgroupRuleContent !== 'function') {
        throw new Error('ruleParserCore must export prepareExplicitSubgroupRuleContent');
      }
    } catch (e) {
      console.error('Failed to import ruleParserCore for build-time parsing — build cannot continue:', e && e.message ? e.message : e);
      throw e;
    }
  }

  if (buildCommon) {

    const missingRuleDirs = validateRulesDir(commonRulesDir);
    if (missingRuleDirs.length) {
      throw new Error(`Missing required rules directories in ${commonRulesDir}: ${missingRuleDirs.join(', ')}`);
    }
    const adrgRulesRaw = getRulesFromDir(path.join(commonRulesDir, 'ADRG'), 'ADRG');
    const mdcRulesRaw = getRulesFromDir(path.join(commonRulesDir, 'MDC'), 'MDC');
    mdcRules = await buildMdcRules(mdcRulesRaw);
    adrgRules = await buildAdrgRules(adrgRulesRaw, parseRule);
  } else {
    const adrgPath = path.join(commonOutputDir, 'adrg_rules.json');
    if (!fs.existsSync(adrgPath)) {
      throw new Error(`Missing DRG common dependency: ${adrgPath}`);
    }
    adrgRules = JSON.parse(fs.readFileSync(adrgPath, 'utf8'));
  }

  const keepContent = process.env.KEEP_CONTENT === '1';
  const adrgRulesForWrite = keepContent ? adrgRules : adrgRules.map(({ content, ...rest }) => rest);
  const mdcRulesForWrite = keepContent ? mdcRules : mdcRules.map(({ content, ...rest }) => rest);

  if (buildCommon) {
    await writeJsonFiles([
      [path.join(commonOutputDir, 'cc_codes.json'), JSON.stringify(ccCodes, null, 2)],
      [path.join(commonOutputDir, 'mcc_codes.json'), JSON.stringify(mccCodes, null, 2)],
      [path.join(commonOutputDir, 'cce_codes.json'), JSON.stringify(cceCodes, null, 2)],
      [path.join(commonOutputDir, 'zd_invalid.json'), JSON.stringify(zdInvalid, null, 2)],
      [path.join(commonOutputDir, 'ss_invalid.json'), JSON.stringify(ssInvalid, null, 2)],
      [path.join(commonOutputDir, 'adrg_rules.json'), JSON.stringify(adrgRulesForWrite, null, 2)],
      [path.join(commonOutputDir, 'mdc_rules.json'), JSON.stringify(mdcRulesForWrite, null, 2)],
    ]);
    console.log('DRG common package generated.');
  }

  if (!buildVersion) return;

  console.log('Deriving DRG subgroup rules...');
  const { subgroupRules: derivedRules, skippedDRGList } = deriveSubgroupRules(drgMap, adrgRules);
  const explicitSubgroupRules = parseRule
    ? await buildExplicitSubgroupRules(parseRule, prepareExplicitSubgroupRuleContent)
    : [];
  const explicitSubgroupRuleByCode = new Map(explicitSubgroupRules.map(rule => [rule.drgCode, rule.rule]));
  const attachedRules = derivedRules.map(rule => {
    const adrgRule = explicitSubgroupRuleByCode.get(rule.drgCode);
    if (!adrgRule) return rule;
    const attachedRule = { ...rule, adrgRule };
    removeRedundantPrimaryPrefix(attachedRule, {
      condition: 'SPECIFIC_DIAGNOSIS_PREFIX',
      prefixesField: 'diagnosisPrefixes',
      category: 'diagnosis',
    });
    removeRedundantPrimaryPrefix(attachedRule, {
      condition: 'SPECIFIC_PROCEDURE_PREFIX',
      prefixesField: 'procedurePrefixes',
      category: 'procedure',
    });
    for (const field of ['diagnosisPrefixes', 'procedurePrefixes']) {
      if (Array.isArray(attachedRule[field]) && attachedRule[field].length === 0) delete attachedRule[field];
    }
    return attachedRule;
  });
  const subgroupRules = orderSubgroupRules(attachedRules);

  console.log(`Generated ${subgroupRules.length} DRG rules in DRG.dat group order (variants before base).`);
  console.log(`Attached ${explicitSubgroupRules.length} explicit subgroup ADRG-style matchers before complication/ADRG fallbacks.`);

  if (skippedDRGList.length > 0) {
    throw new Error(`DRGs reference missing ADRGs: ${skippedDRGList.join(', ')}`);
  }

  logRuleSummary(mdcRules, adrgRules, subgroupRules);

  // Write version-specific outputs.
  const writeJobs = [
    [path.join(outputDir, 'drg.json'), JSON.stringify(drgMap, null, 2)],
    [path.join(outputDir, 'drg_rules.json'), JSON.stringify(subgroupRules, null, 2)],
  ];
  try {
    await writeJsonFiles(writeJobs);
  } catch (err) {
    throw err;
  }

  try {
    const skippedPath = path.join(dataDir, 'skipped_drgs.json');
    if (fs.existsSync(skippedPath)) fs.unlinkSync(skippedPath);
  } catch (e) { }

  console.log('Build complete: JSON files generated for browser use.');
}

function pathToFileUrl(p) {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') resolved = '/' + resolved.replace(/\\/g, '/');
  return `file://${resolved}`;
}

function readConfigs() {
  return configResolver.listResolvedVersionConfigs().map(
    config => config.versionConfig,
  );
}

async function runCli() {
  const configs = readConfigs();
  const [scope = 'all', requestedId] = process.argv.slice(2);
  if (!['all', 'common', 'version'].includes(scope)) {
    throw new Error('Usage: build_rules_json.cjs [all | common <package-id> | version <version-id>]');
  }

  if (scope === 'common') {
    if (!requestedId) throw new Error('DRG common package ID is required');
    const config = configs.find(item => item.drgCommon === requestedId);
    if (!config) throw new Error(`DRG common package is not referenced by any version: ${requestedId}`);
    await buildPackage('common', config, requestedId);
    return;
  }

  if (scope === 'version') {
    const selected = requestedId
      ? configs.filter(item => item.id === requestedId)
      : configs;
    if (selected.length === 0) throw new Error(`Unknown DRG version: ${requestedId}`);
    for (const config of selected) {
      await buildPackage('version', config, config.drgCommon);
    }
    return;
  }

  const commonPackages = [...new Set(configs.map(item => item.drgCommon))].sort();
  for (const packageId of commonPackages) {
    const config = configs.find(item => item.drgCommon === packageId);
    await buildPackage('common', config, packageId);
  }
  for (const config of configs) {
    await buildPackage('version', config, config.drgCommon);
  }
}

runCli().catch(err => {
  console.error('Build failed:', err && err.stack ? err.stack : (err && err.message ? err.message : err));
  process.exitCode = 1;
});
