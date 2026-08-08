export function createMdcAdrgSelection(ruleSet, strategy) {
  const { MDCs, mdcByCode, diagToMDCZCategories, getADRGsForMDC, getADRGByCode } = ruleSet;

const _sectionClassCache = new Map();
const _referencedProcedureSetCache = new WeakMap();
const _ruleSectionMetaCache = new WeakMap();
const _patientLookupCache = new WeakMap();

function buildSectionClassification(sectionName) {
  const normalized = String(sectionName || '');
  const isDiag = normalized.includes('诊断');
  const isProc = normalized.includes('手术') || normalized.includes('操作');
  const isPrincipal = normalized.includes('主要');
  const isOther = normalized.includes('其他');
  const isSimultaneous = normalized.includes('同时包含');
  let category = null;
  if (isDiag) category = 'diagnosis';
  else if (isProc) category = 'procedure';
  let position = 'any';
  if (isPrincipal) position = 'principal';
  else if (isOther) position = 'other';
  return Object.freeze({ category, position, isSimultaneous });
}

function getReferencedProcedureSet(rule) {
  if (_referencedProcedureSetCache.has(rule)) return _referencedProcedureSetCache.get(rule);

  const procCodes = new Set();
  for (const refCode of rule.referencedADRGs) {
    const refADRG = getADRGByCode(refCode);
    if (!refADRG || !refADRG.rule) continue;

    const refRuleMeta = getRuleSectionMeta(refADRG.rule);
    if (!refRuleMeta || !Array.isArray(refRuleMeta.sectionDetails)) continue;

    for (const secMeta of refRuleMeta.sectionDetails) {
      if (secMeta.category !== 'procedure' || !secMeta.codeSet) continue;
      for (const code of secMeta.codeSet) procCodes.add(code);
    }
  }

  _referencedProcedureSetCache.set(rule, procCodes);
  return procCodes;
}

function getReferencedProcedureSetForADRG(refCode) {
  const refADRG = getADRGByCode(refCode);
  if (!refADRG || !refADRG.rule) return new Set();

  const refRuleMeta = getRuleSectionMeta(refADRG.rule);
  if (!refRuleMeta || !Array.isArray(refRuleMeta.sectionDetails)) return new Set();

  const procCodes = new Set();
  for (const secMeta of refRuleMeta.sectionDetails) {
    if (secMeta.category !== 'procedure' || !secMeta.codeSet) continue;
    for (const code of secMeta.codeSet) procCodes.add(code);
  }
  return procCodes;
}

function getPrimaryFallbackSectionName(sectionName) {
  const normalized = String(sectionName || '').trim();
  const diagnosisMatch = normalized.match(/^其他诊断(?:\s+(\d+))?$/);
  if (diagnosisMatch) return `主要诊断${diagnosisMatch[1] ? ` ${diagnosisMatch[1]}` : ''}`;

  const procedureMatch = normalized.match(/^其他手术或操作(?:\s+(\d+))?$/);
  if (procedureMatch) return `主要手术或操作${procedureMatch[1] ? ` ${procedureMatch[1]}` : ''}`;

  return null;
}

function getSectionCodes(rule, sectionName) {
  const sections = (rule && rule.sections) || {};
  const codes = Array.isArray(sections[sectionName]) ? sections[sectionName] : [];
  if (codes.length > 0) return codes;
  if (!strategy.allowSecondarySectionPrimaryFallback) return codes;

  const fallbackSectionName = getPrimaryFallbackSectionName(sectionName);
  if (!fallbackSectionName) return codes;

  const fallbackCodes = sections[fallbackSectionName];
  return Array.isArray(fallbackCodes) && fallbackCodes.length > 0 ? fallbackCodes : codes;
}

function getRuleSectionMeta(rule) {
  if (_ruleSectionMetaCache.has(rule)) return _ruleSectionMetaCache.get(rule);

  const sectionNames = Object.keys((rule && rule.sections) || {});
  let hasDiagSection = false;
  let hasProcSection = false;

  const sectionDetails = sectionNames.map(sec => {
    const { category, position, isSimultaneous } = classifySection(sec);
    if (category === 'diagnosis') hasDiagSection = true;
    if (category === 'procedure') hasProcSection = true;

    const codes = getSectionCodes(rule, sec);
    const codeSet = new Set(codes);

    return { sectionName: sec, category, position, isSimultaneous, codes, codeSet };
  });

  const meta = { sectionNames, sectionDetails, hasDiagSection, hasProcSection };
  _ruleSectionMetaCache.set(rule, meta);
  return meta;
}

function checkSectionMatchByMeta(sectionMeta, patientDiagnoses, patientProcedures, diagnosisLookup = null, procedureLookup = null) {
  if (!sectionMeta || !sectionMeta.codes || sectionMeta.codes.length === 0) return { matched: false, matchedCodes: [] };

  if (sectionMeta.category === 'diagnosis') {
    return matchCodesForPosition(sectionMeta.codes, patientDiagnoses, sectionMeta.position, diagnosisLookup);
  }
  if (sectionMeta.category === 'procedure') {
    return matchCodesForPosition(sectionMeta.codes, patientProcedures, sectionMeta.position, procedureLookup);
  }
  return { matched: false, matchedCodes: [] };
}

function createCodeLookup(patientCodes) {
  const src = Array.isArray(patientCodes) ? patientCodes : [];
  return {
    principal: src.length > 0 ? src[0] : null,
    allSet: new Set(src),
    secondarySet: src.length > 1 ? new Set(src.slice(1)) : null,
  };
}

// RPN evaluator local copy (move from ruleParserCore for modulo grouper logic)
function evaluateRPN(rpn, sectionBool) {
  const stack = [];
  for (const token of rpn) {
    if (typeof token === 'object' && token.type === 'SECTION') {
      stack.push(!!sectionBool[token.name]);
    } else if (token === '!') {
      stack.push(!stack.pop());
    } else if (token === '&&') {
      const b = stack.pop();
      const a = stack.pop();
      stack.push(!!a && !!b);
    } else if (token === '||') {
      const b = stack.pop();
      const a = stack.pop();
      stack.push(!!a || !!b);
    }
  }
  return stack.length > 0 ? !!stack[stack.length - 1] : false;
}

// Rule-evaluation helpers (migrated here from `ruleEval.js`)
function classifySection(sectionName) {
  const key = String(sectionName || '');
  if (_sectionClassCache.has(key)) return _sectionClassCache.get(key);
  const classification = buildSectionClassification(key);
  _sectionClassCache.set(key, classification);
  return classification;
}

function matchCodesForPosition(codes, patientCodes, position, patientCodeLookup = null) {
  if (!codes || codes.length === 0) return { matched: false, matchedCodes: [] };

  if (position === 'principal') {
    const principal = patientCodeLookup ? patientCodeLookup.principal : (patientCodes.length > 0 ? patientCodes[0] : null);
    const hit = principal != null && codes.includes(principal);
    return { matched: hit, matchedCodes: hit ? [principal] : [] };
  }
  if (position === 'other') {
    const secondarySet = patientCodeLookup ? patientCodeLookup.secondarySet : null;
    if (secondarySet) {
      const hits = [];
      for (const code of codes) {
        if (secondarySet.has(code)) hits.push(code);
      }
      return { matched: hits.length > 0, matchedCodes: hits };
    }

    const secondaries = patientCodes.slice(1);
    const hits = codes.filter(c => secondaries.includes(c));
    return { matched: hits.length > 0, matchedCodes: hits };
  }

  const allSet = patientCodeLookup ? patientCodeLookup.allSet : null;
  if (allSet) {
    const hits = [];
    for (const code of codes) {
      if (allSet.has(code)) hits.push(code);
    }
    return { matched: hits.length > 0, matchedCodes: hits };
  }

  const hits = codes.filter(c => patientCodes.includes(c));
  return { matched: hits.length > 0, matchedCodes: hits };
}

function matchesRule(rule, patient) {
  const patientDiagnoses = Array.isArray(patient.diagnoses) ? patient.diagnoses : [];
  const patientProcedures = Array.isArray(patient.procedures) ? patient.procedures : [];
  let patientLookup = _patientLookupCache.get(patient);
  if (!patientLookup) {
    patientLookup = { diagnosisLookup: null, procedureLookup: null };
    _patientLookupCache.set(patient, patientLookup);
  }

  const ensureDiagnosisLookup = () => {
    if (!patientLookup.diagnosisLookup) patientLookup.diagnosisLookup = createCodeLookup(patientDiagnoses);
    return patientLookup.diagnosisLookup;
  };

  const ensureProcedureLookup = () => {
    if (!patientLookup.procedureLookup) patientLookup.procedureLookup = createCodeLookup(patientProcedures);
    return patientLookup.procedureLookup;
  };

  const matchInfo = { matched: false, details: { sections: {} } };
  if (rule?.multiSite === true) {
    const multiSite = patient?.patientInfo?.multiSite === true;
    const matched = multiSite;
    matchInfo.details.multiSite = {
      matched,
      reason: matched ? 'patientInfo.multiSite is true' : 'rule.multiSite requires patientInfo.multiSite=true',
    };
    if (!matched) {
      return matchInfo;
    }
  }

  if (rule.requiredReferencedADRGs && Array.isArray(rule.requiredReferencedADRGs) && rule.requiredReferencedADRGs.length > 0) {
    const procedureSet = ensureProcedureLookup().allSet;
    const requiredDetails = rule.requiredReferencedADRGs.map((refCode) => {
      const procCodes = getReferencedProcedureSetForADRG(refCode);
      const matchedCodes = [];
      for (const code of procCodes) {
        if (procedureSet.has(code)) matchedCodes.push(code);
      }
      return { adrg: refCode, matchedCodes, matched: matchedCodes.length > 0 };
    });

    matchInfo.details.requiredReferencedADRGs = requiredDetails;
    matchInfo.matched = requiredDetails.every((item) => item.matched);
    return matchInfo;
  }

  if (rule.referencedADRGs && Array.isArray(rule.referencedADRGs) && rule.referencedADRGs.length > 0) {
    const procCodes = getReferencedProcedureSet(rule);
    const matched = patientProcedures.some(p => procCodes.has(p));
    matchInfo.details.referencedADRGs = { codes: rule.referencedADRGs, matched };
    matchInfo.matched = matched;
    return matchInfo;
  }

  if (rule.anyProcedureRequired) {
    const hasProc = patientProcedures.some(p => p && String(p).trim());
    matchInfo.details.anyProcedureRequired = true;
    matchInfo.matched = hasProc;
    return matchInfo;
  }

  if (rule.zeroProceduresRequired) {
    matchInfo.matched = true; // fix for ZQY
    matchInfo.details.zeroProceduresRequired = true;
    return matchInfo;
  }

  if (rule.requiredProcedureGroups) {
    const procedureSet = ensureProcedureLookup().allSet;
    matchInfo.details.requiredProcedureGroups = rule.requiredProcedureGroups.map(group => {
      const matchedCodes = [];
      for (const code of group) {
        if (procedureSet.has(code)) matchedCodes.push(code);
      }
      return { group, matchedCodes, matched: matchedCodes.length > 0 };
    });
    matchInfo.matched = matchInfo.details.requiredProcedureGroups.every(g => g.matched);
    return matchInfo;
  }

  if (rule.logic) {
    const { sectionDetails } = getRuleSectionMeta(rule);
    const diagLookup = ensureDiagnosisLookup();
    const procLookup = ensureProcedureLookup();
    for (const secMeta of sectionDetails) {
      matchInfo.details.sections[secMeta.sectionName] = checkSectionMatchByMeta(secMeta, patientDiagnoses, patientProcedures, diagLookup, procLookup);
    }

    // RULE LOGIC RPNs MUST BE PRE-COMPILED at build-time. Do not compile at runtime.
    // If `_logicRPN` is missing or there's a recorded compile error, treat the rule as non-matching.
    if (rule._logicCompileError || !rule._logicRPN) {
      matchInfo.details.logicError = rule._logicCompileError || 'Logic RPN missing (expected pre-compiled)';
      matchInfo.matched = false;
      return matchInfo;
    }

    const sectionBool = {};
    for (const secMeta of sectionDetails) {
      const secName = secMeta.sectionName;
      sectionBool[secName] = !!(matchInfo.details.sections[secName] && matchInfo.details.sections[secName].matched);
    }
    matchInfo.matched = evaluateRPN(rule._logicRPN, sectionBool);
    return matchInfo;
  }

  const { sectionDetails, hasDiagSection, hasProcSection } = getRuleSectionMeta(rule);
  if (sectionDetails.length > 0) {
    const diagLookup = ensureDiagnosisLookup();
    const procLookup = ensureProcedureLookup();
    let diagnosisMatched = false;
    let procedureMatched = false;
    for (const secMeta of sectionDetails) {
      const res = checkSectionMatchByMeta(secMeta, patientDiagnoses, patientProcedures, diagLookup, procLookup);
      matchInfo.details.sections[secMeta.sectionName] = res;
      if (secMeta.category === 'diagnosis' && res.matched) diagnosisMatched = true;
      if (secMeta.category === 'procedure' && res.matched) procedureMatched = true;

      // Non-logic section rules are OR-within-category and AND-between-categories.
      // Once both categories have a positive hit, remaining sections cannot change outcome.
      if (hasDiagSection && hasProcSection && diagnosisMatched && procedureMatched) break;
    }
    matchInfo.matched = (hasDiagSection && hasProcSection) ? (diagnosisMatched && procedureMatched) : (diagnosisMatched || procedureMatched);
    return matchInfo;
  }

  return matchInfo;
}

function checkPreMDCADRGs(diagnoses, effectiveProcedures, patientInfo, matchTrace) {
  const preMDCList = ['MDCA', 'MDCP', 'MDCY', 'MDCZ'];
  const patientForMatch = { diagnoses, procedures: effectiveProcedures, patientInfo };
  for (const preCode of preMDCList) {
    const mdc = (typeof mdcByCode !== 'undefined') ? mdcByCode.get(preCode) : null;
    if (!mdc) continue;

    // Resolve ADRG objects for this MDC
    const adrgObjects = getADRGsForMDC(preCode);
    if (!adrgObjects || adrgObjects.length === 0) continue;

    let applicable = true;
    if (preCode === 'MDCP') {
      applicable = patientInfo && patientInfo.ageInDays != null && patientInfo.ageInDays < 365 && !patientInfo.age;
    } else if (preCode === 'MDCY') {
      applicable = !!(mdc.identifyingDiagnosesSet && Array.isArray(diagnoses) && (
        strategy.mdcyPrincipalDiagnosisOnly
          ? mdc.identifyingDiagnosesSet.has(diagnoses[0])
          : diagnoses.some(dx => mdc.identifyingDiagnosesSet.has(dx))
      ));
    } else if (preCode === 'MDCZ') {
      try {
        const presentCats = new Set();
        if (Array.isArray(diagnoses) && typeof diagToMDCZCategories !== 'undefined') {
          for (const dx of diagnoses) {
            const cats = diagToMDCZCategories.get(dx);
            if (cats) for (const c of cats) presentCats.add(c);
          }
        }
        applicable = presentCats.size >= 2;
      } catch {
        applicable = false;
      }
    }
    if (!applicable) continue;

    matchTrace.push({ stage: 'Pre-MDC', description: `Checking ${preCode} ADRGs` });
    for (const adrg of adrgObjects) {
      if (!adrg || !adrg.rule) continue;

      if (preCode === 'MDCP' && adrg.description) {
        const desc = String(adrg.description);

        if (!desc.includes('29天≤出生年龄＜1周岁') && patientInfo.ageInDays >= 29) continue;
        if (desc.includes('29天≤出生年龄＜1周岁') && patientInfo.ageInDays < 29) continue;

        if (desc.includes('出生体重')) {
          const bw = Number(patientInfo.birthWeight);
          if (!Number.isFinite(bw)) continue;

          const weightText = desc.slice(desc.indexOf('出生体重')).replace(/[－—–]/g, '-');
          const rangeMatch = weightText.match(/(\d{1,4})\s*-\s*(\d{1,4})/);
          if (rangeMatch) {
            const lo = Number(rangeMatch[1]);
            const hi = Number(rangeMatch[2]);
            if (bw < lo || bw > hi) continue;
          } else {
            const boundaryMatch = weightText.match(/(不超过|小于|以下|及以上|超过|大于|以上|[＜<≤＞>≥])\s*(\d{1,4})/);
            if (!boundaryMatch) continue;

            const operator = boundaryMatch[1];
            const limit = Number(boundaryMatch[2]);
            const matches = operator === '小于' || operator === '<' || operator === '＜'
              ? bw < limit
              : operator === '以下' || operator === '不超过' || operator === '≤'
                ? bw <= limit
                : operator === '大于' || operator === '超过' || operator === '>' || operator === '＞'
                  ? bw > limit
                  : operator === '以上' || operator === '及以上' || operator === '≥'
                    ? bw >= limit
                    : false;
            if (!matches) continue;
          }
        }
      }

      const matchResult = matchesRule(adrg.rule, patientForMatch);

      if (matchResult && matchResult.matched) {
        matchTrace.push({ stage: 'Pre-MDC', matched: true, code: adrg.code, description: adrg.description, detail: matchResult });
        return { matchedMDC: mdc, matchedADRG: adrg, ruleMatchDetail: matchResult };
      }
    }
  }

  return { matchedMDC: null, matchedADRG: null, ruleMatchDetail: null };
}

function findMDCByPrincipal(principalDiagnosis, patientInfo = {}, matchTrace) {
  if (!principalDiagnosis) return null;
  const preMDCSet = new Set(['MDCA', 'MDCP', 'MDCY', 'MDCZ']);
  const rawGender = patientInfo && patientInfo.gender;
  const isMale = rawGender === 1 || rawGender === '1';
  const isFemale = rawGender === 2 || rawGender === '2';

  const matchedMDCs = MDCs.filter(mdc =>
    !preMDCSet.has(mdc.code) &&
    (!isMale || mdc.code !== 'MDCN') &&
    (!isFemale || mdc.code !== 'MDCM') &&
    mdc.identifyingDiagnosesSet &&
    mdc.identifyingDiagnosesSet.has(principalDiagnosis)
  );

  if (!matchedMDCs || matchedMDCs.length === 0) return null;
  const selectedMDC = matchedMDCs[0];
  matchTrace.push({ stage: 'MDC', matched: true, code: selectedMDC.code, description: selectedMDC.description });
  return selectedMDC;
}

function findADRGInMDC(mdc, diagnoses, effectiveProcedures, patientInfo, matchTrace) {
  if (!mdc) return { matchedADRG: null, ruleMatchDetail: null };
  const adrgObjects = getADRGsForMDC(mdc.code);
  if (!adrgObjects || adrgObjects.length === 0) return { matchedADRG: null, ruleMatchDetail: null };
  const patientForMatch = { diagnoses, procedures: effectiveProcedures, patientInfo };

  matchTrace.push({ stage: 'ADRG', description: 'Checking MDC ADRGs' });
  for (const adrg of adrgObjects) {
    if (adrg && adrg.rule) {
      const matchResult = matchesRule(adrg.rule, patientForMatch);
      if (matchResult && matchResult.matched) {
        matchTrace.push({ stage: 'ADRG', matched: true, code: adrg.code, description: adrg.description, detail: matchResult });
        return { matchedADRG: adrg, ruleMatchDetail: matchResult };
      }
    }
  }
  matchTrace.push({ stage: 'ADRG', matched: false, description: 'No matching ADRG found' });
  return { matchedADRG: null, ruleMatchDetail: null };
}

function checkQYRedirect(matchedADRG, matchedMDC, principalProcedure, matchTrace) {
  if (!matchedADRG || !principalProcedure || !matchedMDC) return null;
  const adrgCode = matchedADRG.code || '';
  if (adrgCode.length < 2) return null;

  const secondLetter = adrgCode.charAt(1).toUpperCase();
  if (!/^[A-Z]$/.test(secondLetter) || secondLetter <= 'Q') return null;

  const mdcLetter = String(matchedMDC.code).replace('MDC', '');
  const qyCode = mdcLetter + 'QY';

  matchTrace.push({ stage: 'QY Redirect', description: `Redirecting ${adrgCode} to synthetic ${qyCode}` });
  return {
    drg: qyCode,
    weight: null,
    weightTier2: null,
    mdc: matchedMDC ? matchedMDC.code : null,
    adrg: qyCode,
    description: '与主要诊断无关的手术',
    ruleMatchDetail: null,
    matchTrace: matchTrace
  };
}
  return { classifySection, matchCodesForPosition, matchesRule, checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect };
}
