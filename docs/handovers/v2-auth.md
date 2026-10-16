# v2 — `shared/auth.ts` (reescrita em inglês)

Issue que autoriza: `docs/issues/B04-v2-janela-unica-e-ingles.md` (status `em-curso`).
Contrato: `docs/arquitetura.md` §3 (`shared/auth.ts`); requisitos `docs/canonico.md` §9, §11.

## Arquivos tocados

- `shared/auth.ts` (reescrito): a lógica da v1 passa a ter os nomes em inglês, nas assinaturas de
  `docs/arquitetura.md` §3 — `PBKDF2_ITERATIONS = 600_000`, `hashPassword(password, iterations?)`,
  `verifyPassword(password, h)` (comparação em tempo constante), `validateNewPassword(password)`
  (devolve `'password must be at least 8 characters'`), `generateInviteCode()` (32 bytes aleatórios,
  base64url sem padding), `hashInviteCode(code)` (SHA-256 em hex minúsculo),
  `inviteIsValid({ expiresAt, usedAt }, now)` e `unlockWait(failures)` (0 até 4 falhas; depois
  `1000·2^(n−5)`, teto de 15 min). Constantes internas renomeadas (`ALGORITHM`, `SALT_LENGTH`,
  `HASH_BITS`, `CODE_BYTES`, `WAIT_CAP_MS`, `FAILURES_WITHOUT_WAIT`) e helpers
  (`bytesToBinary`, `binaryToBytes`, `bytesToHex`, `derive`, `equalInConstantTime`). Só WebCrypto,
  `TextEncoder` e `btoa/atob`; `PasswordHash` importado como tipo de `shared/types.ts`. Nenhum
  `any`/`@ts-ignore`/`as`.
- `test/auth.test.ts` (reescrito): mesma cobertura da v1, em inglês — senha certa passa e erradas
  não; salts diferentes por hash; `algorithm`/`iterations`/salt de 16 B/64-hex de 32 B no
  `PasswordHash`; `iterations` muda o derivo; algoritmo desconhecido reprova sem derivar; hash
  truncado reprova; `validateNewPassword` (7, 8 e vazio); código de convite 43 chars base64url sem
  padding, dois consecutivos diferem; `hashInviteCode('abc') =
  ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`; `inviteIsValid` (expirado,
  exatamente no instante, usado antes de expirar, válido); `unlockWait` (0→0, 4→0, 5→1000, 6→2000,
  7→4000, 40→900_000, 41→900_000). PBKDF2 nos testes com `TEST_ITERATIONS = 1000` passado
  explicitamente.
- `docs/handovers/v2-auth.md` (este arquivo).

## Critério de aceite e como cada item foi atendido

Critério: "nenhum identificador ou mensagem em português nos dois arquivos".

| Item | Como foi atendido | Evidência |
| --- | --- | --- |
| Sem identificador pt-BR em `shared/auth.ts` | Todos os exports e constantes estão com os nomes de §3; os helpers internos também foram renomeados | `leitura` |
| Sem mensagem pt-BR em `shared/auth.ts` | `validateNewPassword` devolve só `'password must be at least 8 characters'` | `leitura` |
| Sem identificador pt-BR em `test/auth.test.ts` | Imports pelos nomes v2; nomes de `describe`/`test` e variáveis em inglês | `leitura` |
| Sem mensagem pt-BR no teste | Nenhuma string pt-BR; a única mensagem asserida é a do `validateNewPassword` | `leitura` |
| Mesmo comportamento provado da v1 | Cada teste da v1 tem correspondente 1:1; nenhum caso removido, nenhum caso novo que mude significado | `leitura` |
| Helpers de bytes aceitos pela TS 6 como `BufferSource` | `binaryToBytes` e `derive` devolvem `Uint8Array<ArrayBuffer>`; quem só lê bytes aceita `Uint8Array` | `leitura` |

Varredura de `leitura` com `grep` nos dois arquivos por
`senha|Senha|codigo|Codigo|convite|Convite|iteracoes|Iteracoes|falhas|espera|ESPERA|algoritmo|validar|verificar|gerar|hashSenha`:
nenhuma ocorrência. Segunda varredura por acentuadas e por `bytesToBase64Url` (helper removido):
nenhuma ocorrência — nenhuma referência pendente ao helper que foi embutido em `generateInviteCode`.

## Comando rodado e resultado observado

Nenhum. A fatia foi instruída a **não** rodar testes, typecheck, build, smoke, linter ou formatador;
toda a evidência acima é `leitura`. A verificação é do coordenador.

## O que ficou de fora e por quê

- **Consumidores fora desta fatia.** `backend/main.ts` e `backend/session.ts` ainda importam os nomes
  pt-BR de `shared/auth` (`conviteValido`, `gerarCodigoConvite`, `hashCodigo`, `verificarSenha`) e
  `test/sessao.test.ts` importa `hashCodigo`. Esses arquivos têm outros donos e não foram tocados;
  quem os reescreve na v2 deve importar `inviteIsValid`, `generateInviteCode`, `hashInviteCode` e
  `verifyPassword`. Nada mais bloqueia esta fatia.
- **Autorização da issue.** A reescrita para a v2 é a autorizada por
  `docs/issues/B04-v2-janela-unica-e-ingles.md`; nenhum arquivo fora dos três listados foi tocado.
- **Sem dependência nova, sem mudança de contrato.** Assinaturas idênticas às de
  `docs/arquitetura.md` §3; `shared/types.ts` não foi tocado.
