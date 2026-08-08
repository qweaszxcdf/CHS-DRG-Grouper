import Papa from 'papaparse';
import * as XLSX from 'xlsx';

self.onmessage = async (e) => {
  const { action } = e.data || {};
  if (action === 'parse') {
    const { name, buffer, isExcel, header } = e.data;
    try {
      let rawText = '';
      if (isExcel) {
        // XLSX can read ArrayBuffer directly
        const wb = XLSX.read(buffer, { type: 'array' });
        const first = wb.SheetNames && wb.SheetNames[0];
        rawText = first ? XLSX.utils.sheet_to_csv(wb.Sheets[first]) : '';
      } else {
        // CSV/text file
        rawText = new TextDecoder('utf-8').decode(buffer);
      }

      // Parse with header:true by default. If caller explicitly requested `header:true`,
      // respect that and DO NOT fall back to header:false. Otherwise, fall back when
      // the heuristic determines the file lacks a header row.
      const hdrParse = Papa.parse(rawText, { header: true, skipEmptyLines: true });
      let results = hdrParse;

      // Heuristic: if header parse produced objects with fields, assume header exists.
      const hasHeader = hdrParse && Array.isArray(hdrParse.data) && hdrParse.data.length > 0 && typeof hdrParse.data[0] === 'object' && !Array.isArray(hdrParse.data[0]) && hdrParse.meta && Array.isArray(hdrParse.meta.fields) && hdrParse.meta.fields.length > 0;

      if (header === true) {
        // Caller explicitly requested headered parsing; do not fallback even if heuristic failed.
        results = hdrParse;
      } else {
        // Only fallback to header:false when caller did not require headered parsing
        if (!hasHeader) {
          results = Papa.parse(rawText, { header: false, skipEmptyLines: true });
        }
      }

      const parseErrors = Array.isArray(results.errors)
        ? results.errors.filter((error) => !(error && error.type === 'Delimiter' && error.code === 'UndetectableDelimiter'))
        : [];
      if (parseErrors.length > 0) {
        const details = parseErrors.slice(0, 10).map((error) => ({
          type: error.type || 'Parse',
          code: error.code || 'ParseError',
          message: error.message || 'Unable to parse file',
          row: Number.isInteger(error.row) ? error.row : null,
        }));
        const summary = details.map((error) => `${error.row == null ? '' : `row ${error.row + 1}: `}${error.message}`).join('; ');
        self.postMessage({ success: false, name, error: summary, errors: details });
        return;
      }

      if (!Array.isArray(results.data) || results.data.length === 0) {
        self.postMessage({ success: false, name, error: 'The uploaded file contains no data rows.', errors: [] });
        return;
      }

      // Send back only essential pieces to avoid heavy structured cloning overhead
      const sample = Array.isArray(results.data) ? results.data.slice(0, 20) : [];
      self.postMessage({ success: true, name, meta: results.meta || {}, data: results.data, sample }, []);
    } catch (err) {
      self.postMessage({ success: false, error: err && err.message ? err.message : String(err) });
    }
  }
};
