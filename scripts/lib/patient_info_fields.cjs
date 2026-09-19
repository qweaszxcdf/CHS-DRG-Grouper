const fs = require('fs');
const path = require('path');
require('tsx/cjs');

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

const CONDITION_FIELD_PATTERNS = Object.freeze(
  PATIENT_INFO_FIELD_DEFINITIONS
    .filter(({ conditionPattern }) => conditionPattern)
    .map(({ conditionPattern, key }) => ({ pattern: new RegExp(conditionPattern), field: key })),
);

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
  for (const rule of rules) {
    for (const condition of rule.conditions || []) {
      const match = CONDITION_FIELD_PATTERNS.find(({ pattern }) => pattern.test(condition));
      if (match) fields.add(match.field);
    }
    const ruleDetails = rule.adrgRule || rule.rule;
    if (ruleDetails?.intensiveCare === true) fields.add('intensiveCare');
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
