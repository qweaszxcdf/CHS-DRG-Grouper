import type { BatchInputFormat } from '../services/adaptors/index.ts';
import type {
  BatchGroupingRow,
  CodeListInput,
  PatientInfoInput,
} from './grouper.ts';

export type { BatchInputFormat };

export type BatchRawRow = Record<string, unknown>;

export interface BatchMappingKeys {
  idKey: string;
  diagsKey: string[] | null;
  procsKey: string[] | null;
  ageKey: string;
  ageDaysKey: string;
  bwKey: string;
  admissionWeightKey: string;
  dischargeKey: string;
  newTechKey: string;
  intensiveCareKey: string;
  icuHoursKey: string;
  crrtHoursKey: string;
  lengthOfStayKey: string;
  daySurgeryKey: string;
  genderKey: string;
}

export interface ParsedBatchPreview {
  meta: Record<string, unknown>;
  sample: BatchRawRow[];
  dataLength: number;
  headerKeys: string[] | null;
}

export interface NormalizationMiss {
  count: number;
  original: string;
  lastSeen?: string;
}

export interface NormalizationMissView {
  key: string;
  src: string;
  type: string;
  value: string;
  count: number;
  lastSeen: string | null;
}

export interface NormalizedBatchRow extends BatchGroupingRow {
  id: string;
  diagnoses: string[];
  procedures: string[];
  diagnosesRaw?: string[];
  proceduresRaw?: string[];
  patientInfo?: PatientInfoInput;
  diagnosisCodes?: string[];
}

export interface BatchLoadResult {
  normalized: NormalizedBatchRow[];
  logs: string[];
  timeMs?: number;
}

export interface BatchProcessResult {
  results: BatchProcessRowResult[];
  logs: string[];
  timeMs?: number;
}

export type BatchNormalizationType = 'Diagnosis' | 'Procedure';

export interface BatchProcessRowResult {
  id?: string | number | null;
  drg?: string | null;
  description?: string;
  mdc?: string | null;
  adrg?: string | null;
  diagnoses?: CodeListInput | null;
  procedures?: CodeListInput | null;
  [key: string]: unknown;
}

export type BatchCellCleaner = (value: unknown) => string;
export type BatchEntryNormalizer = (values: string[], type: BatchNormalizationType) => string[];
