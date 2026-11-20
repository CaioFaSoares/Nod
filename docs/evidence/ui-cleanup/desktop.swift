import AppKit
import Foundation
import WebKit

struct FixtureCase: Codable {
  let skin: String
  let theme: String
  let mode: String
  let width: Int
}

// Offscreen WKWebView layout fixture of Nod source + existing production CSS.
// It is not Electrobun, a second app runtime, backend/auth evidence, or a real keyboard-focus test.
final class DesktopLayoutCheck: NSObject, WKNavigationDelegate {
  let output: String
  let cases: [FixtureCase]
  var index = 0
  var stageIndex = 0
  var web: WKWebView!
  var window: NSWindow!
  var results: [[String: Any]] = []
  var hadFailure = false

  init(output: String) {
    self.output = output
    var cases: [FixtureCase] = []
    for skin in ["sober", "atrius"] {
      for theme in ["light", "dark"] {
        for (mode, width) in [("cards", 740), ("cards", 1280), ("list", 740), ("org", 740), ("settings", 740)] {
          cases.append(FixtureCase(skin: skin, theme: theme, mode: mode, width: width))
        }
      }
    }
    self.cases = cases
  }

  var test: FixtureCase { cases[index] }
  var stages: [String] {
    if test.mode == "list" || test.mode == "org" { return ["initial", "filtered", "cleared"] }
    if test.mode == "settings" { return ["initial", "appearance"] }
    return ["initial"]
  }
  var stage: String { stages[stageIndex] }
  var name: String { "\(test.skin)-\(test.theme)-\(test.mode)-\(test.width)-\(stage)" }

  func text(_ name: String) -> String { try! String(contentsOfFile: output + "/" + name, encoding: .utf8) }

  func start() {
    stageIndex = 0
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: test.width, height: 820), configuration: config)
    web.navigationDelegate = self
    window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.setFrameOrigin(NSPoint(x: -4000, y: 0))
    window.contentView = web
    window.orderBack(nil)
    let json = String(data: try! JSONEncoder().encode(test), encoding: .utf8)!
    let css = text("style.css")
    let js = text("app.js").replacingOccurrences(of: "</script", with: "<\\/script")
    let stub = text("tiny-fixture.js")
    let html = "<!doctype html><html lang='en' data-skin='atrius' data-theme='dark'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Nod isolated layout fixture</title><style>\(css)</style></head><body><div id='app'></div><script>window.__fixtureCase = \(json);</script><script>\(stub)</script><script>\(js)</script></body></html>"
    try! html.write(toFile: output + "/\(test.skin)-\(test.theme)-\(test.mode)-\(test.width).html", atomically: true, encoding: .utf8)
    web.loadHTMLString(html, baseURL: URL(string: "https://fixture.invalid/"))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { prepare() }

  func prepare() {
    let jsonStage = String(data: try! JSONEncoder().encode(stage), encoding: .utf8)!
    var action = ""
    if stage == "initial" {
      if test.mode == "settings" {
        action = "const control = document.querySelector('.sidebar-action[aria-label=\"Settings\"]'); if (!control) throw Error('Settings action absent'); control.click();"
      } else {
        action = "const control = document.querySelector('.lb-view[data-view=\"\(test.mode)\"]'); if (!control) throw Error('Library view action absent'); control.click();"
      }
    } else if stage == "filtered" || stage == "cleared" {
      let query = stage == "filtered" ? "Ferramenta de teste 3" : ""
      action = "const input = document.querySelector('.lb-search-input'); if (!input) throw Error('Search absent'); input.value = '\(query)'; input.dispatchEvent(new Event('input', {bubbles: true}));"
    } else if stage == "appearance" {
      action = "const disclosure = [...document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === 'Appearance'); if (!disclosure) throw Error('Appearance disclosure absent'); disclosure.open = true; disclosure.scrollIntoView({block: 'start'});"
    }
    let script = """
      window.__fixtureStage = \(jsonStage);
      await document.fonts.ready;
      \(action)
      await new Promise(resolve => setTimeout(resolve, 100));
      await document.fonts.ready;
      if (window.__fixtureStage !== 'appearance') document.querySelector('.content').scrollTop = 0;
      return true;
      """
    web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .success: self.measure()
      case .failure(let error): self.fail(error.localizedDescription)
      }
    }
  }

  func measure() {
    web.evaluateJavaScript(text("measure.js")) { value, error in
      if let error = error { self.fail(error.localizedDescription); return }
      guard let json = value as? String, var record = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { self.fail("Measurement returned no JSON"); return }
      let passed = record["passed"] as? Bool == true
      record["screenshot"] = self.name + ".png"
      self.results.append(record)
      if !passed { self.hadFailure = true }
      let assertions = record["assertions"] as? [String: Bool] ?? [:]
      print("\(passed ? "PASS" : "FAIL") \(self.name) \(assertions.filter { !$0.value }.map { $0.key }.sorted())")
      let snapshot = WKSnapshotConfiguration()
      snapshot.rect = self.web.bounds
      self.web.takeSnapshot(with: snapshot) { image, error in
        if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
          do { try png.write(to: URL(fileURLWithPath: self.output + "/" + self.name + ".png")) }
          catch { self.hadFailure = true; print("Snapshot write failed: \(error.localizedDescription)") }
        } else {
          self.hadFailure = true
          print("Snapshot unavailable: \(error?.localizedDescription ?? "unknown")")
        }
        self.advance()
      }
    }
  }

  func fail(_ message: String) {
    hadFailure = true
    results.append(["error": message, "index": index, "stage": stage, "name": name, "passed": false])
    print("ERROR \(name): \(message)")
    advance()
  }

  func advance() {
    if stageIndex + 1 < stages.count {
      stageIndex += 1
      prepare()
      return
    }
    window.orderOut(nil)
    web.navigationDelegate = nil
    web = nil
    window = nil
    index += 1
    if index < cases.count { start(); return }
    let data = try! JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: URL(fileURLWithPath: output + "/results.json"))
    print("Completed \(cases.count) cases / \(results.count) stages; hadFailure=\(hadFailure)")
    NSApplication.shared.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let runner = DesktopLayoutCheck(output: CommandLine.arguments[1])
DispatchQueue.main.async { runner.start() }
app.run()
exit(runner.hadFailure ? 1 : 0)
