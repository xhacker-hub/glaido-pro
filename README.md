# Glaido Pro — Cross-Platform AI Voice Dictation & Command Mode (Windows `.exe` & macOS)

100% unlocked, local-first **Glaido Pro** (`v0.4.3`) desktop application for **Windows PC** and **macOS**:

## 📥 Download for Windows PC (`.exe`)

No coding, terminal, or external dependencies needed—just download and run like any standard Windows app:

- **[⬇️ Download `Glaido-Pro-Setup-0.4.3.exe` (Windows Installer)](https://github.com/xhacker-hub/glaido-pro/releases/download/v0.4.3/Glaido-Pro-Setup-0.4.3.exe)** — Installs Glaido Pro with Desktop & Start Menu shortcuts and automatic Windows startup support.
- **[⬇️ Download `Glaido-Pro-Portable-0.4.3.exe` (Standalone Portable `.exe`)](https://github.com/xhacker-hub/glaido-pro/releases/download/v0.4.3/Glaido-Pro-Portable-0.4.3.exe)** — Single-file portable `.exe` you can run immediately from anywhere without installing.
- **[📦 View All Releases on GitHub](https://github.com/xhacker-hub/glaido-pro/releases/tag/v0.4.3)**

### How to Use on Windows
1. Run **`Glaido-Pro-Setup-0.4.3.exe`** (or **`Glaido-Pro-Portable-0.4.3.exe`**).
2. Glaido Pro opens its main dashboard and sits in your **Windows System Tray** (bottom-right taskbar).
3. Press **`Alt + Space`** (or **`Ctrl + Shift + Space`**) inside any Windows application to pop up the bottom-center live waveform capsule, speak naturally, and press **`Alt + Space`** again to automatically transcribe and paste (`Ctrl+V`) into your active window.

---

## Features
- **Exact Original Glaido UI**: All 4 native surfaces (`main` dashboard, bottom-center floating `overlay.html` capsule with live 60fps spring-physics waveform, `command-modal.html` Command Island, and `correction-toast.html`).
- **Dual-Engine Low-Latency Speech Recognition**:
  - **Local Neural Whisper Engine (`whisper.cpp` Metal GPU / CPU)**: Conditioned directly on your Personal Dictionary (`Antigravity`, `Glaido`, `Higgsfield AI`, `GrokBot`, `Agentic OS`, `Droppy`, etc.).
  - **Automatic Zero-Install Fallback**: Built-in keep-alive HTTPS streaming speech engine (`enhanceAndNormalizePcm` + 5-hypothesis context reranker) + native Windows WASAPI & bundled `ffmpeg` microphone capture.
  - **Optional Cloud Whisper Turbo**: Plug in a Groq (`whisper-large-v3-turbo`) or OpenAI (`whisper-1`) key anytime in Settings.
- **Full SQLite Persistence (`node:sqlite`)**: History, Personal Dictionary, Spoken Snippets (`{gl.clipboard}`, `{gl.datetime}`, `{gl.timezone}`), Per-App Formatting Rules, Analytics, and 11 Built-in MCP Tools.

---

## Quick Start on macOS (Apple Silicon / Intel)

```bash
brew install node ffmpeg whisper-cpp
git clone https://github.com/xhacker-hub/glaido-pro.git
cd glaido-pro

# Download the 181MB Whisper small.en model for Apple Silicon Metal GPU acceleration
mkdir -p data/models
curl -L -o data/models/ggml-small.en-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin

# Start the keepalive backend + open the native macOS app
./keepalive-server.sh &
open "Glaido Dictate.app"
```
