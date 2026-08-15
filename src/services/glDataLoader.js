import { DEFAULT_RULE_VERSION, getVersionDefinition } from './generated/versionRegistry.ts';

const cachedData = new Map();
const pendingData = new Map();

export function getGLData(version = DEFAULT_RULE_VERSION) {
  return cachedData.get(version) || null;
}

export function preloadGLData(version = DEFAULT_RULE_VERSION) {
  if (cachedData.has(version)) return Promise.resolve(cachedData.get(version));
  if (!pendingData.has(version)) {
    const pending = import('./generated/glData.ts')
      .then(({ loadGlData }) => loadGlData(getVersionDefinition(version).packages))
      .then((glData) => {
        cachedData.set(version, glData);
        return glData;
      })
      .finally(() => pendingData.delete(version));
    pendingData.set(version, pending);
  }
  return pendingData.get(version);
}
