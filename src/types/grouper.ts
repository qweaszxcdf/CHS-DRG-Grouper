import type { PatientInfoDefinition, PatientInfoFieldKey } from './patient_info_fields.ts';
import type {
  RuleData,
  RuleMatchResult,
  RuleSet,
} from './rules.js';
export type CodeListInput = string | readonly string[];
export type VersionId = string;

/** Convert a scalar or array code input to a new array; callers own empty-slot policy. */
export function toCodeList(input: CodeListInput | null | undefined): string[] {
  if (typeof input === 'string') return input ? [input] : [];
  return Array.isArray(input) ? [...input] : [];
}

export type PatientScalarInput = string | number | null | undefined;
export type PatientBooleanInput = boolean | number | string | null | undefined;

type NormalizedPatientByKind = {
  numericEnum: number;
  nonNegativeInteger: number;
  boolean: boolean;
};

// Public inputs stay flat; adding a registered field also adds its input and normalized types.
export type PatientInfoInput = {
  [F in PatientInfoDefinition as F['key']]?: F['kind'] extends 'boolean' ? PatientBooleanInput : PatientScalarInput;
};
export type NormalizedPatientInfo = {
  [F in PatientInfoDefinition as F['key']]?: F extends { kind: 'numericEnum' }
    ? F extends { allowOtherValues: true } ? number : F['options'][number]['value']
    : NormalizedPatientByKind[F['kind']];
};
export type PatientInfoField = PatientInfoFieldKey;

export interface PatientInfoDisplayConfig {
  basic: readonly PatientInfoField[];
  advanced: readonly PatientInfoField[];
}

export const MATCH_TRACE_LABELS = Object.freeze({
  validation: 'Validation',
  'mdcz-category-check': 'Pre-MDC',
  'pre-mdc-match': 'Pre-MDC',
  'mdc-match': 'MDC',
  'adrg-match': 'ADRG',
  'adrg-no-match': 'ADRG',
  'qy-redirect': 'QY Redirect',
  'cc-status': 'CC/MCC',
  'subgroup-match': 'DRG',
  'subgroup-no-match': 'DRG',
  transport: 'Transport',
});
export type MatchTraceEvent = keyof typeof MATCH_TRACE_LABELS;

export interface MatchTraceDetail {
  reasonCode?: 'category-threshold-met' | 'category-threshold-not-met';
  ruleMatch?: RuleMatchResult;
  adrgRule?: RuleMatchResult;
  conditions?: RuleMatchResult | { matched: boolean; reason: string };
}

export interface MatchTraceEntry {
  event: MatchTraceEvent;
  matched?: boolean;
  error?: boolean;
  warning?: boolean;
  code?: string | null;
  status?: string;
  description?: string;
  detail?: MatchTraceDetail;
  calculatedStatus?: string;
  overridden?: boolean;
  strategy?: string;
  candidates?: Array<{ code: string; name?: string }>;
  candidateCount?: number;
  mdczDiagnosisMatches?: Array<{ code: string; categories: string[] }>;
  requiredCategoryCount?: number;
  actualCategoryCount?: number;
}

export type Weight = number | string | null;

export interface GroupingResult {
  drg: string | null;
  mdc: string | null;
  adrg: string | null;
  description: string;
  ruleMatchDetail?: RuleMatchResult | null;
  matchTrace?: MatchTraceEntry[];
  weight?: Weight;
  weightTier2?: Weight;
  code?: string;
  error?: string;
  [key: string]: unknown;
}

export interface BatchGroupingRow {
  id?: string | number | null;
  diagnoses?: CodeListInput | null;
  procedures?: CodeListInput | null;
  patientInfo?: PatientInfoInput | null;
  [key: string]: unknown;
}

export interface BatchGroupingResult extends GroupingResult {
  id: string | number | null;
  diagnoses?: string[];
  procedures?: string[];
  original_diagnoses?: string[];
  original_procedures?: string[];
  patientInfo?: PatientInfoInput | null;
  version?: VersionId;
}

export interface CommonStrategy {
  allowedInvalidPrincipalProcedures: string[];
  allowedGrayPrincipalProcedures: string[];
  preMdc: readonly string[];
  [key: string]: unknown;
}

export interface VersionStrategy {
  enableQyRedirect: boolean;
  daySurgeryAsNoCC: boolean;
  robotAssistedSurgery: {
    adrgCodes: string[];
    procedureCodes: string[];
  };
  highRiskPregnancyAsMcc: {
    adrgCodes: string[];
    diagnosisCodes: string[];
  };
  [key: string]: unknown;
}

export interface VersionPackages {
  clinicalIcd: string;
  insuranceIcd: string;
  [key: string]: unknown;
}

export interface VersionDefinition {
  id: VersionId;
  label: string;
  drgCommon: string;
  packages: VersionPackages;
  commonStrategy: CommonStrategy;
  versionStrategy: VersionStrategy;
  patientInfo: PatientInfoDisplayConfig;
  data?: RuleData;
  [key: string]: unknown;
}

export interface VersionSummary {
  id: VersionId;
  label: string;
  drgCommon: string;
  packages: VersionPackages;
}

export interface SubgroupEvaluation {
  matchedDRG: { code: string; description: string };
}

export interface GrouperEngine {
  groupPatient(
    diagnoses: CodeListInput,
    procedures: CodeListInput,
    patientInfo?: PatientInfoInput | null,
  ): GroupingResult;
  groupBatch(rows?: BatchGroupingRow[]): BatchGroupingResult[];
}

export type CreateGrouperEngineOptions = {
  ruleSet: RuleSet;
  commonStrategy: CommonStrategy;
  versionStrategy: VersionStrategy;
};
