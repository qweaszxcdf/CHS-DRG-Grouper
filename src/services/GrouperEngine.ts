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
import {
  PATIENT_BOOLEAN_FIELDS,
  PATIENT_INFO_FIELDS,
  PATIENT_NUMERIC_FIELDS,
} from '../types/patient_info_fields.ts';

// lite build flag - allows dead-code elimination when VITE_LITE=true
let IS_LITE = (import.meta.env as ImportMetaEnv | undefined)?.VITE_LITE === 'true';

// helper for tests to override behavior
export function _setLite(val: unknown): void { IS_LITE = !!val; }

// Moved helpers (see `src/services/grouper/*`)
import { createMdcAdrgSelection } from './grouper/mdcAdrgSelection.ts';
import { createSubgroupEvaluator } from './grouper/subgroupEval.ts';

export function createGrouperEngine({ ruleSet, commonStrategy, versionStrategy }: CreateGrouperEngineOptions): GrouperEngine {
const { isInvalidDiagnosis, isInvalidProcedure, isGrayDiag, isGrayProc, loadDRGMap } = ruleSet;
const drgMap = loadDRGMap();
const { checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect, matchesRule } = createMdcAdrgSelection(ruleSet, commonStrategy);
  const { evaluateADRGSubgroups } = createSubgroupEvaluator(
    ruleSet,
    matchesRule,
    versionStrategy,
  );

// Note: code conversion moved to `src/services/CodeConversion.ts` for caller-side control.

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
function checkInvalidPrincipalDiagnosis(principalDiagnosis: string): GroupingResult | null {
    if (isInvalidDiagnosis(principalDiagnosis)) {
        // lite build omits weight / special-payment entirely
    const base: GroupingResult = {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '编码不规范：主要诊断无效',
            matchTrace: [{ event: 'validation', error: true, description: `Principal diagnosis ${principalDiagnosis} is in ZD_INVALID list` }]
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

function checkGrayPrincipalDiagnosis(principalDiagnosis: string): GroupingResult | null {
    if (isGrayDiag(principalDiagnosis)) {
        const out: GroupingResult = {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '主要诊断为灰码（不确定/需人工判定）',
            matchTrace: [{ event: 'validation', error: true, description: `Principal diagnosis ${principalDiagnosis} is in gray-code list` }]
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
    if (principalProcedure && isGrayProc(principalProcedure)) {
        const out: GroupingResult = {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '主要手术为灰码（不确定/需人工判定）',
            matchTrace: [{ event: 'validation', error: true, description: `Principal procedure ${principalProcedure} is in gray-code list` }]
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
    let principalProcedure = effectiveProcedures[0] ?? null;
    if (principalProcedure && isInvalidProcedure(principalProcedure) && !ALLOWED_INVALID_PROCEDURES.has(principalProcedure)) {
        // Procedure positions are part of the grouping contract; never promote a later procedure.
        // Removal applies to Pre-MDC/ADRG routing and QY checks only; subgroup
        // evaluation still receives the original procedure list below.
        effectiveProcedures[0] = null;
        matchTrace.push({ event: 'validation', warning: true, description: `Removed invalid principal procedure: ${principalProcedure}` });
        principalProcedure = null;
    }
    return { effectiveProcedures, principalProcedure };
}

type RawPatientInfoValue = PatientScalarInput | PatientBooleanInput;

function normalizeCodeList(input: CodeListInput): string[] {
    const values = typeof input === 'string' ? [input] : [...input];
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
    for (const [field, minimum] of PATIENT_NUMERIC_FIELDS) {
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
        matchTrace: [{ event: 'validation',
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


// Subgroup evaluation lives in `src/services/grouper/subgroupEval.ts` and is
// kept internal to the grouping flow.

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
        normalizedPatientInfo = normalizePatientInfo(patientInfo || {});
    } catch (error) {
        return invalidPatientInfoResult(error);
    }

    if (diagnosisList.length === 0) {
        const out: GroupingResult = {
            drg: "0000",
            mdc: null,
            adrg: null,
            description: "编码不规范：无主要诊断或手术",
            matchTrace: [{ event: 'validation', error: true, description: 'No input data provided' }]
        };
        if (!IS_LITE) {
            out.weight = null;
            // flag omitted
        }
        return out;
    }
    // Keep token boundaries and ordering exactly; only trim outer whitespace.
    // Accept single-string inputs (treat as one token) but do NOT split on delimiters.
    const principalDiagnosis = diagnosisList[0]!;

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
    let principalProcedure: string | null = effectiveProcedures[0] ?? null;
    const grayProcEarly = checkGrayPrincipalProcedure(principalProcedure);
    if (grayProcEarly) return grayProcEarly;

    // Validation 2: SS_INVALID check (sanitize procedure list)
    ({ effectiveProcedures, principalProcedure } = sanitizeProcedures(effectiveProcedures, matchTrace));

    let matchedMDC = null;
    let matchedADRG = null;
    let ruleMatchDetail = null;

    // Evaluate configured Pre-MDC candidates in order, subject to their identifying criteria.
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
    const qyRedirect = matchedADRG && principalProcedure
        ? checkQYRedirect(matchedADRG.code, matchedMDC!.code, principalProcedure, matchTrace)
        : null;
    if (qyRedirect) return qyRedirect;

    // --- Step 4: Find DRG within ADRG ---
    // DRGs are evaluated once, in their DRG.dat order. A raw/subgroup_rules source
    // attaches an ADRG-style matcher to the corresponding DRG candidate.
    // Use the original procedure list: version-specific subgroup rules may match
    // an operation excluded from principal-procedure routing (e.g. Jiangsu LR1S).
    const subgroupResult = matchedADRG
        ? evaluateADRGSubgroups(matchedADRG.code, diagnosisList, procedureList, normalizedPatientInfo, matchTrace)
        : null;
    const matchedDRG = subgroupResult?.matchedDRG ?? null;

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
    const out: BatchGroupingResult[] = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        try {
            // groupPatient owns code normalization; keep the batch input unchanged here.
            const diagnoses = row.diagnoses ?? [];
            const procedures = row.procedures ?? [];

            // Keep input diagnosis/procedure token boundaries (do NOT auto-split delimited strings).
            // This preserves CSV cell contents like 'M35.002+J99.1*' as a single diagnosis token.
            const patientInfo = row.patientInfo || {};

            const res = groupPatient(diagnoses, procedures, patientInfo);

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
                id: row.id || null,
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
return { groupPatient, groupBatch };
}

const defaultVersionDefinition = getVersionDefinition();
const defaultEngine = createGrouperEngine({
    ruleSet: loadRuleSet(),
    commonStrategy: defaultVersionDefinition.commonStrategy,
    versionStrategy: defaultVersionDefinition.versionStrategy,
});
export const groupPatient = defaultEngine.groupPatient;
export const groupBatch = defaultEngine.groupBatch;
