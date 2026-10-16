---
id: B01
frente: bond
titulo: módulos puros (shared/), repositório SQLite e páginas do frontend
status: fechada
tipo: cobertura
origem: derivado
bloqueada_por: —
destino: —
aberta_em: 2026-10-15
---

Autoriza tocar código no repositório `Bond/` para as fatias de `docs/arquitetura.md` §3 (`shared/`),
§4 `backend/sqlite.ts` e `backend/repo.ts`, e §5 (páginas). Requisitos: `docs/canonico.md` §14 —
RF-01 a RF-13, RF-19 a RF-29 na parte de lógica e de interface.

Cada fatia tem dono por arquivo declarado no despacho. Evidência de cada fatia:
`docs/handovers/<fatia>.md`.

## Fechamento

Fechada pelo dono em 2026-10-16 ("feche esse épico"). Evidência de execução: `bun test test/` 295 pass; `tsc` limpo nos dois projetos; `bun run app:build` falha sem o seed e gera o app com ele; smoke real `bun test/smoke/run.ts` 14/14. Pendências registradas no README (§ Pendências).
