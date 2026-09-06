import { loadRuleSet } from './ruleSetLoader.ts';
import { getVersionDefinition } from './generated/versionRegistry.ts';
import type {
  BatchGroupingResult,
  BatchGroupingRow,
  CodeListInput,
  CreateGrouperEngineOptions,
  GrouperEngine,
  GroupingResult,
  MatchTraceEntry,
  NormalizedPatientInfo,
  PatientBooleanInput,
  PatientInfoInput,
  PatientScalarInput,
} from '../types/grouper.js';

// lite build flag - allows dead-code elimination when VITE_LITE=true
let IS_LITE = import.meta.env?.VITE_LITE === 'true';

// helper for tests to override behavior
export function _setLite(val: unknown): void { IS_LITE = !!val; }

const DEFAULT_VERSION_STRATEGY = {
  daySurgeryAsNoCC: false,
  robotAssistedSurgery: { adrgCodes: [], procedureCodes: [] },
  highRiskPregnancyAsMcc: { adrgCodes: [], diagnosisCodes: [] },
};

// Moved helpers (see `src/services/grouper/*`)
import { createMdcAdrgSelection } from './grouper/mdcAdrgSelection.ts';
import { createSubgroupEvaluator } from './grouper/subgroupEval.ts';

export function createGrouperEngine({ ruleSet, commonStrategy, versionStrategy = DEFAULT_VERSION_STRATEGY }: CreateGrouperEngineOptions): GrouperEngine {
const { isInvalidDiagnosis, isInvalidProcedure, isGrayDiag, isGrayProc, loadDRGMap } = ruleSet;
const drgMap = loadDRGMap();
const { checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect, matchesRule } = createMdcAdrgSelection(ruleSet, commonStrategy);
  const { evaluateADRGSubgroups } = createSubgroupEvaluator(
    ruleSet,
    matchesRule,
    versionStrategy,
  );

// Public re-exports (kept for compatibility; prefer importing from `src/services/grouper/*` directly)

// Note: code conversion moved to `src/services/CodeConversion.js` for caller-side control.

/**
 * GrouperEngine — central runtime for DRG grouping.
 * Responsibilities:
 * - `groupPatient` / `groupBatch` public API
 * - orchestrates MDC / ADRG / DRG matching using helpers under `src/services/grouper/`
 * - preserves `matchTrace` for debugging and regression testing
 */

/**
 * Internal helpers for early validations and input sanitization.
 * These keep the main flow in `groupPatient` easy to read while preserving
 * the original behavior.
 */
// Validation helpers (inlined from `grouper/validations.js`).
// Kept inline to reduce indirection for early input sanitization.
function checkInvalidPrincipalDiagnosis(principalDiagnosis: string | null): GroupingResult | null {
    if (principalDiagnosis && isInvalidDiagnosis(principalDiagnosis)) {
        // lite build omits weight / special-payment entirely
    const base: GroupingResult = {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '编码不规范：主要诊断无效',
            matchTrace: [{ stage: 'Validation', error: true, description: `Principal diagnosis ${principalDiagnosis} is in ZD_INVALID list` }]
        };
    if (!IS_LITE) {
        base.weight = null;
        base.weightTier2 = null;
        // special‑payment flag not needed; weight '/' indicates it when present

    }
    return base;
    }
    return null;
}

function checkGrayPrincipalDiagnosis(principalDiagnosis: string | null): GroupingResult | null {
    if (principalDiagnosis && typeof isGrayDiag === 'function' && isGrayDiag(principalDiagnosis)) {
        const out: GroupingResult = {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '主要诊断为灰码（不确定/需人工判定）',
            matchTrace: [{ stage: 'Validation', error: true, description: `Principal diagnosis ${principalDiagnosis} is in gray-code list` }]
        };
        if (!IS_LITE) {
            out.weight = null;
            // flag omitted
        }
        return out;
    }
    return null;
}

const ALLOWED_GRAY_PRINCIPAL_PROCEDURES = new Set(commonStrategy.allowedGrayPrincipalProcedures);

function checkGrayPrincipalProcedure(principalProcedure: string | null): GroupingResult | null {
    if (principalProcedure && ALLOWED_GRAY_PRINCIPAL_PROCEDURES.has(principalProcedure)) {
        return null;
    }
    if (principalProcedure && typeof isGrayProc === 'function' && isGrayProc(principalProcedure)) {
        const out: GroupingResult = {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '主要手术为灰码（不确定/需人工判定）',
            matchTrace: [{ stage: 'Validation', error: true, description: `Principal procedure ${principalProcedure} is in gray-code list` }]
        };
        if (!IS_LITE) {
            out.weight = null;
            // flag omitted
        }
        return out;
    }
    return null;
}

const ALLOWED_INVALID_PROCEDURES = new Set(commonStrategy.allowedInvalidPrincipalProcedures);
function sanitizeProcedures(effectiveProcedures: Array<string | null>, matchTrace: MatchTraceEntry[]): { effectiveProcedures: Array<string | null>; principalProcedure: string | null } {
    let principalProcedure = effectiveProcedures.length > 0 ? effectiveProcedures[0] : null;
    if (principalProcedure && isInvalidProcedure(principalProcedure) && !ALLOWED_INVALID_PROCEDURES.has(principalProcedure)) {
        if (commonStrategy.invalidPrincipalProcedureAction === 'shift') {
            effectiveProcedures.shift();
        } else if (commonStrategy.invalidPrincipalProcedureAction === 'null-slot') {
            effectiveProcedures[0] = null;
        } else if (commonStrategy.invalidPrincipalProcedureAction === 'keep') {
            return { effectiveProcedures, principalProcedure };
        }
        matchTrace.push({ stage: 'Validation', warning: true, description: `Removed invalid principal procedure: ${principalProcedure}` });
        principalProcedure = null;
    }
    return { effectiveProcedures, principalProcedure: principalProcedure ?? null };
}

const PATIENT_INFO_FIELDS = [
    'gender',
    'age',
    'ageInDays',
    'birthWeight',
    'admissionWeight',
    'dischargeStatus',
    'newTechnique',
    'intensiveCare',
    'icuHours',
    'crrtHours',
    'lengthOfStay',
    'daySurgery',
] as const;
const PATIENT_BOOLEAN_FIELDS = [
    'newTechnique',
    'intensiveCare',
    'daySurgery',
] as const;
type RawPatientInfoValue = PatientScalarInput | PatientBooleanInput;

function normalizeCodeList(input: CodeListInput | null | undefined): string[] {
    const values = typeof input === 'string' ? [input] : Array.isArray(input) ? [...input] : [];
    return values.map(code => code.trim()).filter(Boolean);
}

function normalizePatientInfo(patientInfo: PatientInfoInput | null = {}): NormalizedPatientInfo {
    if (
        patientInfo === null
        || typeof patientInfo !== 'object'
        || Array.isArray(patientInfo)
        || (Object.getPrototypeOf(patientInfo) !== Object.prototype && Object.getPrototypeOf(patientInfo) !== null)
    ) {
        throw new TypeError('patientInfo must be a JSON object');
    }
    const normalized: Partial<Record<keyof NormalizedPatientInfo, RawPatientInfoValue>> = {};
    for (const field of PATIENT_INFO_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patientInfo, field)) normalized[field] = patientInfo[field];
    }
    const numericFields: Array<[keyof NormalizedPatientInfo, number]> = [
        ['age', 0],
        ['ageInDays', 0],
        ['birthWeight', 1],
        ['admissionWeight', 1],
        ['icuHours', 0],
        ['crrtHours', 0],
        ['lengthOfStay', 0],
    ];
    for (const [field, minimum] of numericFields) {
        const raw = normalized[field];
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
            delete normalized[field];
            continue;
        }
        if (typeof raw !== 'number' && typeof raw !== 'string') {
            throw new TypeError(`patientInfo.${field} must be ${minimum === 0 ? 'a non-negative number' : `at least ${minimum}`}`);
        }
        const value = Number(typeof raw === 'string' ? raw.trim() : raw);
        if (!Number.isFinite(value) || value < minimum) {
            throw new TypeError(`patientInfo.${field} must be ${minimum === 0 ? 'a non-negative number' : `at least ${minimum}`}`);
        }
        normalized[field] = Math.trunc(value);
    }
    if (normalized.ageInDays !== undefined) {
        if (normalized.age === undefined) {
            normalized.age = 0;
        } else if (normalized.age !== 0) {
            throw new TypeError('patientInfo.age must be 0 or omitted when patientInfo.ageInDays is provided');
        }
    }
    if (normalized.gender !== undefined && normalized.gender !== null && String(normalized.gender).trim() !== '') {
        if (typeof normalized.gender !== 'number' && typeof normalized.gender !== 'string') {
            throw new TypeError('patientInfo.gender must be 1 or 2');
        }
        const gender = String(normalized.gender).trim();
        if (gender !== '1' && gender !== '2') throw new TypeError('patientInfo.gender must be 1 or 2');
        normalized.gender = Number(gender);
    } else {
        delete normalized.gender;
    }
    for (const field of PATIENT_BOOLEAN_FIELDS) {
        const raw = normalized[field];
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
            delete normalized[field];
            continue;
        }
        if (raw === true || raw === false) continue;
        if (typeof raw !== 'number' && typeof raw !== 'string') {
            throw new TypeError(`patientInfo.${field} must be a boolean or a recognized true/false value`);
        }
        const value = String(raw).trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', '是'].includes(value)) normalized[field] = true;
        else if (['false', '0', 'no', 'n', 'off', '否'].includes(value)) normalized[field] = false;
        else throw new TypeError(`patientInfo.${field} must be a boolean or a recognized true/false value`);
    }
    if (normalized.dischargeStatus !== undefined && normalized.dischargeStatus !== null && String(normalized.dischargeStatus).trim() !== '') {
        if (typeof normalized.dischargeStatus !== 'number' && typeof normalized.dischargeStatus !== 'string') {
            throw new TypeError('patientInfo.dischargeStatus must be a string or number');
        }
        const status = String(normalized.dischargeStatus).trim();
        normalized.dischargeStatus = status === '5' || status.toLowerCase() === 'death' ? 'death' : status;
    } else {
        delete normalized.dischargeStatus;
    }
    return normalized as NormalizedPatientInfo;
}

function invalidPatientInfoResult(error: unknown): GroupingResult {
    const message = error instanceof Error ? error.message : String(error);
    const out: GroupingResult = {
        drg: null,
        code: 'ERR',
        mdc: null,
        adrg: null,
        description: `病人信息无效：${message}`,
        error: 'INVALID_PATIENT_INFO',
        matchTrace: [{
            stage: 'Validation',
            error: true,
            description: message,
        }],
    };
    if (!IS_LITE) {
        out.weight = null;
        out.weightTier2 = null;
    }
    return out;
}


// MDC / ADRG selection helpers moved to `src/service./grouper/mdcAdrgSelection.js`
// Imported above as: checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect


// evaluateADRGSubgroups implementation lives in `src/services/grouper/subgroupEval.js`.
// Public re-exports are declared at the top of this file.

// ---------------------------------------------------------------------------
// Rule evaluation helpers
// - Rule/section matching lives under `src/services/grouper/` (mdcSelection.js & subgroupEval.js)
// - Runtime logic evaluation expects `rule._logicRPN` to be pre-compiled at build time
// ---------------------------------------------------------------------------
/**
 * Determine whether a parsed `rule` matches a patient (diagnoses/procedures).
 * - Returns an object { matched: boolean, details: { sections: { ... } } }
 * - Uses compiled rule logic when present.
 * @param {Object} rule - parsed rule object (from parseRule)
 * @param {Object} patient - { diagnoses: string[], procedures: string[] }
 */
// `matchesRule` implementation lives in `src/service./grouper/mdcAdrgSelection.js`.
// Public re-exports are declared at the top of this file.


// ---------------------------------------------------------------------------
// Public API — grouping functions
// ---------------------------------------------------------------------------
/**
 * Groups a patient record into a DRG.
 * @param {string[]} diagnoses - List of diagnosis codes. First one is Principal.
 * @param {string[]} procedures - List of procedure codes.
 * @returns {object} Result object { drg, mdc, adrg, description }
 */
function groupPatient(
    diagnoses: CodeListInput,
    procedures: CodeListInput,
    patientInfo: PatientInfoInput | null = {},
): GroupingResult {
    const diagnosisList = normalizeCodeList(diagnoses);
    const procedureList = normalizeCodeList(procedures);
    let normalizedPatientInfo: NormalizedPatientInfo;
    try {
        normalizedPatientInfo = normalizePatientInfo(patientInfo);
    } catch (error) {
        return invalidPatientInfoResult(error);
    }

    if (diagnosisList.length === 0) {
        const out: GroupingResult = {
            drg: "0000",
            mdc: null,
            adrg: null,
            description: "编码不规范：无主要诊断或手术",
            matchTrace: [{ stage: 'Validation', error: true, description: 'No input data provided' }]
        };
        if (!IS_LITE) {
            out.weight = null;
            // flag omitted
        }
        return out;
    }
    // Keep token boundaries and ordering exactly; only trim outer whitespace.
    // Accept single-string inputs (treat as one token) but do NOT split on delimiters.
    const principalDiagnosis = diagnosisList.length > 0 ? diagnosisList[0] ?? null : null;

    // Initialize match trace early so any early-return or pre-checks can
    // safely reference it without hitting temporal-dead-zone errors.
    const matchTrace: MatchTraceEntry[] = [];

    // Validation 1: Gray-code check (treat as ungroupable)
    const grayDiagEarly = checkGrayPrincipalDiagnosis(principalDiagnosis);
    if (grayDiagEarly) return grayDiagEarly;

    // Validation 1b: ZD_INVALID check (only if diagnosis present)
    const invalidDiagEarly = checkInvalidPrincipalDiagnosis(principalDiagnosis);
    if (invalidDiagEarly) return invalidDiagEarly;

    // Validation 1c: Gray-code check for principal procedure
    let effectiveProcedures: Array<string | null> = [...procedureList];
    let principalProcedure: string | null = effectiveProcedures.length > 0 ? effectiveProcedures[0] ?? null : null;
    const grayProcEarly = checkGrayPrincipalProcedure(principalProcedure);
    if (grayProcEarly) return grayProcEarly;

    // Validation 2: SS_INVALID check (sanitize procedure list)
    ({ effectiveProcedures, principalProcedure } = sanitizeProcedures(effectiveProcedures, matchTrace));

    let matchedMDC = null;
    let matchedADRG = null;
    let ruleMatchDetail = null;

    // Pre-MDC checks: treat these MDCs as pre-MDC ADRG candidates
    // Evaluate ADRG rules for MDCA, MDCP, MDCY, MDCZ in priority order,
    // but only attempt MDCP/MDCY/MDCZ if their identifying criteria are met.
    // Extracted pre-MDC ADRG checks into helper
    const premdc = checkPreMDCADRGs(diagnosisList, effectiveProcedures, normalizedPatientInfo, matchTrace);
    matchedMDC = premdc.matchedMDC;
    matchedADRG = premdc.matchedADRG;
    ruleMatchDetail = premdc.ruleMatchDetail;



    // Fallback: other MDCs by principal diagnosis (use helper)
    if (!matchedMDC) {
        matchedMDC = findMDCByPrincipal(principalDiagnosis, normalizedPatientInfo.gender, matchTrace);
    }
    // 3. Try to match ADRGs in the MDC (extracted helper)
    if (!matchedADRG && matchedMDC) {
        const adrgRes = findADRGInMDC(matchedMDC.code, diagnosisList, effectiveProcedures, normalizedPatientInfo, matchTrace);
        matchedADRG = adrgRes.matchedADRG;
        ruleMatchDetail = adrgRes.ruleMatchDetail;
    }
    // 4. Check if matched ADRG should be redirected to QY group
    // Rule: If ADRG second letter > 'Q' (medical groups R-Z) AND the principal
    // procedure satisfies the 3.0 all-procedure/QY condition, redirect to QY.
    const qyRedirect = checkQYRedirect(matchedADRG?.code ?? null, matchedMDC?.code ?? null, principalProcedure, matchTrace);
    if (qyRedirect) return qyRedirect;

    if (!matchedADRG) {
        matchTrace.push({ stage: 'ADRG', matched: false, description: 'No matching ADRG found' });
    }

    // --- Step 4: Find DRG within ADRG ---
    // DRGs are evaluated once, in their DRG.dat order. A raw/subgroup_rules source
    // attaches an ADRG-style matcher to the corresponding DRG candidate.
    const { matchedDRG } = evaluateADRGSubgroups(matchedADRG?.code ?? null, diagnosisList, procedureList, normalizedPatientInfo, matchTrace);

    const out: GroupingResult = {
        drg: matchedDRG ? matchedDRG.code : "0000",
        mdc: matchedMDC ? matchedMDC.code : null,
        adrg: matchedADRG ? matchedADRG.code : null,
        description: matchedDRG ? matchedDRG.description : (
            matchedADRG ? "不能进入该ADRG内任意DRG" : (
                matchedMDC ? "不能进入该MDC内任意ADRG" : "不能进入任意MDC"
            )
        ),
        ruleMatchDetail: ruleMatchDetail,
        matchTrace: matchTrace
    };
    if (!IS_LITE) {
        // base weight and optional tier‑2 hospital weight
        const drgEntry = matchedDRG ? drgMap[matchedDRG.code] : undefined;
        if (drgEntry) {
          out.weight = drgEntry.weight ?? null;
          out.weightTier2 = drgEntry.weightTier2 ?? null;
          // special payment is now represented simply by '/' in either weight field
        } else {
          out.weight = null;
          out.weightTier2 = null;
          // no special payment flag needed – absence of a slash weight implies false
        }
    }
    return out;
}



/**
 * Evaluates if a DRG sub-grouping rule matches the patient data.
 * @param {Object} rule - The rule object from drg_rules.json
 * @param {Object} patientData - { primaryDiagnosis, primaryProcedure, age, dischargeStatus }
 * @param {string} ccStatus - 'mcc', 'cc', or 'none'
 * @returns {Object} - { matched: boolean, reason: string }
 */

// ---------------------------------------------------------------------------
// Public API — batch grouping
// ---------------------------------------------------------------------------
/**
 * Groups a batch of patient records.
 * @returns {Array} Array of result objects for each record.
 */
function groupBatch(rows: BatchGroupingRow[] = []): BatchGroupingResult[] {
    // Expect an array of row objects: { id?, diagnoses?, procedures?, patientInfo? }
    if (!Array.isArray(rows)) return [];

    const out: BatchGroupingResult[] = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        try {
            // groupPatient owns code normalization; keep the batch input unchanged here.
            const diagnoses = row.diagnoses ?? [];
            const procedures = row.procedures ?? [];

            // Keep input diagnosis/procedure token boundaries (do NOT auto-split delimited strings).
            // This preserves CSV cell contents like 'M35.002+J99.1*' as a single diagnosis token.
            const patientInfo = row.patientInfo || {};

            const res = groupPatient(diagnoses, procedures, patientInfo) || {};

            // Preserve id and original arrays for downstream UI
            const result = {
                id: row.id || null,
                diagnoses: typeof diagnoses === 'string' ? [diagnoses] : [...diagnoses],
                procedures: typeof procedures === 'string' ? [procedures] : [...procedures],
                ...res
            };
            out.push(result);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            out.push({
                id: row && row.id ? row.id : null,
                drg: null,
                code: 'ERR',
                mdc: null,
                adrg: null,
                weight: null,
                // isSpecialPayment omitted
                description: 'ERROR during grouping',
                error: message
            });
        }
    }

    return out;
}
return { groupPatient, groupBatch, matchesRule, evaluateADRGSubgroups };
}

const defaultVersionDefinition = getVersionDefinition();
const defaultEngine = createGrouperEngine({
    ruleSet: loadRuleSet(),
    commonStrategy: defaultVersionDefinition.commonStrategy,
    versionStrategy: defaultVersionDefinition.versionStrategy,
});
export const groupPatient = defaultEngine.groupPatient;
export const groupBatch = defaultEngine.groupBatch;
export const matchesRule = defaultEngine.matchesRule;
export const evaluateADRGSubgroups = defaultEngine.evaluateADRGSubgroups;
