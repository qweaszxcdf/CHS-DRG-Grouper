// Node.js build script to generate browser-friendly JSON files for rules and code lists
const fs = require('fs');
const path = require('path');
const { createDrgConfigResolver } = require('./lib/drg_config.cjs');
const { forEachPackageDatEntry } = require('./lib/icd_package.cjs');
const { writeFileIfChanged } = require('./lib/write_if_changed.cjs');

function readDatLines(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required DAT file: ${filePath}`);
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  } catch (error) {
    throw new Error(`Unable to read required DAT file ${filePath}: ${error.message}`, { cause: error });
  }
}

// Generic DAT loader: supports 'index' (code->value), and 'simple'/'gray' (code->true)
function loadDat(filePath, type) {
  const isIndex = type === 'index';
  const isCodeOnly = type === 'simple' || type === 'gray';
  if (!isIndex && !isCodeOnly) throw new Error(`Unsupported DAT type '${type}' for ${filePath}`);
  const index = {};
  for (const raw of readDatLines(filePath)) {
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

function deriveQyDiffEntries(insurancePackageId, allProcedureCodes, ssInvalid) {
  if (allProcedureCodes === undefined) {
    return undefined;
  }
  if (Object.keys(allProcedureCodes).length === 0) {
    throw new Error('ALL_PROCEDURE code list is present but empty');
  }

  const ybProcedureNames = {};
  forEachPackageDatEntry(
    insurancePackagesDir,
    insurancePackageId,
    'ICD9YB.dat',
    entry => {
      if (entry.removed) delete ybProcedureNames[entry.code];
      else if (entry.value) ybProcedureNames[entry.code] = entry.value;
    },
  );
  const grayProcedureCodes = {};
  forEachPackageDatEntry(
    insurancePackagesDir,
    insurancePackageId,
    'ICD9YB-灰码.dat',
    entry => {
      if (entry.removed) delete grayProcedureCodes[entry.code];
      else grayProcedureCodes[entry.code] = true;
    },
  );
  const entries = [];

  for (const code of Object.keys(ybProcedureNames).sort((left, right) => (
    left.localeCompare(right, 'en', { numeric: true })
  ))) {
    if (
      !Object.hasOwn(grayProcedureCodes, code)
      && !Object.hasOwn(ssInvalid, code)
      && !Object.hasOwn(allProcedureCodes, code)
    ) {
      const name = String(ybProcedureNames[code] || '').trim();
      if (!name) {
        throw new Error(`Missing YB procedure name for QY diff code: ${code}`);
      }
      entries.push({ code, name });
    }
  }

  return entries;
}

function renderCodeNameDat(entries) {
  return `${entries.map(({ code, name }) => `${code} ${name}`).join('\n')}\n`;
}

const projectRoot = path.resolve(__dirname, '..');
const configResolver = createDrgConfigResolver(projectRoot);
const dataDir = path.join(projectRoot, 'src/data');
const versionsDir = path.join(dataDir, 'versions');
const commonPackagesDir = path.join(dataDir, 'drg-common');
const insurancePackagesDir = path.join(dataDir, 'icd-datasets/insurance');

let version;
let versionConfig;
let subgroupConditions;
let rulesDir;
let commonRulesDir;
let outputDir;
let commonOutputDir;
let buildScope;
let inferRegionalSectionMinimumMatches;
let subgroupOrderOverrides;
let allProcedureCodes;
let qyDiffEntries;
let qyDiffCodes;

// Module-level regex constants — compiled once, reused across all calls
const _codeStartRe = /^[A-Za-z]\d|^\d/;
const _codeExtractRe = /^([A-Za-z0-9.+\-*xX/†]+)/;
const _mdcCodeStartRe = /^[A-Za-z]\d{2}/;
const _mdcCodeTokenRe = /^[A-Za-z]\d{2}[A-Za-z0-9.+\-*xX/†]*$/;
const _suffixRe = /_([nab])$/;   // DRG variant suffix: n=new-technique, a=alternate, b=backup
const _upperStartRe = /^[A-Z]/;  // diagnosis prefix cluster (ICD alpha)
const _digitStartRe = /^[0-9]/;  // procedure prefix cluster (ICD-9-CM-3 numeric)

const COMPARISON_OPERATOR_CODES = Object.freeze({
  大于等于: 'GE',
  不低于: 'GE',
  '>=': 'GE',
  '≥': 'GE',
  '＞': 'GT',
  大于: 'GT',
  '>': 'GT',
  '＜': 'LT',
  小于等于: 'LE',
  不超过: 'LE',
  '<=': 'LE',
  '≤': 'LE',
  小于: 'LT',
  '<': 'LT',
  以上: 'GE',
});
const COMPARISON_OPERATOR_PATTERN = Object.keys(COMPARISON_OPERATOR_CODES)
  .filter(value => value !== '以上')
  .sort((left, right) => right.length - left.length)
  .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const CRRT_HOURS_NAME_CONDITION_PATTERNS = [
  {
    pattern: new RegExp(
      `(?:连续性肾脏替代治疗(?:\\[?CRRT\\]?)?|CRRT)(?:时长)?(?<operator>${COMPARISON_OPERATOR_PATTERN})(?<value>\\d+)(?:小时|h)`,
      'i',
    ),
    conditionPrefix: 'CRRT_HOURS',
  },
];
const ICU_HOURS_NAME_CONDITION_PATTERNS = [
  {
    pattern: new RegExp(
      `重症监护(?:时长)?(?<operator>${COMPARISON_OPERATOR_PATTERN})(?<value>\\d+)(?:小时|h)`,
      'i',
    ),
    conditionPrefix: 'ICU_HOURS',
  },
];
const AGE_NAME_CONDITION_PATTERNS = [
  {
    pattern: new RegExp(
      `(?:(?<operator>${COMPARISON_OPERATOR_PATTERN})\\s*)?(?<value>\\d+)\\s*岁(?<suffix>以上)?`,
    ),
    conditionPrefix: 'AGE',
  },
];
const DAY_SURGERY_NAME_PATTERN = /日间|day\s*(?:case|surgery)/i;

function inferNumericCondition(text, definitions = []) {
  const normalized = String(text || '').replace(/\s+/g, '');
  for (const { pattern, conditionPrefix } of definitions) {
    if (!(pattern instanceof RegExp) || !conditionPrefix) continue;
    const match = normalized.match(pattern);
    const comparisonToken = match?.groups?.operator || match?.groups?.suffix;
    const operator = COMPARISON_OPERATOR_CODES[comparisonToken];
    const value = match?.groups?.value;
    if (operator && value) return `${conditionPrefix}_${operator}_${value}`;
  }
  return null;
}

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

function getDrgSpecificName(drgName, adrgName) {
  const normalizedDrgName = String(drgName || '').replace(/\s+/g, ' ').trim();
  const normalizedAdrgName = String(adrgName || '').replace(/\s+/g, ' ').trim();
  if (!normalizedAdrgName) return normalizedDrgName;

  const adrgStart = normalizedDrgName.indexOf(normalizedAdrgName);
  if (adrgStart < 0) return normalizedDrgName;

  return `${normalizedDrgName.slice(0, adrgStart)} ${normalizedDrgName.slice(adrgStart + normalizedAdrgName.length)}`
    .replace(/\s+/g, ' ')
    .trim();
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
  const drgSpecificName = getDrgSpecificName(drgName, adrgData.name);
  const nameConditions = [];

  const ageCondition = inferNumericCondition(drgSpecificName, AGE_NAME_CONDITION_PATTERNS);
  if (ageCondition) nameConditions.push(ageCondition);
  const complicationPair = '(?:合并症[或与]并发症|并发症[或与]合并症)';
  if (new RegExp(`不伴(?:严重|一般)?${complicationPair}`).test(drgSpecificName)) nameConditions.push('NO_CC');
  else if (new RegExp(`伴严重${complicationPair}`).test(drgSpecificName)) nameConditions.push('WITH_MCC');
  else if (new RegExp(`伴(?:严重或一般|一般)?${complicationPair}`).test(drgSpecificName)) nameConditions.push('WITH_CC');
  const crrtHoursCondition = inferNumericCondition(drgSpecificName, CRRT_HOURS_NAME_CONDITION_PATTERNS);
  if (crrtHoursCondition) nameConditions.push(crrtHoursCondition);
  if (/死亡转归/.test(drgSpecificName)) nameConditions.push('DEATH');
  const icuHoursCondition = inferNumericCondition(drgSpecificName, ICU_HOURS_NAME_CONDITION_PATTERNS);
  if (icuHoursCondition) nameConditions.push(icuHoursCondition);
  else if (/伴重症监护/.test(drgSpecificName)) nameConditions.push('INTENSIVE_CARE');
  if (DAY_SURGERY_NAME_PATTERN.test(drgSpecificName)) nameConditions.push('DAY_SURGERY');

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
  } else if (/机器人辅助手术$/.test(drgSpecificName)) {
    rule.conditions.push('ROBOT_ASSISTED_SURGERY');
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
 * parseMDCCodes — extract the leading ICD code from each MDC source row.
 * MDC source rows are `code name` records, and names may contain commas
 * (for example, `Q98.000 ... 47,XXY`). Splitting a row on commas would
 * therefore turn text from a name into false diagnosis codes.
 * - Extracts only a valid ICD-like token at the beginning of each row.
 * - Also accepts a comma-delimited row only when every segment is code-only.
 * - Returns a deduplicated array of code tokens (preserves token case).
 */
function parseMDCCodes(text) {
  if (!text) return [];

  const seen = new Set();
  const out = [];
  const addCode = (token) => {
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  };

  const lines = String(text).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const leadingMatch = line.match(_codeExtractRe);
    if (leadingMatch && _mdcCodeStartRe.test(leadingMatch[1])) {
      addCode(leadingMatch[1]);
      continue;
    }

    // Preserve support for a pure comma-delimited code list without ever
    // treating comma-separated text in a descriptive row as code.
    const codeOnlyParts = line.split(',').map(part => part.trim()).filter(Boolean);
    if (codeOnlyParts.length > 1 && codeOnlyParts.every(part => _mdcCodeTokenRe.test(part))) {
      for (const token of codeOnlyParts) {
        addCode(token);
      }
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
function writeJsonFiles(writeJobs) {
  try {
    for (const [filePath, content] of writeJobs) {
      writeFileIfChanged(filePath, content);
    }
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

const SUBGROUP_COMPLICATION_PRIORITY = Object.freeze({
  WITH_MCC: 0,
  WITH_CC: 1,
  NO_CC: 2,
});
const SUBGROUP_NO_COMPLICATION_PRIORITY = Object.keys(SUBGROUP_COMPLICATION_PRIORITY).length;
const SUBGROUP_COMPLICATION_CONDITIONS = new Set(Object.keys(SUBGROUP_COMPLICATION_PRIORITY));

function orderSubgroupRules(rules) {
  const rulesByAdrg = new Map();
  for (const [sourceIndex, rule] of rules.entries()) {
    const conditions = new Set(rule.conditions || []);
    const drgCode = rule.drgCode;
    const adrgCode = drgCode.slice(0, 3);
    const normalizedCode = drgCode.replace(_suffixRe, '');
    const complicationCondition = Object.keys(SUBGROUP_COMPLICATION_PRIORITY)
      .find(condition => conditions.has(condition)) || null;
    const sections = Object.keys(rule.adrgRule?.sections || {});
    const hasProcedureRule = sections.some(section => section.includes('手术') || section.includes('操作'));
    const hasDiagnosisRule = sections.some(section => section.includes('诊断'));
    const isUnderscoreBranch = drgCode.charAt(3) === '_';
    const extraConditions = new Set(
      [...conditions].filter(condition => !SUBGROUP_COMPLICATION_CONDITIONS.has(condition)),
    );
    const hasAdditionalConstraints = Boolean(rule.adrgRule)
      || [...extraConditions].some(condition => condition !== 'ADRG_ONLY');
    const conditionMultiplicityPriority = hasAdditionalConstraints ? 0 : 1;
    let anchorPriorityClass = 3;
    let extraLogicalPriority = 9;
    if (extraConditions.has('DEATH')) {
      anchorPriorityClass = 0;
      extraLogicalPriority = 0;
    } else if ([...extraConditions].some(condition => condition.startsWith('CRRT_HOURS_'))) {
      anchorPriorityClass = 1;
      extraLogicalPriority = 1;
    } else if (extraConditions.has('DAY_SURGERY')) {
      anchorPriorityClass = 2;
      extraLogicalPriority = 2;
    } else if (isUnderscoreBranch) {
      if (
        extraConditions.has('INTENSIVE_CARE')
        || [...extraConditions].some(condition => condition.startsWith('ICU_HOURS_'))
      ) extraLogicalPriority = 5;
      else if ([...extraConditions].some(condition => condition.startsWith('AGE_'))) {
        extraLogicalPriority = 6;
      } else {
        extraLogicalPriority = 7;
      }
    } else if (
      extraConditions.has('SPECIFIC_PROCEDURE_PREFIX')
      || hasProcedureRule
      || extraConditions.has('ROBOT_ASSISTED_SURGERY')
      || extraConditions.has('NEW_TECHNIQUE')
    ) {
      extraLogicalPriority = 3;
    } else if (extraConditions.has('SPECIFIC_DIAGNOSIS_PREFIX') || hasDiagnosisRule) {
      extraLogicalPriority = 4;
    } else if (
      extraConditions.has('INTENSIVE_CARE')
      || [...extraConditions].some(condition => condition.startsWith('ICU_HOURS_'))
    ) {
      extraLogicalPriority = 5;
    } else if ([...extraConditions].some(condition => condition.startsWith('AGE_'))) {
      extraLogicalPriority = 6;
    }
    const anchorLogicalPriority = complicationCondition !== null && anchorPriorityClass >= 3
      ? 8
      : extraLogicalPriority;
    const lastChar = normalizedCode.at(-1);
    let baseCode = normalizedCode;
    if (lastChar >= 'A' && lastChar <= 'H') {
      const baseSuffix = complicationCondition === 'WITH_MCC'
        ? '1'
        : complicationCondition === 'WITH_CC'
          ? '3'
          : complicationCondition === 'NO_CC'
            ? '5'
            : '9';
      baseCode = `${adrgCode}${baseSuffix}`;
    }
    const entry = {
      rule,
      sourceIndex,
      adrgCode,
      baseCode,
      complicationPriority: complicationCondition === null
        ? SUBGROUP_NO_COMPLICATION_PRIORITY
        : SUBGROUP_COMPLICATION_PRIORITY[complicationCondition],
      conditionMultiplicityPriority,
      anchorPriorityClass,
      anchorLogicalPriority,
      extraLogicalPriority,
      isUnderscoreBranch,
      isBaseRule: drgCode === baseCode,
    };
    if (!rulesByAdrg.has(entry.adrgCode)) rulesByAdrg.set(entry.adrgCode, []);
    rulesByAdrg.get(entry.adrgCode).push(entry);
  }

  const orderedRules = [];
  for (const adrgCode of Object.keys(subgroupOrderOverrides)) {
    if (!rulesByAdrg.has(adrgCode)) {
      throw new Error(`subgroupOrderOverrides references unknown ADRG: ${adrgCode}`);
    }
  }

  for (const entries of rulesByAdrg.values()) {
    const adrgCode = entries[0].adrgCode;
    const configuredOrder = subgroupOrderOverrides[adrgCode] || [];
    const configuredOrderIndex = new Map(
      configuredOrder.map((drgCode, index) => [drgCode, index]),
    );
    const availableCodes = new Set(entries.map(entry => entry.rule.drgCode));
    for (const drgCode of configuredOrder) {
      if (!availableCodes.has(drgCode)) {
        throw new Error(
          `subgroupOrderOverrides.${adrgCode} references unknown DRG: ${drgCode}`,
        );
      }
    }
    const defaultOverridePriority = configuredOrder.length;
    for (const entry of entries) {
      entry.orderOverridePriority = configuredOrderIndex.get(entry.rule.drgCode)
        ?? defaultOverridePriority;
    }

    const groupFirstIndex = new Map();
    for (const entry of entries) {
      if (!groupFirstIndex.has(entry.baseCode)) groupFirstIndex.set(entry.baseCode, entry.sourceIndex);
    }
    for (const entry of entries) entry.baseGroupIndex = groupFirstIndex.get(entry.baseCode);

    entries.sort((left, right) => {
      const orderOverrideDelta = left.orderOverridePriority - right.orderOverridePriority;
      if (orderOverrideDelta !== 0) return orderOverrideDelta;

      const priorityClassDelta = left.anchorPriorityClass - right.anchorPriorityClass;
      if (priorityClassDelta !== 0) return priorityClassDelta;

      const logicalPriorityDelta = left.anchorLogicalPriority - right.anchorLogicalPriority;
      if (logicalPriorityDelta !== 0) return logicalPriorityDelta;

      const complicationDelta = left.complicationPriority - right.complicationPriority;
      if (complicationDelta !== 0) return complicationDelta;

      const conditionMultiplicityDelta =
        left.conditionMultiplicityPriority - right.conditionMultiplicityPriority;
      if (conditionMultiplicityDelta !== 0) return conditionMultiplicityDelta;

      const extraLogicalPriorityDelta = left.extraLogicalPriority - right.extraLogicalPriority;
      if (extraLogicalPriorityDelta !== 0) return extraLogicalPriorityDelta;

      const groupDelta = left.baseGroupIndex - right.baseGroupIndex;
      if (groupDelta !== 0) return groupDelta;

      const baseDelta = Number(left.isBaseRule) - Number(right.isBaseRule);
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
    const sectionMinimumMatches = inferRegionalSectionMinimumMatches(item.content);
    return {
      ...item,
      name: String(drg.description || '').trim(),
      content: prepareExplicitSubgroupRuleContent(item.content),
      ...(Object.keys(sectionMinimumMatches).length > 0 ? { sectionMinimumMatches } : {}),
    };
  });

  const parsePreparedRule = content => parseRule(content, { alreadyNormalized: true });
  const parsedRules = await buildAdrgRules(subgroupSourceEntries, parsePreparedRule, 'explicit subgroup');
  return parsedRules.map(item => ({
    drgCode: item.code,
    drgName: item.name,
    baseAdrg: item.code.slice(0, 3),
    rule: item.rule && item.sectionMinimumMatches
      ? { ...item.rule, sectionMinimumMatches: item.sectionMinimumMatches }
      : item.rule,
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
  subgroupOrderOverrides = versionConfig.subgroupOrderOverrides || {};
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
  const allProcedurePath = path.join(commonRulesDir, 'ALL_PROCEDURE.dat');
  if (fs.existsSync(allProcedurePath)) {
    allProcedureCodes = loadDat(allProcedurePath, 'simple');
    if (Object.keys(allProcedureCodes).length === 0) {
      throw new Error(`ALL_PROCEDURE.dat exists but contains no entries: ${allProcedurePath}`);
    }
  } else {
    allProcedureCodes = undefined;
  }
  const commonConfig = configResolver.resolveCommonConfig(commonPackage);
  qyDiffEntries = deriveQyDiffEntries(
    commonConfig.insuranceIcd,
    allProcedureCodes,
    ssInvalid,
  );
  const qyDiffRawPath = path.join(commonRulesDir, 'QY_DIFF.dat');
  qyDiffCodes = qyDiffEntries && fs.existsSync(qyDiffRawPath)
    ? loadDat(qyDiffRawPath, 'simple')
    : undefined;
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
  if (buildCommon || buildVersion) {
    const ruleParserPath = pathToFileUrl(path.resolve(__dirname, '../src/lib/ruleParserCore.ts'));
    try {
      const rp = await import(ruleParserPath);
      parseRule = rp.parseRule;
      inferRegionalSectionMinimumMatches = rp.inferRegionalSectionMinimumMatches;
      if (typeof inferRegionalSectionMinimumMatches !== 'function') throw new Error('ruleParserCore must export inferRegionalSectionMinimumMatches');
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
  const stripContent = rule => Object.fromEntries(
    Object.entries(rule).filter(([key]) => key !== 'content'),
  );
  const adrgRulesForWrite = keepContent ? adrgRules : adrgRules.map(stripContent);
  const mdcRulesForWrite = keepContent ? mdcRules : mdcRules.map(stripContent);

  if (buildCommon) {
    const qyDiffRawPath = path.join(commonRulesDir, 'QY_DIFF.dat');
    const qyDiffOutputPath = path.join(commonOutputDir, 'qy_diff_codes.json');
    const allProcedureOutputPath = path.join(commonOutputDir, 'all_procedure_codes.json');
    if (qyDiffEntries && qyDiffEntries.length > 0) {
      // Keep one auditable code/name copy in raw; the generated JSON below is
      // the compact code-only representation consumed by the runtime.
      writeFileIfChanged(qyDiffRawPath, renderCodeNameDat(qyDiffEntries), 'utf8');
      qyDiffCodes = loadDat(qyDiffRawPath, 'simple');
    } else {
      qyDiffCodes = undefined;
      if (fs.existsSync(qyDiffRawPath)) fs.unlinkSync(qyDiffRawPath);
    }
    if ((!qyDiffCodes || Object.keys(qyDiffCodes).length === 0)
      && fs.existsSync(qyDiffOutputPath)) {
      fs.unlinkSync(qyDiffOutputPath);
    }
    if (!allProcedureCodes && fs.existsSync(allProcedureOutputPath)) {
      fs.unlinkSync(allProcedureOutputPath);
    }
    await writeJsonFiles([
      [path.join(commonOutputDir, 'cc_codes.json'), JSON.stringify(ccCodes, null, 2)],
      [path.join(commonOutputDir, 'mcc_codes.json'), JSON.stringify(mccCodes, null, 2)],
      [path.join(commonOutputDir, 'cce_codes.json'), JSON.stringify(cceCodes, null, 2)],
      [path.join(commonOutputDir, 'zd_invalid.json'), JSON.stringify(zdInvalid, null, 2)],
      [path.join(commonOutputDir, 'ss_invalid.json'), JSON.stringify(ssInvalid, null, 2)],
      ...(allProcedureCodes && Object.keys(allProcedureCodes).length > 0
        ? [[allProcedureOutputPath, JSON.stringify(allProcedureCodes, null, 2)]]
        : []),
      ...(qyDiffCodes && Object.keys(qyDiffCodes).length > 0
        ? [[path.join(commonOutputDir, 'qy_diff_codes.json'), JSON.stringify(qyDiffCodes, null, 2)]]
        : []),
      [path.join(commonOutputDir, 'adrg_rules.json'), JSON.stringify(adrgRulesForWrite, null, 2)],
      [path.join(commonOutputDir, 'mdc_rules.json'), JSON.stringify(mdcRulesForWrite, null, 2)],
    ]);
    console.log('DRG common package generated.');
  }

  if (!buildVersion) return;

  console.log('Deriving DRG subgroup rules...');
  const { subgroupRules: derivedRules, skippedDRGList } = deriveSubgroupRules(drgMap, adrgRules);
  const explicitSubgroupRules = parseRule && hasSubgroupRulesSource
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
  await writeJsonFiles(writeJobs);

  try {
    const skippedPath = path.join(dataDir, 'skipped_drgs.json');
    if (fs.existsSync(skippedPath)) fs.unlinkSync(skippedPath);
  } catch {
    // Skipped-DRG cleanup is best effort and should not hide generated output.
  }

  console.log('Build complete: JSON files generated for browser use.');
}

function pathToFileUrl(p) {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') resolved = '/' + resolved.replace(/\\/g, '/');
  return `file://${resolved}`;
}

function readConfigs(versionId) {
  if (versionId) {
    const configPath = path.join(versionsDir, versionId, 'config.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Unknown DRG version: ${versionId}`);
    }
    return [configResolver.resolveVersionConfig(versionId).versionConfig];
  }
  return configResolver.listResolvedVersionConfigs().map(
    config => config.versionConfig,
  );
}

async function runCli() {
  const [scope = 'all', requestedId] = process.argv.slice(2);
  if (!['all', 'common', 'version'].includes(scope)) {
    throw new Error('Usage: build_rules_json.cjs [all | common <package-id> | version <version-id>]');
  }

  if (scope === 'version') {
    const configs = readConfigs(requestedId);
    for (const config of configs) {
      await buildPackage('version', config, config.drgCommon);
    }
    return;
  }

  const configs = readConfigs();

  if (scope === 'common') {
    if (!requestedId) throw new Error('DRG common package ID is required');
    const config = configs.find(item => item.drgCommon === requestedId);
    if (!config) throw new Error(`DRG common package is not referenced by any version: ${requestedId}`);
    await buildPackage('common', config, requestedId);
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
