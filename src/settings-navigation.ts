// Display names and destinations shared by Settings and the command palette.
// IDs stay stable: the backend vocabulary and permissions do not depend on UI copy.
export type SettingsTab = 'account' | 'hosts' | 'vault' | 'tools' | 'roles' | 'people' | 'gateway' | 'activity' | 'catalog';
export type SettingsGroup = 'you' | 'guild' | 'advanced';

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroup; label: string }> = [
  { id: 'you', label: 'Your Nod' },
  { id: 'guild', label: 'Your guild' },
  { id: 'advanced', label: 'Advanced' },
];

export const SETTINGS_TABS: ReadonlyArray<{
  id: SettingsTab; label: string; group: SettingsGroup; admin: boolean; action: string; aliases: string; connected?: boolean;
}> = [
  { id: 'vault', label: 'Saved logins', group: 'you', admin: false, action: 'Manage saved logins', aliases: 'vault passwords credentials' },
  { id: 'account', label: 'Account', group: 'you', admin: false, action: 'Account and app settings', aliases: 'security devices updates' },
  { id: 'hosts', label: 'Guild connection', group: 'guild', admin: false, action: 'Manage guild connection', aliases: 'hosts team sync sign in' },
  { id: 'tools', label: 'Tools', group: 'guild', admin: true, action: 'Manage team tools', aliases: 'catalog add tool' },
  { id: 'people', label: 'People', group: 'guild', admin: true, action: 'Manage people and invites', aliases: 'members invite access code' },
  { id: 'gateway', label: 'Gateway', group: 'guild', admin: true, connected: true, action: 'Manage gateway routes', aliases: 'caddy proxy routes domain reverse upstream' },
  { id: 'roles', label: 'Access', group: 'guild', admin: true, action: 'Manage tool access', aliases: 'roles grants permissions' },
  { id: 'activity', label: 'Activity', group: 'advanced', admin: true, action: 'View activity', aliases: 'audit events' },
  { id: 'catalog', label: 'Setup files', group: 'advanced', admin: true, action: 'Import or export setup', aliases: 'catalog seed backup restore' },
];

/** `connected`: a guild answers; tabs flagged `connected` (the gateway is the host's) need one. */
export function settingsTabs(admin: boolean, connected = true) {
  return SETTINGS_TABS.filter((tab) => (!tab.admin || admin) && (tab.connected !== true || connected));
}
