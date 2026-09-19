import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { BatchInputFormat, NormalizationMissView, NormalizedBatchRow, ParsedBatchPreview, BatchRawRow } from '../types/batch.ts';
import type { BatchGroupingResult, PatientInfoInput } from '../types/grouper.ts';
import type { UseBatchHandlersResult } from '../hooks/useBatchHandlers.ts';
import type { UseBatchMappingHelpersResult } from '../hooks/useBatchMappingHelpers.ts';
import type { listRuleVersions } from '../services/versionedGrouper.ts';

interface BatchTabProps {
  batchUi: {
    uploadedBatchFile: File | null;
    batchFormat: BatchInputFormat;
    parsedPreview: ParsedBatchPreview | null;
    previewIdKey: string;
    previewDiagsContainerRef: RefObject<HTMLLabelElement | null>;
    previewDiagsKey: string[];
    diagsBlurTimeoutRef: RefObject<ReturnType<typeof setTimeout> | null>;
    suppressCollapseRef: RefObject<boolean>;
    prevPreviewDiagsCountRef: RefObject<number>;
    diagDelimiterOption: BatchDelimiterOption;
    diagCustomDelimiter: string;
    previewDiagsCollapsed: boolean;
    headerFilterDiagInputRef: RefObject<HTMLInputElement | null>;
    headerFilterDiag: string;
    headerFilterDiagIsRegex: boolean;
    previewProcsContainerRef: RefObject<HTMLLabelElement | null>;
    previewProcsKey: string[];
    procsBlurTimeoutRef: RefObject<ReturnType<typeof setTimeout> | null>;
    prevPreviewProcsCountRef: RefObject<number>;
    procDelimiterOption: BatchDelimiterOption;
    procCustomDelimiter: string;
    previewProcsCollapsed: boolean;
    headerFilterProcInputRef: RefObject<HTMLInputElement | null>;
    headerFilterProc: string;
    headerFilterProcIsRegex: boolean;
    SELECT_ALL_CONFIRM_THRESHOLD: number;
    previewPatientInfoExpanded: boolean;
    previewAgeKey: string;
    previewAgeDaysKey: string;
    previewBirthWeightKey: string;
    previewAdmissionWeightKey: string;
    previewDischargeKey: string;
    previewNewTechniqueKey: string;
    previewIntensiveCareKey: string;
    previewIcuHoursKey: string;
    previewCrrtHoursKey: string;
    previewLengthOfStayKey: string;
    previewDaySurgeryKey: string;
    previewGenderKey: string;
    normMisses: NormalizationMissView[];
    previewSampleIndex: number;
    batchDelimiterOption: BatchDelimiterOption;
    batchCustomDelimiter: string;
    batchData: NormalizedBatchRow[];
    parseTimeMs: number | null;
    parsingInProgress: boolean;
    parseError: string | null;
    batchResults: BatchGroupingResult[];
    batchTimeMs: number | null;
  };
  batchActions: {
    handleFileUpload: UseBatchHandlersResult['handleFileUpload'];
    handleRemoveFile: UseBatchHandlersResult['handleRemoveFile'];
    handlePreviewIdChange: (value: string) => void;
    setPreviewDiagsCollapsed: Dispatch<SetStateAction<boolean>>;
    setDiagDelimiterOption: (value: BatchDelimiterOption) => void;
    setDiagCustomDelimiter: (value: string) => void;
    handlePreviewDiagsChange: (value: string[]) => void;
    setHeaderFilterDiag: (value: string) => void;
    setHeaderFilterDiagIsRegex: Dispatch<SetStateAction<boolean>>;
    setPreviewProcsCollapsed: Dispatch<SetStateAction<boolean>>;
    setProcDelimiterOption: (value: BatchDelimiterOption) => void;
    setProcCustomDelimiter: (value: string) => void;
    handlePreviewProcsChange: (value: string[]) => void;
    setHeaderFilterProc: (value: string) => void;
    setHeaderFilterProcIsRegex: Dispatch<SetStateAction<boolean>>;
    setPreviewPatientInfoExpanded: Dispatch<SetStateAction<boolean>>;
    handlePreviewAgeChange: (value: string) => void;
    handlePreviewAgeDaysChange: (value: string) => void;
    handlePreviewBirthWeightChange: (value: string) => void;
    handlePreviewAdmissionWeightChange: (value: string) => void;
    handlePreviewDischargeChange: (value: string) => void;
    handlePreviewNewTechChange: (value: string) => void;
    handlePreviewIntensiveCareChange: (value: string) => void;
    handlePreviewIcuHoursChange: (value: string) => void;
    handlePreviewCrrtHoursChange: (value: string) => void;
    handlePreviewLengthOfStayChange: (value: string) => void;
    handlePreviewDaySurgeryChange: (value: string) => void;
    handlePreviewGenderChange: (value: string) => void;
    setPreviewSampleIndex: Dispatch<SetStateAction<number>>;
    getMappingKeys: UseBatchMappingHelpersResult['getMappingKeys'];
    cleanCell: UseBatchMappingHelpersResult['cleanCell'];
    normalizeEntriesNoUI: UseBatchMappingHelpersResult['normalizeEntriesNoUI'];
    setBatchDelimiterOption: (value: BatchDelimiterOption) => void;
    setBatchCustomDelimiter: (value: string) => void;
    setBatchFormat: (value: BatchInputFormat) => void;
    handleGroupBatch: UseBatchHandlersResult['handleGroupBatch'];
    handleDownload: UseBatchHandlersResult['handleDownload'];
  };
  ruleVersion: string;
  ruleVersions: ReturnType<typeof listRuleVersions>;
  onRuleVersionChange: (version: string) => void;
}

interface ParsedDataPreview {
  hasSample: boolean;
  idVal: string;
  rawDiags: string[];
  rawProcs: string[];
  convDiags: string[];
  convProcs: string[];
  samplePatientInfo: PatientInfoInput;
  error?: string;
}

import { useCallback, useMemo } from "react";
import { FileUp, Download } from "lucide-react";
import { getVersionDefinition } from '../services/generated/versionRegistry.ts';
import {
  extractMappedPatientInfo,
  getColsAsArrayWithDelim,
  resolveBatchDelimiter,
} from '../services/batchProcess.ts';
import type { BatchDelimiterOption } from '../services/batchProcess.ts';
import { highlightMatch, truncateStr } from './shared.tsx';
import { createBatchAdaptor } from '../services/adaptors/index.ts';

const isRegexValid = (q: string) => {
  if (!q) return true;
  try { new RegExp(q); return true; } catch { return false; }
};

const filterHeaderKeys = (keys: string[], query: string, isRegex: boolean) => {
  const qRaw = query.trim();
  if (!qRaw) return keys;
  if (isRegex) {
    try {
      const re = new RegExp(qRaw, 'i');
      return keys.filter(k => re.test(k));
    } catch {
      return [];
    }
  }
  const q = qRaw.toLowerCase();
  return keys.filter(k => k.toLowerCase().includes(q));
};

const formatPreviewCodeList = (codes: readonly string[]): string => {
  let end = codes.length;
  while (end > 0 && codes[end - 1] === '') end -= 1;
  return codes.slice(0, end).join(' | ') || '(none)';
};

const formatSampleRow = (row: BatchRawRow) => {
  try {
    const keys = Object.keys(row).slice(0, 6);
    const parts = keys.map(k => {
      const v = row[k];
      const vs = (v == null) ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      return `${k}: ${truncateStr(vs, 60)}`;
    });
    return parts.join(' · ');
  } catch {
    return String(row).slice(0, 200);
  }
};

function BatchTab({ batchUi, batchActions, ruleVersion, ruleVersions, onRuleVersionChange }: BatchTabProps) {
  const {
    uploadedBatchFile,
    batchFormat,
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
    previewAdmissionWeightKey,
    previewDischargeKey,
    previewNewTechniqueKey,
    previewIntensiveCareKey,
    previewIcuHoursKey,
    previewCrrtHoursKey,
    previewLengthOfStayKey,
    previewDaySurgeryKey,
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

  const { adaptor, adaptorError } = useMemo(() => {
    if (batchFormat === 'MANUAL' || !parsedPreview?.headerKeys) {
      return { adaptor: null, adaptorError: null };
    }
    try {
      return { adaptor: createBatchAdaptor(batchFormat, parsedPreview.headerKeys), adaptorError: null };
    } catch (error) {
      return { adaptor: null, adaptorError: error instanceof Error ? error.message : String(error) };
    }
  }, [batchFormat, parsedPreview]);
  const isStructuredFormat = batchFormat !== 'MANUAL';
  const previewHeaderKeys = parsedPreview?.headerKeys;

  const patientInfoFieldKeys = useMemo(() => {
    const groups = getVersionDefinition(ruleVersion).patientInfo;
    return new Set([...groups.basic, ...groups.advanced]);
  }, [ruleVersion]);
  const isPatientInfoFieldVisible = (field: keyof PatientInfoInput) => patientInfoFieldKeys.has(field);

  const {
    handleFileUpload,
    handleRemoveFile,
    setBatchFormat,
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
    handlePreviewAdmissionWeightChange,
    handlePreviewDischargeChange,
    handlePreviewNewTechChange,
    handlePreviewIntensiveCareChange,
    handlePreviewIcuHoursChange,
    handlePreviewCrrtHoursChange,
    handlePreviewLengthOfStayChange,
    handlePreviewDaySurgeryChange,
    handlePreviewGenderChange,
    setPreviewSampleIndex,
    getMappingKeys,
    cleanCell,
    normalizeEntriesNoUI,
    handleGroupBatch,
    handleDownload,
  } = batchActions;

  const previewSample = parsedPreview
    ? (parsedPreview.sample[previewSampleIndex] || null)
    : null;
  const previewDiagDelimiterResolved = useMemo(
    () => resolveBatchDelimiter(diagDelimiterOption, diagCustomDelimiter, '|'),
    [diagDelimiterOption, diagCustomDelimiter]
  );
  const previewProcDelimiterResolved = useMemo(
    () => resolveBatchDelimiter(procDelimiterOption, procCustomDelimiter, '|'),
    [procDelimiterOption, procCustomDelimiter]
  );

  const { previewRawDiags, previewRawProcs } = useMemo(() => {
    if (!previewSample || isStructuredFormat) return { previewRawDiags: [], previewRawProcs: [] };
    const sample = previewSample;
    const { diagsKey, procsKey } = getMappingKeys(sample);
    const rawDiags = getColsAsArrayWithDelim(sample, diagsKey, previewDiagDelimiterResolved, cleanCell);
    const rawProcs = getColsAsArrayWithDelim(sample, procsKey, previewProcDelimiterResolved, cleanCell);
    return { previewRawDiags: rawDiags, previewRawProcs: rawProcs };
  }, [
    previewSample,
    isStructuredFormat,
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
    const keys = parsedPreview?.headerKeys ?? [];
    return filterHeaderKeys(keys, headerFilterDiag, headerFilterDiagIsRegex);
  }, [parsedPreview, headerFilterDiag, headerFilterDiagIsRegex]);

  const filteredHeaderKeysProc = useMemo(() => {
    const keys = parsedPreview?.headerKeys ?? [];
    return filterHeaderKeys(keys, headerFilterProc, headerFilterProcIsRegex);
  }, [parsedPreview, headerFilterProc, headerFilterProcIsRegex]);

  const headerFilterDiagRegexValid = useMemo(() => {
    if (!headerFilterDiagIsRegex) return true;
    const q = headerFilterDiag.trim();
    return isRegexValid(q);
  }, [headerFilterDiag, headerFilterDiagIsRegex]);

  const headerFilterProcRegexValid = useMemo(() => {
    if (!headerFilterProcIsRegex) return true;
    const q = headerFilterProc.trim();
    return isRegexValid(q);
  }, [headerFilterProc, headerFilterProcIsRegex]);

  const parsedDataPreview = useMemo<ParsedDataPreview>(() => {
    if (!parsedPreview || parsedPreview.sample.length === 0) {
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
    if (isStructuredFormat) {
      if (!adaptor) {
        return {
          hasSample: true,
          idVal: '',
          rawDiags: [],
          rawProcs: [],
          convDiags: [],
          convProcs: [],
          samplePatientInfo: {},
          error: adaptorError || '请选择与文件表头一致的格式',
        };
      }
      try {
        const {
          id, diagnoses, procedures, patientInfo,
        } = adaptor.adapt(sampleRow, previewSampleIndex);
        const convertedDiagnoses = diagnoses;
        return {
          hasSample: true, idVal: id,
          rawDiags: diagnoses, convDiags: convertedDiagnoses,
          rawProcs: procedures, convProcs: procedures,
          samplePatientInfo: patientInfo,
        };
      } catch (error) {
        return {
          hasSample: true,
          idVal: '',
          rawDiags: [],
          rawProcs: [],
          convDiags: [],
          convProcs: [],
          samplePatientInfo: {},
          error: (error as Error).message,
        };
      }
    }
    let idVal = '';
    let rawDiags: string[] = [];
    let rawProcs: string[] = [];
    let samplePatientInfo = {};

    if (parsedPreview.headerKeys) {
      const sample = sampleRow;
      const mapping = getMappingKeys(sample);
      const { idKey, diagsKey, procsKey } = mapping;
      idVal = cleanCell(sample[idKey]);
      rawDiags = previewRawDiags.length ? previewRawDiags : getColsAsArrayWithDelim(sample, diagsKey, previewDiagDelimiterResolved, cleanCell);
      rawProcs = previewRawProcs.length ? previewRawProcs : getColsAsArrayWithDelim(sample, procsKey, previewProcDelimiterResolved, cleanCell);
      samplePatientInfo = extractMappedPatientInfo(sample, mapping, cleanCell);
    }

    const convDiags = (previewRawDiags.length && previewRawDiags === rawDiags)
      ? previewConvDiags
      : normalizeEntriesNoUI(rawDiags, 'Diagnosis');
    const convProcs = (previewRawProcs.length && previewRawProcs === rawProcs)
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
    isStructuredFormat,
    adaptor,
    adaptorError,
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
    () => new Set(previewDiagsKey),
    [previewDiagsKey]
  );
  const previewProcsKeySet = useMemo(
    () => new Set(previewProcsKey),
    [previewProcsKey]
  );

  const handleTogglePatientInfo = useCallback(
    () => setPreviewPatientInfoExpanded(v => !v),
    [setPreviewPatientInfoExpanded]
  );

  const handleDiagsBlur = useCallback(() => {
    const curr = previewDiagsKey.length;
    if (diagsBlurTimeoutRef.current) clearTimeout(diagsBlurTimeoutRef.current);
    diagsBlurTimeoutRef.current = setTimeout(() => {
      if (suppressCollapseRef.current) { suppressCollapseRef.current = false; diagsBlurTimeoutRef.current = null; return; }
      const active = document.activeElement;
      if (!previewDiagsContainerRef.current || !previewDiagsContainerRef.current.contains(active)) {
        setPreviewDiagsCollapsed(curr === 1);
      }
      prevPreviewDiagsCountRef.current = curr;
      diagsBlurTimeoutRef.current = null;
    }, 0);
  }, [previewDiagsKey, diagsBlurTimeoutRef, suppressCollapseRef, previewDiagsContainerRef, setPreviewDiagsCollapsed, prevPreviewDiagsCountRef]);

  const handleProcsBlur = useCallback(() => {
    const curr = previewProcsKey.length;
    if (procsBlurTimeoutRef.current) clearTimeout(procsBlurTimeoutRef.current);
    procsBlurTimeoutRef.current = setTimeout(() => {
      if (suppressCollapseRef.current) { suppressCollapseRef.current = false; procsBlurTimeoutRef.current = null; return; }
      const active = document.activeElement;
      if (!previewProcsContainerRef.current || !previewProcsContainerRef.current.contains(active)) {
        setPreviewProcsCollapsed(curr === 1);
      }
      prevPreviewProcsCountRef.current = curr;
      procsBlurTimeoutRef.current = null;
    }, 0);
  }, [previewProcsKey, procsBlurTimeoutRef, suppressCollapseRef, previewProcsContainerRef, setPreviewProcsCollapsed, prevPreviewProcsCountRef]);

  const batchResultSummary = useMemo(() => {
    let count0000 = 0;
    let countQY = 0;
    for (const row of batchResults) {
      const drg = row.drg;
      if (drg === '0000') count0000 += 1;
      if (drg?.endsWith('QY')) countQY += 1;
    }
    return { count0000, countQY };
  }, [batchResults]);
  const selectedDiagKey = previewDiagsKey.length === 1 ? previewDiagsKey[0] : undefined;
  const selectedProcKey = previewProcsKey.length === 1 ? previewProcsKey[0] : undefined;
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
        <label htmlFor="batch-input-format" className="ml-4 text-sm text-gray-400">输入格式</label>
        <select
          id="batch-input-format"
          value={batchFormat}
          onChange={(event) => setBatchFormat(event.target.value as BatchInputFormat)}
          className="border border-gray-600 bg-gray-900 rounded px-2 py-1 text-sm"
          disabled={parsingInProgress}
        >
          <option value="MANUAL">通用 CSV / Excel（手动映射）</option>
          <option value="HQMS">HQMS（国考）</option>
          <option value="N041">国家通用 N041</option>
          <option value="HN041">上海扩展 N041</option>
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
        <p className="text-sm text-gray-400 mt-2">格式由上方“输入格式”明确选择，不自动判断</p>
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
              文件导入失败：{parseError}
            </div>
          )}

          {parsedPreview && (
            <div className="mt-3 text-sm">
              <div>
                Rows detected: {parsedPreview.dataLength}
                {previewHeaderKeys && (
                  <span className="ml-2 text-xs text-gray-400">({previewHeaderKeys.length} headers)</span>
                )}
              </div>
              {adaptorError && (
                <div className="mt-2 rounded border border-red-700 bg-red-950 bg-opacity-50 p-3 text-sm text-red-200" role="alert">
                  {adaptorError}
                </div>
              )}
              {adaptor && (
                <div className="mt-2 rounded border border-blue-700 p-3 space-y-2">
                  <div>已选择 {adaptor.format}：{adaptor.mapping.diagnoses.filter(Boolean).length} 个诊断字段，{adaptor.mapping.procedures.filter(Boolean).length} 个手术字段。</div>
                  <div className="text-xs text-gray-400">导入时默认选择国临码，可通过顶部开关切换为医保码。</div>
                  {adaptor.format === 'N041' && <div className="text-xs text-gray-400">此 N041 配置将 BZYZSNL 按天读取；月龄文件须先转换为准确日龄。</div>}
                  {adaptor.format === 'HN041' && <div className="text-xs text-gray-400">上海扩展 N041 直接读取诊断编码；仅以 * 结尾的附加码与主码拼接为双重编码，附加名称不拼接，M 形态学码保留为 metadata。</div>}
                  <details>
                    <summary className="cursor-pointer">查看字段映射</summary>
                    <div className="mt-2 text-xs break-words space-y-1">
                      <div>病案号：{adaptor.mapping.id}</div>
                      <div>诊断编码（首项为主要诊断，分组使用）：{adaptor.mapping.diagnoses.map(key => key ?? '缺列').join(' → ')}</div>
                      <div>手术（首项为主要手术）：{adaptor.mapping.procedures.map(key => key ?? '缺列').join(' → ')}</div>
                      <div>患者信息：{Object.entries(adaptor.mapping.patientInfo).map(([field, key]) => `${field} ← ${key}`).join('，')}</div>
                    </div>
                  </details>
                </div>
              )}
              {previewHeaderKeys && !isStructuredFormat && (
                <div className="mt-2">
                  <div className="flex flex-col md:flex-row md:items-center gap-3">
                    <div className="text-xs md:mr-2">Map columns:</div>
                    <div className="flex flex-col md:flex-row md:items-center gap-2 w-full">
                      <div className="flex-1 md:flex-initial md:mr-3">
                        <div className="text-xs mb-1">ID</div>
                        <select title={previewIdKey || '(none)'} className="p-1 border rounded w-full md:w-auto text-xs bg-gray-800" value={previewIdKey} onChange={e => handlePreviewIdChange(e.target.value)}>
                          <option title="(none)" value="">(none)</option>
                          {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                        </select>
                      </div>

                      <label
                        className="text-xs flex flex-col w-full md:w-auto"
                        ref={previewDiagsContainerRef}
                        tabIndex={-1}
                        onPointerDown={(ev) => { if (ev.pointerType !== 'touch') return; const target = ev.target as Element; if (target.closest('.delimiter-control')) return; previewDiagsContainerRef.current?.focus(); }}
                        onFocus={(event) => { const target = event.target as Element; if (target.closest('.delimiter-control')) return; setPreviewDiagsCollapsed(false); }}
                        onBlur={handleDiagsBlur}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="whitespace-nowrap">Diagnoses</span>
                          <div className="flex items-center gap-2 ml-2 delimiter-control">
                            <select title="Diagnoses delimiter" className="text-xs p-1 border rounded bg-gray-800" value={diagDelimiterOption} onChange={e => setDiagDelimiterOption(e.target.value as BatchDelimiterOption)}>
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
                          {previewDiagsCollapsed && selectedDiagKey !== undefined ? (
                            <div className="flex items-center justify-between gap-2">
                              <div
                                className="truncate text-xs font-mono px-2 py-1 bg-gray-900 rounded cursor-pointer"
                                role="button"
                                tabIndex={0}
                                onPointerDown={() => { suppressCollapseRef.current = true; setTimeout(() => { suppressCollapseRef.current = false; }, 300); }}
                                onClick={() => setPreviewDiagsCollapsed(false)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setPreviewDiagsCollapsed(false); e.preventDefault(); } }}
                                aria-label={`Selected diagnosis column: ${selectedDiagKey}`}
                              >
                                {highlightMatch(selectedDiagKey, headerFilterDiag, headerFilterDiagIsRegex)}
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
                                      const prev = previewDiagsKey;
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
                        onPointerDown={(ev) => { if (ev.pointerType !== 'touch') return; const target = ev.target as Element; if (target.closest('.delimiter-control')) return; previewProcsContainerRef.current?.focus(); }}
                        onFocus={(event) => { const target = event.target as Element; if (target.closest('.delimiter-control')) return; setPreviewProcsCollapsed(false); }}
                        onBlur={handleProcsBlur}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="whitespace-nowrap">Procedures</span>
                          <div className="flex items-center gap-2 ml-2 delimiter-control">
                            <select title="Procedures delimiter" className="text-xs p-1 border rounded bg-gray-800" value={procDelimiterOption} onChange={e => setProcDelimiterOption(e.target.value as BatchDelimiterOption)}>
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
                          {previewProcsCollapsed && selectedProcKey !== undefined ? (
                            <div className="flex items-center justify-between gap-2">
                              <div
                                className="truncate text-xs font-mono px-2 py-1 bg-gray-900 rounded cursor-pointer"
                                role="button"
                                tabIndex={0}
                                onPointerDown={() => { suppressCollapseRef.current = true; setTimeout(() => { suppressCollapseRef.current = false; }, 300); }}
                                onClick={() => setPreviewProcsCollapsed(false)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setPreviewProcsCollapsed(false); e.preventDefault(); } }}
                                aria-label={`Selected procedure column: ${selectedProcKey}`}
                              >
                                {highlightMatch(selectedProcKey, headerFilterProc, headerFilterProcIsRegex)}
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
                                      const prev = previewProcsKey;
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
                        {isPatientInfoFieldVisible('gender') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Gender</span>
                            <select title={previewGenderKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewGenderKey} onChange={e => handlePreviewGenderChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('age') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Age</span>
                            <select title={previewAgeKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewAgeKey} onChange={e => handlePreviewAgeChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('ageInDays') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Age (days)</span>
                            <select title={previewAgeDaysKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewAgeDaysKey} onChange={e => handlePreviewAgeDaysChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('birthWeight') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Birth wt</span>
                            <select title={previewBirthWeightKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewBirthWeightKey} onChange={e => handlePreviewBirthWeightChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('admissionWeight') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Admission wt</span>
                            <select title={previewAdmissionWeightKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewAdmissionWeightKey} onChange={e => handlePreviewAdmissionWeightChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('dischargeStatus') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Discharge</span>
                            <select title={previewDischargeKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewDischargeKey} onChange={e => handlePreviewDischargeChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('newTechnique') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">New Technique</span>
                            <select title={previewNewTechniqueKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewNewTechniqueKey} onChange={e => handlePreviewNewTechChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('intensiveCare') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Intensive care</span>
                            <select title={previewIntensiveCareKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewIntensiveCareKey} onChange={e => handlePreviewIntensiveCareChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('icuHours') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">ICU hours</span>
                            <select title={previewIcuHoursKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewIcuHoursKey} onChange={e => handlePreviewIcuHoursChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('crrtHours') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">CRRT hours</span>
                            <select title={previewCrrtHoursKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewCrrtHoursKey} onChange={e => handlePreviewCrrtHoursChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('lengthOfStay') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Length of stay</span>
                            <select title={previewLengthOfStayKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewLengthOfStayKey} onChange={e => handlePreviewLengthOfStayChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}

                        {isPatientInfoFieldVisible('daySurgery') && (
                          <label className="text-xs flex flex-col md:flex-row md:items-center w-full md:w-auto">
                            <span className="whitespace-nowrap">Day surgery</span>
                            <select title={previewDaySurgeryKey || '(none)'} className="mt-1 md:mt-0 md:ml-1 p-1 border rounded w-full md:w-auto" value={previewDaySurgeryKey} onChange={e => handlePreviewDaySurgeryChange(e.target.value)}>
                              <option title="(none)" value="">(none)</option>
                              {previewHeaderKeys.map(k => <option title={k} key={k} value={k}>{k}</option>)}
                            </select>
                          </label>
                        )}
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
                {previewHeaderKeys ? (
                  <div className="mt-1 rounded" style={{maxHeight: 200, overflowX: 'auto', overflowY: 'hidden'}}>
                    <table className="w-full text-xs table-auto border-collapse">
                      <thead>
                        <tr>
                          {previewHeaderKeys.map(k => (
                            <th key={k} className="p-1 text-left font-semibold text-gray-200 border-b">{k}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {parsedPreview.sample.slice(0,3).map((r, i) => (
                          <tr key={i} className="align-top border-b">
                            {previewHeaderKeys.map(k => (
                              <td key={k} className="p-1 align-top text-gray-300">
                                <div style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  {r[k] != null ? String(r[k]) : ''}
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
                  {parsedPreview.sample.length > 1 && (
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

                {parsedDataPreview.error ? (
                  <div className="text-xs text-red-300" role="alert">{parsedDataPreview.error}</div>
                ) : parsedDataPreview.hasSample ? (
                  <div className="text-xs text-gray-300">
                    <div><strong>ID:</strong> <span className="font-mono">{parsedDataPreview.idVal || '(empty)'}</span></div>
                    <div className="mt-1"><strong>Raw Diagnoses:</strong> <span className="font-mono">{formatPreviewCodeList(parsedDataPreview.rawDiags)}</span></div>
                    <div className="mt-1"><strong>Parsed Diagnoses:</strong> <span className="font-mono">{formatPreviewCodeList(parsedDataPreview.convDiags)}</span></div>
                    <div className="mt-2"><strong>Raw Procedures:</strong> <span className="font-mono">{formatPreviewCodeList(parsedDataPreview.rawProcs)}</span></div>
                    <div className="mt-1"><strong>Parsed Procedures:</strong> <span className="font-mono">{formatPreviewCodeList(parsedDataPreview.convProcs)}</span></div>
                    {Object.keys(parsedDataPreview.samplePatientInfo).length > 0 && (
                      <div className="mt-2"><strong>Patient Info:</strong> <span className="font-mono">{JSON.stringify(parsedDataPreview.samplePatientInfo)}</span></div>
                    )}
                    {adaptor ? (
                      <div className="mt-2 text-xs text-gray-400">每列一个编码，按槽位顺序读取；仅以 * 结尾的附加码与主码拼接为双重编码，附加名称不参与分组；M 形态学码不参与普通诊断。</div>
                    ) : (
                      <div className="mt-2 text-xs text-gray-400">Delimiters: <span className="font-mono">Diag: {previewDiagDelimiterResolved === '\t' ? '\\t' : previewDiagDelimiterResolved} &nbsp;&nbsp; Proc: {previewProcDelimiterResolved === '\t' ? '\\t' : previewProcDelimiterResolved}</span></div>
                    )}
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
        <div className="text-sm">Upload options: parsed rows assume headered CSV/Excel；输入 schema 由上方选择，通用模式再进行字段映射</div>
      </div>

      {/* Batch Log panel removed from UI (logs are still recorded to console) */}

      {(batchData.length > 0 || (parsedPreview && parsedPreview.dataLength > 0 && !parsingInProgress)) && (
        <div className="bg-info p-4 rounded-lg flex justify-between items-center border border-info">
          <span className="font-medium text-info">{batchData.length > 0 ? `${batchData.length} records loaded${parseTimeMs != null ? ` (${parseTimeMs < 1000 ? `${parseTimeMs} ms` : `${(parseTimeMs/1000).toFixed(2)} s`})` : ''}` : `${parsedPreview?.dataLength ?? 0} rows parsed`}</span>
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
