const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  screen,
  nativeImage,
  session,
  shell,
  clipboard,
  systemPreferences
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

let PORT = Number(process.env.PORT || 4321);
let BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_SMOKE_TEST = process.argv.includes("--smoke-test") || process.env.GLAIDO_SMOKE_TEST === "1";
const IS_E2E_TEST = process.argv.includes("--e2e-test") || process.env.GLAIDO_E2E_TEST === "1";

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isQuitting = false;
let isRecording = false;
let isProcessing = false;
let winPasteWorker = null;
let hasShownTrayBalloon = false;

// Configure writable data directory & startup logger
const userDataDir = app.getPath("userData");
fs.mkdirSync(userDataDir, { recursive: true });
process.env.GLAIDO_DATA_DIR = userDataDir;
process.env.GLAIDO_TARGET_OS = process.platform === "win32" ? "windows" : "macos";

const logFilePath = path.join(userDataDir, "glaido-startup.log");
function logStartup(msg) {
  try {
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

// Terminate any orphaned/zombie Glaido Pro.exe processes from earlier runs on Windows
// so SingleInstanceLock and port 4321 are never deadlocked
function killOrphanedWindowsInstancesSync() {
  if (process.platform !== "win32" || IS_SMOKE_TEST || IS_E2E_TEST) return;
  try {
    const currentPid = process.pid;
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Glaido*' -and $_.ProcessId -ne ${currentPid} -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psCmd], {
      timeout: 3000,
      windowsHide: true,
      stdio: "ignore"
    });
  } catch (_) {}
}

killOrphanedWindowsInstancesSync();

function findAvailablePort(startPort, maxAttempts = 20) {
  return new Promise((resolve) => {
    const testNext = (port, attemptsLeft) => {
      if (attemptsLeft <= 0) return resolve(startPort);
      const tester = net.createServer();
      tester.unref();
      tester.on("error", (err) => {
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
          testNext(port + 1, attemptsLeft - 1);
        } else {
          resolve(port);
        }
      });
      tester.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        tester.close(() => resolve(port));
      });
    };
    testNext(startPort, maxAttempts);
  });
}

// Ensure single instance (skip during CI smoke test and e2e test)
if (!IS_SMOKE_TEST && !IS_E2E_TEST) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    logStartup("SingleInstanceLock held by active instance; exiting secondary process.");
    app.quit();
  } else {
    app.on("second-instance", () => {
      logStartup("second-instance triggered.");
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindows();
      }
    });
  }
}

try {
  const ffmpegStatic = require("ffmpeg-static");
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    process.env.FFMPEG_BIN = ffmpegStatic;
    logStartup(`Bundled ffmpeg resolved: ${ffmpegStatic}`);
  }
} catch (err) {
  logStartup(`ffmpeg-static note: ${err?.message || err}`);
}

// Persistent low-latency Win32 keybd_event paste worker on Windows
function startWindowsPasteWorker() {
  if (process.platform !== "win32" || winPasteWorker) return;
  try {
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class GlaidoWinInput {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void SendCtrlV() {
    // Release Alt/Shift if user was holding hotkey
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    // Press Ctrl + V
    keybd_event(0x11, 0, 0, UIntPtr.Zero);
    keybd_event(0x56, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(15);
    keybd_event(0x56, 0, 2, UIntPtr.Zero);
    keybd_event(0x11, 0, 2, UIntPtr.Zero);
  }
}
"@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq "PASTE") {
    [GlaidoWinInput]::SendCtrlV()
  }
}
`;
    winPasteWorker = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
      { stdio: ["pipe", "ignore", "ignore"], windowsHide: true }
    );
    winPasteWorker.on("exit", () => {
      winPasteWorker = null;
    });
    winPasteWorker.on("error", () => {
      winPasteWorker = null;
    });
  } catch (_) {
    winPasteWorker = null;
  }
}

// Register native Electron clipboard + instant paste hook for server.mjs
globalThis.__glaidoElectronPaste = async (text, shouldPaste = false) => {
  if (!text) return;
  try {
    clipboard.writeText(String(text));
    if (shouldPaste) {
      if (process.platform === "win32") {
        if (winPasteWorker && winPasteWorker.stdin && !winPasteWorker.stdin.destroyed) {
          setTimeout(() => {
            try {
              winPasteWorker.stdin.write("PASTE\n");
            } catch (_) {}
          }, 30);
        } else {
          setTimeout(() => {
            execFile(
              "powershell.exe",
              [
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
              ],
              { windowsHide: true },
              () => {}
            );
          }, 30);
        }
      } else if (process.platform === "darwin") {
        setTimeout(() => {
          execFile(
            "/usr/bin/osascript",
            ["-e", 'tell application "System Events" to keystroke "v" using command down'],
            () => {}
          );
        }, 20);
      }
    }
  } catch (err) {
    logStartup(`Paste error: ${err?.message || err}`);
  }
};


// Register native Electron microphone permission hooks for server.mjs
globalThis.__glaidoRequestMicrophonePermission = async () => {
  if (process.platform === "darwin" && typeof systemPreferences?.askForMediaAccess === "function") {
    try {
      return await systemPreferences.askForMediaAccess("microphone");
    } catch (_) {
      return false;
    }
  }
  return true;
};

globalThis.__glaidoGetMicrophonePermissionStatus = () => {
  if (process.platform === "darwin" && typeof systemPreferences?.getMediaAccessStatus === "function") {
    try {
      return systemPreferences.getMediaAccessStatus("microphone");
    } catch (_) {
      return "granted";
    }
  }
  return "granted";
};

function invokeRpc(cmd, args = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ cmd, args });
    const req = http.request(
      `${BASE_URL}/api/invoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.write(payload);
    req.end();
  });
}

function waitForServerReady(retries = 80) {
  return new Promise((resolve) => {
    const attempt = (rem) => {
      const req = http.get(`${BASE_URL}/`, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (rem <= 0) return resolve(false);
        setTimeout(() => attempt(rem - 1), 150);
      });
    };
    attempt(retries);
  });
}

function createTrayIconImage(recording = false) {
  const iconPath = path.join(__dirname, "public", "app-icons", "com.google.antigravity-ide.png");
  if (!recording && fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      return img.resize({ width: 16, height: 16 });
    }
  }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist <= 7.0) {
        if (recording) {
          buf[idx] = 239;
          buf[idx + 1] = 68;
          buf[idx + 2] = 68;
          buf[idx + 3] = 255;
        } else {
          const isBar =
            (Math.abs(x - 5) <= 0.6 && Math.abs(y - 7.5) <= 2.5) ||
            (Math.abs(x - 8) <= 0.6 && Math.abs(y - 7.5) <= 4.2) ||
            (Math.abs(x - 11) <= 0.6 && Math.abs(y - 7.5) <= 2.5);
          const c = isBar ? 255 : 24;
          buf[idx] = c;
          buf[idx + 1] = c;
          buf[idx + 2] = c;
          buf[idx + 3] = 255;
        }
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function updateTrayMenu() {
  if (!tray) return;
  const hotkeyLabel = process.platform === "win32" ? "Alt+Space" : "Option+Space";
  let openAtLogin = false;
  try {
    openAtLogin = Boolean(app.getLoginItemSettings().openAtLogin);
  } catch (_) {}

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRecording
        ? `Stop Dictation & Paste (${hotkeyLabel})`
        : `Start Voice Dictation (${hotkeyLabel})`,
      click: () => toggleGlobalDictation()
    },
    { type: "separator" },
    {
      label: "Open Glaido Pro Dashboard",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: process.platform === "win32" ? "Launch at Windows Startup" : "Launch at macOS Login",
      type: "checkbox",
      checked: openAtLogin,
      click: (item) => {
        try {
          app.setLoginItemSettings({ openAtLogin: item.checked });
        } catch (_) {}
      }
    },
    { type: "separator" },
    {
      label: "Quit Glaido Pro",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setToolTip(
    isRecording ? "Glaido Pro — Recording..." : `Glaido Pro — Voice Dictation (${hotkeyLabel})`
  );
  tray.setContextMenu(contextMenu);
}

async function toggleGlobalDictation() {
  if (isProcessing) return;
  const defaultAppName = process.platform === "win32" ? "Windows Desktop" : "macOS Desktop";
  const defaultBundleId =
    process.platform === "win32" ? "com.microsoft.windows.desktop" : "com.apple.finder";

  if (!isRecording) {
    isRecording = true;
    updateTrayMenu();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      positionOverlayWindow();
      overlayWindow.showInactive();
    }
    await invokeRpc("mac_global_dictation_start", {
      appName: defaultAppName,
      bundleId: defaultBundleId
    });
  } else {
    isRecording = false;
    isProcessing = true;
    updateTrayMenu();
    await invokeRpc("mac_global_dictation_stop", {
      appName: defaultAppName,
      bundleId: defaultBundleId
    });
    isProcessing = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }
  }
}

function positionOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const winWidth = 240;
  const winHeight = 68;
  const x = Math.round((width - winWidth) / 2);
  const y = Math.round(height - winHeight - 28);
  overlayWindow.setBounds({ x, y, width: winWidth, height: winHeight });
}

function subscribeToServerEvents() {
  const connect = () => {
    const req = http.get(`${BASE_URL}/api/events`, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const msg = JSON.parse(line.slice(6));
            if (msg.event === "overlay-visual-transition" && msg.payload) {
              const visible = Boolean(msg.payload.visible);
              isRecording = msg.payload.phase === "recording";
              isProcessing = msg.payload.phase === "processing";
              updateTrayMenu();
              if (overlayWindow && !overlayWindow.isDestroyed()) {
                if (visible) {
                  positionOverlayWindow();
                  overlayWindow.showInactive();
                } else {
                  overlayWindow.hide();
                }
              }
            }
          } catch (_) {}
        }
      });
      res.on("end", () => {
        if (!isQuitting) setTimeout(connect, 1000);
      });
    });
    req.on("error", () => {
      if (!isQuitting) setTimeout(connect, 1000);
    });
  };
  connect();
}

const WEBAUDIO_MIC_CAPTURE_SCRIPT = `
(function() {
  if (window.__glaidoWinMicInitialized) return;
  window.__glaidoWinMicInitialized = true;
  let audioCtx = null;
  let mediaStream = null;
  let processor = null;
  let active = false;

  async function startWebAudioCapture() {
    if (active) return;
    active = true;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(mediaStream);
      processor = audioCtx.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (e) => {
        if (!active) return;
        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const pcmBase64 = btoa(binary);
        fetch("/api/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd: "push_pcm_chunk", args: { pcmBase64 } })
        }).catch(() => {});
      };
      source.connect(processor);
      processor.connect(audioCtx.destination);
    } catch (_) {}
  }

  function stopWebAudioCapture() {
    active = false;
    try {
      if (processor) { processor.disconnect(); processor = null; }
      if (audioCtx) { audioCtx.close(); audioCtx = null; }
      if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    } catch (_) {}
  }

  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "recording-state" && msg.payload) {
        if (msg.payload.recording) startWebAudioCapture();
        else stopWebAudioCapture();
      }
    } catch (_) {}
  };
})();
`;

function createWindows() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media" || permission === "microphone" || permission === "audioCapture") {
      return callback(true);
    }
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  mainWindow = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: process.platform === "win32" ? "Glaido Pro for Windows" : "Glaido Pro for macOS",
    autoHideMenuBar: true,
    backgroundColor: "#FAF8F5",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadURL(`${BASE_URL}/`);

  mainWindow.webContents.on("did-finish-load", () => {
    if (process.platform === "win32") {
      mainWindow.webContents.executeJavaScript(WEBAUDIO_MIC_CAPTURE_SCRIPT).catch(() => {});
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logStartup(`Load failed for ${validatedURL}: [${errorCode}] ${errorDescription}`);
    if (!isQuitting && (errorCode === -102 || errorCode === -105 || errorCode === -6)) {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(`${BASE_URL}/`);
        }
      }, 350);
    }
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      if (tray && !tray.isDestroyed()) {
        e.preventDefault();
        mainWindow.hide();
        if (process.platform === "win32" && !hasShownTrayBalloon) {
          hasShownTrayBalloon = true;
          try {
            tray.displayBalloon({
              title: "Glaido Pro",
              content: "Glaido Pro is running in the system tray. Press Alt+Space anywhere to dictate."
            });
          } catch (_) {}
        }
      } else {
        isQuitting = true;
        app.quit();
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Floating bottom-center capsule overlay (hidden when idle!)
  overlayWindow = new BrowserWindow({
    width: 240,
    height: 68,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  positionOverlayWindow();
  overlayWindow.loadURL(`${BASE_URL}/overlay.html`);
}

async function runE2ETestSuite(serverReady) {
  const artifactsDir =
    process.env.GLAIDO_E2E_ARTIFACTS_DIR ||
    path.join(process.cwd(), "e2e-artifacts", `${process.platform}-${Date.now()}`);
  fs.mkdirSync(artifactsDir, { recursive: true });

  console.log("================================================================================");
  console.log(`[E2E] Starting Glaido Pro End-to-End Verification Suite (${process.platform} / ${process.arch})`);
  console.log(`[E2E] Artifacts Directory: ${artifactsDir}`);
  console.log("================================================================================");

  // Watchdog timeout to prevent CI stall
  const watchdog = setTimeout(() => {
    console.error("[E2E CRITICAL] Watchdog timeout reached (45s). Forcing termination.");
    if (winPasteWorker) {
      try { winPasteWorker.kill(); } catch (_) {}
    }
    isQuitting = true;
    app.exit(1);
  }, 45000);
  if (watchdog.unref) watchdog.unref();

  try {
    // 1. Verify Local Server & RPC Baseline
    console.log("[E2E] Step 1/6: Verifying server readiness & RPC baseline...");
    if (!serverReady) {
      throw new Error(`Local backend server failed to become ready on ${BASE_URL}`);
    }
    const settingsBaseline = await invokeRpc("get_settings");
    const micsBaseline = await invokeRpc("get_microphone_list");
    console.log("[E2E] RPC Baseline: settings ok =", !!settingsBaseline, ", mics count =", micsBaseline?.length || 0);

    // 2. Wait for MainWindow navigation & verify React hydration inside Chromium
    console.log("[E2E] Step 2/6: Verifying MainWindow navigation and React #root rendering...");
    if (!mainWindow) throw new Error("mainWindow is not initialized");

    if (mainWindow.webContents.isLoading()) {
      await new Promise((resolve) => {
        mainWindow.webContents.once("did-finish-load", resolve);
        mainWindow.webContents.once("did-fail-load", resolve);
      });
    }

    let domDetails = null;
    const domStart = Date.now();
    const maxDomWaitMs = 30000;
    while (Date.now() - domStart < maxDomWaitMs) {
      try {
        domDetails = await mainWindow.webContents.executeJavaScript(`
          (function() {
            const root = document.getElementById("root");
            if (!root) return { mounted: false, reason: "root_not_found" };
            const loader = root.querySelector(".startup-loader");
            const childCount = root.children.length;
            const innerHTML = root.innerHTML || "";
            const text = (root.innerText || "").trim();
            // React mounts, replacing the static startup-loader with real app components
            const mounted = !loader && childCount > 0 && innerHTML.length > 200;
            return {
              mounted,
              hasLoader: !!loader,
              childCount,
              htmlLength: innerHTML.length,
              textSnippet: text.slice(0, 160).replace(/\\s+/g, " "),
              buttonCount: document.querySelectorAll("button").length,
              title: document.title
            };
          })()
        `);
        if (domDetails && domDetails.mounted) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!domDetails || !domDetails.mounted) {
      throw new Error(`React failed to mount inside #root within 30s. Last DOM state: ${JSON.stringify(domDetails)}`);
    }
    console.log("[E2E] React #root mounted successfully in Chromium:", JSON.stringify(domDetails));

    // 3. Verify Tauri IPC bridge calls directly from inside the Chromium Renderer
    console.log("[E2E] Step 3/6: Verifying Tauri IPC invocations from inside Chromium renderer...");
    const rendererIpc = await mainWindow.webContents.executeJavaScript(`
      (async function() {
        try {
          if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== "function") {
            return { ok: false, error: "window.__TAURI_INTERNALS__.invoke missing" };
          }
          const appVersion = await window.__TAURI_INTERNALS__.invoke("plugin:app|version");
          const osPlatform = await window.__TAURI_INTERNALS__.invoke("plugin:os|platform");
          const settings = await window.__TAURI_INTERNALS__.invoke("get_settings");
          const mics = await window.__TAURI_INTERNALS__.invoke("get_microphone_list");
          return {
            ok: true,
            appVersion,
            osPlatform,
            hasSettings: !!settings,
            micCount: Array.isArray(mics) ? mics.length : 0
          };
        } catch (err) {
          return { ok: false, error: String(err?.message || err) };
        }
      })()
    `);
    if (!rendererIpc || !rendererIpc.ok) {
      throw new Error(`Tauri IPC failed inside Chromium renderer: ${JSON.stringify(rendererIpc)}`);
    }
    console.log("[E2E] Chromium renderer Tauri IPC verified:", JSON.stringify(rendererIpc));

    // 4. Verify Overlay Window
    console.log("[E2E] Step 4/6: Verifying overlayWindow DOM & capsule structure...");
    if (!overlayWindow) throw new Error("overlayWindow is not initialized");
    if (overlayWindow.webContents.isLoading()) {
      await new Promise((resolve) => {
        overlayWindow.webContents.once("did-finish-load", resolve);
        overlayWindow.webContents.once("did-fail-load", resolve);
      });
    }
    const overlayDetails = await overlayWindow.webContents.executeJavaScript(`
      (function() {
        const root = document.getElementById("overlay-root");
        return {
          ok: !!root,
          hasOverlayRoot: !!root,
          childCount: root ? root.children.length : 0,
          windowLabel: window.__GLAIDO_WINDOW_LABEL__
        };
      })()
    `);
    console.log("[E2E] Overlay window DOM verified:", JSON.stringify(overlayDetails));

    // 5. Test Dictation Session Lifecycle via IPC, Overlay Visuals & Clipboard Write
    console.log("[E2E] Step 5/6: Testing dictation lifecycle via IPC & clipboard write...");
    const defaultAppName = process.platform === "win32" ? "Windows Desktop" : "macOS Desktop";
    const defaultBundleId = process.platform === "win32" ? "com.microsoft.windows.desktop" : "com.apple.finder";

    // 5a. Start Dictation
    const startRes = await invokeRpc("mac_global_dictation_start", {
      appName: defaultAppName,
      bundleId: defaultBundleId
    });
    console.log("[E2E] mac_global_dictation_start result:", JSON.stringify(startRes));

    // Show overlay window inactive so it paints the recording capsule
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      positionOverlayWindow();
      overlayWindow.showInactive();
    }
    await new Promise((r) => setTimeout(r, 600));

    // Capture overlay screenshot DURING active dictation
    console.log("[E2E] Capturing real PNG screenshot of overlayWindow during recording...");
    const overlayImg = await overlayWindow.webContents.capturePage();
    const overlayPng = overlayImg.toPNG();
    const overlayScreenshotPath = path.join(artifactsDir, "overlay-dictation-active.png");
    fs.writeFileSync(overlayScreenshotPath, overlayPng);
    console.log(`[E2E] Overlay screenshot saved: ${overlayScreenshotPath} (${overlayPng.length} bytes)`);

    // 5b. Stop Dictation with test transcript
    const testTranscript = "Glaido Pro Windows and macOS E2E Pipeline Verified";
    console.log(`[E2E] Stopping dictation with spokenText="${testTranscript}"...`);
    const stopRes = await invokeRpc("mac_global_dictation_stop", {
      appName: defaultAppName,
      bundleId: defaultBundleId,
      spokenText: testTranscript
    });
    console.log("[E2E] mac_global_dictation_stop result:", JSON.stringify(stopRes));

    // Wait for clipboard write & hide overlay
    await new Promise((r) => setTimeout(r, 600));
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
    }

    // 5c. Verify Clipboard Readback
    const clipboardText = clipboard.readText();
    console.log("[E2E] Clipboard readback text:", JSON.stringify(clipboardText));
    const clipboardMatched = clipboardText.includes("Glaido Pro") || clipboardText.includes("Pipeline");
    if (!clipboardMatched) {
      throw new Error(`Clipboard text did not match expected transcript. Got: "${clipboardText}"`);
    }
    console.log("[E2E] Native clipboard write & readback VERIFIED!");

    // 6. Capture MainWindow Screenshot & Generate Summary
    console.log("[E2E] Step 6/6: Capturing mainWindow screenshot and generating test report...");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    await new Promise((r) => setTimeout(r, 500));

    const mainImg = await mainWindow.webContents.capturePage();
    const mainPng = mainImg.toPNG();
    const mainScreenshotPath = path.join(artifactsDir, "mainWindow-react-dashboard.png");
    fs.writeFileSync(mainScreenshotPath, mainPng);
    console.log(`[E2E] MainWindow screenshot saved: ${mainScreenshotPath} (${mainPng.length} bytes)`);

    const allPassed =
      Boolean(serverReady) &&
      Boolean(domDetails?.mounted) &&
      Boolean(rendererIpc?.ok) &&
      Boolean(overlayDetails?.hasOverlayRoot) &&
      Boolean(startRes?.result?.started || startRes?.started) &&
      Boolean(stopRes) &&
      Boolean(clipboardMatched) &&
      mainPng.length > 1000 &&
      overlayPng.length > 500;

    const report = {
      testSuite: "Glaido Pro Comprehensive End-to-End Verification",
      status: allPassed ? "PASSED" : "FAILED",
      platform: process.platform,
      arch: process.arch,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - domStart,
      checks: {
        serverReady,
        reactMounted: domDetails?.mounted || false,
        domDetails,
        rendererIpc,
        overlayDetails,
        dictationStart: startRes,
        dictationStop: stopRes,
        clipboardVerified: clipboardMatched,
        clipboardText,
        screenshots: {
          mainWindow: { path: mainScreenshotPath, bytes: mainPng.length },
          overlayWindow: { path: overlayScreenshotPath, bytes: overlayPng.length }
        }
      }
    };

    const reportPath = path.join(artifactsDir, "e2e-summary.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[E2E] Comprehensive test report saved to: ${reportPath}`);
    console.log("================================================================================");
    console.log(`[E2E] ALL CHECKS PASSED: ${allPassed ? "SUCCESS" : "FAILURE"}`);
    console.log("================================================================================");

    clearTimeout(watchdog);
    if (winPasteWorker) {
      try { winPasteWorker.kill(); } catch (_) {}
    }
    isQuitting = true;
    app.exit(allPassed ? 0 : 1);
  } catch (err) {
    clearTimeout(watchdog);
    console.error("[E2E FAILED] Error during end-to-end test execution:", err);

    try {
      const failReport = {
        testSuite: "Glaido Pro Comprehensive End-to-End Verification",
        status: "FAILED",
        error: String(err?.stack || err?.message || err),
        platform: process.platform,
        arch: process.arch,
        timestamp: new Date().toISOString()
      };
      fs.writeFileSync(path.join(artifactsDir, "e2e-summary.json"), JSON.stringify(failReport, null, 2));
    } catch (_) {}

    if (winPasteWorker) {
      try { winPasteWorker.kill(); } catch (_) {}
    }
    isQuitting = true;
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  logStartup(`Starting Glaido Pro (${process.platform})...`);
  startWindowsPasteWorker();

  // Dynamically pick an available localhost port starting at 4321 so EADDRINUSE never occurs
  const chosenPort = await findAvailablePort(PORT);
  PORT = chosenPort;
  BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.PORT = String(PORT);
  logStartup(`Selected available localhost port: ${PORT}`);

  // Proactively request macOS microphone permission so TCC prompt appears on launch
  if (process.platform === "darwin" && typeof systemPreferences?.askForMediaAccess === "function") {
    try {
      const currentStatus = systemPreferences.getMediaAccessStatus("microphone");
      logStartup(`macOS initial microphone access status: ${currentStatus}`);
      if (currentStatus !== "granted") {
        systemPreferences.askForMediaAccess("microphone").then((granted) => {
          logStartup(`macOS askForMediaAccess(microphone) returned: ${granted}`);
        }).catch((err) => {
          logStartup(`macOS askForMediaAccess error: ${err?.message || err}`);
        });
      }
    } catch (err) {
      logStartup(`macOS media access check error: ${err?.message || err}`);
    }
  }

  try {
    const serverModuleUrl = pathToFileURL(path.join(__dirname, "server.mjs")).href;
    await import(serverModuleUrl);
    logStartup("server.mjs imported successfully.");
  } catch (err) {
    logStartup(`server.mjs import error: ${err?.stack || err}`);
  }

  const ready = await waitForServerReady();
  logStartup(`Server ready=${ready} on ${BASE_URL}`);

  if (IS_SMOKE_TEST) {
    const settingsRes = await invokeRpc("get_settings");
    const micsRes = await invokeRpc("get_microphone_list");
    const envRes = await invokeRpc("get_feedback_environment");
    console.log("SMOKE_TEST_RESULTS:", JSON.stringify({ ready, settingsRes, micsRes, envRes }));
    isQuitting = true;
    app.exit(ready && settingsRes && micsRes ? 0 : 1);
    return;
  }

  try {
    app.setLoginItemSettings({ openAtLogin: true });
  } catch (_) {}

  try {
    tray = new Tray(createTrayIconImage(false));
    tray.on("click", () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
    updateTrayMenu();
  } catch (err) {
    logStartup(`Tray warning: ${err?.message || err}`);
  }

  createWindows();
  subscribeToServerEvents();

  // Register global hotkeys
  const hotkeysToRegister = ["Alt+Space", "CommandOrControl+Shift+Space"];
  for (const hk of hotkeysToRegister) {
    try {
      globalShortcut.register(hk, () => {
        toggleGlobalDictation();
      });
    } catch (_) {}
  }

  if (IS_E2E_TEST) {
    await runE2ETestSuite(ready);
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (winPasteWorker) {
    try {
      winPasteWorker.kill();
    } catch (_) {}
  }
});

app.on("window-all-closed", (e) => {
  if (!isQuitting) {
    e.preventDefault();
  }
});
