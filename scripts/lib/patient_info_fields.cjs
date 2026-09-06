const fs = require('fs');
const path = require('path');

const REQUIRED_PATIENT_INFO_FIELDS = Object.freeze([
  'gender',
  'age',
  'ageInDays',
  'birthWeight',
  'admissionWeight',
]);

const WEIGHT_PATIENT_INFO_FIELDS = Object.freeze([
  ['出生体重', 'birthWeight'],
  ['入院体重', 'admissionWeight'],
]);

const ADVANCED_PATIENT_INFO_FIELDS = Object.freeze([
  'dischargeStatus',
  'newTechnique',
  'intensiveCare',
  'icuHours',
  'crrtHours',
  'lengthOfStay',
  'daySurgery',
]);

const CONDITION_FIELD_PATTERNS = Object.freeze([
  { pattern: /^DEATH$/, field: 'dischargeStatus' },
  { pattern: /^NEW_TECHNIQUE$/, field: 'newTechnique' },
  { pattern: /^INTENSIVE_CARE$/, field: 'intensiveCare' },
  { pattern: /^ICU_HOURS_/, field: 'icuHours' },
  { pattern: /^CRRT_HOURS_/, field: 'crrtHours' },
  { pattern: /^LOS_/, field: 'lengthOfStay' },
  { pattern: /^DAY_SURGERY$/, field: 'daySurgery' },
]);

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
  REQUIRED_PATIENT_INFO_FIELDS,
  inferCommonPatientInfoFields,
  inferVersionPatientInfoFields,
};
