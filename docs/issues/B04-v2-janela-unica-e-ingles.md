---
id: B04
frente: bond
titulo: v2 — janela única de gerenciar/usar, app em inglês, achados das revisões
status: fechada
tipo: cobertura
origem: derivado
bloqueada_por: —
destino: —
aberta_em: 2026-10-15
---

Autoriza reescrever o app do Bond conforme `docs/arquitetura.md` (v2): janela principal única
(sidebar, Home, paleta, Settings), ferramentas em janelas próprias, todo o app em inglês, e as
correções das revisões de requisitos e de segurança (achados A1–A24 e D1–D7, P1–P9 citados no
contrato). Requisitos: `docs/canonico.md` §7, §8, §11, §14, §15. Evidência por fatia em
`docs/handovers/v2-<fatia>.md`.

## Fechamento

Fechada pelo dono em 2026-10-16 ("feche esse épico"). Evidência de execução: `bun test test/` 295 pass; `tsc` limpo nos dois projetos; `bun run app:build` falha sem o seed e gera o app com ele; smoke real `bun test/smoke/run.ts` 14/14. Pendências registradas no README (§ Pendências).
