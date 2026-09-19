import type { BatchGroupingRow, PatientInfoField, PatientInfoInput } from '../../types/grouper.js';

export type HospitalFormat = 'HQMS' | 'N041' | 'HN041';
export type BatchInputFormat = HospitalFormat | 'MANUAL';
export type HospitalRow = Record<string, unknown>;

interface SlotDefinition {
  principal: string;
  repeated: RegExp;
  offset?: number;
}

interface AdaptorDefinition {
  id: string;
  diagnoses: SlotDefinition;
  diagnosisAdditionalCodes?: SlotDefinition;
  procedures: SlotDefinition;
  patientInfo: Partial<Record<PatientInfoField, string>>;
}

export interface HospitalAdaptor {
  format: HospitalFormat;
  source: 'GL';
  mapping: {
    id: string;
    diagnoses: Array<string | null>;
    diagnosisAdditionalCodes?: Array<string | null>;
    procedures: Array<string | null>;
    patientInfo: Partial<Record<PatientInfoField, string>>;
  };
  adapt(row: HospitalRow, rowIndex?: number): BatchGroupingRow & {
    id: string;
    diagnoses: string[];
    diagnosisCodes?: string[];
    procedures: string[];
    patientInfo: PatientInfoInput;
  };
}

export function normalizeHeader(header: string): string {
  const trimmed = header.replace(/^\uFEFF/, '').trim();
  const fieldCode = trimmed.match(/[（(]\s*([A-Za-z][A-Za-z0-9_]*)\s*[）)]/);
  return (fieldCode?.[1] || trimmed).toUpperCase();
}

function readCell(row: HospitalRow, key: string | null): string {
  const value = key === null ? undefined : row[key];
  if (value == null) return '';
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`${key} 必须为文本或数字`);
  }
  const text = String(value).trim();
  return text === '-' ? '' : text;
}

export function createHospitalAdaptor(
  format: HospitalFormat,
  headers: readonly string[],
  definition: AdaptorDefinition,
): HospitalAdaptor {
  const keys = new Map<string, string>();
  for (const header of headers) {
    const canonical = normalizeHeader(header);
    if (keys.has(canonical)) throw new Error(`${format} 表头重复：${header}`);
    keys.set(canonical, header);
  }
  const requireKey = (field: string): string => {
    const key = keys.get(normalizeHeader(field));
    if (key === undefined) throw new Error(`${format} 缺少字段：${field}`);
    return key;
  };
  const slots = ({ principal, repeated, offset = 0 }: SlotDefinition): Array<string | null> => {
    const columns: Array<string | null> = [requireKey(principal)];
    for (const [canonical, key] of keys) {
      const match = canonical.match(repeated);
      if (!match) continue;
      const index = Number(match[1]) + offset;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 512) {
        throw new Error(`${format} 编码槽位超出范围：${key}`);
      }
      if (columns[index] !== undefined && columns[index] !== key) {
        throw new Error(`${format} 编码槽位重复：${columns[index]} / ${key}`);
      }
      columns[index] = key;
    }
    // Missing numbered columns remain empty slots; later columns keep their positions.
    return Array.from(columns, key => key ?? null);
  };
  const mapping: HospitalAdaptor['mapping'] = {
    id: requireKey(definition.id),
    diagnoses: slots(definition.diagnoses),
    procedures: slots(definition.procedures),
    patientInfo: {},
  };
  if (definition.diagnosisAdditionalCodes) {
    mapping.diagnosisAdditionalCodes = slots(definition.diagnosisAdditionalCodes);
  }
  for (const [field, column] of Object.entries(definition.patientInfo)) {
    const key = keys.get(normalizeHeader(column));
    if (key !== undefined) mapping.patientInfo[field as PatientInfoField] = key;
  }
  const infoFields = Object.entries(mapping.patientInfo) as Array<[PatientInfoField, string]>;

  return {
    format,
    source: 'GL',
    mapping,
    adapt(row, rowIndex = 0) {
      try {
        const id = readCell(row, mapping.id);
        if (!id) throw new Error(`${mapping.id} 病案号为空`);
        const diagnoses = mapping.diagnoses.map(key => readCell(row, key));
        const procedures = mapping.procedures.map(key => readCell(row, key));
        if (!diagnoses[0]) throw new Error(`${mapping.diagnoses[0]} 主要诊断为空`);
        for (const [label, values, columns] of [
          ['诊断', diagnoses, mapping.diagnoses],
          ['手术', procedures, mapping.procedures],
        ] as const) {
          const firstEmpty = values.indexOf('');
          // The existing Grouper removes empty strings. Reject gaps at this boundary
          // so it cannot promote secondary codes; trailing unused slots are harmless.
          if (firstEmpty >= 0 && values.slice(firstEmpty + 1).some(value => value !== '')) {
            throw new Error(`${label}第 ${firstEmpty + 1} 槽（${columns[firstEmpty] ?? '缺列'}）为空，但后续仍有编码；请核对原始槽位`);
          }
        }
        const patientInfo: PatientInfoInput = {};
        for (const [field, key] of infoFields) {
          const value = readCell(row, key);
          if (value !== '') patientInfo[field] = value;
        }
        const result: BatchGroupingRow & {
          id: string;
          diagnoses: string[];
          diagnosisCodes?: string[];
          procedures: string[];
          patientInfo: PatientInfoInput;
        } = {
          id, diagnoses, procedures, patientInfo,
        };

        if (mapping.diagnosisAdditionalCodes) {
          // Check additional-code columns even when the corresponding main-code
          // column is absent from the header; an orphan FJBM must not disappear.
          const diagnosisSlotCount = Math.max(diagnoses.length, mapping.diagnosisAdditionalCodes.length);
          const orderedDiagnoses: string[] = [];
          for (let slot = 0; slot < diagnosisSlotCount; slot += 1) {
            const code = diagnoses[slot] || '';
            const additionalCode = readCell(row, mapping.diagnosisAdditionalCodes[slot] ?? null);

            if (!code) {
              if (additionalCode) {
                throw new Error(`诊断第 ${slot + 1} 槽主码为空，但存在附加码；请核对原始槽位`);
              }
              continue;
            }

            if (additionalCode && !/^M/i.test(additionalCode) && /\*$/u.test(additionalCode)) {
              // An asterisk additional code is part of the same ICD
              // double-code token. The rule/index data uses
              // `base+additional`, not two independent diagnosis positions.
              orderedDiagnoses.push(`${code}${additionalCode}`);
            } else {
              orderedDiagnoses.push(code);
            }
          }
          result.diagnosisCodes = orderedDiagnoses;
          result.diagnoses = orderedDiagnoses;
        }
        return result;
      } catch (error) {
        throw new Error(`${format} 第 ${rowIndex + 1} 条记录：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
