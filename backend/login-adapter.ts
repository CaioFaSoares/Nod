// Login adapter: the code the backend injects into the tool page (`app.window(id).eval(...)`) after
// a `finish` on the entry origin. Contract: docs/arquitetura.md §4 (login adapter), §2 (`eval` only
// in the entry origin and only in the top frame); canonico §8 and §11 (cascade, vault).
// Requirements: RF-09, RF-10, RF-25.
//
// Rules this file keeps:
// - the values (username and secret) enter the script only through `JSON.stringify`;
// - the script evaluates nothing read from the page: it only reads `input` attributes to decide
//   where to write;
// - the script never throws out (the whole body sits under `try`);
// - it leaves without doing anything when the origin is not the expected one or when it is not the
//   top frame — the second check of the two the contract asks for;
// - the report goes through `window.tiny.api.call('login.report', { state })`, which the backend
//   window guard accepts only from tool windows (docs/arquitetura.md §2).

/** Object the script receives embedded as a JSON literal, in the `data` variable. */
interface AdapterData {
  fill: boolean;
  origin: string;
  username?: string;
  secret?: string;
}

export interface AdapterOptions {
  /** fill and submit the form; false only reports what it found */
  fill: boolean;
  /** origin the script is allowed to run in (`location.origin` must match it exactly) */
  origin: string;
  username?: string;
  secret?: string;
  /** how long (ms) the script waits for a visible password field; 3 s by default */
  waitMs?: number;
}

const DEFAULT_WAIT_MS = 3000;

/**
 * Source of an IIFE that looks for the page's login form and, when asked, fills and submits the
 * credentials; it reports what it found through `login.report`.
 *
 * `fill` becomes true in the script only when both values come along — without one of them the
 * script only reports (`'no-form'`, `'form'` or `'filled'`), and neither the username nor the
 * secret shows up in the generated code.
 */
export function adapterScript(o: AdapterOptions): string {
  const data: AdapterData = { fill: false, origin: o.origin };
  if (
    o.fill === true &&
    typeof o.username === 'string' &&
    o.username !== '' &&
    typeof o.secret === 'string' &&
    o.secret !== ''
  ) {
    data.fill = true;
    data.username = o.username;
    data.secret = o.secret;
  }
  const waitMs =
    typeof o.waitMs === 'number' && Number.isFinite(o.waitMs) && o.waitMs >= 0
      ? Math.round(o.waitMs)
      : DEFAULT_WAIT_MS;

  return `(function () {
  'use strict';
  var data = ${JSON.stringify(data)};
  var waitMs = ${String(waitMs)};
  function report(state) {
    try {
      if (window.tiny && window.tiny.api && typeof window.tiny.api.call === 'function') {
        window.tiny.api.call('login.report', { state: state });
      }
    } catch (error) {
      // reporting is best effort: the report may not break the tool's own page
    }
  }
  function visible(el) {
    if (el.offsetParent !== null) return true;
    return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
  }
  function isText(el) {
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    return type === 'text' || type === 'email';
  }
  function suggestsUsername(el) {
    var hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.getAttribute('id')];
    for (var i = 0; i < hints.length; i++) {
      var hint = hints[i];
      if (typeof hint === 'string' && /user|email|login|username/i.test(hint)) return true;
    }
    return false;
  }
  function findPassword() {
    var fields = document.querySelectorAll('input');
    for (var i = 0; i < fields.length; i++) {
      var type = (fields[i].getAttribute('type') || '').toLowerCase();
      if (type === 'password' && visible(fields[i])) return fields[i];
    }
    return null;
  }
  function findUsername(scope, password) {
    var fields = scope.querySelectorAll('input');
    var i;
    for (i = 0; i < fields.length; i++) {
      var hinted = fields[i];
      if (hinted === password || !isText(hinted) || !visible(hinted)) continue;
      if (suggestsUsername(hinted)) return hinted;
    }
    for (i = 0; i < fields.length; i++) {
      var before = fields[i];
      if (before === password) break;
      if (isText(before) && visible(before)) return before;
    }
    return null;
  }
  function write(el, value) {
    var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function submit(form) {
    if (form === null) return;
    if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return; }
    var button = form.querySelector('[type=submit]');
    if (button !== null) { button.click(); return; }
    if (typeof form.submit === 'function') form.submit();
  }
  /** Origin the form posts to: its own action, or the document's when it carries none (P7). */
  function actionOrigin(form) {
    var action = form === null ? '' : form.getAttribute('action') || '';
    if (action === '') return location.origin;
    try {
      return new URL(action, location.href).origin;
    } catch (error) {
      return '';
    }
  }
  function run(password) {
    try {
      if (password === null) { report('no-form'); return; }
      if (data.fill !== true) { report('form'); return; }
      var form = password.form || null;
      // The credential is written and sent only when the form posts to the page's own origin: a
      // cross-origin action would hand the secret to another server (P7).
      if (actionOrigin(form) !== location.origin) { report('form'); return; }
      var scope = form === null ? document : form;
      var username = findUsername(scope, password);
      if (username !== null) write(username, data.username);
      write(password, data.secret);
      submit(form);
      report('filled');
    } catch (error) {
      report('error');
    }
  }
  /** Runs the callback with the password field, as soon as a visible one exists (up to waitMs). */
  function withPassword(callback) {
    var found = findPassword();
    if (found !== null) { callback(found); return; }
    var done = false;
    var observer = null;
    var timer = null;
    function finish(field) {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      if (observer !== null) {
        try { observer.disconnect(); } catch (error) { /* already gone */ }
      }
      callback(field);
    }
    function look() {
      var field = findPassword();
      if (field !== null) finish(field);
    }
    if (typeof MutationObserver === 'function') {
      try {
        observer = new MutationObserver(look);
        observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
      } catch (error) {
        observer = null;
      }
    }
    timer = setTimeout(function () { finish(null); }, waitMs);
  }
  try {
    if (location.origin !== data.origin) return;
    if (window.top !== window) return;
    withPassword(run);
  } catch (error) {
    report('error');
  }
})();
`;
}
