// Deterministic fake data. This file implements no credentials, tool windows, persistence or host.
(() => {
  const test = window.__fixtureCase;
  window.__fixtureErrors = [];
  window.__fixtureUnexpected = [];
  window.__fixtureCalls = [];
  window.addEventListener('error', event => window.__fixtureErrors.push(event.message));
  window.addEventListener('unhandledrejection', event => window.__fixtureErrors.push(String(event.reason)));
  const longName = 'Pessoa de teste com nome extenso para conferir a largura disponível';
  const roles = [
    {id: 'fixture-role-0', name: 'Papel de teste com nome extenso para o organograma', admin: true},
    {id: 'fixture-role-1', name: 'Segundo papel de teste', admin: false},
  ];
  const person = {id: 'fixture-person', name: longName, email: 'person@example.test', roles: [roles[0].id], admin: true, createdAt: '2026-01-01T00:00:00.000Z'};
  const session = {hasAccount: true, requiresInvite: false, unlocked: true, person, biometric: false, waitMs: 0, mode: 'offline'};
  const entries = Array.from({length: 7}, (_, index) => ({
    id: 'fixture-tool-' + index,
    scope: index === 6 ? 'personal' : 'org',
    ownerId: index === 6 ? person.id : null,
    title: index === 0 ? 'Ferramenta com título muito longo para conferir a composição responsiva' : index === 1 ? 'FerramentaSemEspacosParaTestarQuebraResponsivaSemLarguraMinimaImplicita' : 'Ferramenta de teste ' + (index + 1),
    category: index < 4 ? 'Categoria de teste com título extenso' : 'Outras ferramentas de teste',
    tags: ['etiqueta-de-teste', 'segunda-etiqueta'],
    orgAccount: index === 6 ? null : 'conta-de-teste-com-nome-extenso@example.test',
    url: 'https://tool-' + index + '.example.test', icon: null, order: index,
    roles: [roles[index % 2].id],
    views: index < 2 ? [{label: 'Visão de teste', url: 'https://tool-' + index + '.example.test/view', mode: 'window'}] : [],
    auth: null, active: true,
  }));
  const toolsState = {
    tools: entries.map((entry, index) => ({id: entry.id, title: entry.title, icon: null, digit: index + 1,
      openWindows: index === 2 || index === 3 ? 1 : 0, loading: index === 3,
      error: index === 4 ? 'Falha fictícia de carregamento' : null,
      login: index === 2 ? 'manual' : index === 4 ? 'failed' : null,
    })),
    tabs: [], active: null, mode: 'docked', tabHotkeys: false,
  };
  const host = {status: 'none', guild: null, address: null, fingerprint: null, lastSyncAt: null,
    lastError: null, pendingWrites: 0, updateRequired: false, minAppVersion: null, offlineSession: false};
  const appearance = {skin: test.skin, theme: test.theme, colors: {light: {}, dark: {}}};
  const info = {version: 'fixture', seedVersion: null, os: 'macos', appearance,
    gateOrigins: [], tray: false, biometricAvailable: false, systemPrompt: false, devRun: false};
  const profiles = {offline: {hasAccount: true, requiresInvite: false, email: person.email, seedImportable: false}, guilds: [], last: {kind: 'offline'}, biometric: false};
  const people = [
    {id: person.id, name: longName, roles: [roles[0].id], kind: 'member', admin: true},
    {id: 'fixture-person-2', name: 'Segunda pessoa de teste com nome extenso', roles: [roles[1].id], kind: 'member', admin: false},
  ];
  const reads = {
    'session.state': session,
    'nod.info': info,
    'tools.state': toolsState,
    'catalog.list': entries,
    'host.state': host,
    'favorites.list': [entries[0].id],
    'session.profiles': profiles,
    'sidebar.layout': {nodes: entries.map(entry => ({kind: 'tool', id: entry.id}))},
    'roles.list': roles,
    'roster.list': people,
    'nod.appIcon': {choice: 'default', guildIconAvailable: false},
  };
  const listeners = new Map();
  window.tiny = {
    api: {
      async call(method, params) {
        window.__fixtureCalls.push({method, params});
        if (Object.hasOwn(reads, method)) return structuredClone(reads[method]);
        // No navigation, mutation or native operation is allowed in this layout fixture.
        window.__fixtureUnexpected.push(method);
        throw new Error('Unexpected fixture API call: ' + method);
      },
      on(event, listener) {
        const group = listeners.get(event) || new Set();
        group.add(listener);
        listeners.set(event, group);
        return () => group.delete(listener);
      },
    },
  };
  window.__fixtureExpected = {entryCount: entries.length, roleCount: roles.length};
})();
