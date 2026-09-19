import Papa from 'papaparse';
import * as XLSX from 'xlsx';

interface ParseRequest {
  action?: string;
  name?: string;
  buffer?: ArrayBuffer;
  isExcel?: boolean;
  header?: boolean;
}

interface ParseResponse {
  success: boolean;
  name?: string;
  meta?: Record<string, unknown>;
  data?: unknown[];
  sample?: unknown[];
  error?: string;
  errors?: Array<Record<string, unknown>>;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  postMessage(message: ParseResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = async (e) => {
  const { action } = e.data || {};
  if (action === 'parse') {
    const { name = '', buffer, isExcel = false, header } = e.data;
    try {
      if (!buffer) {
        workerScope.postMessage({ success: false, name, error: 'The uploaded file buffer is missing.' });
        return;
      }
      let rawText = '';
      if (isExcel) {
        // XLSX can read ArrayBuffer directly
        const wb = XLSX.read(buffer, { type: 'array' });
        const first = wb.SheetNames[0];
        const sheet = first ? wb.Sheets[first] : undefined;
        rawText = sheet ? XLSX.utils.sheet_to_csv(sheet) : '';
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
      const hasHeader = hdrParse.data.length > 0 && typeof hdrParse.data[0] === 'object' && !Array.isArray(hdrParse.data[0]) && (hdrParse.meta.fields?.length ?? 0) > 0;

      // Only fallback to header:false when caller did not require headered parsing.
      if (header !== true && !hasHeader) {
        results = Papa.parse(rawText, { header: false, skipEmptyLines: true });
      }

      const parseErrors = results.errors.filter((error) => !(error.type === 'Delimiter' && error.code === 'UndetectableDelimiter'));
      if (parseErrors.length > 0) {
        const details = parseErrors.slice(0, 10).map((error) => ({
          type: error.type || 'Parse',
          code: error.code || 'ParseError',
          message: error.message || 'Unable to parse file',
          row: Number.isInteger(error.row) ? error.row : null,
        }));
        const summary = details.map((error) => `${error.row == null ? '' : `row ${error.row + 1}: `}${error.message}`).join('; ');
        workerScope.postMessage({ success: false, name, error: summary, errors: details });
        return;
      }

      if (results.data.length === 0) {
        workerScope.postMessage({ success: false, name, error: 'The uploaded file contains no data rows.', errors: [] });
        return;
      }

      // Send back only essential pieces to avoid heavy structured cloning overhead
      const sample = results.data.slice(0, 20);
      workerScope.postMessage({ success: true, name, meta: results.meta, data: results.data, sample }, []);
    } catch (err) {
      workerScope.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
};
