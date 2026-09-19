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

function createCodeChecker(index: Record<string, unknown>) {
  return (code: string): boolean => Object.hasOwn(index, code);
}

export function createRuleSet(data: RuleData): RuleSet {
  const {
    adrgRules,
    mdcRules,
    ccCodes,
    mccCodes,
    cceCodes,
    allProcedureCodes = {},
    qyDiffCodes = {},
    zdInvalid,
    ssInvalid,
    icd10GrayJson,
    icd9GrayJson,
    drgSubgroupRules,
    drgMap,
    glDiagNames = {},
    glProcNames = {},
    ybDiagNames,
    ybProcNames,
    icdGlToYbRaw = {},
    icd9GlToYbRaw = {},
  } = data;

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
  function loadAllProcedureCodes() {
    return allProcedureCodes;
  }
  function loadQyDiffCodes() {
    return qyDiffCodes;
  }

  // --- Invalid Code Checkers ---
  const isInvalidDiagnosis = createCodeChecker(zdInvalid);
  const isInvalidProcedure = createCodeChecker(ssInvalid);
  const isGrayDiag = createCodeChecker(icd10GrayJson);
  const isGrayProc = createCodeChecker(icd9GrayJson);

  // --- DRG descriptions and weights ---

  function loadDRGSubgroupRules() {
    return drgSubgroupRules;
  }

  // Build an index of subgroup rules by ADRG code for fast lookup during grouping
  const adrgToSubgroupRules = new Map<string, DrgSubgroupRule[]>();
  for (const r of drgSubgroupRules) {
    const list = adrgToSubgroupRules.get(r.adrgCode) ?? [];
    list.push(r);
    adrgToSubgroupRules.set(r.adrgCode, list);
  }

  function loadDRGSubgroupRulesForADRG(adrgCode: string) {
    return adrgToSubgroupRules.get(adrgCode) ?? [];
  }

  // --- Rule Loader ---
  // Use `adrgRules` and `mdcRules` directly rather than exporting a combined `generatedRules`.

  // --- Grouper Data Definitions ---

  const mdcMap: Record<string, MdcDefinition> = {};
  const adrgMap: Record<string, AdrgDefinition> = {};
  const adrgList: AdrgDefinition[] = [];

  // Process MDC entries (use only build-time parsed fields)
  for (const item of mdcRules) {
    if (item.type === 'MDC') {
      const identifyingDiagnoses = item.identifyingDiagnoses ?? [];
      const mdczCategories = item.mdczCategories ?? null;

      mdcMap[item.code] = {
        code: item.code,
        description: item.name ?? '',
        identifyingDiagnoses,
        identifyingDiagnosesSet: new Set(identifyingDiagnoses),
        mdczCategories
      };
    }
  }

  // Process ADRG entries (use only build-time parsed `item.rule`)
  for (const item of adrgRules) {
    if (item.type === 'ADRG') {
      const ruleObj = item.rule ?? null;

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

  // Build a mapping from ADRG first-letter -> ADRG objects for fast lookup
  const adrgByFirstChar = new Map<string, AdrgDefinition[]>();
  for (const a of adrgList) {
    const k = a.code.charAt(0);
    const arr = adrgByFirstChar.get(k) ?? [];
    arr.push(a);
    adrgByFirstChar.set(k, arr);
  }

  // Cached resolver: compute ADRG objects for a given MDC code using the first-char rule
  const _adrgByMdcCache = new Map<string, AdrgDefinition[]>();
  function getADRGsForMDC(mdcCode: string): AdrgDefinition[] {
    // Only resolve ADRGs for known MDC codes
    if (!mdcByCode.has(mdcCode)) return [];
    const cached = _adrgByMdcCache.get(mdcCode);
    if (cached) return cached;

    const mdcLetter = mdcCode.replace(/^MDC/, '').charAt(0);
    const list = adrgByFirstChar.get(mdcLetter) ?? [];
    _adrgByMdcCache.set(mdcCode, list);
    return list;
  }

  // --- Post-processing: build quick lookup maps and Sets for fast runtime checks
  // Build the MDC lookup map.
  const mdcByCode = new Map<string, MdcDefinition>();
  for (const [code, m] of Object.entries(mdcMap)) {
    mdcByCode.set(code, m);
  }

  // Build diag -> MDCZ categories mapping for fast MDCZ detection
  const diagToMDCZCategories = new Map<string, string>();
  const mdczItem = mdcRules.find((r) => r.type === 'MDC' && r.code === 'MDCZ');
  if (mdczItem && mdczItem.mdczCategories) {
    const categories = mdczItem.mdczCategories;
    for (const [cat, codes] of Object.entries(categories)) {
      for (const code of codes) {
        const existingCategory = diagToMDCZCategories.get(code);
        if (existingCategory !== undefined && existingCategory !== cat) {
          throw new Error(`MDCZ diagnosis ${code} belongs to multiple categories: ${existingCategory}, ${cat}`);
        }
        diagToMDCZCategories.set(code, cat);
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
    return drgMap;
  }
  function loadADRGRules() {
    return adrgRules;
  }
  function loadMDCRules() {
    return mdcRules;
  }
  function loadGLDiagNames() { return glDiagNamesOnly; }
  function loadGLProcNames() { return glProcNamesOnly; }
  function loadYBDiagNames() { return ybDiagNamesOnly; }
  function loadYBProcNames() { return ybProcNamesOnly; }
  function loadGLInitialsDiag() { return _glDiagInitials; }
  function loadGLInitialsProc() { return _glProcInitials; }
  function loadYBInitialsDiag() { return _ybDiagInitials; }
  function loadYBInitialsProc() { return _ybProcInitials; }
  function loadICDGlYBMap() { return icdGlToYbRaw; }
  function loadICD9GlYBMap() { return icd9GlToYbRaw; }
  return {
    loadCCCodes,
    loadMCCCodes,
    loadCCECodes,
    loadAllProcedureCodes,
    loadQyDiffCodes,
    isInvalidDiagnosis,
    isInvalidProcedure,
    isGrayDiag,
    isGrayProc,
    loadDRGSubgroupRules,
    loadDRGSubgroupRulesForADRG,
    getADRGsForMDC,
    MDCs,
    mdcByCode,
    diagToMDCZCategories,
    getADRGByCode,
    loadDRGMap,
    loadADRGRules,
    loadMDCRules,
    loadGLDiagNames,
    loadGLProcNames,
    loadYBDiagNames,
    loadYBProcNames,
    loadGLInitialsDiag,
    loadGLInitialsProc,
    loadYBInitialsDiag,
    loadYBInitialsProc,
    loadICDGlYBMap,
    loadICD9GlYBMap,
  };
}
