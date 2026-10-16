# AGENTS.md — Bond

Antes de qualquer coisa, leia `docs/canonico.md`. Ele é a fonte única do escopo e dos requisitos.
Os fatos do runtime estão em `docs/tinyjs.md`; o que veio da Carna, em `docs/downscale-carna.md`;
o vocabulário, em `CONTEXT.md`.

## O que é o Bond

Uma casca de desktop (TypeScript fino sobre tinyjs) que reúne as ferramentas internas da Copland numa
janela de catálogo e em janelas de ferramenta, com papéis, concessões e credenciais no chaveiro do
sistema. É um downscale da Carna, não uma continuação dela.

## Onde cada coisa mora

| Assunto | Casa |
| --- | --- |
| Escopo, requisitos funcionais e não funcionais, modelo de dados, roadmap, registro de decisões, questões abertas | `docs/canonico.md` |
| Fatos e limites do runtime tinyjs | `docs/tinyjs.md` |
| O que foi herdado e abandonado da Carna | `docs/downscale-carna.md` |
| Vocabulário canônico | `CONTEXT.md` |
| Código (quando existir) | raiz do projeto, conforme a fase do roadmap |
| Processo do dono (proposta, issue, frente) | `_research/_Guia/` do `_Aleph` (`/Users/caio/_Eclaire/_Workspace/Projects/_Aleph/`) — vale para trabalho lá dentro; aqui o registro é este repositório |

## Regras

- **Evidência.** Toda afirmação sobre o que existe carrega caminho ou URL; toda afirmação sobre o que
  funciona diz como foi obtida — `leitura` ou `execução`. Nada executado é chamado de verificado.
- **Um fato, uma casa.** Se já está escrito em outro arquivo, aponte o caminho. Não copie parágrafo.
- **Nada avança sem leitura do dono.** Decisão nasce `Proposto` ou `Aberto` no registro do
  `canonico.md`; só o dono muda para `Decidido`.
- **Estado é derivado, não declarado.** Nenhum arquivo lista o status de outro arquivo.
- **Sem fallback de toolchain.** Ferramenta ausente vira bloqueio declarado, não uma segunda
  superfície de runtime.
- **Ferramenta é dado.** Endereço, produto, ícone e papéis das ferramentas são conteúdo do catálogo;
  o código não conhece `copland.studio` nem nome de produto de terceiro.
- **O seed privado não entra no git.** Ele vive fora do repositório, é listado em `resources/` e vai
  embutido na release (§19 do `canonico.md`). No lugar dele, só `seed.example.json` com dados falsos.

## Não pode

- Escrever código de produto sem requisito aprovado no `canonico.md`.
- Marcar requisito como atendido sem prova na superfície real (o app rodando, a janela abrindo).
- Pôr segredo, token ou senha em arquivo, em log, em evento ou em `store.json`.
- Rodar `tinyjs dev` com `TINYJS_DEBUG=1` usando credenciais reais: o trace do runtime imprime o
  EVAL do adaptador de login (usuário e senha) e cada chamada de API até 160 caracteres — senha local
  em `session.unlock`/`createAccount`/`changePassword`, segredo em `vault.save`/`vault.reveal`,
  código em `invites.issue`. O runtime só esconde `secrets.*` e `clip.*`.
- Abrir ferramenta de terceiro em iframe dentro da casca, ou conceder `api` com `"all"` ou
  wildcard de subdomínio.
- Inventar endereço, produto ou capacidade das ferramentas internas que o dono não confirmou.
- Prometer comportamento que o runtime não documenta (`docs/tinyjs.md` §10, §11).
