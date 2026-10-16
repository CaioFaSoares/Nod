# v2 — `shared/probe.ts` e `shared/vault-export.ts` (reescrita em inglês + correção P1)

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (status `em-curso`).
Contrato: `docs/arquitetura.md` §3 (`shared/probe.ts`, `shared/vault-export.ts`); requisitos
`docs/canonico.md` §8, §11 (RF-28, RF-29). Achado de segurança corrigido: **P1** (regex quadráticas
da v1). Contexto do dono sobre a v2: `docs/arquitetura.md` (cabeçalho) e `CONTEXT.md`.

## Arquivos tocados

- `shared/probe.ts` (criado): `analyzeHtml`, `detectProvider`, `isIdentityPath`, `cleanTitle`,
  `iconType`, com as assinaturas de §3 e os nomes em inglês. Só `URL`, `String`, `Array`, `Set`,
  `Map` e regexes ancoradas — sem DOM, sem `tiny`, sem `tjs`. `RawIcon` importado como tipo de
  `./types` (import sem extensão).
  - **P1**: só os primeiros 256 KiB (`html.slice(0, 262144)`) e nenhuma regex sobre o documento. A
    varredura é linear: `indexOf('<')` acha o próximo `<`, o cursor anda um caractere, o nome da tag
    é lido com um teto de 16 caracteres (`NAME_CHAR`), e **cada tag fechada move o cursor para depois
    do seu `>`** — logo as buscas de `>` e as leituras de atributos nunca se sobrepõem. Quem não tem
    `>` nenhum custa exatamente uma passada. A busca de `</title>` acontece **uma vez só**
    (`titleSearched`), senão `'<title>'.repeat(n)` voltaria a ser quadrático.
  - Atributos de uma tag (o texto entre `<` e `>`): laço que sempre avança — nome, `=`, valor com
    aspas (`"`/`'`) ou sem aspas —, primeira ocorrência de um nome vence, atributo sem `=` é
    ignorado (o mesmo que a regex da v1 lia). Nada de `[^>]*` nem de retrocesso.
  - Mesmas saídas da v1 no resto: decodificação de entidades (`&amp;` por último) + `cleanTitle`;
    ordem de ícones apple-touch-icon → `<link rel~=icon>` (png/svg antes) → `og:image` →
    `/favicon.ico`; absolutos e sem repetição; `hasLoginForm` = um `<input` cujo `type` é
    `password`, com qualquer aspas/caixa; `detectProvider` com URL inválida → `null`.
- `shared/vault-export.ts` (criado): `exportVault`/`importVault` sobre `VaultExportItem`
  (`toolId, label, username, secret`). `iterations` padrão vem de `PBKDF2_ITERATIONS` importado de
  `./auth` (um fato, uma casa — não há segundo `600_000` no repositório). No import, `iter` só passa
  com inteiro em `[1_000, 10_000_000]` **antes** de qualquer derivação; qualquer outra falha
  (base64, JSON, `v`, `alg`, campos, derivação, decifra, lista de itens) vira
  `'wrong password or invalid file'`, a mesma mensagem. Só WebCrypto, `TextEncoder/TextDecoder` e
  `btoa/atob`.
- `test/probe.test.ts` (criado): as fixtures da v1 em inglês, a guarda de ReDoS medida com
  `performance.now()`, a fronteira dos 256 KiB, `isIdentityPath` e `detectProvider`.
- `test/vault-export.test.ts` (criado): ida e volta com 1000 iterações, forma do envelope, salt/nonce
  novos por export, senha errada, lixo, `v: 2`, `alg` trocado, `ct` adulterado, item sem campo, e a
  cerca de `iter` (1e12 e 999 recusados **sem derivar**, medido; `iter` não inteiro; o piso aceito).
- `shared/sonda.ts`, `shared/exportar-cofre.ts`, `test/sonda.test.ts`, `test/exportar-cofre.test.ts`
  (apagados): são os arquivos da v1 que esta fatia substitui.
- `docs/handovers/v2-probe-export.md` (este arquivo).

Nenhum arquivo de outro dono foi tocado (`shared/types.ts`, `shared/auth.ts`, `src/api.ts`,
`docs/arquitetura.md`, `package.json` intactos). Nenhuma dependência nova.

## Critério de aceite e como cada item foi atendido

| Item do aceite | Como foi atendido | Evidência |
| --- | --- | --- |
| Fixtures da v1 em inglês (`'Tool A · Test'` → `'Tool A'`) | `test/probe.test.ts` › `cleanTitle` e `analyzeHtml` | `leitura` |
| Ordem dos ícones e detecção de formulário | Mesmas listas (apple → preferred → others → og → favicon) e mesma checagem de `type=password`; testes "reads title, icons in preference order and the password form", "an icon without type…", "apple-touch-icon comes before everything and duplicates are dropped", "og:image only counts with the exact property…" | `leitura` |
| HTML vazio → título nulo, só o favicon, sem formulário | Idêntico à v1 (`cleanTitle('') === ''` → `null`; `/favicon.ico` sempre resolvido) | `leitura` |
| Guarda de ReDoS com `performance.now()` < 200 ms | `test/probe.test.ts` › `describe('analyzeHtml — ReDoS guard')`: `'<title>'.repeat(300_000)` e `'<link '.repeat(300_000)`, os dois com `expect(elapsed).toBeLessThan(200)` **e** o resultado esperado (`title: null`, só o favicon, sem formulário) | `leitura` |
| Fronteira dos 256 KiB | Teste "reads only the first 256 KiB": 262 144 caracteres de enchimento antes do `<title>`/`<input>` → título nulo, sem formulário | `leitura` |
| `isIdentityPath`: `/realms/x/protocol/openid-connect/auth` true, `/boards/1` false | `isIdentityPath` monta `new URL(url)` e testa o `pathname` contra `/(oauth2?\|oidc\|openid\|authorize\|realms\/\|\/sso\b\|saml)/i`; URL inválida → `false` | `leitura` |
| Ida e volta com 1000 iterações | `test/vault-export.test.ts` › "a round trip returns exactly the same items" e "the floor itself is accepted" (1000 passado explicitamente) | `leitura` |
| Senha errada e lixo → mensagem exata | "the wrong password throws the single message" e "a blob that is not base64/JSON throws the same message" (`'wrong password or invalid file'`) | `leitura` |
| Blob com `iter: 1e12` → mensagem exata sem derivar | "iter above the ceiling is refused without deriving": `iter` é conferido antes do `deriveKey`, e o teste mede o tempo (< 200 ms; 1e12 rodadas de PBKDF2 não terminariam) | `leitura` |
| `iter` padrão = `PBKDF2_ITERATIONS` de `shared/auth` | `exportVault(..., iterations: number = PBKDF2_ITERATIONS)` com `import { PBKDF2_ITERATIONS } from './auth'` | `leitura` |

## Comando rodado e resultado observado

Nenhum. A fatia foi instruída a **não** rodar testes, typecheck, build, smoke, linter ou formatador;
toda a evidência é `leitura` (contrato da fase). A verificação é do coordenador: `bun test test/`,
`bunx tsc -p tsconfig.json`.

## Desvios do contrato (para o coordenador confirmar)

1. **Nome da tag tem de bater inteiro.** A v1 usava `/<title[^>]*>…<\/title>/i`, que aceitaria
   `<titlex>` como `<title>`; aqui o nome lido é comparado a `title`/`link`/`meta`/`input`. `<linkx`,
   `<link-foo>` e afins deixam de casar (a v1 casaria `<link-foo>` por causa do `\b`). HTML real não
   tem esses casos; a checagem estrita é a que o contrato pede ("varredura linear").
2. **`</title>` exato**, como na v1 (`</title >` não fecha) — a v1 pedia a string literal, então o
   comportamento ficou idêntico.
3. **Tabelas de ícone com `Object.hasOwn`** (`ICON_TYPE_BY_CONTENT_TYPE`, `ICON_TYPE_BY_EXTENSION`).
   A v1 fazia `POR_EXTENSAO[ext] ?? null`; com `Content-Type: constructor` ou href terminando em
   `.constructor` ela devolvia `Object` (do protótipo) em vez de `null`. Aqui devolve `null`, e há
   teste para isso ("an unknown content type is never taken from Object.prototype"). Fora desse
   caso, as saídas são as mesmas.
4. **`iter` também tem de ser inteiro** no import, além da faixa `[1_000, 10_000_000]`. Um `iter`
   fracionário não é um arquivo válido e a recusa sai antes da derivação.
5. **`alg` é conferido no import** (`e.alg !== ALGORITHM` → mesma mensagem). A v1 não conferia: um
   envelope com outro `alg` mas com o resto válido decifraria. A mensagem é a única já combinada.

## O que ficou de fora, e por quê

- **Rede, ícones e persistência da sonda** — `backend/probe-net.ts` (`fetch`, timeout, download do
  ícone em base64) e `repo.saveEntry(..., { probe })` são de outras fatias (§4); aqui só se lê o que
  voltou.
- **Chaveiro e o `export`/`import` do backend** — `backend/vault.ts` (`export(personId, password)`,
  `import(personId, blob, password)`) monta os `VaultExportItem[]` e grava os itens de volta; esta
  fatia entrega só o módulo puro que ele chama.
- **Achados A-numéricos das revisões de requisitos** — nada nesta fatia; o contrato dela é a
  reescrita em inglês + P1.
- **`store`, eventos, UI**: fora de `shared/`.

## Precisa de outro dono (dependência declarada)

- `backend/sonda-rede.ts` (v1) **importa `shared/sonda.ts`**, que esta fatia apagou; `backend/cofre.ts`
  (v1) importa `shared/exportar-cofre.ts`, também apagado; `backend/main.ts` (v1) importa
  `detectarProvedor` de `shared/sonda`. Até as fatias de backend da v2 apagarem esses arquivos e
  criarem `backend/probe-net.ts` / `backend/vault.ts` (§4), o typecheck do backend não fecha — é a
  ordem esperada do corte (os arquivos v1 desses donos já estão na lista de remoção de §1), mas fica
  registrado para o coordenador não ler esse erro como regressão desta fatia.
- Quem escrever `backend/probe-net.ts` usa `analyzeHtml(html, finalUrl)` → `{ title, icons,
  hasLoginForm }`, `detectProvider(origin, finalUrl)` e `iconType(url, contentType)` deste módulo.
