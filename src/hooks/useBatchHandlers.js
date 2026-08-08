import { useCallback, useEffect } from 'react';
import Papa from 'papaparse';
import { groupBatchByVersion } from '../services/versionedGrouper';
import { convertGLtoYBCode } from '../services/CodeConversion';
import { preloadGLData } from '../services/glDataLoader';
import { loadParsedFile as svcLoadParsedFile, processBatch as svcProcessBatch } from '../services/batchProcess';
import { DEFAULT_RULE_VERSION } from '../services/generated/versionRegistry.js';

const isVerboseLogging = !!(import.meta.env && import.meta.env.DEV);
const logVerbose = (...args) => {
  if (isVerboseLogging) console.log(...args);
};
const debugVerbose = (...args) => {
  if (isVerboseLogging) console.debug(...args);
};

export function useBatchHandlers({
  searchSource,
  version = DEFAULT_RULE_VERSION,
  uploadedBatchFile,
  parsedPreview,
  parsedRows,
  batchData,
  batchResults,
  previewIdKey,
  previewDiagsKey,
  previewProcsKey,
  workerRef,
  manualPreviewSnapshotRef,
  parseTokenRef,
  batchRunTokenRef,
  failedNormalizationRef,
  setUploadedBatchFile,
  setParsedPreview,
  setParsedRows,
  setBatchData,
  setBatchResults,
  setBatchTimeMs,
  setParseTimeMs,
  setParsingInProgress,
  setParseError,
  setNormMisses,
  setPreviewIdKey,
  setPreviewDiagsKey,
  setPreviewProcsKey,
  setPreviewAgeKey,
  setPreviewAgeDaysKey,
  setPreviewBirthWeightKey,
  setPreviewDischargeKey,
  setPreviewNewTechniqueKey,
  setPreviewMultiSiteKey,
  setPreviewGenderKey,
  setDiagDelimiterOption,
  setDiagCustomDelimiter,
  setProcDelimiterOption,
  setProcCustomDelimiter,
  setBatchDelimiterOption,
  setBatchCustomDelimiter,
  clearNormalizationMisses,
  invalidateBatchState,
  resetPreviewMappings,
  getMappingKeys,
  detectDelimiterForColumn,
  cleanCell,
  normalizeEntriesNoUI,
  buildNormMissesArray,
  batchDelimiterOption,
  batchCustomDelimiter,
  diagDelimiterOption,
  diagCustomDelimiter,
  procDelimiterOption,
  procCustomDelimiter,
}) {
  const stopParseWorker = useCallback((updateProgress = true) => {
    parseTokenRef.current = (parseTokenRef.current || 0) + 1;
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try { worker.terminate(); } catch {
        // A worker may already have terminated after posting its result.
      }
    }
    if (updateProgress) setParsingInProgress(false);
  }, [parseTokenRef, workerRef, setParsingInProgress]);

  useEffect(() => () => {
    // Never allow a worker callback to update state after the app unmounts.
    stopParseWorker(false);
  }, [stopParseWorker]);

  const handleParseUploadedFile = useCallback(async (fileParam) => {
    const file = fileParam || uploadedBatchFile;
    if (!file) return;

    stopParseWorker(false);
    const currentParseToken = parseTokenRef.current;
    try {
      setParsingInProgress(true);
      setParseError(null);
      logVerbose(`${new Date().toISOString()} - Starting parse in worker: ${file.name}`);

      try {
        failedNormalizationRef.current = new Map();
        setNormMisses([]);
        logVerbose(`${new Date().toISOString()} - Cleared previous normalization misses for new parse`);
      } catch {
        // ignore reset issues
      }

      manualPreviewSnapshotRef.current = null;
      resetPreviewMappings();
      logVerbose(`${new Date().toISOString()} - Cleared preview mapping keys for new parse`);

      const ab = await file.arrayBuffer();
      if (currentParseToken !== parseTokenRef.current) return;
      const name = (file.name || '').toLowerCase();
      const isExcel = name.endsWith('.xls') || name.endsWith('.xlsx');

      workerRef.current = new Worker(new URL('../workers/parseWorker.js', import.meta.url), { type: 'module' });
      const worker = workerRef.current;
      const finishWorker = () => {
        if (workerRef.current === worker) workerRef.current = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try { worker.terminate(); } catch {
          // The worker may already be stopped by the browser.
        }
      };
      const failParse = (message) => {
        if (currentParseToken !== parseTokenRef.current) return;
        setParsedRows(null);
        setParsedPreview(null);
        setParseError(message || 'Unable to parse the uploaded file.');
        setParsingInProgress(false);
        finishWorker();
      };
      worker.onmessage = (ev) => {
        if (currentParseToken !== parseTokenRef.current) {
          console.warn('[parse] Ignoring stale worker message for token', currentParseToken);
          finishWorker();
          return;
        }

        const msg = ev.data || {};
        if (msg.success) {
          const data = msg.data || [];
          const sample = msg.sample || [];
          const safeData = Array.isArray(data) ? data : [];
          const safeSample = Array.isArray(sample) ? sample : [];
          const headerKeys = (safeData && safeData.length > 0 && typeof safeData[0] === 'object') ? Object.keys(safeData[0]) : null;
          setParsedRows(safeData);
          setParsedPreview({ meta: msg.meta || {}, sample: safeSample, dataLength: safeData.length, headerKeys });

          const _fmtKey = (v) => (Array.isArray(v) ? v.join(',') : (v || '(empty)'));
          debugVerbose(`${new Date().toISOString()} - DEBUG parse token ${currentParseToken} headerKeys=${headerKeys ? headerKeys.join('|') : '(none)'} previewState=${_fmtKey(previewIdKey)}|${_fmtKey(previewDiagsKey)}|${_fmtKey(previewProcsKey)} (${file.name})`);

          if (headerKeys && sample && sample.length > 0) {
            try {
              const s = sample[0] || {};
              const {
                idKey: guessedId,
                diagsKey: guessedDiags,
                procsKey: guessedProcs,
                ageKey: guessedAge,
                ageDaysKey: guessedAgeDays,
                bwKey: guessedBirthWeight,
                dischargeKey: guessedDischarge,
                newTechKey: guessedNewTechnique,
                multiSiteKey: guessedMultiSite,
                genderKey: guessedGender,
              } = getMappingKeys(s);

              setPreviewIdKey(prev => (prev && prev.length) ? prev : guessedId);
              setPreviewDiagsKey(prev => (prev && prev.length) ? prev : (guessedDiags ? (Array.isArray(guessedDiags) ? guessedDiags : [guessedDiags]) : []));
              setPreviewProcsKey(prev => (prev && prev.length) ? prev : (guessedProcs ? (Array.isArray(guessedProcs) ? guessedProcs : [guessedProcs]) : []));
              setPreviewAgeKey(prev => (prev && prev.length) ? prev : guessedAge);
              setPreviewAgeDaysKey(prev => (prev && prev.length) ? prev : guessedAgeDays);
              setPreviewBirthWeightKey(prev => (prev && prev.length) ? prev : guessedBirthWeight);
              setPreviewDischargeKey(prev => (prev && prev.length) ? prev : guessedDischarge);
              setPreviewNewTechniqueKey(prev => (prev && prev.length) ? prev : guessedNewTechnique);
              setPreviewMultiSiteKey(prev => (prev && prev.length) ? prev : guessedMultiSite);
              setPreviewGenderKey(prev => (prev && prev.length) ? prev : guessedGender);

              try {
                const sampleRows = safeSample || [];
                const diagCol = (Array.isArray(guessedDiags) ? guessedDiags[0] : guessedDiags) || (Array.isArray(previewDiagsKey) ? previewDiagsKey[0] : previewDiagsKey);
                const procCol = (Array.isArray(guessedProcs) ? guessedProcs[0] : guessedProcs) || (Array.isArray(previewProcsKey) ? previewProcsKey[0] : previewProcsKey);
                const diagDetected = diagCol ? detectDelimiterForColumn(sampleRows, diagCol) : null;
                const procDetected = procCol ? detectDelimiterForColumn(sampleRows, procCol) : null;

                const applyDetected = (detected, setterOpt, setterCustom) => {
                  if (!detected) return;
                  if (detected === '|') setterOpt('PIPE');
                  else if (detected === ',') setterOpt('COMMA');
                  else if (detected === ';') setterOpt('SEMICOLON');
                  else if (detected === '\t') setterOpt('TAB');
                  else if (detected === '+') setterOpt('PLUS');
                  else { setterOpt('CUSTOM'); setterCustom(detected); }
                };

                if (diagDetected) {
                  applyDetected(diagDetected, setDiagDelimiterOption, setDiagCustomDelimiter);
                  applyDetected(diagDetected, setBatchDelimiterOption, setBatchCustomDelimiter);
                  logVerbose(`${new Date().toISOString()} - Auto-detected diag delimiter: ${diagDetected}`);
                }
                if (procDetected) {
                  applyDetected(procDetected, setProcDelimiterOption, setProcCustomDelimiter);
                  if (!diagDetected) applyDetected(procDetected, setBatchDelimiterOption, setBatchCustomDelimiter);
                  logVerbose(`${new Date().toISOString()} - Auto-detected proc delimiter: ${procDetected}`);
                }
              } catch {
                // ignore delimiter auto-detect failures
              }

              logVerbose(`${new Date().toISOString()} - Auto-mapped columns: id=${guessedId || '(none)'} diags=${guessedDiags || '(none)'} procs=${guessedProcs || '(none)'} newtech=${guessedNewTechnique || '(none)'} (${file.name})`);
            } catch {
              // ignore auto-map failures
            }
          }

          logVerbose(`${new Date().toISOString()} - Worker parse complete: ${file.name} (${data.length} rows)`);
        } else {
          const message = msg.error || 'Unable to parse the uploaded file.';
          console.error(`${new Date().toISOString()} - Worker parse ERROR: ${message}`);
          failParse(message);
          return;
        }
        setParsingInProgress(false);
        finishWorker();
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        failParse(event.message || 'The file parser worker failed.');
      };
      worker.onmessageerror = () => {
        failParse('The parsed file result could not be transferred from the worker.');
      };

      worker.postMessage({ action: 'parse', name: file.name, buffer: ab, isExcel, header: true }, [ab]);
      logVerbose(`${new Date().toISOString()} - Parsing assuming header row present`);
    } catch (err) {
      if (currentParseToken !== parseTokenRef.current) return;
      const message = err && err.message ? err.message : String(err);
      setParsingInProgress(false);
      setParsedRows(null);
      setParsedPreview(null);
      setParseError(message);
      stopParseWorker(false);
      console.error(`${new Date().toISOString()} - ERROR starting worker parse: ${message}`);
    }
  }, [
    uploadedBatchFile,
    stopParseWorker,
    setParsingInProgress,
    setParseError,
    failedNormalizationRef,
    setNormMisses,
    parseTokenRef,
    manualPreviewSnapshotRef,
    resetPreviewMappings,
    setPreviewIdKey,
    setPreviewDiagsKey,
    setPreviewProcsKey,
    setPreviewAgeKey,
    setPreviewAgeDaysKey,
    setPreviewBirthWeightKey,
    setPreviewDischargeKey,
    setPreviewNewTechniqueKey,
    setPreviewMultiSiteKey,
    setPreviewGenderKey,
    workerRef,
    setParsedRows,
    setParsedPreview,
    previewIdKey,
    previewDiagsKey,
    previewProcsKey,
    getMappingKeys,
    detectDelimiterForColumn,
    setDiagDelimiterOption,
    setDiagCustomDelimiter,
    setBatchDelimiterOption,
    setBatchCustomDelimiter,
    setProcDelimiterOption,
    setProcCustomDelimiter,
  ]);

  const handleFileUpload = useCallback(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    invalidateBatchState();
    setParseError(null);
    setUploadedBatchFile(file);
    setParsedPreview(null);
    setParsedRows(null);
    logVerbose(`${new Date().toISOString()} - Uploaded file received: ${file.name}`);
    handleParseUploadedFile(file);
  }, [
    setUploadedBatchFile,
    invalidateBatchState,
    setParseError,
    setParsedPreview,
    setParsedRows,
    handleParseUploadedFile,
  ]);

  const handleRemoveFile = useCallback(() => {
    stopParseWorker();
    invalidateBatchState();
    setUploadedBatchFile(null);
    setParsedPreview(null);
    setParsedRows(null);
    setParseError(null);
    manualPreviewSnapshotRef.current = null;
    resetPreviewMappings();
    clearNormalizationMisses();
  }, [
    stopParseWorker,
    invalidateBatchState,
    setUploadedBatchFile,
    setParsedPreview,
    setParsedRows,
    setParseError,
    manualPreviewSnapshotRef,
    resetPreviewMappings,
    clearNormalizationMisses,
  ]);

  const handleLoadParsedFile = useCallback(() => {
    if (!Array.isArray(parsedRows) || parsedRows.length === 0) return;
    setParseTimeMs(null);

    try { clearNormalizationMisses(); } catch {
      // ignore clear failures
    }

    const opts = {
      delimiterOption: batchDelimiterOption,
      customDelimiter: batchCustomDelimiter,
      diagDelimiterOption,
      diagCustomDelimiter,
      procDelimiterOption,
      procCustomDelimiter,
      uploadedBatchFileName: uploadedBatchFile ? uploadedBatchFile.name : 'file',
      getMappingKeys,
      cleanCell,
      normalizeEntries: normalizeEntriesNoUI,
    };

    try {
      const { normalized, timeMs } = svcLoadParsedFile(parsedRows, opts);
      setBatchData(normalized);
      try { setNormMisses(buildNormMissesArray()); } catch {
        // ignore misses refresh failures
      }
      if (typeof timeMs === 'number') setParseTimeMs(timeMs);
      logVerbose(`${new Date().toISOString()} - Loaded ${normalized ? normalized.length : 0} records from uploaded file in ${typeof timeMs === 'number' ? `${timeMs} ms` : 'unknown time'}`);
      return normalized;
    } catch (e) {
      console.error(`${new Date().toISOString()} - ERROR loading parsed file: ${String(e)}`);
      return null;
    }
  }, [
    parsedRows,
    setParseTimeMs,
    clearNormalizationMisses,
    batchDelimiterOption,
    batchCustomDelimiter,
    diagDelimiterOption,
    diagCustomDelimiter,
    procDelimiterOption,
    procCustomDelimiter,
    uploadedBatchFile,
    getMappingKeys,
    cleanCell,
    normalizeEntriesNoUI,
    setBatchData,
    setNormMisses,
    buildNormMissesArray,
  ]);

  const handleGroupBatch = useCallback(async () => {
    const currentBatchToken = batchRunTokenRef.current;
    if (searchSource === 'GL') await preloadGLData(version);
    if (currentBatchToken !== batchRunTokenRef.current) return;
    const loaded = handleLoadParsedFile();
    const rows = Array.isArray(loaded) ? loaded : batchData;

    setBatchResults([]);
    setBatchTimeMs(null);
    if (!rows.length) return;
    logVerbose(`${new Date().toISOString()} - Starting batch processing (${rows.length} records)`);

    try {
      const { results, timeMs } = await svcProcessBatch(rows, { groupBatch: (items) => groupBatchByVersion(items, version), convertGLtoYBCode: (code, isProcedure) => convertGLtoYBCode(code, isProcedure, version), searchSource });
      if (currentBatchToken !== batchRunTokenRef.current) return;
      if (Array.isArray(results)) setBatchResults(results);
      if (typeof timeMs === 'number') setBatchTimeMs(timeMs);
      logVerbose(`${new Date().toISOString()} - Batch processed ${results ? results.length : 0} records in ${typeof timeMs === 'number' ? `${timeMs} ms` : 'unknown time'}`);
    } catch (e) {
      console.error(`${new Date().toISOString()} - ERROR during batch processing: ${String(e)}`);
    }
  }, [handleLoadParsedFile, batchData, batchRunTokenRef, setBatchResults, setBatchTimeMs, searchSource, version]);

  const handleDownload = useCallback(() => {
    const conversionApplied = (searchSource === 'GL');
    try {
      if (parsedPreview && parsedRows && Array.isArray(parsedRows) && batchResults && batchResults.length) {
        const resMap = new Map();
        for (const r of batchResults) resMap.set(String(r.id), r);

        const outData = parsedRows.map((row, idx) => {
          const batchRow = (Array.isArray(batchData) && batchData[idx]) ? batchData[idx] : null;
          const idKeyCandidates = ['id', 'caseid', 'case_id', 'identifier', '编号', '序号', 'patient_id', 'patid', '病案号', '住院号'];
          const keys = Object.keys(row || {});
          const idKey = keys.find(k => idKeyCandidates.includes(String(k).toLowerCase())) || keys[0];
          const rawIdVal = row && idKey ? String(row[idKey]) : '';
          const idVal = batchRow && batchRow.id ? String(batchRow.id) : (rawIdVal || `${uploadedBatchFile ? uploadedBatchFile.name : 'file'}-${idx + 1}`);
          const resultRow = resMap.get(String(idVal)) || {};

          const outRow = {};
          if (idKey) outRow[idKey] = row[idKey];
          outRow.drg = resultRow.drg || '';
          outRow.description = resultRow.description || '';
          outRow.weight = (resultRow && resultRow.weight === '/')
            ? '特殊支付'
            : ((resultRow && resultRow.weight !== undefined && resultRow.weight !== null) ? String(resultRow.weight) : '');
          // include tier‑2 hospital weight if available
          if (resultRow && resultRow.weightTier2 !== undefined) {
            outRow.weightTier2 = (resultRow.weightTier2 === '/')
              ? '特殊支付'
              : ((resultRow.weightTier2 !== null) ? String(resultRow.weightTier2) : '');
          }

          if (conversionApplied) {
            outRow.original_diagnoses = (resultRow.original_diagnoses && resultRow.original_diagnoses.join) ? resultRow.original_diagnoses.join('|') : '';
            outRow.converted_diagnoses = (resultRow.diagnoses && resultRow.diagnoses.join) ? resultRow.diagnoses.join('|') : '';
            outRow.original_procedures = (resultRow.original_procedures && resultRow.original_procedures.join) ? resultRow.original_procedures.join('|') : '';
            outRow.converted_procedures = (resultRow.procedures && resultRow.procedures.join) ? resultRow.procedures.join('|') : '';
          } else {
            outRow.original_diagnoses = (resultRow.diagnoses && resultRow.diagnoses.join) ? resultRow.diagnoses.join('|') : '';
            outRow.converted_diagnoses = '';
            outRow.original_procedures = (resultRow.procedures && resultRow.procedures.join) ? resultRow.procedures.join('|') : '';
            outRow.converted_procedures = '';
          }

          for (const k of keys) {
            if (k === idKey) continue;
            outRow[k] = row[k];
          }
          return outRow;
        });

        const csv = Papa.unparse(outData);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const base = uploadedBatchFile ? uploadedBatchFile.name.replace(/\.[^.]+$/, '') : 'results';
        link.setAttribute('download', `${base}-with-results.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return;
      }
    } catch (e) {
      console.warn('Failed to append results to original file:', e);
    }

    const csv = Papa.unparse(
      batchResults.map((r) => ({
        id: r.id,
        drg: r.drg,
        description: r.description,
        weight: (r && r.weight === '/') ? '特殊支付' : ((r && r.weight !== undefined && r.weight !== null) ? String(r.weight) : ''),
        weightTier2: (r && r.weightTier2 === '/') ? '特殊支付' : ((r && r.weightTier2 !== undefined && r.weightTier2 !== null) ? String(r.weightTier2) : ''),
        ...(conversionApplied ? {
          original_diagnoses: r.original_diagnoses ? r.original_diagnoses.join('|') : '',
          original_procedures: r.original_procedures ? r.original_procedures.join('|') : '',
          converted_diagnoses: r.diagnoses.join('|'),
          converted_procedures: r.procedures.join('|'),
        } : {
          diagnoses: r.diagnoses.join('|'),
          procedures: r.procedures.join('|'),
        }),
      }))
    );

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'drg_results.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [searchSource, parsedPreview, parsedRows, batchResults, uploadedBatchFile, batchData]);

  return {
    handleFileUpload,
    handleRemoveFile,
    handleParseUploadedFile,
    handleLoadParsedFile,
    handleGroupBatch,
    handleDownload,
  };
}
