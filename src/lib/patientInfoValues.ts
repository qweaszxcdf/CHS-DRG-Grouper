import { PATIENT_NUMERIC_ENUM_FIELDS } from '../types/patient_info_fields.ts';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on', '是']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off', '否']);
const DECIMAL_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function parsePatientBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return undefined;
}

// Compile choices once; grouping does not rebuild them for each patient.
export const PATIENT_NUMERIC_ENUM_PARSERS = Object.freeze(
  PATIENT_NUMERIC_ENUM_FIELDS.map(field => {
    const choices = new Map(field.options.map(option => [String(option.value), option.value]));
    const allowOtherValues = 'allowOtherValues' in field && field.allowOtherValues;
    return {
      key: field.key,
      allowOtherValues,
      expected: allowOtherValues ? 'a finite decimal number' : field.options.map(option => option.value).join(' or '),
      parse(raw: string | number): number | undefined {
        const text = typeof raw === 'string' ? raw.trim() : String(raw);
        if (typeof raw === 'string' && !DECIMAL_NUMBER_PATTERN.test(text)) return undefined;
        const choice = choices.get(text);
        if (choice !== undefined) return choice;
        if (allowOtherValues) {
          const value = typeof raw === 'number' ? raw : Number(text);
          if (Number.isFinite(value)) return value;
        }
        return undefined;
      },
    };
  }),
);

export const PATIENT_NUMERIC_ENUM_PARSER_BY_FIELD = Object.freeze(
  Object.fromEntries(PATIENT_NUMERIC_ENUM_PARSERS.map(parser => [parser.key, parser])),
);
