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
  clipboard
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn, execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const PORT = Number(process.env.PORT || 4321);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_SMOKE_TEST = process.argv.includes("--smoke-test") || process.env.GLAIDO_SMOKE_TEST === "1";

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isQuitting = false;
let isRecording = false;
let isProcessing = false;
let winPasteWorker = null;

// Ensure single instance (skip during CI smoke test)
if (!IS_SMOKE_TEST) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }
}

// Configure writable data directory & bundled ffmpeg before importing server.mjs
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
    mainWindow.webContents.executeJavaScript(WEBAUDIO_MIC_CAPTURE_SCRIPT).catch(() => {});
  });

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
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

app.whenReady().then(async () => {
  logStartup(`Starting Glaido Pro (${process.platform})...`);
  startWindowsPasteWorker();

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
