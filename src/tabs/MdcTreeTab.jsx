/**
 * MDC/ADRG/DRG tree explorer component for DRG grouper rule inspection.
 *
 * This module has three major parts:
 * 1) data normalization + token matching utilities
 * 2) tree building + filtering helpers
 * 3) React components for rendering the tree and node details
 */
import { useMemo, useState, useEffect, useRef, useCallback, memo, Fragment } from 'react';
import { loadRuleSetAsync } from '../services/ruleSetLoader.js';
import { getVersionDefinition } from '../services/generated/versionRegistry.js';

// --- Shared helpers

/**
 * Normalize a value for case-insensitive token/phrase matching.
 * @param {any} v The input text.
 * @returns {string} Lower-case trimmed text.
 */
function normalizeText(v) {
  return String(v || '').trim().toLowerCase();
}

// Selector type tags used by the UI detail panel.
const SELECTION_TYPES = Object.freeze({
  MDC: 'MDC',
  ADRG: 'ADRG',
  DRG: 'DRG',
});

const ALL_ADRG_CHANGED = '__ALL__';
// ICD-10 codes may use either a numeric extension (`.001`) or the
// insurance-code form with an `x` placeholder (`.x01`, `.001x002`).
const ICD_TOKEN_PREFIX_RE = /^(?:(?:[A-Za-z][0-9]{2}|[0-9]{2})(?:\.(?:(?:[0-9]{1,4}(?:x[0-9]+)?)|x[0-9]+)?)?\*?)(?:\+(?:(?:[A-Za-z][0-9]{2}|[0-9]{2})(?:\.(?:(?:[0-9]{1,4}(?:x[0-9]+)?)|x[0-9]+)?)?\*?))*$/i;
const CODE_QUERY_TOKEN_RE = /^(?:[A-Za-z][0-9]{2}|[0-9]{2})(?:\.(?:(?:[0-9]{1,4}(?:x[0-9]+)?)|x[0-9]+)?)?\*?$/i;
const EMPTY_LIST = Object.freeze([]);
const CODE_PART_SPLIT_RE = /[^0-9a-z.x*]+/i;
const QUERY_PART_SPLIT_RE = /[\s+]+/;
const SPECIFIC_EXACT_SCORE = 10000;
const MDC_TREE_CACHE = new Map();
const COMMON_MDC_TREE_CACHE = new Map();

const DEFAULT_RULE_EVAL_META = Object.freeze({
  isAdrgOnly: false,
  hasSpecificProcedure: false,
  hasSpecificProcedurePrefix: false,
  hasSpecificDiagnosis: false,
  hasSpecificDiagnosisPrefix: false,
  procedureCodes: EMPTY_LIST,
  procedurePrefixes: EMPTY_LIST,
  diagnosisCodes: EMPTY_LIST,
  diagnosisPrefixes: EMPTY_LIST,
});

function splitCodeParts(value) {
  return String(value || '')
    .split(CODE_PART_SPLIT_RE)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function splitQueryParts(value) {
  return String(value || '')
    .split(QUERY_PART_SPLIT_RE)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

/**
 * Collect all rule tokens that can be used for code-based search matching.
 * Works for ADRG and DRG rule objects.
 * @param {object} rule Rule object from JSON declaration.
 * @returns {string[]} normalized token list
 */
function getRuleTokenSearchTokens(rule) {
  const srcRule = rule || {};
  const diagCodes = Array.isArray(srcRule.diagnosisCodes) ? srcRule.diagnosisCodes : [];
  const procCodes = Array.isArray(srcRule.procedureCodes) ? srcRule.procedureCodes : [];
  const diagPrefixes = Array.isArray(srcRule.diagnosisPrefixes) ? srcRule.diagnosisPrefixes : [];
  const procPrefixes = Array.isArray(srcRule.procedurePrefixes) ? srcRule.procedurePrefixes : [];
  const rawTokens = [];

  if (diagCodes.length > 0) rawTokens.push(...diagCodes);
  if (procCodes.length > 0) rawTokens.push(...procCodes);
  if (diagPrefixes.length > 0) rawTokens.push(...diagPrefixes);
  if (procPrefixes.length > 0) rawTokens.push(...procPrefixes);

  if (srcRule.sections && typeof srcRule.sections === 'object') {
    for (const section of Object.values(srcRule.sections)) {
      if (Array.isArray(section)) {
        rawTokens.push(...section);
      }
    }
  }
  if (srcRule.adrgRule?.sections && typeof srcRule.adrgRule.sections === 'object') {
    for (const section of Object.values(srcRule.adrgRule.sections)) {
      if (Array.isArray(section)) rawTokens.push(...section);
    }
  }

  const normalized = [];
  for (const token of rawTokens) {
    const norm = normalizeText(token);
    if (norm) normalized.push(norm);
  }
  return normalized;
}

function getSubgroupAdrgRuleCodes(rule) {
  const diagnosisCodes = [];
  const procedureCodes = [];
  const sections = rule?.adrgRule?.sections;
  if (!sections || typeof sections !== 'object') return { diagnosisCodes, procedureCodes };

  for (const [sectionName, codes] of Object.entries(sections)) {
    if (!Array.isArray(codes)) continue;
    const normalizedCodes = codes.map(code => normalizeText(String(code || ''))).filter(Boolean);
    if (sectionName.includes('诊断')) diagnosisCodes.push(...normalizedCodes);
    else if (sectionName.includes('手术') || sectionName.includes('操作')) procedureCodes.push(...normalizedCodes);
  }
  return {
    diagnosisCodes: [...new Set(diagnosisCodes)],
    procedureCodes: [...new Set(procedureCodes)],
  };
}

/**
 * Checks whether a source code token set matches a normalized query phrase.
 * Supports:
 * - exact token equality
 * - code token prefix/suffix inclusion (with ICD token guard)
 * - multi-token queries separated by + or whitespace
 */
function codeMatchesText(codeText, queryNorm, queryParts = null) {
  if (!codeText || !queryNorm) return false;

  const normalizedCodeParts = Array.isArray(codeText)
    ? codeText.map((part) => normalizeText(part)).filter(Boolean)
    : splitCodeParts(codeText);

  const normalizedQueryParts = Array.isArray(queryParts)
    ? queryParts.map((part) => normalizeText(part)).filter(Boolean)
    : splitQueryParts(queryNorm);

  if (normalizedQueryParts.length === 0) return false;

  for (const queryPart of normalizedQueryParts) {
    let matched = false;
    for (const candidate of normalizedCodeParts) {
      if (!candidate || !queryPart) continue;
      if (candidate === queryPart || (ICD_TOKEN_PREFIX_RE.test(candidate) && (candidate.startsWith(queryPart) || candidate.endsWith(queryPart)))) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  return true;
}

// --- Rule-aware helpers for DRG filtering
function buildSearchMeta(code, name, extraText = '') {
  const codeNorm = normalizeText(code);
  const nameNorm = normalizeText(name);
  const textNorm = `${codeNorm} ${nameNorm} ${normalizeText(extraText)}`.trim();
  const codeTokens = codeNorm ? splitCodeParts(codeNorm) : EMPTY_LIST;
  return { codeNorm, textNorm, codeTokens };
}

function nodeMatchesQuery(node, qNorm) {
  const codeNorm = node?._search?.codeNorm || '';
  const textNorm = node?._search?.textNorm || '';
  return codeNorm.includes(qNorm) || textNorm.includes(qNorm);
}

function getDrgSearchMeta(drg) {
  const rule = drg?.rule || {};
  return drg?._search || buildSearchMeta(rule.drgCode || '', rule.drgName || '');
}

function getSearchMetaCodeTokens(searchMeta) {
  if (Array.isArray(searchMeta?.codeTokens)) return searchMeta.codeTokens;
  if (!searchMeta?.codeNorm) return EMPTY_LIST;
  return splitCodeParts(searchMeta.codeNorm);
}

function drgNameMatchesQuery(searchMeta, qNorm, queryParts, queryIsExactCode) {
  if (!qNorm) return false;
  if (!queryIsExactCode) return searchMeta.textNorm.includes(qNorm);

  return codeMatchesText(getSearchMetaCodeTokens(searchMeta), qNorm, queryParts)
    || searchMeta.textNorm.includes(qNorm);
}

function getDrgRuleEvalMeta(drg) {
  return drg?._ruleEvalMeta || DEFAULT_RULE_EVAL_META;
}

function evaluateSpecificMatch(ruleEvalMeta, qNorm) {
  let specificScore = 0;

  const procedureCodeMatch = ruleEvalMeta.hasSpecificProcedure && ruleEvalMeta.procedureCodes.some((code) => {
    if (!code.startsWith(qNorm)) return false;
    specificScore = Math.max(specificScore, SPECIFIC_EXACT_SCORE);
    return true;
  });

  const procedurePrefixMatch = ruleEvalMeta.hasSpecificProcedurePrefix && qNorm && ruleEvalMeta.procedurePrefixes.some((prefix) => {
    if (!qNorm.startsWith(prefix)) return false;
    specificScore = Math.max(specificScore, prefix.length);
    return true;
  });

  const diagnosisCodeMatch = ruleEvalMeta.hasSpecificDiagnosis && ruleEvalMeta.diagnosisCodes.some((code) => {
    if (!code.startsWith(qNorm)) return false;
    specificScore = Math.max(specificScore, SPECIFIC_EXACT_SCORE);
    return true;
  });

  const diagnosisPrefixMatch = ruleEvalMeta.hasSpecificDiagnosisPrefix && qNorm && ruleEvalMeta.diagnosisPrefixes.some((prefix) => {
    if (!qNorm.startsWith(prefix)) return false;
    specificScore = Math.max(specificScore, prefix.length);
    return true;
  });

  const specificMatched = procedureCodeMatch || procedurePrefixMatch || diagnosisCodeMatch || diagnosisPrefixMatch;
  const ruleMatched = ruleEvalMeta.isAdrgOnly ? true : specificMatched;

  return {
    specificMatched,
    specificScore,
    ruleMatched,
  };
}

function buildDrgMatchEntry(drg, qNorm, queryParts, queryIsExactCode, adrgHit) {
  const searchMeta = getDrgSearchMeta(drg);
  const nameMatch = drgNameMatchesQuery(searchMeta, qNorm, queryParts, queryIsExactCode);

  if ((nameMatch && !adrgHit) || !queryIsExactCode || !qNorm) {
    if (!nameMatch) return null;
    return {
      drg,
      nameMatch,
      specificMatched: false,
      isAdrgOnly: false,
      specificScore: 0,
    };
  }

  const ruleEvalMeta = getDrgRuleEvalMeta(drg);
  const specific = evaluateSpecificMatch(ruleEvalMeta, qNorm);
  if (!(specific.ruleMatched || nameMatch)) return null;

  return {
    drg,
    nameMatch,
    specificMatched: specific.specificMatched,
    isAdrgOnly: ruleEvalMeta.isAdrgOnly,
    specificScore: specific.specificScore,
  };
}



// --- Selection helpers
function selectionScopeChanged(prev, next, isPrevAffected, isNextAffected) {
  if (isPrevAffected !== isNextAffected) return true;
  if (!(isPrevAffected || isNextAffected)) return false;
  if (prev.selectedNodeKey !== next.selectedNodeKey) return true;
  if (prev.selectedRule !== next.selectedRule) return true;

  const prevParsedExpanded = prev.detailProps ? prev.detailProps.parsedExpanded : prev.parsedExpanded;
  const nextParsedExpanded = next.detailProps ? next.detailProps.parsedExpanded : next.parsedExpanded;
  if (prevParsedExpanded !== nextParsedExpanded) return true;

  return false;
}

// --- Selection builders
function buildDrgSelectionRule(mdc, adrg, drg) {
  return {
    __selectionType: SELECTION_TYPES.DRG,
    drgRule: drg.rule || null,
    drg,
    adrg: { code: adrg.code, name: adrg.name },
    mdc: { code: mdc.code, name: mdc.name },
  };
}

// --- Hooks
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = useState(value);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebounced(value), delayMs);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, delayMs]);

  return debounced;
}

// --- Builders: maps and nodes
function buildAdrgNameByCodeMap(adrgRules) {
  const map = new Map();
  for (const item of Array.isArray(adrgRules) ? adrgRules : []) {
    if (!item || item.type !== 'ADRG' || !item.code) continue;
    map.set(String(item.code), String(item.name || ''));
  }
  return map;
}

function buildDrgByAdrgMap(drgRules, drgMap) {
  const mapRes = new Map();

  for (const item of Array.isArray(drgRules) ? drgRules : []) {
    if (!item || !item.adrgCode || !item.drgCode) continue;

    const drgCode = String(item.drgCode);
    const adrgCode = String(item.adrgCode);
    const mapItem = drgMap ? drgMap[drgCode] : null;
    const drgName = String((mapItem && mapItem.description) || item.drgName || '');
    const tokenSearchTokens = getRuleTokenSearchTokens(item);
    const conditions = Array.isArray(item.conditions) ? item.conditions : [];
    const adrgRuleCodes = getSubgroupAdrgRuleCodes(item);
    const hasAdrgDiagnosisCodes = adrgRuleCodes.diagnosisCodes.length > 0;
    const hasAdrgProcedureCodes = adrgRuleCodes.procedureCodes.length > 0;
    const hasSpecific = hasAdrgDiagnosisCodes
      || hasAdrgProcedureCodes
      || conditions.some((condition) => typeof condition === 'string' && condition.startsWith('SPECIFIC'));
    const procedureCodes = Array.isArray(item.procedureCodes)
      ? item.procedureCodes.map((code) => normalizeText(String(code || ''))).filter(Boolean)
      : [];
    const diagnosisCodes = Array.isArray(item.diagnosisCodes)
      ? item.diagnosisCodes.map((code) => normalizeText(String(code || ''))).filter(Boolean)
      : [];

    const drg = {
      code: drgCode,
      name: drgName,
      weight: mapItem ? mapItem.weight ?? null : null,
      weightTier2: mapItem ? mapItem.weightTier2 ?? null : null,
      rule: item,
      // Keep token-only data separate from the code/name search bundle.
      _search: buildSearchMeta(drgCode, drgName),
      _tokenSearchTokens: tokenSearchTokens,
      _ruleEvalMeta: {
        hasSpecific,
        isAdrgOnly: conditions.includes('ADRG_ONLY') && !hasSpecific,
        hasSpecificProcedure: conditions.includes('SPECIFIC_PROCEDURE') || hasAdrgProcedureCodes,
        hasSpecificProcedurePrefix: conditions.includes('SPECIFIC_PROCEDURE_PREFIX'),
        hasSpecificDiagnosis: conditions.includes('SPECIFIC_DIAGNOSIS') || hasAdrgDiagnosisCodes,
        hasSpecificDiagnosisPrefix: conditions.includes('SPECIFIC_DIAGNOSIS_PREFIX'),
        procedureCodes: [...new Set([...procedureCodes, ...adrgRuleCodes.procedureCodes])],
        procedurePrefixes: Array.isArray(item.procedurePrefixes)
          ? item.procedurePrefixes.map((prefix) => normalizeText(prefix)).filter(Boolean)
          : [],
        diagnosisCodes: [...new Set([...diagnosisCodes, ...adrgRuleCodes.diagnosisCodes])],
        diagnosisPrefixes: Array.isArray(item.diagnosisPrefixes)
          ? item.diagnosisPrefixes.map((prefix) => normalizeText(prefix)).filter(Boolean)
          : [],
      },
    };

    let byAdrg = mapRes.get(adrgCode);
    if (!byAdrg) {
      byAdrg = new Map();
      mapRes.set(adrgCode, byAdrg);
    }
    if (!byAdrg.has(drgCode)) byAdrg.set(drgCode, drg);
  }

  const result = new Map();
  for (const [adrgCode, byAdrg] of mapRes.entries()) {
    result.set(adrgCode, Array.from(byAdrg.values()));
  }
  return result;
}

function buildMdcTreeNodes(mdcRules, adrgNameByCode, drgByAdrg, getADRGsForMDC, commonKey = 'default') {
  commonKey = String(commonKey);
  const cachedCommon = COMMON_MDC_TREE_CACHE.get(commonKey);
  if (cachedCommon) {
    return cachedCommon.map((mdc) => {
      let totalDrg = 0;
      const adrgs = mdc.adrgs.map((adrg) => {
        const drgs = drgByAdrg.get(adrg.code) || EMPTY_LIST;
        totalDrg += drgs.length;
        return { ...adrg, drgs, _totalDrg: drgs.length };
      });
      return { ...mdc, adrgs, _totalDrg: totalDrg };
    });
  }

  const source = Array.isArray(mdcRules) ? mdcRules : [];
  const out = [];

  for (const mdc of source) {
    if (!mdc || mdc.type !== 'MDC' || !mdc.code) continue;

    const mdcCode = String(mdc.code);
    const mdcName = String(mdc.name || '');
    const mdcKey = `mdc:${mdcCode}`;
    const adrgNodes = [];
    const adrgKeys = [];
    let totalDrg = 0;

    for (const a of (getADRGsForMDC(mdcCode) || EMPTY_LIST)) {
      const adrgCode = String(a?.code || '');
      if (!adrgCode) continue;

      const adrgName = String(adrgNameByCode.get(adrgCode) || a.name || '');
      const adrgKey = `${mdcCode}:${adrgCode}`;
      const adrgDrgs = EMPTY_LIST;
      const adrgNode = {
        code: adrgCode,
        name: adrgName,
        rule: a.rule || null,
        content: a.content || null,
        drgs: adrgDrgs,
        _totalDrg: adrgDrgs.length,
        _search: buildSearchMeta(adrgCode, adrgName),
        _tokenSearchTokens: getRuleTokenSearchTokens(a.rule || {}),
        _adrgKey: adrgKey,
      };

      adrgNodes.push(adrgNode);
      adrgKeys.push(adrgKey);
      totalDrg += adrgDrgs.length;
    }

    out.push({
      code: mdcCode,
      name: mdcName,
      adrgs: adrgNodes,
      rule: mdc,
      _search: buildSearchMeta(mdcCode, mdcName),
      _mdcKey: mdcKey,
      _adrgKeys: adrgKeys,
      _adrgKeySet: new Set(adrgKeys),
      _totalAdrg: adrgNodes.length,
      _totalDrg: totalDrg,
    });
  }

  COMMON_MDC_TREE_CACHE.set(commonKey, out);
  return out.map((mdc) => {
    let totalDrg = 0;
    const adrgs = mdc.adrgs.map((adrg) => {
      const drgs = drgByAdrg.get(adrg.code) || EMPTY_LIST;
      totalDrg += drgs.length;
      return { ...adrg, drgs, _totalDrg: drgs.length };
    });
    return { ...mdc, adrgs, _totalDrg: totalDrg };
  });
}

// --- DRG rule evaluation helper
function calcKeepDrgList(matchedEntries, filterFn) {
  const used = new Set();
  const result = [];
  for (const entry of matchedEntries) {
    if (!filterFn(entry)) continue;
    if (used.has(entry.drg.code)) continue;
    used.add(entry.drg.code);
    result.push(entry.drg);
  }
  return result;
}

function evaluateDrgRuleMatch(drgs, qNorm, queryParts, queryIsExactCode, applySubgroupFallback, adrgHit = false) {
  const entries = Array.isArray(drgs) ? drgs : EMPTY_LIST;
  if (entries.length === 0) return EMPTY_LIST;

  const matchedEntries = [];

  for (const drg of entries) {
    const matchEntry = buildDrgMatchEntry(drg, qNorm, queryParts, queryIsExactCode, adrgHit);
    if (matchEntry) matchedEntries.push(matchEntry);
  }

  if (!applySubgroupFallback) {
    return matchedEntries.map((entry) => entry.drg);
  }

  const hasSpecificMatch = matchedEntries.some((entry) => entry.specificMatched);
  if (hasSpecificMatch) {
    let maxSpecificScore = 0;
    for (const entry of matchedEntries) {
      if (!entry.specificMatched) continue;
      maxSpecificScore = Math.max(maxSpecificScore, entry.specificScore || 0);
    }

    return calcKeepDrgList(matchedEntries, (entry) =>
      (entry.specificMatched && (entry.specificScore || 0) === maxSpecificScore) || entry.nameMatch,
    );
  }

  return calcKeepDrgList(matchedEntries, (entry) => entry.isAdrgOnly || entry.nameMatch);
}


// --- Filtering

function filterAdrgNode(adrg, mdcHit, qNorm, queryParts, queryIsExactCode) {
  const tokenSearchTokens = adrg._tokenSearchTokens || EMPTY_LIST;
  const adrgNameMatch = nodeMatchesQuery(adrg, qNorm);
  const adrgRuleCodeMatch = queryIsExactCode
    && tokenSearchTokens.length > 0
    && codeMatchesText(tokenSearchTokens, qNorm, queryParts);
  const adrgHit = adrgRuleCodeMatch || adrgNameMatch;

  const candidateDrgs = queryIsExactCode && !adrgRuleCodeMatch ? EMPTY_LIST : adrg.drgs;
  const matchedDrgs = candidateDrgs.length > 0
    ? evaluateDrgRuleMatch(candidateDrgs, qNorm, queryParts, queryIsExactCode, queryIsExactCode && adrgRuleCodeMatch, adrgHit)
    : EMPTY_LIST;

  const shouldKeepAdrg = adrgHit || matchedDrgs.length > 0 || mdcHit;
  if (!shouldKeepAdrg) return null;

  const keepFullAdrg = matchedDrgs.length === 0 || matchedDrgs.length === adrg.drgs.length;
  if (keepFullAdrg) return adrg;

  return {
    ...adrg,
    drgs: matchedDrgs,
    _totalDrg: adrg._totalDrg,
  };
}

/**
 * Apply full tree search filtering at MDC, ADRG, and DRG levels.
 * - queryIsExactCode enables strict code match mode with rule conditions
 * - otherwise, fallback to plain text search across code/name
 */
function filterMdcTreeWithMeta(mdcNodes, query, queryIsExactCode) {
  const filteredNodes = [];
  let adrgCount = 0;
  let drgCount = 0;
  const allMdcCodes = [];
  const allAdrgKeys = [];

  function pushAndAccumulate(mdcNode) {
    filteredNodes.push(mdcNode);
    allMdcCodes.push(mdcNode.code);
    adrgCount += mdcNode.adrgs.length;

    for (const adrg of mdcNode.adrgs) {
      allAdrgKeys.push(adrg._adrgKey || `${mdcNode.code}:${adrg.code}`);
      drgCount += adrg.drgs.length;
    }
  }

  if (!query) {
    for (const mdc of mdcNodes) pushAndAccumulate(mdc);
  } else {
    const qNorm = normalizeText(query);
    const queryParts = splitQueryParts(qNorm);

    for (const mdc of mdcNodes) {
      const mdcHit = nodeMatchesQuery(mdc, qNorm);
      const matchedAdrgs = [];
      let usesOriginalAdrgRefs = true;

      for (const adrg of mdc.adrgs) {
        const nextAdrg = filterAdrgNode(adrg, mdcHit, qNorm, queryParts, queryIsExactCode);
        if (!nextAdrg) continue;

        if (nextAdrg !== adrg) usesOriginalAdrgRefs = false;
        matchedAdrgs.push(nextAdrg);
      }

      if (mdcHit || matchedAdrgs.length > 0) {
        const nextMdcNode = usesOriginalAdrgRefs && matchedAdrgs.length === mdc.adrgs.length
          ? mdc
          : { ...mdc, adrgs: matchedAdrgs };
        pushAndAccumulate(nextMdcNode);
      }
    }
  }

  return {
    filteredNodes,
    filteredMeta: {
      counts: {
        mdcCount: filteredNodes.length,
        adrgCount,
        drgCount,
      },
      allMdcCodes,
      allAdrgKeys,
    },
  };
}


// --- Detail parsing + rendering
function buildParsedMappedNames(parsedViewerType, parsedViewerResult, ybDiagNames, ybProcNames) {
  if (!parsedViewerResult || parsedViewerResult.error) return [];

  const parsed = parsedViewerResult.parsed;
  const out = [];

  if (parsedViewerType === SELECTION_TYPES.MDC) {
    if (Array.isArray(parsed)) {
      const items = (parsed || []).map((code) => ({ code, name: (ybDiagNames || {})[code] || '' }));
      if (items.length > 0) out.push({ label: 'MDC Diagnosis Codes', items });
    } else if (parsed && typeof parsed === 'object') {
      for (const [cat, codes] of Object.entries(parsed)) {
        const items = (codes || []).map((code) => ({ code, name: (ybDiagNames || {})[code] || '' }));
        if (items.length > 0) out.push({ label: `MDCZ ${cat}`, items });
      }
    }
    return out;
  }

  if (parsedViewerType === SELECTION_TYPES.ADRG) {
    const sections = parsed?.sections;
    if (!sections || typeof sections !== 'object') return out;

    for (const [sectionName, codes] of Object.entries(sections)) {
      const isProc = String(sectionName || '').includes('手术') || String(sectionName || '').includes('操作');
      const items = (codes || []).map((code) => ({
        code,
        name: (isProc ? (ybProcNames || {}) : (ybDiagNames || {}))[code] || '',
      }));
      if (items.length > 0) out.push({ label: sectionName, items });
    }
    return out;
  }

  if (parsedViewerType === SELECTION_TYPES.DRG) {
    const rules = Array.isArray(parsed) ? parsed : [];
    for (const rule of rules) {
      const drgLabel = String(rule?.drgCode || '').trim() || 'DRG';

      const adrgSections = rule?.adrgRule?.sections;
      if (adrgSections && typeof adrgSections === 'object') {
        for (const [sectionName, codes] of Object.entries(adrgSections)) {
          const isProc = String(sectionName || '').includes('手术') || String(sectionName || '').includes('操作');
          const items = (Array.isArray(codes) ? codes : []).map((code) => ({
            code,
            name: (isProc ? (ybProcNames || {}) : (ybDiagNames || {}))[code] || '',
          }));
          if (items.length > 0) out.push({ label: `${drgLabel} ${sectionName}`, items });
        }
      }

      const diagItems = (Array.isArray(rule?.diagnosisCodes) ? rule.diagnosisCodes : []).map((code) => ({
        code,
        name: (ybDiagNames || {})[code] || '',
      }));
      if (diagItems.length > 0) out.push({ label: `${drgLabel} Diagnosis`, items: diagItems });

      const procItems = (Array.isArray(rule?.procedureCodes) ? rule.procedureCodes : []).map((code) => ({
        code,
        name: (ybProcNames || {})[code] || '',
      }));
      if (procItems.length > 0) out.push({ label: `${drgLabel} Procedure`, items: procItems });
    }
    return out;
  }

  return out;
}

function resolveParsedViewerType(rule) {
  if (rule?.__selectionType === SELECTION_TYPES.DRG) return SELECTION_TYPES.DRG;
  if (rule?.__selectionType === SELECTION_TYPES.ADRG) return SELECTION_TYPES.ADRG;
  return SELECTION_TYPES.MDC;
}

function buildParsedViewerResult(parsedViewerType, rule) {
  try {
    if (parsedViewerType === SELECTION_TYPES.MDC) {
      const item = rule?.rule || null;
      const parsed = item && item.code === 'MDCZ'
        ? (item.mdczCategories || {})
        : (item?.identifyingDiagnoses || []);
      return { item, parsed };
    }

    if (parsedViewerType === SELECTION_TYPES.ADRG) {
      const item = rule || null;
      const parsed = item?.rule ? item.rule : (item?.content || null);
      return { item, parsed };
    }

    const entries = rule?.drgRule ? [rule.drgRule] : null;
    return { item: entries, parsed: entries };
  } catch (error) {
    return { error: String(error) };
  }
}

function stringifyParsedValue(parsedViewerResult) {
  if (!parsedViewerResult) return '';

  try {
    return JSON.stringify(parsedViewerResult.parsed, null, 2);
  } catch {
    return String(parsedViewerResult.parsed);
  }
}

function SelectedDetails({ rule, ybDiagNames, ybProcNames, parsedExpanded, setParsedExpanded }) {
  const parsedViewerType = resolveParsedViewerType(rule);
  const parsedViewerResult = buildParsedViewerResult(parsedViewerType, rule);

  const mapped = buildParsedMappedNames(parsedViewerType, parsedViewerResult, ybDiagNames, ybProcNames);
  const parsedStr = stringifyParsedValue(parsedViewerResult);

  return (
    <div className="mt-2 p-3 dark-surface-2 rounded border dark-border">
      {parsedViewerResult?.error ? (
        <div className="text-error font-bold">{parsedViewerResult.error}</div>
      ) : parsedViewerResult ? (
        <>
          {mapped.length > 0 && (
            <div className="mb-3 p-2 rounded border dark-border bg-gray-800/70 text-xs text-gray-200 space-y-2 max-h-56 overflow-auto">
              {mapped.map((group, i) => (
                <div key={`${group.label}-${i}`}>
                  <div className="text-gray-300 font-semibold mb-1">{group.label}</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 2xl:grid-cols-5 gap-1.5">
                    {group.items.map((item, rowIdx) => (
                      <div
                        key={`${group.label}-${item.code}-${rowIdx}`}
                        className="grid grid-cols-[7.5rem_1fr] gap-1.5 min-w-0 py-0.5 border-b border-gray-700/40 last:border-b-0"
                      >
                        <span className="font-mono text-blue-300 truncate" title={item.code}>{item.code}</span>
                        <span className="text-gray-200 break-words leading-tight">{item.name || '-'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-2">
            <button
              type="button"
              onClick={() => setParsedExpanded((v) => !v)}
              className="px-3 py-1 text-sm rounded bg-gray-700 text-gray-200"
            >
              {parsedExpanded ? 'Hide Parsed' : 'Show Parsed'}
            </button>
          </div>

          {parsedExpanded && parsedStr && (
            <pre className="text-xs font-mono text-gray-300 overflow-auto whitespace-pre-wrap break-words max-h-96 mt-2">
              {parsedStr}
            </pre>
          )}
        </>
      ) : (
        <div className="text-gray-400">No parsed data available for this selection.</div>
      )}
    </div>
  );
}

// --- UI components

const DrgRow = memo(function DrgRow({ rowKey, drg, adrg, mdc, selectedNodeKey, onSelectDrg }) {
  const selected = selectedNodeKey === rowKey;
  return (
    <tr
      onClick={() => onSelectDrg(mdc, adrg, drg, rowKey)}
      className={`border-b dark-border last:border-0 cursor-pointer transition ${selected ? 'bg-blue-600/20' : 'hover:bg-info hover:bg-opacity-20'}`}
    >
      <td className="py-2 px-3 font-medium text-cyan-300">{drg.code}</td>
      <td className="py-2 px-3 text-gray-200">{drg.name || '-'}</td>
      <td className="py-2 px-3 text-gray-300">{drg.weight ?? '-'}</td>
      <td className="py-2 px-3 text-gray-300">{drg.weightTier2 ?? '-'}</td>
    </tr>
  );
}, (prev, next) => {
  const prevSelected = prev.selectedNodeKey === prev.rowKey;
  const nextSelected = next.selectedNodeKey === next.rowKey;
  if (prevSelected !== nextSelected) return false;

  const prevDrg = prev.drg || {};
  const nextDrg = next.drg || {};
  if (prevDrg.code !== nextDrg.code) return false;
  if (prevDrg.name !== nextDrg.name) return false;
  if ((prevDrg.weight ?? null) !== (nextDrg.weight ?? null)) return false;
  if ((prevDrg.weightTier2 ?? null) !== (nextDrg.weightTier2 ?? null)) return false;

  return true;
});

const AdrgNode = memo(function AdrgNode({
  mdc,
  adrg,
  adrgKey,
  adrgOpen,
  toggleAdrg,
  selectedNodeKey,
  selectedRule,
  detailProps,
  onSelectAdrg,
  onSelectDrg,
}) {
  const adrgSelected = selectedNodeKey === adrgKey;

  return (
    <div className="border dark-border rounded overflow-hidden ml-6">
      <button
        type="button"
        className={`w-full text-left px-4 py-2 dark-surface-2 ${adrgSelected ? 'bg-blue-600/20' : 'hover:bg-info hover:bg-opacity-20'} flex items-center justify-between`}
        onClick={() => {
          toggleAdrg(adrgKey);
          onSelectAdrg(mdc, adrg);
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-300">{adrgOpen ? '▾' : '▸'}</span>
          <span className="font-medium text-emerald-300">{adrg.code}</span>
          <span className="text-gray-200">{adrg.name}</span>
        </div>
        <span className="text-xs text-gray-400">
          DRG: {adrg.drgs.length}/{adrg._totalDrg ?? adrg.drgs.length}
        </span>
      </button>

      {adrgSelected && (
        <div className="px-4 pb-2">
          <SelectedDetails rule={selectedRule} {...detailProps} />
        </div>
      )}

      {adrgOpen && (
        <div className="p-2">
          {adrg.drgs.length === 0 ? (
            <div className="text-sm text-gray-400 px-3 py-1 ml-6">No DRG subgroup entries for this ADRG.</div>
          ) : null}
          <table className="w-full text-sm border-collapse">
            <thead className="border-b dark-border text-gray-400">
              <tr>
                <th className="text-left py-2 px-3">DRG</th>
                <th className="text-left py-2 px-3">Description</th>
                <th className="text-left py-2 px-3">Weight</th>
                <th className="text-left py-2 px-3">Weight Tier2</th>
              </tr>
            </thead>
            <tbody>
              {adrg.drgs.map((drg) => {
                const rowKey = `${adrgKey}:${drg.code}`;
                return (
                  <Fragment key={rowKey}>
                    <DrgRow
                      rowKey={rowKey}
                      drg={drg}
                      adrg={adrg}
                      mdc={mdc}
                      selectedNodeKey={selectedNodeKey}
                      onSelectDrg={onSelectDrg}
                    />
                    {selectedNodeKey === rowKey && (
                      <tr>
                        <td colSpan={4}>
                          <SelectedDetails rule={buildDrgSelectionRule(mdc, adrg, drg)} {...detailProps} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  if ((prev.adrg?.code || '') !== (next.adrg?.code || '')) return false;
  if ((prev.adrg?.name || '') !== (next.adrg?.name || '')) return false;
  if ((prev.adrg?.drgs?.length || 0) !== (next.adrg?.drgs?.length || 0)) return false;
  if (prev.adrgOpen !== next.adrgOpen) return false;

  const prevSel = String(prev.selectedNodeKey || '');
  const nextSel = String(next.selectedNodeKey || '');

  const prevAdrgKey = prev.mdc?.code && prev.adrg?.code ? `${prev.mdc.code}:${prev.adrg.code}` : '';
  const nextAdrgKey = next.mdc?.code && next.adrg?.code ? `${next.mdc.code}:${next.adrg.code}` : '';
  const prevAffects = !!prevAdrgKey && (prevSel === prevAdrgKey || prevSel.startsWith(`${prevAdrgKey}:`));
  const nextAffects = !!nextAdrgKey && (nextSel === nextAdrgKey || nextSel.startsWith(`${nextAdrgKey}:`));

  if (selectionScopeChanged(prev, next, prevAffects, nextAffects)) return false;

  return true;
});

const MdcNode = memo(function MdcNode({
  mdc,
  mdcOpen,
  mdcKey,
  selectedNodeKey,
  selectedRule,
  detailProps,
  toggleMdc,
  toggleAdrg,
  expandedAdrg,
  onSelectMdc,
  onSelectAdrg,
  onSelectDrg,
}) {
  const mdcSelected = selectedNodeKey === mdcKey;

  return (
    <div className="border dark-border rounded-lg mb-3 overflow-hidden">
      <button
        type="button"
        className={`w-full text-left px-4 py-3 dark-surface-2 ${mdcSelected ? 'bg-blue-600/20' : 'hover:bg-info hover:bg-opacity-20'} flex items-center justify-between`}
        onClick={() => {
          toggleMdc(mdc.code);
          onSelectMdc(mdc);
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-300">{mdcOpen ? '▾' : '▸'}</span>
          <span className="font-semibold text-blue-300">{mdc.code}</span>
          <span className="text-gray-200">{mdc.name}</span>
        </div>
        <span className="text-xs text-gray-400">
          ADRG: {mdc.adrgs.length}/{mdc._totalAdrg ?? mdc.adrgs.length}
        </span>
      </button>

      {mdcSelected && (
        <div className="p-3 border-t border-gray-700/30">
          <SelectedDetails rule={selectedRule} {...detailProps} />
        </div>
      )}

      {mdcOpen && (
        <div className="p-3 space-y-2">
          {mdc.adrgs.length === 0 ? (
            <div className="text-sm text-gray-400 px-2 py-1">No ADRG mapped to this MDC.</div>
          ) : (
            mdc.adrgs.map((adrg) => {
              const adrgKey = adrg._adrgKey || `${mdc.code}:${adrg.code}`;
              return (
                <AdrgNode
                  key={adrgKey}
                  mdc={mdc}
                  adrg={adrg}
                  adrgKey={adrgKey}
                  adrgOpen={expandedAdrg.has(adrgKey)}
                  toggleAdrg={toggleAdrg}
                  selectedNodeKey={selectedNodeKey}
                  selectedRule={selectedRule}
                  detailProps={detailProps}
                  onSelectAdrg={onSelectAdrg}
                  onSelectDrg={onSelectDrg}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  if ((prev.mdc?.code || '') !== (next.mdc?.code || '')) return false;
  if ((prev.mdc?.name || '') !== (next.mdc?.name || '')) return false;
  if ((prev.mdc?.adrgs?.length || 0) !== (next.mdc?.adrgs?.length || 0)) return false;
  if (prev.mdcOpen !== next.mdcOpen) return false;

  if (prev.expandedAdrg !== next.expandedAdrg) {
    const changedKey = next.lastChangedAdrgKey || ALL_ADRG_CHANGED;
    if (changedKey === ALL_ADRG_CHANGED) return false;
    const adrgKeySet = prev.mdc?._adrgKeySet;
    if (!adrgKeySet || adrgKeySet.has(changedKey)) return false;
  }

  const prevSel = String(prev.selectedNodeKey || '');
  const nextSel = String(next.selectedNodeKey || '');

  const prevMdcCode = prev.mdc?.code || '';
  const nextMdcCode = next.mdc?.code || '';
  const prevAffects = !!prevMdcCode && (prevSel === `mdc:${prevMdcCode}` || prevSel.startsWith(`${prevMdcCode}:`));
  const nextAffects = !!nextMdcCode && (nextSel === `mdc:${nextMdcCode}` || nextSel.startsWith(`${nextMdcCode}:`));

  if (selectionScopeChanged(prev, next, prevAffects, nextAffects)) return false;

  return true;
});

// --- Main tab component
export default function MdcTreeTab({ version }) {
  const [queryInput, setQueryInput] = useState('');
  const [expandedMdc, setExpandedMdc] = useState(() => new Set());
  const [expandedAdrg, setExpandedAdrg] = useState(() => new Set());
  const [lastChangedAdrgKey, setLastChangedAdrgKey] = useState('');
  const [selectedRule, setSelectedRule] = useState(null);
  const [selectedNodeKey, setSelectedNodeKey] = useState(null);
  const [parsedExpanded, setParsedExpanded] = useState(false);

  const [ruleSet, setRuleSet] = useState(null);
  const [loadedVersion, setLoadedVersion] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let active = true;
    loadRuleSetAsync(version).then((nextRuleSet) => {
      if (active) {
        setRuleSet(nextRuleSet);
        setLoadedVersion(version);
      }
    }).catch((error) => {
      if (active) setLoadError(error);
    });
    return () => { active = false; };
  }, [version]);

  const mdcRules = useMemo(() => ruleSet?.loadMDCRules() || [], [ruleSet]);
  const adrgRules = useMemo(() => ruleSet?.loadADRGRules() || [], [ruleSet]);
  const drgRules = useMemo(() => ruleSet?.loadDRGSubgroupRules() || [], [ruleSet]);
  const drgMap = useMemo(() => ruleSet?.loadDRGMap() || {}, [ruleSet]);
  const ybDiagNames = useMemo(() => ruleSet?.loadYBDiagNames() || {}, [ruleSet]);
  const ybProcNames = useMemo(() => ruleSet?.loadYBProcNames() || {}, [ruleSet]);

  const adrgNameByCode = useMemo(() => buildAdrgNameByCodeMap(adrgRules), [adrgRules]);
  const drgByAdrg = useMemo(() => buildDrgByAdrgMap(drgRules, drgMap), [drgRules, drgMap]);
  const mdcNodes = useMemo(() => {
    if (!ruleSet) return EMPTY_LIST;
    const cached = MDC_TREE_CACHE.get(version);
    if (cached) return cached;
    const commonVersion = getVersionDefinition(version).packages?.drgCommon || version;
    const nodes = buildMdcTreeNodes(mdcRules, adrgNameByCode, drgByAdrg, ruleSet.getADRGsForMDC, commonVersion);
    MDC_TREE_CACHE.set(version, nodes);
    return nodes;
  }, [mdcRules, adrgNameByCode, drgByAdrg, ruleSet, version]);

  const totals = useMemo(() => {
    let adrgCount = 0;
    let drgCount = 0;

    for (const mdc of mdcNodes) {
      const adrgs = Array.isArray(mdc.adrgs) ? mdc.adrgs : EMPTY_LIST;
      adrgCount += adrgs.length;
      for (const adrg of adrgs) {
        drgCount += Array.isArray(adrg.drgs) ? adrg.drgs.length : 0;
      }
    }

    return {
      mdcCount: mdcNodes.length,
      adrgCount,
      drgCount,
    };
  }, [mdcNodes]);

  const debouncedQuery = useDebouncedValue(queryInput, 200);

  const query = normalizeText(debouncedQuery);
  const queryIsExactCode = useMemo(() => {
    const normalized = String(query || '').trim();
    if (!normalized) return false;

    // Composite code queries can include + and wildcard * tokens (e.g., A01.002+G01*)
    // Allow a trailing dot as valid prefix syntax (k80. -> k80.101).
    const tokens = splitQueryParts(normalized);
    return tokens.every((token) => CODE_QUERY_TOKEN_RE.test(token));
  }, [query]);

  const filteredResult = useMemo(
    () => filterMdcTreeWithMeta(mdcNodes, query, queryIsExactCode),
    [mdcNodes, query, queryIsExactCode],
  );
  const filtered = filteredResult.filteredNodes;
  const filteredMeta = filteredResult.filteredMeta;
  const filteredCounts = filteredMeta.counts;
  const allFilteredMdcCodes = filteredMeta.allMdcCodes;
  const allFilteredAdrgKeys = filteredMeta.allAdrgKeys;
  const detailProps = useMemo(() => ({
    ybDiagNames,
    ybProcNames,
    parsedExpanded,
    setParsedExpanded,
  }), [ybDiagNames, ybProcNames, parsedExpanded, setParsedExpanded]);

  const toggleMdc = useCallback((mdcCode) => {
    setExpandedMdc((prev) => {
      const next = new Set(prev);
      if (next.has(mdcCode)) next.delete(mdcCode);
      else next.add(mdcCode);
      return next;
    });
  }, []);

  const toggleAdrg = useCallback((key) => {
    setLastChangedAdrgKey(key);
    setExpandedAdrg((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSelectMdc = useCallback((mdc) => {
    setSelectedRule({
      __selectionType: SELECTION_TYPES.MDC,
      code: mdc.code,
      name: mdc.name,
      rule: mdc.rule || mdc,
    });
    setSelectedNodeKey(mdc._mdcKey || `mdc:${mdc.code}`);
  }, []);

  const handleSelectAdrg = useCallback((mdc, adrg) => {
    setSelectedRule({
      __selectionType: SELECTION_TYPES.ADRG,
      code: adrg.code,
      name: adrg.name,
      rule: adrg.rule || null,
      content: adrg.content || null,
    });
    setSelectedNodeKey(adrg._adrgKey || `${mdc.code}:${adrg.code}`);
  }, []);

  const handleSelectDrg = useCallback((mdc, adrg, drg, rowKey) => {
    setSelectedRule(buildDrgSelectionRule(mdc, adrg, drg));
    setSelectedNodeKey(rowKey);
  }, []);

  const expandAll = useCallback(() => {
    setLastChangedAdrgKey(ALL_ADRG_CHANGED);
    setExpandedMdc(new Set(allFilteredMdcCodes));
    setExpandedAdrg(new Set(allFilteredAdrgKeys));
  }, [allFilteredMdcCodes, allFilteredAdrgKeys]);

  const collapseAll = useCallback(() => {
    setLastChangedAdrgKey(ALL_ADRG_CHANGED);
    setExpandedMdc(new Set());
    setExpandedAdrg(new Set());
  }, []);

  if (loadError) {
    return <div className="dark-surface p-6 rounded-lg border dark-border text-red-300">Failed to load DRG rule version {version}: {loadError.message}</div>;
  }
  if (!ruleSet || loadedVersion !== version) {
    return <div className="dark-surface p-6 rounded-lg border dark-border text-gray-300">Loading DRG rule version {version}…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="dark-surface p-6 rounded-lg border dark-border shadow-sm">
        <h2 className="text-xl font-bold mb-2 text-gray-100">MDC-ADRG-DRG Tree Viewer</h2>
        <p className="text-sm text-gray-400 mb-4">
          Explore grouping hierarchy from MDC to ADRG and DRG, with quick filtering by code or name.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto] gap-3 items-end">
          <div>
            <label className="block text-sm font-medium mb-2 text-gray-300">Filter</label>
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search MDC / ADRG / DRG code or name"
              className="w-full p-3 border dark-border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            />
          </div>
          <button
            type="button"
            onClick={expandAll}
            className="px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Expand All
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="px-4 py-3 bg-gray-700 text-gray-100 rounded-lg border border-gray-600 hover:bg-gray-600"
          >
            Collapse All
          </button>
        </div>

        <div className="flex flex-wrap gap-4 mt-4 text-sm text-gray-300">
          <span>MDC: <strong>{filteredCounts.mdcCount}/{totals.mdcCount}</strong></span>
          <span>ADRG: <strong>{filteredCounts.adrgCount}/{totals.adrgCount}</strong></span>
          <span>DRG: <strong>{filteredCounts.drgCount}/{totals.drgCount}</strong></span>
        </div>
      </div>

      <div className="dark-surface p-4 rounded-lg border dark-border shadow-sm overflow-x-auto">
        {filtered.length === 0 ? (
          <div className="text-center text-gray-400 py-10">No hierarchy nodes matched your filter.</div>
        ) : (
          <div className="min-w-[740px]">
            {filtered.map((mdc) => {
              const mdcKey = mdc._mdcKey || `mdc:${mdc.code}`;
              return (
                <MdcNode
                  key={mdc.code}
                  mdc={mdc}
                  mdcOpen={expandedMdc.has(mdc.code)}
                  mdcKey={mdcKey}
                  lastChangedAdrgKey={lastChangedAdrgKey}
                  selectedNodeKey={selectedNodeKey}
                  selectedRule={selectedRule}
                  detailProps={detailProps}
                  toggleMdc={toggleMdc}
                  toggleAdrg={toggleAdrg}
                  expandedAdrg={expandedAdrg}
                  onSelectMdc={handleSelectMdc}
                  onSelectAdrg={handleSelectAdrg}
                  onSelectDrg={handleSelectDrg}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
