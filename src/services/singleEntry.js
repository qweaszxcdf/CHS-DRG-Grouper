import { groupPatient } from './groupingGateway.ts';

const MAX_COMBOS = 720;

const PATIENT_INFO_FIELDS = Object.freeze([
  'gender',
  'age',
  'ageInDays',
  'birthWeight',
  'admissionWeight',
  'icuHours',
  'crrtHours',
  'lengthOfStay',
  'dischargeStatus',
  'newTechnique',
  'intensiveCare',
  'daySurgery',
]);
const toCodeList = (codes) => (Array.isArray(codes) ? codes : []).filter(Boolean);

// Build a patientInfo object from UI-supplied fields (pure helper)
export function buildPatientInfo({ gender, age, ageInDays, birthWeight, admissionWeight, dischargeStatus, newTechnique, intensiveCare, icuHours, crrtHours, lengthOfStay, daySurgery }) {
  const patientInfo = {};

  // Preserve supplied values so the shared grouper owns normalization and validation.
  const preserveInput = (field, value) => {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return;
    patientInfo[field] = value;
  };

  const inputs = { gender, age, ageInDays, birthWeight, admissionWeight, icuHours, crrtHours, lengthOfStay, dischargeStatus, newTechnique, intensiveCare, daySurgery };
  for (const field of PATIENT_INFO_FIELDS) preserveInput(field, inputs[field]);
  return patientInfo;
}

// Group a single entry. Returns an object that mirrors previous App logic but is pure.
export async function groupSingle(diagnoses, procedures, patientInfo, searchSource, version) {
  const filteredDiagnoses = toCodeList(diagnoses);
  const filteredProcedures = toCodeList(procedures);

  const conversionApplied = searchSource === 'GL';
  const finalRes = await groupPatient(filteredDiagnoses, filteredProcedures, patientInfo, version, searchSource) || {};
  const convertedDiagnoses = Array.isArray(finalRes.diagnosesConverted) ? finalRes.diagnosesConverted : filteredDiagnoses;
  const convertedProcedures = Array.isArray(finalRes.proceduresConverted) ? finalRes.proceduresConverted : filteredProcedures;

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
export async function groupAllOrders(diagnoses, procedures, patientInfo, searchSource, version) {
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
  const totalCombos = diagPerms.length * procPerms.length;
  const results = [];
  const seen = new Map(); // map resultKey -> index in results
  let processed = 0;

  outer: for (let i = 0; i < diagPerms.length; i++) {
    for (let j = 0; j < procPerms.length; j++) {
      if (processed >= MAX_COMBOS) break outer;
      const diagOrder = diagPerms[i];
      const procOrder = procPerms[j];

      const res = await groupPatient(diagOrder, procOrder, patientInfo, version, searchSource) || {};
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
