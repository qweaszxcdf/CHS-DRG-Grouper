const fs = require('fs');
const path = require('path');
require('tsx/cjs');
const { registerPatientNumericConditions } = require('../../src/types/patient_info_fields.ts');

const PATIENT_INFO_FIELD_DEFINITIONS = Object.freeze(
  require('../../src/types/patient_info_fields.ts').PATIENT_INFO_FIELD_DEFINITIONS
    .map(field => Object.freeze(field)),
);

const REQUIRED_PATIENT_INFO_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ displayGroup }) => displayGroup === 'basic')
    .map(({ key }) => key),
);

const WEIGHT_PATIENT_INFO_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ weightMarker }) => weightMarker)
    .map(({ weightMarker, key }) => [weightMarker, key]),
);

const ADVANCED_PATIENT_INFO_FIELDS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ displayGroup }) => displayGroup === 'advanced')
    .map(({ key }) => key),
);

const CONDITION_FIELDS = Object.freeze(Object.fromEntries(
  PATIENT_INFO_FIELD_DEFINITIONS.flatMap(({ condition, kind, key }) => (
    condition && kind !== 'nonNegativeInteger' ? [[condition.token, key]] : []
  )),
));

function readJson(filePath, description) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${filePath}`, { cause: error });
  }
  if (!Array.isArray(value)) {
    throw new Error(`${description} must contain an array: ${filePath}`);
  }
  return value;
}

function collectRuleFields(rules, fields) {
  const numericConditions = registerPatientNumericConditions(rules, PATIENT_INFO_FIELD_DEFINITIONS);
  for (const rule of rules) {
    for (const condition of rule.conditions || []) {
      if (Object.hasOwn(numericConditions, condition)) fields.add(numericConditions[condition].field);
      if (Object.hasOwn(CONDITION_FIELDS, condition)) fields.add(CONDITION_FIELDS[condition]);
    }
  }
}

function inferWeightPatientInfoFields(rules) {
  const fields = new Set();
  for (const rule of rules) {
    const text = [rule.name, rule.description, rule.filename]
      .filter(Boolean)
      .join(' ');
    for (const [marker, field] of WEIGHT_PATIENT_INFO_FIELDS) {
      if (text.includes(marker)) fields.add(field);
    }
  }
  return fields;
}

function buildPatientInfoConfig(advanced) {
  return Object.freeze({
    basic: Object.freeze([]),
    advanced: Object.freeze(
      ADVANCED_PATIENT_INFO_FIELDS.filter(field => advanced.has(field)),
    ),
  });
}

function filterBasicPatientInfoFields(weightFields) {
  return Object.freeze(
    REQUIRED_PATIENT_INFO_FIELDS.filter(
      field => !WEIGHT_PATIENT_INFO_FIELDS.some(([, weightField]) => weightField === field)
        || weightFields.has(field),
    ),
  );
}

function inferCommonPatientInfoFields({ commonDir, commonPackageId }) {
  const adrgRules = readJson(
    path.join(commonDir, commonPackageId, 'generated/adrg_rules.json'),
    `${commonPackageId} ADRG rules`,
  );
  const advanced = new Set();
  collectRuleFields(adrgRules, advanced);
  const weightFields = inferWeightPatientInfoFields(adrgRules);

  return Object.freeze({
    basic: filterBasicPatientInfoFields(weightFields),
    advanced: buildPatientInfoConfig(advanced).advanced,
  });
}

function inferVersionPatientInfoFields({ versionsDir, versionId }) {
  const subgroupRules = readJson(
    path.join(versionsDir, versionId, 'generated/drg_rules.json'),
    `${versionId} DRG rules`,
  );
  const advanced = new Set();
  collectRuleFields(subgroupRules, advanced);

  return buildPatientInfoConfig(advanced);
}

module.exports = {
  ADVANCED_PATIENT_INFO_FIELDS,
  PATIENT_INFO_FIELD_DEFINITIONS,
  REQUIRED_PATIENT_INFO_FIELDS,
  inferCommonPatientInfoFields,
  inferVersionPatientInfoFields,
};
