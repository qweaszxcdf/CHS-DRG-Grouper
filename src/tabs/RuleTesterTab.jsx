import { useMemo, useState } from 'react';
import { parseRule } from '../lib/ruleParserCore.js';
import { matchesRule } from '../services/GrouperEngine';
import { loadRuleSet } from '../services/ruleSetLoader.js';
const {
  getADRGByCode,
  loadADRGRules,
  loadDRGMap,
  loadDRGSubgroupRules,
  loadMDCRules,
  loadYBDiagNames,
  loadYBProcNames,
} = loadRuleSet();

const mdcRules = loadMDCRules();
const ybDiagNames = loadYBDiagNames();
const ybProcNames = loadYBProcNames();

const DRG_MATCH_RANK = { exact: 0, prefix: 1, general: 2 };

function unescapeStrings(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  if (Array.isArray(value)) return value.map(unescapeStrings);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = unescapeStrings(value[k]);
    return out;
  }
  return value;
}

function isProcedureSection(sectionName) {
  const s = String(sectionName || '');
  return s.includes('手术') || s.includes('操作');
}

function codeFromValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.code === 'string') return value.code;
  return '';
}

function normalizeCode(value) {
  if (!value) return '';
  return String(value).trim();
}

function mapCodesToItems(codes, isProcedure) {
  if (!Array.isArray(codes) || codes.length === 0) return [];
  const map = isProcedure ? ybProcNames : ybDiagNames;
  const result = [];

  for (const c of codes) {
    const code = codeFromValue(c);
    if (!code) continue;
    result.push({ code, name: map[code] || '' });
  }

  return result;
}

function buildParsedMappedNames(parsedViewerType, parsedViewerResult) {
  if (!parsedViewerResult || parsedViewerResult.error) return [];

  const parsed = parsedViewerResult.parsed;
  const out = [];

  if (parsedViewerType === 'MDC') {
    if (Array.isArray(parsed)) {
      const items = mapCodesToItems(parsed, false);
      if (items.length > 0) out.push({ label: 'MDC Diagnosis Codes', items });
    } else if (parsed && typeof parsed === 'object') {
      for (const [cat, codes] of Object.entries(parsed)) {
        const items = mapCodesToItems(codes, false);
        if (items.length > 0) out.push({ label: `MDCZ ${cat}`, items });
      }
    }
    return out;
  }

  if (parsedViewerType === 'ADRG') {
    const sections = parsed?.sections;
    if (!sections || typeof sections !== 'object') return out;

    for (const [sectionName, codes] of Object.entries(sections)) {
      const isProc = isProcedureSection(sectionName);
      const items = mapCodesToItems(codes, isProc);
      if (items.length > 0) out.push({ label: sectionName, items });
    }
    return out;
  }

  if (parsedViewerType === 'DRG') {
    const rules = Array.isArray(parsed) ? parsed : [];

    for (const rule of rules) {
      const drgLabel = String(rule?.drgCode || '').trim() || 'DRG';

      const adrgSections = rule?.adrgRule?.sections;
      if (adrgSections && typeof adrgSections === 'object') {
        for (const [sectionName, codes] of Object.entries(adrgSections)) {
          const items = mapCodesToItems(codes, isProcedureSection(sectionName));
          if (items.length > 0) out.push({ label: `${drgLabel} ${sectionName}`, items });
        }
      }

      const diagItems = mapCodesToItems(Array.isArray(rule?.diagnosisCodes) ? rule.diagnosisCodes : [], false);
      if (diagItems.length > 0) out.push({ label: `${drgLabel} Diagnosis`, items: diagItems });

      const procItems = mapCodesToItems(Array.isArray(rule?.procedureCodes) ? rule.procedureCodes : [], true);
      if (procItems.length > 0) out.push({ label: `${drgLabel} Procedure`, items: procItems });
    }
    return out;
  }

  return out;
}

function codeMatchesRuleCode(inputCode, ruleCode) {
  const input = normalizeCode(inputCode);
  const candidate = normalizeCode(typeof ruleCode === 'string' ? ruleCode : ruleCode?.code);
  if (!input || !candidate) return false;

  if (candidate.endsWith('*')) {
    const pref = candidate.slice(0, -1);
    return !!pref && input.startsWith(pref);
  }

  return input === candidate;
}

function matchesPrefixList(inputCode, prefixes) {
  const input = normalizeCode(inputCode);
  if (!input || !Array.isArray(prefixes)) return false;
  return prefixes.some((p) => input.startsWith(normalizeCode(p)));
}

function adrgProcedureMatchReason(adrg, procedureCode, adrgByCode) {
  const rule = adrg?.rule;
  if (!rule || !procedureCode) return null;

  if (rule.anyProcedureRequired) {
    return 'ADRG requires any procedure';
  }

  if (Array.isArray(rule.requiredProcedureGroups) && rule.requiredProcedureGroups.length > 0) {
    for (const group of rule.requiredProcedureGroups) {
      if (Array.isArray(group) && group.some((c) => codeMatchesRuleCode(procedureCode, c))) {
        return 'Procedure appears in ADRG required-procedure groups';
      }
    }
  }

  if (rule.sections && typeof rule.sections === 'object') {
    for (const [sectionName, codes] of Object.entries(rule.sections)) {
      if (!isProcedureSection(sectionName) || !Array.isArray(codes) || codes.length === 0) continue;
      if (codes.some((c) => codeMatchesRuleCode(procedureCode, c))) {
        return `Procedure matched ADRG rule section: ${sectionName}`;
      }
    }
  }

  if (Array.isArray(rule.referencedADRGs) && rule.referencedADRGs.length > 0) {
    for (const refCode of rule.referencedADRGs) {
      const ref = adrgByCode.get(String(refCode || '').toUpperCase());
      const refSections = ref?.rule?.sections;
      if (!refSections) continue;

      for (const [sectionName, codes] of Object.entries(refSections)) {
        if (!isProcedureSection(sectionName) || !Array.isArray(codes) || codes.length === 0) continue;
        if (codes.some((c) => codeMatchesRuleCode(procedureCode, c))) {
          return `Procedure matched referenced ADRG ${String(refCode).toUpperCase()}`;
        }
      }
    }
  }

  return null;
}

function classifySubgroupProcedureMatch(rule, procedureCode) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const hasSpecific = conditions.includes('SPECIFIC_PROCEDURE');
  const hasPrefix = conditions.includes('SPECIFIC_PROCEDURE_PREFIX');
  const adrgProcedureCodes = [];
  const adrgSections = rule?.adrgRule?.sections;
  if (adrgSections && typeof adrgSections === 'object') {
    for (const [sectionName, codes] of Object.entries(adrgSections)) {
      if (!isProcedureSection(sectionName) || String(sectionName).includes('其他') || !Array.isArray(codes)) continue;
      adrgProcedureCodes.push(...codes);
    }
  }

  if (adrgProcedureCodes.length > 0) {
    const exactMatched = adrgProcedureCodes.some((c) => codeMatchesRuleCode(procedureCode, c));
    const prefixMatched = !hasPrefix || matchesPrefixList(procedureCode, rule?.procedurePrefixes);
    const matched = exactMatched && prefixMatched;
    return {
      include: matched,
      type: matched ? 'exact' : null,
      reason: matched ? 'DRG adrgRule requires this primary procedure' : null,
    };
  }

  if (hasSpecific) {
    const matched = Array.isArray(rule?.procedureCodes) && rule.procedureCodes.some((c) => codeMatchesRuleCode(procedureCode, c));
    return {
      include: matched,
      type: matched ? 'exact' : null,
      reason: matched ? 'DRG requires this exact primary procedure' : null,
    };
  }

  if (hasPrefix) {
    const matched = matchesPrefixList(procedureCode, rule?.procedurePrefixes);
    return {
      include: matched,
      type: matched ? 'prefix' : null,
      reason: matched ? 'DRG matches primary procedure prefix condition' : null,
    };
  }

  if (Array.isArray(rule?.conditions) && rule.conditions.includes('ADRG_ONLY')) {
    return {
      include: true,
      type: 'general',
      reason: 'ADRG-only fallback rule (no specific procedure condition)',
    };
  }

  return {
    include: true,
    type: 'general',
    reason: 'DRG has no explicit primary-procedure condition',
  };
}

function ProcedureDrgExplorer({
  procedureInput,
  setProcedureInput,
  inputProcedureName,
  canonicalProcedure,
  stats,
  rows,
}) {
  return (
    <div className="dark-surface p-6 rounded-lg border dark-border shadow-sm mt-8">
      <h2 className="text-xl font-bold mb-2 text-gray-100">Procedure DRG Explorer</h2>
      <p className="text-sm text-gray-400 mb-4">
        Enter one procedure code to list ADRG/DRG candidates that can match this primary procedure.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end mb-6">
        <div>
          <label className="block text-sm font-medium mb-2 text-gray-300">Procedure Code</label>
          <div className="relative">
            <input
              type="text"
              className="w-full p-3 pr-40 border dark-border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="e.g. 00.6600 (YB)"
              value={procedureInput}
              onChange={(e) => setProcedureInput(e.target.value)}
            />
            {inputProcedureName && (
              <span
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 max-w-[14rem] truncate text-xs text-gray-400"
                title={inputProcedureName}
              >
                {inputProcedureName}
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="px-4 py-3 bg-gray-700 text-gray-100 rounded-lg border border-gray-600 hover:bg-gray-600"
          onClick={() => setProcedureInput('')}
        >
          Clear
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-4">
        <h3 className="text-lg font-bold text-gray-100">Matches</h3>
        <span className="text-sm text-gray-400">ADRGs: <span className="text-gray-200 font-semibold">{stats.adrgCount}</span></span>
        <span className="text-sm text-gray-400">DRGs: <span className="text-gray-200 font-semibold">{stats.drgCount}</span></span>
      </div>

      {!canonicalProcedure ? (
        <p className="text-gray-400">Enter a procedure code above to calculate possible DRGs.</p>
      ) : !inputProcedureName ? (
        <p className="text-yellow-300">Code not recognized in YB procedure dictionary. Matching starts after a valid code maps to a name.</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-400">No DRG candidates found for this procedure code.</p>
      ) : (
        <div className="overflow-x-auto border dark-border rounded-lg max-h-[640px]">
          <table className="w-full text-left text-sm">
            <thead className="border-b dark-border">
              <tr>
                <th className="sticky top-0 z-10 p-3 font-semibold text-gray-200 w-28 bg-gray-800">DRG</th>
                <th className="sticky top-0 z-10 p-3 font-semibold text-gray-200 bg-gray-800">DRG Name</th>
                <th className="sticky top-0 z-10 p-3 font-semibold text-gray-200 w-24 bg-gray-800">ADRG</th>
                <th className="sticky top-0 z-10 p-3 font-semibold text-gray-200 bg-gray-800">ADRG Match Basis</th>
                <th className="sticky top-0 z-10 p-3 font-semibold text-gray-200 bg-gray-800">DRG Match Basis</th>
                <th className="sticky top-0 z-10 p-3 font-semibold text-gray-200 w-28 bg-gray-800">Weight</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={`${row.drgCode}-${row.adrgCode}-${idx}`} className="border-b dark-border last:border-0 hover:bg-info hover:bg-opacity-20 transition">
                  <td className="p-3 font-mono font-bold text-blue-400">{row.drgCode}</td>
                  <td className="p-3 text-gray-200">{row.drgName || '-'}</td>
                  <td className="p-3 font-mono text-gray-300">{row.adrgCode}</td>
                  <td className="p-3 text-gray-300">{row.adrgReason}</td>
                  <td className="p-3 text-gray-300">
                    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold mr-2 ${
                      row.matchType === 'exact'
                        ? 'bg-green-700/40 text-green-200 border border-green-600'
                        : row.matchType === 'prefix'
                          ? 'bg-blue-700/40 text-blue-200 border border-blue-600'
                          : 'bg-gray-700 text-gray-200 border border-gray-600'
                    }`}>
                      {row.matchType}
                    </span>
                    {row.subgroupReason}
                  </td>
                  <td className="p-3 font-mono text-gray-300">
                    {row.weight ?? '-'}
                    {row.weightTier2 != null ? ` / ${row.weightTier2}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function RuleTesterTab() {
  const showRuleLogicTester = false;

  const [testRuleText, setTestRuleText] = useState(
    `其他诊断：\nZ93.000 气管造口状态\n包含以下手术或操作：\n96.7201 呼吸机治疗[大于等于 96 小时]`
  );
  const [testDiags, setTestDiags] = useState('Z93.000, I63.9');
  const [testProcs, setTestProcs] = useState('96.7201');
  const [testResult, setTestResult] = useState(null);

  const [parsedViewerType, setParsedViewerType] = useState('ADRG');
  const [parsedViewerCode, setParsedViewerCode] = useState('');
  const [parsedViewerResult, setParsedViewerResult] = useState(null);
  const [parsedExpanded, setParsedExpanded] = useState(false);
  const [parsedSourceExpanded, setParsedSourceExpanded] = useState(false);

  const [procedureInput, setProcedureInput] = useState('');

  const adrgRules = useMemo(
    () => (loadADRGRules() || []).filter((item) => item?.type === 'ADRG' && item?.code),
    []
  );
  const subgroupRules = useMemo(() => loadDRGSubgroupRules() || [], []);
  const drgMap = useMemo(() => loadDRGMap() || {}, []);

  const adrgByCode = useMemo(() => {
    const map = new Map();
    for (const a of adrgRules) {
      map.set(String(a.code).toUpperCase(), a);
    }
    return map;
  }, [adrgRules]);

  const subgroupByADRG = useMemo(() => {
    const map = new Map();
    for (const r of subgroupRules) {
      const key = String(r?.adrgCode || '').toUpperCase();
      if (!key) continue;
      const list = map.get(key) || [];
      list.push(r);
      map.set(key, list);
    }
    return map;
  }, [subgroupRules]);

  const canonicalProcedure = useMemo(() => {
    const code = normalizeCode(procedureInput);
    if (!code) return '';
    return code;
  }, [procedureInput]);

  const inputProcedureName = useMemo(() => {
    if (!canonicalProcedure) return '';
    return ybProcNames[canonicalProcedure] || '';
  }, [canonicalProcedure]);

  const canMatch = !!canonicalProcedure && !!inputProcedureName;

  const rows = useMemo(() => {
    if (!canMatch) return [];

    const out = [];

    for (const adrg of adrgRules) {
      const adrgCode = String(adrg.code || '').toUpperCase();
      if (!adrgCode) continue;

      const adrgReason = adrgProcedureMatchReason(adrg, canonicalProcedure, adrgByCode);
      if (!adrgReason || adrgReason === 'ADRG requires any procedure') continue;

      const drgs = subgroupByADRG.get(adrgCode) || [];
      const priorityMatches = [];
      const fallbackMatches = [];

      for (const rule of drgs) {
        const procMatch = classifySubgroupProcedureMatch(rule, canonicalProcedure);
        if (!procMatch.include) continue;

        const drgCode = String(rule.drgCode || '').toUpperCase();
        const weightInfo = drgMap[drgCode] || {};

        const matchRecord = {
          adrgCode,
          adrgName: adrg.name || adrg.description || '',
          adrgReason,
          drgCode,
          drgName: rule.drgName || '',
          subgroupReason: procMatch.reason,
          matchType: procMatch.type,
          isAdrgOnly: Array.isArray(rule.conditions) && rule.conditions.includes('ADRG_ONLY'),
          weight: weightInfo.weight ?? null,
          weightTier2: weightInfo.weightTier2 ?? null,
        };

        if (procMatch.type === 'exact' || procMatch.type === 'prefix') {
          priorityMatches.push(matchRecord);
        } else {
          fallbackMatches.push(matchRecord);
        }
      }

      if (priorityMatches.length > 0) {
        out.push(...priorityMatches);
      } else if (fallbackMatches.length > 0) {
        out.push(...fallbackMatches);
      }
    }

    out.sort((a, b) => {
      const r = (DRG_MATCH_RANK[a.matchType] ?? 99) - (DRG_MATCH_RANK[b.matchType] ?? 99);
      if (r !== 0) return r;
      const c = a.drgCode.localeCompare(b.drgCode);
      if (c !== 0) return c;
      return a.adrgCode.localeCompare(b.adrgCode);
    });

    return out;
  }, [canMatch, canonicalProcedure, adrgRules, adrgByCode, subgroupByADRG, drgMap]);

  const stats = useMemo(() => {
    const adrgSet = new Set(rows.map((r) => r.adrgCode));
    const drgSet = new Set(rows.map((r) => r.drgCode));
    return {
      adrgCount: adrgSet.size,
      drgCount: drgSet.size,
    };
  }, [rows]);

  const handleTestRule = () => {
    try {
      const ruleObj = parseRule(testRuleText);
      const dList = testDiags.split(',').map((s) => s.trim());
      const pList = testProcs.split(',').map((s) => s.trim());
      const matchInfo = matchesRule(ruleObj, { diagnoses: dList, procedures: pList });
      setTestResult({ parsed: ruleObj, match: !!(matchInfo && matchInfo.matched), matchInfo });
    } catch (e) {
      setTestResult({ error: e.message });
    }
  };

  const handleLoadParsedRule = () => {
    try {
      if (!parsedViewerCode || String(parsedViewerCode).trim() === '')
        return setParsedViewerResult({ error: 'Please enter a code' });
      const code = String(parsedViewerCode).trim();

      if (parsedViewerType === 'MDC') {
        const item = Array.isArray(mdcRules)
          ? mdcRules.find((r) => r.type === 'MDC' && r.code === code.toUpperCase())
          : null;
        if (!item) return setParsedViewerResult({ error: `MDC ${code} not found` });
        const parsed = item.code === 'MDCZ' ? item.mdczCategories || {} : item.identifyingDiagnoses || [];
        setParsedViewerResult({ item, parsed });
        setParsedExpanded(false);
        setParsedSourceExpanded(false);
        return;
      }

      if (parsedViewerType === 'ADRG') {
        const adrg = getADRGByCode(code.toUpperCase());
        if (!adrg) return setParsedViewerResult({ error: `ADRG ${code} not found` });
        setParsedViewerResult({ item: adrg, parsed: adrg.rule || parseRule(adrg.content || '') });
        setParsedExpanded(false);
        setParsedSourceExpanded(false);
        return;
      }

      if (parsedViewerType === 'DRG') {
        const entries = subgroupRules.filter(
          (e) => String(e.drgCode || '').toLowerCase() === code.toLowerCase()
        );
        if (!entries || entries.length === 0)
          return setParsedViewerResult({ error: `DRG ${code} not found or has no subgroup rules` });
        setParsedViewerResult({ item: entries, parsed: entries });
        setParsedExpanded(false);
        setParsedSourceExpanded(false);
        return;
      }
    } catch (e) {
      setParsedViewerResult({ error: String(e) });
    }
  };

  const getParsedViewerStrings = () => {
    if (!parsedViewerResult) return null;
    try {
      const itemStr = JSON.stringify(parsedViewerResult.item, null, 2);
      const parsedStr = JSON.stringify(parsedViewerResult.parsed, null, 2);
      return { itemStr, parsedStr, identical: itemStr === parsedStr };
    } catch {
      return {
        itemStr: String(parsedViewerResult.item),
        parsedStr: String(parsedViewerResult.parsed),
        identical: false,
      };
    }
  };

  const parsedMappedNames = useMemo(
    () => buildParsedMappedNames(parsedViewerType, parsedViewerResult, ybDiagNames, ybProcNames),
    [parsedViewerType, parsedViewerResult]
  );

  return (
    <div className="space-y-6">
      {showRuleLogicTester && (
        <div className="dark-surface p-6 rounded-lg border dark-border shadow-sm">
          <h2 className="text-xl font-bold mb-4 text-gray-100">Rule Logic Tester</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium mb-2 text-gray-300">Rule Text</label>
              <textarea
                className="w-full h-64 p-3 border dark-border rounded-lg font-mono text-sm"
                value={testRuleText}
                onChange={(e) => setTestRuleText(e.target.value)}
              />
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2 text-gray-300">Test Diagnoses</label>
                <input
                  className="w-full p-3 border dark-border rounded-lg"
                  value={testDiags}
                  onChange={(e) => setTestDiags(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2 text-gray-300">Test Procedures</label>
                <input
                  className="w-full p-3 border dark-border rounded-lg"
                  value={testProcs}
                  onChange={(e) => setTestProcs(e.target.value)}
                />
              </div>
              <button
                onClick={handleTestRule}
                className="w-full bg-purple-600 text-white p-3 rounded-lg font-bold hover:bg-purple-700"
              >
                Test Logic
              </button>
            </div>
          </div>
          {testResult && (
            <div className="mt-4 p-4 dark-surface-2 rounded border dark-border">
              <span className={`font-bold ${testResult.match ? 'text-success' : 'text-error'}`}>
                {testResult.match ? 'MATCHED' : 'NO MATCH'}
              </span>
              <pre className="mt-2 text-xs bg-gray-800 text-success p-2 rounded overflow-auto">
                {`Parsed rule:\n${JSON.stringify(unescapeStrings(testResult.parsed), null, 2)}\n\nMatch details:\n${JSON.stringify(unescapeStrings(testResult.matchInfo), null, 2)}`}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Parsed Rule Viewer (MDC / ADRG / DRG) */}
      <div className="dark-surface p-6 rounded-lg border dark-border shadow-sm mt-8">
        <h2 className="text-xl font-bold mb-4 text-gray-100">Parsed Rule Viewer</h2>
        <div className="flex flex-col md:flex-row gap-3 items-stretch mb-4">
          <div className="flex gap-2 overflow-auto flex-wrap">
            {['MDC', 'ADRG', 'DRG'].map((t) => (
              <button
                key={t}
                onClick={() => setParsedViewerType(t)}
                className={`px-4 py-2 md:px-3 md:py-1 rounded text-sm font-semibold ${parsedViewerType === t ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <input
            placeholder="Code (case-insensitive, e.g. MDCZ / AA1 / ah27)"
            value={parsedViewerCode}
            onChange={(e) => setParsedViewerCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleLoadParsedRule(); } }}
            className="flex-1 p-2 border dark-border rounded"
          />
          <button onClick={handleLoadParsedRule} className="w-full md:w-auto px-4 py-2 bg-green-600 text-white rounded">Load</button>
        </div>

        {parsedViewerResult && (
          <div className="p-3 dark-surface-2 rounded border dark-border">
            {parsedViewerResult.error ? (
              <div className="text-error font-bold">{parsedViewerResult.error}</div>
            ) : (
              (() => {
                const pv = getParsedViewerStrings();
                if (!pv) return null;
                const mappedNamesBlock = parsedMappedNames.length > 0 ? (
                  <div className="mb-3 p-2 rounded border dark-border bg-gray-800/70 text-xs text-gray-200 space-y-2 max-h-56 overflow-auto">
                    {parsedMappedNames.map((grp, i) => (
                      <div key={`${grp.label}-${i}`}>
                        <div className="text-gray-300 font-semibold mb-1">{grp.label}</div>
                        <div className="grid grid-cols-1 md:grid-cols-3 2xl:grid-cols-5 gap-1.5">
                          {grp.items.map((item, rowIdx) => (
                            <div key={`${grp.label}-${item.code}-${rowIdx}`} className="grid grid-cols-[7.5rem_1fr] gap-1.5 min-w-0 py-0.5 border-b border-gray-700/40 last:border-b-0">
                              <span className="font-mono text-blue-300 truncate" title={item.code}>{item.code}</span>
                              <span className="text-gray-200 break-words leading-tight">{item.name || '-'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null;

                const parsedDetailBlock = pv.identical ? (
                  <div className="mt-2">
                    <button
                      onClick={() => setParsedExpanded((v) => !v)}
                      className="px-3 py-1 text-sm rounded bg-gray-700 text-gray-200 mr-2"
                    >
                      {parsedExpanded ? 'Hide Parsed' : 'Show Parsed'}
                    </button>
                    {parsedExpanded && (
                      <>
                        <div className="text-sm text-gray-300 mt-2 mb-2">Parsed / Source (identical)</div>
                        <pre className="text-xs font-mono text-gray-300 overflow-auto whitespace-pre-wrap break-words max-h-96">{pv.parsedStr}</pre>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        onClick={() => setParsedExpanded((v) => !v)}
                        className="px-3 py-1 text-sm rounded bg-gray-700 text-gray-200"
                      >
                        {parsedExpanded ? 'Hide Parsed' : 'Show Parsed'}
                      </button>
                      <button
                        onClick={() => setParsedSourceExpanded((v) => !v)}
                        className="px-3 py-1 text-sm rounded bg-gray-700 text-gray-200"
                      >
                        {parsedSourceExpanded ? 'Hide Source' : 'Show Source'}
                      </button>
                    </div>
                    {parsedExpanded && (
                      <>
                        <div className="text-sm text-gray-300 mt-2 mb-2">Parsed</div>
                        <pre className="text-xs font-mono text-gray-300 overflow-auto whitespace-pre-wrap break-words max-h-80 mb-2">{pv.parsedStr}</pre>
                      </>
                    )}
                    {parsedSourceExpanded && (
                      <pre className="text-xs font-mono text-gray-300 mt-2 overflow-auto whitespace-pre-wrap break-words max-h-64">{pv.itemStr}</pre>
                    )}
                  </>
                );

                return (
                  <>
                    {mappedNamesBlock}
                    {parsedDetailBlock}
                  </>
                );
              })()
            )}
          </div>
        )}
      </div>

      <ProcedureDrgExplorer
        procedureInput={procedureInput}
        setProcedureInput={setProcedureInput}
        inputProcedureName={inputProcedureName}
        canonicalProcedure={canonicalProcedure}
        stats={stats}
        rows={rows}
      />
    </div>
  );
}
