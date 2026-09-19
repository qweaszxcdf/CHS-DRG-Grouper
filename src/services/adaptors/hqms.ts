import { createHospitalAdaptor } from './common.ts';

/** HQMS field-code headers. Repeated columns are ordered by their slot number. */
export function createHqmsAdaptor(headers: readonly string[]) {
  return createHospitalAdaptor('HQMS', headers, {
    id: 'A48',
    diagnoses: { principal: 'C03C', repeated: /^C06X(\d+)C$/ },
    procedures: { principal: 'C14x01C', repeated: /^C35X(\d+)C$/ },
    patientInfo: {
      gender: 'A12C',
      age: 'A14',
      ageInDays: 'A16',
      birthWeight: 'A18x01',
      admissionWeight: 'A17',
      dischargeStatus: 'B34C',
      lengthOfStay: 'B20',
    },
  });
}
