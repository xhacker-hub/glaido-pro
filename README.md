# Glaido Pro — Cross-Platform AI Voice Dictation & Command Mode (macOS & Windows PC)

100% unlocked, local-first **Glaido Pro** (`v0.4.3`) desktop application for **macOS** and **Windows PC**:
- **Exact Original Glaido UI**: All 4 native surfaces (`main` dashboard, bottom-center floating `overlay.html` capsule with live 60fps spring-physics waveform, `command-modal.html` Command Island, and `correction-toast.html`).
- **Dual-Engine Low-Latency Speech Recognition**:
  - **Local Neural Whisper Engine (`whisper.cpp` Metal GPU / CPU)**: Conditioned directly on your Personal Dictionary (`Antigravity`, `Glaido`, `Higgsfield AI`, `GrokBot`, `Agentic OS`, `Droppy`, etc.).
  - **Automatic Zero-Install Fallback**: Built-in keep-alive HTTPS streaming speech engine (`enhanceAndNormalizePcm` + 5-hypothesis context reranker) that works immediately on any Windows PC or Mac with zero model download required.
  - **Optional Cloud Whisper Turbo**: Plug in a Groq (`whisper-large-v3-turbo`) or OpenAI (`whisper-1`) key anytime in Settings.
- **Full SQLite Persistence (`node:sqlite`)**: History, Personal Dictionary, Spoken Snippets (`{gl.clipboard}`, `{gl.datetime}`, `{gl.timezone}`), Per-App Formatting Rules, Analytics, and 11 Built-in MCP Tools.

---

## Quick Start on Windows PC

### 1. Prerequisites
- **Node.js v22.5+ or v24+** ([nodejs.org](https://nodejs.org))
- **FFmpeg** installed and in your system `PATH`:
  ```powershell
  winget install Gyan.FFmpeg
  ```

### 2. Clone & Run on Windows
```powershell
git clone https://github.com/xhacker-hub/glaido-pro.git
cd glaido-pro
```
Then simply double-click **`Start-Glaido-Pro-Windows.bat`** (or run `node --no-warnings server.mjs` and open `http://localhost:4321`).

- **Global Hotkeys on Windows**: Press **`Alt + Space`** or **`Ctrl + Space`** in any Windows app to start/stop dictation and automatically paste (`Ctrl+V`) into your active window.

---

## Quick Start on macOS (Apple Silicon / Intel)

### 1. Prerequisites
```bash
brew install node ffmpeg whisper-cpp
```

### 2. Clone, Download Whisper Model & Launch
```bash
git clone https://github.com/xhacker-hub/glaido-pro.git
cd glaido-pro

# Download the 181MB Whisper small.en model for Apple Silicon Metal GPU acceleration
mkdir -p data/models
curl -L -o data/models/ggml-small.en-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin

# Start the keepalive backend + open the native macOS app
./keepalive-server.sh &
open "Glaido Dictate.app"
```

- **Global Hotkeys on macOS**: Press **`Fn`**, **Right Option**, **`⌥ + Space`**, or **`⌃ + Space`** in any macOS app to dictate and auto-paste (`⌘V`).
