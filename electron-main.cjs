const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  screen,
  nativeImage,
  session,
  shell
} = require("electron");
const path = require("node:path");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

const PORT = Number(process.env.PORT || 4321);
const BASE_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let isQuitting = false;
let isRecording = false;
let isProcessing = false;

// Ensure single instance
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

// Configure writable data directory & bundled ffmpeg before importing server.mjs
process.env.GLAIDO_DATA_DIR = app.getPath("userData");
try {
  const ffmpegStatic = require("ffmpeg-static");
  if (ffmpegStatic) {
    process.env.FFMPEG_BIN = ffmpegStatic;
  }
} catch (_) {}

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

function waitForServerReady(retries = 60) {
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
  // Generate a crisp 16x16 RGBA icon programmatically so it never fails to load
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
          // Vibrant red recording dot (BGRA on Windows/Electron nativeImage fromBitmap or RGBA via PNG data URL)
          buf[idx] = 239;
          buf[idx + 1] = 68;
          buf[idx + 2] = 68;
          buf[idx + 3] = 255;
        } else {
          // Sleek dark obsidian badge with white waveform bars
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
  const iconPath = path.join(__dirname, "public", "app-icons", "com.google.antigravity-ide.png");
  if (!recording && require("node:fs").existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      return img.resize({ width: 16, height: 16 });
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function updateTrayMenu() {
  if (!tray) return;
  const loginSettings = app.getLoginItemSettings();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isRecording
        ? "Stop Dictation & Paste (Alt+Space)"
        : "Start Voice Dictation (Alt+Space)",
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
      label: "Launch Glaido Pro at Windows Login",
      type: "checkbox",
      checked: Boolean(loginSettings.openAtLogin),
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
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
  tray.setToolTip(isRecording ? "Glaido Pro — Recording..." : "Glaido Pro — Voice Dictation (Alt+Space)");
  tray.setContextMenu(contextMenu);
}

async function toggleGlobalDictation() {
  if (isProcessing) return;
  if (!isRecording) {
    isRecording = true;
    updateTrayMenu();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      positionOverlayWindow();
      overlayWindow.showInactive();
    }
    await invokeRpc("mac_global_dictation_start", {
      appName: "Windows Desktop",
      bundleId: "com.microsoft.windows.desktop"
    });
  } else {
    isRecording = false;
    isProcessing = true;
    updateTrayMenu();
    await invokeRpc("mac_global_dictation_stop", {
      appName: "Windows Desktop",
      bundleId: "com.microsoft.windows.desktop"
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

function createWindows() {
  // Auto-approve microphone access in Chromium WebAudio
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
    title: "Glaido Pro",
    autoHideMenuBar: true,
    backgroundColor: "#FAF8F5",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL(`${BASE_URL}/`);

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

  // Inject native Chromium WASAPI 16kHz PCM microphone streamer into overlayWindow
  // so Windows microphone capture works out-of-the-box with any default input device
  overlayWindow.webContents.on("did-finish-load", () => {
    overlayWindow.webContents
      .executeJavaScript(`
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
    `)
      .catch(() => {});
  });
}

app.whenReady().then(async () => {
  // Start embedded Glaido Pro Node server
  const serverModuleUrl = pathToFileURL(path.join(__dirname, "server.mjs")).href;
  await import(serverModuleUrl);
  await waitForServerReady();

  // Enable launch on login by default on first run
  try {
    app.setLoginItemSettings({ openAtLogin: true });
  } catch (_) {}

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

  createWindows();
  subscribeToServerEvents();

  // Register Windows global hotkeys for voice dictation
  try {
    globalShortcut.register("Alt+Space", () => {
      toggleGlobalDictation();
    });
  } catch (_) {}
  try {
    globalShortcut.register("CommandOrControl+Shift+Space", () => {
      toggleGlobalDictation();
    });
  } catch (_) {}
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", (e) => {
  if (!isQuitting) {
    e.preventDefault();
  }
});
