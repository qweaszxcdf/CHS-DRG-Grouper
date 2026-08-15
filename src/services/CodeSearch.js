import { DEFAULT_RULE_VERSION, getVersionDefinition } from './generated/versionRegistry.ts';
import { loadRuleSet } from './ruleSetLoader.ts';
import { getGLData, preloadGLData } from './glDataLoader.js';

// DRG-common and ICD dictionaries are package-specific. Final DRG maps remain
// version-specific because versions sharing one common package can still have
// different subgroup maps.
const drgCommonIndexStates = new Map();
const drgMapIndexStates = new Map();
const icdIndexStates = new Map();
const verboseSearchLogs = !!(import.meta.env && import.meta.env.DEV);

function getDrgCommonIndexState(version) {
    const { drgCommon } = getVersionDefinition(version);
    if (!drgCommonIndexStates.has(drgCommon)) {
        drgCommonIndexStates.set(drgCommon, { codeIndex: [], buckets: {}, isBuilt: false });
    }
    return drgCommonIndexStates.get(drgCommon);
}

function getDrgMapIndexState(version) {
    if (!drgMapIndexStates.has(version)) {
        drgMapIndexStates.set(version, { codeIndex: [], buckets: {}, isBuilt: false });
    }
    return drgMapIndexStates.get(version);
}

function getIcdIndexState(version) {
    const { insuranceIcd, clinicalIcd } = getVersionDefinition(version).packages;
    const packageKey = `${insuranceIcd}::${clinicalIcd}`;
    if (!icdIndexStates.has(packageKey)) {
        icdIndexStates.set(packageKey, { codeIndex: [], buckets: {}, isBuilt: false, glBuilt: false });
    }
    return icdIndexStates.get(packageKey);
}

/**
 * Builds the DRG-common search index for one rule version.
 */
export function buildDrgCommonIndex(version = DEFAULT_RULE_VERSION) {
    const state = getDrgCommonIndexState(version);
    if (state.isBuilt) return state.codeIndex;
    const { loadADRGRules } = loadRuleSet(version);
    const tempMap = new Map();
    for (const entry of loadADRGRules()) {
        if (!entry || entry.type !== 'ADRG' || !entry.code) continue;
        tempMap.set(`${entry.code}::ADRG`, {
            code: entry.code,
            name: entry.name || entry.description || '',
            type: 'ADRG',
        });
    }
    state.codeIndex = Array.from(tempMap.values());
    state.buckets = { 'ADRG:ADRG': state.codeIndex };
    state.isBuilt = true;
    if (verboseSearchLogs) console.log(`DRG-common index for ${version} built with ${state.codeIndex.length} entries.`);
    return state.codeIndex;
}

/** Builds the final DRG-map search index for one rule version. */
export function buildDrgMapIndex(version = DEFAULT_RULE_VERSION) {
    const state = getDrgMapIndexState(version);
    if (state.isBuilt) return state.codeIndex;
    const { loadDRGMap } = loadRuleSet(version);
    const drgMap = loadDRGMap();
    const tempMap = new Map();
    Object.entries(drgMap).forEach(([code, entry]) => {
        const name = (typeof entry === 'object' && entry !== null) ? entry.description : entry;
        tempMap.set(`${code}::DRG`, { code, name, type: 'DRG' });
    });
    state.codeIndex = Array.from(tempMap.values());
    state.buckets = { 'DRG:DRG': state.codeIndex };
    state.isBuilt = true;
    if (verboseSearchLogs) console.log(`DRG-map index for ${version} built with ${state.codeIndex.length} entries.`);
    return state.codeIndex;
}

/**
 * Builds the ICD search index for one rule version.
 */
export function buildIcdIndex(version = DEFAULT_RULE_VERSION) {
    const state = getIcdIndexState(version);
    if (state.isBuilt) return state.codeIndex;
    const {
        loadYBDiagNames,
        loadYBProcNames,
        loadYBInitialsDiag,
        loadYBInitialsProc,
    } = loadRuleSet(version);
    const ybDiagNames = loadYBDiagNames();
    const ybProcNames = loadYBProcNames();
    const ybInitialsDiag = loadYBInitialsDiag();
    const ybInitialsProc = loadYBInitialsProc();
    const tempMap = new Map();

    Object.entries(ybDiagNames).forEach(([code, name]) => {
        tempMap.set(`${code}::YB`, { code, name, type: 'Diagnosis', source: 'YB', initials: ybInitialsDiag[code] || '' });
    });

    // Procedure names
    Object.entries(ybProcNames).forEach(([code, name]) => {
        tempMap.set(`${code}::YB`, { code, name, type: 'Procedure', source: 'YB', initials: ybInitialsProc[code] || '' });
    });

    state.codeIndex = Array.from(tempMap.values());
    for (const item of state.codeIndex) {
        const key = `${item.type}:${item.source || item.type}`;
        (state.buckets[key] ??= []).push(item);
    }
    state.isBuilt = true;
    if (verboseSearchLogs) console.log(`ICD index for ${version} built with ${state.codeIndex.length} entries.`);
    return state.codeIndex;
}

/** Builds both index families for callers that need the complete code index. */
export function buildCodeIndex(version = DEFAULT_RULE_VERSION) {
    return buildDrgMapIndex(version).concat(buildDrgCommonIndex(version), buildIcdIndex(version));
}

export function buildGLCodeIndex(version = DEFAULT_RULE_VERSION) {
    const state = getIcdIndexState(version);
    if (state.glBuilt) return state.codeIndex;
    if (!state.isBuilt) buildIcdIndex(version);
    const data = getGLData(version);
    if (!data) return;
    const { _initials: glDiagInitials = {}, ...glDiagNames } = data.glDiagNames || {};
    const { _initials: glProcInitials = {}, ...glProcNames } = data.glProcNames || {};
    const diagnosisItems = Object.entries(glDiagNames).map(([code, name]) => ({ code, name, type: 'Diagnosis', source: 'GL', initials: glDiagInitials[code] || '' }));
    const procedureItems = Object.entries(glProcNames).map(([code, name]) => ({ code, name, type: 'Procedure', source: 'GL', initials: glProcInitials[code] || '' }));
    state.buckets['Diagnosis:GL'] = diagnosisItems;
    state.buckets['Procedure:GL'] = procedureItems;
    state.codeIndex.push(...diagnosisItems, ...procedureItems);
    state.glBuilt = true;
    return state.codeIndex;
}

export async function preloadGLCodeIndex(version = DEFAULT_RULE_VERSION) {
    await preloadGLData(version);
    buildIcdIndex(version);
    buildGLCodeIndex(version);
}

/**
 * Searches for codes matching the query.
 * @param {string} query 
 * @param {string} type - Optional filter for code type ('Diagnosis', 'Procedure', 'ADRG', 'DRG', etc.)
 * @returns {Array} List of matching objects {code, name, type}
 */
export function searchCodes(query, type, source = 'YB', version = DEFAULT_RULE_VERSION) {
    if (!query) return [];
    try {
        if (type === 'DRG') {
            buildDrgMapIndex(version);
        }
        else if (type === 'ADRG') {
            buildDrgCommonIndex(version);
        }
        else if (!type || type === 'All') buildCodeIndex(version);
        else buildIcdIndex(version);
    } catch {
        // Non-default versions are loaded asynchronously. Callers will retry
        // when the app's search-index revision changes after preload.
        return [];
    }
    const drgCommonBuckets = getDrgCommonIndexState(version).buckets;
    const drgMapBuckets = getDrgMapIndexState(version).buckets;
    const icdBuckets = getIcdIndexState(version).buckets;

    // Treat space as wildcard, but escape regex metacharacters so user input is literal.
    // For DRG searches we match the `code` portion case-sensitively (letters must match case);
    // names remain case-insensitive. For other search types we preserve existing
    // case-insensitive behavior by lowercasing both query and target strings.
    const src = (source || 'YB').toUpperCase();

    /** Resolve candidates from the separate DRG-common and ICD indexes. */
    function getCandidates(t, s) {
        if (!t || t === 'All') {
            const drgs = (drgMapBuckets['DRG:DRG'] || []).concat(drgCommonBuckets['ADRG:ADRG'] || []);
            if (s === 'ALL') {
                return drgs.concat(
                    icdBuckets['Diagnosis:GL'] || [],
                    icdBuckets['Diagnosis:YB'] || [],
                    icdBuckets['Procedure:GL'] || [],
                    icdBuckets['Procedure:YB'] || [],
                );
            }
            return drgs.concat(
                icdBuckets[`Diagnosis:${s}`] || [],
                icdBuckets[`Procedure:${s}`] || [],
            );
        }
        if (t === 'DRG') return drgMapBuckets['DRG:DRG'] || [];
        if (t === 'ADRG') return drgCommonBuckets['ADRG:ADRG'] || [];
        if (s === 'ALL') {
            return (icdBuckets[`${t}:GL`] || []).concat(icdBuckets[`${t}:YB`] || []);
        }
        return icdBuckets[`${t}:${s}`] || [];
    }

    /** Collect up to `limit` matches with early exit. */
    function collect(candidates, limit, predicate) {
        const out = [];
        for (let i = 0; i < candidates.length; i++) {
            if (predicate(candidates[i])) {
                out.push(candidates[i]);
                if (out.length === limit) break;
            }
        }
        return out;
    }

    if (type === 'DRG' || type === 'ADRG') {
        const raw = query.trim();
        // Build a CASE-SENSITIVE pattern for DRG `code` where the alphabetic character
        // immediately following an underscore (`_`) is matched case-sensitively, while
        // other alphabetic characters are matched case-insensitively.
        let pattern = '';
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (/\s/.test(ch)) {
                pattern += '.*';
                continue;
            }
            if (/[A-Za-z]/.test(ch)) {
                const prev = raw[i - 1];
                if (prev === '_') {
                    pattern += ch.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
                } else {
                    const lower = ch.toLowerCase();
                    const upper = ch.toUpperCase();
                    if (lower === upper) pattern += ch.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
                    else pattern += `[${lower}${upper}]`;
                }
                continue;
            }
            pattern += ch.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
        }
        const codeRegex = new RegExp(pattern);
        const nameRegex = new RegExp(pattern, 'i');
        const candidates = getCandidates(type, src);
        return collect(candidates, 100, item =>
            codeRegex.test(item.code || '') || nameRegex.test(item.name || ''));
    }

    // Default (non-DRG): case-insensitive search on code / name / pinyin initials
    const lowerQuery = query.toLowerCase().trim();
    const escaped = lowerQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped.replace(/\s+/g, '.*'));
    const candidates = getCandidates(type, src);
    return collect(candidates, 100, item => {
        const code = (item.code || '').toString().toLowerCase();
        const name = (item.name || '').toString().toLowerCase();
        return regex.test(code) || regex.test(name) || regex.test(item.initials || '');
    });
}

// Expose codeIndex for debugging/inspection
export function getCodeIndex(version = DEFAULT_RULE_VERSION) {
    try {
        buildCodeIndex(version);
    } catch {
        return [];
    }
    return getDrgMapIndexState(version).codeIndex.concat(
        getDrgCommonIndexState(version).codeIndex,
        getIcdIndexState(version).codeIndex,
    );
}

// Batch name normalization only needs diagnosis/procedure dictionaries.
export function getIcdIndex(version = DEFAULT_RULE_VERSION) {
    try {
        return buildIcdIndex(version);
    } catch {
        return [];
    }
}

/**
 * Exact name match search. Returns entries whose name equals the query (case-insensitive).
 * Useful when the user input is an exact clinical phrase and we want only exact matches.
 */
/* exactSearch removed; use getCodeIndex() from the app to inspect exact-name entries when needed */
