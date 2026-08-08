export function createSubgroupEvaluator(ruleSet) {
  const { loadDRGSubgroupRulesForADRG, loadCCCodes, loadMCCCodes, loadCCECodes } = ruleSet;

/*
 * Subgroup evaluation — evaluate detailed ADRG subgroup rules and CC/MCC status.
 * Keep logic local and minimal; behavior must remain identical to the legacy
 * implementation (used by subgroup selection in the grouping engine).
 */

// Preload CC/MCC/CCE maps to keep subgroup evaluation fast
const _ccList = loadCCCodes();
const _mccList = loadMCCCodes();
const _cceList = loadCCECodes();
const _ruleNeedsCCCache = new WeakMap();

function ruleNeedsCC(rule) {
  if (_ruleNeedsCCCache.has(rule)) return _ruleNeedsCCCache.get(rule);
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const needs = conditions.includes('WITH_MCC') || conditions.includes('WITH_CC') || conditions.includes('NO_CC');
  _ruleNeedsCCCache.set(rule, needs);
  return needs;
}

/**
 * Evaluate a single DRG subgroup rule against patient data.
 * - rule.conditions is an array of tokens (e.g. 'SPECIFIC_DIAGNOSIS', 'WITH_MCC')
 * - patientData contains primaryDiagnosis, primaryProcedure, age, dischargeStatus, newTechnique
 * - ccStatus is one of 'none'|'cc'|'mcc'
 *
 * Returns { matched: boolean, reason: string }
 */
function evaluateDRGRule(rule, patientData, ccStatus) {
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
      if (!patientData.primaryDiagnosis) return { matched: false, reason: 'No primary diagnosis' };
      const ok = diagnosisCodes.some(d => (typeof d === 'string' ? d : d.code) === patientData.primaryDiagnosis);
      if (!ok) return { matched: false, reason: `Primary diagnosis ${patientData.primaryDiagnosis} not in list` };
      continue; // 💡 换成 continue：代表当前规则通过，继续校验下一个 condition
    }

    if (condition === 'SPECIFIC_DIAGNOSIS_PREFIX') {
      if (!patientData.primaryDiagnosis) return { matched: false, reason: 'No primary diagnosis' };
      const ok = diagnosisPrefixes.some(pref => patientData.primaryDiagnosis.startsWith(pref));
      if (!ok) return { matched: false, reason: `Primary diagnosis ${patientData.primaryDiagnosis} does not match prefixes` };
      continue;
    }

    // --- 2. 手术校验 (Procedure Checks)
    if (condition === 'SPECIFIC_PROCEDURE') {
      if (!patientData.primaryProcedure) return { matched: false, reason: 'No primary procedure' };
      const ok = procedureCodes.some(p => (typeof p === 'string' ? p : p.code) === patientData.primaryProcedure);
      if (!ok) return { matched: false, reason: `Primary procedure ${patientData.primaryProcedure} not in list` };
      continue;
    }

    if (condition === 'SPECIFIC_PROCEDURE_PREFIX') {
      if (!patientData.primaryProcedure) return { matched: false, reason: 'No primary procedure' };
      const ok = procedurePrefixes.some(pref => patientData.primaryProcedure.startsWith(pref));
      if (!ok) return { matched: false, reason: `Primary procedure ${patientData.primaryProcedure} does not match prefixes` };
      continue;
    }

    // --- 3. 动态年龄校验 (⭐ 核心升级：完美融合正则与动态数值)
    const match = condition.match(/^AGE_(LT|LE|GT|GE)_(\d+)$/);
    if (match) {
      if (patientData.age === undefined || patientData.age === null) return { matched: false, reason: 'Age not provided' };

      const operator = match[1];          // 拿到 'LT', 'LE', 'GT', 或 'GE'
      const limit = parseInt(match[2], 10); // 动态解析出任何数字（如 18, 65, 21）
      const age = patientData.age;

      // 动态规则矩阵映射
      const isMatched =
        operator === 'LT' ? age < limit :
          operator === 'LE' ? age <= limit :
            operator === 'GT' ? age > limit :
              operator === 'GE' ? age >= limit : false;

      if (!isMatched) {
        const opSymbols = { LT: '<', LE: '<=', GT: '>', GE: '>=' };
        return { matched: false, reason: `Age ${age} is not ${opSymbols[operator]} ${limit}` };
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
function evaluateADRGSubgroups(matchedADRG, diagnoses, patientInfo, principalDiagnosis, principalProcedure, matchTrace) {
    const candidateRules = matchedADRG ? loadDRGSubgroupRulesForADRG(matchedADRG.code) : [];
    if (!candidateRules || candidateRules.length === 0) return { matchedDRG: null, matchedSubgroup: null };

    matchTrace.push({ stage: 'Subgroup', description: `Evaluating ${candidateRules.length} detailed rules for ${matchedADRG.code}` });

    let ccStatus = 'none';
    const hasAnyCCRule = candidateRules.some(ruleNeedsCC);

    if (hasAnyCCRule && Array.isArray(diagnoses) && diagnoses.length > 1) {
      const exclusionId = _cceList[principalDiagnosis] || null;
      let hasMCC = false;
      let hasCC = false;

      for (let i = 1; i < diagnoses.length; i++) {
        const dx = diagnoses[i];
        if (_mccList[dx] && _mccList[dx] !== exclusionId) {
          hasMCC = true;
          break;
        }
      }

      if (!hasMCC) {
        for (let i = 1; i < diagnoses.length; i++) {
          const dx = diagnoses[i];
          if (_ccList[dx] && _ccList[dx] !== exclusionId) {
            hasCC = true;
            break;
          }
        }
      }

      ccStatus = hasMCC ? 'mcc' : (hasCC ? 'cc' : 'none');
      matchTrace.push({ stage: 'CC/MCC', status: ccStatus, description: `Calculated CC Status: ${ccStatus}` });
    }

    const patientData = {
      primaryDiagnosis: principalDiagnosis,
      primaryProcedure: principalProcedure,
      age: patientInfo?.age,
      dischargeStatus: patientInfo?.dischargeStatus,
      newTechnique: !!patientInfo?.newTechnique
    };

    let matchedSubgroup = null;

    for (const rule of candidateRules) {
      const matchResult = evaluateDRGRule(rule, patientData, ccStatus);
      if (matchResult.matched) {
        matchedSubgroup = { ...rule, matchResult };
        matchTrace.push({ stage: 'Subgroup', matched: true, code: matchedSubgroup.drgCode, description: matchedSubgroup.drgName, detail: matchResult });
        break;
      }
    }

    if (!matchedSubgroup) matchTrace.push({ stage: 'Subgroup', matched: false, description: 'No detailed rules matched' });

    const matchedDRG = matchedSubgroup ? { code: matchedSubgroup.drgCode, description: matchedSubgroup.drgName } : null;
    return { matchedDRG, matchedSubgroup };
  }
  return { evaluateADRGSubgroups };
}
