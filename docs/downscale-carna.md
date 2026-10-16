# O corte da Carna

O Nod nasce como downscale da Carna. Este documento diz o que é herdado, o que é abandonado e por
quê. Nada aqui repete o `canonico.md`: aqui só mora a comparação.

Caminhos `Carna/…` e `_research/…` são relativos a `/Users/caio/_Eclaire/_Workspace/Projects/_Aleph/`.
Evidência obtida por `leitura` de código e de documentação.

## O que o Nod herda

| Peça | De onde | Por que serve |
| --- | --- | --- |
| Conceito de host e conta por host | `Carna/CONTEXT.md` §Host, §Conta por host; doc canônico, "Cliente inicial e hospedagem" e "Contas por host" | O Nod começa local e ganha um host depois; a conta por host evita migração quando o host chegar |
| Primeira conta é admin; demais exigem convite | `Carna/apps/api/lib/carna/accounts/changes/registration_rule.ex` | Resolve cadastro sem servidor de e-mail e sem tela de "criar o primeiro usuário" |
| Convite de uso único, hash SHA-256, TTL de 7 dias, código de 32 bytes url-safe | `Carna/apps/api/lib/carna/accounts/invite.ex` | Emissão de credencial pelo administrador, com o código em claro aparecendo uma vez só |
| Mensagem de erro única no login | `Carna/apps/api/lib/carna/accounts/graphql_errors.ex` | Não servir de oráculo de e-mail cadastrado |
| Token bearer com vida curta, linha revogável, expurgo | `Carna/apps/api/lib/carna/accounts/{user,token}.ex`, `Carna/apps/api/lib/carna/accounts/workers/purge_expired_tokens.ex` | Sessão do host sem inventar JWT novo |
| Rate limit por identidade e IP | `Carna/apps/api/lib/carna_web/rate_limit.ex` | Mesma defesa de força bruta, cabendo num nó só |
| CORS por origin exata, sem credenciais | `Carna/apps/api/lib/carna_web/endpoint.ex` | O cliente manda token em header, não cookie |
| Auditoria append-only com redação de segredo | `Carna/apps/api/lib/carna/trace/{redactor,handler}.ex`, `Carna/apps/api/lib/carna/system/span.ex` | O Nod reduz a um evento por ação, com a mesma regra: segredo nunca é parâmetro |
| Visibilidade por concessão, admin vê tudo | Doc canônico §Organização; `Carna/apps/api/lib/carna/system/span.ex` (policies) | Papel + concessão é a espinha da visibilidade, como a membership é a espinha lá |
| Contrato multi-host do cliente | `Carna/packages/client-core/src/{host,store,registry,session,links}.ts` | Reduz-se a: `HostId` normalizado, chaveiro por host, sessão por host, link `carna://<host>/p/<id>` |
| Regra de evidência e de um fato por casa | `Carna/AGENTS.md`; `_research/_Guia/convencoes.md` | Mesma disciplina de documento, sem tabela que declare status de outro arquivo |

## O que o Nod abandona

| Peça da Carna | Por que não entra |
| --- | --- |
| Elixir + Ash + Postgres + Oban como fundação do dia 0 | Não há servidor no v1: o banco é SQLite dentro do app; Ash/Oban/Postgres voltam só se o host existir (F5) |
| GraphQL do dia 0 | Sem host, a API é RPC interna do runtime; GraphQL entra com o host |
| Hocuspocus/Yjs, tiptap, Quickdraw, Dockview | O Nod não edita conteúdo nem compõe painéis; o runtime não tem abas (`docs/tinyjs.md` §3) |
| Base de conhecimento, busca híbrida, captura de links | Fora do escopo "casca de ferramentas" |
| Agentes, Jev, harness, rastros com span | Fora; a auditoria do Nod é um evento por ação, não telemetria |
| Cofre E2E com libsodium, `UserKeys/ProjectKey/KeyGrant/Secret` | O Nod não tem servidor que precise não ler: o segredo é do chaveiro do SO, por pessoa, e nunca sai da máquina |
| LiveKit, Phoenix Channels, Presence, ingest, object storage | Sem comunicação nem mídia próprias: quem tem chat é o Discord |
| Extensões (registro, manifesto, actor, WASM/Extism, iframes de terceiros) | O Nod cadastra endereços, não hospeda código de terceiros |
| Feederações entre hosts, `carna://` links, clientes iOS e de terminal | Um host, um cliente desktop; `nod://` é deep link local |
| Tauri | Trocado por tinyjs, que é o runtime pedido: TS fino, ~6 MB, mesma webview nativa |
| Casca web (Expo/Caddy) e monorepo de sete releases | O Nod é um app só; sem web própria, sem Docker no cliente |

## Vocabulário mapeado

| Carna | Nod | Nota |
| --- | --- | --- |
| Host | Host | Mesmo termo; hoje inexistente, a casca é a fonte |
| Tropa | — | O Nod não tem conceito de time: tem papéis |
| Conta por host | Conta | Uma por casca hoje, uma por host depois |
| Papel (`admin`/`member`) | Papel | O Nod precisa de papéis nomeados, não de um par fixo |
| Membership de projeto | Concessão papel↔ferramenta | Mesma função: é a espinha da visibilidade |
| Cofre (`Secret`, `SecretAccess`) | Cofre (ponteiro) + chaveiro | O valor sai do servidor e vai para o SO |
| Rastro (`Span`) | Evento | Um por ação, local, exportável |
| Extensão com grants | Entrada do catálogo | Dado, não código |
| Abas/splits (Dockview) | Rail + palco (janela de ferramenta) + vista | O runtime não tem abas: a troca é mostrar/esconder janela carregada |
| `client-core` multi-host | Backend do app | Só o necessário: catálogo, papéis, cofre, eventos |

## Observações da leitura

Coisas que a leitura revelou e que valem para o desenho do Nod:

- **Boa parte da Carna existe só no documento.** O sistema de extensões (`Extension`, `Grant`), o
  cofre cifrado, memberships e grants **não existem no código**: `apps/api/lib` hoje tem accounts,
  collab, trace e system. Ou seja, o "downscale" corta sobretudo documento, não implementação.
- **A API da Carna é pequena de verdade**: quatro mutations e três queries
  (`Carna/packages/graphql/schema.graphql`), `spans`, `invites`, `tokens`, `users`,
  `collab_snapshots` (`apps/api/priv/repo/migrations/`). É o tamanho de coisa que o host do Nod
  precisa ter.
- **Divergências a registrar**, não a corrigir por conta própria: o `FRENTE.md` da frente carna
  aponta a A003 em `_proposto/`, mas o arquivo está em `decisoes/`; e o `compose.yaml` tem uma rede
  só, enquanto o doc canônico prevê duas. Nenhuma das duas afeta o Nod.
- **AAC/M4A, Web Audio e codecs** são o tipo de armadilha que o Nod não encosta: sem áudio próprio,
  nada disso importa.
