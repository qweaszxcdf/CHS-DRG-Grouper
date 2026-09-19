import { useCallback, useEffect } from 'react';
import type { ChangeEvent, Dispatch, MutableRefObject, SetStateAction } from 'react';
import Papa from 'papaparse';
import { groupBatchByVersion } from '../services/versionedGrouper.ts';
import { convertGLtoYBCode } from '../services/CodeConversion';
import { preloadGLData } from '../services/glDataLoader';
import {
  type BatchDelimiterOption,
  getDelimiterOptionForChar,
  loadParsedFile as svcLoadParsedFile,
  processBatch as svcProcessBatch,
} from '../services/batchProcess.ts';
import {
  BATCH_ID_FIELD_ALIASES,
  type UseBatchMappingHelpersResult,
} from './useBatchMappingHelpers.ts';
import { DEFAULT_RULE_VERSION } from '../services/generated/versionRegistry.ts';
import type {
  BatchInputFormat,
  BatchRawRow,
  NormalizationMiss,
  NormalizationMissView,
  NormalizedBatchRow,
  ParsedBatchPreview,
} from '../types/batch.ts';
import type { BatchGroupingResult } from '../types/grouper.ts';

const isVerboseLogging = !!(import.meta.env as ImportMetaEnv | undefined)?.DEV;
const logVerbose = (...args: unknown[]): void => {
  if (isVerboseLogging) console.log(...args);
};
const debugVerbose = (...args: unknown[]): void => {
  if (isVerboseLogging) console.debug(...args);
};

function formatWeight(value: unknown): string {
  if (value === '/') return '特殊支付';
  return value == null ? '' : String(value);
}

function joinCodes(codes: unknown): string {
  return Array.isArray(codes) ? codes.map(value => String(value)).join('|') : '';
}

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

interface ParseWorkerMessage {
  success?: boolean;
  name?: string;
  meta?: Record<string, unknown>;
  data?: unknown;
  sample?: unknown;
  error?: string;
}

export interface UseBatchHandlersOptions {
  searchSource: string;
  batchFormat?: BatchInputFormat;
  version?: string;
  uploadedBatchFile: File | null;
  parsedRows: BatchRawRow[] | null;
  batchData: NormalizedBatchRow[];
  batchResults: BatchGroupingResult[];
  previewIdKey: string;
  previewDiagsKey: string[];
  previewProcsKey: string[];
  workerRef: MutableRefObject<Worker | null>;
  manualPreviewSnapshotRef: MutableRefObject<unknown>;
  parseTokenRef: MutableRefObject<number>;
  batchRunTokenRef: MutableRefObject<number>;
  failedNormalizationRef: MutableRefObject<Map<string, NormalizationMiss>>;
  setUploadedBatchFile: Dispatch<SetStateAction<File | null>>;
  setParsedPreview: Dispatch<SetStateAction<ParsedBatchPreview | null>>;
  setParsedRows: Dispatch<SetStateAction<BatchRawRow[] | null>>;
  setBatchData: Dispatch<SetStateAction<NormalizedBatchRow[]>>;
  setBatchResults: Dispatch<SetStateAction<BatchGroupingResult[]>>;
  setBatchTimeMs: Dispatch<SetStateAction<number | null>>;
  setParseTimeMs: Dispatch<SetStateAction<number | null>>;
  setParsingInProgress: Dispatch<SetStateAction<boolean>>;
  setParseError: Dispatch<SetStateAction<string | null>>;
  setNormMisses: Dispatch<SetStateAction<NormalizationMissView[]>>;
  setPreviewIdKey: Dispatch<SetStateAction<string>>;
  setPreviewDiagsKey: Dispatch<SetStateAction<string[]>>;
  setPreviewProcsKey: Dispatch<SetStateAction<string[]>>;
  setPreviewAgeKey: Dispatch<SetStateAction<string>>;
  setPreviewAgeDaysKey: Dispatch<SetStateAction<string>>;
  setPreviewBirthWeightKey: Dispatch<SetStateAction<string>>;
  setPreviewAdmissionWeightKey: Dispatch<SetStateAction<string>>;
  setPreviewDischargeKey: Dispatch<SetStateAction<string>>;
  setPreviewNewTechniqueKey: Dispatch<SetStateAction<string>>;
  setPreviewIntensiveCareKey: Dispatch<SetStateAction<string>>;
  setPreviewIcuHoursKey: Dispatch<SetStateAction<string>>;
  setPreviewCrrtHoursKey: Dispatch<SetStateAction<string>>;
  setPreviewLengthOfStayKey: Dispatch<SetStateAction<string>>;
  setPreviewDaySurgeryKey: Dispatch<SetStateAction<string>>;
  setPreviewGenderKey: Dispatch<SetStateAction<string>>;
  setDiagDelimiterOption: Dispatch<SetStateAction<BatchDelimiterOption>>;
  setDiagCustomDelimiter: Dispatch<SetStateAction<string>>;
  setProcDelimiterOption: Dispatch<SetStateAction<BatchDelimiterOption>>;
  setProcCustomDelimiter: Dispatch<SetStateAction<string>>;
  setBatchDelimiterOption: Dispatch<SetStateAction<BatchDelimiterOption>>;
  setBatchCustomDelimiter: Dispatch<SetStateAction<string>>;
  clearNormalizationMisses: () => void;
  invalidateBatchState: () => void;
  resetPreviewMappings: () => void;
  getMappingKeys: UseBatchMappingHelpersResult['getMappingKeys'];
  detectDelimiterForColumn: UseBatchMappingHelpersResult['detectDelimiterForColumn'];
  cleanCell: UseBatchMappingHelpersResult['cleanCell'];
  normalizeEntriesNoUI: UseBatchMappingHelpersResult['normalizeEntriesNoUI'];
  buildNormMissesArray: UseBatchMappingHelpersResult['buildNormMissesArray'];
  batchDelimiterOption: BatchDelimiterOption;
  batchCustomDelimiter: string;
  diagDelimiterOption: BatchDelimiterOption;
  diagCustomDelimiter: string;
  procDelimiterOption: BatchDelimiterOption;
  procCustomDelimiter: string;
}

export interface UseBatchHandlersResult {
  handleFileUpload: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRemoveFile: () => void;
  handleParseUploadedFile: (file?: File) => Promise<void>;
  handleLoadParsedFile: () => NormalizedBatchRow[] | null | undefined;
  handleGroupBatch: () => Promise<void>;
  handleDownload: () => void;
}

export function useBatchHandlers({
  searchSource,
  batchFormat = 'MANUAL',
  version = DEFAULT_RULE_VERSION,
  uploadedBatchFile,
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
  setPreviewAdmissionWeightKey,
  setPreviewDischargeKey,
  setPreviewNewTechniqueKey,
  setPreviewIntensiveCareKey,
  setPreviewIcuHoursKey,
  setPreviewCrrtHoursKey,
  setPreviewLengthOfStayKey,
  setPreviewDaySurgeryKey,
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
}: UseBatchHandlersOptions): UseBatchHandlersResult {
  const stopParseWorker = useCallback((updateProgress = true): void => {
    parseTokenRef.current += 1;
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

  const handleParseUploadedFile = useCallback(async (fileParam?: File): Promise<void> => {
    const file = fileParam || uploadedBatchFile;
    if (!file) return;

    stopParseWorker(false);
    const currentParseToken = parseTokenRef.current;
    try {
      setParsingInProgress(true);
      setParseError(null);
      logVerbose(`${new Date().toISOString()} - Starting parse in worker: ${file.name}`);

      failedNormalizationRef.current = new Map();
      setNormMisses([]);
      logVerbose(`${new Date().toISOString()} - Cleared previous normalization misses for new parse`);

      manualPreviewSnapshotRef.current = null;
      resetPreviewMappings();
      logVerbose(`${new Date().toISOString()} - Cleared preview mapping keys for new parse`);

      const ab = await file.arrayBuffer();
      if (currentParseToken !== parseTokenRef.current) return;
      const name = file.name.toLowerCase();
      const isExcel = name.endsWith('.xls') || name.endsWith('.xlsx');

      const worker = new Worker(new URL('../workers/parseWorker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      const finishWorker = () => {
        if (workerRef.current === worker) workerRef.current = null;
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        try { worker.terminate(); } catch {
          // The worker may already be stopped by the browser.
        }
      };
      const failParse = (message: string): void => {
        if (currentParseToken !== parseTokenRef.current) return;
        setParsedRows(null);
        setParsedPreview(null);
        setParseError(message || 'Unable to parse the uploaded file.');
        setParsingInProgress(false);
        finishWorker();
      };
      worker.onmessage = (ev: MessageEvent<unknown>): void => {
        if (currentParseToken !== parseTokenRef.current) {
          console.warn('[parse] Ignoring stale worker message for token', currentParseToken);
          finishWorker();
          return;
        }

        const msg = ev.data && typeof ev.data === 'object'
          ? ev.data as ParseWorkerMessage
          : {};
        if (msg.success) {
          const data = msg.data;
          const sample = msg.sample;
          const safeData = Array.isArray(data) ? data as BatchRawRow[] : [];
          const safeSample = Array.isArray(sample) ? sample as BatchRawRow[] : [];
          const headerKeys = safeData.length > 0 && typeof safeData[0] === 'object' ? Object.keys(safeData[0]) : null;
          setParsedRows(safeData);
          setParsedPreview({ meta: msg.meta || {}, sample: safeSample, dataLength: safeData.length, headerKeys });

          const _fmtKey = (v: unknown): string => (Array.isArray(v) ? v.join(',') : (v || '(empty)') as string);
          debugVerbose(`${new Date().toISOString()} - DEBUG parse token ${currentParseToken} headerKeys=${headerKeys ? headerKeys.join('|') : '(none)'} previewState=${_fmtKey(previewIdKey)}|${_fmtKey(previewDiagsKey)}|${_fmtKey(previewProcsKey)} (${file.name})`);

          if (batchFormat === 'MANUAL' && headerKeys && safeSample.length > 0) {
            try {
              const s = safeSample[0]!;
              const {
                idKey: guessedId,
                diagsKey: guessedDiags,
                procsKey: guessedProcs,
                ageKey: guessedAge,
                ageDaysKey: guessedAgeDays,
                bwKey: guessedBirthWeight,
                admissionWeightKey: guessedAdmissionWeight,
                dischargeKey: guessedDischarge,
                newTechKey: guessedNewTechnique,
                intensiveCareKey: guessedIntensiveCare,
                icuHoursKey: guessedIcuHours,
                crrtHoursKey: guessedCrrtHours,
                lengthOfStayKey: guessedLengthOfStay,
                daySurgeryKey: guessedDaySurgery,
                genderKey: guessedGender,
              } = getMappingKeys(s);

              setPreviewIdKey(prev => prev.length ? prev : guessedId);
              setPreviewDiagsKey(prev => prev.length ? prev : (guessedDiags ?? []));
              setPreviewProcsKey(prev => prev.length ? prev : (guessedProcs ?? []));
              setPreviewAgeKey(prev => prev.length ? prev : guessedAge);
              setPreviewAgeDaysKey(prev => prev.length ? prev : guessedAgeDays);
              setPreviewBirthWeightKey(prev => prev.length ? prev : guessedBirthWeight);
              setPreviewAdmissionWeightKey(prev => prev.length ? prev : guessedAdmissionWeight);
              setPreviewDischargeKey(prev => prev.length ? prev : guessedDischarge);
              setPreviewNewTechniqueKey(prev => prev.length ? prev : guessedNewTechnique);
              setPreviewIntensiveCareKey(prev => prev.length ? prev : guessedIntensiveCare);
              setPreviewIcuHoursKey(prev => prev.length ? prev : guessedIcuHours);
              setPreviewCrrtHoursKey(prev => prev.length ? prev : guessedCrrtHours);
              setPreviewLengthOfStayKey(prev => prev.length ? prev : guessedLengthOfStay);
              setPreviewDaySurgeryKey(prev => prev.length ? prev : guessedDaySurgery);
              setPreviewGenderKey(prev => prev.length ? prev : guessedGender);

              try {
                const sampleRows = safeSample;
                const diagCol = guessedDiags?.[0] || previewDiagsKey[0];
                const procCol = guessedProcs?.[0] || previewProcsKey[0];
                const diagDetected = diagCol ? detectDelimiterForColumn(sampleRows, diagCol) : null;
                const procDetected = procCol ? detectDelimiterForColumn(sampleRows, procCol) : null;

                const applyDetected = (
                  detected: string,
                  setterOpt: Dispatch<SetStateAction<BatchDelimiterOption>>,
                  setterCustom: Dispatch<SetStateAction<string>>,
                ): void => {
                  const option = getDelimiterOptionForChar(detected);
                  setterOpt(option);
                  if (option === 'CUSTOM') setterCustom(detected);
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

              logVerbose(`${new Date().toISOString()} - Auto-mapped columns: id=${guessedId || '(none)'} diags=${guessedDiags || '(none)'} procs=${guessedProcs || '(none)'} newtech=${guessedNewTechnique || '(none)'} intensivecare=${guessedIntensiveCare || '(none)'} (${file.name})`);
            } catch {
              // ignore auto-map failures
            }
          }

          logVerbose(`${new Date().toISOString()} - Worker parse complete: ${file.name} (${safeData.length} rows)`);
        } else {
          const message = msg.error || 'Unable to parse the uploaded file.';
          console.error(`${new Date().toISOString()} - Worker parse ERROR: ${message}`);
          failParse(message);
          return;
        }
        setParsingInProgress(false);
        finishWorker();
      };
      worker.onerror = (event: ErrorEvent): void => {
        event.preventDefault();
        failParse(event.message || 'The file parser worker failed.');
      };
      worker.onmessageerror = (): void => {
        failParse('The parsed file result could not be transferred from the worker.');
      };

      worker.postMessage({ action: 'parse', name: file.name, buffer: ab, isExcel, header: true }, [ab]);
      logVerbose(`${new Date().toISOString()} - Parsing assuming header row present`);
    } catch (err: unknown) {
      if (currentParseToken !== parseTokenRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setParsingInProgress(false);
      setParsedRows(null);
      setParsedPreview(null);
      setParseError(message);
      stopParseWorker(false);
      console.error(`${new Date().toISOString()} - ERROR starting worker parse: ${message}`);
    }
  }, [
    uploadedBatchFile,
    batchFormat,
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
    setPreviewAdmissionWeightKey,
    setPreviewDischargeKey,
    setPreviewNewTechniqueKey,
    setPreviewIntensiveCareKey,
    setPreviewIcuHoursKey,
    setPreviewCrrtHoursKey,
    setPreviewLengthOfStayKey,
    setPreviewDaySurgeryKey,
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

  const handleFileUpload = useCallback(async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.currentTarget.files?.[0];
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

  const handleLoadParsedFile = useCallback((): NormalizedBatchRow[] | null | undefined => {
    if (!parsedRows || parsedRows.length === 0) return;
    setParseTimeMs(null);

    clearNormalizationMisses();

    const opts = {
      delimiterOption: batchDelimiterOption,
      format: batchFormat,
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
      setParseError(null);
      setBatchData(normalized);
      setNormMisses(buildNormMissesArray());
      if (typeof timeMs === 'number') setParseTimeMs(timeMs);
      logVerbose(`${new Date().toISOString()} - Loaded ${normalized.length} records from uploaded file in ${typeof timeMs === 'number' ? `${timeMs} ms` : 'unknown time'}`);
      return normalized;
    } catch (e: unknown) {
      setParseError(e instanceof Error ? e.message : String(e));
      setBatchData([]);
      console.error(`${new Date().toISOString()} - ERROR loading parsed file: ${String(e)}`);
      return null;
    }
  }, [
    parsedRows,
    batchFormat,
    setParseError,
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

  const handleGroupBatch = useCallback(async (): Promise<void> => {
    const currentBatchToken = batchRunTokenRef.current;
    if (searchSource === 'GL') await preloadGLData(version);
    if (currentBatchToken !== batchRunTokenRef.current) return;
    const loaded = handleLoadParsedFile();
    if (loaded === null) return;
    const rows = loaded ?? batchData;

    setBatchResults([]);
    setBatchTimeMs(null);
    if (!rows.length) return;
    logVerbose(`${new Date().toISOString()} - Starting batch processing (${rows.length} records)`);

    try {
      const { results, timeMs } = await svcProcessBatch(rows, { groupBatch: (items) => groupBatchByVersion(items, version), convertGLtoYBCode: (code, isProcedure) => convertGLtoYBCode(code, isProcedure, version), searchSource });
      if (currentBatchToken !== batchRunTokenRef.current) return;
      setBatchResults(results as BatchGroupingResult[]);
      if (typeof timeMs === 'number') setBatchTimeMs(timeMs);
      logVerbose(`${new Date().toISOString()} - Batch processed ${results.length} records in ${typeof timeMs === 'number' ? `${timeMs} ms` : 'unknown time'}`);
    } catch (e: unknown) {
      console.error(`${new Date().toISOString()} - ERROR during batch processing: ${String(e)}`);
    }
  }, [handleLoadParsedFile, batchData, batchRunTokenRef, setBatchResults, setBatchTimeMs, searchSource, version]);

  const handleDownload = useCallback((): void => {
    const conversionApplied = (searchSource === 'GL');
    try {
      if (parsedRows && batchResults.length) {
        const resMap = new Map<string, BatchGroupingResult>();
        for (const r of batchResults) resMap.set(String(r.id), r);

        const outData = parsedRows.map((row, idx): Record<string, unknown> => {
          const batchRow = batchData[idx] || null;
          const idKeyCandidates = BATCH_ID_FIELD_ALIASES;
          const keys = Object.keys(row);
          const idKey = keys.find(k => idKeyCandidates.includes(k.toLowerCase())) || keys[0];
          const rawIdVal = idKey ? String(row[idKey]) : '';
          const idVal = batchRow && batchRow.id ? String(batchRow.id) : (rawIdVal || `${uploadedBatchFile ? uploadedBatchFile.name : 'file'}-${idx + 1}`);
          const resultRow = resMap.get(String(idVal));

          const outRow: Record<string, unknown> = {};
          if (idKey) outRow[idKey] = row[idKey];
          outRow.drg = resultRow?.drg || '';
          outRow.description = resultRow?.description || '';
          outRow.weight = formatWeight(resultRow?.weight);
          // include tier‑2 hospital weight if available
          if (resultRow && resultRow.weightTier2 !== undefined) {
            outRow.weightTier2 = formatWeight(resultRow.weightTier2);
          }

          if (conversionApplied) {
            outRow.original_diagnoses = joinCodes(resultRow?.original_diagnoses);
            outRow.converted_diagnoses = joinCodes(resultRow?.diagnoses);
            outRow.original_procedures = joinCodes(resultRow?.original_procedures);
            outRow.converted_procedures = joinCodes(resultRow?.procedures);
          } else {
            outRow.original_diagnoses = joinCodes(resultRow?.original_diagnoses ?? resultRow?.diagnoses);
            outRow.converted_diagnoses = '';
            outRow.original_procedures = joinCodes(resultRow?.procedures);
            outRow.converted_procedures = '';
          }

          for (const k of keys) {
            if (k === idKey) continue;
            outRow[k] = row[k];
          }
          return outRow;
        });

        const csv = Papa.unparse(outData);
        const base = uploadedBatchFile ? uploadedBatchFile.name.replace(/\.[^.]+$/, '') : 'results';
        downloadCsv(csv, `${base}-with-results.csv`);
        return;
      }
    } catch (e: unknown) {
      console.warn('Failed to append results to original file:', e);
    }

    const csv = Papa.unparse(
      batchResults.map((r) => ({
        id: r.id,
        drg: r.drg,
        description: r.description,
        weight: formatWeight(r.weight),
        weightTier2: formatWeight(r.weightTier2),
        ...(conversionApplied ? {
          original_diagnoses: joinCodes(r.original_diagnoses),
          original_procedures: joinCodes(r.original_procedures),
          converted_diagnoses: joinCodes(r.diagnoses),
          converted_procedures: joinCodes(r.procedures),
        } : {
          diagnoses: joinCodes(r.original_diagnoses ?? r.diagnoses),
          procedures: joinCodes(r.procedures),
        }),
      }))
    );

    downloadCsv(csv, 'drg_results.csv');
  }, [searchSource, parsedRows, batchResults, uploadedBatchFile, batchData]);

  return {
    handleFileUpload,
    handleRemoveFile,
    handleParseUploadedFile,
    handleLoadParsedFile,
    handleGroupBatch,
    handleDownload,
  };
}
