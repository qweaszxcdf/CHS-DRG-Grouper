import type { GroupingResult, PatientInfoInput } from './grouper.js';

export interface SingleGroupingResult {
  finalRes: GroupingResult;
  diagnoses: string[];
  procedures: string[];
  diagnosesConverted: string[];
  proceduresConverted: string[];
  conversionApplied: boolean;
  patientInfo: PatientInfoInput;
}

export interface PermutationEntry {
  key: string;
  drg: string | null | undefined;
  mdc: string | null | undefined;
  adrg: string | null | undefined;
  description: string;
  diagnoses: string[];
  procedures: string[];
  raw: GroupingResult;
  weight?: GroupingResult['weight'];
  weightTier2?: GroupingResult['weightTier2'];
}

export interface PermutationGroup {
  summary: PermutationEntry;
  examples: PermutationEntry[];
}

export interface PermutationResult {
  totalCombos: number;
  processed: number;
  results: PermutationGroup[];
  error?: string;
  description?: string;
}

export type GroupingSource = string;
