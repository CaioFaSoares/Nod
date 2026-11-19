// One real left click at a point of the window server's space, for the E03 smoke
// (`test/smoke/tabs.ts`, `/desk/click`). A DOM `el.click()` never goes through AppKit's hit test,
// so it cannot see a native view laid over the page; this posts the same `CGEvent`s a mouse does.
//
//   click <x> <y> <main-pid> <main-CGWindowNumber>
//
// The click lands only when the topmost on-screen window at the point has BOTH the captured main
// window's pid and CGWindowNumber. Titles may be unavailable without Screen Recording permission;
// an unnamed tool window of the same process must still never receive the click. Anything else in
// the way exits 3, and no window at all exits 4, without posting any event.
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 5, let x = Double(args[1]), let y = Double(args[2]),
      x.isFinite, y.isFinite,
      let wantedPid = Int(args[3]), wantedPid > 0,
      let wantedId = Int(args[4]), wantedId > 0 else {
  FileHandle.standardError.write("usage: click <x> <y> <main-pid> <main-CGWindowNumber>\n".data(using: .utf8)!)
  exit(2)
}
let point = CGPoint(x: x, y: y)

let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
var owner: (id: Int, pid: Int, name: String, title: String)? = nil
for window in list {
  guard (window[kCGWindowLayer as String] as? Int ?? 0) == 0,
        let bounds = window[kCGWindowBounds as String] as? [String: Any] else { continue }
  let rect = CGRect(
    x: (bounds["X"] as? NSNumber)?.doubleValue ?? 0,
    y: (bounds["Y"] as? NSNumber)?.doubleValue ?? 0,
    width: (bounds["Width"] as? NSNumber)?.doubleValue ?? 0,
    height: (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
  )
  if rect.contains(point) {
    owner = (
      window[kCGWindowNumber as String] as? Int ?? 0,
      window[kCGWindowOwnerPID as String] as? Int ?? 0,
      window[kCGWindowOwnerName as String] as? String ?? "",
      window[kCGWindowName as String] as? String ?? ""
    )
    break
  }
}
guard let top = owner else {
  print("no window at \(x),\(y)")
  exit(4)
}
guard top.pid == wantedPid, top.id == wantedId else {
  print("covered by \(top.name) window \"\(top.title)\" (pid \(top.pid), CGWindowNumber \(top.id)); expected main \(wantedPid)/\(wantedId)")
  exit(3)
}

guard CGPreflightPostEventAccess() else {
  print("macOS has not authorized this smoke helper to post input events (Accessibility)")
  exit(5)
}
func post(_ type: CGEventType) {
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
    print("could not create mouse event \(type.rawValue)")
    exit(6)
  }
  event.post(tap: .cghidEventTap)
}
post(.mouseMoved)
usleep(80_000)
post(.leftMouseDown)
usleep(40_000)
post(.leftMouseUp)
print("clicked \(x),\(y)")
