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

type MdcAdrgRuleSet = Pick<
  RuleSet,
  | 'MDCs'
  | 'mdcByCode'
  | 'diagToMDCZCategories'
  | 'getADRGsForMDC'
  | 'getADRGByCode'
  | 'loadQyDiffCodes'
>;

/**
 * Internal MDC/ADRG selection factory.
 *
 * @internal Use the public grouping API from `GrouperEngine` instead.
 */
export function createMdcAdrgSelection(ruleSet: MdcAdrgRuleSet, strategy: CommonStrategy) {
  const { MDCs, mdcByCode, diagToMDCZCategories, getADRGsForMDC, getADRGByCode } = ruleSet;
  const preMdcCodes = strategy.preMdc;
  const preMdcCodeSet = new Set(preMdcCodes);
  const qyDiffCodes = new Set(Object.keys(ruleSet.loadQyDiffCodes()));
  const hasQyDiffCodes = qyDiffCodes.size > 0;

  function matchesAllProcedureRequirement(principalProcedure: string | null | undefined): boolean {
    return principalProcedure != null
      && (!hasQyDiffCodes || !qyDiffCodes.has(principalProcedure));
  }

const _sectionClassCache = new Map<string, SectionClassification>();
const _referencedProcedureSetCache = new WeakMap<AdrgRule, Set<string>>();
const _ruleSectionMetaCache = new WeakMap<AdrgRule, RuleSectionMeta>();
const _patientLookupCache = new WeakMap<RulePatient, PatientLookup>();
const _rpnEvaluatorCache = new WeakMap<AdrgRule, RpnEvaluator | null>();

function buildSectionClassification(sectionName: string): SectionClassification {
  const normalized = sectionName;
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

function getProcedureCodesForADRG(refCode: string): Set<string> {
  const refADRG = getADRGByCode(refCode);
  if (!refADRG || !refADRG.rule) return new Set();

  const refRuleMeta = getRuleSectionMeta(refADRG.rule);

  const procCodes = new Set<string>();
  for (const secMeta of refRuleMeta.sectionDetails) {
    if (secMeta.category !== 'procedure') continue;
    for (const code of secMeta.codeSet) procCodes.add(code);
  }
  return procCodes;
}

function getReferencedProcedureSet(rule: AdrgRule): Set<string> {
  const cached = _referencedProcedureSetCache.get(rule);
  if (cached) return cached;

  const procCodes = new Set<string>();
  for (const refCode of rule.referencedADRGs ?? []) {
    for (const code of getProcedureCodesForADRG(refCode)) procCodes.add(code);
  }

  _referencedProcedureSetCache.set(rule, procCodes);
  return procCodes;
}

function getSectionCodes(
  rule: AdrgRule,
  sectionName: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(sectionName)) return [];
  visited.add(sectionName);

  const sections = rule.sections ?? {};
  const codes = sections[sectionName] ?? [];
  if (codes.length > 0) return codes;

  const aliasTarget = rule.sectionAliases?.[sectionName];
  if (aliasTarget !== undefined) {
    const aliasCodes = getSectionCodes(rule, aliasTarget, visited);
    if (aliasCodes.length > 0) return aliasCodes;
  }
  return codes;
}

function getRuleSectionMeta(rule: AdrgRule): RuleSectionMeta {
  const cached = _ruleSectionMetaCache.get(rule);
  if (cached) return cached;

  const sectionNames = [...new Set([
    ...Object.keys(rule.sections ?? {}),
    ...Object.keys(rule.sectionAliases ?? {}),
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
  if (sectionMeta.codes.length === 0) return { matched: false, matchedCodes: [] };

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
  const src = patientCodes;
  return {
    codes: src,
    principal: src[0] ?? null,
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
    if (typeof token === 'object') {
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
  const rpn = rule._logicRPN!;
  let evaluator = _rpnEvaluatorCache.get(rule);
  if (evaluator === undefined) {
    evaluator = compileRpnEvaluator(rpn, getRuleSectionMeta(rule).sectionByName);
    _rpnEvaluatorCache.set(rule, evaluator);
  }
  return evaluator ? evaluator(resolveSection) : false;
}

// Rule-evaluation helpers (migrated here from `ruleEval.js`)
function classifySection(sectionName: string): SectionClassification {
  const key = sectionName;
  const cached = _sectionClassCache.get(key);
  if (cached) return cached;
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
  const { position, minimumMatches = 1, minimumOccurrences, codeSet } = section;
  const patientCodes = patientCodeLookup.codes;

  const finalize = (hits: string[]): MatchCodeDetail => {
    const occurrenceHits = minimumOccurrences === undefined
      ? null
      : (() => {
        const positionedCodes = position === 'principal'
          ? patientCodes.slice(0, 1)
          : position === 'other'
            ? patientCodes.slice(1)
            : patientCodes;
        return positionedCodes.filter((code): code is string => (
          code !== null && codeSet.has(code)
        ));
      })();
    const countedHits = occurrenceHits ?? hits;
    const matchedCodes = [...new Set(countedHits)].sort();
    const matchedCount = occurrenceHits === null ? matchedCodes.length : occurrenceHits.length;
    const requiredCount = minimumOccurrences
      ?? (minimumMatches > 1 ? minimumMatches : undefined);
    return {
      matched: matchedCount >= (minimumOccurrences ?? minimumMatches),
      matchedCodes,
      ...(requiredCount === undefined ? {} : { matchedCount, requiredCount }),
    };
  };

  // Occurrence-counted sections derive the count from the patient list; the
  // finalized trace is sorted deterministically, so no section scan is needed.
  if (minimumOccurrences !== undefined) return finalize([]);

  if (position === 'principal') {
    const principal = patientCodeLookup.principal;
    const hit = principal != null && codeSet.has(principal);
      return finalize(hit ? [principal] : []);
  }
  if (position === 'other') {
    const secondarySet = patientCodeLookup.secondarySet;
    return finalize(secondarySet ? intersectCodeSets(codeSet, secondarySet) : []);
  }

  const allSet = patientCodeLookup.allSet;
  return finalize(intersectCodeSets(codeSet, allSet));
}

function matchesRule(rule: AdrgRule, patient: RulePatient): RuleMatchResult {
  const patientDiagnoses = patient.diagnoses;
  const patientProcedures = patient.procedures;
  let patientLookup = _patientLookupCache.get(patient);
  if (!patientLookup) {
    patientLookup = { diagnosisLookup: null, procedureLookup: null };
    _patientLookupCache.set(patient, patientLookup);
  }

  const details: RuleMatchDetails = { sections: {} };
  const matchInfo: RuleMatchResult = { matched: false, details };
  if (rule.intensiveCare === true) {
    const intensiveCare = patient.patientInfo.intensiveCare === true;
    matchInfo.details.intensiveCare = {
      matched: intensiveCare,
      reason: intensiveCare ? 'patientInfo.intensiveCare is true' : 'rule.intensiveCare requires patientInfo.intensiveCare=true',
    };
    if (!intensiveCare) return matchInfo;
  }

  if (rule.requiredReferencedADRGs && rule.requiredReferencedADRGs.length > 0) {
    const procedureSet = ensurePatientCodeLookup(patientLookup, 'procedureLookup', patientProcedures).allSet;
    const requiredDetails = rule.requiredReferencedADRGs.map((refCode) => {
      const procCodes = getProcedureCodesForADRG(refCode);
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

  if (rule.referencedADRGs && rule.referencedADRGs.length > 0) {
    const procCodes = getReferencedProcedureSet(rule);
    const principalProcedure = patientProcedures[0];
    const matched = principalProcedure != null && procCodes.has(principalProcedure);
    matchInfo.details.referencedADRGs = { codes: rule.referencedADRGs, matched };
    matchInfo.matched = matched;
    return matchInfo;
  }

  if (rule.anyProcedureRequired) {
    // The unified flag accepts a principal procedure except for the small
    // valid-YB procedure set omitted from the PDF all-procedure list.
    matchInfo.details.anyProcedureRequired = true;
    matchInfo.matched = matchesAllProcedureRequirement(patientProcedures[0]);
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
    matchInfo.matched = matchInfo.details.requiredProcedureGroups.every(g => g.matched);
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
  const patientForMatch = { diagnoses, procedures: effectiveProcedures, patientInfo };
  for (const preCode of preMdcCodes) {
    const mdc = mdcByCode.get(preCode);
    if (!mdc) continue;

    // Resolve ADRG objects for this MDC
    const adrgObjects = getADRGsForMDC(preCode);
    if (adrgObjects.length === 0) continue;

    let applicable = true;
    if (preCode === 'MDCP') {
      applicable = patientInfo.ageInDays != null && patientInfo.ageInDays < 366;
    } else if (preCode === 'MDCY') {
      applicable = diagnoses.some(dx => mdc.identifyingDiagnosesSet.has(dx));
    } else if (preCode === 'MDCZ') {
      // The official MDCZ rule binds ZYZD to the principal diagnosis and
      // QTZD to a later diagnosis from a different trauma category.
      const mdczDiagnosisMatches: Array<{ code: string; categories: string[] }> = [];
      let principalCategory: string | undefined;
      const presentCats = new Set<string>();
      for (const [index, dx] of diagnoses.entries()) {
        const category = diagToMDCZCategories.get(dx);
        if (category === undefined) continue;
        mdczDiagnosisMatches.push({ code: dx, categories: [category] });
        presentCats.add(category);
        if (index === 0) principalCategory = category;
      }
      applicable = principalCategory !== undefined && presentCats.size >= 2;
      if (mdczDiagnosisMatches.length > 0) {
        matchTrace.push({
          event: 'mdcz-category-check',
          matched: applicable,
          description: `Checking ${preCode} ADRGs`,
          detail: { reasonCode: applicable ? 'category-threshold-met' : 'category-threshold-not-met' },
          mdczDiagnosisMatches,
          requiredCategoryCount: 2,
          actualCategoryCount: presentCats.size,
        });
      }
    }
    if (!applicable) continue;

    // Candidate probing is an implementation detail; only emit a match or a failure.
    for (const adrg of adrgObjects) {
      if (!adrg.rule) continue;

      if (preCode === 'MDCP' && adrg.description) {
        const desc = adrg.description;
        const isOlderInfantAdrg = desc.includes('29天≤出生年龄＜1周岁');

        const ageInDays = patientInfo.ageInDays!;
        if (!isOlderInfantAdrg && ageInDays >= 29) continue;
        if (isOlderInfantAdrg && ageInDays < 29) continue;

        // The official CHS 3.0 PV1 condition excludes procedures in OP_ALL.
        // QY_DIFF is the compact complement for valid YB procedure codes;
        // without it, fail closed for any non-empty principal procedure.
        if (isOlderInfantAdrg) {
          const principalProcedure = effectiveProcedures[0] ?? null;
          if (
            principalProcedure != null
            && (!hasQyDiffCodes || !qyDiffCodes.has(principalProcedure))
          ) continue;
        }

        const weightMarkers = [...desc.matchAll(/(?:出生|入院)体重/gu)];
        let weightConditionsMatch = true;
        for (const [index, markerMatch] of weightMarkers.entries()) {
          const weightMarker = markerMatch[0];
          const weightField = weightMarker === '出生体重' ? 'birthWeight' : 'admissionWeight';
          const weight = patientInfo[weightField];
          if (weight === undefined) {
            weightConditionsMatch = false;
            break;
          }

          const markerStart = markerMatch.index;
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

      if (matchResult.matched) {
        matchTrace.push({ event: 'pre-mdc-match', matched: true, code: adrg.code, description: adrg.description, detail: { ruleMatch: matchResult } });
        return { matchedMDC: mdc, matchedADRG: adrg, ruleMatchDetail: matchResult };
      }
    }
  }

  return { matchedMDC: null, matchedADRG: null, ruleMatchDetail: null };
}

function findMDCByPrincipal(
  principalDiagnosis: string,
  gender: NormalizedPatientInfo['gender'],
  matchTrace: MatchTraceEntry[],
): MdcDefinition | null {
  const isMale = gender === 1;
  const isFemale = gender === 2;

  const matchedMDCs = MDCs.filter(mdc =>
    !preMdcCodeSet.has(mdc.code) &&
    (!isMale || mdc.code !== 'MDCN') &&
    (!isFemale || mdc.code !== 'MDCM') &&
    mdc.identifyingDiagnosesSet.has(principalDiagnosis)
  );

  const selectedMDC = matchedMDCs[0];
  if (!selectedMDC) return null;
  matchTrace.push({ event: 'mdc-match', matched: true, code: selectedMDC.code, description: selectedMDC.description });
  return selectedMDC;
}

function findADRGInMDC(
  mdcCode: string,
  diagnoses: string[],
  effectiveProcedures: Array<string | null>,
  patientInfo: NormalizedPatientInfo,
  matchTrace: MatchTraceEntry[],
): { matchedADRG: AdrgDefinition | null; ruleMatchDetail: RuleMatchResult | null } {
  const adrgObjects = getADRGsForMDC(mdcCode);
  if (adrgObjects.length === 0) {
    matchTrace.push({ event: 'adrg-no-match', matched: false, description: 'No matching ADRG found' });
    return { matchedADRG: null, ruleMatchDetail: null };
  }
  // A null principal slot means there is no effective principal procedure for
  // ADRG routing. This intentionally treats [null, laterProcedure] as the
  // medical path while preserving the original array and its positions for
  // rule evaluation and subgroup matching.
  const noEffectivePrincipalProcedure = effectiveProcedures.length === 0
    || effectiveProcedures[0] == null;
  const patientForMatch = { diagnoses, procedures: effectiveProcedures, patientInfo };

  for (const adrg of adrgObjects) {
    if (noEffectivePrincipalProcedure) {
      const secondCharacter = adrg.code.charAt(1).toUpperCase();
      if (secondCharacter < 'R' || secondCharacter > 'Z') continue;
    }
    if (adrg.rule) {
      const matchResult = matchesRule(adrg.rule, patientForMatch);
      if (matchResult.matched) {
        matchTrace.push({ event: 'adrg-match', matched: true, code: adrg.code, description: adrg.description, detail: { ruleMatch: matchResult } });
        return { matchedADRG: adrg, ruleMatchDetail: matchResult };
      }
    }
  }
  matchTrace.push({ event: 'adrg-no-match', matched: false, description: 'No matching ADRG found' });
  return { matchedADRG: null, ruleMatchDetail: null };
}

function checkQYRedirect(
  adrgCode: string,
  mdcCode: string,
  principalProcedure: string,
  matchTrace: MatchTraceEntry[],
): GroupingResult | null {
  const secondLetter = adrgCode.charAt(1).toUpperCase();
  if (!/^[A-Z]$/.test(secondLetter) || secondLetter <= 'Q') return null;

  // A procedure from the small valid-YB complement of the PDF all-procedure
  // list must not reach the synthetic QY group through a medical fallback.
  if (!matchesAllProcedureRequirement(principalProcedure)) return null;

  const mdcLetter = mdcCode.replace('MDC', '');
  const qyCode = mdcLetter + 'QY';

  matchTrace.push({ event: 'qy-redirect', code: qyCode, matched: true, description: `Redirecting ${adrgCode} to synthetic ${qyCode}` });
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
  return { matchesRule, checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect };
}
