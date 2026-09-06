import type {
  CommonStrategy,
  GroupingResult,
  MatchTraceEntry,
  NormalizedPatientInfo,
} from '../../types/grouper.js';
import type {
  AdrgDefinition,
  AdrgRule,
  MatchCodeDetail,
  MdcDefinition,
  RpnToken,
  RuleMatchDetails,
  RuleMatchResult,
  RulePatient,
  RuleSet,
} from '../../types/rules.js';

type SectionCategory = 'diagnosis' | 'procedure' | null;
type SectionPosition = 'principal' | 'other' | 'any';
type SectionClassification = {
  category: SectionCategory;
  position: SectionPosition;
  isSimultaneous: boolean;
};
type SectionMeta = SectionClassification & {
  sectionName: string;
  codes: string[];
  codeSet: Set<string>;
  minimumMatches?: number;
  minimumOccurrences?: number;
};
type RuleSectionMeta = {
  sectionNames: string[];
  sectionDetails: SectionMeta[];
  sectionByName: Map<string, SectionMeta>;
  hasDiagSection: boolean;
  hasProcSection: boolean;
};
type CodeLookup = {
  codes: Array<string | null>;
  principal: string | null;
  allSet: Set<string | null>;
  secondarySet: Set<string | null> | null;
};
type PatientLookup = {
  diagnosisLookup: CodeLookup | null;
  procedureLookup: CodeLookup | null;
};
type SectionResolver = (section: SectionMeta) => boolean;
type RpnEvaluator = (resolveSection: SectionResolver) => boolean;
type PreMdcResult = {
  matchedMDC: MdcDefinition | null;
  matchedADRG: AdrgDefinition | null;
  ruleMatchDetail: RuleMatchResult | null;
};

export function createMdcAdrgSelection(ruleSet: RuleSet, strategy: CommonStrategy) {
  const { MDCs, mdcByCode, diagToMDCZCategories, getADRGsForMDC, getADRGByCode } = ruleSet;
  const qyDiffCodes = new Set(
    typeof ruleSet.loadQyDiffCodes === 'function'
      ? Object.keys(ruleSet.loadQyDiffCodes() ?? {})
      : [],
  );
  const hasQyDiffCodes = qyDiffCodes.size > 0;

const _sectionClassCache = new Map<string, SectionClassification>();
const _referencedProcedureSetCache = new WeakMap<AdrgRule, Set<string>>();
const _ruleSectionMetaCache = new WeakMap<AdrgRule, RuleSectionMeta>();
const _patientLookupCache = new WeakMap<RulePatient, PatientLookup>();
const _rpnEvaluatorCache = new WeakMap<AdrgRule, RpnEvaluator | null>();

function buildSectionClassification(sectionName: string): SectionClassification {
  const normalized = String(sectionName || '');
  const isDiag = normalized.includes('诊断');
  const isProc = normalized.includes('手术') || normalized.includes('操作');
  const isPrincipal = normalized.includes('主要');
  const isOther = normalized.includes('其他');
  const isSimultaneous = normalized.includes('同时包含');
  let category: SectionCategory = null;
  if (isDiag) category = 'diagnosis';
  else if (isProc) category = 'procedure';
  let position: SectionPosition = 'any';
  if (isPrincipal) position = 'principal';
  else if (isOther) position = 'other';
  return Object.freeze({ category, position, isSimultaneous });
}

function getReferencedProcedureSet(rule: AdrgRule): Set<string> {
  if (_referencedProcedureSetCache.has(rule)) return _referencedProcedureSetCache.get(rule) as Set<string>;

  const procCodes = new Set<string>();
  for (const refCode of rule.referencedADRGs ?? []) {
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

function getReferencedProcedureSetForADRG(refCode: string): Set<string> {
  const refADRG = getADRGByCode(refCode);
  if (!refADRG || !refADRG.rule) return new Set();

  const refRuleMeta = getRuleSectionMeta(refADRG.rule);
  if (!refRuleMeta || !Array.isArray(refRuleMeta.sectionDetails)) return new Set();

  const procCodes = new Set<string>();
  for (const secMeta of refRuleMeta.sectionDetails) {
    if (secMeta.category !== 'procedure' || !secMeta.codeSet) continue;
    for (const code of secMeta.codeSet) procCodes.add(code);
  }
  return procCodes;
}

function getSectionCodes(
  rule: AdrgRule,
  sectionName: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(sectionName)) return [];
  visited.add(sectionName);

  const sections = (rule && rule.sections) || {};
  const codes = Array.isArray(sections[sectionName]) ? sections[sectionName] : [];
  if (codes.length > 0) return codes;

  const aliasTarget = rule.sectionAliases?.[sectionName];
  if (typeof aliasTarget === 'string') {
    const aliasCodes = getSectionCodes(rule, aliasTarget, visited);
    if (aliasCodes.length > 0) return aliasCodes;
  }
  return codes;
}

function getRuleSectionMeta(rule: AdrgRule): RuleSectionMeta {
  if (_ruleSectionMetaCache.has(rule)) return _ruleSectionMetaCache.get(rule) as RuleSectionMeta;

  const sectionNames = [...new Set([
    ...Object.keys((rule && rule.sections) || {}),
    ...Object.keys((rule && rule.sectionAliases) || {}),
  ])];
  let hasDiagSection = false;
  let hasProcSection = false;

  const sectionDetails = sectionNames.map(sec => {
    const { category, position, isSimultaneous } = classifySection(sec);
    if (category === 'diagnosis') hasDiagSection = true;
    if (category === 'procedure') hasProcSection = true;

    const codes = getSectionCodes(rule, sec);
    const codeSet = new Set(codes);
    const minimumMatches = rule.sectionMinimumMatches?.[sec];
    const minimumOccurrences = rule.sectionMinimumOccurrences?.[sec];

    return { sectionName: sec, category, position, isSimultaneous, codes, codeSet, minimumMatches, minimumOccurrences };
  });

  const sectionByName = new Map(sectionDetails.map(section => [section.sectionName, section]));
  const meta = { sectionNames, sectionDetails, sectionByName, hasDiagSection, hasProcSection };
  _ruleSectionMetaCache.set(rule, meta);
  return meta;
}

function checkSectionMatchByMeta(
  sectionMeta: SectionMeta,
  patientLookup: PatientLookup,
): MatchCodeDetail {
  if (!sectionMeta || !sectionMeta.codes || sectionMeta.codes.length === 0) return { matched: false, matchedCodes: [] };

  // Callers initialize the lookup for each evaluated category.
  if (sectionMeta.category === 'diagnosis') {
    return matchCodesForPosition(sectionMeta, patientLookup.diagnosisLookup!);
  }
  if (sectionMeta.category === 'procedure') {
    return matchCodesForPosition(sectionMeta, patientLookup.procedureLookup!);
  }
  return { matched: false, matchedCodes: [] };
}

function createCodeLookup(patientCodes: Array<string | null>): CodeLookup {
  const src = Array.isArray(patientCodes) ? patientCodes : [];
  return {
    codes: src,
    principal: src.length > 0 ? (src[0] ?? null) : null,
    allSet: new Set(src),
    secondarySet: src.length > 1 ? new Set(src.slice(1)) : null,
  };
}

function ensurePatientCodeLookup(
  patientLookup: PatientLookup,
  key: keyof PatientLookup,
  patientCodes: Array<string | null>,
): CodeLookup {
  const cached = patientLookup[key];
  if (cached) return cached;
  const lookup = createCodeLookup(patientCodes);
  patientLookup[key] = lookup;
  return lookup;
}

// Compile a generated RPN array into a reusable lazy evaluator. Rule data keeps
// RPN as its runtime representation; this plan only avoids rebuilding the same
// short-circuit closure graph for every patient.
function compileRpnEvaluator(
  rpn: RpnToken[],
  sectionByName: Map<string, SectionMeta>,
): RpnEvaluator | null {
  const stack: RpnEvaluator[] = [];
  for (const token of rpn) {
    if (token !== null && typeof token === 'object' && token.type === 'SECTION') {
      const sectionMeta = sectionByName.get(token.name);
      stack.push(sectionMeta ? resolveSection => resolveSection(sectionMeta) : () => false);
    } else if (token === '!') {
      if (stack.length < 1) return null;
      const operand = stack.pop() as RpnEvaluator;
      stack.push(resolveSection => !operand(resolveSection));
    } else if (token === '&&') {
      if (stack.length < 2) return null;
      const right = stack.pop() as RpnEvaluator;
      const left = stack.pop() as RpnEvaluator;
      stack.push(resolveSection => left(resolveSection) && right(resolveSection));
    } else if (token === '||') {
      if (stack.length < 2) return null;
      const right = stack.pop() as RpnEvaluator;
      const left = stack.pop() as RpnEvaluator;
      stack.push(resolveSection => left(resolveSection) || right(resolveSection));
    } else {
      return null;
    }
  }
  return stack.length === 1 ? (stack[0] as RpnEvaluator) : null;
}

function evaluateRPN(
  rule: AdrgRule,
  resolveSection: SectionResolver,
): boolean {
  const rpn = rule._logicRPN;
  if (!Array.isArray(rpn)) return false;
  let evaluator = _rpnEvaluatorCache.get(rule);
  if (evaluator === undefined && !_rpnEvaluatorCache.has(rule)) {
    evaluator = compileRpnEvaluator(rpn, getRuleSectionMeta(rule).sectionByName);
    _rpnEvaluatorCache.set(rule, evaluator);
  }
  return evaluator ? evaluator(resolveSection) : false;
}

// Rule-evaluation helpers (migrated here from `ruleEval.js`)
function classifySection(sectionName: string): SectionClassification {
  const key = String(sectionName || '');
  if (_sectionClassCache.has(key)) return _sectionClassCache.get(key) as SectionClassification;
  const classification = buildSectionClassification(key);
  _sectionClassCache.set(key, classification);
  return classification;
}

function intersectCodeSets(
  eligibleCodeSet: Set<string>,
  patientCodeSet: Set<string | null>,
): string[] {
  const hits = [];
  if (patientCodeSet.size < eligibleCodeSet.size) {
    for (const code of patientCodeSet) {
      if (code !== null && eligibleCodeSet.has(code)) hits.push(code);
    }
  } else {
    for (const code of eligibleCodeSet) {
      if (patientCodeSet.has(code)) hits.push(code);
    }
  }
  return hits;
}

function matchCodesForPosition(
  section: SectionMeta,
  patientCodeLookup: CodeLookup,
): MatchCodeDetail {
  const { codes, position, minimumMatches = 1, minimumOccurrences, codeSet } = section;
  if (!codes || codes.length === 0) return { matched: false, matchedCodes: [] };
  const eligibleCodeSet = codeSet ?? new Set(codes);
  const patientCodes = patientCodeLookup.codes;

  const occurrenceMinimum = Number.isInteger(minimumOccurrences) && Number(minimumOccurrences) >= 1
    ? Number(minimumOccurrences)
    : undefined;

  const finalize = (hits: string[]): MatchCodeDetail => {
    const occurrenceHits = occurrenceMinimum === undefined
      ? null
      : (() => {
        const positionedCodes = position === 'principal'
          ? patientCodes.slice(0, 1)
          : position === 'other'
            ? patientCodes.slice(1)
            : patientCodes;
        return positionedCodes.filter((code): code is string => (
          code !== null && eligibleCodeSet.has(code)
        ));
      })();
    const countedHits = occurrenceHits ?? hits;
    const matchedCodes = [...new Set(countedHits)].sort();
    const matchedCount = occurrenceHits === null ? matchedCodes.length : occurrenceHits.length;
    const requiredCount = occurrenceMinimum
      ?? (Number.isInteger(minimumMatches) && minimumMatches > 1 ? minimumMatches : undefined);
    return {
      matched: matchedCount >= (occurrenceMinimum ?? minimumMatches),
      matchedCodes,
      ...(requiredCount === undefined ? {} : { matchedCount, requiredCount }),
    };
  };

  // Occurrence-counted sections derive the count from the patient list; the
  // finalized trace is sorted deterministically, so no section scan is needed.
  if (occurrenceMinimum !== undefined) return finalize([]);

  if (position === 'principal') {
    const principal = patientCodeLookup.principal;
    const hit = principal != null && eligibleCodeSet.has(principal);
    return finalize(hit ? [principal] : []);
  }
  if (position === 'other') {
    const secondarySet = patientCodeLookup.secondarySet;
    return finalize(secondarySet ? intersectCodeSets(eligibleCodeSet, secondarySet) : []);
  }

  const allSet = patientCodeLookup.allSet;
  return finalize(intersectCodeSets(eligibleCodeSet, allSet));
}

function matchesRule(rule: AdrgRule, patient: RulePatient): RuleMatchResult {
  const patientDiagnoses = Array.isArray(patient.diagnoses) ? patient.diagnoses : [];
  const patientProcedures = Array.isArray(patient.procedures) ? patient.procedures : [];
  let patientLookup = _patientLookupCache.get(patient);
  if (!patientLookup) {
    patientLookup = { diagnosisLookup: null, procedureLookup: null };
    _patientLookupCache.set(patient, patientLookup);
  }

  const details: RuleMatchDetails = { sections: {} };
  const matchInfo: RuleMatchResult = { matched: false, details };
  if (rule?.intensiveCare === true) {
    const intensiveCare = patient?.patientInfo?.intensiveCare === true;
    matchInfo.details.intensiveCare = {
      matched: intensiveCare,
      reason: intensiveCare ? 'patientInfo.intensiveCare is true' : 'rule.intensiveCare requires patientInfo.intensiveCare=true',
    };
    if (!intensiveCare) return matchInfo;
  }

  if (rule.requiredReferencedADRGs && Array.isArray(rule.requiredReferencedADRGs) && rule.requiredReferencedADRGs.length > 0) {
    const procedureSet = ensurePatientCodeLookup(patientLookup, 'procedureLookup', patientProcedures).allSet;
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
    const matched = patientProcedures.some(p => p !== null && procCodes.has(p));
    matchInfo.details.referencedADRGs = { codes: rule.referencedADRGs, matched };
    matchInfo.matched = matched;
    return matchInfo;
  }

  if (rule.anyProcedureRequired) {
    // The unified flag accepts a principal procedure except for the small
    // valid-YB procedure set omitted from the PDF all-procedure list.
    const principalProcedure = patientProcedures[0];
    const hasProc = principalProcedure != null
      && (!hasQyDiffCodes || !qyDiffCodes.has(principalProcedure));
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
    const procedureSet = ensurePatientCodeLookup(patientLookup, 'procedureLookup', patientProcedures).allSet;
    matchInfo.details.requiredProcedureGroups = rule.requiredProcedureGroups.map(group => {
      const matchedCodes = [];
      for (const code of group) {
        if (procedureSet.has(code)) matchedCodes.push(code);
      }
      return { group, matchedCodes, matched: matchedCodes.length > 0 };
    });
    matchInfo.matched = matchInfo.details.requiredProcedureGroups?.every(g => g.matched) ?? false;
    return matchInfo;
  }

  if (rule.logic) {
    // RULE LOGIC RPNs MUST BE PRE-COMPILED at build-time. Do not compile at runtime.
    // If `_logicRPN` is missing or there's a recorded compile error, treat the rule as non-matching.
    if (rule._logicCompileError || !rule._logicRPN) {
      matchInfo.details.logicError = rule._logicCompileError || 'Logic RPN missing (expected pre-compiled)';
      matchInfo.matched = false;
      return matchInfo;
    }

    const resolveSection = (sectionMeta: SectionMeta): boolean => {
      const sectionName = sectionMeta.sectionName;
      const cached = matchInfo.details.sections[sectionName];
      if (cached) return cached.matched;

      if (sectionMeta.category === 'diagnosis' && !patientLookup.diagnosisLookup) {
        ensurePatientCodeLookup(patientLookup, 'diagnosisLookup', patientDiagnoses);
      }
      if (sectionMeta.category === 'procedure' && !patientLookup.procedureLookup) {
        ensurePatientCodeLookup(patientLookup, 'procedureLookup', patientProcedures);
      }
      const result = checkSectionMatchByMeta(sectionMeta, patientLookup);
      // Short-circuited operands never reach this resolver, so trace details
      // intentionally contain only the sections that were actually evaluated.
      matchInfo.details.sections[sectionName] = result;
      return result.matched;
    };

    matchInfo.matched = evaluateRPN(rule, resolveSection);
    return matchInfo;
  }

  const { sectionDetails, hasDiagSection, hasProcSection } = getRuleSectionMeta(rule);
  if (sectionDetails.length > 0) {
    if (hasDiagSection) ensurePatientCodeLookup(patientLookup, 'diagnosisLookup', patientDiagnoses);
    if (hasProcSection) ensurePatientCodeLookup(patientLookup, 'procedureLookup', patientProcedures);
    let diagnosisMatched = false;
    let procedureMatched = false;
    for (const secMeta of sectionDetails) {
      const res = checkSectionMatchByMeta(secMeta, patientLookup);
      matchInfo.details.sections[secMeta.sectionName] = res;
      if (secMeta.category === 'diagnosis' && res.matched) diagnosisMatched = true;
      if (secMeta.category === 'procedure' && res.matched) procedureMatched = true;
   }
    matchInfo.matched = (hasDiagSection && hasProcSection) ? (diagnosisMatched && procedureMatched) : (diagnosisMatched || procedureMatched);
    return matchInfo;
  }

  return matchInfo;
}

function checkPreMDCADRGs(
  diagnoses: string[],
  effectiveProcedures: Array<string | null>,
  patientInfo: NormalizedPatientInfo,
  matchTrace: MatchTraceEntry[],
): PreMdcResult {
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
      const identifyingDiagnosesSet = mdc.identifyingDiagnosesSet;
      applicable = !!(identifyingDiagnosesSet && Array.isArray(diagnoses) && (
        strategy.mdcyPrincipalDiagnosisOnly
          ? diagnoses[0] !== undefined && identifyingDiagnosesSet.has(diagnoses[0])
          : diagnoses.some(dx => identifyingDiagnosesSet.has(dx))
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

        const ageInDays = patientInfo.ageInDays;
        if (ageInDays === undefined) continue;
        if (!desc.includes('29天≤出生年龄＜1周岁') && ageInDays >= 29) continue;
        if (desc.includes('29天≤出生年龄＜1周岁') && ageInDays < 29) continue;

        const weightMarkers = [...desc.matchAll(/(?:出生|入院)体重/gu)];
        let weightConditionsMatch = true;
        for (let index = 0; index < weightMarkers.length; index += 1) {
          const markerMatch = weightMarkers[index];
          if (!markerMatch) {
            weightConditionsMatch = false;
            break;
          }
          const weightMarker = markerMatch[0];
          const weightField = weightMarker === '出生体重' ? 'birthWeight' : 'admissionWeight';
          const weight = Number(patientInfo[weightField]);
          if (!Number.isFinite(weight)) {
            weightConditionsMatch = false;
            break;
          }

          const markerStart = markerMatch.index ?? 0;
          const nextMarkerStart = weightMarkers[index + 1]?.index ?? desc.length;
          const weightText = desc.slice(markerStart, nextMarkerStart).replace(/[－—–]/g, '-');
          const rangeMatch = weightText.match(/(\d{1,4})\s*-\s*(\d{1,4})/);
          if (rangeMatch) {
            const lo = Number(rangeMatch[1]);
            const hi = Number(rangeMatch[2]);
            if (weight < lo || weight > hi) {
              weightConditionsMatch = false;
              break;
            }
          } else {
            const boundaryMatch = weightText.match(/(不超过|小于|以下|及以上|超过|大于|以上|[＜<≤＞>≥])\s*(\d{1,4})/);
            if (!boundaryMatch) {
              weightConditionsMatch = false;
              break;
            }

            const operator = boundaryMatch[1];
            const limit = Number(boundaryMatch[2]);
            const matches = operator === '小于' || operator === '<' || operator === '＜'
              ? weight < limit
              : operator === '以下' || operator === '不超过' || operator === '≤'
                ? weight <= limit
                : operator === '大于' || operator === '超过' || operator === '>' || operator === '＞'
                  ? weight > limit
                  : operator === '以上' || operator === '及以上' || operator === '≥'
                    ? weight >= limit
                    : false;
            if (!matches) {
              weightConditionsMatch = false;
              break;
            }
          }
        }
        if (!weightConditionsMatch) continue;
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

function findMDCByPrincipal(
  principalDiagnosis: string | null,
  gender: NormalizedPatientInfo['gender'],
  matchTrace: MatchTraceEntry[],
): MdcDefinition | null {
  if (!principalDiagnosis) return null;
  const preMDCSet = new Set(['MDCA', 'MDCP', 'MDCY', 'MDCZ']);
  const isMale = gender === 1 || gender === '1';
  const isFemale = gender === 2 || gender === '2';

  const matchedMDCs = MDCs.filter(mdc =>
    !preMDCSet.has(mdc.code) &&
    (!isMale || mdc.code !== 'MDCN') &&
    (!isFemale || mdc.code !== 'MDCM') &&
    mdc.identifyingDiagnosesSet &&
    mdc.identifyingDiagnosesSet.has(principalDiagnosis)
  );

  if (!matchedMDCs || matchedMDCs.length === 0) return null;
  const selectedMDC = matchedMDCs[0];
  if (!selectedMDC) return null;
  matchTrace.push({ stage: 'MDC', matched: true, code: selectedMDC.code, description: selectedMDC.description });
  return selectedMDC;
}

function findADRGInMDC(
  mdcCode: string | null,
  diagnoses: string[],
  effectiveProcedures: Array<string | null>,
  patientInfo: NormalizedPatientInfo,
  matchTrace: MatchTraceEntry[],
): { matchedADRG: AdrgDefinition | null; ruleMatchDetail: RuleMatchResult | null } {
  if (mdcCode === null) return { matchedADRG: null, ruleMatchDetail: null };
  const adrgObjects = getADRGsForMDC(mdcCode);
  if (!adrgObjects || adrgObjects.length === 0) return { matchedADRG: null, ruleMatchDetail: null };
  // A null principal slot means there is no effective principal procedure for
  // ADRG routing. This intentionally treats [null, laterProcedure] as the
  // medical path while preserving the original array and its positions for
  // rule evaluation and subgroup matching.
  const noEffectivePrincipalProcedure = effectiveProcedures.length === 0
    || effectiveProcedures[0] == null;
  const patientForMatch = { diagnoses, procedures: effectiveProcedures, patientInfo };

  matchTrace.push({ stage: 'ADRG', description: 'Checking MDC ADRGs' });
  for (const adrg of adrgObjects) {
    if (noEffectivePrincipalProcedure) {
      const secondCharacter = String(adrg?.code || '').charAt(1).toUpperCase();
      if (secondCharacter < 'R' || secondCharacter > 'Z') continue;
    }
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

function checkQYRedirect(
  adrgCode: string | null,
  mdcCode: string | null,
  principalProcedure: string | null,
  matchTrace: MatchTraceEntry[],
): GroupingResult | null {
  if (!adrgCode || !principalProcedure || mdcCode === null) return null;
  if (adrgCode.length < 2) return null;

  const secondLetter = adrgCode.charAt(1).toUpperCase();
  if (!/^[A-Z]$/.test(secondLetter) || secondLetter <= 'Q') return null;

  // A procedure from the small valid-YB complement of the PDF all-procedure
  // list must not reach the synthetic QY group through a medical fallback.
  if (hasQyDiffCodes && qyDiffCodes.has(principalProcedure)) return null;

  const mdcLetter = String(mdcCode).replace('MDC', '');
  const qyCode = mdcLetter + 'QY';

  matchTrace.push({ stage: 'QY Redirect', description: `Redirecting ${adrgCode} to synthetic ${qyCode}` });
  return {
    drg: qyCode,
    weight: null,
    weightTier2: null,
    mdc: mdcCode,
    adrg: qyCode,
    description: '与主要诊断无关的手术',
    ruleMatchDetail: null,
    matchTrace: matchTrace
  };
}
  return { classifySection, matchCodesForPosition, matchesRule, checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect };
}
