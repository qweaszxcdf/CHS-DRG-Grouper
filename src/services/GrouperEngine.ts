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
import { PATIENT_NUMERIC_ENUM_PARSERS, parsePatientBoolean } from '../lib/patientInfoValues.ts';

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
const ybDiagNames = ruleSet.loadYBDiagNames();
const ybProcNames = ruleSet.loadYBProcNames();
const { checkPreMDCADRGs, findMDCByPrincipal, findADRGInMDC, checkQYRedirect, matchesRule } = createMdcAdrgSelection(ruleSet, commonStrategy);
const { evaluateADRGSubgroups } = createSubgroupEvaluator(ruleSet, matchesRule, versionStrategy,);

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
        // Un-grouped validation failures have no DRG weight to attach.
        return {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '编码不规范：主要诊断无效',
            matchTrace: [{ event: 'validation', error: true, description: `Principal diagnosis ${principalDiagnosis} is in ZD_INVALID list` }]
        };
    }
    return null;
}

function checkGrayPrincipalDiagnosis(principalDiagnosis: string): GroupingResult | null {
    if (isGrayDiag(principalDiagnosis)) {
        return {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '主要诊断为灰码（不确定/需人工判定）',
            matchTrace: [{ event: 'validation', error: true, description: `Principal diagnosis ${principalDiagnosis} is in gray-code list` }]
        };
    }
    return null;
}

const ALLOWED_GRAY_PRINCIPAL_PROCEDURES = new Set(commonStrategy.allowedGrayPrincipalProcedures);

function checkGrayPrincipalProcedure(principalProcedure: string | null): GroupingResult | null {
    if (principalProcedure && ALLOWED_GRAY_PRINCIPAL_PROCEDURES.has(principalProcedure)) {
        return null;
    }
    if (principalProcedure && isGrayProc(principalProcedure)) {
        return {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: '主要手术为灰码（不确定/需人工判定）',
            matchTrace: [{ event: 'validation', error: true, description: `Principal procedure ${principalProcedure} is in gray-code list` }]
        };
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
        effectiveProcedures = effectiveProcedures.slice();
        effectiveProcedures[0] = null;
        matchTrace.push({ event: 'validation', warning: true, description: `Removed invalid principal procedure: ${principalProcedure}` });
        principalProcedure = null;
    }
    return { effectiveProcedures, principalProcedure };
}

type RawPatientInfoValue = PatientScalarInput | PatientBooleanInput;

function normalizeCodeList(input: CodeListInput): string[] {
    const values = typeof input === 'string' ? [input] : Array.isArray(input) ? input : [...input];
    const normalized: string[] = new Array(values.length);
    let count = 0;
    for (const code of values) {
        const value = code.trim();
        if (value) normalized[count++] = value;
    }
    normalized.length = count;
    return normalized;
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
    for (const { key, parse, expected } of PATIENT_NUMERIC_ENUM_PARSERS) {
        const raw = normalized[key];
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            delete normalized[key];
            continue;
        }
        const value = typeof raw === 'number' || typeof raw === 'string' ? parse(raw) : undefined;
        if (value === undefined) throw new TypeError(`patientInfo.${key} must be ${expected}`);
        normalized[key] = value;
    }
    for (const field of PATIENT_BOOLEAN_FIELDS) {
        const raw = normalized[field];
        if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
            delete normalized[field];
            continue;
        }
        const value = parsePatientBoolean(raw);
        if (value === undefined) throw new TypeError(`patientInfo.${field} must be a boolean or a recognized true/false value`);
        normalized[field] = value;
    }
    return normalized as NormalizedPatientInfo;
}

function invalidPatientInfoResult(error: unknown): GroupingResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
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
        return {
            drg: "0000",
            mdc: null,
            adrg: null,
            description: "编码不规范：无主要诊断或手术",
            matchTrace: [{ event: 'validation', error: true, description: 'No input data provided' }]
        };
    }
    // Keep token boundaries and ordering exactly; only trim outer whitespace.
    // Accept single-string inputs (treat as one token) but do NOT split on delimiters.
    const principalDiagnosis = diagnosisList[0]!;

    // Initialize match trace early so any early-return or pre-checks can
    // safely reference it without hitting temporal-dead-zone errors.
    const matchTrace: MatchTraceEntry[] = [];

    // Principal codes must belong to this version's insurance code library.
    // Check exact membership before any routing, without promoting later codes.
    const unknownPrincipal = !Object.hasOwn(ybDiagNames, principalDiagnosis)
        ? { kind: '主要诊断', code: principalDiagnosis }
        : procedureList[0] && !Object.hasOwn(ybProcNames, procedureList[0])
            ? { kind: '主要手术/操作', code: procedureList[0] }
            : null;
    if (unknownPrincipal) {
        return {
            drg: '0000',
            mdc: null,
            adrg: null,
            description: `编码不规范：${unknownPrincipal.kind}不在医保代码库中`,
            matchTrace: [{ event: 'validation', error: true,
                description: `${unknownPrincipal.kind} ${unknownPrincipal.code} 不在当前版本医保代码库中` }],
        };
    }

    // Validation 1: Gray-code check (treat as ungroupable)
    const grayDiagEarly = checkGrayPrincipalDiagnosis(principalDiagnosis);
    if (grayDiagEarly) return grayDiagEarly;

    // Validation 1b: ZD_INVALID check (only if diagnosis present)
    const invalidDiagEarly = checkInvalidPrincipalDiagnosis(principalDiagnosis);
    if (invalidDiagEarly) return invalidDiagEarly;

    // Validation 1c: Gray-code check for principal procedure
    let effectiveProcedures: Array<string | null> = procedureList;
    let principalProcedure: string | null = effectiveProcedures[0] ?? null;
    const grayProcEarly = checkGrayPrincipalProcedure(principalProcedure);
    if (grayProcEarly) return grayProcEarly;

    // Validation 2: SS_INVALID check (sanitize procedure list)
    ({ effectiveProcedures, principalProcedure } = sanitizeProcedures(effectiveProcedures, matchTrace));

    const routingPatient = {
        diagnoses: diagnosisList,
        procedures: effectiveProcedures,
        patientInfo: normalizedPatientInfo,
    };

    let matchedMDC = null;
    let matchedADRG = null;
    let ruleMatchDetail = null;

    // Evaluate configured Pre-MDC candidates in order, subject to their identifying criteria.
    const premdc = checkPreMDCADRGs(routingPatient, matchTrace);
    matchedMDC = premdc.matchedMDC;
    matchedADRG = premdc.matchedADRG;
    ruleMatchDetail = premdc.ruleMatchDetail;



    // Fallback: other MDCs by principal diagnosis (use helper)
    if (!matchedMDC) {
        matchedMDC = findMDCByPrincipal(principalDiagnosis, normalizedPatientInfo.gender, matchTrace);
    }
    // 3. Try to match ADRGs in the MDC (extracted helper)
    if (!matchedADRG && matchedMDC) {
        const adrgRes = findADRGInMDC(matchedMDC.code, routingPatient, matchTrace);
        matchedADRG = adrgRes.matchedADRG;
        ruleMatchDetail = adrgRes.ruleMatchDetail;
    }
    if (!matchedMDC || !matchedADRG) {
        const out: GroupingResult = {
            drg: "0000",
            mdc: matchedMDC ? matchedMDC.code : null,
            adrg: null,
            description: matchedMDC ? "不能进入该MDC内任意ADRG" : "不能进入任意MDC",
            ruleMatchDetail: ruleMatchDetail,
            matchTrace: matchTrace
        };
        return out;
    }
    // 4. Check if matched ADRG should be redirected to QY group
    // Rule: If ADRG second letter > 'Q' (medical groups R-Z) AND the principal
    // procedure satisfies the all-procedure/QY condition, redirect to QY
    // when enabled by the version strategy.
    const qyRedirect = versionStrategy.enableQyRedirect && principalProcedure
        ? checkQYRedirect(matchedADRG.code, matchedMDC.code, principalProcedure, matchTrace)
        : null;
    if (qyRedirect) return qyRedirect;

    // --- Step 4: Find DRG within ADRG ---
    // DRGs are evaluated once, in their DRG.dat order. A raw/subgroup_rules source
    // attaches an ADRG-style matcher to the corresponding DRG candidate.
    // Use the original procedure list: version-specific subgroup rules may match
    // an operation excluded from principal-procedure routing (e.g. Jiangsu LR1S).
    const matchedDRG = evaluateADRGSubgroups(matchedADRG.code, diagnosisList, procedureList, normalizedPatientInfo, matchTrace).matchedDRG;

    const out: GroupingResult = {
        drg: matchedDRG.code,
        mdc: matchedMDC.code,
        adrg: matchedADRG.code,
        description: matchedDRG.description,
        ruleMatchDetail: ruleMatchDetail,
        matchTrace: matchTrace
    };
    if (!IS_LITE) {
        // base weight and optional tier‑2 hospital weight
        const drgEntry = drgMap[matchedDRG.code];
        out.weight = drgEntry?.weight ?? null;
        out.weightTier2 = drgEntry?.weightTier2 ?? null;
        // special payment is now represented simply by '/' in either weight field
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
                id: row.id ?? null,
                diagnoses: typeof diagnoses === 'string' ? [diagnoses] : [...diagnoses],
                procedures: typeof procedures === 'string' ? [procedures] : [...procedures],
                ...res
            };
            out.push(result);
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            out.push({
                id: row.id ?? null,
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
