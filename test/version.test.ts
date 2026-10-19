// `shared/version.ts`: the comparison O2's gate is decided with — the running app's version against
// the host's `minAppVersion` (SP04 §1, SP03 §3). Behavior, not wording: what the numbers answer for
// equal, newer, older, a pre-release and a text that is not a version at all.
import { describe, expect, test } from 'bun:test';
import { compareVersions } from '../shared/version';

describe('compareVersions', () => {
  test('orders by each numeric component', () => {
    expect(compareVersions('0.3.5', '0.3.5')).toBe(0);
    expect(compareVersions('0.3.5', '0.3.6')).toBe(-1);
    expect(compareVersions('0.3.6', '0.3.5')).toBe(1);
    expect(compareVersions('0.4.0', '0.3.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('10.0.0', '9.0.0')).toBe(1);
  });

  test('a missing component is a zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('0.4', '0.3.5')).toBe(1);
  });

  test('a leading v and surrounding spaces are presentation', () => {
    expect(compareVersions('v0.3.5', '0.3.5')).toBe(0);
    expect(compareVersions(' 0.3.5 ', 'V0.3.5')).toBe(0);
  });

  test('a pre-release is older than the release it leads to, and build metadata orders nothing', () => {
    expect(compareVersions('0.4.0-rc.1', '0.4.0')).toBe(-1);
    expect(compareVersions('0.4.0', '0.4.0-rc.1')).toBe(1);
    expect(compareVersions('0.4.0-rc.1', '0.4.0-rc.2')).toBe(-1);
    expect(compareVersions('0.4.0-rc.2', '0.4.0-rc.10')).toBe(-1);
    expect(compareVersions('0.4.0-alpha', '0.4.0-alpha.1')).toBe(-1);
    expect(compareVersions('0.4.0-alpha.1', '0.4.0-beta')).toBe(-1);
    expect(compareVersions('0.4.0+build.7', '0.4.0+build.9')).toBe(0);
    expect(compareVersions('0.4.0-rc.1+build', '0.4.0-rc.1')).toBe(0);
  });

  test('a hotfix letter sits after its release and before the next patch (0.5.5a)', () => {
    // The runtime's own check reads 0.5.5a as 0.5.5; this order is what offers the hotfix.
    expect(compareVersions('0.5.5', '0.5.5a')).toBe(-1);
    expect(compareVersions('0.5.5a', '0.5.5')).toBe(1);
    expect(compareVersions('0.5.5a', '0.5.5b')).toBe(-1);
    expect(compareVersions('0.5.5z', '0.5.5aa')).toBe(-1);
    expect(compareVersions('0.5.5b', '0.5.6')).toBe(-1);
    expect(compareVersions('0.5.5a', '0.5.5a')).toBe(0);
    expect(compareVersions('v0.5.5a', '0.5.5a')).toBe(0);
    // Letters belong to the patch only, and lowercase.
    expect(compareVersions('0.5a.5', '0.5.5')).toBe(0);
    expect(compareVersions('0.5.5A', '0.5.5')).toBe(0);
  });

  test('a text that is not a version answers "not older, not newer"', () => {
    // O2: a `minAppVersion` no one can read must not stop a Nod from syncing.
    expect(compareVersions('0.3.5', '')).toBe(0);
    expect(compareVersions('0.3.5', 'latest')).toBe(0);
    expect(compareVersions('', '0.3.5')).toBe(0);
    expect(compareVersions('0.3.5', '1.2.3.4')).toBe(0);
    expect(compareVersions('0.3.5', '1.x.0')).toBe(0);
    expect(compareVersions('0.3.5', 'not-a-version')).toBe(0);
  });

  test('the gate of O2 reads a current app as current and an old one as old', () => {
    const required = '0.3.5';
    for (const [version, older] of [
      ['0.3.5', false],
      ['0.3.6', false],
      ['0.4.0', false],
      ['0.3.4', true],
      ['0.2.9', true],
    ] as const) {
      expect(compareVersions(version, required) < 0).toBe(older);
    }
  });
});
