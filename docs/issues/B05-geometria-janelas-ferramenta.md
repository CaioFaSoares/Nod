---
id: B05
frente: nod
titulo: janelas de ferramenta abrem com o tamanho e a posição da janela principal
status: aberta
tipo: bug
origem: derivado
bloqueada_por: —
destino: —
aberta_em: 2026-10-16
---

`docs/arquitetura.md` §4 (`backend/tool-windows.ts`) pede 1280×800 limitado a 90% da área útil da tela
da janela `main`, em cascata (+28 px), aplicando `setPosition`/`setSize` no handle logo depois do
`win.open`.

Observado por execução (2026-10-16, instância de captura com `copland.nod.ui`, bounds lidos
por `CGWindowListCopyWindowInfo`): `Nod`, `Kanban` e `Affine` com bounds idênticos —
`X 4853, Y -1350, 1235×1312` (segunda tela). As ferramentas funcionam, mas abrem exatamente por cima
da janela principal.

Causa não fechada. Próximo passo: trace com `TINYJS_DEBUG=1` **sem credenciais salvas** (o trace imprime
o EVAL do adaptador — `AGENTS.md`), conferindo se os comandos `SIZE`/`WINOP pos` saem para as janelas
`tool_*` e com quais valores.
