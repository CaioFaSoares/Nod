---
id: B03
frente: bond
titulo: smoke na superfície real e release privada com seed travado
status: fechada
tipo: cobertura
origem: derivado
bloqueada_por: —
destino: —
aberta_em: 2026-10-15
---

Autoriza `test/smoke/` e `docs/distribuicao.md`. Requisitos: `docs/canonico.md` §19, RF-14, RF-26,
RF-27. Evidência: `docs/handovers/<fatia>.md`.

## Fechamento

Fechada pelo dono em 2026-10-16 ("feche esse épico"). Evidência de execução: `bun test test/` 295 pass; `tsc` limpo nos dois projetos; `bun run app:build` falha sem o seed e gera o app com ele; smoke real `bun test/smoke/run.ts` 14/14. Pendências registradas no README (§ Pendências).
