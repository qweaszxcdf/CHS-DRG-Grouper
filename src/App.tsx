import type { BatchInputFormat, BatchRawRow, NormalizationMiss, NormalizationMissView, NormalizedBatchRow, ParsedBatchPreview } from './types/batch.ts';
import type { BatchGroupingResult } from './types/grouper.ts';
import { useState, useEffect, useRef, useCallback, Suspense, lazy } from "react";
import { Search } from "lucide-react";

import SingleTab from "./tabs/SingleTab.tsx";

// runtime constant replaced by Vite; used for tree-shaking
const isLite = import.meta.env.VITE_LITE === 'true';

// lazily load the other tabs only when not in lite build
const BatchTab = !isLite ? lazy(() => import("./tabs/BatchTab.tsx")) : null;
const SearchTab = !isLite ? lazy(() => import("./tabs/SearchTab.tsx")) : null;
const MdcTreeTab = !isLite ? lazy(() => import("./tabs/MdcTreeTab.tsx")) : null;
// Runtime MDC parsing removed; use pre-parsed artifacts instead.
import { useBatchHandlers } from "./hooks/useBatchHandlers";
import { useBatchMappingHelpers } from "./hooks/useBatchMappingHelpers";
import { useSearchIndex } from './hooks/useSearchIndex.ts';
import { listRuleVersions } from './services/versionedGrouper.ts';
import { DEFAULT_RULE_VERSION } from './services/generated/versionRegistry.ts';
import type { BatchDelimiterOption } from './services/batchProcess.ts';

function App() {
  const [activeTab, setActiveTab] = useState("single"); // 'single', 'batch', 'test', 'search', 'tree'
  const [searchSource, setSearchSource] = useState('YB'); // 'YB' (医保) or 'GL' (国临)
  const [mdcTreeQuery, setMdcTreeQuery] = useState('');
  const [mdcTreeExpandToAdrg, setMdcTreeExpandToAdrg] = useState(false);
  const [batchFormat, setBatchFormat] = useState<BatchInputFormat>('MANUAL');
  const [ruleVersion, setRuleVersion] = useState(DEFAULT_RULE_VERSION);
  const codeIndexRevision = useSearchIndex({ ruleVersion, searchSource });

  // Batch Grouper State
  const [batchData, setBatchData] = useState<NormalizedBatchRow[]>([]);
  const [batchResults, setBatchResults] = useState<BatchGroupingResult[]>([]);
  const [batchTimeMs, setBatchTimeMs] = useState<number | null>(null);
  const [parseTimeMs, setParseTimeMs] = useState<number | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  // `batchLog` removed — operational messages are sent to the console only.
  // Store uploaded file and defer parsing until user requests it
  const [uploadedBatchFile, setUploadedBatchFile] = useState<File | null>(null);
  // Worker and parsed preview state
  const workerRef = useRef<Worker | null>(null);
  // Snapshot of manual preview mappings across parses (preserve user overrides)
  const manualPreviewSnapshotRef = useRef<unknown>(null);
  // Monotonic parse token to ignore stale worker messages
  const parseTokenRef = useRef(0);
  const batchRunTokenRef = useRef(0);
  const [parsingInProgress, setParsingInProgress] = useState(false);
  const [parsedPreview, setParsedPreview] = useState<ParsedBatchPreview | null>(null); // { meta, sample, dataLength, headerKeys, isArray }
  const [parsedRows, setParsedRows] = useState<BatchRawRow[] | null>(null);
  const [previewSampleIndex, setPreviewSampleIndex] = useState(0);

  const invalidateBatchState = useCallback(() => {
    batchRunTokenRef.current += 1;
    setBatchData([]);
    setBatchResults([]);
    setBatchTimeMs(null);
    setParseTimeMs(null);
  }, []);
  // Preview mapping keys (for headered CSVs)
  const [previewIdKey, setPreviewIdKey] = useState('');
  const [previewDiagsKey, setPreviewDiagsKey] = useState<string[]>([]);
  const [previewProcsKey, setPreviewProcsKey] = useState<string[]>([]);
  const [previewAgeKey, setPreviewAgeKey] = useState('');
  const [previewAgeDaysKey, setPreviewAgeDaysKey] = useState('');
  const [previewBirthWeightKey, setPreviewBirthWeightKey] = useState('');
  const [previewAdmissionWeightKey, setPreviewAdmissionWeightKey] = useState('');
  const [previewDischargeKey, setPreviewDischargeKey] = useState('');
  const [previewNewTechniqueKey, setPreviewNewTechniqueKey] = useState('');
  const [previewIntensiveCareKey, setPreviewIntensiveCareKey] = useState('');
  const [previewIcuHoursKey, setPreviewIcuHoursKey] = useState('');
  const [previewCrrtHoursKey, setPreviewCrrtHoursKey] = useState('');
  const [previewLengthOfStayKey, setPreviewLengthOfStayKey] = useState('');
  const [previewDaySurgeryKey, setPreviewDaySurgeryKey] = useState('');
  const [previewGenderKey, setPreviewGenderKey] = useState('');
  // Header filters (per-field) for long-file UX
  const [headerFilterDiag, setHeaderFilterDiag] = useState('');
  const [headerFilterProc, setHeaderFilterProc] = useState('');
  const [headerFilterDiagIsRegex, setHeaderFilterDiagIsRegex] = useState(false);
  const [headerFilterProcIsRegex, setHeaderFilterProcIsRegex] = useState(false);
  const headerFilterDiagInputRef = useRef<HTMLInputElement | null>(null);
  const headerFilterProcInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-collapse preview header selectors when exactly one column is selected
  const [previewDiagsCollapsed, setPreviewDiagsCollapsed] = useState(false);
  const [previewProcsCollapsed, setPreviewProcsCollapsed] = useState(false);
  const prevPreviewDiagsCountRef = useRef(previewDiagsKey.length);
  const prevPreviewProcsCountRef = useRef(previewProcsKey.length);
  // container refs so we can verify activeElement during blurred events
  const previewDiagsContainerRef = useRef<HTMLLabelElement | null>(null);
  const previewProcsContainerRef = useRef<HTMLLabelElement | null>(null);
  // timers to debounce blur-check (avoid collapsing on transient DOM focus loss)
  const diagsBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const procsBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // flag to temporarily suppress collapse when user is clicking the pill (prevents blur race)
  const suppressCollapseRef = useRef(false);
  // track whether we've initialized the parsed-preview UI so we only auto-collapse once on initial load
  const parsedPreviewLoadedRef = useRef(false);

  // If user attempts to "select all" more than this many columns, ask for confirmation
  const SELECT_ALL_CONFIRM_THRESHOLD = 50;
  // Refs to hold latest preview values for use in async closures (worker handlers)
  const previewIdRef = useRef(previewIdKey);
  const previewDiagsRef = useRef(previewDiagsKey);
  const previewProcsRef = useRef(previewProcsKey);
  const previewAgeRef = useRef(previewAgeKey);
  const previewAgeDaysRef = useRef(previewAgeDaysKey);
  const previewBirthWeightRef = useRef(previewBirthWeightKey);
  const previewAdmissionWeightRef = useRef(previewAdmissionWeightKey);
  const previewDischargeRef = useRef(previewDischargeKey);
  const previewNewTechniqueRef = useRef(previewNewTechniqueKey);
  const previewIntensiveCareRef = useRef(previewIntensiveCareKey);
  const previewIcuHoursRef = useRef(previewIcuHoursKey);
  const previewCrrtHoursRef = useRef(previewCrrtHoursKey);
  const previewLengthOfStayRef = useRef(previewLengthOfStayKey);
  const previewDaySurgeryRef = useRef(previewDaySurgeryKey);
  const previewGenderRef = useRef(previewGenderKey);
  const [batchDelimiterOption, setBatchDelimiterOption] = useState<BatchDelimiterOption>('PIPE');
  const [batchCustomDelimiter, setBatchCustomDelimiter] = useState('|');

  // Per-field delimiters (default to global delimiter option)
  const [diagDelimiterOption, setDiagDelimiterOption] = useState<BatchDelimiterOption>('PIPE');
  const [diagCustomDelimiter, setDiagCustomDelimiter] = useState('|');
  const [procDelimiterOption, setProcDelimiterOption] = useState<BatchDelimiterOption>('PIPE');
  const [procCustomDelimiter, setProcCustomDelimiter] = useState('|');

  const resetPreviewMappings = useCallback(() => {
    previewIdRef.current = '';
    previewDiagsRef.current = [];
    previewProcsRef.current = [];
    previewAgeRef.current = '';
    previewAgeDaysRef.current = '';
    previewBirthWeightRef.current = '';
    previewAdmissionWeightRef.current = '';
    previewDischargeRef.current = '';
    previewNewTechniqueRef.current = '';
    previewIntensiveCareRef.current = '';
    previewIcuHoursRef.current = '';
    previewCrrtHoursRef.current = '';
    previewLengthOfStayRef.current = '';
    previewDaySurgeryRef.current = '';
    previewGenderRef.current = '';
    setPreviewIdKey('');
    setPreviewDiagsKey([]);
    setPreviewProcsKey([]);
    setPreviewAgeKey('');
    setPreviewAgeDaysKey('');
    setPreviewBirthWeightKey('');
    setPreviewAdmissionWeightKey('');
    setPreviewDischargeKey('');
    setPreviewNewTechniqueKey('');
    setPreviewIntensiveCareKey('');
    setPreviewIcuHoursKey('');
    setPreviewCrrtHoursKey('');
    setPreviewLengthOfStayKey('');
    setPreviewDaySurgeryKey('');
    setPreviewGenderKey('');
    setPreviewSampleIndex(0);
  }, []);

  const handleSearchSourceChange = (nextSource: string) => {
    if (nextSource === searchSource) return;
    invalidateBatchState();
    setSearchSource(nextSource);
  };
  const handleViewInMdcTree = useCallback((code: string) => {
    const query = code.trim();
    if (!query || isLite) return;
    setMdcTreeQuery(query);
    setMdcTreeExpandToAdrg(true);
    setActiveTab('tree');
  }, []);
  const handleRuleVersionChange = (nextVersion: string) => {
    if (nextVersion === ruleVersion) return;
    invalidateBatchState();
    setRuleVersion(nextVersion);
  };
  const handleDiagDelimiterOptionChange = (value: BatchDelimiterOption) => { invalidateBatchState(); setDiagDelimiterOption(value); };
  const handleDiagCustomDelimiterChange = (value: string) => { invalidateBatchState(); setDiagCustomDelimiter(value); };
  const handleProcDelimiterOptionChange = (value: BatchDelimiterOption) => { invalidateBatchState(); setProcDelimiterOption(value); };
  const handleProcCustomDelimiterChange = (value: string) => { invalidateBatchState(); setProcCustomDelimiter(value); };
  const handleBatchDelimiterOptionChange = (value: BatchDelimiterOption) => { invalidateBatchState(); setBatchDelimiterOption(value); };
  const handleBatchCustomDelimiterChange = (value: string) => { invalidateBatchState(); setBatchCustomDelimiter(value); };
  const handleBatchFormatChange = (value: BatchInputFormat) => {
    invalidateBatchState();
    setParseError(null);
    if (value !== 'MANUAL') setSearchSource('GL');
    setBatchFormat(value);
  };
  

  // Keep preview refs in sync with state so closures can read latest values.
  // A single effect avoids scheduling multiple tiny effects on each mapping-state change.
  useEffect(() => {
    previewIdRef.current = previewIdKey;
    previewDiagsRef.current = previewDiagsKey;
    previewProcsRef.current = previewProcsKey;
    previewAgeRef.current = previewAgeKey;
    previewAgeDaysRef.current = previewAgeDaysKey;
    previewBirthWeightRef.current = previewBirthWeightKey;
    previewAdmissionWeightRef.current = previewAdmissionWeightKey;
    previewDischargeRef.current = previewDischargeKey;
    previewNewTechniqueRef.current = previewNewTechniqueKey;
    previewIntensiveCareRef.current = previewIntensiveCareKey;
    previewIcuHoursRef.current = previewIcuHoursKey;
    previewCrrtHoursRef.current = previewCrrtHoursKey;
    previewLengthOfStayRef.current = previewLengthOfStayKey;
    previewDaySurgeryRef.current = previewDaySurgeryKey;
    previewGenderRef.current = previewGenderKey;
  }, [
    previewIdKey,
    previewDiagsKey,
    previewProcsKey,
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
  ]);

  // When selection changes, collapse **only if** the selector is not focused.
  // This preserves the "stay open while interacting" behavior but will allow
  // the UI to collapse automatically when the user isn't focused on the selector.
  useEffect(() => {
    const curr = previewDiagsKey.length;
    const active = document.activeElement;
    const container = previewDiagsContainerRef.current;
    const isFocused = container?.contains(active) ?? false;
    if (curr === 1 && !isFocused) setPreviewDiagsCollapsed(true);
    else if (curr !== 1) setPreviewDiagsCollapsed(false);
    prevPreviewDiagsCountRef.current = curr;
  }, [previewDiagsKey]);

  useEffect(() => {
    const curr = previewProcsKey.length;
    const active = document.activeElement;
    const container = previewProcsContainerRef.current;
    const isFocused = container?.contains(active) ?? false;
    if (curr === 1 && !isFocused) setPreviewProcsCollapsed(true);
    else if (curr !== 1) setPreviewProcsCollapsed(false);
    prevPreviewProcsCountRef.current = curr;
  }, [previewProcsKey]);

  // Collapse when user clicks outside either selector (acts like onBlur)
  useEffect(() => {
    const handler = (ev: PointerEvent) => {
      const diagContainer = previewDiagsContainerRef.current;
      if (diagContainer && !diagContainer.contains(ev.target as Node | null) && !previewDiagsCollapsed) {
        const currDiag = previewDiagsKey.length;
        setPreviewDiagsCollapsed(currDiag === 1);
      }

      const procContainer = previewProcsContainerRef.current;
      if (procContainer && !procContainer.contains(ev.target as Node | null) && !previewProcsCollapsed) {
        const currProc = previewProcsKey.length;
        setPreviewProcsCollapsed(currProc === 1);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [previewDiagsCollapsed, previewDiagsKey, previewProcsCollapsed, previewProcsKey]);

  // When a parsed preview is first loaded, collapse the selector if exactly one
  // header is selected so the UI starts compact for stable mappings.
  useEffect(() => {
    if (!parsedPreview) {
      parsedPreviewLoadedRef.current = false;
      return;
    }

    if (!parsedPreviewLoadedRef.current) {
      parsedPreviewLoadedRef.current = true;
      const diagCount = previewDiagsRef.current.length;
      const procCount = previewProcsRef.current.length;
      if (diagCount === 1) setPreviewDiagsCollapsed(true);
      if (procCount === 1) setPreviewProcsCollapsed(true);
    }
  }, [parsedPreview]);

  // Control expansion of patient-info mapping panel in batch preview.
  // Default: collapsed. If any mapping key is present, auto-expand so users see mapped fields.
  const [previewPatientInfoExpanded, setPreviewPatientInfoExpanded] = useState(false);
  useEffect(() => {
    if (previewAgeKey || previewAgeDaysKey || previewBirthWeightKey || previewAdmissionWeightKey || previewDischargeKey || previewNewTechniqueKey || previewIntensiveCareKey || previewIcuHoursKey || previewCrrtHoursKey || previewLengthOfStayKey || previewDaySurgeryKey || previewGenderKey) {
      setPreviewPatientInfoExpanded(true);
    }
  }, [previewAgeKey, previewAgeDaysKey, previewBirthWeightKey, previewAdmissionWeightKey, previewDischargeKey, previewNewTechniqueKey, previewIntensiveCareKey, previewIcuHoursKey, previewCrrtHoursKey, previewLengthOfStayKey, previewDaySurgeryKey, previewGenderKey]);

  // Handlers that update both state and immediate ref to avoid races in async handlers
  const handlePreviewIdChange = (val: string) => { invalidateBatchState(); previewIdRef.current = val; setPreviewIdKey(val); };
  const handlePreviewDiagsChange = (val: string[]) => { invalidateBatchState(); previewDiagsRef.current = val; setPreviewDiagsKey(val); };
  const handlePreviewProcsChange = (val: string[]) => { invalidateBatchState(); previewProcsRef.current = val; setPreviewProcsKey(val); };
  const handlePreviewAgeChange = (val: string) => {
    invalidateBatchState();
    previewAgeRef.current = val;
    setPreviewAgeKey(val);
    if (val && previewAgeDaysRef.current === val) {
      previewAgeDaysRef.current = '';
      setPreviewAgeDaysKey('');
    }
  };
  const handlePreviewAgeDaysChange = (val: string) => {
    invalidateBatchState();
    previewAgeDaysRef.current = val;
    setPreviewAgeDaysKey(val);
    if (val && previewAgeRef.current === val) {
      previewAgeRef.current = '';
      setPreviewAgeKey('');
    }
  };
  const handlePreviewBirthWeightChange = (val: string) => { invalidateBatchState(); previewBirthWeightRef.current = val; setPreviewBirthWeightKey(val); };
  const handlePreviewAdmissionWeightChange = (val: string) => { invalidateBatchState(); previewAdmissionWeightRef.current = val; setPreviewAdmissionWeightKey(val); };
  const handlePreviewDischargeChange = (val: string) => { invalidateBatchState(); previewDischargeRef.current = val; setPreviewDischargeKey(val); };
  const handlePreviewNewTechChange = (val: string) => { invalidateBatchState(); previewNewTechniqueRef.current = val; setPreviewNewTechniqueKey(val); };
  const handlePreviewIntensiveCareChange = (val: string) => { invalidateBatchState(); previewIntensiveCareRef.current = val; setPreviewIntensiveCareKey(val); };
  const handlePreviewIcuHoursChange = (val: string) => { invalidateBatchState(); previewIcuHoursRef.current = val; setPreviewIcuHoursKey(val); };
  const handlePreviewCrrtHoursChange = (val: string) => { invalidateBatchState(); previewCrrtHoursRef.current = val; setPreviewCrrtHoursKey(val); };
  const handlePreviewLengthOfStayChange = (val: string) => { invalidateBatchState(); previewLengthOfStayRef.current = val; setPreviewLengthOfStayKey(val); };
  const handlePreviewDaySurgeryChange = (val: string) => { invalidateBatchState(); previewDaySurgeryRef.current = val; setPreviewDaySurgeryKey(val); };
  const handlePreviewGenderChange = (val: string) => { invalidateBatchState(); previewGenderRef.current = val; setPreviewGenderKey(val); };
  // Track inputs that failed normalization so we can inspect and iterate on heuristics
  const failedNormalizationRef = useRef<Map<string, NormalizationMiss>>(new Map());

  // State to render normalization misses in the UI. We update this whenever
  // `batchLog` changes since misses are logged there when first observed.
  const [normMisses, setNormMisses] = useState<NormalizationMissView[]>([]);

  // Helper: clear recorded normalization misses (used in several UI flows)
  const clearNormalizationMisses = useCallback(() => {
    failedNormalizationRef.current = new Map();
    setNormMisses([]);
  }, []);

  const {
    buildNormMissesArray,
    normalizeEntriesNoUI,
    cleanCell,
    getMappingKeys,
    detectDelimiterForColumn,
  } = useBatchMappingHelpers({
    searchSource,
    version: ruleVersion,
    codeIndexRevision,
    previewIdRef,
    previewDiagsRef,
    previewProcsRef,
    previewAgeRef,
    previewAgeDaysRef,
    previewBirthWeightRef,
    previewAdmissionWeightRef,
    previewDischargeRef,
    previewNewTechniqueRef,
    previewIntensiveCareRef,
    previewIcuHoursRef,
    previewCrrtHoursRef,
    previewLengthOfStayRef,
    previewDaySurgeryRef,
    previewGenderRef,
    failedNormalizationRef,
    setNormMisses,
  });

  const {
    handleFileUpload,
    handleRemoveFile,
    handleGroupBatch,
    handleDownload,
  } = useBatchHandlers({
    searchSource,
    batchFormat,
    version: ruleVersion,
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
  });

    const batchUi = {
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
      batchDelimiterOption,
      batchCustomDelimiter,
      batchData,
      parseTimeMs,
      parsingInProgress,
      parseError,
      batchResults,
      batchTimeMs,
    };

    const batchActions = {
      handleFileUpload,
      handleRemoveFile,
      handlePreviewIdChange,
      setPreviewDiagsCollapsed,
      setDiagDelimiterOption: handleDiagDelimiterOptionChange,
      setDiagCustomDelimiter: handleDiagCustomDelimiterChange,
      handlePreviewDiagsChange,
      setHeaderFilterDiag,
      setHeaderFilterDiagIsRegex,
      setPreviewProcsCollapsed,
      setProcDelimiterOption: handleProcDelimiterOptionChange,
      setProcCustomDelimiter: handleProcCustomDelimiterChange,
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
      setBatchDelimiterOption: handleBatchDelimiterOptionChange,
      setBatchCustomDelimiter: handleBatchCustomDelimiterChange,
      setBatchFormat: handleBatchFormatChange,
      handleGroupBatch,
      handleDownload,
    };



  /* `batchLog` state removed — operational messages are logged directly to the console. */

  return (
    <div style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, boxSizing: 'border-box' }}>
      <div className="w-full h-full dark-surface rounded-xl shadow-lg overflow-auto m-0 p-0 flex flex-col">
        <header className="bg-blue-600 p-6 text-white flex items-center justify-between flex-shrink-0">
          <div>
            <h1 className="text-3xl font-bold">DRG Grouper</h1>
            <p className="opacity-90">Diagnosis Related Group Assignment Engine</p>
          </div>

          <div className="flex items-center gap-4">
            <label className="inline-flex items-center cursor-pointer select-none">
              <input
                type="checkbox"
                checked={searchSource === 'YB'}
                onChange={(e) => handleSearchSourceChange(e.target.checked ? 'YB' : 'GL')}
                className="sr-only"
                aria-label="使用医保码"
              />
              <span className={`relative inline-block h-5 w-10 rounded-full transition-colors duration-200 ease-in-out ${searchSource === 'YB' ? 'bg-blue-400' : 'bg-gray-600'}`}>
                <span className={`absolute left-1 top-0.5 h-4 w-4 bg-white rounded-full shadow transform transition-transform duration-200 ${searchSource === 'YB' ? 'translate-x-4' : 'translate-x-0'}`} />
              </span>
              <span className="ml-3 text-sm text-white">使用医保码</span>
            </label>
          </div>
        </header>

        <div className="flex border-b">
          <button
            onClick={() => setActiveTab('single')}
            className={`flex-1 p-4 font-semibold ${activeTab === 'single' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-300 hover:bg-opacity-10 hover:bg-white'}`}
          >
            Single Entry
          </button>
          {!isLite && (
            <>
              <button
                onClick={() => setActiveTab('batch')}
                className={`flex-1 p-4 font-semibold ${activeTab === 'batch' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-300 hover:bg-opacity-10 hover:bg-white'}`}
              >
                Batch Processing
              </button>
              <button
                onClick={() => setActiveTab('search')}
                className={`flex-1 p-4 font-semibold flex items-center justify-center gap-2 ${activeTab === 'search' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-300 hover:bg-opacity-10 hover:bg-white'}`}
              >
                <Search size={18} /> Code Search
              </button>
              <button
                onClick={() => {
                  setMdcTreeExpandToAdrg(false);
                  setActiveTab('tree');
                }}
                className={`flex-1 p-4 font-semibold ${activeTab === 'tree' ? 'text-blue-400 border-b-2 border-blue-400' : 'text-gray-300 hover:bg-opacity-10 hover:bg-white'}`}
              >
                MDC Tree
              </button>
            </>
          )}
        </div>

        <div className="p-6">
          <Suspense fallback={<div className="text-center text-gray-400">Loading...</div>}>
            <div className={activeTab === 'single' ? '' : 'hidden'}>
              <div className="px-4 pt-3 flex items-center gap-2">
                <label htmlFor="rule-version" className="text-sm text-gray-500">DRG版本</label>
                <select id="rule-version" value={ruleVersion} onChange={(e) => handleRuleVersionChange(e.target.value)} className="border rounded px-2 py-1 text-sm">
                  {listRuleVersions().map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </div>
              <SingleTab
                searchSource={searchSource}
                lite={isLite}
                version={ruleVersion}
                codeIndexRevision={codeIndexRevision}
                onViewInMdcTree={isLite ? undefined : handleViewInMdcTree}
              />
            </div>
            {activeTab === 'batch' && BatchTab ? (
              <BatchTab
                batchUi={batchUi}
                batchActions={batchActions}
                ruleVersion={ruleVersion}
                ruleVersions={listRuleVersions()}
                onRuleVersionChange={handleRuleVersionChange}
              />
            ) : activeTab === 'search' && SearchTab ? (
              <SearchTab searchSource={searchSource} version={ruleVersion} codeIndexRevision={codeIndexRevision} />
            ) : activeTab === 'tree' && MdcTreeTab ? (
              <MdcTreeTab
                version={ruleVersion}
                queryInput={mdcTreeQuery}
                onQueryInputChange={setMdcTreeQuery}
                autoExpandToAdrg={mdcTreeExpandToAdrg}
              />
            ) : null}
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export default App;
