(() => {
  const test = window.__fixtureCase;
  const stage = window.__fixtureStage;
  const content = document.querySelector('.content');
  const home = document.querySelector('.home');
  const bounds = node => {
    const r = node.getBoundingClientRect();
    return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height};
  };
  const shown = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const cards = [...document.querySelectorAll('.home .tool-card')].map(card => {
    const title = card.querySelector('.tool-title');
    const footer = card.querySelector('.tool-actions');
    const cardRect = bounds(card);
    const footerRect = footer ? bounds(footer) : null;
    const slots = footer ? [...footer.children].map(bounds) : [];
    return {title: title?.textContent, card: cardRect, titleRect: title ? bounds(title) : null,
      footer: footerRect, slots,
      titlePositive: !!title && bounds(title).width > 0,
      footerWithinCard: !!footerRect && footerRect.right <= cardRect.right + 0.5 && footerRect.left >= cardRect.left - 0.5 && footerRect.bottom <= cardRect.bottom + 0.5,
      slotsWithinCard: slots.every(rect => rect.right <= cardRect.right + 0.5 && rect.left >= cardRect.left - 0.5),
    };
  });
  const expectedWrapper = test.mode === 'cards' ? 'lb-groups' : test.mode === 'list' ? 'lb-list' : 'lb-org';
  const wrapper = home?.firstElementChild;
  const titles = [...document.querySelectorAll(test.mode === 'cards' ? '.home .tool-title' : test.mode === 'list' ? '.home .lb-card-title' : test.mode === 'org' ? '.home .lb-org-role' : '.settings-view h2')].filter(shown).map(node => ({text: node.textContent, ...bounds(node)}));
  const controls = [...document.querySelectorAll('button,input,select,summary')].filter(shown).map(node => ({class: node.className, label: node.getAttribute('aria-label') || node.textContent?.slice(0, 50), ...bounds(node)}));
  const listRows = document.querySelectorAll('.home .lb-list-row').length;
  const orgNodes = document.querySelectorAll('.home .lb-org-node').length;
  const expectedListRows = stage === 'filtered' ? 1 : window.__fixtureExpected.entryCount;
  const contentMetrics = content ? {clientWidth: content.clientWidth, scrollWidth: content.scrollWidth, scrollLeft: content.scrollLeft, scrollTop: content.scrollTop, ...bounds(content)} : null;
  const wrapperCorrect = test.mode === 'settings' ? !!document.querySelector('.settings-view') : !!home && home.childElementCount === 1 && !!wrapper?.classList.contains(expectedWrapper) && (test.mode !== 'org' || wrapper.getAttribute('aria-busy') === 'false');
  const controlsInsideContent = controls.filter(node => node.left >= (contentMetrics?.left || 0) && node.top >= (contentMetrics?.top || 0)).every(node => node.right <= (contentMetrics?.right || 0) + 0.5);
  const assertions = {
    contentExists: !!content,
    contentNoHorizontalOverflow: !!content && content.clientWidth > 0 && content.scrollWidth <= content.clientWidth,
    documentNoHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    titlesPositive: titles.length > 0 && titles.every(rect => rect.width > 0),
    cardsPresentWhenExpected: test.mode !== 'cards' || cards.length === window.__fixtureExpected.entryCount,
    cardsTitlesPositive: cards.every(card => card.titlePositive),
    cardFootersInside: cards.every(card => card.footerWithinCard && card.slotsWithinCard),
    wrapperCorrect,
    listRowsCorrect: test.mode !== 'list' || listRows === expectedListRows,
    orgNodesCorrect: test.mode !== 'org' || orgNodes === window.__fixtureExpected.roleCount,
    skinThemeCorrect: document.documentElement.dataset.skin === test.skin && document.documentElement.dataset.theme === test.theme,
    noJavaScriptErrors: window.__fixtureErrors.length === 0,
    noUnexpectedAPICalls: window.__fixtureUnexpected.length === 0,
    controlsExist: controls.length > 0,
    controlsInsideContent,
  };
  return JSON.stringify({case: test, stage, viewport: {width: innerWidth, height: innerHeight},
    document: {clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth},
    content: contentMetrics, homeChildren: home ? [...home.children].map(node => node.className) : [],
    selectedView: document.querySelector('.lb-view[aria-pressed="true"]')?.dataset.view || null,
    search: document.querySelector('.lb-search-input')?.value || '',
    cards, titles, listRows, orgNodes, orgCategories: [...document.querySelectorAll('.home .lb-org-categories')].map(node => node.textContent),
    controls, fonts: {status: document.fonts.status, rubik400Loaded: document.fonts.check('400 14px Rubik'), faces: [...document.fonts].map(font => ({family: font.family, weight: font.weight, status: font.status}))},
    errors: window.__fixtureErrors, unexpectedAPICalls: window.__fixtureUnexpected, apiCalls: window.__fixtureCalls,
    hasFocus: document.hasFocus(), activeElement: document.activeElement?.className || null,
    assertions, passed: Object.values(assertions).every(Boolean),
  });
})()
