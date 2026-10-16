# tinyjs — o que o runtime faz, e o que ele proíbe

Levantamento do runtime sobre o qual a casca do Bond é construída. Só fatos verificáveis: cada
afirmação diz de onde veio. Nenhum item foi obtido por execução; tudo é `leitura`.

Este arquivo é a casa dos fatos do runtime. O `canonico.md` aponta para cá e não repete nada.

## Método e fontes

| Fonte | O que é |
| --- | --- |
| `https://tinyjs.app/docs.html` | Documentação completa, lida inteira (~1524 linhas). |
| `https://tinyjs.app/api-map.html` | Mapa `app` (backend) ↔ `tiny` (página), gerado do `tiny.d.ts`. |
| `https://tinyjs.app/changelog.html` | Histórico de releases; diz quando cada capacidade entrou. |
| `tarwin/tinyjsapp:README.md` | README do runtime (portabilidade, empacotamento, wire protocol). |
| `tarwin/tinyjsapp:template/types/tiny.d.ts` | Definições TypeScript ambientes — fonte autoritativa da API. |
| `tarwin/tinyjsapp-examples:trolley/.claude/skills/tinyjs/references/{api,recipes,platforms,release}.md` | Referências destiladas dos apps de exemplo do próprio autor. |

Versão observada nas fontes: `0.57.x`. O tiny.d.ts não vive em `types/tiny.d.ts` na raiz (404); o
caminho real é `template/types/tiny.d.ts`.

## 1. O que o runtime é

- Um app é **um processo backend em txiki.js (QuickJS)** mais **uma janela nativa** de webview do
  sistema: WKWebView no macOS, WebView2 no Windows, WebKitGTK 4.1 no Linux
  (`tinyjs.app/docs.html`; `README.md` §Portability).
- **Não há servidor HTTP nem porta.** Página e backend falam por RPC em socket Unix (named pipe no
  Windows), protocolo de texto delimitado por linha com payload JSON (`README.md`, "Wire protocol").
- Tamanho empacotado ~6 MB: `bin/tjs` 5,6 MB + launcher 1–2 MB (`README.md`).
- Requisitos por OS: macOS 15+; Windows 10/11 com WebView2; Linux glibc 2.35+ com `webkit2gtk-4.1`
  (X11 ou Wayland) (`README.md`; `docs.html` §install).
- O backend tem acesso total ao sistema (fs, sockets, processos, FFI). A página **não** tem `tjs`
  global e não pode importar `tjs:*` — importar lança `ReferenceError: tjs is not defined`
  (`docs.html` §SQLite; advertência repetida em `recipes.md`).
- Dados que o próprio código lê em runtime vão numa pasta `resources/`; a release empacota a pasta
  inteira e `(await app.paths()).resources` aponta para ela — a mesma pasta em dev e no build.
  Programas que o backend dispara vão em `executables/`, e o que o sistema operacional lê (ícone,
  créditos, ajuda) em `assets/` (`docs.html` §Bundled data resources; `README.md`).
- **Caminho listado que falta falha o build**: `resources/` (ou a lista `"resources": [...]` no
  `tinyjs.json`) com arquivo ausente, caminho absoluto, `..` ou symlink **falha o build**
  (`docs.html` §Bundled data resources; `README.md`). É um portão de build de graça.
- Dados de dados/consulta ficam no SQLite do backend (`tjs:sqlite`, totalmente síncrono); o
  `tjs.*` de fs é assíncrono (`docs.html` §Store/secrets/sqlite).

## 2. Encapsular um site hospedado

- `"url": "https://app.example.com"` no `tinyjs.json` faz **a janela principal ser a página
  remota**, sem frontend local (`docs.html` §wrapping a hosted site; changelog 0.38.0).
- `tinyjs wrap <url>` gera o esqueleto desse wrapper e aplica o preset `"api": "wrapper"`
  (changelog 0.44.0).
- O objeto `tiny` é injetado em **toda origin**. O gate é imposto **no backend** e usa a origin do
  frame como o motor a reporta, não como a página declara: `"api": "wrapper"`, `{ "disable": [...],
  "enable": [...] }` (enable vence disable), ou `{ "origins": { "<origin>": [...] } }` com `"all"` /
  `"none"`. Com `origins` presente, uma origin que não casa nenhuma chave não ganha nada — inclusive
  as páginas do próprio app, que precisam de uma chave `"file://*"` (`docs.html` §pattern rules;
  `recipes.md` §"Wrapping a hosted web app").
- Padrões de método aceitam `*` e `prefix.*`. A chave de origem deve casar
  `scheme://host[:port]` inteiro; `*` casa pontos, e uma chave que termina em `*` depois do host
  vaza para domínios maliciosos (`docs.html` §pattern rules).
- `"userAgent"` substitui o UA do webview — necessário porque o UA padrão não traz
  `Version/x Safari/x` e sites que farejam UA rejeitam. Também é lido por `tiny.system.os()`, então
  cada bloco de OS precisa do UA correspondente (`docs.html`; `README.md`). Aviso do autor: muitos
  SaaS detectam webview embutida e recusam de qualquer forma.
- `"inject": "src/shim.js"` injeta um script **document-start em toda página, de qualquer origin**
  (`.ts` é empacotado por esbuild). É o gancho para preparar um site de terceiros antes do boot
  (`docs.html` §tinyjs.json; `README.md`).
- `"downloads": "auto" | "ask" | "deny"` e `"popups": "external" | "window" | "deny"`
  (`docs.html` §tinyjs.json).
- Diálogos nativos de `alert/confirm/prompt` ganham painel do sistema com a origin no título;
  `window.open`/`target=_blank` seguem `"popups"`; `tiny.win.find()` faz o ⌘F (`recipes.md`).
- Navegação: o backend exporta `onNavigate(info, app)` com `kind: 'policy' | 'start' | 'commit' |
  'finish' | 'fail' | 'crash'`. No `policy`, responder `'deny'` ou `'external'` (manda ao navegador
  real) antes de a navegação rodar. Resposta mais lenta que ~400 ms **permite** (`docs.html`).
  Caveats: no Linux a pergunta acontece na decisão de resposta, então uma navegação negada **já fez
  a requisição**; no Windows um POST main-frame que passou pelo policy é reemitido como GET
  (`platforms.md`).
- **Empacotar o site remoto para uso offline não é suportado.** `frontend.devUrl` é dev-only, e um
  app empacotado assim "has no page at all" (`docs.html`). Não há service worker, cache offline nem
  preload documentados.

## 3. Janelas e abas

- `win.open(id, opts)` aceita: `page`, `title`, `size` (`'WxH'` = caixa da página), `minSize`,
  `chrome`, `x`, `y`, `parent` (`true` = main, ou id de janela). `chrome`, `x`, `y` e `minSize` são
  aplicados **antes do primeiro paint** (`docs.html` §windows).
- **Não existe campo `url` em `win.open`; o campo é `page`.** Do lado da página, `page` deve ser uma
  URL `http(s)` ou um arquivo dentro do diretório do frontend; `..`, caminhos absolutos, UNC e
  `file:`/`javascript:` são recusados. **O backend (`app.win.open`) aceita qualquer caminho**
  (changelog 0.46.0; `docs.html`).
- **Não existem abas nativas.** O modelo é multi-janela. Qualquer "aba" é implementada em HTML
  dentro de uma página (`docs.html`; `api-map.html` — nenhuma menção a abas).
- Cada janela tem sua própria ponte completa (`win.*` mira a própria janela); no Windows, cada
  janela recebe WebView2 própria (`README.md`).
- **Não há isolamento de cookies/sessão por janela.** O que existe é **um perfil de browser por app
  id** (Windows: `%APPDATA%\<app-id>\WebView2`, changelog 0.45.0). Ou seja: duas contas da mesma
  ferramenta dentro do mesmo app compartilham cookies e `localStorage`.
- `win.getState()` devolve `{ x, y, width, height, outer, fullscreen, minimized, visible, focused,
  alwaysOnTop, resizable, screen, chrome, canPosition }` — `width/height` é a caixa da página,
  `outer` inclui decoração (`docs.html`; `tiny.d.ts`). `tiny.win.onState(cb)` avisa toda transição,
  com o id da janela; no Wayland nunca reporta `minimized` (`api.md`).
- `setChrome` também aceita `menu: false` (esconde a barra só naquela janela; no macOS a barra é
  única por app) e `data-tiny-drag` numa barra própria move a janela (`api.md`).
- `mainWindow: false` sobe o app sem janela nem webview (economia grande de memória ociosa), mas
  **não é combinável com `"url"`**, e `win.open('main')` lança erro nesse modo (`docs.html`;
  changelog 0.51.0/0.57.2).
- Aplicativos de bandeja: `tiny.tray.set({ title, icon: 'sf:…' | 'emoji:…' | png, menu,
  primaryAction })` + `"activation": "accessory"` (`recipes.md`).
- **Trocar de janela é barato e preserva a página.** `win.hide()` e `win.show({ activate: false })`
  existem para todos os lados; a janela escondida/ocluída é throttled (`rAF` para), mas o processo da
  página segue vivo, com a sessão e o estado. Custo do que fica vivo: ~50 MiB por janela no macOS
  (`recipes.md` §windowless; `api.md` §windows).
- `tiny.hotkey.register(id, combo)` / `unregister` registra atalho **global**, que dispara em
  qualquer app; itens de menu aceitam acelerador (`api-map.html`; `api.md` §windows). No Linux,
  `keystroke`/pasting por XTest é X11-only (`platforms.md`).
- `tiny.screens()` e `win.getState().screen` dão a geometria dos monitores, para posicionar e
  redimensionar janelas na área útil (`api.md` §windows).
- Janela ocluída ou escondida é **throttled** (`rAF` para): trabalho contínuo pertence ao backend,
  que nunca é throttled (`recipes.md` §desktop pet).

## 4. Injeção e controle da página

- Backend: `app.eval(js)` (janela principal) e `app.window(id).eval(js)`, mais
  `app.window(id).push/close/setTitle/…` e `app.push(event, data)` que transmite a **todas** as
  janelas (`api-map.html` §Windows; `tiny.d.ts` §`TinyWindowHandle`).
- Página: `tiny.api.call(method, params)` e `tiny.api.on(event, fn)`. Handlers do backend recebem
  `(params, app, meta)`, com `meta.window` (id da janela chamadora) e `meta.origin` (a origin real
  do frame, carimbada pelo launcher) (`docs.html`; `tiny.d.ts` §`TinyApiMeta`).
- Preenchimento/controle de login em página de terceiros: dois caminhos documentados — o `"inject"`
  document-start (roda com privilégios da página, todas as origins) e `app.eval`/`window(id).eval`
  em runtime. Não existe hook por-navegação no lado da página além dos eventos
  (`docs.html`; `api-map.html`).
- Não há IPC página↔página além do broadcast `app.push` e dos eventos (`api-map.html`).

## 5. Credenciais e armazenamento

- `app.secrets.set/get/delete` grava no **keychain do sistema**: macOS Keychain, Windows Credential
  Manager, Linux Secret Service. O valor é **somente string**; `get` devolve `string | null`
  (`docs.html` §secrets & auth; `tiny.d.ts` §`TinySecrets`).
- A ACL do keychain do macOS nomeia o **binário** que gravou: um segredo salvo por `tinyjs dev` faz
  o app construído pedir permissão uma vez, e reassinar o app pede de novo (`docs.html`).
- `tiny.store.*` é um `store.json` **em texto plano** no diretório de dados por app
  (`~/Library/Application Support/<id>` no macOS, `%APPDATA%\<id>` no Windows,
  `~/.local/share/<id>` no Linux). A própria doc diz para **nunca** pôr token ali (`docs.html`).
- Não há limite de tamanho documentado para `secrets` nem para `store`.
- **Primitivas de criptografia nativas, lidas no código do runtime** (evidência: `leitura` de
  `saghul/txiki.js`, branch `master`, não execução): PBKDF2 existe como operação nativa
  (`src/js/polyfills/crypto/kdf.js`, `nativePbkdf2`), Ed25519 também (`…/ed.js`,
  `nativeEd25519GenerateKey/Sign/Verify`), ao lado de AES (`…/aes.js`), digest, HMAC, X25519, RSA e
  EC; `src/webcrypto.c` é o encaminhamento nativo e `src/js/polyfills/crypto/subtle.js` expõe o
  `subtle`. Ou seja: derivar chave de senha e assinar um documento não exigem dependência externa.
  O comportamento exato (parâmetros aceitos, custo) ainda não foi medido por execução.

## 6. Permissões e capacidades

- `"permissions": { "microphone": "porquê", "camera": "porquê", "speechRecognition": "porquê" }` —
  as strings viram o texto do diálogo do sistema; no macOS, capturar sem elas mata o app; no Linux,
  o manifesto **é** o gate (`docs.html`; `platforms.md`).
- `app.permissions.check/request` com `accessibility | screen | notifications | microphone | camera |
  automation[:<bundle-id>]` devolvendo `granted | denied | undetermined | unsupported`
  (`docs.html`).
- Mic/câmera só são concedidos sem prompt às páginas do próprio app; uma origin externa precisa de
  uma chave em `api.origins` que permita `media.*` (`docs.html`).
- `tiny.fetch` roda **no backend**: sem CORS, sem CSP, sem limite de mixed content, com
  `{ stream: true }`; certos casos caem no `curl` do sistema (`docs.html`).
- `tiny.system.capabilities()` lista **apenas as exceções** — testar `caps.x !== false`, nunca
  `if (caps.x)`. Chamadas que não existem: fire-and-forget vira no-op, consulta resolve `null`,
  capacidade rejeita com o motivo (`platforms.md`).
- `tiny.system.requirements/missing/promptMissing` transforma peça faltante do sistema (codecs,
  speech, tray) em prompt instalável (`docs.html`).

## 7. TypeScript, frontend e backend

- Backend em `.ts` é empacotado com esbuild automaticamente, e isso libera pacotes npm no backend
  (`README.md`; `docs.html` §tinyjs.json). O mesmo vale para o `"inject"`.
- `tinyjs new <dir> --template react-ts|vue-ts|svelte-ts|solid-ts|preact-ts|lit-ts|alpine-ts|vanilla-ts`
  monta Vite com HMR dentro da janela nativa (`README.md`).
- `template/types/tiny.d.ts` traz definições completas e **ambientais** (`declare const tiny: Tiny`,
  `interface Window { tiny: Tiny }`), e o `tiny` é injetado em toda página sem script tag
  (`README.md`; `tiny.d.ts`).
- Modelo mental: **backend = dados e sistema; página = visão**. O app de exemplo `trolley` mantém
  tudo em SQLite no backend e a página só chama a API (`tinyjsapp-examples:trolley/backend/main.ts`).

## 8. Distribuição e atualização

- `tinyjs build`: no macOS gera binário + `.app` codesigned (`--dmg` para o instalador,
  `--arch`/`--universal` para CPUs); no Windows/Linux gera uma pasta `dist/` portátil
  (`docs.html` §cli; `README.md`).
- `tinyjs publish` gera zip + `manifest.json` com versão, url, **sha256** e notas; `"update": { "url",
  "auto": "launch" | "daily" }` liga o auto-update. `app.update.check()` devolve
  `{ available, current, latest, notes }`; `app.update.install()` baixa, **verifica sha256 e
  assinatura**, troca o `.app` e reinicia (`README.md`; `docs.html` §auto-update).
- `"urlScheme"` e `"fileExtensions"` dão deep links e associação de arquivos, com instância única
  automática; a segunda execução entrega o argv para a primeira (`docs.html`; `api.md`).
- Assinatura: o padrão é **ad-hoc**, que só roda na máquina de quem construiu. Em outras máquinas o
  Gatekeeper bloqueia e a pessoa precisa de "Open Anyway" (no macOS 15+ o truque do right-click não
  funciona mais) ou `xattr -d com.apple.quarantine`. Distribuição sem atrito exige **Developer ID
  Application + notarização**, ambos do Apple Developer Program (US$ 99/ano); um certificado "Apple
  Development" de Apple ID grátis só vale nos dispositivos registrados (`README.md`).
- **Assinatura no Windows não é documentada** em nenhuma das fontes.

## 9. Segurança

- O **backend não é sandboxed**; a página roda como documento `file://` com leitura restrita ao
  diretório do frontend (ou ao que `readAccess` liberar).
- O gate `"api"` é o único controle de o que uma origin externa pode chamar. Sem ele, o JavaScript
  do site encapsulado fala com um backend com acesso total a fs e processos — pior que Electron. A
  doc chama o preset `"api": "wrapper"` de mínimo aceitável (`docs.html`; `recipes.md`).
- Com `origins` presente, origin não listada herda **nada** — um redirect para domínio fora da lista
  não herda acesso (`recipes.md`).
- No Linux o carimbo de origin é frame-blind (o shim só injeta no top frame): a doc diz para não
  encapsular site que embute iframes não confiáveis confiando só em `api.origins` (`platforms.md`).
- `proxyURL` e `printToPDF` são restritos por origin (`docs.html`; changelog 0.47.0/0.48.0).
- Não existe `SECURITY.md` no repositório; a postura de segurança está no changelog.

## 10. Constraints duros

1. **Sem servidor HTTP.** Nada de hospedar endpoint dentro do app: um backend Elixir só entra como
   serviço externo consumido pelo **backend** do app (via `fetch`/`tiny.fetch`).
2. **A página não tem sistema.** Sem `tjs`, sem SQLite, sem spawn, sem FFI, sem disco arbitrário:
   tudo passa por RPC `api`.
3. **Sem isolamento de sessão por janela.** Um app = um perfil (no Windows, documentado). Duas
   identidades da mesma ferramenta no mesmo app compartilham cookies.
4. **Site remoto não é empacotável offline.** `"url"` exige a rede; não há service worker nem cache.
5. **`win.open` não tem `url`**, só `page` (http(s) da página; caminho absoluto do backend).
6. **Sem abas nativas.** Agrupar conteúdo é multi-janela; "abas" são HTML.
7. **Distribuição limpa no macOS custa Developer ID + notarização** (US$ 99/ano); sem isso, atrito
   manual de quarentena. Windows: sem assinatura documentada.
8. **`app.secrets` só aceita string**; `store` é JSON em texto plano.
9. **A chave de `api.origins` deve ser a origin exata**; o preset e as listas top-level nunca
   concedem mic/câmera.
10. **`mainWindow: false` não combina com `"url"`**; `win.open('main')` lança nesse modo.
11. **Janela ocluída é throttled** — nada de processo contínuo na página.
12. **Fora do macOS, `tiny.macos.*` rejeita**; e uma lista de capacidades (`authenticate`,
    `system.locale`, `wifi`, `frontmostApp`, `share`, `pickColor`, `spotlight`, `audio.filters`)
    não existe em um ou outro OS (`platforms.md` §Not supported).

## 11. Não documentado (não presumir)

- Service worker / cache offline / preload para página remota.
- Isolamento de cookies, `localStorage` ou partição **por janela**.
- Abas nativas no chrome do app.
- Assinatura de código no Windows (Authenticode/signtool/SmartScreen).
- Limites de tamanho de `secrets` e `store`.
- IPC direto janela↔janela além do broadcast `app.push`.
- Política formal de segurança (`SECURITY.md`).
