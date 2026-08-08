import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupPatientByVersion,
  listRuleVersions,
} from '../src/services/versionedGrouper.js';
import { DEFAULT_RULE_VERSION } from '../src/services/generated/versionRegistry.js';

const sample = {
  diagnoses: ['K80.101', 'I50.900'],
  procedures: ['51.2300'],
  patientInfo: { gender: 1, age: 45, multiSite: false },
};

test('release exposes every bundled DRG version', () => {
  assert.deepEqual(
    listRuleVersions().map(({ id }) => id),
    ['chs-drg-2.0', 'chs-drg-3.0', 'shanghai-drg-2.0'],
  );
  assert.equal(DEFAULT_RULE_VERSION, 'shanghai-drg-2.0');
});

test('bundled versions produce their expected sample paths', async () => {
  const expected = {
    'chs-drg-2.0': ['MDCH', 'HC2', 'HC23'],
    'chs-drg-3.0': ['MDCH', 'HC4', 'HC43'],
    'shanghai-drg-2.0': ['MDCH', 'HC2', 'HC21'],
  };

  for (const [version, path] of Object.entries(expected)) {
    const result = await groupPatientByVersion(
      sample.diagnoses,
      sample.procedures,
      sample.patientInfo,
      version,
    );
    assert.equal(result.error, undefined, version);
    assert.deepEqual([result.mdc, result.adrg, result.drg], path, version);
  }
});
