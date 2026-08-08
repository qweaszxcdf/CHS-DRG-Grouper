import { DEFAULT_RULE_VERSION, getVersionDefinition, listVersionDefinitions } from './generated/versionRegistry.js';
import { createGrouperEngine } from './GrouperEngine.js';
import { loadRuleSet, loadRuleSetAsync } from './ruleSetLoader.js';

const engines = new Map();

export function listRuleVersions() {
  return listVersionDefinitions();
}

export function preloadRuleVersion(version = DEFAULT_RULE_VERSION) {
  return Promise.resolve(resolveEngine(version));
}

export function resolveEngine(version = DEFAULT_RULE_VERSION) {
  const definition = getVersionDefinition(version);
  if (engines.has(definition.id)) return engines.get(definition.id);
  if (definition.id === DEFAULT_RULE_VERSION) {
    const engine = createGrouperEngine({ ruleSet: loadRuleSet(definition.id), strategy: definition.strategy });
    engines.set(definition.id, engine);
    return engine;
  }
  return loadRuleSetAsync(definition.id).then((ruleSet) => {
    if (engines.has(definition.id)) return engines.get(definition.id);
    const engine = createGrouperEngine({
      ruleSet,
      strategy: definition.strategy,
    });
    engines.set(definition.id, engine);
    return engine;
  });
}

export function groupPatientByVersion(diagnoses, procedures, patientInfo = {}, version = DEFAULT_RULE_VERSION) {
  const engine = resolveEngine(version);
  if (engine && typeof engine.then === 'function') {
    return engine.then((loaded) => loaded.groupPatient(diagnoses, procedures, patientInfo));
  }
  return engine.groupPatient(diagnoses, procedures, patientInfo);
}

export function groupBatchByVersion(rows, version = DEFAULT_RULE_VERSION) {
  const engine = resolveEngine(version);
  const group = (loaded) => loaded.groupBatch(rows).map(result => ({ ...result, version }));
  return engine && typeof engine.then === 'function' ? engine.then(group) : group(engine);
}
