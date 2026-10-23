// NodNative.swift — the Electrobun target's one macOS-native surface: keychain generic passwords,
// LocalAuthentication (`deviceOwnerAuthentication`), the app icon, `NSApp.hide`, tray icon rendering,
// and the app-modal open/save panels. The client is `electrobun/bun/facade/native.ts`.
//
// Why this is an in-process dylib, and not the stdio helper process the parity contract sketched
// (measured 2026-10-22, macOS 27.0.1 arm64, Electrobun 2.0.4, ad-hoc built bundle):
//
// - `lsappinfo` on a running Electrobun app reports the foreground application with
//   `executable path = <Name>.app/Contents/MacOS/bun` and a pid different from the launcher; the
//   bundle's own `launcher` process is only the parent. The Bun process *is* the app.
// - A SEPARATE helper process has a different process identity. It cannot own `NSApp`'s icon, its
//   `NSOpenPanel`/`NSSavePanel` and Touch ID sheet are attributed to the helper binary rather than
//   to Nod, and a keychain item it writes gets `kSecACL` naming the helper — every rebuild would
//   reprompt and a stale helper could read the item. That is exactly the ACL trap `docs/tinyjs.md`
//   §5 describes.
// - The Bun main process is a worker thread; AppKit lives on the process's main thread (the core's
//   `createWindowWithFrameAndStyleFromWorker`). Every AppKit call here therefore hops to the main
//   queue, and the JS thread blocks only for the duration of the call.
//
// Secrets never travel through argv, the environment or a log: `nodnative_request` takes ONE JSON
// request as an in-memory C string and returns ONE JSON response string. The facade keeps every
// value in JS memory and sends it here only for the `SecItem*` call.
//
// Requests (all with a string `id`, echoed in the response):
//   {"op":"keychain.get",    "service"?,"account"}
//   {"op":"keychain.set",    "service"?,"account","value"}
//   {"op":"keychain.delete", "service"?,"account"}
//   {"op":"canAuthenticate"}
//   {"op":"authenticate.begin", "reason"?}      -> {"token": string|null, "result"?: false}
//   {"op":"authenticate.poll",  "token"}        -> {"status":"pending"} | {"status":"done","result":bool}
//   {"op":"authenticate.cancel","token"}
//   {"op":"setAppIcon","path"}                  -> "" restores the bundle icon
//   {"op":"openFile","types"?: [...],"title"?}   -> path | null
//   {"op":"saveFile","types"?: [...],"name"?,"title"?} -> path | null
//   {"op":"setWindowFrame","target":"<NSWindow pointer>","frame":bool}      -> true when enqueued
//   {"op":"setContentMinSize","target":"<pointer>","width":n,"height":n}   -> true when enqueued
//   {"op":"views.list","target":"<NSWindow pointer>"}  -> [{ptr, class, hidden, frame, url?}]
//   {"op":"view.attach","view":"<NSView pointer>","target":"<NSWindow pointer>",
//    "x":n,"y":n,"width":n,"height":n,"autoresize":bool}                     -> true when moved
//   {"op":"view.url","view":"<NSView pointer>"}  -> the top document URL, or null
//   {"op":"hideApp"}                            -> true (NSApp.hide: focus returns to the previous app)
//   {"op":"setTerminationHold","enabled":bool}   -> true (opts the process in/out of automatic and
//                                                  sudden termination; armed by hide-on-close)
//   {"op":"renderTrayIcon","kind":"sf"|"emoji","value":<name|glyph>,"dir":<cache dir>} -> png path
// The two chrome ops are applied with `DispatchQueue.main.async` (Windows' slice owns the policy):
// Electrobun's window subclass makes a synchronous `setStyleMask:` through FFI abort the process.
// `service` defaults to the running app's bundle identifier, so the keychain namespace is the build
// identifier unless the caller overrides it.
//
// Authentication is begin/poll rather than one blocking call on purpose: `evaluatePolicy` presents a
// sheet while the app keeps running, and blocking the Bun loop for the whole time a person takes to
// answer would freeze every other backend task. The facade polls every 100 ms and cancels at its
// deadline.

import AppKit
import LocalAuthentication
import Security
import UniformTypeIdentifiers
import WebKit

// MARK: - Errors

private struct Failure: Error {
    let code: String
    let message: String
}

private func failure(_ code: String, _ message: String) -> Failure {
    Failure(code: code, message: message)
}

// MARK: - Shared state

/// Serializes requests: one JSON request is in flight at a time, so the response buffer has one owner.
private let requestLock = NSLock()
/// Guards the response buffer and the authentication records.
private let stateLock = NSLock()

private var responseBuffer: UnsafeMutablePointer<CChar>?

private final class AuthRecord {
    let context: LAContext
    var done = false
    var success = false
    let startedAt = Date()

    init(context: LAContext) {
        self.context = context
    }
}

private var authRecords: [String: AuthRecord] = [:]
private let authRecordLifetime: TimeInterval = 600

// MARK: - Threading helpers

/// Runs AppKit work on the process's main thread. The Bun runtime calls this library from its worker
/// thread; the Cocoa run loop is on the main thread (`electrobun_core_run_main_thread`).
private func onMainSync<T>(_ body: () -> T) -> T {
    if Thread.isMainThread {
        return body()
    }
    return DispatchQueue.main.sync(execute: body)
}

// MARK: - JSON helpers

private func encodeResponse(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]),
          let text = String(data: data, encoding: .utf8) else {
        return "{\"ok\":false,\"code\":\"internal\",\"error\":\"response encoding failed\"}"
    }
    return text
}

private func requiredString(_ key: String, _ request: [String: Any]) throws -> String {
    guard let value = request[key] as? String, !value.isEmpty else {
        throw failure("invalid", "missing \(key)")
    }
    return value
}

private func optionalString(_ key: String, _ request: [String: Any]) -> String? {
    guard let value = request[key] as? String else { return nil }
    return value
}

/// A string that may legitimately be empty but must be present (`keychain.set` with "").
private func presentString(_ key: String, _ request: [String: Any]) throws -> String {
    guard let value = request[key] as? String else {
        throw failure("invalid", "missing \(key)")
    }
    return value
}

private func requiredNumber(_ key: String, _ request: [String: Any]) throws -> Double {
    guard let value = request[key] as? Double else {
        throw failure("invalid", "missing \(key)")
    }
    return value
}

private func stringList(_ key: String, _ request: [String: Any]) -> [String] {
    guard let values = request[key] as? [Any] else { return [] }
    return values.compactMap { $0 as? String }
}

/// The keychain namespace: the build identifier, which the running bundle already carries. A caller
/// may pin a different one (exports/smokes); nothing here guesses from the data directory.
private func keychainService(_ request: [String: Any]) throws -> String {
    if let service = optionalString("service", request), !service.isEmpty {
        return service
    }
    if let identifier = Bundle.main.bundleIdentifier, !identifier.isEmpty {
        return identifier
    }
    throw failure("invalid", "no keychain service: request has none and the bundle has no identifier")
}

// MARK: - Keychain

private func genericPasswordQuery(service: String, account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

private func keychainStatusError(_ status: OSStatus, while doing: String) -> Failure {
    let detail = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return failure("keychain", "\(doing): \(detail)")
}

private func keychainGet(service: String, account: String) throws -> Any {
    var query = genericPasswordQuery(service: service, account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    switch status {
    case errSecSuccess:
        guard let data = item as? Data else {
            return NSNull()
        }
        guard let value = String(data: data, encoding: .utf8) else {
            throw failure("encoding", "stored value is not UTF-8")
        }
        return value
    case errSecItemNotFound:
        return NSNull()
    default:
        throw keychainStatusError(status, while: "keychain get")
    }
}

private func keychainSet(service: String, account: String, value: String) throws -> Any {
    guard let data = value.data(using: .utf8) else {
        throw failure("encoding", "value is not UTF-8")
    }
    let query = genericPasswordQuery(service: service, account: account)
    let update: [String: Any] = [kSecValueData as String: data]
    let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
    if updateStatus == errSecItemNotFound {
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        let addStatus = SecItemAdd(insert as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw keychainStatusError(addStatus, while: "keychain set")
        }
        return true
    }
    guard updateStatus == errSecSuccess else {
        throw keychainStatusError(updateStatus, while: "keychain set")
    }
    return true
}

private func keychainDelete(service: String, account: String) throws -> Any {
    let status = SecItemDelete(genericPasswordQuery(service: service, account: account) as CFDictionary)
    switch status {
    case errSecSuccess:
        return true
    case errSecItemNotFound:
        return false
    default:
        throw keychainStatusError(status, while: "keychain delete")
    }
}

// MARK: - Authentication

/// Removes and returns the expired records. Called with `stateLock` held; the caller invalidates the
/// contexts AFTER unlocking, because `invalidate()` may deliver the evaluation completion, which
/// takes the same lock.
private func pruneAuthRecords(now: Date) -> [AuthRecord] {
    let expired = authRecords.filter {
        now.timeIntervalSince($0.value.startedAt) > authRecordLifetime
    }
    for token in expired.keys {
        authRecords.removeValue(forKey: token)
    }
    return Array(expired.values)
}

private func canAuthenticate() -> Bool {
    let context = LAContext()
    var error: NSError?
    return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
}

private func beginAuthentication(reason rawReason: String?) throws -> Any {
    let reason = (rawReason?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
        ? rawReason!
        : "Confirm your identity"

    let context = LAContext()
    context.localizedCancelTitle = "Cancel"
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
        return ["token": NSNull(), "result": false]
    }

    let token = UUID().uuidString
    let record = AuthRecord(context: context)
    stateLock.lock()
    let expired = pruneAuthRecords(now: Date())
    authRecords[token] = record
    stateLock.unlock()
    for stale in expired {
        stale.context.invalidate()
    }

    DispatchQueue.main.async {
        NSApp.activate(ignoringOtherApps: true)
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
            stateLock.lock()
            record.success = success
            record.done = true
            stateLock.unlock()
        }
    }

    return ["token": token]
}

private func pollAuthentication(token: String) -> Any {
    stateLock.lock()
    guard let record = authRecords[token] else {
        stateLock.unlock()
        return ["status": "done", "result": false]
    }
    if record.done {
        authRecords.removeValue(forKey: token)
        let success = record.success
        stateLock.unlock()
        return ["status": "done", "result": success]
    }
    if Date().timeIntervalSince(record.startedAt) > authRecordLifetime {
        authRecords.removeValue(forKey: token)
        stateLock.unlock()
        record.context.invalidate()
        return ["status": "done", "result": false]
    }
    stateLock.unlock()
    return ["status": "pending"]
}

private func cancelAuthentication(token: String) -> Any {
    stateLock.lock()
    let record = authRecords.removeValue(forKey: token)
    stateLock.unlock()
    record?.context.invalidate()
    return true
}

// MARK: - App icon

/// The icon `Info.plist` names, else the Finder icon of the .app. Measured: restoring `nil` or a
/// captured `applicationIconImage` can leave the replaced Dock tile in place, so `''` loads the
/// bundle icon explicitly.
private func bundleAppIcon() -> NSImage? {
    if let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String, !name.isEmpty {
        let file = name.hasSuffix(".icns") ? name : name + ".icns"
        if let path = Bundle.main.path(forResource: file, ofType: nil),
           let image = NSImage(contentsOfFile: path) {
            return image
        }
    }
    return NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
}

private func setAppIcon(path: String) throws -> Any {
    var image: NSImage?
    if !path.isEmpty {
        guard let loaded = NSImage(contentsOfFile: path) else {
            throw failure("invalid", "not a readable image: \(path)")
        }
        image = loaded
    }
    onMainSync {
        NSApp.applicationIconImage = path.isEmpty ? bundleAppIcon() : image
    }
    return NSNull()
}

// MARK: - App hide

/// `NSApp.hide`: every window goes away and focus returns to the previously active app. The Bun
/// process owns `NSApp` (see the header), so this is the same hide the tinyjs target performs; menu
/// bar windows that live in another process (a tray item) keep the app reachable.
private func hideApplication() -> Any {
    onMainSync {
        guard let application = NSApp else { return false }
        application.hide(nil)
        return true
    }
}

// MARK: - Termination hold

/// Main-thread only (every access is inside `onMainSync`): `ProcessInfo`'s two counters are nesting
/// counters, so the same state must never be armed twice.
private var terminationHeld = false

/// Opts the process out of the two ways macOS reclaims an app that is not doing anything.
///
/// `backend/main.ts` arms this while `setHideOnClose(true)` is in effect (Nod lives in the tray) and
/// a real quit releases it. `disableAutomaticTermination` keeps AppKit from posting a Quit AppleEvent
/// for an idle app of its own accord; `disableSuddenTermination` keeps the system from SIGKILLing a
/// process that holds the unlocked session in memory.
///
/// Measured limit (2026-10-22, macOS 27 arm64): neither call stops a Quit AppleEvent sent by ANOTHER
/// application. The packaged check got one from the machine's "quit apps when their last window
/// closes" menu-bar tool ~1.5 s after the window hid, and Electrobun's delegate forwards every Quit
/// AppleEvent to `Utils.quit()`. The window itself therefore has to stay in AppKit's window list,
/// which is why `facade/windows.ts` hides the app (not just the window) when `main` is the last
/// window.
private func setTerminationHold(enabled: Bool) -> Any {
    onMainSync {
        guard enabled != terminationHeld else { return true }
        let info = ProcessInfo.processInfo
        if enabled {
            info.disableAutomaticTermination("Nod keeps running in the tray while its window is hidden")
            info.disableSuddenTermination()
        } else {
            info.enableAutomaticTermination("Nod is quitting")
            info.enableSuddenTermination()
        }
        terminationHeld = enabled
        NSLog("[NodNative] termination hold %@", enabled ? "armed" : "released")
        return true
    }
}

// MARK: - Tray icon rendering

/// FNV-1a over the UTF-8 bytes: one stable file name per spec, so a repeated `tray.set` reuses the
/// png instead of growing the cache directory.
private func trayIconFileName(kind: String, value: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in "\(kind)\u{0}\(value)".utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 0x0000_0100_0000_01b3
    }
    return "tray-\(kind)-\(String(hash, radix: 16)).png"
}

/// An 18 pt menu-bar image. An SF Symbol stays a template image (the system tints it for the menu
/// bar's appearance); an emoji is drawn from its attributed string, which keeps the glyph's colors.
private func trayImage(kind: String, value: String) -> NSImage? {
    if kind == "sf" {
        guard let symbol = NSImage(systemSymbolName: value, accessibilityDescription: nil) else {
            return nil
        }
        symbol.size = NSSize(width: 18, height: 18)
        symbol.isTemplate = true
        return symbol
    }
    guard kind == "emoji" else { return nil }
    let size = NSSize(width: 18, height: 18)
    return NSImage(size: size, flipped: false) { rect in
        let text = NSAttributedString(
            string: value,
            attributes: [.font: NSFont.systemFont(ofSize: 15)]
        )
        let box = text.size()
        text.draw(at: NSPoint(x: rect.midX - box.width / 2, y: rect.midY - box.height / 2))
        return true
    }
}

/// Draws the spec to a png under `dir` and answers the path. `dir` is the app's cache/temp dir, so
/// nothing outside the app's own storage is written.
private func renderTrayIcon(kind: String, value: String, dir: String) throws -> Any {
    guard !dir.isEmpty else { throw failure("invalid", "missing dir") }
    guard !value.isEmpty else { throw failure("invalid", "missing value") }
    let directory = URL(fileURLWithPath: dir, isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    } catch {
        throw failure("io", "cannot create \(dir): \(error.localizedDescription)")
    }
    let image: NSImage? = onMainSync { trayImage(kind: kind, value: value) }
    guard let image, let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        throw failure("invalid", "cannot render tray icon \(kind):\(value)")
    }
    let url = directory.appendingPathComponent(trayIconFileName(kind: kind, value: value))
    do {
        try png.write(to: url, options: .atomic)
    } catch {
        throw failure("io", "cannot write \(url.path): \(error.localizedDescription)")
    }
    return url.path
}

// MARK: - File panels

/// Extensions such as `json`, `jsonl` and the Nod's own `nodvault` are not declared UTTypes, so the
/// extension list is what restricts the panel — `allowedContentTypes` alone would silently allow
/// every file for `nodvault`.
private func applyDialogTypes(_ rawTypes: [String], to panel: NSSavePanel) {
    let types = rawTypes
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .map { $0.hasPrefix(".") ? String($0.dropFirst()) : $0 }
        .filter { !$0.isEmpty }
    guard !types.isEmpty else { return }
    panel.allowedFileTypes = types
    panel.allowsOtherFileTypes = false
    panel.isExtensionHidden = false
}

private func openFilePanel(types: [String], title: String?) -> Any {
    onMainSync {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        if let title, !title.isEmpty { panel.message = title }
        applyDialogTypes(types, to: panel)
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return NSNull() }
        return url.path
    }
}

private func saveFilePanel(types: [String], name: String?, title: String?) -> Any {
    onMainSync {
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        if let title, !title.isEmpty { panel.message = title }
        applyDialogTypes(types, to: panel)
        if let name, !name.isEmpty { panel.nameFieldStringValue = name }
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return NSNull() }
        return url.path
    }
}

// MARK: - Window chrome (policy is Windows' slice; this is the AppKit primitive)

/// `target` is `BrowserWindow.ptr` in decimal: the live `NSWindow*` (an `ElectrobunWindow`
/// subclass). A dead pointer is a contract violation; resolving it here is deliberately narrow.
private func windowFromTarget(_ target: String) -> NSWindow? {
    guard let raw = UInt64(target), raw != 0,
          let pointer = UnsafeMutableRawPointer(bitPattern: UInt(raw)) else { return nil }
    let object = Unmanaged<AnyObject>.fromOpaque(pointer).takeUnretainedValue()
    return object as? NSWindow
}

/// Enqueues the style-mask flip on the main queue and returns immediately. Measured on Electrobun
/// 2.0.4: `setStyleMask:` through a synchronous FFI call kills the Bun process (its window subclass
/// reacts synchronously); running it on the main queue after the FFI call returned does not.
private func setWindowFrameChrome(target: String, frame: Bool) -> Any {
    guard let window = windowFromTarget(target) else { return false }
    DispatchQueue.main.async {
        let delegate = window.delegate
        window.delegate = nil
        window.styleMask = frame
            ? [.titled, .closable, .miniaturizable, .resizable]
            : [.resizable, .fullSizeContentView]
        window.delegate = delegate
    }
    return true
}

private func setContentMinSizeChrome(target: String, width: Double, height: Double) -> Any {
    guard let window = windowFromTarget(target) else { return false }
    let size = NSSize(width: width, height: height)
    DispatchQueue.main.async {
        let delegate = window.delegate
        window.delegate = nil
        window.contentMinSize = size
        window.delegate = delegate
    }
    return true
}

// MARK: - Webview re-parent (the AppKit primitive of a docked tab; the policy is Windows' slice)
//
// Electrobun 2.0.4 has no re-parent API. A webview's NSView is a direct child of its window's
// content view, and the core lays the views of a window out on every layout pass. Showing a docked
// tab inside the Nod window and detaching it again without a reload therefore means moving the live
// WKWebView itself, which is what these two ops do.
//
// The pointer a caller passes is the one `views.list` reported (an AppKit object). The core's
// `getWebviewPointer` is NOT an NSView — measured: it answers a different address for the same
// webview — so it is never dereferenced here. `view.attach` also refuses a pointer it cannot find
// in a live content view: the value is compared, never cast.

/// Keeps a moved view alive across `removeFromSuperview` (Electrobun's map is not ours to assume).
private var retainedViews: [NSView] = []

private func pointerString(_ view: NSView) -> String {
    String(UInt64(UInt(bitPattern: Unmanaged.passUnretained(view).toOpaque())))
}

/// The WKWebView inside a subtree (`depth` bounds the walk); nil when there is none.
private func findWebView(in view: NSView, depth: Int) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    if depth <= 0 { return nil }
    for sub in view.subviews {
        if let found = findWebView(in: sub, depth: depth - 1) { return found }
    }
    return nil
}

private func findView(pointer: String, in root: NSView) -> NSView? {
    if pointerString(root) == pointer { return root }
    for sub in root.subviews {
        if let found = findView(pointer: pointer, in: sub) { return found }
    }
    return nil
}

/// The live views this library may move: only AppKit objects reachable from a window's content view.
private func liveView(pointer: String) -> NSView? {
    guard pointer != "" else { return nil }
    for window in NSApplication.shared.windows {
        guard let root = window.contentView else { continue }
        if let found = findView(pointer: pointer, in: root) { return found }
    }
    return nil
}

/// The URL of the view's **top** document. Electrobun's navigation events also fire for subframes and
/// carry no frame flag (measured: a claude.ai page reported its hCaptcha iframe), so the facade
/// compares each reported URL with this reading before it feeds the gate and the tab title.
private func viewUrl(pointer: String) -> Any {
    guard let view = liveView(pointer: pointer) else { return NSNull() }
    guard let web = findWebView(in: view, depth: 4) else { return NSNull() }
    return web.url?.absoluteString ?? NSNull()
}

/// Every direct child of a window's content view (a webview is one of them), with the URL of the
/// WKWebView inside it when there is one. `ptr` is what `view.attach` takes.
private func viewList(target: String) -> Any {
    guard let window = windowFromTarget(target), let content = window.contentView else { return [] }
    return content.subviews.map { (child: NSView) -> [String: Any] in
        var entry: [String: Any] = [
            "ptr": pointerString(child),
            "class": String(cString: object_getClassName(child)),
            "hidden": child.isHidden,
            "frame": [
                "x": Double(child.frame.origin.x),
                "y": Double(child.frame.origin.y),
                "width": Double(child.frame.size.width),
                "height": Double(child.frame.size.height),
            ],
        ]
        if let web = findWebView(in: child, depth: 4) {
            entry["url"] = web.url?.absoluteString ?? ""
            entry["title"] = web.title ?? ""
        }
        return entry
    }
}

/// Moves a live NSView into `target`'s content view at a top-left rect (AppKit is bottom-left).
/// `autoresize` is for a view that should fill its window (a detached tab); a docked tab is placed
/// by the facade on every layout pass instead, so it does not follow the window on its own.
private func attachView(
    viewPointer: String,
    target: String,
    x: Double,
    y: Double,
    width: Double,
    height: Double,
    autoresize: Bool
) -> Any {
    guard let window = windowFromTarget(target), let content = window.contentView else {
        return false
    }
    guard let view = liveView(pointer: viewPointer) else { return false }
    if !retainedViews.contains(where: { $0 === view }) {
        retainedViews.append(view)
    }
    view.removeFromSuperview()
    content.addSubview(view)
    let w = width > 0 ? CGFloat(width) : content.bounds.width
    let h = height > 0 ? CGFloat(height) : content.bounds.height
    view.frame = NSRect(
        x: CGFloat(x),
        y: content.bounds.height - CGFloat(y) - h,
        width: w,
        height: h
    )
    view.autoresizingMask = autoresize ? [.width, .height] : []
    view.needsLayout = true
    view.layoutSubtreeIfNeeded()
    return true
}

// MARK: - Dispatch

private func perform(op: String, request: [String: Any]) throws -> Any {
    switch op {
    case "keychain.get":
        return try keychainGet(
            service: keychainService(request),
            account: requiredString("account", request)
        )
    case "keychain.set":
        return try keychainSet(
            service: keychainService(request),
            account: requiredString("account", request),
            value: presentString("value", request)
        )
    case "keychain.delete":
        return try keychainDelete(
            service: keychainService(request),
            account: requiredString("account", request)
        )
    case "canAuthenticate":
        return canAuthenticate()
    case "authenticate.begin":
        return try beginAuthentication(reason: optionalString("reason", request))
    case "authenticate.poll":
        return pollAuthentication(token: try requiredString("token", request))
    case "authenticate.cancel":
        return cancelAuthentication(token: try requiredString("token", request))
    case "setAppIcon":
        return try setAppIcon(path: optionalString("path", request) ?? "")
    case "hideApp":
        return hideApplication()
    case "setTerminationHold":
        guard let enabled = request["enabled"] as? Bool else {
            throw failure("invalid", "missing enabled")
        }
        return setTerminationHold(enabled: enabled)
    case "renderTrayIcon":
        return try renderTrayIcon(
            kind: try requiredString("kind", request),
            value: try requiredString("value", request),
            dir: try requiredString("dir", request)
        )
    case "openFile":
        return openFilePanel(
            types: stringList("types", request),
            title: optionalString("title", request)
        )
    case "saveFile":
        return saveFilePanel(
            types: stringList("types", request),
            name: optionalString("name", request),
            title: optionalString("title", request)
        )
    case "setWindowFrame":
        return setWindowFrameChrome(
            target: try requiredString("target", request),
            frame: (request["frame"] as? Bool) ?? false
        )
    case "setContentMinSize":
        return setContentMinSizeChrome(
            target: try requiredString("target", request),
            width: try requiredNumber("width", request),
            height: try requiredNumber("height", request)
        )
    case "views.list":
        let listTarget = try requiredString("target", request)
        return onMainSync { viewList(target: listTarget) }
    case "view.url":
        let urlPointer = optionalString("view", request) ?? ""
        return onMainSync { viewUrl(pointer: urlPointer) }
    case "view.attach":
        let attachTarget = try requiredString("target", request)
        let viewPointer = optionalString("view", request) ?? ""
        let rect = (
            x: (request["x"] as? Double) ?? 0,
            y: (request["y"] as? Double) ?? 0,
            width: (request["width"] as? Double) ?? 0,
            height: (request["height"] as? Double) ?? 0
        )
        let autoresize = (request["autoresize"] as? Bool) ?? false
        return onMainSync {
            attachView(
                viewPointer: viewPointer,
                target: attachTarget,
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                autoresize: autoresize
            )
        }
    default:
        throw failure("unknown_op", "unknown op: \(op)")
    }
}

private func dispatchRequest(_ raw: UnsafePointer<CChar>?) -> (id: Any, json: String) {
    var identifier: Any = NSNull()
    do {
        guard let raw else {
            throw failure("invalid", "missing request")
        }
        let data = Data(bytes: raw, count: strlen(raw))
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw failure("invalid", "request must be a JSON object")
        }
        identifier = object["id"] ?? NSNull()
        let op = object["op"] as? String ?? ""
        let result = try perform(op: op, request: object)
        return (identifier, encodeResponse(["id": identifier, "ok": true, "result": result]))
    } catch let error as Failure {
        return (identifier, encodeResponse([
            "id": identifier,
            "ok": false,
            "code": error.code,
            "error": error.message,
        ]))
    } catch {
        return (identifier, encodeResponse([
            "id": identifier,
            "ok": false,
            "code": "internal",
            "error": String(describing: error),
        ]))
    }
}

// MARK: - C entry point

/// One JSON request in, one JSON response out. The returned pointer is owned by this library and is
/// valid until the next request; Bun's `cstring` return converts it to a JS string synchronously.
@_cdecl("nodnative_request")
public func nodnative_request(_ request: UnsafePointer<CChar>?) -> UnsafePointer<CChar>? {
    requestLock.lock()
    defer { requestLock.unlock() }

    let (_, json) = dispatchRequest(request)

    stateLock.lock()
    if let previous = responseBuffer {
        free(previous)
    }
    responseBuffer = strdup(json)
    let result = responseBuffer.map { UnsafePointer($0) }
    stateLock.unlock()
    return result
}
