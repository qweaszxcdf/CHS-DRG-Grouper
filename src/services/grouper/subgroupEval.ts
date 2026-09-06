import type {
  MatchTraceEntry,
  NormalizedPatientInfo,
  SubgroupEvaluation,
  VersionStrategy,
} from '../../types/grouper.js';
import type {
  AdrgRule,
  DrgSubgroupRule,
  MatchedSubgroup,
  RuleMatchResult,
  RulePatient,
  RuleSet,
} from '../../types/rules.js';

type CCStatus = 'none' | 'cc' | 'mcc';

const DEFAULT_VERSION_STRATEGY: VersionStrategy = {
  daySurgeryAsNoCC: false,
  robotAssistedSurgery: { adrgCodes: [], procedureCodes: [] },
  highRiskPregnancyAsMcc: { adrgCodes: [], diagnosisCodes: [] },
};

interface SubgroupPatientData {
  primaryDiagnosis: string | null;
  primaryProcedure: string | null;
  age?: number;
  dischargeStatus?: string | number;
  robotAssistedSurgery: boolean;
  newTechnique: boolean;
  intensiveCare: boolean;
  icuHours?: number;
  crrtHours?: number;
  lengthOfStay?: number;
  daySurgery: boolean;
}

export function createSubgroupEvaluator(
  ruleSet: RuleSet,
  matchesAdrgRule: ((rule: AdrgRule, patient: RulePatient) => RuleMatchResult) | undefined,
  versionStrategy: VersionStrategy = DEFAULT_VERSION_STRATEGY,
) {
  const {
    loadDRGSubgroupRulesForADRG,
    loadCCCodes,
    loadMCCCodes,
    loadCCECodes,
  } = ruleSet;

/*
 * Subgroup evaluation — evaluate detailed ADRG subgroup rules and CC/MCC status.
 * Keep logic local and minimal; behavior must remain identical to the legacy
 * implementation (used by subgroup selection in the grouping engine).
 */

// Preload CC/MCC/CCE maps to keep subgroup evaluation fast
const _ccList = loadCCCodes();
const _mccList = loadMCCCodes();
const _cceList = loadCCECodes();
const _robotAssistedSurgeryProcedures = new Set(
  versionStrategy.robotAssistedSurgery?.procedureCodes || [],
);
const _highRiskPregnancyDiagnoses = new Set(
  versionStrategy.highRiskPregnancyAsMcc?.diagnosisCodes || [],
);
const _ruleNeedsCCCache = new WeakMap<DrgSubgroupRule, boolean>();

function ruleNeedsCC(rule: DrgSubgroupRule) {
  if (_ruleNeedsCCCache.has(rule)) return _ruleNeedsCCCache.get(rule);
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const needs = conditions.includes('WITH_MCC') || conditions.includes('WITH_CC') || conditions.includes('NO_CC');
  _ruleNeedsCCCache.set(rule, needs);
  return needs;
}

function calculateCCStatus(diagnoses: string[]): CCStatus {
  if (!Array.isArray(diagnoses) || diagnoses.length <= 1) return 'none';
  const principalDiagnosis = diagnoses[0] ?? null;
  const exclusionId = principalDiagnosis && Object.hasOwn(_cceList, principalDiagnosis)
    ? _cceList[principalDiagnosis] || null
    : null;
  for (let index = 1; index < diagnoses.length; index += 1) {
    const diagnosis = diagnoses[index];
    if (diagnosis && Object.hasOwn(_mccList, diagnosis) && _mccList[diagnosis] && _mccList[diagnosis] !== exclusionId) return 'mcc';
  }
  for (let index = 1; index < diagnoses.length; index += 1) {
    const diagnosis = diagnoses[index];
    if (diagnosis && Object.hasOwn(_ccList, diagnosis) && _ccList[diagnosis] && _ccList[diagnosis] !== exclusionId) return 'cc';
  }
  return 'none';
}

/**
 * Evaluate a single DRG subgroup rule against patient data.
 * - rule.conditions is an array of tokens (e.g. 'SPECIFIC_DIAGNOSIS', 'WITH_MCC')
 * - patientData contains primaryDiagnosis, primaryProcedure and normalized patient attributes
 * - ccStatus is one of 'none'|'cc'|'mcc'
 *
 * Returns { matched: boolean, reason: string }
 */
function evaluateDRGRule(rule: DrgSubgroupRule, patientData: SubgroupPatientData, ccStatus: CCStatus) {
  const {
    conditions = [],
    diagnosisCodes = [],
    procedureCodes = [],
    diagnosisPrefixes = [],
    procedurePrefixes = []
  } = rule;

  for (const condition of conditions) {
    if (typeof condition !== 'string') {
      return { matched: false, reason: `Condition must be a string, received ${condition === null ? 'null' : typeof condition}` };
    }

    // --- 1. 诊断校验 (Diagnosis Checks)
    if (condition === 'SPECIFIC_DIAGNOSIS') {
      const primaryDiagnosis = patientData.primaryDiagnosis;
      if (!primaryDiagnosis) return { matched: false, reason: 'No primary diagnosis' };
      const ok = diagnosisCodes.some(d => (typeof d === 'string' ? d : d.code) === primaryDiagnosis);
      if (!ok) return { matched: false, reason: `Primary diagnosis ${primaryDiagnosis} not in list` };
      continue; // 💡 换成 continue：代表当前规则通过，继续校验下一个 condition
    }

    if (condition === 'SPECIFIC_DIAGNOSIS_PREFIX') {
      const primaryDiagnosis = patientData.primaryDiagnosis;
      if (!primaryDiagnosis) return { matched: false, reason: 'No primary diagnosis' };
      const ok = diagnosisPrefixes.some(pref => primaryDiagnosis.startsWith(pref));
      if (!ok) return { matched: false, reason: `Primary diagnosis ${primaryDiagnosis} does not match prefixes` };
      continue;
    }

    // --- 2. 手术校验 (Procedure Checks)
    if (condition === 'SPECIFIC_PROCEDURE') {
      const primaryProcedure = patientData.primaryProcedure;
      if (!primaryProcedure) return { matched: false, reason: 'No primary procedure' };
      const ok = procedureCodes.some(p => (typeof p === 'string' ? p : p.code) === primaryProcedure);
      if (!ok) return { matched: false, reason: `Primary procedure ${primaryProcedure} not in list` };
      continue;
    }

    if (condition === 'SPECIFIC_PROCEDURE_PREFIX') {
      const primaryProcedure = patientData.primaryProcedure;
      if (!primaryProcedure) return { matched: false, reason: 'No primary procedure' };
      const ok = procedurePrefixes.some(pref => primaryProcedure.startsWith(pref));
      if (!ok) return { matched: false, reason: `Primary procedure ${primaryProcedure} does not match prefixes` };
      continue;
    }

    // --- 3. Numeric patient attributes
    const numericMatch = condition.match(/^(AGE|ICU_HOURS|CRRT_HOURS|LOS)_(LT|LE|GT|GE)_(\d+)$/);
    if (numericMatch) {
      const [, dimension, operator, rawLimit] = numericMatch;
      const dimensions: Record<string, { field: 'age' | 'icuHours' | 'crrtHours' | 'lengthOfStay'; label: string }> = {
        AGE: { field: 'age', label: 'Age' },
        ICU_HOURS: { field: 'icuHours', label: 'ICU hours' },
        CRRT_HOURS: { field: 'crrtHours', label: 'CRRT hours' },
        LOS: { field: 'lengthOfStay', label: 'Length of stay' },
      };
      const dimensionInfo = dimensions[dimension ?? ''];
      if (!dimensionInfo) return { matched: false, reason: `Unknown numeric condition '${condition}'` };
      const { field, label } = dimensionInfo;
      const value = patientData[field];
      if (value === undefined || value === null) return { matched: false, reason: `${label} not provided` };

      const limit = parseInt(rawLimit ?? '', 10);
      const comparisonOperator = operator as 'LT' | 'LE' | 'GT' | 'GE';
      const isMatched =
        comparisonOperator === 'LT' ? value < limit :
          comparisonOperator === 'LE' ? value <= limit :
            comparisonOperator === 'GT' ? value > limit :
              comparisonOperator === 'GE' ? value >= limit : false;

      if (!isMatched) {
        const opSymbols: Record<'LT' | 'LE' | 'GT' | 'GE', string> = { LT: '<', LE: '<=', GT: '>', GE: '>=' };
        return { matched: false, reason: `${label} ${value} is not ${opSymbols[comparisonOperator]} ${limit}` };
      }
      continue;
    }

    // --- 4. 离院结局校验 (Outcome Checks)
    if (condition === 'DEATH') {
      if (patientData.dischargeStatus !== 'death' && patientData.dischargeStatus !== 5 && patientData.dischargeStatus !== '5') {
        return { matched: false, reason: 'Outcome is not Death' };
      }
      continue;
    }

    if (condition === 'INTENSIVE_CARE') {
      if (!patientData.intensiveCare) return { matched: false, reason: 'Intensive care required but not present' };
      continue;
    }

    if (condition === 'DAY_SURGERY') {
      if (!patientData.daySurgery) return { matched: false, reason: 'Day surgery required but not present' };
      continue;
    }

    // --- 5. 并发症/合并症校验 (CC / MCC Checks)
    if (condition === 'WITH_MCC') {
      if (ccStatus !== 'mcc') return { matched: false, reason: `CC Status is ${ccStatus}, not mcc` };
      continue;
    }
    if (condition === 'WITH_CC') {
      if (ccStatus === 'none') return { matched: false, reason: `CC Status is ${ccStatus}, not cc/mcc` };
      continue;
    }
    if (condition === 'NO_CC') {
      continue;
    }

    // --- 6. 其他独立标签校验
    if (condition === 'ROBOT_ASSISTED_SURGERY') {
      if (!patientData.robotAssistedSurgery) {
        return { matched: false, reason: 'Official robot-assisted surgery procedure required but not present' };
      }
      continue;
    }

    if (condition === 'NEW_TECHNIQUE') {
      if (!patientData.newTechnique) return { matched: false, reason: 'NEW_TECHNIQUE required but not present' };
      continue;
    }

    if (condition === 'ADRG_ONLY') {
      continue; // 显式放行
    }

    // --- 7. 未识别规则拦截
    return { matched: false, reason: `Condition '${condition}' not recognized` };
  }

  // 只有当循环内所有的 condition 都安全越过（未被 return 拦截），才说明全部通过
  return { matched: true, reason: 'Matched all conditions' };
};

  /**
   * Evaluate detailed subgroup (DRG) rules for a matched ADRG.
   * - Returns { matchedDRG, matchedSubgroup } where matchedSubgroup contains the matching rule and matchResult.
   */
function evaluateADRGSubgroups(
  adrgCode: string | null,
  diagnoses: string[],
  procedures: Array<string | null>,
  patientInfo: NormalizedPatientInfo,
  matchTrace: MatchTraceEntry[],
): SubgroupEvaluation {
    const candidateRules = adrgCode !== null ? loadDRGSubgroupRulesForADRG(adrgCode) : [];
    if (!candidateRules || candidateRules.length === 0) return { matchedDRG: null, matchedSubgroup: null };

    const principalDiagnosis = diagnoses[0] ?? null;
    const principalProcedure = procedures[0] ?? null;

    matchTrace.push({ stage: 'Subgroup', description: `Evaluating ${candidateRules.length} detailed rules (${candidateRules.map(r => r.drgCode).join(', ')})` });

    let ccStatus: CCStatus = 'none';
    const hasAnyCCRule = candidateRules.some(ruleNeedsCC);

    if (hasAnyCCRule) {
      const calculatedStatus: CCStatus = Array.isArray(diagnoses) && diagnoses.length > 1
        ? calculateCCStatus(diagnoses)
        : 'none';
      const configuredAdrgCodes = versionStrategy.highRiskPregnancyAsMcc?.adrgCodes;
      const highRiskPregnancyAsMcc = Boolean(
        adrgCode !== null
        && Array.isArray(configuredAdrgCodes)
        && configuredAdrgCodes.includes(adrgCode)
        && principalDiagnosis
        && _highRiskPregnancyDiagnoses.has(principalDiagnosis),
      );
      ccStatus = highRiskPregnancyAsMcc ? 'mcc' : calculatedStatus;

      if (versionStrategy.daySurgeryAsNoCC === true && patientInfo?.daySurgery === true) {
        const statusBeforeOverride = ccStatus;
        ccStatus = 'none';
        matchTrace.push({
          stage: 'CC/MCC',
          status: ccStatus,
          calculatedStatus,
          overridden: true,
          strategy: 'daySurgeryAsNoCC',
          description: `Edition strategy treats day surgery as NO_CC (before override: ${statusBeforeOverride}, calculated: ${calculatedStatus})`,
        });
      } else if (highRiskPregnancyAsMcc || (Array.isArray(diagnoses) && diagnoses.length > 1)) {
        matchTrace.push({
          stage: 'CC/MCC',
          status: ccStatus,
          calculatedStatus,
          ...(highRiskPregnancyAsMcc ? { strategy: 'highRiskPregnancyAsMcc' } : {}),
          description: highRiskPregnancyAsMcc
            ? `Version strategy promotes high-risk pregnancy principal diagnosis to MCC (calculated: ${calculatedStatus})`
            : `Calculated CC Status: ${ccStatus}`,
        });
      }
    }

    const configuredRobotAdrgCodes = versionStrategy.robotAssistedSurgery?.adrgCodes;
    const robotAssistedSurgery = Boolean(
      adrgCode !== null
      && Array.isArray(configuredRobotAdrgCodes)
      && configuredRobotAdrgCodes.includes(adrgCode)
      && procedures.some(code => code && _robotAssistedSurgeryProcedures.has(code)),
    );
    const patientData = {
      primaryDiagnosis: principalDiagnosis,
      primaryProcedure: principalProcedure,
      age: patientInfo?.age,
      dischargeStatus: patientInfo?.dischargeStatus,
      robotAssistedSurgery,
      newTechnique: !!patientInfo?.newTechnique,
      intensiveCare: !!patientInfo?.intensiveCare,
      icuHours: patientInfo?.icuHours,
      crrtHours: patientInfo?.crrtHours,
      lengthOfStay: patientInfo?.lengthOfStay,
      daySurgery: !!patientInfo?.daySurgery
    };
    const patient: RulePatient = { diagnoses, procedures, patientInfo };

    let matchedSubgroup: MatchedSubgroup | null = null;

    for (const rule of candidateRules) {
      let adrgMatchResult = null;
      if (rule.adrgRule) {
        if (typeof matchesAdrgRule !== 'function') continue;
        adrgMatchResult = matchesAdrgRule(rule.adrgRule, patient);
        if (!adrgMatchResult.matched) continue;
      }
      const matchResult = evaluateDRGRule(rule, patientData, ccStatus);
      if (matchResult.matched) {
        matchedSubgroup = { ...rule, matchResult, adrgMatchResult };
        matchTrace.push({
          stage: 'Subgroup',
          matched: true,
          code: matchedSubgroup.drgCode,
          description: matchedSubgroup.drgName,
          detail: adrgMatchResult ? { adrgRule: adrgMatchResult, conditions: matchResult } : matchResult,
        });
        break;
      }
    }

    if (!matchedSubgroup) matchTrace.push({ stage: 'Subgroup', matched: false, description: 'No detailed rules matched' });

    const matchedDRG = matchedSubgroup ? { code: matchedSubgroup.drgCode, description: matchedSubgroup.drgName } : null;
    return { matchedDRG, matchedSubgroup };
  }

  return { evaluateADRGSubgroups };
}
