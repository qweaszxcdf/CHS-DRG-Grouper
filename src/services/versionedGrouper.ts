import { DEFAULT_RULE_VERSION, getVersionDefinition, listVersionDefinitions } from './generated/versionRegistry.ts';
import { createGrouperEngine } from './GrouperEngine.ts';
import { loadRuleSetAsync } from './ruleSetLoader.ts';
import type { BatchGroupingResult, BatchGroupingRow, CodeListInput, GrouperEngine, GroupingResult, PatientInfoInput, VersionId } from '../types/grouper.js';
import type { RuleSet } from '../types/rules.js';

const engines = new Map<VersionId, GrouperEngine>();

function createAndCacheEngine(definition: ReturnType<typeof getVersionDefinition>, ruleSet: RuleSet): GrouperEngine {
  const engine = createGrouperEngine({
    ruleSet,
    commonStrategy: definition.commonStrategy,
    versionStrategy: definition.versionStrategy,
  });
  engines.set(definition.id, engine);
  return engine;
}

export function listRuleVersions() {
  return listVersionDefinitions();
}

export function preloadRuleVersion(version = DEFAULT_RULE_VERSION) {
  return resolveEngine(version);
}

export async function resolveEngine(version = DEFAULT_RULE_VERSION): Promise<GrouperEngine> {
  const definition = getVersionDefinition(version);
  const cached = engines.get(definition.id);
  if (cached) return cached;

  const ruleSet = await loadRuleSetAsync(definition.id);
  const loaded = engines.get(definition.id);
  if (loaded) return loaded;
  return createAndCacheEngine(definition, ruleSet);
}

export function groupPatientByVersion(diagnoses: CodeListInput, procedures: CodeListInput, patientInfo: PatientInfoInput | null = {}, version: VersionId = DEFAULT_RULE_VERSION): Promise<GroupingResult> {
  return resolveEngine(version).then((engine) => engine.groupPatient(diagnoses, procedures, patientInfo));
}

export function groupBatchByVersion(rows: BatchGroupingRow[], version: VersionId = DEFAULT_RULE_VERSION): Promise<BatchGroupingResult[]> {
  return resolveEngine(version).then((engine) => engine.groupBatch(rows).map(result => ({ ...result, version })));
}
