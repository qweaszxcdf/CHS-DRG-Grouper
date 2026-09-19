import { DEFAULT_RULE_VERSION, getVersionDefinition } from './generated/versionRegistry.ts';
import { loadVersionData } from './generated/versionData.ts';
import { createRuleSet } from './ruleSetFactory.ts';
import type { VersionId } from '../types/grouper.js';
import type { RuleSet } from '../types/rules.js';

const ruleSets: Map<VersionId, RuleSet> = new Map();

export function loadRuleSet(version = DEFAULT_RULE_VERSION) {
  const definition = getVersionDefinition(version);
  const cached = ruleSets.get(definition.id);
  if (cached) return cached;
  if (!definition.data) throw new Error(`Rule version ${definition.id} must be loaded with loadRuleSetAsync()`);
  const ruleSet = createRuleSet(definition.data);
  ruleSets.set(definition.id, ruleSet);
  return ruleSet;
}

const pendingRuleSets: Map<VersionId, Promise<RuleSet>> = new Map();
export async function loadRuleSetAsync(version = DEFAULT_RULE_VERSION) {
  const cached = ruleSets.get(version);
  if (cached) return cached;

  const pending = pendingRuleSets.get(version);
  if (pending) return pending;

  const next = loadVersionData(version).then((data) => {
    const ruleSet = createRuleSet(data);
    ruleSets.set(version, ruleSet);
    return ruleSet;
  }).finally(() => pendingRuleSets.delete(version));
  pendingRuleSets.set(version, next);
  return next;
}
