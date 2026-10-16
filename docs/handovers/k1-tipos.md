# Fatia K1 — tipos de `Uint8Array` (TypeScript 6) e `tjs:sqlite` declarado

Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md` (status `em-curso`), que autoriza
`shared/` (§3) e `backend/sqlite.ts` (§4). Contrato: `docs/arquitetura.md` §3, §4.
Despacho: correção K1 do coordenador (erros do `tsc` 6.0.3 instalado no projeto).

## Arquivos tocados

- `shared/auth.ts` (editado).
- `shared/exportar-cofre.ts` (editado).
- `backend/sqlite.ts` (editado).
- `docs/handovers/k1-tipos.md` (este arquivo).

Nenhum teste, `shared/types.ts`, `src/` ou `backend/tjs.d.ts` foi tocado. Nenhum arquivo novo além
deste handover.

## O que mudou

### A causa

O TypeScript 6 tipa o buffer do typed array: `Uint8Array` sozinho é `Uint8Array<ArrayBufferLike>` e
não é atribuível a `BufferSource` (que na lib é `ArrayBufferView<ArrayBuffer> | ArrayBuffer`). Os
três erros do despacho vinham todos de um parâmetro ou de um retorno declarado largo demais.

### `shared/auth.ts`

- `binarioParaBytes` (decodifica base64 em bytes) agora devolve `Uint8Array<ArrayBuffer>`. O corpo
  já era `new Uint8Array(texto.length)` — buffer próprio, sem `as`, sem cópia.
- `derivar` passou a receber `salt: Uint8Array<ArrayBuffer>` e a devolver
  `Promise<Uint8Array<ArrayBuffer>>` (o corpo é `new Uint8Array(bits)`, com `bits: ArrayBuffer` do
  `deriveBits`). Era o ponto do erro `auth.ts(58,40)`: o objeto
  `{ name: 'PBKDF2', …, salt, … }` exige `BufferSource`.
- Os produtores de bytes (`crypto.getRandomValues(new Uint8Array(16))` em `hashSenha`,
  `new Uint8Array(digest)` em `hashCodigo`, `TextEncoder().encode`) já eram `ArrayBuffer`-backed por
  inferência, então nenhum deles precisou de conversão.
- Os helpers que só **leem** bytes (`bytesParaBinario`, `bytesParaBase64Url`, `bytesParaHex`,
  `iguaisTempoConstante`) continuam aceitando `Uint8Array` qualquer: `Uint8Array<ArrayBuffer>` é
  atribuível a `Uint8Array<ArrayBufferLike>`, então nada mais apertado era necessário.
- Comentário curto na seção de base64 registrando a regra (produtor anota `Uint8Array<ArrayBuffer>`,
  leitor aceita `Uint8Array`), para o próximo a mexer não reabrir o mesmo erro.

### `shared/exportar-cofre.ts`

- `base64ParaBytes` devolve `Uint8Array<ArrayBuffer>` (corpo já era `new Uint8Array(binario.length)`).
  Isso cobre os três usos: `salt` de `chaveDeSenha`, `iv` de `decrypt` e o `data` (`e.ct`) de
  `decrypt` — era o erro `exportar-cofre.ts(106,26)` e o `iv` na mesma chamada.
- `chaveDeSenha` recebe `salt: Uint8Array<ArrayBuffer>` (assinatura quebrada em 4 linhas para caber a
  anotação). Era o erro `exportar-cofre.ts(32,23)`: `deriveKey` com `Pbkdf2Params`.
- `bytesParaBase64` continua aceitando `Uint8Array` qualquer (só lê).
- Nenhum cast novo, nenhum `as BufferSource`, nenhuma cópia: `getRandomValues` e
  `new Uint8Array(await crypto.subtle.encrypt(...))` já saem `ArrayBuffer`-backed.

### `backend/sqlite.ts`

- Removidos o `// @ts-ignore` da linha do import e os tipos locais `SqliteStatement`/`SqliteDatabase`
  (que existiam só para fixar a superfície real do runtime sem declaração de tipos).
- `import { Database } from 'tjs:sqlite'` agora usa a declaração de `backend/tjs.d.ts`
  (`declare module 'tjs:sqlite'` com `Database{exec,prepare,close}` e `Statement{run,all,finalize}`),
  sem silenciamento. O comentário de cabeçalho do arquivo foi reescrito para apontar para essa
  declaração.
- `abrirSqlite` deixou de fazer `new Database(caminho) as SqliteDatabase`: o `db` é o `Database`
  declarado. `exec`, `prepare(sql).all(...)` e `prepare(sql).run(...)` batem com a assinatura
  declarada; `SqlDb` continua satisfeito com a mesma forma de antes.
- Comportamento idêntico: mesmos PRAGMAs, mesma delegação `all`/`run` por `prepare(sql)`, mesma
  ausência de `await`.

## Admissão (por que esta correção não é fatia nova)

1. Está dentro do que a issue `em-curso` autoriza: `shared/auth.ts` e `shared/exportar-cofre.ts` são
   §3 de `docs/arquitetura.md`; `backend/sqlite.ts` é §4 e é citado na própria B01.
2. Corrige costura existente entre partes que já deveriam conversar (helpers de bytes ↔ WebCrypto;
   `sqlite.ts` ↔ declaração de `tjs:sqlite` em `tjs.d.ts`): nenhuma função nova, nenhum export novo.
3. Não tem resultado visível para quem usa o produto: as assinaturas públicas de
   `docs/arquitetura.md` §3/§4 seguem iguais e o byte produzido é o mesmo.
4. Arquivos sem outro escritor no momento da edição — os donos das fatias A/D/E já entregaram
   handover (`docs/handovers/fatia-a-auth.md`, `fatia-d-sonda-export.md`, `fatia-e-repo.md`).
5. Sem dependência nova, sem troca de runtime ou toolchain: só anotação de tipo e remoção de um
   silenciamento que a declaração passou a suprir.
6. Verificável por `tsc` focado (o próprio `bunx tsc -p tsconfig.json` do despacho, mais
   `tsc -p backend/tsconfig.json`, que cobre `sqlite.ts`).

## Critério → como foi atendido

| Critério do despacho | Como foi atendido |
| --- | --- |
| `shared/auth.ts(58,40)` TS2322 | `derivar` tipado `salt: Uint8Array<ArrayBuffer>`; `binarioParaBytes` devolve `Uint8Array<ArrayBuffer>`, então a chamada de `verificarSenha` também satisfaz o parâmetro |
| `shared/exportar-cofre.ts(32,23)` TS2769 | `chaveDeSenha` recebe `salt: Uint8Array<ArrayBuffer>`; chamadas (`getRandomValues`, `base64ParaBytes(e.salt)`) já produzem esse tipo |
| `shared/exportar-cofre.ts(106,26)` TS2322 | `base64ParaBytes` devolve `Uint8Array<ArrayBuffer>` — vale para `salt`, `iv` e o `data` do `decrypt` |
| Helpers produtores anotados como `Uint8Array<ArrayBuffer>` | `binarioParaBytes`, `base64ParaBytes`, `derivar` (retorno e `salt`) |
| Sem cast falso | nenhum `as BufferSource`, `as any`, `@ts-ignore` ou `@ts-expect-error` nos três arquivos. `leitura` pós-edição: busca por `ts-ignore\|ts-expect-error\|\bany\b\|BufferSource` nos três arquivos só casa o texto de dois comentários que explicam a regra de tipos (`shared/auth.ts:19`, `shared/exportar-cofre.ts:28`) — nenhuma ocorrência em código |
| `backend/sqlite.ts` sem `@ts-ignore` e sem tipo local | `import { Database } from 'tjs:sqlite'` direto da declaração de `tjs.d.ts`; `new Database(caminho)` sem cast |
| Comportamento idêntico | nenhuma expressão de runtime mudou: só anotações, um comentário e a remoção do cast/`@ts-ignore` do `sqlite.ts`; `new Uint8Array(n)` já era `ArrayBuffer`-backed antes e continua |
| Testes de `auth`/`exportar-cofre` válidos como estão | nenhum arquivo de `test/` foi tocado; `PBKDF2_ITERACOES`, base64url sem padding, base64 do `hash`/`salt`, hex do SHA-256 e o envelope do cofre (v/alg/iter/salt 16 B/nonce 12 B/ct) seguem produzidos pelo mesmo código |

Evidência desta fatia: **`leitura`**. Não rodei `tsc` nem testes (contrato do despacho: "NÃO rode
testes, typecheck, build, linter nem formatador. Só edite.").

## Comando e resultado

Nenhum comando de verificação foi executado por mim. O que o coordenador rodou e observou (base
desta correção):

```
$ bunx tsc -p tsconfig.json
shared/auth.ts(58,40): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BufferSource'.
shared/exportar-cofre.ts(32,23): error TS2769: No overload matches this call. (Uint8Array<ArrayBufferLike> → BufferSource no deriveKey)
shared/exportar-cofre.ts(106,26): error TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BufferSource'.
```

Comandos que o coordenador deve rodar no fim da fase:

```
bunx tsc -p tsconfig.json            # os três erros acima não devem reaparecer
bunx tsc -p backend/tsconfig.json    # cobre backend/sqlite.ts (sem @ts-ignore)
bun test test/auth.test.ts test/exportar-cofre.test.ts
```

## O que ficou de fora

- Não mexi em `src/` nem nos demais arquivos de `backend/`: os erros do despacho eram só destes três
  arquivos, e cada arquivo tem um dono.
- Não "arrumei" preventivamente outros `Uint8Array` do repositório: a regra só é necessária onde o
  valor cruza a fronteira da WebCrypto como `BufferSource`; ampliar isso seria fora do despacho.
- Não toquei em `backend/tjs.d.ts` (é de outro dono) nem na declaração de `tjs:sqlite`: assumi a
  declaração como está, que é o que o despacho informa.
- Não apaguei a menção histórica ao `@ts-ignore` em `docs/handovers/fatia-e-repo.md` (registro de
  outra fatia; handover não se reescreve).
