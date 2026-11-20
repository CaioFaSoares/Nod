import AppKit
import Foundation
import WebKit

// Isolated layout fixture: production portal assets, fake responses, no host or authentication.
final class PortalCheck: NSObject, WKNavigationDelegate {
  let assets: String
  let output: String
  let modes = ["entry", "cards", "list", "org"]
  let widths = [360, 740, 1280]
  var index = 0
  var web: WKWebView!
  var window: NSWindow!
  var results: [[String: Any]] = []
  var hadFailure = false

  init(assets: String, output: String) {
    self.assets = assets
    self.output = output
  }

  func start() {
    let width = widths[index / modes.count]
    let mode = modes[index % modes.count]
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 740), configuration: config)
    web.navigationDelegate = self
    window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.setFrameOrigin(NSPoint(x: -4000, y: 0))
    window.contentView = web
    window.orderBack(nil)
    let css = try! String(contentsOfFile: assets + "/style.css", encoding: .utf8)
    let js = try! String(contentsOfFile: assets + "/app.js", encoding: .utf8)
    let stub = """
      window.__fixtureErrors = [];
      window.addEventListener('error', e => window.__fixtureErrors.push(e.message));
      window.addEventListener('unhandledrejection', e => window.__fixtureErrors.push(String(e.reason)));
      const fixtureMode = '\(mode)';
      const longName = 'Nome muito longo de uma pessoa para testar o limite da interface';
      const entries = Array.from({length: 6}, (_, i) => ({
        id: 'test-' + i, title: i === 0 ? 'Ferramenta com título longo para teste responsivo' : 'Ferramenta de teste ' + (i+1),
        url: 'https://tool-' + i + '.example.test', icon: null, category: i < 4 ? 'Categoria de teste com título extenso' : 'Outros testes',
        tags: ['etiqueta-de-teste', 'segunda-etiqueta'], orgAccount: 'conta-de-teste-com-nome-longo@example.test',
        roles: ['test-role'], order: i, active: true, views: [], auth: {}
      }));
      window.fetch = async (path) => {
        const isMe = String(path).endsWith('/me');
        const data = isMe ? { guild: 'Organização com nome longo para teste de layout', name: longName, email: 'person@example.test', admin: true }
          : { orgTools: entries, personalTools: [], favorites: ['test-0'], roles: [{id: 'test-role', name: 'Papel de teste com nome longo', admin: true}], people: [{id: 'test-person', name: longName, roles: ['test-role'], admin: true}] };
        return new Response(JSON.stringify(data), {status: isMe && fixtureMode === 'entry' ? 401 : 200, headers: {'content-type': 'application/json'}});
      };
      """
    web.loadHTMLString("<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>\(css)</style></head><body><div id='root'></div><script>\(stub)</script><script>\(js)</script></body></html>", baseURL: URL(string: "https://fixture.invalid/"))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let mode = modes[index % modes.count]
    let prepare = """
      (() => {
        const chosen = document.querySelector('[data-view="\(mode)"]');
        if (chosen) chosen.click();
        if ('\(mode)' === 'entry') document.querySelector('.lb-message').textContent = 'Mensagem de erro de teste para observar contraste e quebra de linha.';
        return true;
      })()
      """
    web.evaluateJavaScript(prepare) { _, error in
      if let error = error { self.fail(error.localizedDescription); return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.measure() }
    }
  }

  func measure() {
    let width = widths[index / modes.count]
    let mode = modes[index % modes.count]
    let measure = """
      (() => {
        const rect = el => {const r = el.getBoundingClientRect(); return {class: el.className, text: el.textContent.slice(0,60), x:r.x, y:r.y, w:r.width, h:r.height}};
        const visible = el => el.getClientRects().length > 0;
        const controls = [...document.querySelectorAll('input,button')].filter(visible).map(rect);
        const overflows = [...document.querySelectorAll('body *')].filter(visible).filter(el => {const r = el.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1}).map(rect);
        const active = document.activeElement;
        const focus = active ? {class:active.className, outline:getComputedStyle(active).outline, offset:getComputedStyle(active).outlineOffset} : null;
        return JSON.stringify({viewport:innerWidth,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,controls,rawOutOfViewportRectsIncludingClippedDescendants:overflows,focus,hasFocus:document.hasFocus(),errors:window.__fixtureErrors});
      })()
      """
    web.evaluateJavaScript(measure) { value, error in
      if let error = error { self.fail(error.localizedDescription); return }
      let json = value as? String ?? "{}"
      var record = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
      record["width"] = width
      record["mode"] = mode
      let clientWidth = record["clientWidth"] as? Double ?? 0
      let scrollWidth = record["scrollWidth"] as? Double ?? 1
      let controls = record["controls"] as? [[String: Any]] ?? []
      let shortControls = controls.filter { ($0["h"] as? Double ?? 0) < 36 }
      let errors = record["errors"] as? [String] ?? []
      let passed = clientWidth > 0 && scrollWidth <= clientWidth && !controls.isEmpty && shortControls.isEmpty && errors.isEmpty
      record["geometryPassed"] = passed
      if !passed { self.hadFailure = true }
      self.results.append(record)
      print("\(width) \(mode): \(json)")
      let snapshot = WKSnapshotConfiguration()
      snapshot.rect = NSRect(x: 0, y: 0, width: width, height: 740)
      self.web.takeSnapshot(with: snapshot) { image, error in
        if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
          try? png.write(to: URL(fileURLWithPath: self.output + "/\(mode)-\(width).png"))
        } else if let error = error {
          print("snapshot unavailable: \(error.localizedDescription)")
        }
        self.advance()
      }
    }
  }

  func fail(_ message: String) {
    hadFailure = true
    results.append(["error": message, "index": index])
    print("error: \(message)")
    advance()
  }

  func advance() {
    window.orderOut(nil)
    web.navigationDelegate = nil
    web = nil
    window = nil
    index += 1
    if index < widths.count * modes.count { start(); return }
    let data = try! JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: URL(fileURLWithPath: output + "/results.json"))
    NSApplication.shared.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let runner = PortalCheck(assets: CommandLine.arguments[1], output: CommandLine.arguments[2])
DispatchQueue.main.async { runner.start() }
app.run()
exit(runner.hadFailure ? 1 : 0)
