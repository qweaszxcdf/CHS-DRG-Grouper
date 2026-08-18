import type {
  AdrgDefinition,
  AdrgRule,
  DrgSubgroupRule,
  RuleData,
  RuleMatchResult,
  RulePatient,
  RuleSet,
} from './rules.js';

export type CodeListInput = string | readonly string[];
export type VersionId = string;
export type MaybePromise<T> = T | Promise<T>;

export type PatientScalarInput = string | number | null | undefined;
export type PatientBooleanInput = boolean | number | string | null | undefined;

export interface PatientDemographicsInput {
  gender?: PatientScalarInput;
  age?: PatientScalarInput;
  ageInDays?: PatientScalarInput;
  birthWeight?: PatientScalarInput;
}

export interface PatientOutcomeInput {
  dischargeStatus?: PatientScalarInput;
}

export interface PatientFlagsInput {
  newTechnique?: PatientBooleanInput;
  multiSite?: PatientBooleanInput;
  intensiveCare?: PatientBooleanInput;
  daySurgery?: PatientBooleanInput;
}

export interface PatientDurationsInput {
  icuHours?: PatientScalarInput;
  crrtHours?: PatientScalarInput;
  lengthOfStay?: PatientScalarInput;
}

// Public input remains flat for API, SingleTab, and BatchTab compatibility.
export interface PatientInfoInput extends
  PatientDemographicsInput,
  PatientOutcomeInput,
  PatientFlagsInput,
  PatientDurationsInput {}

export type PatientInfoField = keyof PatientInfoInput;

export interface PatientInfoDisplayConfig {
  basic: readonly PatientInfoField[];
  advanced: readonly PatientInfoField[];
}

export interface NormalizedPatientDemographics {
  gender?: number | string;
  age?: number;
  ageInDays?: number;
  birthWeight?: number;
}

export interface NormalizedPatientOutcome {
  dischargeStatus?: string;
}

export interface NormalizedPatientFlags {
  newTechnique?: boolean;
  multiSite?: boolean;
  intensiveCare?: boolean;
  daySurgery?: boolean;
}

export interface NormalizedPatientDurations {
  icuHours?: number;
  crrtHours?: number;
  lengthOfStay?: number;
}

export interface NormalizedPatientInfo extends
  NormalizedPatientDemographics,
  NormalizedPatientOutcome,
  NormalizedPatientFlags,
  NormalizedPatientDurations {
}

export interface MatchTraceEntry {
  stage: string;
  matched?: boolean;
  error?: boolean;
  warning?: boolean;
  code?: string | null;
  status?: string;
  description?: string;
  detail?: unknown;
  [key: string]: unknown;
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
  version?: VersionId;
}

export interface CommonStrategy {
  invalidPrincipalProcedureAction: 'shift' | 'null-slot' | 'keep';
  allowedInvalidPrincipalProcedures: string[];
  allowedGrayPrincipalProcedures: string[];
  mdcyPrincipalDiagnosisOnly: boolean;
  allowSecondarySectionPrimaryFallback: boolean;
  [key: string]: unknown;
}

export interface VersionStrategy {
  daySurgeryAsNoCC: boolean;
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
  matchedDRG: { code: string; description: string } | null;
  matchedSubgroup: DrgSubgroupRule | null;
}

export interface GrouperEngine {
  groupPatient(
    diagnoses: CodeListInput,
    procedures: CodeListInput,
    patientInfo?: PatientInfoInput | null,
  ): GroupingResult;
  groupBatch(rows?: BatchGroupingRow[]): BatchGroupingResult[];
  matchesRule(rule: AdrgRule, patient: RulePatient): RuleMatchResult;
  evaluateADRGSubgroups(
    matchedADRG: AdrgDefinition | null,
    diagnoses: string[],
    procedures: Array<string | null>,
    patientInfo: NormalizedPatientInfo,
    principalDiagnosis: string | null,
    principalProcedure: string | null,
    matchTrace: MatchTraceEntry[],
  ): SubgroupEvaluation;
}

export type CreateGrouperEngineOptions = {
  ruleSet: RuleSet;
  commonStrategy: CommonStrategy;
  versionStrategy?: VersionStrategy;
};
