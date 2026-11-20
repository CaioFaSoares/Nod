# Limpeza de UI — 2026-11-19

Pedido do dono: limpar a interface e remover a visualização isométrica quebrada. Escopo e proposta de geometria: [RF-79 e registro §22](../canonico.md). A decisão histórica da biblioteca foi preservada; esta entrega não aprova a proposta em nome do dono.

## Alterações — leitura

- [Modelos compartilhados](../../shared/library.ts): apenas Cards, List e Org chart. A preferência antiga `blocks` é lida como Cards, sem regravar o armazenamento ao iniciar. Removidos modelo, renderizadores e CSS da projeção.
- [Geometria compartilhada](../../shared/library.css): trilhas encolhíveis, títulos longos com quebra, categorias colapsáveis e destaque de duas colunas somente quando há espaço real. List e Org chart refluem sem alargar o catálogo.
- [Desktop](../../src/app.ts) e [estilos comuns](../../src/style.css): títulos deixam de disputar as antigas colunas fixas; seis slots de ações alinhados dentro dos cards; cabeçalho com busca e nomes das vistas visíveis; controles e abas maiores; grades de configurações adaptáveis. Filtrar/limpar mantém o wrapper de cada vista. List usa um botão nativo por linha. Leituras/escritas da preferência não derrubam a biblioteca quando o armazenamento é negado.
- [Portal](../../web/main.ts) e [estilos](../../web/style.css): alinhamento e hierarquia mais simples, busca e vistas adaptáveis, formulário com campos de pelo menos 44 px, envio por Enter e proteção contra envio duplicado, foco visível e estados acessíveis. List continua sendo link com abertura em outra aba.
- Preservados Atrius e Nod Sober, claro/escuro/cores personalizadas, permissões, credenciais, catálogo e contratos do backend. Não houve instalação ou publicação de release.

## Execução obtida

### Validação automatizada

```sh
bun run validate
```

Resultado: **4/4 etapas**, código 0, 44,9 s. Typecheck de app/backend/host/Electrobun; **1.141 testes** do app/backend (4.789 asserções) e **205 do host** (2.358 asserções), sem falhas; builds de produção desktop e portal. Os [testes da biblioteca](../../test/library.test.ts) cobrem as três opções e o fallback da preferência retirada.

### Superfície real: Electrobun

```sh
bun test/smoke/ui.ts --force
```

Resultado observado: **`ui smoke: ok (8 stage(s), 7 app launch(es))`**, código 0. O [driver](../../test/smoke/ui-driver.ts) verificou na janela real: três vistas e uma selecionada por vez; busca/limpeza; categoria colapsada persistindo ao alternar vistas; seis títulos de Cards com largura positiva e ações dentro do card; conteúdo sem overflow horizontal; wrappers diretos de List/Org chart preservados ao filtrar e limpar. Também passaram os fluxos existentes de navegação, conta, compartilhamento, pessoas e estilo/cores.

Somente host, contas, ferramentas e segredos descartáveis de smoke em loopback. O seed privado foi restaurado **byte a byte**, conferido por SHA-256 antes/depois; nenhum backup de seed permaneceu. A primeira tentativa foi bloqueada pelo sandbox ao resolver Cottontail; a repetição exata autorizada passou. Não foi lançado o perfil real com trace.

### Geometria renderizada: fixtures isoladas

- **Desktop: 20 casos / 40 estágios aprovados** — [resultados](../evidence/ui-cleanup/desktop-results.json), [proveniência](../evidence/ui-cleanup/desktop-provenance.json), [runner](../evidence/ui-cleanup/desktop.swift), [asserções](../evidence/ui-cleanup/measure.js), [API fictícia](../evidence/ui-cleanup/tiny-fixture.js). App real empacotado para navegador, CSS de produção e oito fontes Rubik embutidas. Atrius/Sober × claro/escuro, Cards em 740/1280 px, List/Org chart/configurações em 740 px; altura 820 px. Mede títulos, slots/rodapés dentro do card, overflow, List 7→1→7, wrapper de Org chart, aparência expandida e ausência de erros JS/chamadas inesperadas.
- **Portal: 12 casos aprovados** — [resultados](../evidence/ui-cleanup/portal-results.json), [runner](../evidence/ui-cleanup/portal.swift). Assets de produção, respostas fictícias: entrada/Cards/List/Org chart em 360/740/1280 px, altura 740 px. Sem overflow horizontal do documento, sem controles abaixo de 36 px e sem erros JS. Retângulos internos de texto elidido aparecem fora do viewport em algumas medições, mas são recortados pelo ancestral; não foram tratados como overflow do documento.
- Os resultados completos foram retidos; somente oito PNGs representativos foram copiados. [Manifesto](../evidence/ui-cleanup/manifest.json) registra hashes dos arquivos e assets usados.

**Limites:** WKWebView offscreen não é outro runtime do Nod nem prova de backend/autenticação. Os mocks não abrem ferramentas, não implementam mutações e não representam dados reais. `hasFocus=false`: estas capturas não comprovam navegação de teclado, leitor de tela, foco efetivo ou chrome nativo. A compilação inicial do runner desktop foi bloqueada no cache Swift; a repetição exata autorizada passou. O smoke Electrobun acima é a evidência separada da superfície real; as capturas são somente evidência de layout.

## Capturas representativas — dados fictícios

- [Desktop Cards, Sober escuro, 740 px](../evidence/ui-cleanup/sober-dark-cards-740-initial.png)
- [Desktop Cards, Sober escuro, 1280 px](../evidence/ui-cleanup/sober-dark-cards-1280-initial.png)
- [Desktop List, 740 px](../evidence/ui-cleanup/sober-dark-list-740-initial.png)
- [Desktop Org chart, Atrius claro, 740 px](../evidence/ui-cleanup/atrius-light-org-740-initial.png)
- [Configurações, Sober claro, 740 px](../evidence/ui-cleanup/sober-light-settings-740-initial.png)
- [Portal Cards, 360 px](../evidence/ui-cleanup/cards-360.png)
- [Portal entrada, 360 px](../evidence/ui-cleanup/entry-360.png)
- [Portal List, 740 px](../evidence/ui-cleanup/list-740.png)

## Reproduzir as fixtures no macOS

Requer Bun, Swift/AppKit/WebKit e os builds atuais. Não inicia servidor nem abre credenciais reais. Comandos a partir da raiz; diretório de saída descartável, sem apagar ou mover perfis:

```sh
bun run build
OUT="$(mktemp -d /tmp/nod-ui-layout.XXXXXX)"
mkdir -p "$OUT/desktop" "$OUT/portal"
bun docs/evidence/ui-cleanup/build-desktop-fixture.ts "$PWD" "$OUT/desktop"
swiftc docs/evidence/ui-cleanup/desktop.swift -o "$OUT/desktop-check"
"$OUT/desktop-check" "$OUT/desktop"
swift docs/evidence/ui-cleanup/portal.swift "$PWD/host/public" "$OUT/portal"
```

O [empacotador da fixture](../evidence/ui-cleanup/build-desktop-fixture.ts) usa os assets de produção existentes e embute as fontes, sem alterar fontes de produto. Se o sandbox negar cache ou API nativa, a execução precisa de autorização; não redirecionar uma operação negada para contornar a política. Resultados e capturas ficam em `OUT`; o runtime de produto continua exclusivamente Electrobun.

Fora do escopo: publicação/instalação de release, serviços reais, autenticação em ferramentas de terceiros e uma auditoria completa de acessibilidade.
