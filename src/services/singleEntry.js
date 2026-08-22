import { convertDiagnosesArray, convertProceduresArray } from './CodeConversion';
import { preloadGLData } from './glDataLoader.js';
import { groupPatientByVersion } from './versionedGrouper.ts';

const PATIENT_INFO_FIELDS = Object.freeze([
  'gender',
  'age',
  'ageInDays',
  'birthWeight',
  'icuHours',
  'crrtHours',
  'lengthOfStay',
  'dischargeStatus',
  'newTechnique',
  'multiSite',
  'intensiveCare',
  'daySurgery',
]);
const toCodeList = (codes) => (Array.isArray(codes) ? codes : []).filter(Boolean);

function createCodeMapper(codes, converter, version) {
  const converted = converter(codes, version);
  const map = new Map();
  for (let i = 0; i < codes.length; i++) map.set(codes[i], converted[i]);
  return (items) => items.map((code) => (map.has(code) ? map.get(code) : code));
}

// Build a patientInfo object from UI-supplied fields (pure helper)
export function buildPatientInfo({ gender, age, ageInDays, birthWeight, dischargeStatus, newTechnique, multiSite, intensiveCare, icuHours, crrtHours, lengthOfStay, daySurgery }) {
  const patientInfo = {};

  // Preserve supplied values so the shared grouper owns normalization and validation.
  const preserveInput = (field, value) => {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return;
    patientInfo[field] = value;
  };

  const inputs = { gender, age, ageInDays, birthWeight, icuHours, crrtHours, lengthOfStay, dischargeStatus, newTechnique, multiSite, intensiveCare, daySurgery };
  for (const field of PATIENT_INFO_FIELDS) preserveInput(field, inputs[field]);
  return patientInfo;
}

// Group a single entry. Returns an object that mirrors previous App logic but is pure.
export async function groupSingle(diagnoses, procedures, patientInfo, searchSource, version) {
  if (searchSource === 'GL') await preloadGLData(version);
  const filteredDiagnoses = toCodeList(diagnoses);
  const filteredProcedures = toCodeList(procedures);

  const conversionApplied = searchSource === 'GL';
  const convertedDiagnoses = conversionApplied ? convertDiagnosesArray(filteredDiagnoses, version) : filteredDiagnoses;
  const convertedProcedures = conversionApplied ? convertProceduresArray(filteredProcedures, version) : filteredProcedures;

  const finalRes = await groupPatientByVersion(convertedDiagnoses, convertedProcedures, patientInfo, version) || {};

  return {
    finalRes,
    diagnoses: filteredDiagnoses,
    procedures: filteredProcedures,
    diagnosesConverted: convertedDiagnoses,
    proceduresConverted: convertedProcedures,
    conversionApplied,
    patientInfo
  };
}

// Compute permutation results across diagnoses/procedures (pure function)
export async function groupAllOrders(diagnoses, procedures, patientInfo, searchSource, maxCombos = 720, version) {
  if (searchSource === 'GL') await preloadGLData(version);
  const filteredDiagnoses = toCodeList(diagnoses);
  const filteredProcedures = toCodeList(procedures);

  // Inline permutation generator (principal-first, canonicalized secondaries)
  const generatePerms = (items) => {
    if (!items || items.length === 0) return [[]];
    if (items.length === 1) return [items.slice()];

    const perms = [];
    const seenKeys = new Set();

    for (let k = 0; k < items.length; k++) {
      const principal = items[k];
      const others = items.slice(0, k).concat(items.slice(k + 1));
      const canonicalOthers = others.slice().sort();
      const key = `${principal}|${canonicalOthers.join(',')}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        perms.push([principal, ...canonicalOthers]);
      }
    }

    return perms;
  };

  const diagPerms = generatePerms(filteredDiagnoses);
  const procPerms = generatePerms(filteredProcedures);
  const conversionApplied = searchSource === 'GL';
  const convertDiagnoses = conversionApplied
    ? createCodeMapper(filteredDiagnoses, convertDiagnosesArray, version)
    : (items) => items;
  const convertProcedures = conversionApplied
    ? createCodeMapper(filteredProcedures, convertProceduresArray, version)
    : (items) => items;

  const totalCombos = diagPerms.length * procPerms.length;
  const results = [];
  const seen = new Map(); // map resultKey -> index in results
  let processed = 0;

  outer: for (let i = 0; i < diagPerms.length; i++) {
    for (let j = 0; j < procPerms.length; j++) {
      if (processed >= maxCombos) break outer;
      const diagOrder = diagPerms[i];
      const procOrder = procPerms[j];

      const convertedDiagnoses = convertDiagnoses(diagOrder);
      const convertedProcedures = convertProcedures(procOrder);

      const res = await groupPatientByVersion(convertedDiagnoses, convertedProcedures, patientInfo, version) || {};
      if (res.error) {
        return {
          totalCombos,
          processed: processed + 1,
          results: [],
          error: res.error,
          description: res.description,
        };
      }
      const drgCode = String(res.drg || res.code || '').trim();
      const isQY = /QY$/.test(String(res.adrg || '')) || /QY$/.test(drgCode);
      const is0000 = drgCode === '0000';
      const resultKey = `${drgCode || 'NONE'}|${res.mdc || ''}|${res.adrg || ''}`;

      const entry = {
        key: resultKey,
        drg: res.drg || res.code,
        mdc: res.mdc,
        adrg: res.adrg,
        description: res.description,
        diagnoses: diagOrder.slice(),
        procedures: procOrder.slice(),
        raw: res,
        weight: res.weight,
        weightTier2: res.weightTier2
      };

      if (!isQY && !is0000) {
        if (!seen.has(resultKey)) {
          seen.set(resultKey, results.length);
          results.push({ summary: entry, examples: [entry] });
        } else {
          results[seen.get(resultKey)].examples.push(entry);
        }
      }

      processed++;
    }
  }

  return { totalCombos, processed, results };
}
