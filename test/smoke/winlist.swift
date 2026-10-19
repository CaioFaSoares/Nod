// On-screen window list of this machine, as JSON on stdout: the real frame of every window the
// window server is showing, front to back, with the owner pid and the window's title.
//
// The E03 smoke (`test/smoke/tabs.ts`) compiles it with `swiftc` into `test/smoke/.gerado/winlist`
// and reads it to check what the OS really put on screen: a WKWebView reports
// `window.screenX/screenY` as 0 and the screen height and `window.outerWidth/outerHeight` as 0
// (`backend/tiny.d.ts`, `TinyWinState.outer`), so the page cannot tell where its window is, and
// `CGWindowListCopyWindowInfo` is the only honest source for that. Same helper the E03 spikes used
// (`docs/handovers/e03-spikes.md` §1). The smoke skips the cross-check where `swiftc` is missing.
import AppKit
import CoreGraphics
import Foundation

let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
  FileHandle.standardError.write("no window list\n".data(using: .utf8)!)
  exit(1)
}

var out: [[String: Any]] = []
var order = 0
for window in list {
  let pid = window[kCGWindowOwnerPID as String] as? Int ?? 0
  let owner = window[kCGWindowOwnerName as String] as? String ?? ""
  let name = window[kCGWindowName as String] as? String ?? ""
  let layer = window[kCGWindowLayer as String] as? Int ?? 0
  var x = 0.0
  var y = 0.0
  var width = 0.0
  var height = 0.0
  if let bounds = window[kCGWindowBounds as String] as? [String: Any] {
    x = (bounds["X"] as? NSNumber)?.doubleValue ?? 0
    y = (bounds["Y"] as? NSNumber)?.doubleValue ?? 0
    width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
    height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
  }
  out.append([
    "order": order, "pid": pid, "owner": owner, "name": name, "layer": layer,
    "x": x, "y": y, "w": width, "h": height,
  ])
  order += 1
}

let front = NSWorkspace.shared.frontmostApplication

// The displays, in both spaces: `CGDisplayBounds` is the window server's, `NSScreen.frame` is
// Cocoa's points (what an app's `win.getState()` is in). On a scaled display they differ — that
// ratio is how the real frame of a window is read in an app's own units.
var displayIds = [CGDirectDisplayID](repeating: 0, count: 16)
var displayCount: UInt32 = 0
CGGetActiveDisplayList(UInt32(displayIds.count), &displayIds, &displayCount)

var displays: [[String: Any]] = []
for (index, id) in displayIds.prefix(Int(displayCount)).enumerated() {
  let bounds = CGDisplayBounds(id)
  var entry: [String: Any] = [
    "id": Int(id),
    "server": ["x": bounds.origin.x, "y": bounds.origin.y, "w": bounds.width, "h": bounds.height],
    "pixels": [CGDisplayPixelsWide(id), CGDisplayPixelsHigh(id)],
  ]
  if index < NSScreen.screens.count {
    let screen = NSScreen.screens[index]
    entry["points"] = ["x": screen.frame.origin.x, "y": screen.frame.origin.y, "w": screen.frame.width, "h": screen.frame.height]
    entry["scale"] = screen.backingScaleFactor
  }
  displays.append(entry)
}

// The session itself: a locked screen covers every window, which is what makes a webview report
// `document.visibilityState === 'hidden'` (and what the runtime throttles on), so a geometry check
// has to say which session it ran in.
var session: [String: Any] = ["screenLocked": false, "onConsole": true, "known": false]
if let state = CGSessionCopyCurrentDictionary() as? [String: Any] {
  session = [
    "screenLocked": state["CGSSessionScreenIsLocked"] as? Bool ?? false,
    "onConsole": state["kCGSSessionOnConsoleKey"] as? Bool ?? true,
    "userName": state["kCGSSessionUserNameKey"] as? String ?? "",
    "known": true,
  ]
}

let payload: [String: Any] = [
  "frontmost": ["pid": front?.processIdentifier ?? 0, "name": front?.localizedName ?? ""],
  "displays": displays,
  "session": session,
  "list": out,
]
let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
FileHandle.standardOutput.write(data)
