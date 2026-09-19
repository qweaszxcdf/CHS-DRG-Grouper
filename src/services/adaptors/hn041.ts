import { createHospitalAdaptor } from './common.ts';

/**
 * Shanghai's N041 extension. Each XY diagnosis slot has a disease code and
 * an optional additional code. Asterisk-suffixed additional codes are joined
 * to the disease code; morphology codes remain excluded from the DRG list.
 */
export function createHn041Adaptor(headers: readonly string[]) {
  return createHospitalAdaptor('HN041', headers, {
    id: 'BAH',
    diagnoses: { principal: 'XY_JBDM', repeated: /^XY_JBDM(\d+)$/ },
    diagnosisAdditionalCodes: { principal: 'XY_FJBM', repeated: /^XY_FJBM(\d+)$/ },
    procedures: { principal: 'SSBM1_S', repeated: /^SSBM(\d+)_S$/, offset: -1 },
    patientInfo: {
      gender: 'XB',
      age: 'NL',
      ageInDays: 'BZYZSNLT',
      birthWeight: 'XSECSTZ',
      admissionWeight: 'XSERYTZ',
      dischargeStatus: 'LYFS',
      lengthOfStay: 'SJZYTS',
    },
  });
}
