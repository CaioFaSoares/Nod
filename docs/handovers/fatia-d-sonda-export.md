# Fatia D — sonda e export do cofre (shared/)

Fatia de `docs/arquitetura.md` §3, autorizada pela issue `docs/issues/B01-modulos-puros-e-frontend.md`
(`status: em-curso`). Dono: este agente. Evidência obtida por **leitura** de código e de documento —
o contrato da fase proíbe rodar `bun test`, `typecheck`, linter e formatador; a verificação é do
coordenador.

## Arquivos tocados

- `shared/sonda.ts` (novo) — `analisarHtml`, `detectarProvedor`, `tituloLimpo`, `tipoIcone` e o tipo
  `AnaliseHtml`; regex sobre o HTML, sem DOM, sem `tiny`, sem `tjs`; só `URL`.
- `shared/exportar-cofre.ts` (novo) — `exportarCofre`, `importarCofre`; só WebCrypto,
  `TextEncoder/TextDecoder` e `btoa/atob`.
- `test/sonda.test.ts` (novo) — `bun test`, cobre cada regra da §3 e as fronteiras.
- `test/exportar-cofre.test.ts` (novo) — `bun test`, ida e volta com iterações 1000, formato do
  envelope e cada caminho de erro.
- `docs/handovers/fatia-d-sonda-export.md` (este arquivo).

Nenhum arquivo de outro dono foi tocado. `shared/types.ts`, `src/api.ts` e `docs/arquitetura.md` não
foram alterados.

## Critério de aceite e como cada item foi atendido

| Item | Como foi atendido | Onde |
| --- | --- | --- |
| Título de `<title>`, entidades básicas e `tituloLimpo`; nulo se ausente/vazio | `RE_TITULO` (case-insensitive, com `[\s\S]*?`), decodificação de `&amp; &lt; &gt; &quot; &#39;` (com `&amp;` por último) e `tituloLimpo`; resultado vazio → `null` | `shared/sonda.ts` (`analisarHtml`, `tituloLimpo`); testes em `test/sonda.test.ts` |
| Ícones na ordem apple → icon (png/svg antes) → og:image → `/favicon.ico`, absolutos, sem repetição | Coleta em quatro listas na ordem de varredura do documento, concatenação na preferência e `new URL(href, urlFinal).href` com `Set` de deduplicação | `shared/sonda.ts` (`analisarHtml`); teste do HTML de aceite |
| Atributos em qualquer ordem, aspas simples ou duplas | `atributosDeTag` lê os pares nome=valor com três alternativas de valor (`"…"`, `'…'`, sem aspas) — superset pedido, o sem aspas cobre o `<input type=password>` | `shared/sonda.ts`; testes de ordem/aspas |
| `tem_formulario` = `<input type="password">` (aspas de três formas, case-insensitive) | `RE_SENHA = /<input\b[^>]*\btype\s*=\s*(?:"password"|'password'|password\b)/i` | `shared/sonda.ts`; testes de `input` |
| `detectarProvedor`: origin diferente → essa origin; mesma origin com caminho de fluxo → a própria; senão `null`; URL inválida → `null` | `new URL(urlFinal)`, comparação de `origin` e teste do `pathname` contra `/(oauth2?\|oidc\|openid\|authorize\|realms\/\|\/sso\b\|saml)/i`; `catch` → `null` | `shared/sonda.ts`; `describe('detectarProvedor')` |
| `tituloLimpo`: corta no primeiro separador, trim, e devolve o trim original se o corte zerar | menor índice entre ` · `, ` \| `, ` — `, ` – `, ` - `; `slice(0, i).trim()`; vazio → `titulo.trim()` | `shared/sonda.ts`; `describe('tituloLimpo')` |
| `tipoIcone` por content-type e, se ausente/genérico, pela extensão; ico/desconhecido → `null` | `POR_CONTENT_TYPE` (png, svg, jpeg, webp) sobre o content-type sem parâmetros; senão extensão do `pathname` (`POR_EXTENSAO`); `ico` e demais → `null` | `shared/sonda.ts`; `describe('tipoIcone')` |
| `exportarCofre(itens, senha, iteracoes = 600_000)`: salt 16 B, nonce 12 B, AES-256-GCM por PBKDF2-SHA256, base64 do envelope `{ v, alg, iter, salt, nonce, ct }` | `getRandomValues` para salt/nonce, `chaveDeSenha` (PBKDF2-SHA256 → AES-256-GCM 256), `encrypt` sobre `TextEncoder(JSON.stringify(itens))`, envelope em base64 de UTF-8 | `shared/exportar-cofre.ts`; teste do envelope e do salt/nonce |
| `importarCofre(blob, senha)`: qualquer falha → `throw new Error('senha incorreta ou arquivo inválido')`; valida lista de itens string | `try/catch` único em volta de base64, JSON, `v !== 1`, campos do envelope, derivação e `decrypt`; `validarItens` confere `Array` e os quatro campos string | `shared/exportar-cofre.ts`; testes de senha errada, blob lixo, `v: 2`, ct adulterado e item sem `segredo` |
| Import sem extensão, tipos de `shared/types.ts` via `import type`, sem dependência nova | `import type { IconeBruto } from './types'` e `import type { CofreExportItem } from './types'`; nenhum `package.json` alterado | os dois módulos |

## Comando e resultado observado

Nenhum comando de verificação foi rodado — por contrato desta fase ("NÃO rode testes, typecheck,
linter nem formatador; só edite"). O que segue é **leitura**, não `execucao`:

- Saída esperada de `bun test test/`: os testes de `test/sonda.test.ts` e
  `test/exportar-cofre.test.ts` passando. O caso de aceite do HTML está escrito literalmente como
  descrito no despacho e espera títulos e ícones nas ordens acima; a ida e volta usa 1000 iterações.
- Itens do aceite cobertos por teste nomeado: HTML completo e HTML vazio; os três casos de
  `detectarProvedor`; os três casos de `tipoIcone`; ida e volta, senha errada e blob lixo.

## O que ficou de fora e por quê

- **`backend/sonda-rede.ts`** (fetch, redirect, download do ícone em base64) — é de outra fatia; aqui
  só a leitura do HTML. `Sonda.icone` é montado lá com o `tipoIcone` daqui.
- **ICO**: `tipoIcone` devolve `null`, como o canônico §8 pede (não há decodificador de imagem).
- **Ícone embutido ou data URI**: não entram na lista de `icones`; quem busca é o backend.
- **Meta tags de `<link rel="mask-icon">`** fora de `\bicon\b`: um `rel` que não contenha a palavra
  `icon` é ignorado de propósito (só `icon`/`shortcut icon`/`apple-touch-icon` contam).
- **Iterações padrão do PBKDF2**: os testes usam 1000; nenhum teste roda as 600 000 iterações, para
  não tornar a suíte lenta. O padrão do parâmetro segue 600 000 em `exportarCofre`.

## Decisões de implementação (semântica, não contrato)

- `tituloLimpo` corta sobre a string crua e apara o pedaço; o ramo "corte vazio" devolve `titulo.trim()`
  — é o único jeito de esse ramo ser alcançável (ex.: `' - Copland'` → `'- Copland'`).
- O leitor de atributos aceita também valor sem aspas, além de aspas simples e duplas; é superset do
  pedido e é o que permite ler `<input type=password>` no mesmo caminho.
- `og:image` só casa a `property` exata (`og:image:width` fica de fora).

## O que outro dono precisa fazer

Nada desta fatia. `backend/sonda-rede.ts` (fatia B) consome `analisarHtml`, `detectarProvedor` e
`tipoIcone` deste módulo; `backend/cofre.ts` (fatia E) consome `exportarCofre` e `importarCofre`.
