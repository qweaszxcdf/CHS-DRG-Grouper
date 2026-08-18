import { convertDiagnosesArray, convertProceduresArray } from './CodeConversion';
import { preloadGLData } from './glDataLoader.js';
import { groupPatientByVersion } from './versionedGrouper.ts';

// Build a patientInfo object from UI-supplied fields (pure helper)
export function buildPatientInfo({ gender, age, ageInDays, birthWeight, dischargeStatus, newTechnique, multiSite, intensiveCare, icuHours, crrtHours, lengthOfStay, daySurgery }) {
  const patientInfo = {};
  if (gender) patientInfo.gender = gender;

  // Preserve explicitly supplied invalid values so the shared grouper
  // validator can report them instead of silently treating them as absent.
  const parseAndTrunc = (val) => {
    if (val === undefined || val === null || String(val).trim() === '') return undefined;
    const raw = String(val).trim();
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : raw;
  };

  const a = parseAndTrunc(age);
  if (a !== undefined) patientInfo.age = a;

  const aDays = parseAndTrunc(ageInDays);
  if (aDays !== undefined) patientInfo.ageInDays = aDays;

  const bw = parseAndTrunc(birthWeight);
  if (bw !== undefined) patientInfo.birthWeight = bw;

  const icu = parseAndTrunc(icuHours);
  if (icu !== undefined) patientInfo.icuHours = icu;

  const crrt = parseAndTrunc(crrtHours);
  if (crrt !== undefined) patientInfo.crrtHours = crrt;

  const los = parseAndTrunc(lengthOfStay);
  if (los !== undefined) patientInfo.lengthOfStay = los;

  if (dischargeStatus !== undefined && dischargeStatus !== null && dischargeStatus !== '')
    patientInfo.dischargeStatus = (String(dischargeStatus).trim() === '5') ? 'death' : String(dischargeStatus).trim();
  if (newTechnique) patientInfo.newTechnique = true;
  if (multiSite) patientInfo.multiSite = true;
  if (intensiveCare) patientInfo.intensiveCare = true;
  if (daySurgery) patientInfo.daySurgery = true;
  return patientInfo;
}

// Group a single entry. Returns an object that mirrors previous App logic but is pure.
export async function groupSingle(diagnoses, procedures, patientInfo, searchSource, version) {
  if (searchSource === 'GL') await preloadGLData(version);
  const filteredDiagnoses = Array.isArray(diagnoses) ? diagnoses.filter(Boolean) : [];
  const filteredProcedures = Array.isArray(procedures) ? procedures.filter(Boolean) : [];

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
  const filteredDiagnoses = Array.isArray(diagnoses) ? diagnoses.filter(Boolean) : [];
  const filteredProcedures = Array.isArray(procedures) ? procedures.filter(Boolean) : [];

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

  const totalCombos = diagPerms.length * procPerms.length;
  const results = [];
  const seen = new Map(); // map resultKey -> index in results
  let processed = 0;

  outer: for (let i = 0; i < diagPerms.length; i++) {
    for (let j = 0; j < procPerms.length; j++) {
      if (processed >= maxCombos) break outer;
      const diagOrder = diagPerms[i];
      const procOrder = procPerms[j];

      const convertedDiagnoses = conversionApplied ? convertDiagnosesArray(diagOrder, version) : diagOrder;
      const convertedProcedures = conversionApplied ? convertProceduresArray(procOrder, version) : procOrder;

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
