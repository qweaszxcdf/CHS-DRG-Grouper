import { useCallback, useMemo } from "react";
import { FileUp, Download } from "lucide-react";

const DELIMITER_BY_OPTION = {
  PIPE: '|',
  COMMA: ',',
  SEMICOLON: ';',
  TAB: '\t',
  PLUS: '+',
};

const NEW_TECHNIQUE_TRUTHY = new Set(['1', 'true', 'yes', 'y', 't', 'on', '是']);
const MULTI_SITE_TRUTHY = new Set(['1', 'true', 'yes', 'y', 't', 'on', '是']);

const resolveDelimiter = (option, customDelimiter, fallback = '|') => (
  DELIMITER_BY_OPTION[option] ?? (customDelimiter || fallback)
);

const isRegexValid = (q) => {
  if (!q) return true;
  try { new RegExp(q); return true; } catch { return false; }
};

const filterHeaderKeys = (keys, query, isRegex) => {
  const qRaw = (query || '').trim();
  if (!qRaw) return keys;
  if (isRegex) {
    try {
      const re = new RegExp(qRaw, 'i');
      return keys.filter(k => re.test(String(k || '')));
    } catch {
      return [];
    }
  }
  const q = qRaw.toLowerCase();
  return keys.filter(k => String(k || '').toLowerCase().includes(q));
};

const getSampleCols = (sampleObj, keyOrKeys, delim, cleanCell) => {
  if (!keyOrKeys) return [];
  const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
  const out = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(sampleObj, key) && sampleObj[key] != null) {
      const cell = String(cleanCell(sampleObj[key]));
      if (cell) out.push(...cell.split(delim).map(s => s.trim()).filter(Boolean));
    }
  }
  return out;
};

const truncateStr = (s, max = 120) => {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
};

const highlightMatch = (text, q, isRegex = false) => {
  if (!q) return text;
  try {
    const s = String(text || '');
    if (isRegex) {
      try {
        const re = new RegExp(q, 'gi');
        const parts = [];
        let lastIndex = 0;
        let match;
        let key = 0;
        while ((match = re.exec(s)) !== null) {
          const idx = match.index;
          const len = match[0].length;
          if (idx > lastIndex) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex, idx)}</span>);
          parts.push(<mark key={`${s}-m-${key++}`} className="bg-yellow-300 text-black rounded px-0.5">{s.slice(idx, idx + len)}</mark>);
          lastIndex = idx + len;
          if (len === 0) re.lastIndex++;
        }
        if (lastIndex < s.length) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex)}</span>);
        return parts;
      } catch {
        return text;
      }
    }

    const needle = String(q || '').toLowerCase();
    if (!needle) return s;
    const lc = s.toLowerCase();
    const parts = [];
    let lastIndex = 0;
    let idx = lc.indexOf(needle, lastIndex);
    let key = 0;
    while (idx !== -1) {
      if (idx > lastIndex) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex, idx)}</span>);
      parts.push(<mark key={`${s}-m-${key++}`} className="bg-yellow-300 text-black rounded px-0.5">{s.slice(idx, idx + needle.length)}</mark>);
      lastIndex = idx + needle.length;
      idx = lc.indexOf(needle, lastIndex);
    }
    if (lastIndex < s.length) parts.push(<span key={`${s}-p-${key++}`}>{s.slice(lastIndex)}</span>);
    return parts;
  } catch {
    return text;
  }
};

const formatSampleRow = (row) => {
  try {
    if (row == null) return '';
    if (typeof row === 'object') {
      const keys = Object.keys(row || {}).slice(0, 6);
      const parts = keys.map(k => {
        const v = row[k];
        const vs = (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return `${k}: ${truncateStr(vs, 60)}`;
      });
      return parts.join(' · ');
    }
    return truncateStr(String(row), 120);
  } catch {
    return String(row).slice(0, 200);
  }
};

function BatchTab({ batchUi, batchActions, ruleVersion, ruleVersions, onRuleVersionChange }) {
  const {
    uploadedBatchFile,
    parsedPreview,
    previewIdKey,
    previewDiagsContainerRef,
    previewDiagsKey,
    diagsBlurTimeoutRef,
    suppressCollapseRef,
    prevPreviewDiagsCountRef,
    diagDelimiterOption,
    diagCustomDelimiter,
    previewDiagsCollapsed,
    headerFilterDiagInputRef,
    headerFilterDiag,
    headerFilterDiagIsRegex,
    previewProcsContainerRef,
    previewProcsKey,
    procsBlurTimeoutRef,
    prevPreviewProcsCountRef,
    procDelimiterOption,
    procCustomDelimiter,
    previewProcsCollapsed,
    headerFilterProcInputRef,
    headerFilterProc,
    headerFilterProcIsRegex,
    SELECT_ALL_CONFIRM_THRESHOLD,
    previewPatientInfoExpanded,
    previewAgeKey,
    previewAgeDaysKey,
    previewBirthWeightKey,
    previewDischargeKey,
    previewNewTechniqueKey,
    previewMultiSiteKey,
    previewGenderKey,
    normMisses,
    previewSampleIndex,
    batchData,
    parseTimeMs,
    parsingInProgress,
    parseError,
    batchResults,
    batchTimeMs,
  } = batchUi;

  const {
    handleFileUpload,
    handleRemoveFile,
    handlePreviewIdChange,
    setPreviewDiagsCollapsed,
    setDiagDelimiterOption,
    setDiagCustomDelimiter,
    handlePreviewDiagsChange,
    setHeaderFilterDiag,
    setHeaderFilterDiagIsRegex,
    setPreviewProcsCollapsed,
    setProcDelimiterOption,
    setProcCustomDelimiter,
    handlePreviewProcsChange,
    setHeaderFilterProc,
    setHeaderFilterProcIsRegex,
    setPreviewPatientInfoExpanded,
    handlePreviewAgeChange,
    handlePreviewAgeDaysChange,
    handlePreviewBirthWeightChange,
    handlePreviewDischargeChange,
    handlePreviewNewTechChange,
    handlePreviewMultiSiteChange,
    handlePreviewGenderChange,
    setPreviewSampleIndex,
    getMappingKeys,
    cleanCell,
    normalizeEntriesNoUI,
    handleGroupBatch,
    handleDownload,
  } = batchActions;

  const previewSample = (parsedPreview && parsedPreview.sample)
    ? (parsedPreview.sample[previewSampleIndex] || null)
    : null;
  const previewDiagDelimiterResolved = useMemo(
    () => resolveDelimiter(diagDelimiterOption, diagCustomDelimiter, '|'),
    [diagDelimiterOption, diagCustomDelimiter]
  );
  const previewProcDelimiterResolved = useMemo(
    () => resolveDelimiter(procDelimiterOption, procCustomDelimiter, '|'),
    [procDelimiterOption, procCustomDelimiter]
  );

  const { previewRawDiags, previewRawProcs } = useMemo(() => {
    if (!previewSample) return { previewRawDiags: [], previewRawProcs: [] };
    const sample = previewSample || {};
    const { diagsKey, procsKey } = getMappingKeys(sample);
    const rawDiags = getSampleCols(sample, diagsKey, previewDiagDelimiterResolved, cleanCell);
    const rawProcs = getSampleCols(sample, procsKey, previewProcDelimiterResolved, cleanCell);
    return { previewRawDiags: rawDiags, previewRawProcs: rawProcs };
  }, [
    previewSample,
    getMappingKeys,
    cleanCell,
    previewDiagDelimiterResolved,
    previewProcDelimiterResolved,
  ]);

  const previewConvDiags = useMemo(
    () => normalizeEntriesNoUI(previewRawDiags, 'Diagnosis'),
    [previewRawDiags, normalizeEntriesNoUI]
  );
  const previewConvProcs = useMemo(
    () => normalizeEntriesNoUI(previewRawProcs, 'Procedure'),
    [previewRawProcs, normalizeEntriesNoUI]
  );

  const filteredHeaderKeysDiag = useMemo(() => {
    const keys = (parsedPreview && Array.isArray(parsedPreview.headerKeys)) ? parsedPreview.headerKeys : [];
    return filterHeaderKeys(keys, headerFilterDiag, headerFilterDiagIsRegex);
  }, [parsedPreview, headerFilterDiag, headerFilterDiagIsRegex]);

  const filteredHeaderKeysProc = useMemo(() => {
    const keys = (parsedPreview && Array.isArray(parsedPreview.headerKeys)) ? parsedPreview.headerKeys : [];
    return filterHeaderKeys(keys, headerFilterProc, headerFilterProcIsRegex);
  }, [parsedPreview, headerFilterProc, headerFilterProcIsRegex]);

  const headerFilterDiagRegexValid = useMemo(() => {
    if (!headerFilterDiagIsRegex) return true;
    const q = (headerFilterDiag || '').trim();
    return isRegexValid(q);
  }, [headerFilterDiag, headerFilterDiagIsRegex]);

  const headerFilterProcRegexValid = useMemo(() => {
    if (!headerFilterProcIsRegex) return true;
    const q = (headerFilterProc || '').trim();
    return isRegexValid(q);
  }, [headerFilterProc, headerFilterProcIsRegex]);

  const parsedDataPreview = useMemo(() => {
    if (!(parsedPreview && parsedPreview.sample && parsedPreview.sample.length > 0)) {
      return {
        hasSample: false,
        idVal: '',
        rawDiags: [],
        rawProcs: [],
        convDiags: [],
        convProcs: [],
        samplePatientInfo: {},
      };
    }

    const sampleRow = parsedPreview.sample[previewSampleIndex] || {};
    let idVal = '';
    let rawDiags = [];
    let rawProcs = [];
    let samplePatientInfo = {};

    if (parsedPreview.headerKeys) {
      const sample = sampleRow || {};
      const { idKey, diagsKey, procsKey, ageKey, ageDaysKey, bwKey, dischargeKey, newTechKey, multiSiteKey, genderKey } = getMappingKeys(sample);
      idVal = cleanCell(sample[idKey] != null ? sample[idKey] : '');
      rawDiags = previewRawDiags && previewRawDiags.length ? previewRawDiags : getSampleCols(sample, diagsKey, previewDiagDelimiterResolved, cleanCell);
      rawProcs = previewRawProcs && previewRawProcs.length ? previewRawProcs : getSampleCols(sample, procsKey, previewProcDelimiterResolved, cleanCell);

      try { if (ageKey) { const v = cleanCell(sample[ageKey]); if (v !== '') { const n = Number(String(v).trim()); if (!Number.isNaN(n)) samplePatientInfo.age = Math.trunc(n); } } } catch { /* ignore */ }
      try { if (ageDaysKey) { const v = cleanCell(sample[ageDaysKey]); if (v !== '') { const n = Number(String(v).trim()); if (!Number.isNaN(n)) samplePatientInfo.ageInDays = Math.trunc(n); } } } catch { /* ignore */ }
      try { if (bwKey) { const v = cleanCell(sample[bwKey]); if (v !== '') { const n = Number(String(v).trim()); if (!Number.isNaN(n)) samplePatientInfo.birthWeight = Math.trunc(n); } } } catch { /* ignore */ }
      try { if (dischargeKey) { const v = cleanCell(sample[dischargeKey]); if (v !== '') { samplePatientInfo.dischargeStatus = v === '5' ? 'death' : String(v).trim(); } } } catch { /* ignore */ }
      try { if (genderKey) { const v = cleanCell(sample[genderKey]); if (v !== '') samplePatientInfo.gender = String(v).trim(); } } catch { /* ignore */ }
      try { if (newTechKey) { const v = cleanCell(sample[newTechKey]); if (NEW_TECHNIQUE_TRUTHY.has(String(v).trim().toLowerCase())) { samplePatientInfo.newTechnique = true; } } } catch { /* ignore */ }
      try { if (multiSiteKey) { const v = cleanCell(sample[multiSiteKey]); if (MULTI_SITE_TRUTHY.has(String(v).trim().toLowerCase())) { samplePatientInfo.multiSite = true; } } } catch { /* ignore */ }
    }

    const convDiags = (previewConvDiags && previewRawDiags && previewRawDiags.length && previewRawDiags === rawDiags)
      ? previewConvDiags
      : normalizeEntriesNoUI(rawDiags, 'Diagnosis');
    const convProcs = (previewConvProcs && previewRawProcs && previewRawProcs.length && previewRawProcs === rawProcs)
      ? previewConvProcs
      : normalizeEntriesNoUI(rawProcs, 'Procedure');

    return {
      hasSample: true,
      idVal,
      rawDiags,
      rawProcs,
      convDiags,
      convProcs,
      samplePatientInfo,
    };
  }, [
    parsedPreview,
    previewSampleIndex,
    getMappingKeys,
    cleanCell,
    previewRawDiags,
    previewRawProcs,
    previewConvDiags,
    previewConvProcs,
    normalizeEntriesNoUI,
    previewDiagDelimiterResolved,
    previewProcDelimiterResolved,
  ]);

  const previewDiagsKeySet = useMemo(
    () => new Set(Array.isArray(previewDiagsKey) ? previewDiagsKey : previewDiagsKey ? [previewDiagsKey] : []),
    [previewDiagsKey]
  );
  const previewProcsKeySet = useMemo(
    () => new Set(Array.isArray(previewProcsKey) ? previewProcsKey : previewProcsKey ? [previewProcsKey] : []),
    [previewProcsKey]
  );

  const handleTogglePatientInfo = useCallback(
    () => setPreviewPatientInfoExpanded(v => !v),
    [setPreviewPatientInfoExpanded]
  );

  const handleDiagsBlur = useCallback(() => {
    const curr = Array.isArray(previewDiagsKey) ? previewDiagsKey.length : (previewDiagsKey ? 1 : 0);
    if (diagsBlurTimeoutRef.current) clearTimeout(diagsBlurTimeoutRef.current);
    diagsBlurTimeoutRef.current = setTimeout(() => {
      if (suppressCollapseRef.current) { suppressCollapseRef.current = false; diagsBlurTimeoutRef.current = null; return; }
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (!previewDiagsContainerRef.current || !previewDiagsContainerRef.current.contains(active)) {
        setPreviewDiagsCollapsed(curr === 1);
      }
      prevPreviewDiagsCountRef.current = curr;
      diagsBlurTimeoutRef.current = null;
    }, 0);
  }, [previewDiagsKey, diagsBlurTimeoutRef, suppressCollapseRef, previewDiagsContainerRef, setPreviewDiagsCollapsed, prevPreviewDiagsCountRef]);

  const handleProcsBlur = useCallback(() => {
    const curr = Array.isArray(previewProcsKey) ? previewProcsKey.length : (previewProcsKey ? 1 : 0);
    if (procsBlurTimeoutRef.current) clearTimeout(procsBlurTimeoutRef.current);
    procsBlurTimeoutRef.current = setTimeout(() => {
      if (suppressCollapseRef.current) { suppressCollapseRef.current = false; procsBlurTimeoutRef.current = null; return; }
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if (!previewProcsContainerRef.current || !previewProcsContainerRef.current.contains(active)) {
        setPreviewProcsCollapsed(curr === 1);
      }
      prevPreviewProcsCountRef.current = curr;
      procsBlurTimeoutRef.current = null;
    }, 0);
  }, [previewProcsKey, procsBlurTimeoutRef, suppressCollapseRef, previewProcsContainerRef, setPreviewProcsCollapsed, prevPreviewProcsCountRef]);

  const batchResultSummary = useMemo(() => {
    if (!Array.isArray(batchResults) || batchResults.length === 0) {
      return { count0000: 0, countQY: 0 };
    }

    let count0000 = 0;
    let countQY = 0;
    for (const row of batchResults) {
      const drg = row && row.drg;
      if (drg === '0000') count0000 += 1;
      if (typeof drg === 'string' && drg.endsWith('QY')) countQY += 1;
    }
    return { count0000, countQY };
  }, [batchResults]);
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <label htmlFor="batch-rule-version" className="text-sm text-gray-400">DRG版本</label>
        <select
          id="batch-rule-version"
          value={ruleVersion}
          onChange={(event) => onRuleVersionChange(event.target.value)}
          className="border border-gray-600 bg-gray-900 rounded px-2 py-1 text-sm"
          disabled={parsingInProgress}
        >
          {ruleVersions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
      {/* Batch Upload */}
      <div className="border-2 border-dashed border-gray-400 rounded-xl p-12 text-center hover:bg-info hover:bg-opacity-10 transition cursor-pointer relative">
        <input
          type="file"
          accept=".csv,.xls,.xlsx"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          onChange={handleFileUpload}
        />
        <FileUp className="mx-auto h-12 w-12 text-gray-300 mb-4" />
        <p className="text-lg font-medium text-gray-200">Drop your CSV file here</p>
        <p className="text-sm text-gray-400 mt-2">Format: id, diagnoses, procedures (pipe separated)</p>
      </div>

      {uploadedBatchFile && (
        <div className="mt-4 p-3 border rounded bg-gray-900">
          <div className="flex items-center justify-between">
            <div className="text-sm">Uploaded: <strong>{uploadedBatchFile.name}</strong></div>
            <div className="flex items-center gap-2">
              {/* Parsing starts automatically on upload; explicit button removed */}
              <button onClick={handleRemoveFile} className="text-sm px-3 py-1 border rounded">Remove</button>
            </div>
          </div>

          {parseError && (
            <div className="mt-3 rounded border border-red-700 bg-red-950 bg-opacity-50 p-3 text-sm text-red-200" role="alert">
              File parsing failed: {parseError}
            </div>
          )}

          {parsedPreview && (
            <div className="mt-3 text-sm">
              <div>
                Rows detected: {parsedPreview.dataLength}
                {parsedPreview.headerKeys && (
                  <span className="ml-2 text-xs text-gray-400">({parsedPreview.headerKeys.length} headers)</span>
                )}
              </div>
              {parsedPreview.headerKeys && (
                <div className="mt-2">
                  <div className="flex flex-col md:flex-row md:items-center gap-3">
                    <div className="text-xs md:mr-2">Map columns:</div>
                    <div className="flex flex-col md:flex-row md:items-center gap-2 w-full">
                      <div className="flex-1 md:flex-initial md:mr-3">
                        <div className="text-xs mb-1">ID</div>
                        <select title={previewIdKey || '(none)'} className="p-1 border rounded w-full md:w-auto text-xs bg-gray-800" value={previewIdKey} onChange={e => handlePreviewIdChange(e.target.value)}>
                          <option title="(none)" value="">(none)</option>
                          {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                        </select>
                      </div>

                      <label
                        className="text-xs flex flex-col w-full md:w-auto"
                        ref={previewDiagsContainerRef}
                        tabIndex={-1}
                        onPointerDown={(ev) => { try { if (!ev || ev.pointerType !== 'touch') return; const tgt = ev.target; if (tgt && typeof tgt.closest === 'function' && tgt.closest('.delimiter-control')) return; previewDiagsContainerRef.current && previewDiagsContainerRef.current.focus(); } catch { /* ignore focus fallback errors */ } }}
                        onFocus={(e) => { try { const tgt = e && e.target; if (tgt && typeof tgt.closest === 'function' && tgt.closest('.delimiter-control')) return; } catch { /* ignore focus target errors */ } setPreviewDiagsCollapsed(false); }}
                        onBlur={handleDiagsBlur}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="whitespace-nowrap">Diagnoses</span>
                          <div className="flex items-center gap-2 ml-2 delimiter-control">
                            <select title="Diagnoses delimiter" className="text-xs p-1 border rounded bg-gray-800" value={diagDelimiterOption} onChange={e => setDiagDelimiterOption(e.target.value)}>
                              <option value="PIPE">|</option>
                              <option value="COMMA">,</option>
                              <option value="SEMICOLON">;</option>
                              <option value="TAB">\t</option>
                              <option value="PLUS">+</option>
                              <option value="CUSTOM">Custom</option>
                            </select>
                            {diagDelimiterOption === 'CUSTOM' && (
                              <input className="w-16 p-1 border rounded text-xs bg-gray-800" value={diagCustomDelimiter} onChange={e => setDiagCustomDelimiter(e.target.value)} placeholder="delim" />
                            )}
                          </div>
                        </div>

                        <div className="mt-1 p-1 border rounded w-full md:w-auto bg-gray-800">
                          {previewDiagsCollapsed && (Array.isArray(previewDiagsKey) ? previewDiagsKey.length === 1 : !!previewDiagsKey) ? (
                            <div className="flex items-center justify-between gap-2">
                              <div
                                className="truncate text-xs font-mono px-2 py-1 bg-gray-900 rounded cursor-pointer"
                                role="button"
                                tabIndex={0}
                                onPointerDown={() => { suppressCollapseRef.current = true; setTimeout(() => { suppressCollapseRef.current = false; }, 300); }}
                                onClick={() => setPreviewDiagsCollapsed(false)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setPreviewDiagsCollapsed(false); e.preventDefault(); } }}
                                aria-label={`Selected diagnosis column: ${Array.isArray(previewDiagsKey) ? previewDiagsKey[0] : previewDiagsKey}`}
                              >
                                {highlightMatch(Array.isArray(previewDiagsKey) ? previewDiagsKey[0] : previewDiagsKey, headerFilterDiag, headerFilterDiagIsRegex)}
                              </div>
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => handlePreviewDiagsChange([])} className="text-xs px-2 py-0.5 border rounded">Clear</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="mb-1 flex items-center gap-2">
                                <input ref={headerFilterDiagInputRef} value={headerFilterDiag} onChange={e => setHeaderFilterDiag(e.target.value)} placeholder="filter diag headers..." className="p-1 border rounded bg-gray-900 text-xs w-full md:w-56" />
                                <button type="button" title="Use regex" onClick={() => setHeaderFilterDiagIsRegex(v => !v)} className={`text-xs px-2 py-0.5 border rounded ${headerFilterDiagIsRegex ? 'bg-blue-600' : ''}`}>.*</button>
                                <span className="ml-2 text-xs text-gray-400">{filteredHeaderKeysDiag.length}</span>
                              </div>

                              <div className="flex flex-wrap gap-2 max-h-40 overflow-auto p-1">
                                {filteredHeaderKeysDiag.map(k => (
                                  <label key={k} className="inline-flex items-center text-xs mr-2">
                                    <input type="checkbox" className="mr-1" checked={previewDiagsKeySet.has(k)} onChange={e => {
                                      const prev = Array.isArray(previewDiagsKey) ? previewDiagsKey : (previewDiagsKey ? [previewDiagsKey] : []);
                                      const next = e.target.checked ? [...prev, k] : prev.filter(x => x !== k);
                                      handlePreviewDiagsChange(next);
                                    }} />
                                    <span className="truncate text-xs">{highlightMatch(k, headerFilterDiag, headerFilterDiagIsRegex)}</span>
                                  </label>
                                ))}
                                {filteredHeaderKeysDiag.length === 0 && (
                                  <div className="text-xs text-gray-400">{headerFilterDiagIsRegex && !headerFilterDiagRegexValid ? 'Invalid regex' : 'No matching headers'}</div>
                                )}
                                <button type="button" onClick={() => {
                                  const cnt = filteredHeaderKeysDiag.length;
                                  if (cnt > SELECT_ALL_CONFIRM_THRESHOLD) {
                                    const ok = window.confirm(`Select ${cnt} headers for Diagnoses? This will select a large number of columns — continue?`);
                                    if (!ok) return;
                                  }
                                  handlePreviewDiagsChange(filteredHeaderKeysDiag);
                                }} className="text-xs ml-1 px-2 py-0.5 border rounded">Select all matches</button>
                                <button type="button" onClick={() => handlePreviewDiagsChange([])} className="text-xs ml-1 px-2 py-0.5 border rounded">Clear</button>
                              </div>
                            </>
                          )}
                        </div>
                      </label>

                      <label
                        className="text-xs flex flex-col w-full md:w-auto"
                        ref={previewProcsContainerRef}
                        tabIndex={-1}
                        onPointerDown={(ev) => { try { if (!ev || ev.pointerType !== 'touch') return; const tgt = ev.target; if (tgt && typeof tgt.closest === 'function' && tgt.closest('.delimiter-control')) return; previewProcsContainerRef.current && previewProcsContainerRef.current.focus(); } catch { /* ignore focus fallback errors */ } }}
                        onFocus={(e) => { try { const tgt = e && e.target; if (tgt && typeof tgt.closest === 'function' && tgt.closest('.delimiter-control')) return; } catch { /* ignore focus target errors */ } setPreviewProcsCollapsed(false); }}
                        onBlur={handleProcsBlur}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="whitespace-nowrap">Procedures</span>
                          <div className="flex items-center gap-2 ml-2 delimiter-control">
                            <select title="Procedures delimiter" className="text-xs p-1 border rounded bg-gray-800" value={procDelimiterOption} onChange={e => setProcDelimiterOption(e.target.value)}>
                              <option value="PIPE">|</option>
                              <option value="COMMA">,</option>
                              <option value="SEMICOLON">;</option>
                              <option value="TAB">\t</option>
                              <option value="PLUS">+</option>
                              <option value="CUSTOM">Custom</option>
                            </select>
                            {procDelimiterOption === 'CUSTOM' && (
                              <input className="w-16 p-1 border rounded text-xs bg-gray-800" value={procCustomDelimiter} onChange={e => setProcCustomDelimiter(e.target.value)} placeholder="delim" />
                            )}
                          </div>
                        </div>

                        <div className="mt-1 p-1 border rounded w-full md:w-auto bg-gray-800">
                          {previewProcsCollapsed && (Array.isArray(previewProcsKey) ? previewProcsKey.length === 1 : !!previewProcsKey) ? (
                            <div className="flex items-center justify-between gap-2">
                              <div
                                className="truncate text-xs font-mono px-2 py-1 bg-gray-900 rounded cursor-pointer"
                                role="button"
                                tabIndex={0}
                                onPointerDown={() => { suppressCollapseRef.current = true; setTimeout(() => { suppressCollapseRef.current = false; }, 300); }}
                                onClick={() => setPreviewProcsCollapsed(false)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setPreviewProcsCollapsed(false); e.preventDefault(); } }}
                                aria-label={`Selected procedure column: ${Array.isArray(previewProcsKey) ? previewProcsKey[0] : previewProcsKey}`}
                              >
                                {highlightMatch(Array.isArray(previewProcsKey) ? previewProcsKey[0] : previewProcsKey, headerFilterProc, headerFilterProcIsRegex)}
                              </div>
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => handlePreviewProcsChange([])} className="text-xs px-2 py-0.5 border rounded">Clear</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="mb-1 flex items-center gap-2">
                                <input ref={headerFilterProcInputRef} value={headerFilterProc} onChange={e => setHeaderFilterProc(e.target.value)} placeholder="filter proc headers..." className="p-1 border rounded bg-gray-900 text-xs w-full md:w-56" />
                                <button type="button" title="Use regex" onClick={() => setHeaderFilterProcIsRegex(v => !v)} className={`text-xs px-2 py-0.5 border rounded ${headerFilterProcIsRegex ? 'bg-blue-600' : ''}`}>.*</button>
                                <span className="ml-2 text-xs text-gray-400">{filteredHeaderKeysProc.length}</span>
                              </div>

                              <div className="flex flex-wrap gap-2 max-h-40 overflow-auto p-1">
                                {filteredHeaderKeysProc.map(k => (
                                  <label key={k} className="inline-flex items-center text-xs mr-2">
                                    <input type="checkbox" className="mr-1" checked={previewProcsKeySet.has(k)} onChange={e => {
                                      const prev = Array.isArray(previewProcsKey) ? previewProcsKey : (previewProcsKey ? [previewProcsKey] : []);
                                      const next = e.target.checked ? [...prev, k] : prev.filter(x => x !== k);
                                      handlePreviewProcsChange(next);
                                    }} />
                                    <span className="truncate text-xs">{highlightMatch(k, headerFilterProc, headerFilterProcIsRegex)}</span>
                                  </label>
                                ))}
                                {filteredHeaderKeysProc.length === 0 && (
                                  <div className="text-xs text-gray-400">{headerFilterProcIsRegex && !headerFilterProcRegexValid ? 'Invalid regex' : 'No matching headers'}</div>
                                )}
                                <button type="button" onClick={() => {
                                  const cnt = filteredHeaderKeysProc.length;
                                  if (cnt > SELECT_ALL_CONFIRM_THRESHOLD) {
                                    const ok = window.confirm(`Select ${cnt} headers for Procedures? This will select a large number of columns — continue?`);
                                    if (!ok) return;
                                  }
                                  handlePreviewProcsChange(filteredHeaderKeysProc);
                                }} className="text-xs ml-1 px-2 py-0.5 border rounded">Select all matches</button>
                                <button type="button" onClick={() => handlePreviewProcsChange([])} className="text-xs ml-1 px-2 py-0.5 border rounded">Clear</button>
                              </div>
                            </>
                          )}
                        </div>
                      </label>
                    </div>
                  </div>

                  <div className="mt-3 border-t pt-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold mb-2">Patient Info</div>
                      <button onClick={handleTogglePatientInfo} className="text-xs px-2 py-0.5 border rounded ml-2">
                        {previewPatientInfoExpanded ? 'Hide' : 'Show'}
                      </button>
                    </div>

                    {previewPatientInfoExpanded && (
                      <div className="flex flex-col md:flex-row md:items-center gap-2 w-full">
                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">Age</span>
                          <select title={previewAgeKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewAgeKey} onChange={e => handlePreviewAgeChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">Gender</span>
                          <select title={previewGenderKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewGenderKey} onChange={e => handlePreviewGenderChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">Age (days)</span>
                          <select title={previewAgeDaysKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewAgeDaysKey} onChange={e => handlePreviewAgeDaysChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">Birth wt</span>
                          <select title={previewBirthWeightKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewBirthWeightKey} onChange={e => handlePreviewBirthWeightChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">Discharge</span>
                          <select title={previewDischargeKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewDischargeKey} onChange={e => handlePreviewDischargeChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">New Technique</span>
                          <select title={previewNewTechniqueKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewNewTechniqueKey} onChange={e => handlePreviewNewTechChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>

                        <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                          <span className="whitespace-nowrap">Multi-site</span>
                          <select title={previewMultiSiteKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewMultiSiteKey} onChange={e => handlePreviewMultiSiteChange(e.target.value)}>
                            <option title="(none)" value="">(none)</option>
                            {parsedPreview.headerKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                          </select>
                        </label>
                      </div>
                    )}
                  </div>

                  {/* Normalization misses panel (shows recent unique misses) */}
                  <div className="mt-3 border-t pt-2">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-semibold">Normalization Misses</div>
                      <div className="text-xs text-gray-400">{normMisses.length} unique</div>
                    </div>
                    <div className="mt-2 text-xs text-gray-300 max-h-40 overflow-auto">
                      {normMisses.length === 0 ? (
                        <div className="text-gray-400">No recent normalization misses</div>
                      ) : (
                        <ul className="list-disc pl-5 space-y-1">
                          {normMisses.slice(0,50).map((m) => (
                            <li key={m.key} className="break-words">
                              <strong className="font-mono">{m.value}</strong>
                              <span className="ml-2 text-xs text-gray-400">[{m.src}/{m.type}]</span>
                              <span className="ml-2 text-xs text-gray-500">×{m.count}</span>
                              {m.lastSeen && <span className="ml-2 text-xs text-gray-500">({m.lastSeen})</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-2">
                <div className="italic text-xs">Sample rows (first 3):</div>
                {parsedPreview.headerKeys ? (
                  <div className="mt-1 rounded" style={{maxHeight: 200, overflowX: 'auto', overflowY: 'hidden'}}>
                    <table className="w-full text-xs table-auto border-collapse">
                      <thead>
                        <tr>
                          {parsedPreview.headerKeys.map(k => (
                            <th key={k} className="p-1 text-left font-semibold text-gray-200 border-b">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {parsedPreview.sample.slice(0,3).map((r, i) => (
                          <tr key={i} className="align-top border-b">
                            {parsedPreview.headerKeys.map(k => (
                              <td key={k} className="p-1 align-top text-gray-300">
                                <div style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  {(r && r[k]) != null ? String(r[k]) : ''}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs p-2 mt-1 bg-black rounded" style={{maxHeight: 200, overflow: 'auto'}}>
                    {parsedPreview.sample.slice(0,3).map((r, i) => (
                      <div key={i} className="truncate" style={{marginBottom: 6}}>
                        <code style={{
                          color: '#cbd5e1',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'normal'
                        }}>{formatSampleRow(r)}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3 p-2 bg-gray-900 rounded text-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold">Parsed data preview</div>
                  {parsedPreview.sample && parsedPreview.sample.length > 1 && (
                    <div className="text-xs">
                      <label className="mr-2">Sample</label>
                      <select value={previewSampleIndex} onChange={e => setPreviewSampleIndex(Number(e.target.value))} className="p-1 text-xs border rounded bg-gray-800">
                        {parsedPreview.sample.slice(0,10).map((_, i) => (
                          <option key={i} value={i}>#{i+1}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {parsedDataPreview.hasSample ? (
                  <div className="text-xs text-gray-300">
                    <div><strong>ID:</strong> <span className="font-mono">{parsedDataPreview.idVal || '(empty)'}</span></div>
                    <div className="mt-1"><strong>Raw Diagnoses:</strong> <span className="font-mono">{parsedDataPreview.rawDiags.join(' | ') || '(none)'}</span></div>
                    <div className="mt-1"><strong>Parsed Diagnoses:</strong> <span className="font-mono">{parsedDataPreview.convDiags.join(' | ') || '(none)'}</span></div>
                    <div className="mt-2"><strong>Raw Procedures:</strong> <span className="font-mono">{parsedDataPreview.rawProcs.join(' | ') || '(none)'}</span></div>
                    <div className="mt-1"><strong>Parsed Procedures:</strong> <span className="font-mono">{parsedDataPreview.convProcs.join(' | ') || '(none)'}</span></div>
                    {parsedDataPreview.samplePatientInfo && Object.keys(parsedDataPreview.samplePatientInfo).length > 0 && (
                      <div className="mt-2"><strong>Patient Info:</strong> <span className="font-mono">{JSON.stringify(parsedDataPreview.samplePatientInfo)}</span></div>
                    )}
                    <div className="mt-2 text-xs text-gray-400">Delimiters: <span className="font-mono">Diag: {previewDiagDelimiterResolved === '\t' ? '\\t' : previewDiagDelimiterResolved} &nbsp;&nbsp; Proc: {previewProcDelimiterResolved === '\t' ? '\\t' : previewProcDelimiterResolved}</span></div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">No sample rows available</div>
                )}
              </div>

              {/* Load parsed data is now performed automatically when running batch */}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <div className="text-sm">Upload options: parsed rows assume headered CSV/Excel (auto-detect columns)</div>
      </div>

      {/* Batch Log panel removed from UI (logs are still recorded to console) */}

      {(batchData.length > 0 || (parsedPreview && parsedPreview.dataLength > 0 && !parsingInProgress)) && (
        <div className="bg-info p-4 rounded-lg flex justify-between items-center border border-info">
          <span className="font-medium text-info">{batchData.length > 0 ? `${batchData.length} records loaded${parseTimeMs != null ? ` (${parseTimeMs < 1000 ? `${parseTimeMs} ms` : `${(parseTimeMs/1000).toFixed(2)} s`})` : ''}` : `${parsedPreview.dataLength} rows parsed`}</span>
          <button
            onClick={handleGroupBatch}
            className="bg-blue-600 text-white px-6 py-2 rounded-lg font-bold hover:bg-blue-700"
          >
            Run Batch Grouper
          </button>
        </div>
      )}

      {batchResults.length > 0 && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-lg">Results Preview</h3>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 text-success font-bold border border-success bg-success bg-opacity-20 px-4 py-2 rounded-lg hover:bg-opacity-30 transition"
            >
              <Download size={18} /> Download CSV
            </button>
          </div>
          <div className="flex gap-6 items-center text-sm text-gray-300">
            <span>DRG <span className="font-mono font-bold text-blue-400">0000</span>: {batchResultSummary.count0000}</span>
            <span>DRG <span className="font-mono font-bold text-blue-400">*QY</span>: {batchResultSummary.countQY}</span>
            {batchTimeMs != null && (
              <span>Elapsed: <span className="font-mono font-bold text-blue-400">{batchTimeMs < 1000 ? `${batchTimeMs} ms` : `${(batchTimeMs/1000).toFixed(2)} s`}</span></span>
            )}
          </div>
          <div className="overflow-x-auto border dark-border rounded-lg">
            <table className="w-full text-left text-sm">
              <thead className="dark-surface-2 border-b dark-border">
                <tr>
                  <th className="p-3 font-semibold text-gray-200">ID</th>
                  <th className="p-3 font-semibold text-gray-200">DRG</th>
                  <th className="p-3 font-semibold text-gray-200">Description</th>
                </tr>
              </thead>
              <tbody>
                {batchResults.slice(0, 5).map((row, i) => (
                  <tr key={i} className="border-b dark-border last:border-0 hover:bg-info hover:bg-opacity-20 transition">
                    <td className="p-3 text-gray-200">{row.id}</td>
                    <td className="p-3 font-mono text-blue-400">{row.drg || "ERR"}</td>
                    <td className="p-3 text-gray-200">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {batchResults.length > 5 && (
              <div className="p-3 text-center text-gray-400 dark-surface-2 text-xs border-t dark-border">
                Showing 5 of {batchResults.length} records
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default BatchTab;
