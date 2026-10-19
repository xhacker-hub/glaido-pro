(function () {
  const windowLabel = window.__GLAIDO_WINDOW_LABEL__ || "main";
  const callbacks = new Map();
  const eventListeners = new Map(); // eventName -> Set<{ eventId, handlerId, target }>
  let nextId = 1;

  const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("glaido-ipc-events") : null;

  function registerCallback(fn, once = false) {
    const id = nextId++;
    callbacks.set(id, (...args) => {
      if (once) callbacks.delete(id);
      if (typeof fn === "function") return fn(...args);
    });
    return id;
  }

  function dispatchLocalEvent(event, payload, targetLabel = null) {
    if (targetLabel && targetLabel !== windowLabel) return;
    const set = eventListeners.get(event);
    if (!set) return;
    for (const item of Array.from(set)) {
      const cb = callbacks.get(item.handlerId);
      if (cb) {
        try {
          cb({
            event,
            id: item.eventId,
            windowLabel,
            payload
          });
        } catch (err) {
          console.error("[Glaido Shim] Event listener error:", err);
        }
      }
    }
  }

  function emitGlobalEvent(event, payload, target = null) {
    const targetLabel =
      typeof target === "string"
        ? target
        : target && (target.kind === "AnyLabel" || target.kind === "Window" || target.kind === "Webview")
        ? target.label
        : null;

    dispatchLocalEvent(event, payload, targetLabel);
    if (bc) {
      bc.postMessage({ type: "tauri-event", event, payload, targetLabel });
    }
    // Also notify parent/child frames if same-origin
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __glaidoEvent: true, event, payload, targetLabel }, "*");
      }
      const frames = document.querySelectorAll("iframe");
      frames.forEach((f) => {
        try {
          f.contentWindow?.postMessage({ __glaidoEvent: true, event, payload, targetLabel }, "*");
        } catch (_) {}
      });
    } catch (_) {}
  }

  if (bc) {
    bc.onmessage = (msg) => {
      if (msg.data && msg.data.type === "tauri-event") {
        dispatchLocalEvent(msg.data.event, msg.data.payload, msg.data.targetLabel);
      }
    };
  }

  window.addEventListener("message", (ev) => {
    if (ev.data && ev.data.__glaidoEvent) {
      dispatchLocalEvent(ev.data.event, ev.data.payload, ev.data.targetLabel);
    }
  });

  // Connect to backend SSE stream for server-pushed Tauri events
  function connectServerEvents() {
    try {
      const es = new EventSource("/api/events");
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data && data.event) {
            dispatchLocalEvent(data.event, data.payload, data.targetLabel || null);
            handleWindowSurfaceEvent(data.event, data.payload);
          }
        } catch (_) {}
      };
      es.onerror = () => {
        es.close();
        setTimeout(connectServerEvents, 2000);
      };
    } catch (_) {}
  }
  if (typeof EventSource !== "undefined") {
    connectServerEvents();
  }

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, eventId) {
      const set = eventListeners.get(event);
      if (!set) return;
      for (const item of set) {
        if (item.eventId === eventId) {
          set.delete(item);
          callbacks.delete(item.handlerId);
        }
      }
    }
  };

  const isWindowsClient =
    typeof navigator !== "undefined" && /win/i.test(navigator.userAgent || "") && !/darwin|mac/i.test(navigator.userAgent || "");

  window.__TAURI_OS_PLUGIN_INTERNALS__ = isWindowsClient
    ? {
        arch: "x86_64",
        eol: "\r\n",
        exe_extension: "exe",
        family: "windows",
        os_type: "windows",
        platform: "windows",
        version: "10.0.22631"
      }
    : {
        arch: "aarch64",
        eol: "\n",
        exe_extension: "",
        family: "unix",
        os_type: "macos",
        platform: "macos",
        version: "15.4.0"
      };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: windowLabel },
      currentWebview: { label: windowLabel },
      windows: [
        { label: "main" },
        { label: "overlay" },
        { label: "command-modal" },
        { label: "toast-overlay" }
      ],
      webviews: [
        { label: "main", windowLabel: "main" },
        { label: "overlay", windowLabel: "overlay" },
        { label: "command-modal", windowLabel: "command-modal" },
        { label: "toast-overlay", windowLabel: "toast-overlay" }
      ]
    },
    plugins: {
      path: isWindowsClient
        ? {
            sep: "\\",
            delimiter: ";"
          }
        : {
            sep: "/",
            delimiter: ":"
          }
    },
    transformCallback: registerCallback,
    convertFileSrc(filePath, _protocol = "asset") {
      if (!filePath) return "";
      if (filePath.startsWith("http://") || filePath.startsWith("https://") || filePath.startsWith("data:")) {
        return filePath;
      }
      const idxIcons = filePath.indexOf("/app-icons/");
      if (idxIcons >= 0) return filePath.slice(idxIcons);
      const idxAudio = filePath.indexOf("/audio/");
      if (idxAudio >= 0) return filePath.slice(idxAudio);
      if (filePath.startsWith("/")) return filePath;
      return "/" + filePath;
    },
    async invoke(cmd, args = {}, _options) {
      // 1. Handle Tauri Event Plugin
      if (cmd === "plugin:event|listen") {
        const eventId = nextId++;
        const eventName = args.event;
        if (!eventListeners.has(eventName)) {
          eventListeners.set(eventName, new Set());
        }
        eventListeners.get(eventName).add({
          eventId,
          handlerId: args.handler,
          target: args.target
        });
        return eventId;
      }
      if (cmd === "plugin:event|unlisten") {
        window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(args.event, args.eventId);
        return null;
      }
      if (cmd === "plugin:event|emit") {
        emitGlobalEvent(args.event, args.payload, null);
        fetch("/api/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd, args })
        }).catch(() => {});
        return null;
      }
      if (cmd === "plugin:event|emit_to") {
        emitGlobalEvent(args.event, args.payload, args.target);
        fetch("/api/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cmd, args })
        }).catch(() => {});
        return null;
      }

      // 2. Handle Tauri Window / Webview / App / OS / Opener plugins
      if (cmd === "plugin:app|version") return "0.4.3";
      if (cmd === "plugin:app|name") return "Glaido";
      if (cmd === "plugin:app|tauri_version") return "2.11.5";
      if (cmd === "plugin:os|platform" || cmd === "plugin:os|os_type") return isWindowsClient ? "windows" : "macos";
      if (cmd === "plugin:os|arch") return isWindowsClient ? "x86_64" : "aarch64";
      if (cmd === "plugin:os|version") return isWindowsClient ? "10.0.22631" : "15.4.0";
      if (cmd === "plugin:os|locale") return "en-US";
      if (cmd === "plugin:window|get_all_windows") {
        return ["main", "overlay", "command-modal", "toast-overlay"];
      }
      if (
        cmd.startsWith("plugin:window|") ||
        cmd.startsWith("plugin:webview|") ||
        cmd.startsWith("plugin:resources|") ||
        cmd.startsWith("plugin:window-state|") ||
        cmd.startsWith("plugin:autostart|") ||
        cmd.startsWith("plugin:deep-link|")
      ) {
        if (cmd === "plugin:window|theme") return "dark";
        if (cmd === "plugin:window|is_focused" || cmd === "plugin:window|is_visible") return true;
        if (cmd === "plugin:window|scale_factor") return window.devicePixelRatio || 2;
        if (cmd === "plugin:window|inner_size" || cmd === "plugin:window|outer_size") {
          return { width: window.innerWidth || 1200, height: window.innerHeight || 800 };
        }
        if (cmd === "plugin:window|inner_position" || cmd === "plugin:window|outer_position") {
          return { x: 0, y: 0 };
        }
        return null;
      }
      if (cmd === "plugin:opener|open_url" || cmd === "open_external") {
        const url = args.url || args.path;
        if (url && typeof window !== "undefined") {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        return null;
      }

      // 3. Handle UI Window Sizing / Visibility Hooks Locally + Remotely
      if (cmd === "resize_command_modal") {
        emitGlobalEvent("__internal:resize_command_modal", { height: args.height });
        return null;
      }
      if (cmd === "close_command_modal" || cmd === "command_island_left") {
        emitGlobalEvent("__internal:hide_command_modal", {});
      }
      if (cmd === "show_toast_overlay") {
        emitGlobalEvent("__internal:toast_visibility", { visible: true });
      }
      if (cmd === "hide_toast_overlay") {
        emitGlobalEvent("__internal:toast_visibility", { visible: false });
      }
      if (cmd === "resize_toast_overlay") {
        emitGlobalEvent("__internal:resize_toast_overlay", { height: args.height });
      }
      if (cmd === "set_toast_overlay_clickthrough") {
        emitGlobalEvent("__internal:toast_clickthrough", { enabled: args.enabled });
      }
      if (cmd === "start_hotkey_capture") {
        window.__GLAIDO_CAPTURING_HOTKEY__ = true;
        return null;
      }
      if (cmd === "stop_hotkey_capture") {
        window.__GLAIDO_CAPTURING_HOTKEY__ = false;
        return null;
      }

      // 4. Forward all Glaido Core Rust IPC commands to our Backend
      const res = await fetch("/api/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, args })
      });
      const json = await res.json();
      if (!res.ok || json.__error) {
        throw json.error || { kind: "system", code: "error", message: json.message || `Command ${cmd} failed` };
      }
      return json.result;
    }
  };

  // ============================================================================
  // Main Window Multi-Surface Compositor + Live Voice & MCP Agent Studio Dock
  // ============================================================================
  function handleWindowSurfaceEvent(event, payload) {
    if (windowLabel !== "main") return;
    const cmdFrame = document.getElementById("glaido-live-command-frame");
    if (!cmdFrame) return;
    if (
      event === "command-modal-init" ||
      event === "command-modal-recording-start" ||
      event === "command-transcript" ||
      event === "command-response-delta" ||
      event === "command-response-final" ||
      event === "__internal:show_command_modal"
    ) {
      cmdFrame.style.opacity = "1";
      cmdFrame.style.pointerEvents = "auto";
      cmdFrame.style.transform = "translateX(-50%) translateY(0px)";
    }
    if (event === "__internal:hide_command_modal" || event === "command-modal-reset") {
      cmdFrame.style.opacity = "0";
      cmdFrame.style.pointerEvents = "none";
      cmdFrame.style.transform = "translateX(-50%) translateY(10px)";
    }
  }

  if (windowLabel === "main") {
    window.addEventListener("DOMContentLoaded", () => {
      mountMultiSurfaceFrames();
      mountHotkeyCaptureSupport();
    });
  } else if (windowLabel === "overlay") {
    window.addEventListener("DOMContentLoaded", () => {
      document.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        try {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.glaidoOverlay) {
            window.webkit.messageHandlers.glaidoOverlay.postMessage("toggle");
          }
        } catch (_) {}
      });
    });
  }

  function mountMultiSurfaceFrames() {
    // 1. Floating Liquid-Glass Command Island (/command-modal.html)
    const cmdFrame = document.createElement("iframe");
    cmdFrame.id = "glaido-live-command-frame";
    cmdFrame.src = "/command-modal.html";
    cmdFrame.title = "Glaido Command Island";
    Object.assign(cmdFrame.style, {
      position: "fixed",
      left: "50%",
      bottom: "74px",
      transform: "translateX(-50%) translateY(10px)",
      width: "560px",
      height: "360px",
      maxWidth: "94vw",
      border: "none",
      background: "transparent",
      zIndex: "9999",
      opacity: "0",
      pointerEvents: "none",
      transition: "opacity 0.18s ease, transform 0.18s ease, height 0.18s ease",
      overflow: "hidden"
    });
    document.body.appendChild(cmdFrame);

    // 2. Toast Overlay (/toast-overlay.html)
    const toastFrame = document.createElement("iframe");
    toastFrame.id = "glaido-live-toast-frame";
    toastFrame.src = "/toast-overlay.html";
    toastFrame.title = "Glaido Toast Overlay";
    Object.assign(toastFrame.style, {
      position: "fixed",
      right: "16px",
      top: "16px",
      width: "380px",
      height: "180px",
      border: "none",
      background: "transparent",
      zIndex: "9997",
      pointerEvents: "none",
      overflow: "hidden"
    });
    document.body.appendChild(toastFrame);

    // Listen for resize/visibility messages from child iframes
    const registerInternal = (evt, fn) => {
      const id = registerCallback((e) => fn(e.payload));
      if (!eventListeners.has(evt)) eventListeners.set(evt, new Set());
      eventListeners.get(evt).add({ eventId: nextId++, handlerId: id, target: null });
    };

    registerInternal("__internal:resize_command_modal", (p) => {
      if (p && p.height) {
        cmdFrame.style.height = Math.max(120, Math.min(560, p.height + 24)) + "px";
      }
    });
    registerInternal("__internal:show_command_modal", () => {
      cmdFrame.style.opacity = "1";
      cmdFrame.style.pointerEvents = "auto";
      cmdFrame.style.transform = "translateX(-50%) translateY(0)";
    });
    registerInternal("__internal:hide_command_modal", () => {
      cmdFrame.style.opacity = "0";
      cmdFrame.style.pointerEvents = "none";
    });
    registerInternal("__internal:toast_visibility", (p) => {
      toastFrame.style.opacity = p && p.visible ? "1" : "0";
    });
    registerInternal("__internal:toast_clickthrough", (p) => {
      toastFrame.style.pointerEvents = p && p.enabled ? "none" : "auto";
    });
  }

  function mountHotkeyCaptureSupport() {
    function formatKeyEventLabel(e) {
      if (isWindowsClient) {
        if (e.code === "AltRight") return { primary: "Right Alt", short: "Right Alt" };
        if (e.code === "AltLeft") return { primary: "Left Alt", short: "Left Alt" };
        if (e.code === "ControlRight") return { primary: "Right Ctrl", short: "Right Ctrl" };
        if (e.code === "ShiftRight") return { primary: "Right Shift", short: "Right Shift" };
        const mods = [];
        if (e.ctrlKey && !e.code.startsWith("Control")) mods.push("Ctrl");
        if (e.altKey && !e.code.startsWith("Alt")) mods.push("Alt");
        if (e.shiftKey && !e.code.startsWith("Shift")) mods.push("Shift");
        if (e.metaKey && !e.code.startsWith("Meta")) mods.push("Win");
        const keyName = e.code === "Space" ? "Space" : e.code.replace(/^Key|^Digit/, "");
        const shortMods = mods.join("+");
        return {
          primary: keyName,
          modifiers: mods,
          short: shortMods ? `${shortMods}+${keyName}` : keyName
        };
      }
      if (e.code === "AltRight") return { primary: "Right Option", short: "Right ⌥" };
      if (e.code === "AltLeft") return { primary: "Left Option", short: "Left ⌥" };
      if (e.code === "ControlRight") return { primary: "Right Control", short: "Right ⌃" };
      if (e.code === "ShiftRight") return { primary: "Right Shift", short: "Right ⇧" };
      const mods = [];
      if (e.ctrlKey && !e.code.startsWith("Control")) mods.push("Control");
      if (e.altKey && !e.code.startsWith("Alt")) mods.push("Option");
      if (e.shiftKey && !e.code.startsWith("Shift")) mods.push("Shift");
      if (e.metaKey && !e.code.startsWith("Meta")) mods.push("Command");
      const keyName = e.code === "Space" ? "Space" : e.code.replace(/^Key|^Digit/, "");
      const shortMods = mods.map((m) => (m === "Control" ? "⌃" : m === "Option" ? "⌥" : m === "Shift" ? "⇧" : "⌘")).join("");
      return {
        primary: keyName,
        modifiers: mods,
        short: shortMods ? `${shortMods}+${keyName}` : keyName
      };
    }

    window.addEventListener("keydown", (e) => {
      if (!window.__GLAIDO_CAPTURING_HOTKEY__) return;
      e.preventDefault();
      e.stopPropagation();
      const info = formatKeyEventLabel(e);
      localStorage.setItem("glaido_dictate_key_code", e.code);
      localStorage.setItem("glaido_dictate_key_ctrl", e.ctrlKey ? "1" : "0");
      localStorage.setItem("glaido_dictate_key_alt", e.altKey ? "1" : "0");
      localStorage.setItem("glaido_dictate_key_label", info.short);

      emitGlobalEvent("hotkey-captured", {
        binding: {
          primary_keycode: e.keyCode || 61,
          primary_is_modifier: ["AltRight", "AltLeft", "ControlRight", "ControlLeft", "ShiftRight", "ShiftLeft"].includes(e.code),
          required_flags: 0,
          required_device_flags: 0,
          activation: "press",
          custom_primary: info.primary,
          custom_modifiers: info.modifiers || []
        },
        display_primary: info.primary,
        display_modifiers: info.modifiers || []
      });
    });
  }
})();
