export type PatientInfoDisplayGroup = 'basic' | 'advanced';
export type PatientInfoFieldKind =
  | 'gender'
  | 'nonNegativeInteger'
  | 'dischargeStatus'
  | 'boolean';

export interface PatientInfoFieldDefinition {
  key: string;
  displayGroup: PatientInfoDisplayGroup;
  kind: PatientInfoFieldKind;
  minimum?: number;
  weightMarker?: string;
  conditionPattern?: string;
}

export const PATIENT_INFO_FIELD_DEFINITIONS = Object.freeze([
  { key: 'gender', displayGroup: 'basic', kind: 'gender' },
  { key: 'age', displayGroup: 'basic', kind: 'nonNegativeInteger', minimum: 0 },
  { key: 'ageInDays', displayGroup: 'basic', kind: 'nonNegativeInteger', minimum: 0 },
  {
    key: 'birthWeight',
    displayGroup: 'basic',
    kind: 'nonNegativeInteger',
    minimum: 1,
    weightMarker: '出生体重',
  },
  {
    key: 'admissionWeight',
    displayGroup: 'basic',
    kind: 'nonNegativeInteger',
    minimum: 1,
    weightMarker: '入院体重',
  },
  {
    key: 'dischargeStatus',
    displayGroup: 'advanced',
    kind: 'dischargeStatus',
    conditionPattern: '^DEATH$',
  },
  {
    key: 'newTechnique',
    displayGroup: 'advanced',
    kind: 'boolean',
    conditionPattern: '^NEW_TECHNIQUE$',
  },
  {
    key: 'intensiveCare',
    displayGroup: 'advanced',
    kind: 'boolean',
    conditionPattern: '^INTENSIVE_CARE$',
  },
  {
    key: 'icuHours',
    displayGroup: 'advanced',
    kind: 'nonNegativeInteger',
    minimum: 0,
    conditionPattern: '^ICU_HOURS_',
  },
  {
    key: 'crrtHours',
    displayGroup: 'advanced',
    kind: 'nonNegativeInteger',
    minimum: 0,
    conditionPattern: '^CRRT_HOURS_',
  },
  {
    key: 'lengthOfStay',
    displayGroup: 'advanced',
    kind: 'nonNegativeInteger',
    minimum: 0,
    conditionPattern: '^LOS_',
  },
  {
    key: 'daySurgery',
    displayGroup: 'advanced',
    kind: 'boolean',
    conditionPattern: '^DAY_SURGERY$',
  },
] as const satisfies readonly PatientInfoFieldDefinition[]);

export type PatientInfoFieldKey = typeof PATIENT_INFO_FIELD_DEFINITIONS[number]['key'];

export const PATIENT_INFO_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS.map(({ key }) => key),
);

export const PATIENT_BOOLEAN_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ kind }) => kind === 'boolean')
  .map(({ key }) => key),
);

export const PATIENT_NUMERIC_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ kind }) => kind === 'nonNegativeInteger')
    .map(definition => [
      definition.key,
      'minimum' in definition ? definition.minimum : 0,
    ] as const),
) as readonly (readonly [PatientInfoFieldKey, number])[];
