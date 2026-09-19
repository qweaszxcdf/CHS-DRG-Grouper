import { createHospitalAdaptor } from './common.ts';

/** 卫统 N041 profile with BZYZSNL in days; month-based exports need preprocessing. */
export function createN041Adaptor(headers: readonly string[]) {
  return createHospitalAdaptor('N041', headers, {
    id: 'BAH',
    diagnoses: { principal: 'JBDM', repeated: /^JBDM(\d+)$/ },
    procedures: { principal: 'SSJCZBM1', repeated: /^SSJCZBM(\d+)$/, offset: -1 },
    patientInfo: {
      gender: 'XB',
      age: 'NL',
      ageInDays: 'BZYZSNL',
      birthWeight: 'XSECSTZ',
      admissionWeight: 'XSERYTZ',
      dischargeStatus: 'LYFS',
      lengthOfStay: 'SJZYTS',
    },
  });
}
