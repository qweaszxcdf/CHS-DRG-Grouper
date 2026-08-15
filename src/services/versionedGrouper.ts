import { DEFAULT_RULE_VERSION, getVersionDefinition, listVersionDefinitions } from './generated/versionRegistry.ts';
import { createGrouperEngine } from './GrouperEngine.ts';
import { loadRuleSet, loadRuleSetAsync } from './ruleSetLoader.ts';
import type { BatchGroupingResult, BatchGroupingRow, CodeListInput, GrouperEngine, GroupingResult, MaybePromise, PatientInfoInput, VersionId } from '../types/grouper.js';

const engines = new Map<VersionId, GrouperEngine>();

export function listRuleVersions() {
  return listVersionDefinitions();
}

export function preloadRuleVersion(version = DEFAULT_RULE_VERSION) {
  return Promise.resolve(resolveEngine(version));
}

export function resolveEngine(version = DEFAULT_RULE_VERSION) {
  const definition = getVersionDefinition(version);
  if (engines.has(definition.id)) return engines.get(definition.id)!;
  if (definition.id === DEFAULT_RULE_VERSION) {
    const engine = createGrouperEngine({
      ruleSet: loadRuleSet(definition.id),
      commonStrategy: definition.commonStrategy,
      versionStrategy: definition.versionStrategy,
    });
    engines.set(definition.id, engine);
    return engine;
  }
  return loadRuleSetAsync(definition.id).then((ruleSet) => {
    if (engines.has(definition.id)) return engines.get(definition.id)!;
    const engine = createGrouperEngine({
      ruleSet,
      commonStrategy: definition.commonStrategy,
      versionStrategy: definition.versionStrategy,
    });
    engines.set(definition.id, engine);
    return engine;
  });
}

export function groupPatientByVersion(diagnoses: CodeListInput, procedures: CodeListInput, patientInfo: PatientInfoInput | null = {}, version: VersionId = DEFAULT_RULE_VERSION): MaybePromise<GroupingResult> {
  const engine = resolveEngine(version);
  if (engine instanceof Promise) {
    return engine.then((loaded) => loaded.groupPatient(diagnoses, procedures, patientInfo));
  }
  return engine.groupPatient(diagnoses, procedures, patientInfo);
}

export function groupBatchByVersion(rows: BatchGroupingRow[], version: VersionId = DEFAULT_RULE_VERSION): MaybePromise<BatchGroupingResult[]> {
  const engine = resolveEngine(version);
  const group = (loaded: GrouperEngine): BatchGroupingResult[] => loaded.groupBatch(rows).map(result => ({ ...result, version }));
  return engine instanceof Promise ? engine.then(group) : group(engine);
}
