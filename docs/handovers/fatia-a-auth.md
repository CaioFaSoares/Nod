# Fatia A — `shared/auth.ts`

Issue que autoriza: `docs/issues/B01-modulos-puros-e-frontend.md` (status `em-curso`).
Contrato: `docs/arquitetura.md` §3 (`shared/auth.ts`); requisitos `docs/canonico.md` §9, §11.

## Arquivos tocados

- `shared/auth.ts` (criado): `PBKDF2_ITERACOES = 600_000`; `hashSenha`, `verificarSenha`,
  `validarSenhaNova`, `gerarCodigoConvite`, `hashCodigo`, `conviteValido`, `esperaDesbloqueio`, nas
  assinaturas de `docs/arquitetura.md` §3. Só WebCrypto (`crypto.subtle`, `crypto.getRandomValues`),
  `TextEncoder`, `btoa/atob`; `SenhaHash` importado como tipo de `shared/types.ts`. Helpers de base64 e
  o comparador de tempo constante são locais e não exportados.
- `test/auth.test.ts` (criado): testes de `bun test` para os itens do critério, com `ITERACOES_TESTE =
  1000` passadas explicitamente.
- `docs/handovers/fatia-a-auth.md` (este arquivo).

## Critério de aceite e como foi atendido

Evidência deste handover: `leitura`. Não executei `bun test` nem typecheck (contrato do despacho:
só editar; o coordenador verifica no fim da fase). Abaixo, o item do critério e o ponto do código /
teste que o cobre.

| Item do critério | Onde é atendido |
| --- | --- |
| hash e verify da mesma senha → true | `verificarSenha` re-deriva com `salt`/`iteracoes` do `SenhaHash` e compara; teste "a senha correta passa e a errada não" |
| senha errada → false | idem; mesmo teste cobre sufixo, outra senha e vazia |
| salt de dois hashes da mesma senha difere | `hashSenha` sorteia 16 bytes por chamada; teste "dois hashes da mesma senha usam salts diferentes" |
| `verificarSenha` com `algoritmo` alterado → false | guarda `if (h.algoritmo !== ALGORITMO) return false`; teste "algoritmo diferente do esperado reprova sem derivar" |
| `validarSenhaNova('1234567')` → mensagem | `< 8` devolve `'a senha precisa de pelo menos 8 caracteres'`; testes de 7, 8 e vazio |
| `validarSenhaNova('12345678')` → null | idem, teste "oito caracteres é aceito" |
| código de convite casa `^[A-Za-z0-9_-]{43}$` | `gerarCodigoConvite` = 32 bytes aleatórios em base64url sem padding (`+`→`-`, `/`→`_`, sem `=`); teste de forma |
| dois códigos diferem | aleatoriedade de 32 bytes; teste "dois códigos consecutivos diferem" |
| `hashCodigo('abc')` = `ba7816bf…f20015ad` | SHA-256 UTF-8 em hex minúsculo; teste de valor exato e forma `^[0-9a-f]{64}$` |
| `conviteValido`: expirado → false | `new Date(expira_em) > agora` estrito; testes de expirado e de instante exato |
| `conviteValido`: usado → false | `usado_em === null` na conjunção; teste "usado reprova, mesmo antes de expirar" |
| `conviteValido`: válido → true | datas fixas, sem relógio real; teste "não usado e dentro da validade passa" |
| `esperaDesbloqueio`: 4 → 0; 5 → 1000; 6 → 2000; 40 → 900000 | `0` até 4 falhas, depois `1000 * 2 ** (falhas - 5)` com teto `15 * 60 * 1000`; testes de 0, 4, 5, 6, 7, 40 e 41 |

Fronteiras extras cobertas: comparação em tempo constante com hash de outro tamanho reprova;
mudar `iteracoes` do `SenhaHash` invalida a senha; `atob(h.salt).length === 16` e
`atob(h.hash).length === 32`.

## Comando e resultado

Nenhum. Não rodei `bun test`, typecheck, linter nem formatador, conforme o contrato do despacho
("NÃO rode testes, typecheck, linter nem formatador. Só edite."). Evidência desta fatia é `leitura`.

Comando que o coordenador deve rodar no fim da fase: `bun test test/auth.test.ts`.

## O que ficou de fora

- Testes que exercitam a superfície real (o app rodando) não são desta fatia; `shared/` é lógica pura.
- O bloqueio por falhas seguidas com estado persistido (contador na sessão) é do backend/repo, não de
  `shared/auth.ts`; aqui só a função pura de espera.
- Não há desvio de contrato nem dependência nova.

## O que outro dono precisa fazer

Nada bloqueia esta fatia. Quem consome `shared/auth.ts` (`backend/repo.ts`, sessão, admin) usa as
assinaturas de `docs/arquitetura.md` §3 sem alteração.
