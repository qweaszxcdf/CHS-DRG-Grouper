import { DEFAULT_RULE_VERSION, getVersionDefinition } from './generated/versionRegistry.ts';
import type { VersionId } from '../types/grouper.js';

type MappingTable = Record<string, string> & { mapping?: Record<string, string> };
export interface GlData {
  glDiagNames?: import('../types/rules.ts').NameMapWithInitials;
  glProcNames?: import('../types/rules.ts').NameMapWithInitials;
  icdGlToYbRaw?: MappingTable;
  icd9GlToYbRaw?: MappingTable;
}

const cachedData = new Map<VersionId, GlData>();
const pendingData = new Map<VersionId, Promise<GlData>>();

export function getGLData(version: VersionId = DEFAULT_RULE_VERSION): GlData | null {
  return cachedData.get(version) ?? null;
}

export function preloadGLData(version: VersionId = DEFAULT_RULE_VERSION): Promise<GlData> {
  const cached = cachedData.get(version);
  if (cached) return Promise.resolve(cached);

  const pending = pendingData.get(version);
  if (pending) return pending;

  const next = import('./generated/glData.ts')
    .then(({ loadGlData }) => loadGlData(getVersionDefinition(version).packages) as Promise<GlData>)
    .then((glData) => {
      cachedData.set(version, glData);
      return glData;
    })
    .finally(() => pendingData.delete(version));
  pendingData.set(version, next);
  return next;
}
