# Glaido Pro — Windows Native System Tray & Global Hotkey Agent (Alt+Space / Ctrl+Space)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$RepoDir = Split-Path -Parent $PSScriptRoot
Set-Location $RepoDir

# 1. Ensure Node.js backend is running on http://127.0.0.1:4321
function Ensure-BackendRunning {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:4321/api/invoke" -Method Post -ContentType "application/json" -Body '{"cmd":"get_recording_state"}' -TimeoutSec 1
    } catch {
        Start-Process -FilePath "node" -ArgumentList "--no-warnings", "server.mjs" -WorkingDirectory $RepoDir -WindowStyle Hidden
        Start-Sleep -Milliseconds 1200
    }
}

Ensure-BackendRunning

# 2. Launch Glaido Pro UI in App Mode (Edge or Chrome)
function Show-GlaidoWindow {
    Ensure-BackendRunning
    $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    if (-not (Test-Path $edge)) {
        $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    }
    if (Test-Path $edge) {
        Start-Process $edge -ArgumentList "--app=http://127.0.0.1:4321"
    } else {
        Start-Process "http://127.0.0.1:4321"
    }
}

Show-GlaidoWindow

# 3. Win32 Global Hotkey Window (Alt+Space = ID 1, Ctrl+Space = ID 2)
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class HotKeyWindow : NativeWindow, IDisposable {
    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public event EventHandler HotKeyPressed;

    public HotKeyWindow() {
        CreateHandle(new CreateParams());
        // Alt + Space (MOD_ALT = 0x0001, VK_SPACE = 0x20)
        RegisterHotKey(this.Handle, 1, 0x0001, 0x20);
        // Ctrl + Space (MOD_CONTROL = 0x0002, VK_SPACE = 0x20)
        RegisterHotKey(this.Handle, 2, 0x0002, 0x20);
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312) { // WM_HOTKEY
            if (HotKeyPressed != null) HotKeyPressed(this, EventArgs.Empty);
        }
        base.WndProc(ref m);
    }

    public void Dispose() {
        UnregisterHotKey(this.Handle, 1);
        UnregisterHotKey(this.Handle, 2);
        DestroyHandle();
    }
}
"@

Add-Type -TypeDefinition $code -ReferencedAssemblies System.Windows.Forms

$script:isRecording = $false

function Toggle-Dictation {
    Ensure-BackendRunning
    if (-not $script:isRecording) {
        $script:isRecording = $true
        $trayIcon.Text = "Glaido Pro — Listening... (Press Alt+Space to stop)"
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:4321/api/invoke" -Method Post -ContentType "application/json" -Body '{"cmd":"mac_global_dictation_start","args":{"appName":"Windows Active App","bundleId":"windows.active.app"}}'
        } catch {}
    } else {
        $script:isRecording = $false
        $trayIcon.Text = "Glaido Pro — Ready (Alt+Space or Ctrl+Space)"
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:4321/api/invoke" -Method Post -ContentType "application/json" -Body '{"cmd":"mac_global_dictation_stop","args":{"appName":"Windows Active App","bundleId":"windows.active.app"}}'
        } catch {}
    }
}

# 4. System Tray Icon & Context Menu
$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$trayIcon.Icon = [System.Drawing.SystemIcons]::Application
$trayIcon.Text = "Glaido Pro — Ready (Alt+Space or Ctrl+Space)"
$trayIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$toggleItem = $menu.Items.Add("Start / Stop Dictation (Alt+Space)")
$toggleItem.Add_Click({ Toggle-Dictation })

$showItem = $menu.Items.Add("Show Glaido Pro")
$showItem.Add_Click({ Show-GlaidoWindow })

$null = $menu.Items.Add("-")
$quitItem = $menu.Items.Add("Quit")
$quitItem.Add_Click({
    $trayIcon.Visible = $false
    $hotKeyWin.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$trayIcon.ContextMenuStrip = $menu

$hotKeyWin = New-Object HotKeyWindow
$hotKeyWin.Add_HotKeyPressed({ Toggle-Dictation })

[System.Windows.Forms.Application]::Run()
