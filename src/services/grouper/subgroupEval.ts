import { PATIENT_NUMERIC_CONDITIONS, PATIENT_BOOLEAN_CONDITIONS, PATIENT_ENUM_CONDITIONS } from '../../types/patient_info_fields.ts';
import type {
  MatchTraceEntry,
  NormalizedPatientInfo,
  SubgroupEvaluation,
  VersionStrategy,
} from '../../types/grouper.js';
import type {
  AdrgRule,
  ComparisonOperator,
  DrgSubgroupRule,
  RuleMatchResult,
  RulePatient,
  RuleSet,
} from '../../types/rules.js';

type CCStatus = 'none' | 'cc' | 'mcc';

function compareNumeric(value: number, limit: number, operator: ComparisonOperator): boolean {
  switch (operator) {
    case 'LT': return value < limit;
    case 'LE': return value <= limit;
    case 'GT': return value > limit;
    case 'GE': return value >= limit;
  }
}

interface SubgroupPatientData {
  primaryDiagnosis: string | null;
  primaryProcedure: string | null;
  patientInfo: NormalizedPatientInfo;
  robotAssistedSurgery: boolean;
}

type SubgroupRuleSet = Pick<
  RuleSet,
  'loadDRGSubgroupRulesForADRG' | 'loadCCCodes' | 'loadMCCCodes' | 'loadCCECodes'
>;

export function createSubgroupEvaluator(
  ruleSet: SubgroupRuleSet,
  matchesRule: (rule: AdrgRule, patient: RulePatient) => RuleMatchResult,
  versionStrategy: VersionStrategy,
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
  versionStrategy.robotAssistedSurgery.procedureCodes,
);
const _highRiskPregnancyDiagnoses = new Set(
  versionStrategy.highRiskPregnancyAsMcc.diagnosisCodes,
);
const _ruleNeedsCCCache = new WeakMap<DrgSubgroupRule, boolean>();

function ruleNeedsCC(rule: DrgSubgroupRule) {
  const cached = _ruleNeedsCCCache.get(rule);
  if (cached !== undefined) return cached;
  const conditions = rule.conditions;
  const needs = conditions.includes('WITH_MCC') || conditions.includes('WITH_CC') || conditions.includes('NO_CC');
  _ruleNeedsCCCache.set(rule, needs);
  return needs;
}

function calculateCCStatus(diagnoses: string[]): CCStatus {
  if (diagnoses.length <= 1) return 'none';
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
    conditions,
    diagnosisCodes = [],
    procedureCodes = [],
    diagnosisPrefixes = [],
    procedurePrefixes = []
  } = rule;

  for (const condition of conditions) {
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
    const numericMatch = condition.match(/^(.+)_(LT|LE|GT|GE)_(\d+)$/);
    if (numericMatch && Object.hasOwn(PATIENT_NUMERIC_CONDITIONS, numericMatch[1]!)) {
      const [, dimension, operator, rawLimit] = numericMatch as [
        string,
        string,
        ComparisonOperator,
        string,
      ];
      const { field, label } = PATIENT_NUMERIC_CONDITIONS[dimension]!;
      const value = patientData.patientInfo[field];
      if (value === undefined) return { matched: false, reason: `${label} not provided` };

      const limit = parseInt(rawLimit, 10);
      const isMatched = compareNumeric(value, limit, operator);

      if (!isMatched) {
        const opSymbols: Record<'LT' | 'LE' | 'GT' | 'GE', string> = { LT: '<', LE: '<=', GT: '>', GE: '>=' };
        return { matched: false, reason: `${label} ${value} is not ${opSymbols[operator]} ${limit}` };
      }
      continue;
    }

    // --- 4. Registered enum and boolean patient attributes
    if (Object.hasOwn(PATIENT_ENUM_CONDITIONS, condition)) {
      const { field, value, missingReason } = PATIENT_ENUM_CONDITIONS[condition]!;
      if (patientData.patientInfo[field] !== value) return { matched: false, reason: missingReason };
      continue;
    }

    if (Object.hasOwn(PATIENT_BOOLEAN_CONDITIONS, condition)) {
      const { field, missingReason } = PATIENT_BOOLEAN_CONDITIONS[condition]!;
      if (!patientData.patientInfo[field]) return { matched: false, reason: missingReason };
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
   * - Returns a matched DRG and subgroup; an ADRG without a matching subgroup
   *   violates the generated-rule invariant.
   */
function evaluateADRGSubgroups(
  adrgCode: string,
  diagnoses: string[],
  procedures: Array<string | null>,
  patientInfo: NormalizedPatientInfo,
  matchTrace: MatchTraceEntry[],
): SubgroupEvaluation {
    const candidateRules = loadDRGSubgroupRulesForADRG(adrgCode);
    if (candidateRules.length === 0) {
      throw new Error(`No DRG subgroup rules configured for ADRG ${adrgCode}`);
    }

    const principalDiagnosis = diagnoses[0] ?? null;
    const principalProcedure = procedures[0] ?? null;

    const subgroupCandidates = candidateRules.map(rule => ({ code: rule.drgCode, name: rule.drgName }));
    let ccStatus: CCStatus = 'none';
    const hasAnyCCRule = candidateRules.some(ruleNeedsCC);

    if (hasAnyCCRule) {
      const calculatedStatus = calculateCCStatus(diagnoses);
      const configuredAdrgCodes = versionStrategy.highRiskPregnancyAsMcc.adrgCodes;
      const highRiskPregnancyAsMcc = Boolean(
        configuredAdrgCodes.includes(adrgCode)
        && principalDiagnosis
        && _highRiskPregnancyDiagnoses.has(principalDiagnosis),
      );
      ccStatus = highRiskPregnancyAsMcc ? 'mcc' : calculatedStatus;

      if (versionStrategy.daySurgeryAsNoCC === true && patientInfo.daySurgery === true) {
        const statusBeforeOverride = ccStatus;
        ccStatus = 'none';
        matchTrace.push({
          event: 'cc-status',
          status: ccStatus,
          calculatedStatus,
          overridden: true,
          strategy: 'daySurgeryAsNoCC',
          description: `Edition strategy treats day surgery as NO_CC (before override: ${statusBeforeOverride}, calculated: ${calculatedStatus})`,
        });
      } else if (highRiskPregnancyAsMcc || diagnoses.length > 1) {
        matchTrace.push({
          event: 'cc-status',
          status: ccStatus,
          calculatedStatus,
          ...(highRiskPregnancyAsMcc ? { strategy: 'highRiskPregnancyAsMcc' } : {}),
          description: highRiskPregnancyAsMcc
            ? `Version strategy promotes high-risk pregnancy principal diagnosis to MCC (calculated: ${calculatedStatus})`
            : `Calculated CC Status: ${ccStatus}`,
        });
      }
    }

    const configuredRobotAdrgCodes = versionStrategy.robotAssistedSurgery.adrgCodes;
    const robotAssistedSurgery = Boolean(
      configuredRobotAdrgCodes.includes(adrgCode)
      && procedures.some(code => code && _robotAssistedSurgeryProcedures.has(code)),
    );
    const patientData = {
      primaryDiagnosis: principalDiagnosis,
      primaryProcedure: principalProcedure,
      patientInfo,
      robotAssistedSurgery,
    };
    const patient: RulePatient = { diagnoses, procedures, patientInfo };

    for (const rule of candidateRules) {
      let adrgMatchResult = null;
      if (rule.adrgRule) {
        adrgMatchResult = matchesRule(rule.adrgRule, patient);
        if (!adrgMatchResult.matched) continue;
      }
      const matchResult = evaluateDRGRule(rule, patientData, ccStatus);
      if (matchResult.matched) {
        matchTrace.push({
          event: 'subgroup-match',
          matched: true,
          code: rule.drgCode,
          description: rule.drgName,
          candidateCount: candidateRules.length,
          candidates: subgroupCandidates,
          detail: adrgMatchResult
            ? { adrgRule: adrgMatchResult, conditions: matchResult }
            : { conditions: matchResult },
        });
        return {
          matchedDRG: { code: rule.drgCode, description: rule.drgName },
        };
      }
    }

    matchTrace.push({
      event: 'subgroup-no-match',
      matched: false,
      description: 'No detailed rules matched',
      candidateCount: candidateRules.length,
      candidates: subgroupCandidates,
    });
    throw new Error(`No DRG subgroup matched ADRG ${adrgCode}`);
  }

  return { evaluateADRGSubgroups };
}
