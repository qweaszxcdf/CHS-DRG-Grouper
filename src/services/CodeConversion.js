// Helpers to convert GL-formatted ICD codes to canonical YB codes
// This module centralizes conversion logic so callers (e.g., App.jsx) can convert before grouping.
import { getGLData, preloadGLData } from './glDataLoader.js';

export { preloadGLData };

export function convertGLtoYBCode(code, isProcedure = false, version) {
  if (!code || typeof code !== 'string') return code;
  let key = String(code).trim();
  const data = getGLData(version);
  const icdGlToYb = data?.icdGlToYbRaw?.mapping || data?.icdGlToYbRaw || {};
  const icd9GlToYb = data?.icd9GlToYbRaw?.mapping || data?.icd9GlToYbRaw || {};
  // Exact mapping only: return mapping if present, otherwise return original trimmed code
  try {
    if (!isProcedure && icdGlToYb && Object.prototype.hasOwnProperty.call(icdGlToYb, key)) {
      return icdGlToYb[key];
    }
    if (isProcedure && icd9GlToYb && Object.prototype.hasOwnProperty.call(icd9GlToYb, key)) {
      return icd9GlToYb[key];
    }
    return key;
  } catch {
    return key;
  }
}

export function convertDiagnosesArray(arr, version) {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map((d) => convertGLtoYBCode(d, false, version));
}

export function convertProceduresArray(arr, version) {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map((p) => convertGLtoYBCode(p, true, version));
}

export default {
  convertGLtoYBCode,
  convertDiagnosesArray,
  convertProceduresArray
};
