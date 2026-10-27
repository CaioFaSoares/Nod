// One real left click at a point of the window server's space, for the E03 smoke
// (`test/smoke/tabs.ts`, `/desk/click`). A DOM `el.click()` never goes through AppKit's hit test,
// so it cannot see a native view laid over the page; this posts the same `CGEvent`s a mouse does.
//
//   click <x> <y> <pid,pid,...>
//
// The click lands only when the topmost on-screen window at the point belongs to one of the given
// pids (this run's own app): a window of another app in the way exits 3 with its owner on stdout,
// and no window at all exits 4, so the smoke never clicks into somebody else's work.
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 4, let x = Double(args[1]), let y = Double(args[2]) else {
  FileHandle.standardError.write("usage: click <x> <y> <pid,pid,...>\n".data(using: .utf8)!)
  exit(2)
}
let allowed = Set(args[3].split(separator: ",").compactMap { Int($0) })
let point = CGPoint(x: x, y: y)

let options = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
var owner: (pid: Int, name: String)? = nil
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
    owner = (window[kCGWindowOwnerPID as String] as? Int ?? 0, window[kCGWindowOwnerName as String] as? String ?? "")
    break
  }
}
guard let top = owner else {
  print("no window at \(x),\(y)")
  exit(4)
}
guard allowed.contains(top.pid) else {
  print("covered by \(top.name) (pid \(top.pid))")
  exit(3)
}

func post(_ type: CGEventType) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cghidEventTap)
}
post(.mouseMoved)
usleep(80_000)
post(.leftMouseDown)
usleep(40_000)
post(.leftMouseUp)
print("clicked \(x),\(y)")
