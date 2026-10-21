import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupPatientByVersion,
  listRuleVersions,
} from '../src/services/versionedGrouper.ts';
import { DEFAULT_RULE_VERSION } from '../src/services/generated/versionRegistry.ts';

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

test('CHS 2.0 procedure eligibility controls QY redirects and preserves principal position', async () => {
  for (const [version, medicalDrg] of [
    ['chs-drg-2.0', 'HZ29'],
    ['shanghai-drg-2.0', 'HZ25'],
  ]) {
    for (const procedures of [
      ['93.0100x002'],
      ['93.0100x002', '33.2402'],
      ['00.0900x001', '33.2402'],
    ]) {
      const result = await groupPatientByVersion(['K80.101'], procedures, {}, version);
      assert.deepEqual([result.mdc, result.adrg, result.drg], ['MDCH', 'HZ2', medicalDrg], version);
      assert.equal(result.matchTrace.some(entry => entry.event === 'qy-redirect'), false);
    }
    const qy = await groupPatientByVersion(['K80.101'], ['93.9000'], {}, version);
    assert.deepEqual([qy.mdc, qy.adrg, qy.drg], ['MDCH', 'HQY', 'HQY'], version);
    assert.equal(qy.matchTrace.some(entry => entry.event === 'qy-redirect' && entry.code === 'HQY'), true);

    const unlisted = await groupPatientByVersion(['B90.000'], ['93.1100'], {}, version);
    const listed = await groupPatientByVersion(['B90.000'], ['93.9000'], {}, version);
    assert.deepEqual([unlisted.mdc, unlisted.adrg, unlisted.drg], ['MDCX', 'XT3', 'XT35'], version);
    assert.deepEqual([listed.mdc, listed.adrg, listed.drg], ['MDCX', 'XJ1', 'XJ15'], version);
  }
});
