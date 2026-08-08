export function createRuleSet(data) {
const { adrgRules, mdcRules, ccCodes, mccCodes, cceCodes, zdInvalid, ssInvalid, icd10GrayJson, icd9GrayJson, drgSubgroupRules, drgMap, glDiagNames = {}, glProcNames = {}, ybDiagNames, ybProcNames, icdGlToYbRaw = {}, icd9GlToYbRaw = {} } = data;

// Split _initials from name maps once at module load — O(1) destructuring, not per-call.
const { _initials: _glDiagInitials, ...glDiagNamesOnly } = glDiagNames;
const { _initials: _glProcInitials, ...glProcNamesOnly } = glProcNames;
const { _initials: _ybDiagInitials, ...ybDiagNamesOnly } = ybDiagNames;
const { _initials: _ybProcInitials, ...ybProcNamesOnly } = ybProcNames;

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
function isInvalidDiagnosis(code) {
    return !!zdInvalid[code];
}
function isInvalidProcedure(code) {
    return !!ssInvalid[code];
}

function isGrayDiag(code) {
    return !!icd10GrayJson[code];
}

function isGrayProc(code) {
    return !!icd9GrayJson[code];
}

// --- DRG descriptions and weights ---

function loadDRGSubgroupRules() {
    return drgSubgroupRules;
}

// Build an index of subgroup rules by ADRG code for fast lookup during grouping
const adrgToSubgroupRules = new Map();
if (Array.isArray(drgSubgroupRules)) {
    for (const r of drgSubgroupRules) {
        const list = adrgToSubgroupRules.get(r.adrgCode) || [];
        list.push(r);
        adrgToSubgroupRules.set(r.adrgCode, list);
    }
}

function loadDRGSubgroupRulesForADRG(adrgCode) {
    return adrgToSubgroupRules.get(adrgCode) || [];
}

// --- Rule Loader ---
// Use `adrgRules` and `mdcRules` directly rather than exporting a combined `generatedRules`.

// --- Grouper Data Definitions ---

const mdcMap = {};
const adrgMap = {};
const adrgList = [];

// Process MDC entries (use only build-time parsed fields)
if (Array.isArray(mdcRules)) {
    for (const item of mdcRules) {
        if (item.type === 'MDC') {
            const identifyingDiagnoses = Array.isArray(item.identifyingDiagnoses) ? item.identifyingDiagnoses : [];
            const mdczCategories = item.mdczCategories || null;

            mdcMap[item.code] = {
                code: item.code,
                description: item.name,
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
const adrgByFirstChar = new Map();
for (const a of adrgList) {
    const k = String(a.code || '').charAt(0);
    const arr = adrgByFirstChar.get(k) || [];
    arr.push(a);
    adrgByFirstChar.set(k, arr);
}

// Cached resolver: compute ADRG objects for a given MDC code using the first-char rule
const _adrgByMdcCache = new Map();
function getADRGsForMDC(mdcCode) {
    if (!mdcCode) return [];
    // Only resolve ADRGs for known MDC codes
    if (!mdcByCode.has(mdcCode)) return [];
    if (_adrgByMdcCache.has(mdcCode)) return _adrgByMdcCache.get(mdcCode);

    const mdcLetter = String(mdcCode).replace(/^MDC/, '').charAt(0);
    const list = adrgByFirstChar.get(mdcLetter) || [];
    _adrgByMdcCache.set(mdcCode, list);
    return list;
}

// --- Post-processing: build quick lookup maps and Sets for fast runtime checks
// Convert identifyingDiagnoses arrays to Sets and build mdcByCode
const mdcByCode = new Map();
for (const [code, m] of Object.entries(mdcMap)) {
    const ids = Array.isArray(m.identifyingDiagnoses) ? m.identifyingDiagnoses : [];
    m.identifyingDiagnosesSet = new Set(ids);
    mdcByCode.set(code, mdcMap[code]);
}

// Build diag -> MDCZ categories mapping for fast MDCZ detection
const diagToMDCZCategories = new Map();
const mdczItem = Array.isArray(mdcRules) ? mdcRules.find(r => r.type === 'MDC' && r.code === 'MDCZ') : undefined;
if (mdczItem && mdczItem.mdczCategories) {
    const categories = mdczItem.mdczCategories;
    for (const [cat, codes] of Object.entries(categories)) {
        for (const code of codes) {
            const s = diagToMDCZCategories.get(code) || new Set();
            s.add(cat);
            diagToMDCZCategories.set(code, s);
        }
    }
}

const MDCs = Object.values(mdcMap)
    .sort((a, b) => a.code.localeCompare(b.code));
function getADRGByCode(code) {
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
