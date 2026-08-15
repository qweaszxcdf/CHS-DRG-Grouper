import type {
  AdrgDefinition,
  DrgSubgroupRule,
  MdcDefinition,
  NameMap,
  NameMapWithInitials,
  RuleData,
  RuleSet,
} from '../types/rules.js';

function splitNameMap(raw: NameMapWithInitials | undefined): {
  names: NameMap;
  initials: Record<string, string>;
} {
  const names: NameMap = {};
  const initials = raw?._initials ?? {};

  for (const [code, value] of Object.entries(raw ?? {})) {
    if (code !== '_initials' && typeof value === 'string') {
      names[code] = value;
    }
  }

  return { names, initials };
}

export function createRuleSet(data: RuleData): RuleSet {
const { adrgRules, mdcRules, ccCodes, mccCodes, cceCodes, zdInvalid, ssInvalid, icd10GrayJson, icd9GrayJson, drgSubgroupRules, drgMap, glDiagNames = {}, glProcNames = {}, ybDiagNames, ybProcNames, icdGlToYbRaw = {}, icd9GlToYbRaw = {} } = data;

// Split _initials from name maps once at module load, not per lookup.
const { names: glDiagNamesOnly, initials: _glDiagInitials } = splitNameMap(glDiagNames);
const { names: glProcNamesOnly, initials: _glProcInitials } = splitNameMap(glProcNames);
const { names: ybDiagNamesOnly, initials: _ybDiagInitials } = splitNameMap(ybDiagNames);
const { names: ybProcNamesOnly, initials: _ybProcInitials } = splitNameMap(ybProcNames);

// --- CC/MCC/CCE loaders ---
function loadCCCodes() {
    return ccCodes;
}
function loadMCCCodes() {
    return mccCodes;
}
function loadCCECodes() {
    return cceCodes;
}

// --- Invalid Code Checkers ---
function isInvalidDiagnosis(code: string | null | undefined) {
    return code ? !!zdInvalid[code] : false;
}
function isInvalidProcedure(code: string | null | undefined) {
    return code ? !!ssInvalid[code] : false;
}

function isGrayDiag(code: string | null | undefined) {
    return code ? !!icd10GrayJson[code] : false;
}

function isGrayProc(code: string | null | undefined) {
    return code ? !!icd9GrayJson[code] : false;
}

// --- DRG descriptions and weights ---

function loadDRGSubgroupRules() {
    return drgSubgroupRules;
}

// Build an index of subgroup rules by ADRG code for fast lookup during grouping
const adrgToSubgroupRules = new Map<string, DrgSubgroupRule[]>();
if (Array.isArray(drgSubgroupRules)) {
    for (const r of drgSubgroupRules) {
        const list = adrgToSubgroupRules.get(r.adrgCode) || [];
        list.push(r);
        adrgToSubgroupRules.set(r.adrgCode, list);
    }
}

function loadDRGSubgroupRulesForADRG(adrgCode: string) {
    return adrgToSubgroupRules.get(adrgCode) || [];
}

// --- Rule Loader ---
// Use `adrgRules` and `mdcRules` directly rather than exporting a combined `generatedRules`.

// --- Grouper Data Definitions ---

const mdcMap: Record<string, MdcDefinition> = {};
const adrgMap: Record<string, AdrgDefinition> = {};
const adrgList: AdrgDefinition[] = [];

// Process MDC entries (use only build-time parsed fields)
if (Array.isArray(mdcRules)) {
    for (const item of mdcRules) {
        if (item.type === 'MDC') {
            const identifyingDiagnoses = Array.isArray(item.identifyingDiagnoses) ? item.identifyingDiagnoses : [];
            const mdczCategories = item.mdczCategories || null;

            mdcMap[item.code] = {
                code: item.code,
                description: item.name ?? '',
                identifyingDiagnoses,
                mdczCategories
            };
        }
    }
}

// Process ADRG entries (use only build-time parsed `item.rule`)
if (Array.isArray(adrgRules)) {
    for (const item of adrgRules) {
        if (item.type === 'ADRG') {
            const ruleObj = item.rule || null;

            const adrg = {
                ...item,
                code: item.code,
                description: item.name,
                rule: ruleObj
            };
            adrgMap[item.code] = adrg;
            adrgList.push(adrg);
        }
    }
}

// Build a mapping from ADRG first-letter -> ADRG objects for fast lookup
const adrgByFirstChar = new Map<string, AdrgDefinition[]>();
for (const a of adrgList) {
    const k = String(a.code || '').charAt(0);
    const arr = adrgByFirstChar.get(k) || [];
    arr.push(a);
    adrgByFirstChar.set(k, arr);
}

// Cached resolver: compute ADRG objects for a given MDC code using the first-char rule
const _adrgByMdcCache = new Map<string, AdrgDefinition[]>();
function getADRGsForMDC(mdcCode: string | null | undefined): AdrgDefinition[] {
    if (!mdcCode) return [];
    // Only resolve ADRGs for known MDC codes
    if (!mdcByCode.has(mdcCode)) return [];
    if (_adrgByMdcCache.has(mdcCode)) return _adrgByMdcCache.get(mdcCode) as AdrgDefinition[];

    const mdcLetter = String(mdcCode).replace(/^MDC/, '').charAt(0);
    const list = adrgByFirstChar.get(mdcLetter) || [];
    _adrgByMdcCache.set(mdcCode, list);
    return list;
}

// --- Post-processing: build quick lookup maps and Sets for fast runtime checks
// Convert identifyingDiagnoses arrays to Sets and build mdcByCode
const mdcByCode = new Map<string, MdcDefinition>();
for (const [code, m] of Object.entries(mdcMap)) {
    const ids = Array.isArray(m.identifyingDiagnoses) ? m.identifyingDiagnoses : [];
    m.identifyingDiagnosesSet = new Set(ids);
    const mdc = mdcMap[code];
    if (mdc) mdcByCode.set(code, mdc);
}

// Build diag -> MDCZ categories mapping for fast MDCZ detection
const diagToMDCZCategories = new Map<string, Set<string>>();
const mdczItem = Array.isArray(mdcRules) ? mdcRules.find((r) => r.type === 'MDC' && r.code === 'MDCZ') : undefined;
if (mdczItem && mdczItem.mdczCategories) {
    const categories = mdczItem.mdczCategories;
    for (const [cat, codes] of Object.entries(categories)) {
        for (const code of codes) {
            const s = diagToMDCZCategories.get(code) || new Set<string>();
            s.add(cat);
            diagToMDCZCategories.set(code, s);
        }
    }
}

const MDCs = Object.values(mdcMap)
    .sort((a, b) => a.code.localeCompare(b.code));
function getADRGByCode(code: string) {
    return adrgMap[code];
}

// --- Loader exports for centralized JSON access ---
function loadDRGMap() {
    return drgMap || {};
}
function loadADRGRules() {
    return adrgRules || [];
}
function loadMDCRules() {
    return mdcRules || [];
}
function loadGLDiagNames() { return glDiagNamesOnly; }
function loadGLProcNames() { return glProcNamesOnly; }
function loadYBDiagNames() { return ybDiagNamesOnly; }
function loadYBProcNames() { return ybProcNamesOnly; }
function loadGLInitialsDiag() { return _glDiagInitials || {}; }
function loadGLInitialsProc() { return _glProcInitials || {}; }
function loadYBInitialsDiag() { return _ybDiagInitials || {}; }
function loadYBInitialsProc() { return _ybProcInitials || {}; }
function loadICDGlYBMap() { return icdGlToYbRaw || {}; }
function loadICD9GlYBMap() { return icd9GlToYbRaw || {}; }
return { loadCCCodes, loadMCCCodes, loadCCECodes, isInvalidDiagnosis, isInvalidProcedure, isGrayDiag, isGrayProc, loadDRGSubgroupRules, loadDRGSubgroupRulesForADRG, getADRGsForMDC, MDCs, mdcByCode, diagToMDCZCategories, getADRGByCode, loadDRGMap, loadADRGRules, loadMDCRules, loadGLDiagNames, loadGLProcNames, loadYBDiagNames, loadYBProcNames, loadGLInitialsDiag, loadGLInitialsProc, loadYBInitialsDiag, loadYBInitialsProc, loadICDGlYBMap, loadICD9GlYBMap };
}
