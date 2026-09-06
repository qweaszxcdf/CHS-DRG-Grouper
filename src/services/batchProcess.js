/**
 * batchProcess helpers — kept pure and dependency-injectable.
 *
 * Exports:
 *  - loadParsedFile(parsedRows, opts)
 *  - processBatch(rows, opts)
 *
 * Both functions are intentionally small and accept injected helpers (normalizer, mapping helper, converter)
 * so they remain testable and free of UI side-effects.
 */

const DEFAULT_CHUNK_SIZE = 2000;
const DELIMITER_BY_OPTION = Object.freeze({
  PIPE: '|',
  COMMA: ',',
  SEMICOLON: ';',
  TAB: '\t',
  PLUS: '+',
});
function mapOptionToChar(opt, custom) {
  if (opt === 'CUSTOM') return custom || '|';
  return DELIMITER_BY_OPTION[opt] || custom || '|';
}
const toCodeList = (value) => Array.isArray(value) ? value : (value ? [value] : []);

const PATIENT_INFO_FIELD_MAPPINGS = Object.freeze([
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
export function extractMappedPatientInfo(row, mapping, cleanCell) {
  const info = {};
  for (const [field, mappingKey] of PATIENT_INFO_FIELD_MAPPINGS) {
    try {
      const sourceKey = mapping?.[mappingKey];
      const raw = sourceKey ? cleanCell(row?.[sourceKey]) : '';
      const value = raw == null ? '' : String(raw).trim();
      if (value !== '') info[field] = value;
    } catch {
      // Optional patient-info fields should not prevent the row from loading.
    }
  }
  return info;
}


// `buildPatientInfoFromRow` removed — logic inlined into `loadParsedFile` to reduce indirection


/**
 * Load parsed CSV/Excel rows (objects) and convert to normalized batch records.
 * Keeps the same signature and return shape as before.
 */
export function loadParsedFile(parsedRows, { delimiterOption = 'PIPE', customDelimiter = '|', diagDelimiterOption, diagCustomDelimiter, procDelimiterOption, procCustomDelimiter, uploadedBatchFileName = 'file', getMappingKeys, cleanCell, normalizeEntries } = {}) {
  const startTime = Date.now();
  if (!parsedRows || !Array.isArray(parsedRows)) return { normalized: [], logs: ['no parsed rows'] };

  // Global default delimiter (legacy)
  const globalDelimiter = mapOptionToChar(delimiterOption, customDelimiter);
  // Per-field delimiters (fall back to globalDelimiter when not provided)
  const diagDelimiter = mapOptionToChar(diagDelimiterOption || delimiterOption, diagCustomDelimiter || customDelimiter);
  const procDelimiter = mapOptionToChar(procDelimiterOption || delimiterOption, procCustomDelimiter || customDelimiter);

  const sample = parsedRows[0] || {};
  const mapping = getMappingKeys ? getMappingKeys(sample) : {};

  const hasMappingKey = (k) => k && (Array.isArray(k) ? k.length > 0 : true);
  if (!hasMappingKey(mapping.diagsKey) || !hasMappingKey(mapping.procsKey)) {
    return { normalized: [], logs: ['Missing diagnoses or procedures column mapping. Ensure uploaded file has headers and mapping is correct.'] };
  }

  // Support single mapping key (string) or multiple keys (array). For each matching
  // column, split by the configured delimiter for that field and flatten the values into a single array.
  const getColsAsArrayWithDelim = (row, keyOrKeys, delim) => {
    if (!keyOrKeys) return [];
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    const out = [];
    for (const k of keys) {
      if (row?.[k]) {
        const cell = String(cleanCell(row[k]));
        if (cell) out.push(...cell.split(delim).map(s => s.trim()).filter(Boolean));
      }
    }
    return out;
  };

  const normalized = new Array(parsedRows.length);
  for (let idx = 0; idx < parsedRows.length; idx++) {
    const row = parsedRows[idx];
    const idRaw = cleanCell(row?.[mapping.idKey] ?? '');
    const diagnosesRaw = getColsAsArrayWithDelim(row, mapping.diagsKey, diagDelimiter || globalDelimiter);
    const proceduresRaw = getColsAsArrayWithDelim(row, mapping.procsKey, procDelimiter || globalDelimiter);

    const diagnoses = normalizeEntries(diagnosesRaw, 'Diagnosis');
    const procedures = normalizeEntries(proceduresRaw, 'Procedure');

    // Copy raw patient-info fields; GrouperEngine owns normalization and validation.
    const info = extractMappedPatientInfo(row, mapping, cleanCell);
    const patientInfo = Object.keys(info).length ? info : undefined;

    const raw = idRaw && String(idRaw).trim();
    const id = raw && raw.length ? raw : `${uploadedBatchFileName || 'file'}-${idx + 1}`;
    const out = { id, diagnoses, procedures, diagnosesRaw, proceduresRaw };
    if (patientInfo) out.patientInfo = patientInfo;
    normalized[idx] = out;
  }

  const timeMs = Date.now() - startTime;
  const logs = [`Loaded ${normalized.length} records`, `Parsed file in ${timeMs} ms`];
  return { normalized, logs, timeMs };
}

/**
 * Process a batch of normalized rows using the injected `groupBatch` function.
 * Returns { results, logs, timeMs } — behavior unchanged.
 */
export async function processBatch(rows, { groupBatch, convertGLtoYBCode, searchSource } = {}) {
  if (!Array.isArray(rows)) return { results: [], logs: ['no rows to process'] };

  const startTime = Date.now();
  const allResults = [];
  const logs = [];
  const conversionApplied = (searchSource === 'GL');

  const diagCache = new Map();
  const procCache = new Map();

  if (conversionApplied) {
    const uniqueDiags = new Set();
    const uniqueProcs = new Set();
    for (const row of rows) {
      const diags = toCodeList(row.diagnoses);
      const procs = toCodeList(row.procedures);
      diags.forEach(d => d && uniqueDiags.add(d));
      procs.forEach(p => p && uniqueProcs.add(p));
    }
    uniqueDiags.forEach(code => diagCache.set(code, convertGLtoYBCode(code, false)));
    uniqueProcs.forEach(code => procCache.set(code, convertGLtoYBCode(code, true)));
  }

  const chunkSize = DEFAULT_CHUNK_SIZE;
  const totalRows = rows.length;

  let chunkCounter = 0;
  for (let chunkStart = 0; chunkStart < totalRows; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, totalRows);

    const chunkRows = new Array(chunkEnd - chunkStart);
    for (let i = chunkStart; i < chunkEnd; i++) {
      const row = rows[i];
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

    const chunkResults = groupBatch ? await groupBatch(chunkRows) : [];
    for (let i = 0; i < chunkResults.length; i++) {
      const result = chunkResults[i];
      const rowIdx = chunkStart + i;
      const origRow = rows[rowIdx];

      const origDiags = toCodeList(origRow.diagnoses);
      const origProcs = toCodeList(origRow.procedures);

      if (conversionApplied) {
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
