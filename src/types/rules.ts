import type { NormalizedPatientInfo } from './grouper.js';

export type StringMap = Record<string, unknown>;

export type NameMap = Record<string, string>;

// Source ICD JSON maps also carry an `_initials` object beside the code/name
// entries. Keep that raw shape distinct from the cleaned lookup map exposed by
// RuleSet so the generated data can be checked without an unsafe cast.
export interface NameMapWithInitials {
  [key: string]: string | Record<string, string> | undefined;
  _initials?: Record<string, string>;
}

export type RpnToken = string | { type: 'SECTION'; name: string };

export interface AdrgRule {
  logic?: string;
  sections?: Record<string, string[]>;
  sectionAliases?: Record<string, string>;
  sectionMinimumMatches?: Record<string, number>;
  sectionMinimumOccurrences?: Record<string, number>;
  _logicRPN?: RpnToken[];
  _logicCompileError?: string | null;
  referencedADRGs?: string[];
  requiredReferencedADRGs?: string[];
  requiredProcedureGroups?: string[][];
  anyProcedureRequired?: boolean;
  zeroProceduresRequired?: boolean;
  intensiveCare?: boolean;
  [key: string]: unknown;
}

export interface MdcRule {
  type?: string;
  code: string;
  name?: string;
  identifyingDiagnoses?: string[];
  mdczCategories?: Record<string, string[]> | null;
  [key: string]: unknown;
}

export interface AdrgDefinition {
  type?: string;
  code: string;
  name?: string;
  description?: string;
  rule?: AdrgRule | null;
  [key: string]: unknown;
}

export interface MdcDefinition {
  code: string;
  description: string;
  identifyingDiagnoses: string[];
  identifyingDiagnosesSet: Set<string>;
  mdczCategories?: Record<string, string[]> | null;
}

export type ComparisonOperator = 'LT' | 'LE' | 'GT' | 'GE';
export type AgeCondition = `AGE_${ComparisonOperator}_${number}`;
export type IcuHoursCondition = `ICU_HOURS_${ComparisonOperator}_${number}`;
export type CrrtHoursCondition = `CRRT_HOURS_${ComparisonOperator}_${number}`;
export type LengthOfStayCondition = `LOS_${ComparisonOperator}_${number}`;

export type KnownSubgroupCondition =
  | 'SPECIFIC_DIAGNOSIS'
  | 'SPECIFIC_DIAGNOSIS_PREFIX'
  | 'SPECIFIC_PROCEDURE'
  | 'SPECIFIC_PROCEDURE_PREFIX'
  | AgeCondition
  | IcuHoursCondition
  | CrrtHoursCondition
  | LengthOfStayCondition
  | 'DEATH'
  | 'INTENSIVE_CARE'
  | 'DAY_SURGERY'
  | 'WITH_MCC'
  | 'WITH_CC'
  | 'NO_CC'
  | 'ROBOT_ASSISTED_SURGERY'
  | 'NEW_TECHNIQUE'
  | 'ADRG_ONLY';

// Keep runtime input open to future/unknown tokens; the evaluator fails closed.
export type SubgroupCondition = string;

export interface CodeMatcher {
  code: string;
  [key: string]: unknown;
}

export interface DrgSubgroupRule {
  drgCode: string;
  drgName: string;
  adrgCode: string;
  conditions: SubgroupCondition[];
  diagnosisCodes?: Array<string | CodeMatcher>;
  procedureCodes?: Array<string | CodeMatcher>;
  diagnosisPrefixes?: string[];
  procedurePrefixes?: string[];
  adrgRule?: AdrgRule | null;
  [key: string]: unknown;
}

export interface DrgMapEntry {
  description?: string;
  weight?: number | string | null;
  weightTier2?: number | string | null;
  [key: string]: unknown;
}

export interface RuleData {
  adrgRules: AdrgDefinition[];
  mdcRules: MdcRule[];
  ccCodes: Record<string, string>;
  mccCodes: Record<string, string>;
  cceCodes: Record<string, string>;
  allProcedureCodes?: Record<string, boolean>;
  qyDiffCodes?: Record<string, boolean>;
  zdInvalid: Record<string, boolean>;
  ssInvalid: Record<string, boolean>;
  icd10GrayJson: Record<string, unknown>;
  icd9GrayJson: Record<string, unknown>;
  drgSubgroupRules: DrgSubgroupRule[];
  drgMap: Record<string, DrgMapEntry>;
  glDiagNames?: NameMapWithInitials;
  glProcNames?: NameMapWithInitials;
  ybDiagNames: NameMapWithInitials;
  ybProcNames: NameMapWithInitials;
  icdGlToYbRaw?: Record<string, unknown>;
  icd9GlToYbRaw?: Record<string, unknown>;
}

export interface RuleSet {
  loadCCCodes(): Record<string, string>;
  loadMCCCodes(): Record<string, string>;
  loadCCECodes(): Record<string, string>;
  loadAllProcedureCodes(): Record<string, boolean>;
  /** Small derived exclusion set used by QY/anyProcedureRequired matching. */
  loadQyDiffCodes(): Record<string, boolean>;
  isInvalidDiagnosis(code: string): boolean;
  isInvalidProcedure(code: string): boolean;
  isGrayDiag(code: string): boolean;
  isGrayProc(code: string): boolean;
  loadDRGSubgroupRules(): DrgSubgroupRule[];
  loadDRGSubgroupRulesForADRG(adrgCode: string): DrgSubgroupRule[];
  getADRGsForMDC(mdcCode: string): AdrgDefinition[];
  MDCs: MdcDefinition[];
  mdcByCode: Map<string, MdcDefinition>;
  diagToMDCZCategories: Map<string, string>;
  getADRGByCode(code: string): AdrgDefinition | undefined;
  loadDRGMap(): Record<string, DrgMapEntry>;
  loadADRGRules(): AdrgDefinition[];
  loadMDCRules(): MdcRule[];
  loadGLDiagNames(): Record<string, string>;
  loadGLProcNames(): Record<string, string>;
  loadYBDiagNames(): Record<string, string>;
  loadYBProcNames(): Record<string, string>;
  loadGLInitialsDiag(): Record<string, string>;
  loadGLInitialsProc(): Record<string, string>;
  loadYBInitialsDiag(): Record<string, string>;
  loadYBInitialsProc(): Record<string, string>;
  loadICDGlYBMap(): Record<string, unknown>;
  loadICD9GlYBMap(): Record<string, unknown>;
}

export interface RulePatient {
  diagnoses: string[];
  procedures: Array<string | null>;
  patientInfo: NormalizedPatientInfo;
}

export interface MatchCodeDetail {
  matched: boolean;
  matchedCodes: string[];
  matchedCount?: number;
  requiredCount?: number;
}

export interface RuleMatchDetails {
  sections: Record<string, MatchCodeDetail>;
  requiredProcedureGroups?: Array<{ group: string[]; matchedCodes: string[]; matched: boolean }>;
  requiredReferencedADRGs?: Array<{ adrg: string; matchedCodes: string[]; matched: boolean }>;
  referencedADRGs?: { codes: string[]; matched: boolean };
  logicError?: string;
  [key: string]: unknown;
}

export interface RuleMatchResult {
  matched: boolean;
  details: RuleMatchDetails;
}

export interface MatchedSubgroup extends DrgSubgroupRule {
  matchResult: { matched: boolean; reason: string };
  adrgMatchResult: RuleMatchResult | null;
}
