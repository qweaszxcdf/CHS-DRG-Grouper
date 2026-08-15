import { DEFAULT_RULE_VERSION, getVersionDefinition } from './generated/versionRegistry.ts';
import { loadVersionData } from './generated/versionData.ts';
import { createRuleSet } from './ruleSetFactory.ts';
import type { VersionId } from '../types/grouper.js';
import type { RuleSet } from '../types/rules.js';

const ruleSets: Map<VersionId, RuleSet> = new Map();

export function loadRuleSet(version = DEFAULT_RULE_VERSION) {
  const definition = getVersionDefinition(version);
  if (ruleSets.has(definition.id)) return ruleSets.get(definition.id)!;
  if (!definition.data) throw new Error(`Rule version ${definition.id} must be loaded with loadRuleSetAsync()`);
  ruleSets.set(definition.id, createRuleSet(definition.data));
  return ruleSets.get(definition.id)!;
}

const pendingRuleSets: Map<VersionId, Promise<RuleSet>> = new Map();
export async function loadRuleSetAsync(version = DEFAULT_RULE_VERSION) {
  if (ruleSets.has(version)) return ruleSets.get(version)!;
  if (!pendingRuleSets.has(version)) {
    const pending = loadVersionData(version).then((data) => {
      const ruleSet = createRuleSet(data);
      ruleSets.set(version, ruleSet);
      return ruleSet;
    }).finally(() => pendingRuleSets.delete(version));
    pendingRuleSets.set(version, pending);
  }
  return pendingRuleSets.get(version)!;
}
