---
id: B02
frente: bond
titulo: integração do backend tinyjs (sessão, cofre, palcos, adaptador, sonda, seed, main)
status: fechada
tipo: cobertura
origem: derivado
bloqueada_por: —
destino: —
aberta_em: 2026-10-15
---

Autoriza tocar código no repositório `Bond/` para as fatias de `docs/arquitetura.md` §4
(`backend/sessao.ts`, `backend/cofre.ts`, `backend/palcos.ts`, `backend/adaptador.ts`,
`backend/sonda-rede.ts`, `backend/seed.ts`, `backend/icones.ts`, `backend/main.ts`) e §6
(`scripts/gen-config.ts`). Requisitos: `docs/canonico.md` §14 — todos os RF de F1 a F4.

Evidência de cada fatia: `docs/handovers/<fatia>.md`.

## Fechamento

Fechada pelo dono em 2026-10-16 ("feche esse épico"). Evidência de execução: `bun test test/` 295 pass; `tsc` limpo nos dois projetos; `bun run app:build` falha sem o seed e gera o app com ele; smoke real `bun test/smoke/run.ts` 14/14. Pendências registradas no README (§ Pendências).
