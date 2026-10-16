# Bond

Casca de desktop, multiplataforma, que reúne as ferramentas internas da Copland
(`*.copland.studio` e afins) numa **janela principal única** — sidebar de ícones, Home, paleta de
comandos (`⌘K`) e Settings — e abre cada ferramenta na **janela própria** dela; catálogo cadastrado
pelo administrador, papéis e credenciais no chaveiro do sistema — uma senha local autentica a sessão
e pronto.

É um TypeScript fino sobre o [tinyjs](https://tinyjs.app) — backend em txiki.js, janela nativa de
webview do sistema, ~6 MB, sem Electron e sem servidor HTTP embutido.

## Estado

v2 entregue (épico B01–B04 fechado em 2026-10-16): janela única de gerenciar/usar, ferramentas em
janelas próprias, cascata de login, cofre no chaveiro, papéis e concessões, auditoria, release com seed
privado. App em inglês; docs de projeto em português. Leia `docs/canonico.md` e `docs/arquitetura.md`.

### Pendências

- Janelas de ferramenta abrem com o mesmo tamanho e posição da janela principal (medido: bounds
  idênticos); o tamanho próprio e a cascata de +28 px de `docs/arquitetura.md` §4 não estão sendo
  aplicados. Causa não fechada.
- Não exercitado de verdade: Windows, Linux, Touch ID, atalhos globais; Settings e paleta só por
  typecheck e build.
- Achados menores das revisões ainda abertos (persistir preferências, ações extras na paleta, etc.)
  em `docs/handovers/`.
- A faixa de implementação DeepSeek (`.omp/config.yml`) parou com 401 de chave inválida; trocar a
  chave antes de despachar subagentes de novo.

Distribuição: o dono manda releases privadas com as regras do sistema embutidas (seed fora do git) e,
depois, isso passa a ser validado online e a se atualizar sozinho — ver §19 do `canonico.md`.

## Como ler

| Documento | O que tem |
| --- | --- |
| `docs/canonico.md` | A base de requisitos: escopo, RF, RNF, modelo de dados, segurança, roadmap, registro de decisões, questões abertas. |
| `docs/tinyjs.md` | O que o runtime faz e o que ele proíbe, com fontes. É a casa dos fatos do runtime. |
| `docs/downscale-carna.md` | O que o Bond herda da Carna e o que fica de fora. |
| `CONTEXT.md` | Vocabulário. Termo novo só entra depois de leitura do dono. |
| `AGENTS.md` | Regras para agentes que trabalham aqui. |

## Ferramentas de hoje

Affine, Kanban (Planka), webmail, Discord e o que mais entrar — todas cadastradas como **dado**, não
como código. Ver `docs/canonico.md` §4.

## Como rodar

```
bun install
bun run app:dev         # dev (roda sem o seed privado)
bun test                # shared/, scripts/ e backend/
bun run typecheck       # tsc do frontend e do backend
bun run app:build       # release (exige resources/seed.json)
bun test/smoke/run.ts   # smoke na superfície real (abre o app)
```

O passo a passo de distribuição e liberação está em `docs/distribuicao.md`.
