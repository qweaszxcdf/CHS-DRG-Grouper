import type { ComparisonOperator } from './rules.ts';

export type PatientInfoDisplayGroup = 'basic' | 'advanced';
export type PatientInfoFieldKind =
  | 'numericEnum'
  | 'nonNegativeInteger'
  | 'boolean';

export interface PatientInfoFieldDefinition {
  key: string;
  label: string;
  displayGroup: PatientInfoDisplayGroup;
  kind: PatientInfoFieldKind;
  minimum?: number;
  weightMarker?: string;
  condition?: { token: string; label: string } | { token: string; missingReason: string; value?: number };
  placeholder?: string;
  maximum?: number;
  checkboxId?: string;
  options?: readonly { value: number; label: string }[];
  allowOtherValues?: boolean;
  batch: {
    mappingKey: string;
    aliases: readonly string[];
    label?: string;
    match?: 'exact';
    excludePattern?: string;
  };
}

const builtinConditionTokens = new Set([
  'SPECIFIC_DIAGNOSIS', 'SPECIFIC_DIAGNOSIS_PREFIX',
  'SPECIFIC_PROCEDURE', 'SPECIFIC_PROCEDURE_PREFIX',
  'WITH_MCC', 'WITH_CC', 'NO_CC', 'ROBOT_ASSISTED_SURGERY', 'ADRG_ONLY',
]);
const NUMERIC_PATIENT_CONDITION_PATTERN = /^([A-Z][A-Z0-9_]*)_(LT|LE|GT|GE)_(\d+)$/;

function parseNumericExpression(token: string): { prefix: string; operator: ComparisonOperator; limit: number } | null {
  const match = token.match(NUMERIC_PATIENT_CONDITION_PATTERN);
  if (!match) return null;
  const limit = Number(match[3]);
  return Number.isFinite(limit) ? { prefix: match[1]!, operator: match[2] as ComparisonOperator, limit } : null;
}

function validatePatientInfoDefinitions(definitions: readonly PatientInfoFieldDefinition[]): void {
  const keys = new Set<string>();
  const mappingKeys = new Set<string>();
  const conditionTokens = new Set<string>();
  function registerToken(key: string, token: string) {
    if (builtinConditionTokens.has(token)) throw new Error(`Reserved patientInfo condition token for ${key}: ${token}`);
    if (conditionTokens.has(token)) throw new Error(`Duplicate patientInfo condition token: ${token} (field ${key})`);
    conditionTokens.add(token);
  }
  for (const { key, kind, batch, condition } of definitions) {
    if (keys.has(key)) throw new Error(`Duplicate patientInfo field key: ${key}`);
    keys.add(key);
    if (mappingKeys.has(batch.mappingKey)) throw new Error(`Duplicate patientInfo mappingKey: ${batch.mappingKey}`);
    mappingKeys.add(batch.mappingKey);
    if (condition) {
      if (kind === 'nonNegativeInteger') {
        if (!('label' in condition) || typeof condition.token !== 'string'
          || !/^[A-Z][A-Z0-9_]*$/.test(condition.token)) {
          throw new Error(`Numeric patientInfo condition for ${key} requires a dimension token`);
        }
      } else {
        if (!('token' in condition) || typeof condition.token !== 'string' || !condition.token) {
          throw new Error(`Fixed patientInfo condition for ${key} requires a token`);
        }
        if (NUMERIC_PATIENT_CONDITION_PATTERN.test(condition.token)) {
          throw new Error(`Numeric expression cannot be a fixed patientInfo condition for ${key}: ${condition.token}`);
        }
      }
      registerToken(key, condition.token);
    }
  }
}

export const PATIENT_INFO_FIELD_DEFINITIONS = Object.freeze([
  {
    key: 'gender', label: 'Gender', displayGroup: 'basic', kind: 'numericEnum',
    options: [{ value: 1, label: 'Male' }, { value: 2, label: 'Female' }],
    batch: { mappingKey: 'genderKey', aliases: ['gender', 'sex', 'patient_sex', 'gender_code', '性别', '性别代码'] },
  },
  {
    key: 'age', label: 'Age (years)', displayGroup: 'basic', kind: 'nonNegativeInteger', minimum: 0,
    placeholder: 'e.g. 30',
    condition: { token: 'AGE', label: 'Age' },
    batch: { mappingKey: 'ageKey', label: 'Age', match: 'exact', aliases: ['age', 'age_years', 'age_year', 'patient_age', 'patient_age_years', '年龄', '年龄岁', '岁'] },
  },
  {
    key: 'ageInDays', label: 'Age (days)', displayGroup: 'basic', kind: 'nonNegativeInteger', minimum: 0,
    placeholder: 'e.g. 20', maximum: 365,
    batch: { mappingKey: 'ageDaysKey', match: 'exact', aliases: ['ageindays', 'age_in_days', 'age_days', 'patient_age_in_days', 'patient_age_days', '年龄天数', '出生年龄天数', '出生年龄(天)'] },
  },
  {
    key: 'birthWeight',
    label: 'Birth weight (grams)',
    displayGroup: 'basic',
    kind: 'nonNegativeInteger',
    minimum: 1,
    weightMarker: '出生体重',
    placeholder: 'e.g. 3200',
    batch: { mappingKey: 'bwKey', label: 'Birth wt', aliases: ['birthweight', 'birth_weight', '出生体重', 'birth_weight_g', '体重'], excludePattern: '入院.*体重|admission[\\s_.():，\\u200B\\uFEFF-]*weight' },
  },
  {
    key: 'admissionWeight',
    label: 'Admission weight (grams)',
    displayGroup: 'basic',
    kind: 'nonNegativeInteger',
    minimum: 1,
    weightMarker: '入院体重',
    placeholder: 'e.g. 3200',
    batch: { mappingKey: 'admissionWeightKey', label: 'Admission wt', match: 'exact', aliases: ['admissionweight', 'admission_weight', 'admission-weight', '入院体重', 'admission_weight_g'] },
  },
  {
    key: 'dischargeStatus',
    label: 'Discharge Status',
    displayGroup: 'advanced',
    kind: 'numericEnum',
    condition: { token: 'DEATH', value: 5, missingReason: 'Outcome is not Death' },
    options: [{ value: 1, label: 'Alive' }, { value: 5, label: 'Dead' }],
    allowOtherValues: true,
    batch: { mappingKey: 'dischargeKey', label: 'Discharge', aliases: ['discharge', 'discharge_status', 'dischargeStatus', '出院状态', 'discharge_status'] },
  },
  {
    key: 'newTechnique',
    label: 'New Technique',
    displayGroup: 'advanced',
    kind: 'boolean',
    checkboxId: 'newtechnique-checkbox',
    condition: { token: 'NEW_TECHNIQUE', missingReason: 'NEW_TECHNIQUE required but not present' },
    batch: { mappingKey: 'newTechKey', aliases: ['new_technique', 'newtechnique', 'new-technique', '新技术', 'new technique', 'is_new_tech', 'newtech'] },
  },
  {
    key: 'intensiveCare',
    label: 'Intensive care',
    displayGroup: 'advanced',
    kind: 'boolean',
    checkboxId: 'intensive-care-checkbox',
    condition: { token: 'INTENSIVE_CARE', missingReason: 'Intensive care required but not present' },
    batch: { mappingKey: 'intensiveCareKey', match: 'exact', aliases: ['intensivecare', 'intensive_care', 'intensive-care', 'icu_flag', 'icu_status', '重症监护', '重症监护标志', '是否重症监护'] },
  },
  {
    key: 'icuHours',
    label: 'ICU duration (hours)',
    displayGroup: 'advanced',
    kind: 'nonNegativeInteger',
    minimum: 0,
    placeholder: 'e.g. 120',
    condition: { token: 'ICU_HOURS', label: 'ICU hours' },
    batch: { mappingKey: 'icuHoursKey', label: 'ICU hours', match: 'exact', aliases: ['icu_hours', 'icuhours', 'icu-hours', 'icu hour', 'icu hours', '重症监护小时', 'icu时长', 'icu小时'] },
  },
  {
    key: 'crrtHours',
    label: 'CRRT duration (hours)',
    displayGroup: 'advanced',
    kind: 'nonNegativeInteger',
    minimum: 0,
    placeholder: 'e.g. 24',
    condition: { token: 'CRRT_HOURS', label: 'CRRT hours' },
    batch: { mappingKey: 'crrtHoursKey', label: 'CRRT hours', match: 'exact', aliases: ['crrt_hours', 'crrthours', 'crrt-hours', 'crrt hour', 'crrt hours', '连续性肾脏替代治疗时长', 'crrt时长', 'crrt小时'] },
  },
  {
    key: 'lengthOfStay',
    label: 'Length of stay (days)',
    displayGroup: 'advanced',
    kind: 'nonNegativeInteger',
    minimum: 0,
    placeholder: 'e.g. 7',
    condition: { token: 'LOS', label: 'Length of stay' },
    batch: { mappingKey: 'lengthOfStayKey', label: 'Length of stay', aliases: ['length_of_stay', 'lengthofstay', 'length-of-stay', 'los', '住院日', '住院天数', '住院日数'] },
  },
  {
    key: 'daySurgery',
    label: 'Day surgery',
    displayGroup: 'advanced',
    kind: 'boolean',
    checkboxId: 'day-surgery-checkbox',
    condition: { token: 'DAY_SURGERY', missingReason: 'Day surgery required but not present' },
    batch: { mappingKey: 'daySurgeryKey', aliases: ['day_surgery', 'daysurgery', 'day-surgery', '日间手术', '日间手术标志', '日间'] },
  },
] as const satisfies readonly PatientInfoFieldDefinition[]);

// Validate once before deriving lookup tables; duplicate definitions must not overwrite each other.
validatePatientInfoDefinitions(PATIENT_INFO_FIELD_DEFINITIONS);

export type PatientInfoDefinition = typeof PATIENT_INFO_FIELD_DEFINITIONS[number];
export type PatientInfoFieldKey = PatientInfoDefinition['key'];
export type PatientInfoMappingKey = PatientInfoDefinition['batch']['mappingKey'];

// Widen optional metadata for consumers while retaining literal keys for derived types.
export const PATIENT_INFO_DEFINITIONS: readonly (PatientInfoFieldDefinition & {
  key: PatientInfoFieldKey;
  batch: PatientInfoFieldDefinition['batch'] & { mappingKey: PatientInfoMappingKey };
})[] = PATIENT_INFO_FIELD_DEFINITIONS;

export const PATIENT_NUMERIC_CONDITIONS = Object.freeze(Object.fromEntries(
  PATIENT_INFO_FIELD_DEFINITIONS.flatMap(field => (
    field.kind === 'nonNegativeInteger' && 'condition' in field
      ? [[field.condition.token, { field: field.key, label: field.condition.label }]]
      : []
  )),
));

interface RegisteredNumericCondition {
  field: string;
  label: string;
  operator: ComparisonOperator;
  limit: number;
}

type ConditionRules = readonly { conditions?: readonly string[] }[];

export function registerPatientNumericConditions(rules: ConditionRules, definitions: readonly PatientInfoFieldDefinition[] = PATIENT_INFO_DEFINITIONS) {
  if (definitions !== PATIENT_INFO_DEFINITIONS) validatePatientInfoDefinitions(definitions);
  const dimensions = new Map<string, { field: string; label: string }>();
  for (const { key, kind, condition } of definitions) {
    if (kind === 'nonNegativeInteger' && condition && 'label' in condition) {
      dimensions.set(condition.token, { field: key, label: condition.label });
    }
  }
  const registered: Record<string, RegisteredNumericCondition> = {};
  for (const rule of rules) {
    for (const token of rule.conditions ?? []) {
      if (Object.hasOwn(registered, token)) continue;
      const expression = parseNumericExpression(token);
      if (!expression) continue;
      const dimension = dimensions.get(expression.prefix);
      if (dimension) registered[token] = { ...dimension, operator: expression.operator, limit: expression.limit };
    }
  }
  return Object.freeze(registered);
}

export const PATIENT_BOOLEAN_CONDITIONS = Object.freeze(Object.fromEntries(
  PATIENT_INFO_FIELD_DEFINITIONS.flatMap(field => (
    field.kind === 'boolean' && 'condition' in field
      ? [[field.condition.token, { field: field.key, missingReason: field.condition.missingReason }]]
      : []
  )),
));

export const PATIENT_ENUM_CONDITIONS = Object.freeze(Object.fromEntries(
  PATIENT_INFO_FIELD_DEFINITIONS.flatMap(field => (
    field.kind === 'numericEnum' && 'condition' in field
      ? [[field.condition.token, { field: field.key, value: field.condition.value, missingReason: field.condition.missingReason }]]
      : []
  )),
));

export const PATIENT_INFO_FIELD_LABELS = Object.freeze(
  Object.fromEntries(PATIENT_INFO_FIELD_DEFINITIONS.map(({ key, label }) => [key, label])),
);

export const PATIENT_INFO_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS.map(({ key }) => key),
);

export const PATIENT_BOOLEAN_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ kind }) => kind === 'boolean')
    .map(({ key }) => key),
);

export const PATIENT_NUMERIC_ENUM_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS.flatMap(field => field.kind === 'numericEnum' ? [field] : []),
);

export const PATIENT_NUMERIC_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ kind }) => kind === 'nonNegativeInteger')
    .map(definition => [
      definition.key,
      'minimum' in definition ? definition.minimum : 0,
    ] as const),
);
