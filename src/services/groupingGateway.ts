import type {
  CodeListInput,
  GroupingResult,
  PatientInfoInput,
  VersionId,
} from '../types/grouper.js';

export const IS_CLIENT_SERVER = import.meta.env.VITE_CLIENT_SERVER === 'true';

const apiBaseUrl = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

function apiUrl(path: string): string {
  return `${apiBaseUrl}/${path.replace(/^\/+/, '')}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to reach the C/S service: ${message}`);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    if (response.ok) throw new Error('C/S service returned an invalid JSON response');
  }

  if (!response.ok) {
    const message = typeof payload?.error === 'string'
      ? payload.error
      : `C/S service request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function checkGroupingServer(): Promise<Record<string, unknown>> {
  if (!IS_CLIENT_SERVER) return { ok: true, mode: 'browser' };
  return requestJson<Record<string, unknown>>('versions');
}

export async function groupPatient(
  diagnoses: CodeListInput,
  procedures: CodeListInput,
  patientInfo: PatientInfoInput | null = {},
  version?: VersionId,
  source = 'YB',
): Promise<GroupingResult> {
  if (!IS_CLIENT_SERVER) {
    const { groupPatientByVersion } = await import('./versionedGrouper.ts');
    let normalizedDiagnoses = Array.isArray(diagnoses) ? [...diagnoses] : [diagnoses];
    let normalizedProcedures = Array.isArray(procedures) ? [...procedures] : [procedures];
    if (source === 'GL') {
      const [{ preloadGLData }, { convertDiagnosesArray, convertProceduresArray }] = await Promise.all([
        import('./glDataLoader.js'),
        import('./CodeConversion.js'),
      ]);
      await preloadGLData(version);
      normalizedDiagnoses = convertDiagnosesArray(normalizedDiagnoses, version);
      normalizedProcedures = convertProceduresArray(normalizedProcedures, version);
    }
    const result = await groupPatientByVersion(normalizedDiagnoses, normalizedProcedures, patientInfo, version);
    return {
      ...result,
      diagnosesConverted: normalizedDiagnoses,
      proceduresConverted: normalizedProcedures,
      conversionApplied: source === 'GL',
    };
  }

  return postJson<GroupingResult>(`group${source === 'GL' ? '?source=GL' : ''}`, {
    diagnoses,
    procedures,
    patientInfo: patientInfo || {},
    version,
  }) as Promise<GroupingResult>;
}
