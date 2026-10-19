import Cocoa
import Carbon
import WebKit

// Global C callback for Carbon RegisterEventHotKey (works in ALL macOS apps with zero Input Monitoring permission)
private var sharedAgent: GlaidoMacAgent?

private func hotKeyHandler(
    nextHandler: EventHandlerCallRef?,
    theEvent: EventRef?,
    userData: UnsafeMutableRawPointer?
) -> OSStatus {
    DispatchQueue.main.async {
        sharedAgent?.toggleDictationFromGlobalHotkey()
    }
    return noErr
}

final class GlaidoMacAgent: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private var mainWindow: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var hudPanel: NSPanel!
    private var overlayWebView: WKWebView!
    private var isRecording = false
    private var targetApp: NSRunningApplication?
    private var hotKeyRef1: EventHotKeyRef?
    private var hotKeyRef2: EventHotKeyRef?
    private var lastRightOptionDown = false
    private var lastFnKeyDown = false
    private var watchdogTimer: Timer?
    private var isSpawningBackend = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        sharedAgent = self
        ensureBackendServerRunning()
        setupMenuBar()
        setupMainWindow()
        setupFloatingOverlay()
        registerGlobalHotKeys()
        startWatchdogTimer()

        // Show main window on launch, keep floating dictation bar hidden until dictation starts
        NSApp.activate(ignoringOtherApps: true)
        mainWindow.makeKeyAndOrderFront(nil)
        hudPanel.orderOut(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        ensureBackendServerRunning()
        mainWindow.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender == mainWindow {
            // Hide main window when not in use so it can reopen instantly
            mainWindow.orderOut(nil)
            return false
        }
        return true
    }

    private func startWatchdogTimer() {
        watchdogTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] _ in
            self?.ensureBackendServerRunning()
        }
    }

    private func ensureBackendServerRunning() {
        guard !isSpawningBackend, let url = URL(string: "http://127.0.0.1:4321/api/invoke") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{\"cmd\":\"get_recording_state\"}".utf8)
        req.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, err in
            if err != nil || resp == nil {
                DispatchQueue.main.async {
                    self?.spawnBackendServer()
                }
            }
        }.resume()
    }

    private func spawnBackendServer() {
        guard !isSpawningBackend else { return }
        isSpawningBackend = true
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/zsh")
        task.arguments = [
            "-c",
            "export PATH=\"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH\"; if ! pgrep -f glaido-keepalive >/dev/null 2>&1; then cd '/Users/pranavgoel/Downloads/AntiGravity Reverse Engineer/glaido-replica' && nohup /opt/homebrew/bin/node --no-warnings server.mjs >/tmp/glaido-pro.log 2>&1 & fi"
        ]
        try? task.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self = self else { return }
            self.isSpawningBackend = false
            if let mainUrl = URL(string: "http://127.0.0.1:4321/") {
                self.webView?.load(URLRequest(url: mainUrl))
            }
            if let overlayUrl = URL(string: "http://127.0.0.1:4321/overlay.html") {
                self.overlayWebView?.load(URLRequest(url: overlayUrl))
            }
        }
    }

    private func setupMainWindow() {
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width: CGFloat = min(1240, screenRect.width - 80)
        let height: CGFloat = min(800, screenRect.height - 80)
        let x = screenRect.midX - width / 2
        let y = screenRect.midY - height / 2

        mainWindow = NSWindow(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        mainWindow.title = "Glaido Pro"
        mainWindow.titleVisibility = .hidden
        mainWindow.titlebarAppearsTransparent = true
        mainWindow.backgroundColor = NSColor(calibratedWhite: 0.05, alpha: 1.0)
        mainWindow.delegate = self

        let cfg = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        mainWindow.contentView = webView

        if let url = URL(string: "http://127.0.0.1:4321/") {
            webView.load(URLRequest(url: url))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                if self?.webView.url == nil {
                    self?.webView.load(URLRequest(url: url))
                }
            }
        }
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let btn = statusItem.button {
            btn.title = ""
            let bundleIconPath = (Bundle.main.resourcePath ?? "") + "/tray-icon.png"
            let fallbackIconPath = "/Users/pranavgoel/Downloads/AntiGravity Reverse Engineer/glaido-replica/macos-agent/tray-icon-0.png"
            let iconPath = FileManager.default.fileExists(atPath: bundleIconPath) ? bundleIconPath : fallbackIconPath
            if let img = NSImage(contentsOfFile: iconPath) {
                img.size = NSSize(width: 18, height: 18)
                img.isTemplate = true
                btn.image = img
                btn.imagePosition = .imageOnly
            }
        }
        rebuildMenu()
    }

    private func rebuildMenu() {
        let menu = NSMenu()

        // Exact original Glaido tray menu structure: Microphone ▸, separator, Show Glaido Pro, Quit
        let micItem = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        let micSubmenu = NSMenu(title: "Microphone")

        let autoMicItem = NSMenuItem(title: "System Default (MacBook Pro Microphone)", action: #selector(selectDefaultMicAction), keyEquivalent: "")
        autoMicItem.target = self
        autoMicItem.state = .on
        micSubmenu.addItem(autoMicItem)

        micSubmenu.addItem(NSMenuItem.separator())

        let builtInMicItem = NSMenuItem(title: "MacBook Pro Microphone", action: #selector(selectDefaultMicAction), keyEquivalent: "")
        builtInMicItem.target = self
        micSubmenu.addItem(builtInMicItem)

        menu.setSubmenu(micSubmenu, for: micItem)
        menu.addItem(micItem)

        menu.addItem(NSMenuItem.separator())

        let showItem = NSMenuItem(title: "Show Glaido Pro", action: #selector(showDashboardWindow), keyEquivalent: "")
        showItem.target = self
        menu.addItem(showItem)

        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc private func selectDefaultMicAction() {
        // Keep System Default checked
    }

    private func setupFloatingOverlay() {
        // Exact original Glaido /overlay.html capsule dimensions at bottom-center of screen (hidden when idle)
        let width: CGFloat = 240
        let height: CGFloat = 68
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = screenRect.midX - width / 2
        let y = screenRect.minY + 10

        hudPanel = NSPanel(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        hudPanel.level = .statusBar
        hudPanel.isOpaque = false
        hudPanel.backgroundColor = .clear
        hudPanel.hasShadow = false
        hudPanel.ignoresMouseEvents = false
        hudPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]

        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "glaidoOverlay")

        overlayWebView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
        overlayWebView.setValue(false, forKey: "drawsBackground")
        overlayWebView.autoresizingMask = [.width, .height]
        hudPanel.contentView = overlayWebView

        if let url = URL(string: "http://127.0.0.1:4321/overlay.html") {
            overlayWebView.load(URLRequest(url: url))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
                if self?.overlayWebView.url == nil {
                    self?.overlayWebView.load(URLRequest(url: url))
                }
            }
        }

        // Start hidden when not being used
        hudPanel.alphaValue = 0.0
        hudPanel.orderOut(nil)
    }

    private func showOverlayPill() {
        if let screenRect = NSScreen.main?.visibleFrame {
            let width = hudPanel.frame.width
            let x = screenRect.midX - width / 2
            let y = screenRect.minY + 10
            hudPanel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        hudPanel.alphaValue = 1.0
        hudPanel.orderFrontRegardless()
    }

    private func hideOverlayPill() {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.16
            self.hudPanel.animator().alphaValue = 0.0
        }, completionHandler: { [weak self] in
            guard let self = self, !self.isRecording else { return }
            self.hudPanel.orderOut(nil)
        })
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "glaidoOverlay" {
            DispatchQueue.main.async {
                self.toggleDictationFromGlobalHotkey()
            }
        }
    }

    private func registerGlobalHotKeys() {
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyHandler,
            1,
            &eventType,
            nil,
            nil
        )

        // 1. Option + Space (keyCode 49, optionKey = 0x0800)
        let id1 = EventHotKeyID(signature: OSType(0x474C4431), id: 1)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id1, GetApplicationEventTarget(), 0, &hotKeyRef1)

        // 2. Control + Space (keyCode 49, controlKey = 0x1000)
        let id2 = EventHotKeyID(signature: OSType(0x474C4432), id: 2)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey), id2, GetApplicationEventTarget(), 0, &hotKeyRef2)

        // 3. Right Option (keyCode 61) via NSEvent global + local monitor
        NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
        }
        NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        if event.keyCode == 61 {
            let isOptionDown = event.modifierFlags.contains(.option)
            if isOptionDown && !lastRightOptionDown {
                lastRightOptionDown = true
                DispatchQueue.main.async {
                    self.toggleDictationFromGlobalHotkey()
                }
            } else if !isOptionDown {
                lastRightOptionDown = false
            }
        } else if event.keyCode == 63 {
            let isFnDown = event.modifierFlags.contains(.function)
            if isFnDown && !lastFnKeyDown {
                lastFnKeyDown = true
                DispatchQueue.main.async {
                    self.toggleDictationFromGlobalHotkey()
                }
            } else if !isFnDown {
                lastFnKeyDown = false
            }
        }
    }

    func toggleDictationFromGlobalHotkey() {
        if !isRecording {
            if let front = NSWorkspace.shared.frontmostApplication,
               front.bundleIdentifier != Bundle.main.bundleIdentifier {
                targetApp = front
            }
            isRecording = true
            let appName = targetApp?.localizedName ?? "Active App"

            // Show the floating bottom bar only while actively recording/processing
            showOverlayPill()

            postInvoke(cmd: "mac_global_dictation_start", args: [
                "appName": appName,
                "bundleId": targetApp?.bundleIdentifier ?? "com.google.antigravity-ide"
            ]) { _ in }
        } else {
            isRecording = false
            let appName = targetApp?.localizedName ?? "Active App"

            if let app = targetApp {
                app.activate()
            }

            postInvoke(cmd: "mac_global_dictation_stop", args: [
                "appName": appName,
                "bundleId": targetApp?.bundleIdentifier ?? "com.google.antigravity-ide"
            ]) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    guard let self = self, !self.isRecording else { return }
                    self.hideOverlayPill()
                }
            }
        }
    }

    private func postInvoke(cmd: String, args: [String: Any], completion: @escaping ([String: Any]?) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:4321/api/invoke") else {
            completion(nil)
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["cmd": cmd, "args": args]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let result = json["result"] as? [String: Any] else {
                completion(nil)
                return
            }
            completion(result)
        }.resume()
    }

    @objc private func showDashboardWindow() {
        NSApp.activate(ignoringOtherApps: true)
        mainWindow.makeKeyAndOrderFront(nil)
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = GlaidoMacAgent()
app.delegate = delegate
app.run()
