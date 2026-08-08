import { useCallback, useEffect, useRef } from 'react';
import { getIcdIndex } from '../services/CodeSearch';

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
  previewDischargeRef,
  previewNewTechniqueRef,
  previewMultiSiteRef,
  previewGenderRef,
  failedNormalizationRef,
  setNormMisses,
}) {
  const searchCacheRef = useRef(new Map());
  const nameIndexRef = useRef(null);

  const buildNormMissesArray = useCallback(() => {
    const arr = [];
    for (const [k, v] of failedNormalizationRef.current.entries()) {
      const parts = String(k).split('|');
      const src = parts[0] || '';
      const type = parts[1] || '';
      const displayed = (v && v.original) ? v.original : parts.slice(2).join('|') || '';
      arr.push({ key: k, src, type, value: displayed, count: v.count || 0, lastSeen: v.lastSeen || null });
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

  const normalizeEntriesNoUI = useCallback((arr, type) => {
    if (!arr || !Array.isArray(arr)) return [];
    const out = [];
    for (let t of arr) {
      const raw = t == null ? '' : String(t);
      const s0 = raw.trim();
      const s = s0 ? s0 : '';
      if (!s) continue;
      const key = `${version || ''}:${type}:${(searchSource || 'YB')}:${s.toLowerCase()}`;
      if (searchCacheRef.current.has(key)) {
        const cached = searchCacheRef.current.get(key);
        if (cached && typeof cached === 'object' && cached.__type === 'miss') {
          try {
            const src = (searchSource || 'YB');
            const sNorm = String(s).normalize ? String(s).normalize('NFKC') : String(s);
            const sNormClean = String(sNorm).replace(/\u200B|\uFEFF|\u200C|\u200D|\u00AD|\u200E|\u200F/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');
            const failKeyClean = `${src}|${type}|${sNormClean}`;
            const prev = failedNormalizationRef.current.get(failKeyClean) || { count: 0, original: s };
            if (!prev.original) prev.original = s;
            prev.count++;
            prev.lastSeen = new Date().toISOString();
            failedNormalizationRef.current.set(failKeyClean, prev);
          } catch {
            // ignore miss-tracking failures
          }
          out.push(cached.value);
        } else {
          const val = (cached && typeof cached === 'object' && ('value' in cached)) ? cached.value : cached;
          out.push(val);
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

      try {
        try {
          const idx = getIcdIndex(version);
          if (!nameIndexRef.current || nameIndexRef.current.__index !== idx || nameIndexRef.current.__srcLen !== idx.length) {
            const m = new Map();
            for (const item of idx) {
              if (!item || !item.name) continue;
              const n = String(item.name).toLowerCase().trim();
              const arrRef = m.get(n);
              if (arrRef) arrRef.push(item); else m.set(n, [item]);
            }
            m.__index = idx;
            m.__srcLen = idx.length;
            nameIndexRef.current = m;
          }
          const candidates = nameIndexRef.current.get(s.toLowerCase().trim()) || [];
          const exact = candidates.filter(item => {
            if (!item) return false;
            if (item.type === 'DRG') return false;
            if (type && type !== 'All' && item.type !== type) return false;
            if (!item.source) return false;
            if (item.source !== searchSource) return false;
            return true;
          });
          if (exact && exact.length) {
            const code = exact[0].code || exact[0].value || exact[0].id || null;
            if (code) {
              searchCacheRef.current.set(key, { __type: 'code', value: code });
              out.push(code);
              continue;
            }
          }
        } catch {
          // ignore name-index lookup failures
        }
      } catch {
        // ignore normalization lookup failures
      }

      searchCacheRef.current.set(key, { __type: 'miss', value: s });
      out.push(s);

      try {
        const src = (searchSource || 'YB');
        const sNorm = String(s).normalize ? String(s).normalize('NFKC') : String(s);
        const sNormClean = String(sNorm).replace(/\u200B|\uFEFF|\u200C|\u200D|\u00AD|\u200E|\u200F/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');
        const failKeyClean = `${src}|${type}|${sNormClean}`;
        const prev = failedNormalizationRef.current.get(failKeyClean) || { count: 0, original: s };
        if (!prev.original) prev.original = s;
        prev.count++;
        prev.lastSeen = new Date().toISOString();
        failedNormalizationRef.current.set(failKeyClean, prev);
      } catch {
        // ignore miss-tracking failures
      }
    }
    return out.filter(Boolean);
  }, [searchSource, version, failedNormalizationRef]);

  const cleanCell = useCallback((val) => {
    if (val == null) return '';
    let s = String(val).trim();
    s = s.replace(/^[='\uFEFF\u200B]+/, '');
    if (s === '-') return '';
    return s;
  }, []);

  const findFieldName = useCallback((rowObj, candidates) => {
    if (!rowObj || typeof rowObj !== 'object') return null;
    const keys = Object.keys(rowObj || {});
    const lower = keys.map((k) => k.toLowerCase());
    for (const c of candidates) {
      const idx = lower.indexOf(String(c).toLowerCase());
      if (idx >= 0) return keys[idx];
    }
    return null;
  }, []);

  const findFieldNameFuzzy = useCallback((rowObj, candidates) => {
    if (!rowObj || typeof rowObj !== 'object') return null;
    const keys = Object.keys(rowObj || {});
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.():，\u200B\uFEFF-]/gu, '');
    const keyNorms = keys.map(k => norm(k));

    for (const c of candidates) {
      const lc = String(c).toLowerCase();
      const idx = keys.findIndex(k => String(k).toLowerCase() === lc);
      if (idx >= 0) return keys[idx];
    }

    for (const c of candidates) {
      const cn = norm(c);
      for (let i = 0; i < keyNorms.length; i++) {
        const kn = keyNorms[i];
        if (!kn || !cn) continue;
        if (kn === cn) return keys[i];
        if (kn.includes(cn) || cn.includes(kn)) return keys[i];
      }
    }

    const splitTokens = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const c of candidates) {
      const ctoks = splitTokens(c);
      if (!ctoks.length) continue;
      for (let i = 0; i < keys.length; i++) {
        const ktoks = splitTokens(keys[i]);
        if (!ktoks.length) continue;
        if (ctoks.some(t => ktoks.includes(t))) return keys[i];
      }
    }

    return null;
  }, []);

  const findFieldNameByNormalizedAlias = useCallback((rowObj, candidates) => {
    if (!rowObj || typeof rowObj !== 'object') return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.():，\u200B\uFEFF-]/gu, '');
    const aliases = new Set(candidates.map(norm).filter(Boolean));
    return Object.keys(rowObj).find((key) => aliases.has(norm(key))) || null;
  }, []);

  const getMappingKeys = useCallback((sample) => {
    const idCandidates = ['id', 'caseid', 'case_id', 'identifier', '编号', '序号', 'patient_id', 'patid', '病案号', '住院号'];
    const diagsCandidates = ['diagnoses', 'diagnosis', 'diag', 'diags', '诊断', '诊断列表'];
    const procsCandidates = ['procedures', 'procedure', 'proc', 'procs', '手术', '操作'];
    const ageCandidates = ['age', 'age_years', 'age_year', 'patient_age', 'patient_age_years', '年龄', '年龄岁', '岁'];
    const ageDaysCandidates = ['ageindays', 'age_in_days', 'age_days', 'patient_age_in_days', 'patient_age_days', '年龄天数', '出生年龄天数', '出生年龄(天)'];
    const birthWeightCandidates = ['birthweight', 'birth_weight', '出生体重', 'birth_weight_g', '体重'];
    const dischargeCandidates = ['discharge', 'discharge_status', 'dischargeStatus', '出院状态', 'discharge_status'];
    const newTechniqueCandidates = ['new_technique', 'newtechnique', 'new-technique', '新技术', 'new technique', 'is_new_tech', 'newtech'];
    const multiSiteCandidates = ['multi_site', 'multisite', 'multi-site', '多部位', '多部位手术', '多部位关节置换'];
    const genderCandidates = ['gender', 'sex', 'patient_sex', 'gender_code', '性别', '性别代码'];

    const idKey = (previewIdRef.current || '') || findFieldNameFuzzy(sample, idCandidates) || findFieldName(sample, idCandidates) || '';

    const _resolvePreview = (v) => {
      if (!v) return null;
      if (Array.isArray(v)) return v.length ? v : null;
      if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
      return null;
    };

    const previewDiags = _resolvePreview(previewDiagsRef.current);
    let diagsKey;
    if (previewDiags) diagsKey = previewDiags;
    else {
      const combined = findFieldNameFuzzy(sample, diagsCandidates) || findFieldName(sample, diagsCandidates) || null;
      diagsKey = combined ? [combined] : null;
    }

    const previewProcs = _resolvePreview(previewProcsRef.current);
    let procsKey;
    if (previewProcs) procsKey = previewProcs;
    else {
      const combined = findFieldNameFuzzy(sample, procsCandidates) || findFieldName(sample, procsCandidates) || null;
      procsKey = combined ? [combined] : null;
    }

    // Age-in-years and age-in-days deliberately use normalized exact aliases,
    // not generic substring matching: "age" must never also claim
    // "age_in_days" (or vice versa).
    let ageKey = (previewAgeRef.current || '') || findFieldNameByNormalizedAlias(sample, ageCandidates) || findFieldName(sample, ageCandidates) || '';
    let ageDaysKey = (previewAgeDaysRef.current || '') || findFieldNameByNormalizedAlias(sample, ageDaysCandidates) || findFieldName(sample, ageDaysCandidates) || '';
    if (ageKey && ageKey === ageDaysKey) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[\s_.():，\u200B\uFEFF-]/gu, '');
      const dayAliases = new Set(ageDaysCandidates.map(norm));
      if (dayAliases.has(norm(ageKey))) ageKey = '';
      else ageDaysKey = '';
    }
    const bwKey = (previewBirthWeightRef.current || '') || findFieldNameFuzzy(sample, birthWeightCandidates) || findFieldName(sample, birthWeightCandidates) || '';
    const dischargeKey = (previewDischargeRef.current || '') || findFieldNameFuzzy(sample, dischargeCandidates) || findFieldName(sample, dischargeCandidates) || '';
    const newTechKey = (previewNewTechniqueRef.current || '') || findFieldNameFuzzy(sample, newTechniqueCandidates) || findFieldName(sample, newTechniqueCandidates) || '';
    const multiSiteKey = (previewMultiSiteRef.current || '') || findFieldNameFuzzy(sample, multiSiteCandidates) || findFieldName(sample, multiSiteCandidates) || '';
    const genderKey = (previewGenderRef.current || '') || findFieldNameFuzzy(sample, genderCandidates) || findFieldName(sample, genderCandidates) || '';

    return { idKey, diagsKey, procsKey, ageKey, ageDaysKey, bwKey, dischargeKey, newTechKey, multiSiteKey, genderKey };
  }, [
    previewIdRef,
    previewDiagsRef,
    previewProcsRef,
    previewAgeRef,
    previewAgeDaysRef,
    previewBirthWeightRef,
    previewDischargeRef,
    previewNewTechniqueRef,
    previewMultiSiteRef,
    previewGenderRef,
    findFieldName,
    findFieldNameFuzzy,
    findFieldNameByNormalizedAlias,
  ]);

  const detectDelimiterForColumn = useCallback((rows, columnKey) => {
    if (!rows || rows.length === 0 || !columnKey) return null;
    const delims = ['|', ',', ';', '\t', '+'];
    const counts = delims.map(d => {
      let totalTokens = 0;
      let samples = 0;
      for (const r of rows) {
        try {
          const v = (r && typeof r === 'object') ? (r[columnKey] || '') : '';
          const s = v == null ? '' : String(v);
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
      if (counts[i] > bestScore) { bestScore = counts[i]; bestIdx = i; }
    }
    if (bestIdx === -1 || bestScore <= 1.1) return null;
    return delims[bestIdx];
  }, []);

  return {
    buildNormMissesArray,
    normalizeEntriesNoUI,
    cleanCell,
    getMappingKeys,
    detectDelimiterForColumn,
  };
}
