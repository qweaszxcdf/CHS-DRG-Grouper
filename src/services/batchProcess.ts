/**
 * batchProcess helpers — kept pure and dependency-injectable.
 *
 * Exports:
 *  - delimiter constants/resolvers
 *  - loadParsedFile(parsedRows, opts)
 *  - processBatch(rows, opts)
 *
 * Both functions are intentionally small and accept injected helpers (normalizer, mapping helper, converter)
 * so they remain testable and free of UI side-effects.
 */

import { createBatchAdaptor } from './adaptors/index.ts';
import type {
  BatchCellCleaner,
  BatchEntryNormalizer,
  BatchInputFormat,
  BatchLoadResult,
  BatchMappingKeys,
  BatchProcessResult,
  BatchProcessRowResult,
  BatchRawRow,
  NormalizedBatchRow,
} from '../types/batch.ts';
import { toCodeList } from '../types/grouper.ts';
import type { BatchGroupingRow, PatientInfoInput } from '../types/grouper.ts';

const DEFAULT_CHUNK_SIZE = 2000;

export const DELIMITER_BY_OPTION = Object.freeze({
  PIPE: '|',
  COMMA: ',',
  SEMICOLON: ';',
  TAB: '\t',
  PLUS: '+',
});

export const AUTO_DETECT_DELIMITERS = Object.freeze(
  Object.values(DELIMITER_BY_OPTION),
);

export type BatchDelimiterOption = keyof typeof DELIMITER_BY_OPTION | 'CUSTOM';

export function resolveBatchDelimiter(option: BatchDelimiterOption | null | undefined, customDelimiter: string | null | undefined, fallback = '|'): string {
  if (option && option !== 'CUSTOM') return DELIMITER_BY_OPTION[option];
  return customDelimiter || fallback;
}

export function getDelimiterOptionForChar(delimiter: string): BatchDelimiterOption {
  for (const [option, value] of Object.entries(DELIMITER_BY_OPTION)) {
    if (value === delimiter) return option as keyof typeof DELIMITER_BY_OPTION;
  }
  return 'CUSTOM';
}

function mapOptionToChar(opt: BatchDelimiterOption | null | undefined, custom: string | null | undefined): string {
  return resolveBatchDelimiter(opt, custom, '|');
}

type PatientInfoMappingKey = Exclude<keyof BatchMappingKeys, 'idKey' | 'diagsKey' | 'procsKey'>;
const PATIENT_INFO_FIELD_MAPPINGS: ReadonlyArray<readonly [keyof PatientInfoInput, PatientInfoMappingKey]> = Object.freeze([
  ['age', 'ageKey'],
  ['ageInDays', 'ageDaysKey'],
  ['birthWeight', 'bwKey'],
  ['admissionWeight', 'admissionWeightKey'],
  ['dischargeStatus', 'dischargeKey'],
  ['gender', 'genderKey'],
  ['newTechnique', 'newTechKey'],
  ['intensiveCare', 'intensiveCareKey'],
  ['icuHours', 'icuHoursKey'],
  ['crrtHours', 'crrtHoursKey'],
  ['lengthOfStay', 'lengthOfStayKey'],
  ['daySurgery', 'daySurgeryKey'],
]);

/**
 * Extract mapped patient-info values without applying grouping semantics.
 * The same raw-value boundary is used by batch loading and the preview;
 * GrouperEngine remains responsible for normalization and validation.
 */
export function extractMappedPatientInfo(
  row: BatchRawRow,
  mapping: BatchMappingKeys,
  cleanCell: BatchCellCleaner,
): PatientInfoInput {
  const info: PatientInfoInput = {};
  for (const [field, mappingKey] of PATIENT_INFO_FIELD_MAPPINGS) {
    try {
      const sourceKey = mapping[mappingKey];
      const raw = sourceKey ? cleanCell(row[sourceKey]) : '';
      const value = raw.trim();
      if (value !== '') info[field] = value;
    } catch {
      // Optional patient-info fields should not prevent the row from loading.
    }
  }
  return info;
}

/**
 * Extract one or more mapped columns, split each cell by the configured
 * delimiter, and flatten the non-empty values. Preview and batch loading use
 * the same extraction boundary so they cannot silently diverge.
 */
export function getColsAsArrayWithDelim(
  row: BatchRawRow,
  keys: readonly string[] | null,
  delim: string,
  cleanCell: BatchCellCleaner,
): string[] {
  const out: string[] = [];
  for (const key of keys ?? []) {
    if (!Object.prototype.hasOwnProperty.call(row, key) || row[key] == null) continue;
    const cell = cleanCell(row[key]);
    if (cell) out.push(...cell.split(delim).map(value => value.trim()).filter(Boolean));
  }
  return out;
}


// `buildPatientInfoFromRow` removed — logic inlined into `loadParsedFile` to reduce indirection


/**
 * Load parsed CSV/Excel rows (objects) and convert to normalized batch records.
 * Keeps the same signature and return shape as before.
 *
 * @param {readonly BatchRawRow[]} parsedRows
 * @param {BatchLoadOptions} [options]
 */
export interface BatchLoadOptions {
  format?: BatchInputFormat;
  delimiterOption?: BatchDelimiterOption;
  customDelimiter?: string;
  diagDelimiterOption?: BatchDelimiterOption;
  diagCustomDelimiter?: string;
  procDelimiterOption?: BatchDelimiterOption;
  procCustomDelimiter?: string;
  uploadedBatchFileName?: string;
  getMappingKeys?: (sample: BatchRawRow) => BatchMappingKeys;
  cleanCell?: BatchCellCleaner;
  normalizeEntries?: BatchEntryNormalizer;
}

export function loadParsedFile(
  parsedRows: readonly BatchRawRow[],
  {
    format = 'MANUAL',
    delimiterOption = 'PIPE',
    customDelimiter = '|',
    diagDelimiterOption,
    diagCustomDelimiter,
    procDelimiterOption,
    procCustomDelimiter,
    uploadedBatchFileName = 'file',
    getMappingKeys,
    cleanCell,
    normalizeEntries,
  }: BatchLoadOptions = {},
): BatchLoadResult {
  const startTime = Date.now();

  const adaptor = createBatchAdaptor(format, Object.keys(parsedRows[0] || {}));
  if (adaptor) {
    const normalized = parsedRows.map((row, index) => {
      return adaptor.adapt(row, index);
    });
    const timeMs = Date.now() - startTime;
    return { normalized, logs: [`Loaded ${normalized.length} ${adaptor.format} records`], timeMs };
  }

  // Per-field delimiters inherit the global option/custom delimiter when unset.
  const diagDelimiter = mapOptionToChar(diagDelimiterOption || delimiterOption, diagCustomDelimiter || customDelimiter);
  const procDelimiter = mapOptionToChar(procDelimiterOption || delimiterOption, procCustomDelimiter || customDelimiter);

  const sample = parsedRows[0] || {};
  const mapping = getMappingKeys ? getMappingKeys(sample) : null;

  if (!mapping || !mapping.diagsKey?.length || !mapping.procsKey?.length) {
    return { normalized: [], logs: ['Missing diagnoses or procedures column mapping. Ensure uploaded file has headers and mapping is correct.'] };
  }

  const normalized: NormalizedBatchRow[] = new Array(parsedRows.length);
  const cellCleaner: BatchCellCleaner = cleanCell || ((value) => value == null ? '' : String(value));
  const entryNormalizer: BatchEntryNormalizer = normalizeEntries || ((values) => values);
  for (let idx = 0; idx < parsedRows.length; idx++) {
    const row = parsedRows[idx]!;
    const idRaw = cellCleaner(row[mapping.idKey] ?? '');
    const diagnosesRaw = getColsAsArrayWithDelim(row, mapping.diagsKey, diagDelimiter, cellCleaner);
    const proceduresRaw = getColsAsArrayWithDelim(row, mapping.procsKey, procDelimiter, cellCleaner);

    const diagnoses = entryNormalizer(diagnosesRaw, 'Diagnosis');
    const procedures = entryNormalizer(proceduresRaw, 'Procedure');

    // Copy raw patient-info fields; GrouperEngine owns normalization and validation.
    const info = extractMappedPatientInfo(row, mapping, cellCleaner);
    const patientInfo = Object.keys(info).length ? info : undefined;

    const raw = idRaw.trim();
    const id = raw || `${uploadedBatchFileName || 'file'}-${idx + 1}`;
    const out: NormalizedBatchRow = { id, diagnoses, procedures, diagnosesRaw, proceduresRaw };
    if (patientInfo) out.patientInfo = patientInfo;
    normalized[idx] = out;
  }

  const timeMs = Date.now() - startTime;
  const logs = [`Loaded ${normalized.length} records`, `Parsed file in ${timeMs} ms`];
  return { normalized, logs, timeMs };
}

/**
 * Process a batch of normalized rows using the required injected `groupBatch` function.
 * Returns { results, logs, timeMs }.
 *
 * @param {readonly NormalizedBatchRow[] | readonly BatchGroupingRow[]} rows
 * @param {BatchProcessOptions} options
 */
export interface BatchProcessOptions {
  groupBatch: (rows: BatchGroupingRow[]) => Promise<BatchProcessRowResult[]> | BatchProcessRowResult[];
  convertGLtoYBCode?: (code: string, isProcedure: boolean) => string;
  searchSource?: string;
}

export async function processBatch(
  rows: readonly NormalizedBatchRow[] | readonly BatchGroupingRow[],
  options: BatchProcessOptions,
): Promise<BatchProcessResult> {
  const { groupBatch, convertGLtoYBCode, searchSource } = options;

  const startTime = Date.now();
  const allResults: BatchProcessRowResult[] = [];
  const logs: string[] = [];
  const conversionApplied = (searchSource === 'GL');

  const diagCache = new Map<string, string>();
  const procCache = new Map<string, string>();

  if (conversionApplied) {
    const uniqueDiags = new Set<string>();
    const uniqueProcs = new Set<string>();
    for (const row of rows) {
      const diags = toCodeList(row.diagnoses);
      const procs = toCodeList(row.procedures);
      diags.forEach(d => d && uniqueDiags.add(d));
      procs.forEach(p => p && uniqueProcs.add(p));
    }
    if (convertGLtoYBCode) {
      uniqueDiags.forEach(code => diagCache.set(code, convertGLtoYBCode(code, false)));
      uniqueProcs.forEach(code => procCache.set(code, convertGLtoYBCode(code, true)));
    }
  }

  const chunkSize = DEFAULT_CHUNK_SIZE;
  const totalRows = rows.length;

  let chunkCounter = 0;
  for (let chunkStart = 0; chunkStart < totalRows; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, totalRows);

    const chunkRows: BatchGroupingRow[] = new Array(chunkEnd - chunkStart);
    for (let i = chunkStart; i < chunkEnd; i++) {
      const row = rows[i]!;
      const chunkIdx = i - chunkStart;
      const origDiags = toCodeList(row.diagnoses);
      const origProcs = toCodeList(row.procedures);

      const diagnoses = conversionApplied ? origDiags.map(d => diagCache.get(d) || d) : origDiags;
      const procedures = conversionApplied ? origProcs.map(p => procCache.get(p) || p) : origProcs;

      chunkRows[chunkIdx] = {
        ...row,
        id: row.id || `row-${i + 1}`,
        diagnoses,
        procedures,
        patientInfo: row.patientInfo || undefined,
      };
    }

    const chunkResults = await groupBatch(chunkRows);
    for (let i = 0; i < chunkResults.length; i++) {
      const result = chunkResults[i];
      if (!result) continue;
      const rowIdx = chunkStart + i;
      const origRow = rows[rowIdx] || {};

      const origDiags = toCodeList(origRow.diagnoses);
      const origProcs = toCodeList(origRow.procedures);

      if (conversionApplied || origRow.diagnosisCodes !== undefined) {
        result.original_diagnoses = origDiags;
        result.original_procedures = origProcs;
      }

      allResults.push(result);
    }

    // Yield periodically for responsiveness, but not after every chunk to avoid runtime overhead.
    chunkCounter++;
    if (totalRows > chunkSize && (chunkCounter % 4 === 0)) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const totalElapsed = Date.now() - startTime;
  logs.push(`Batch processing complete (${allResults.length} results) — total ${totalElapsed} ms`);
  return { results: allResults, logs, timeMs: totalElapsed };
}
