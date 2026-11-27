import { describe, expect, test } from 'bun:test';
import { SETTINGS_GROUPS, SETTINGS_TABS, settingsTabs } from '../src/settings-navigation';

describe('task-based Settings navigation', () => {
  test('members get their logins, account and guild connection only', () => {
    expect(settingsTabs(false).map((tab) => tab.id)).toEqual(['vault', 'account', 'hosts']);
    expect(settingsTabs(false).every((tab) => !tab.admin && tab.group !== 'advanced')).toBe(true);
  });

  test('admins retain every stable destination and technical screens stay advanced', () => {
    expect(settingsTabs(true).map((tab) => tab.id)).toEqual([
      'vault', 'account', 'hosts', 'tools', 'people', 'gateway', 'roles', 'activity', 'catalog',
    ]);
    // RF-80: the gateway is the host's, so a Nod without a guild does not offer it.
    expect(settingsTabs(true, false).map((tab) => tab.id)).not.toContain('gateway');
    expect(settingsTabs(true).filter((tab) => tab.group === 'advanced').map((tab) => tab.id))
      .toEqual(['activity', 'catalog']);
  });

  test('every destination has one group and one searchable task action', () => {
    const groups = SETTINGS_GROUPS.map((group) => group.id);
    expect(new Set(SETTINGS_TABS.map((tab) => tab.id)).size).toBe(SETTINGS_TABS.length);
    expect(new Set(SETTINGS_TABS.map((tab) => tab.action)).size).toBe(SETTINGS_TABS.length);
    for (const tab of SETTINGS_TABS) {
      expect(groups).toContain(tab.group);
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.action.length).toBeGreaterThan(0);
      expect(tab.aliases.length).toBeGreaterThan(0);
    }
  });

  test('old vocabulary remains searchable without being the primary copy', () => {
    for (const [id, alias] of [
      ['vault', 'vault'], ['hosts', 'hosts'], ['roles', 'roles'], ['catalog', 'seed'],
    ] as const) {
      expect(SETTINGS_TABS.find((tab) => tab.id === id)?.aliases.split(' ')).toContain(alias);
    }
  });
});
