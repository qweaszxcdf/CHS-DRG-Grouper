import { toCodeList } from '../types/grouper.ts';
import type { CodeListInput, VersionId } from '../types/grouper.ts';
// Helpers to convert GL-formatted ICD codes to canonical YB codes
// This module centralizes conversion logic so callers (e.g., App.tsx) can convert before grouping.
import { getGLData, preloadGLData } from './glDataLoader.ts';

export { preloadGLData };

export function convertGLtoYBCode(code: string, isProcedure = false, version?: VersionId): string {
  const key = code.trim();
  const data = getGLData(version);
  const icdGlToYb = data?.icdGlToYbRaw?.mapping || data?.icdGlToYbRaw || {};
  const icd9GlToYb = data?.icd9GlToYbRaw?.mapping || data?.icd9GlToYbRaw || {};
  // Exact mapping only: return mapping if present, otherwise return original trimmed code
  if (!isProcedure && Object.prototype.hasOwnProperty.call(icdGlToYb, key)) {
    return icdGlToYb[key]!;
  }
  if (isProcedure && Object.prototype.hasOwnProperty.call(icd9GlToYb, key)) {
    return icd9GlToYb[key]!;
  }
  return key;
}

export function convertDiagnosesArray(arr: CodeListInput, version?: VersionId): string[] {
  return toCodeList(arr).map((d) => convertGLtoYBCode(d, false, version));
}

export function convertProceduresArray(arr: CodeListInput, version?: VersionId): string[] {
  return toCodeList(arr).map((p) => convertGLtoYBCode(p, true, version));
}

export default {
  convertGLtoYBCode,
  convertDiagnosesArray,
  convertProceduresArray
};
