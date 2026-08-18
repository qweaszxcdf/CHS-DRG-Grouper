import type {
  AdrgDefinition,
  AdrgRule,
  DrgMapEntry,
  DrgSubgroupRule,
  MdcRule,
  NameMapWithInitials,
  RuleData,
  RpnToken,
} from '../types/rules.js';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'boolean');
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function isPositiveIntegerRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => (
    typeof item === 'number' && Number.isInteger(item) && item >= 1
  ));
}

function isRpnToken(value: unknown): value is RpnToken {
  if (typeof value === 'string') return true;
  return isRecord(value) && value.type === 'SECTION' && typeof value.name === 'string';
}

function isAdrgRule(value: unknown): value is AdrgRule {
  if (!isRecord(value)) return false;
  if (value.logic !== undefined && typeof value.logic !== 'string') return false;
  if (value.sections !== undefined && !isStringArrayRecord(value.sections)) return false;
  if (value.sectionMinimumMatches !== undefined && !isPositiveIntegerRecord(value.sectionMinimumMatches)) return false;
  if (value._logicRPN !== undefined && (!Array.isArray(value._logicRPN) || !value._logicRPN.every(isRpnToken))) return false;
  if (value._logicCompileError !== undefined && value._logicCompileError !== null && typeof value._logicCompileError !== 'string') return false;
  for (const field of ['referencedADRGs', 'requiredReferencedADRGs']) {
    if (value[field] !== undefined && !isStringArray(value[field])) return false;
  }
  if (value.requiredProcedureGroups !== undefined && (!Array.isArray(value.requiredProcedureGroups) || !value.requiredProcedureGroups.every(isStringArray))) return false;
  for (const field of ['anyProcedureRequired', 'zeroProceduresRequired', 'multiSite', 'intensiveCare']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') return false;
  }
  return true;
}

function isAdrgDefinition(value: unknown): value is AdrgDefinition {
  if (!isRecord(value) || typeof value.code !== 'string') return false;
  for (const field of ['type', 'name', 'description', 'filename']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  }
  return value.rule === undefined || value.rule === null || isAdrgRule(value.rule);
}

function isMdcRule(value: unknown): value is MdcRule {
  if (!isRecord(value) || typeof value.code !== 'string') return false;
  for (const field of ['type', 'name']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  }
  if (value.identifyingDiagnoses !== undefined && !isStringArray(value.identifyingDiagnoses)) return false;
  return value.mdczCategories === undefined
    || value.mdczCategories === null
    || isStringArrayRecord(value.mdczCategories);
}

function isCodeMatcher(value: unknown): value is { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

function isCodeMatcherArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' || isCodeMatcher(item));
}

function isDrgSubgroupRule(value: unknown): value is DrgSubgroupRule {
  if (!isRecord(value)) return false;
  if (typeof value.drgCode !== 'string' || typeof value.drgName !== 'string' || typeof value.adrgCode !== 'string') return false;
  if (!isStringArray(value.conditions)) return false;
  for (const field of ['diagnosisPrefixes', 'procedurePrefixes']) {
    if (value[field] !== undefined && !isStringArray(value[field])) return false;
  }
  for (const field of ['diagnosisCodes', 'procedureCodes']) {
    if (value[field] !== undefined && !isCodeMatcherArray(value[field])) return false;
  }
  return value.adrgRule === undefined || value.adrgRule === null || isAdrgRule(value.adrgRule);
}

function isDrgMapEntry(value: unknown): value is DrgMapEntry {
  if (!isRecord(value)) return false;
  for (const field of ['description']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false;
  }
  for (const field of ['weight', 'weightTier2']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'number' && typeof value[field] !== 'string') return false;
  }
  return true;
}

function isNameMapWithInitials(value: unknown): value is NameMapWithInitials {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (key === '_initials') return isStringRecord(item);
    return typeof item === 'string';
  });
}

function isRuleData(value: unknown): value is RuleData {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.adrgRules) || !value.adrgRules.every(isAdrgDefinition)) return false;
  if (!Array.isArray(value.mdcRules) || !value.mdcRules.every(isMdcRule)) return false;
  if (!isStringRecord(value.ccCodes) || !isStringRecord(value.mccCodes) || !isStringRecord(value.cceCodes)) return false;
  if (!isBooleanRecord(value.zdInvalid) || !isBooleanRecord(value.ssInvalid)) return false;
  if (!isRecord(value.icd10GrayJson) || !isRecord(value.icd9GrayJson)) return false;
  if (!Array.isArray(value.drgSubgroupRules) || !value.drgSubgroupRules.every(isDrgSubgroupRule)) return false;
  if (!isRecord(value.drgMap) || !Object.values(value.drgMap).every(isDrgMapEntry)) return false;
  if (value.glDiagNames !== undefined && !isNameMapWithInitials(value.glDiagNames)) return false;
  if (value.glProcNames !== undefined && !isNameMapWithInitials(value.glProcNames)) return false;
  if (!isNameMapWithInitials(value.ybDiagNames) || !isNameMapWithInitials(value.ybProcNames)) return false;
  if (value.icdGlToYbRaw !== undefined && !isRecord(value.icdGlToYbRaw)) return false;
  if (value.icd9GlToYbRaw !== undefined && !isRecord(value.icd9GlToYbRaw)) return false;
  return true;
}

export function normalizeRuleData(value: unknown): RuleData {
  if (!isRuleData(value)) {
    throw new TypeError('Generated DRG data does not match the RuleData contract');
  }
  return value;
}
