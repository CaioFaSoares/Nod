# AGENTS.md — Nod

Antes de qualquer coisa, leia `docs/canonico.md`. Ele é a fonte única do escopo e dos requisitos.
Os fatos do runtime estão em `docs/electrobun.md`; o que veio da Carna, em `docs/downscale-carna.md`;
o vocabulário, em `CONTEXT.md`.

## O que é o Nod

Uma casca de desktop (TypeScript fino sobre Electrobun) que reúne as ferramentas internas de um time numa
janela de catálogo e em janelas de ferramenta, com papéis, concessões e credenciais no chaveiro do
sistema. É um downscale da Carna, não uma continuação dela.

## Onde cada coisa mora

| Assunto | Casa |
| --- | --- |
| Escopo, requisitos funcionais e não funcionais, modelo de dados, roadmap, registro de decisões, questões abertas | `docs/canonico.md` |
| Fatos e limites do runtime tinyjs | `docs/tinyjs.md` |
| O que foi herdado e abandonado da Carna | `docs/downscale-carna.md` |
| Vocabulário canônico | `CONTEXT.md` |
| Epics (what and why) and effort blocks with story points | `docs/epics/` (`blocks.md` for points and blocks) |
| Exact contracts: schemas, endpoints, payloads, key formats | `docs/specs/` |
| Role and rules of each part of the code | `context.md` in each folder: `host/`, `backend/`, `shared/`, `src/`, `test/` |
| Story issues for blocks 1–2 (status lives there, not in the docs) | GitHub issues of `CaioFaSoares/Nod`, milestones "Block 1" and "Block 2" |
| Código (quando existir) | raiz do projeto, conforme a fase do roadmap |
| Processo do dono (proposta, issue, frente) | `_research/_Guia/` do `_Aleph` (`/Users/caio/_Eclaire/_Workspace/Projects/_Aleph/`) — vale para trabalho lá dentro; aqui o registro é este repositório |

## Regras

- **Evidência.** Toda afirmação sobre o que existe carrega caminho ou URL; toda afirmação sobre o que
  funciona diz como foi obtida — `leitura` ou `execução`. Nada executado é chamado de verificado.
- **Um fato, uma casa.** Se já está escrito em outro arquivo, aponte o caminho. Não copie parágrafo.
- **Nada avança sem leitura do dono.** Decisão nasce `Proposto` ou `Aberto` no registro do
  `canonico.md`; só o dono muda para `Decidido`.
- **Estado é derivado, não declarado.** Nenhum arquivo lista o status de outro arquivo.
- **Um runtime.** Electrobun é a única superfície de desktop; tinyjs é histórico (`docs/tinyjs.md`).
  Ferramenta ausente vira bloqueio declarado, não uma segunda superfície de runtime.
- **Ferramenta é dado.** Endereço, produto, ícone e papéis das ferramentas são conteúdo do catálogo;
  o código não conhece o domínio do time nem nome de produto de terceiro.
- **O seed privado não entra no git.** Ele vive fora do repositório, é listado em `resources/` e vai
  embutido na release (§19 do `canonico.md`). No lugar dele, só `seed.example.json` com dados falsos.

## Não pode

- Escrever código de produto sem requisito aprovado no `canonico.md`.
- Marcar requisito como atendido sem prova na superfície real (o app rodando, a janela abrindo).
- Pôr segredo, token ou senha em arquivo, em log, em evento ou em `store.json`.
- Rodar um launch de desenvolvimento com credenciais reais e trace de runtime ligado: o trace
  pode imprimir o EVAL do adaptador de login (usuário e senha) e chamadas de API. Use contas,
  códigos e segredos descartáveis em `eb:dev` e nos smokes.
- Abrir ferramenta de terceiro em iframe dentro da casca. O gate de origin é fechado: uma view de
  ferramenta alcança `login.report` e nada mais; `main` só tem a API na origin do app. (A exceção da
  aba embutida, aberta em 2026-10-19, foi removida em 2026-10-22 com RF-69/RF-70.)
- Inventar endereço, produto ou capacidade das ferramentas internas que o dono não confirmou.
- Prometer comportamento que o runtime não documenta (`docs/electrobun.md` §7).
