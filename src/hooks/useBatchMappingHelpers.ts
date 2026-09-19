import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getIcdIndex } from '../services/CodeSearch';
import { AUTO_DETECT_DELIMITERS } from '../services/batchProcess.ts';
import type {
  BatchNormalizationType,
  BatchMappingKeys,
  BatchRawRow,
  NormalizationMiss,
  NormalizationMissView,
} from '../types/batch.ts';
import type { CodeSearchItem } from '../types/search.ts';

export const BATCH_ID_FIELD_ALIASES: readonly string[] = Object.freeze(['id', 'caseid', 'case_id', 'identifier', '编号', '序号', 'patient_id', 'patid', '病案号', '住院号']);

const normalizeHeaderAlias = (value: string): string => (
  value.toLowerCase().replace(/[\s_.():，\u200B\uFEFF-]/gu, '')
);

interface NameIndex extends Map<string, CodeSearchItem[]> {
  __index?: CodeSearchItem[];
  __srcLen?: number;
}

interface NormalizationCacheEntry {
  __type: 'miss' | 'code';
  value: string;
}

export interface UseBatchMappingHelpersOptions {
  searchSource: string;
  version: string;
  codeIndexRevision?: number;
  previewIdRef: MutableRefObject<string>;
  previewDiagsRef: MutableRefObject<string[]>;
  previewProcsRef: MutableRefObject<string[]>;
  previewAgeRef: MutableRefObject<string>;
  previewAgeDaysRef: MutableRefObject<string>;
  previewBirthWeightRef: MutableRefObject<string>;
  previewAdmissionWeightRef: MutableRefObject<string>;
  previewDischargeRef: MutableRefObject<string>;
  previewNewTechniqueRef: MutableRefObject<string>;
  previewIntensiveCareRef: MutableRefObject<string>;
  previewIcuHoursRef: MutableRefObject<string>;
  previewCrrtHoursRef: MutableRefObject<string>;
  previewLengthOfStayRef: MutableRefObject<string>;
  previewDaySurgeryRef: MutableRefObject<string>;
  previewGenderRef: MutableRefObject<string>;
  failedNormalizationRef: MutableRefObject<Map<string, NormalizationMiss>>;
  setNormMisses: Dispatch<SetStateAction<NormalizationMissView[]>>;
}

export interface UseBatchMappingHelpersResult {
  buildNormMissesArray: () => NormalizationMissView[];
  normalizeEntriesNoUI: (values: readonly string[], type: BatchNormalizationType) => string[];
  cleanCell: (value: unknown) => string;
  getMappingKeys: (sample: BatchRawRow) => BatchMappingKeys;
  detectDelimiterForColumn: (rows: BatchRawRow[], columnKey: string | null) => string | null;
}

function recordNormalizationMiss(
  failedNormalizationRef: MutableRefObject<Map<string, NormalizationMiss>>,
  source: string,
  type: BatchNormalizationType,
  value: string,
): void {
  const original = value;
  const sourceValue = source || 'YB';
  const normalized = original.normalize('NFKC');
  const normalizedClean = normalized
    .replace(/\u200B|\uFEFF|\u200C|\u200D|\u00AD|\u200E|\u200F/gu, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const key = `${sourceValue}|${type}|${normalizedClean}`;
  const previous = failedNormalizationRef.current.get(key) || { count: 0, original };
  if (!previous.original) previous.original = original;
  previous.count++;
  previous.lastSeen = new Date().toISOString();
  failedNormalizationRef.current.set(key, previous);
}

export function useBatchMappingHelpers({
  searchSource,
  version,
  codeIndexRevision = 0,
  previewIdRef,
  previewDiagsRef,
  previewProcsRef,
  previewAgeRef,
  previewAgeDaysRef,
  previewBirthWeightRef,
  previewAdmissionWeightRef,
  previewDischargeRef,
  previewNewTechniqueRef,
  previewIntensiveCareRef,
  previewIcuHoursRef,
  previewCrrtHoursRef,
  previewLengthOfStayRef,
  previewDaySurgeryRef,
  previewGenderRef,
  failedNormalizationRef,
  setNormMisses,
}: UseBatchMappingHelpersOptions): UseBatchMappingHelpersResult {
  const searchCacheRef = useRef<Map<string, NormalizationCacheEntry>>(new Map());
  const nameIndexRef = useRef<NameIndex | null>(null);

  const buildNormMissesArray = useCallback((): NormalizationMissView[] => {
    const arr: NormalizationMissView[] = [];
    for (const [k, v] of failedNormalizationRef.current.entries()) {
      const [src = '', type = ''] = k.split('|');
      const displayed = v.original;
      arr.push({ key: k, src, type, value: displayed, count: v.count, lastSeen: v.lastSeen ?? null });
    }
    arr.sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
    return arr;
  }, [failedNormalizationRef]);

  useEffect(() => {
    setNormMisses(buildNormMissesArray());
  }, [buildNormMissesArray, setNormMisses]);

  useEffect(() => {
    searchCacheRef.current.clear();
  }, [searchSource, version, codeIndexRevision]);

  const normalizeEntriesNoUI = useCallback((arr: readonly string[], type: BatchNormalizationType): string[] => {
    const out: string[] = [];
    for (const t of arr) {
      const s = t.trim();
      if (!s) continue;
      const key = `${version}:${type}:${(searchSource || 'YB')}:${s.toLowerCase()}`;
      const cached = searchCacheRef.current.get(key);
      if (cached) {
        if (cached.__type === 'miss') {
          recordNormalizationMiss(failedNormalizationRef, searchSource, type, s);
          out.push(cached.value);
        } else {
          out.push(cached.value);
        }
        continue;
      }

      const codeLike = /^[A-Za-z0-9][A-Za-z0-9.\-xX+*]*$/.test(s);
      if (codeLike) {
        const val = s;
        searchCacheRef.current.set(key, { __type: 'code', value: val });
        out.push(val);
        continue;
      }

      const idx = getIcdIndex(version);
      if (!nameIndexRef.current || nameIndexRef.current.__index !== idx || nameIndexRef.current.__srcLen !== idx.length) {
        const m: NameIndex = new Map();
        for (const item of idx) {
          const n = item.name.toLowerCase().trim();
          const arrRef = m.get(n);
          if (arrRef) arrRef.push(item); else m.set(n, [item]);
        }
        m.__index = idx;
        m.__srcLen = idx.length;
        nameIndexRef.current = m;
      }
      const candidates = nameIndexRef.current.get(s.toLowerCase().trim()) ?? [];
      const exact = candidates.filter(item => {
        if (item.type === 'DRG') return false;
        if (item.type !== type) return false;
        if (item.source !== searchSource) return false;
        return true;
      });
      const code = exact[0]?.code;
      if (code) {
        searchCacheRef.current.set(key, { __type: 'code', value: code });
        out.push(code);
        continue;
      }

      searchCacheRef.current.set(key, { __type: 'miss', value: s });
      out.push(s);

      recordNormalizationMiss(failedNormalizationRef, searchSource, type, s);
    }
    return out;
  }, [searchSource, version, failedNormalizationRef]);

  const cleanCell = useCallback((val: unknown): string => {
    if (val == null) return '';
    let s = String(val).trim();
    s = s.replace(/^[='\uFEFF\u200B]+/, '');
    if (s === '-') return '';
    return s;
  }, []);

  const findFieldName = useCallback((rowObj: BatchRawRow, candidates: readonly string[]): string | null => {
    const keys = Object.keys(rowObj);
    const lower = keys.map((k) => k.toLowerCase());
    for (const c of candidates) {
      const idx = lower.indexOf(c.toLowerCase());
      if (idx >= 0) return keys[idx]!;
    }
    return null;
  }, []);

  const findFieldNameFuzzy = useCallback((rowObj: BatchRawRow, candidates: readonly string[]): string | null => {
    const keys = Object.keys(rowObj);
    const norm = normalizeHeaderAlias;
    const keyNorms = keys.map(k => norm(k));

    for (const c of candidates) {
      const lc = c.toLowerCase();
      const idx = keys.findIndex(k => k.toLowerCase() === lc);
      if (idx >= 0) return keys[idx]!;
    }

    for (const c of candidates) {
      const cn = norm(c);
      for (let i = 0; i < keyNorms.length; i++) {
        const kn = keyNorms[i];
        if (!kn || !cn) continue;
        if (kn === cn) return keys[i]!;
        if (kn.includes(cn) || cn.includes(kn)) return keys[i]!;
      }
    }

    const splitTokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const c of candidates) {
      const ctoks = splitTokens(c);
      if (!ctoks.length) continue;
      for (let i = 0; i < keys.length; i++) {
        const ktoks = splitTokens(keys[i]!);
        if (!ktoks.length) continue;
        if (ctoks.some(t => ktoks.includes(t))) return keys[i]!;
      }
    }

    return null;
  }, []);

  const findFieldNameByNormalizedAlias = useCallback((rowObj: BatchRawRow, candidates: readonly string[]): string | null => {
    const aliases = new Set(candidates.map(normalizeHeaderAlias).filter(Boolean));
    return Object.keys(rowObj).find((key) => aliases.has(normalizeHeaderAlias(key))) ?? null;
  }, []);

  const getMappingKeys = useCallback((sample: BatchRawRow): BatchMappingKeys => {
    const idCandidates = BATCH_ID_FIELD_ALIASES;
    const diagsCandidates = ['diagnoses', 'diagnosis', 'diag', 'diags', '诊断', '诊断列表'];
    const procsCandidates = ['procedures', 'procedure', 'proc', 'procs', '手术', '操作'];
    const ageCandidates = ['age', 'age_years', 'age_year', 'patient_age', 'patient_age_years', '年龄', '年龄岁', '岁'];
    const ageDaysCandidates = ['ageindays', 'age_in_days', 'age_days', 'patient_age_in_days', 'patient_age_days', '年龄天数', '出生年龄天数', '出生年龄(天)'];
    const birthWeightCandidates = ['birthweight', 'birth_weight', '出生体重', 'birth_weight_g', '体重'];
    const admissionWeightCandidates = ['admissionweight', 'admission_weight', 'admission-weight', '入院体重', 'admission_weight_g'];
    const dischargeCandidates = ['discharge', 'discharge_status', 'dischargeStatus', '出院状态', 'discharge_status'];
    const newTechniqueCandidates = ['new_technique', 'newtechnique', 'new-technique', '新技术', 'new technique', 'is_new_tech', 'newtech'];
    const intensiveCareCandidates = ['intensivecare', 'intensive_care', 'intensive-care', 'icu_flag', 'icu_status', '重症监护', '重症监护标志', '是否重症监护'];
    const icuHoursCandidates = ['icu_hours', 'icuhours', 'icu-hours', 'icu hour', 'icu hours', '重症监护小时', 'icu时长', 'icu小时'];
    const crrtHoursCandidates = ['crrt_hours', 'crrthours', 'crrt-hours', 'crrt hour', 'crrt hours', '连续性肾脏替代治疗时长', 'crrt时长', 'crrt小时'];
    const lengthOfStayCandidates = ['length_of_stay', 'lengthofstay', 'length-of-stay', 'los', '住院日', '住院天数', '住院日数'];
    const daySurgeryCandidates = ['day_surgery', 'daysurgery', 'day-surgery', '日间手术', '日间手术标志', '日间'];
    const genderCandidates = ['gender', 'sex', 'patient_sex', 'gender_code', '性别', '性别代码'];

    const idKey = previewIdRef.current || findFieldNameFuzzy(sample, idCandidates) || findFieldName(sample, idCandidates) || '';

    const previewDiags = previewDiagsRef.current.length ? previewDiagsRef.current : null;
    let diagsKey: string[] | null;
    if (previewDiags) diagsKey = previewDiags;
    else {
      const combined = findFieldNameFuzzy(sample, diagsCandidates) || findFieldName(sample, diagsCandidates) || null;
      diagsKey = combined ? [combined] : null;
    }

    const previewProcs = previewProcsRef.current.length ? previewProcsRef.current : null;
    let procsKey: string[] | null;
    if (previewProcs) procsKey = previewProcs;
    else {
      const combined = findFieldNameFuzzy(sample, procsCandidates) || findFieldName(sample, procsCandidates) || null;
      procsKey = combined ? [combined] : null;
    }

    // Age-in-years and age-in-days deliberately use normalized exact aliases,
    // not generic substring matching: "age" must never also claim
    // "age_in_days" (or vice versa).
    let ageKey = previewAgeRef.current || findFieldNameByNormalizedAlias(sample, ageCandidates) || findFieldName(sample, ageCandidates) || '';
    let ageDaysKey = previewAgeDaysRef.current || findFieldNameByNormalizedAlias(sample, ageDaysCandidates) || findFieldName(sample, ageDaysCandidates) || '';
    if (ageKey && ageKey === ageDaysKey) {
      const dayAliases = new Set(ageDaysCandidates.map(normalizeHeaderAlias));
      if (dayAliases.has(normalizeHeaderAlias(ageKey))) ageKey = '';
      else ageDaysKey = '';
    }
    const autoBirthWeightKey = findFieldNameFuzzy(sample, birthWeightCandidates) || findFieldName(sample, birthWeightCandidates) || '';
    const isAdmissionWeightKey = (key: string): boolean => /入院.*体重|admission[\s_.():，\u200B\uFEFF-]*weight/i.test(key);
    const bwKey = previewBirthWeightRef.current
      || (isAdmissionWeightKey(autoBirthWeightKey) ? '' : autoBirthWeightKey);
    const admissionWeightKey = previewAdmissionWeightRef.current || findFieldNameFuzzy(sample, admissionWeightCandidates) || findFieldName(sample, admissionWeightCandidates) || '';
    const dischargeKey = previewDischargeRef.current || findFieldNameFuzzy(sample, dischargeCandidates) || findFieldName(sample, dischargeCandidates) || '';
    const newTechKey = previewNewTechniqueRef.current || findFieldNameFuzzy(sample, newTechniqueCandidates) || findFieldName(sample, newTechniqueCandidates) || '';
    const intensiveCareKey = previewIntensiveCareRef.current || findFieldNameByNormalizedAlias(sample, intensiveCareCandidates) || '';
    const icuHoursKey = previewIcuHoursRef.current || findFieldNameFuzzy(sample, icuHoursCandidates) || findFieldName(sample, icuHoursCandidates) || '';
    const crrtHoursKey = previewCrrtHoursRef.current || findFieldNameFuzzy(sample, crrtHoursCandidates) || findFieldName(sample, crrtHoursCandidates) || '';
    const lengthOfStayKey = previewLengthOfStayRef.current || findFieldNameFuzzy(sample, lengthOfStayCandidates) || findFieldName(sample, lengthOfStayCandidates) || '';
    const daySurgeryKey = previewDaySurgeryRef.current || findFieldNameFuzzy(sample, daySurgeryCandidates) || findFieldName(sample, daySurgeryCandidates) || '';
    const genderKey = previewGenderRef.current || findFieldNameFuzzy(sample, genderCandidates) || findFieldName(sample, genderCandidates) || '';

    return { idKey, diagsKey, procsKey, ageKey, ageDaysKey, bwKey, admissionWeightKey, dischargeKey, newTechKey, intensiveCareKey, icuHoursKey, crrtHoursKey, lengthOfStayKey, daySurgeryKey, genderKey };
  }, [
    previewIdRef,
    previewDiagsRef,
    previewProcsRef,
    previewAgeRef,
    previewAgeDaysRef,
    previewBirthWeightRef,
    previewAdmissionWeightRef,
    previewDischargeRef,
    previewNewTechniqueRef,
    previewIntensiveCareRef,
    previewIcuHoursRef,
    previewCrrtHoursRef,
    previewLengthOfStayRef,
    previewDaySurgeryRef,
    previewGenderRef,
    findFieldName,
    findFieldNameFuzzy,
    findFieldNameByNormalizedAlias,
  ]);

  const detectDelimiterForColumn = useCallback((rows: BatchRawRow[], columnKey: string | null): string | null => {
    if (rows.length === 0 || !columnKey) return null;
    const delims = AUTO_DETECT_DELIMITERS;
    const counts = delims.map(d => {
      let totalTokens = 0;
      let samples = 0;
      for (const r of rows) {
        try {
          const v = r[columnKey] || '';
          const s = String(v);
          if (!s) continue;
          const toks = s.split(d).map(t => t.trim()).filter(Boolean);
          totalTokens += toks.length;
          samples++;
        } catch {
          // ignore delimiter sampling errors
        }
      }
      return samples > 0 ? (totalTokens / samples) : 0;
    });

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < counts.length; i++) {
      const score = counts[i] ?? 0;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx === -1 || bestScore <= 1.1) return null;
    return delims[bestIdx] ?? null;
  }, []);

  return {
    buildNormMissesArray,
    normalizeEntriesNoUI,
    cleanCell,
    getMappingKeys,
    detectDelimiterForColumn,
  };
}
