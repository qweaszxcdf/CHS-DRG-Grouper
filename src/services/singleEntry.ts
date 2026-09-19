import { groupPatient } from './groupingGateway.ts';
import { PATIENT_INFO_FIELDS } from '../types/patient_info_fields.ts';
import { toCodeList } from '../types/grouper.js';
import type { CodeListInput, PatientInfoInput, VersionId } from '../types/grouper.js';
import type { GroupingSource, PermutationResult, SingleGroupingResult } from '../types/single-entry.js';

const MAX_COMBOS = 720;

// Build a patientInfo object from UI-supplied fields (pure helper)
export function buildPatientInfo({ gender, age, ageInDays, birthWeight, admissionWeight, dischargeStatus, newTechnique, intensiveCare, icuHours, crrtHours, lengthOfStay, daySurgery }: PatientInfoInput): PatientInfoInput {
  const patientInfo: PatientInfoInput = {};

  // Preserve supplied values so the shared grouper owns normalization and validation.
  const preserveInput = <K extends keyof PatientInfoInput>(field: K, value: PatientInfoInput[K]): void => {
    if (value == null || (typeof value === 'string' && value.trim() === '')) return;
    patientInfo[field] = value;
  };

  const inputs = { gender, age, ageInDays, birthWeight, admissionWeight, icuHours, crrtHours, lengthOfStay, dischargeStatus, newTechnique, intensiveCare, daySurgery };
  for (const field of PATIENT_INFO_FIELDS) preserveInput(field, inputs[field]);
  return patientInfo;
}

// Group a single entry. Returns an object that mirrors previous App logic but is pure.
export async function groupSingle(
  diagnoses: CodeListInput,
  procedures: CodeListInput,
  patientInfo: PatientInfoInput,
  searchSource: GroupingSource,
  version: VersionId,
): Promise<SingleGroupingResult> {
  const filteredDiagnoses = toCodeList(diagnoses).filter(Boolean);
  const filteredProcedures = toCodeList(procedures).filter(Boolean);

  const conversionApplied = searchSource === 'GL';
  const finalRes = await groupPatient(filteredDiagnoses, filteredProcedures, patientInfo, version, searchSource);

  return {
    finalRes,
    diagnoses: filteredDiagnoses,
    procedures: filteredProcedures,
    diagnosesConverted: finalRes.diagnosesConverted,
    proceduresConverted: finalRes.proceduresConverted,
    conversionApplied,
    patientInfo
  };
}

// Compute permutation results across diagnoses/procedures (pure function)
export async function groupAllOrders(
  diagnoses: CodeListInput,
  procedures: CodeListInput,
  patientInfo: PatientInfoInput,
  searchSource: GroupingSource,
  version: VersionId,
): Promise<PermutationResult> {
  const filteredDiagnoses = toCodeList(diagnoses).filter(Boolean);
  const filteredProcedures = toCodeList(procedures).filter(Boolean);

  // Inline permutation generator (principal-first, canonicalized secondaries)
  const generatePerms = (items: string[]): string[][] => {
    if (items.length === 0) return [[]];
    if (items.length === 1) return [items.slice()];

    const perms: string[][] = [];
    const seenKeys = new Set();

    for (const [k, principal] of items.entries()) {
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
  const results: PermutationResult['results'] = [];
  const seen = new Map<string, number>(); // map resultKey -> index in results
  let processed = 0;

  outer: for (const diagOrder of diagPerms) {
    for (const procOrder of procPerms) {
      if (processed >= MAX_COMBOS) break outer;

      const res = await groupPatient(diagOrder, procOrder, patientInfo, version, searchSource);
      if (res.error) {
        return {
          totalCombos,
          processed: processed + 1,
          results: [],
          error: res.error,
          description: res.description,
        };
      }
      const drgCode = (res.drg ?? res.code ?? '').trim();
      const isQY = /QY$/.test(res.adrg ?? '') || /QY$/.test(drgCode);
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
        const resultIndex = seen.get(resultKey);
        if (resultIndex === undefined) {
          seen.set(resultKey, results.length);
          results.push({ summary: entry, examples: [entry] });
        } else {
          results[resultIndex]!.examples.push(entry);
        }
      }

      processed++;
    }
  }

  return { totalCombos, processed, results };
}
