$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Result([bool]$Ok, [object]$Data, [string]$ErrorMessage = "") {
  $result = [ordered]@{ ok = $Ok; data = $Data }
  if ($ErrorMessage) { $result.error = $ErrorMessage }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 10 -Compress))
}

function Test-SecureEqual([string]$Left, [string]$Right) {
  $a = [System.Text.Encoding]::UTF8.GetBytes([string]$Left)
  $b = [System.Text.Encoding]::UTF8.GetBytes([string]$Right)
  if ($a.Length -ne $b.Length) { return $false }
  $difference = 0
  for ($i = 0; $i -lt $a.Length; $i++) { $difference = $difference -bor ($a[$i] -bxor $b[$i]) }
  return $difference -eq 0
}

try {
  $raw = [Console]::In.ReadToEnd()
  if (-not $raw.Trim()) { throw "Computer Use request is empty" }
  $request = $raw | ConvertFrom-Json
  $capabilityPath = [string]$env:HARNESS_COMPUTER_USE_CAPABILITY_FILE
  if (-not [IO.Path]::IsPathRooted($capabilityPath) -or -not (Test-Path -LiteralPath $capabilityPath -PathType Leaf)) {
    throw "Computer Use capability file is missing"
  }
  $capability = Get-Content -LiteralPath $capabilityPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($capability.schema_version -ne 1 -or $capability.provider -ne "computer-use") { throw "Unsupported Computer Use capability" }
  if (-not (Test-SecureEqual ([string]$capability.token) ([string]$request.token))) { throw "Computer Use token rejected" }
  if (-not (Test-SecureEqual ([string]$capability.token) ([string]$env:HARNESS_COMPUTER_USE_TOKEN))) { throw "Computer Use environment token rejected" }
  if (-not (Test-SecureEqual ([string]$capability.instance_id) ([string]$request.instance_id))) { throw "Computer Use instance rejected" }
  if (-not (Test-SecureEqual ([string]$capability.instance_id) ([string]$env:HARNESS_COMPUTER_USE_INSTANCE_ID))) { throw "Computer Use environment instance rejected" }
  if ($env:HARNESS_ACCOUNT_ID -and $capability.account_id -ne $env:HARNESS_ACCOUNT_ID) { throw "Computer Use account rejected" }
  if ([DateTimeOffset]::Parse([string]$capability.expires_at).UtcDateTime -le [DateTime]::UtcNow) { throw "Computer Use capability expired" }
  $actualHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not (Test-SecureEqual $actualHash ([string]$capability.helper_sha256).ToLowerInvariant())) { throw "Computer Use helper hash rejected" }
  if (-not (Test-SecureEqual $actualHash ([string]$env:HARNESS_COMPUTER_USE_HELPER_SHA256).ToLowerInvariant())) { throw "Computer Use helper environment hash rejected" }

  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace HarnessComputerUse {
  public sealed class WindowRecord {
    public string hwnd { get; set; }
    public string title { get; set; }
    public string class_name { get; set; }
    public uint pid { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int width { get; set; }
    public int height { get; set; }
  }

  public static class Native {
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    // GDI capture, window bounds and cursor input must use the same physical pixels.
    public static void EnablePhysicalCoordinates() {
      try {
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
      } catch (EntryPointNotFoundException) { }
      if (!SetProcessDPIAware()) throw new InvalidOperationException("Cannot establish physical-pixel coordinates; no input was sent");
    }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);

    public static WindowRecord Info(IntPtr hWnd) {
      if (!IsWindow(hWnd) || !IsWindowVisible(hWnd)) throw new InvalidOperationException("Target window no longer exists or is not visible");
      int length = Math.Min(GetWindowTextLength(hWnd) + 1, 4097);
      var title = new StringBuilder(Math.Max(length, 2)); GetWindowText(hWnd, title, title.Capacity);
      var cls = new StringBuilder(512); GetClassName(hWnd, cls, cls.Capacity);
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      RECT rect; if (!GetWindowRect(hWnd, out rect)) throw new InvalidOperationException("Cannot read target window bounds");
      return new WindowRecord { hwnd = hWnd.ToInt64().ToString(), title = title.ToString(), class_name = cls.ToString(), pid = pid,
        x = rect.Left, y = rect.Top, width = Math.Max(0, rect.Right - rect.Left), height = Math.Max(0, rect.Bottom - rect.Top) };
    }

    public static WindowRecord[] ListWindows() {
      var result = new List<WindowRecord>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr extra) {
        try { var item = Info(hWnd); if (!String.IsNullOrWhiteSpace(item.title) && item.width > 0 && item.height > 0) result.Add(item); } catch {}
        return result.Count < 512;
      }, IntPtr.Zero);
      return result.ToArray();
    }

    public static void Activate(IntPtr hWnd) {
      if (!IsWindow(hWnd)) throw new InvalidOperationException("Target window no longer exists");
      uint ignored;
      uint targetThread = GetWindowThreadProcessId(hWnd, out ignored);
      uint currentThread = GetCurrentThreadId();
      IntPtr foreground = GetForegroundWindow();
      uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
      bool attachedForeground = false;
      bool attachedTarget = false;
      try {
        if (foregroundThread != 0 && foregroundThread != currentThread)
          attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
        if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread)
          attachedTarget = AttachThreadInput(currentThread, targetThread, true);
        ShowWindowAsync(hWnd, 9);
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
        Thread.Sleep(250);
      } finally {
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
      }
      if (GetForegroundWindow() != hWnd) throw new InvalidOperationException("Windows refused to activate the selected window; no input was sent");
    }

    public static void SendUnicode(string text) {
      foreach (char ch in text) {
        var input = new INPUT[2];
        input[0].type = 1; input[0].U.ki.wScan = ch; input[0].U.ki.dwFlags = 0x0004;
        input[1].type = 1; input[1].U.ki.wScan = ch; input[1].U.ki.dwFlags = 0x0004 | 0x0002;
        if (SendInput(2, input, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("Windows rejected Unicode keyboard input");
      }
    }

    public static void PressKeys(int[] keys) {
      foreach (int key in keys) keybd_event((byte)key, 0, 0, UIntPtr.Zero);
      for (int i = keys.Length - 1; i >= 0; i--) keybd_event((byte)keys[i], 0, 0x0002, UIntPtr.Zero);
    }
  }
}
"@

  [HarnessComputerUse.Native]::EnablePhysicalCoordinates()

  function Get-TargetBounds([object]$Target) {
    if (-not $Target -or $Target.kind -eq "desktop") {
      $rect = [System.Windows.Forms.SystemInformation]::VirtualScreen
      return [ordered]@{ x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height; hwnd = $null }
    }
    if ($Target.kind -ne "window" -or ([string]$Target.hwnd) -notmatch '^\d{1,20}$') { throw "Invalid selected target" }
    $hwnd = [IntPtr]::new([Int64]([string]$Target.hwnd))
    $info = [HarnessComputerUse.Native]::Info($hwnd)
    return [ordered]@{ x = $info.x; y = $info.y; width = $info.width; height = $info.height; hwnd = $hwnd; title = $info.title; pid = $info.pid }
  }

  function Activate-Target([object]$Bounds) {
    if ($Bounds.hwnd) { [HarnessComputerUse.Native]::Activate([IntPtr]$Bounds.hwnd) }
  }

  function Resolve-Point([object]$Bounds, [object]$RawX, [object]$RawY) {
    $x = [int]$RawX; $y = [int]$RawY
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $Bounds.width -or $y -ge $Bounds.height) {
      throw "Point is outside the selected target bounds"
    }
    return [ordered]@{ x = $Bounds.x + $x; y = $Bounds.y + $y; relative_x = $x; relative_y = $y }
  }

  function Invoke-MouseClick([string]$Button, [bool]$Double) {
    $down = 0x0002; $up = 0x0004
    if ($Button -eq "right") { $down = 0x0008; $up = 0x0010 }
    elseif ($Button -eq "middle") { $down = 0x0020; $up = 0x0040 }
    $count = if ($Double) { 2 } else { 1 }
    for ($i = 0; $i -lt $count; $i++) {
      [HarnessComputerUse.Native]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [HarnessComputerUse.Native]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($Double -and $i -eq 0) { Start-Sleep -Milliseconds 80 }
    }
  }

  function Get-VirtualKey([string]$Raw) {
    $key = $Raw.Trim().ToUpperInvariant()
    $map = @{
      'CTRL'=0x11; 'CONTROL'=0x11; 'SHIFT'=0x10; 'ALT'=0x12; 'META'=0x5B; 'WIN'=0x5B;
      'ENTER'=0x0D; 'RETURN'=0x0D; 'TAB'=0x09; 'ESC'=0x1B; 'ESCAPE'=0x1B;
      'BACKSPACE'=0x08; 'DELETE'=0x2E; 'SPACE'=0x20; 'LEFT'=0x25; 'UP'=0x26;
      'RIGHT'=0x27; 'DOWN'=0x28; 'HOME'=0x24; 'END'=0x23; 'PAGEUP'=0x21; 'PAGEDOWN'=0x22;
      'F1'=0x70; 'F2'=0x71; 'F3'=0x72; 'F4'=0x73; 'F5'=0x74; 'F6'=0x75;
      'F7'=0x76; 'F8'=0x77; 'F9'=0x78; 'F10'=0x79; 'F11'=0x7A; 'F12'=0x7B
    }
    if ($map.ContainsKey($key)) { return [int]$map[$key] }
    if ($key.Length -eq 1 -and $key -match '^[A-Z0-9]$') { return [int][char]$key }
    throw "Unsupported key: $Raw"
  }

  $action = [string]$request.action
  switch ($action) {
    "status" {
      $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
      Write-Result $true ([ordered]@{ helper_version = "1.0.0"; desktop = @{ x=$screen.X; y=$screen.Y; width=$screen.Width; height=$screen.Height } })
    }
    "list_windows" {
      $windows = @([HarnessComputerUse.Native]::ListWindows()) | Sort-Object title | Select-Object -First 256
      Write-Result $true ([ordered]@{ windows = $windows; count = $windows.Count })
    }
    "window_info" {
      if (([string]$request.hwnd) -notmatch '^\d{1,20}$') { throw "window_info requires decimal hwnd" }
      $info = [HarnessComputerUse.Native]::Info([IntPtr]::new([Int64]([string]$request.hwnd)))
      Write-Result $true $info
    }
    "screenshot" {
      $bounds = Get-TargetBounds $request.selected_target
      if ($bounds.width -le 0 -or $bounds.height -le 0 -or ([Int64]$bounds.width * [Int64]$bounds.height) -gt 80000000) { throw "Selected target has invalid screenshot bounds" }
      $bitmap = [Drawing.Bitmap]::new($bounds.width, $bounds.height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      $stream = [IO.MemoryStream]::new()
      try {
        $graphics.CopyFromScreen($bounds.x, $bounds.y, 0, 0, $bitmap.Size, [Drawing.CopyPixelOperation]::SourceCopy)
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $encoded = [Convert]::ToBase64String($stream.ToArray())
      } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
      Write-Result $true ([ordered]@{ image_base64=$encoded; width=$bounds.width; height=$bounds.height })
    }
    { $_ -in @("move", "click", "double_click") } {
      $bounds = Get-TargetBounds $request.selected_target
      Activate-Target $bounds
      $point = Resolve-Point $bounds $request.x $request.y
      if (-not [HarnessComputerUse.Native]::SetCursorPos($point.x, $point.y)) { throw "Windows rejected cursor movement" }
      if ($action -ne "move") { Invoke-MouseClick ([string]$request.button) ($action -eq "double_click") }
      Write-Result $true ([ordered]@{ action=$action; x=$point.relative_x; y=$point.relative_y; button=[string]$request.button })
    }
    "drag" {
      $bounds = Get-TargetBounds $request.selected_target
      Activate-Target $bounds
      $from = Resolve-Point $bounds $request.x $request.y
      $to = Resolve-Point $bounds $request.to_x $request.to_y
      [HarnessComputerUse.Native]::SetCursorPos($from.x, $from.y) | Out-Null
      [HarnessComputerUse.Native]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
      try {
        for ($i=1; $i -le 12; $i++) {
          $x=[int]($from.x + (($to.x-$from.x)*$i/12)); $y=[int]($from.y + (($to.y-$from.y)*$i/12))
          [HarnessComputerUse.Native]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 20
        }
      } finally { [HarnessComputerUse.Native]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero) }
      Write-Result $true ([ordered]@{ action="drag"; from=@{x=$from.relative_x;y=$from.relative_y}; to=@{x=$to.relative_x;y=$to.relative_y} })
    }
    "type" {
      $bounds = Get-TargetBounds $request.selected_target
      Activate-Target $bounds
      $text = [string]$request.text
      if ($text.Length -gt 100000) { throw "Text exceeds 100000 characters" }
      if ($request.replace_existing -eq $true) {
        [HarnessComputerUse.Native]::PressKeys(@(0x11, 0x41))
        [HarnessComputerUse.Native]::PressKeys(@(0x08))
      }
      [HarnessComputerUse.Native]::SendUnicode($text)
      Write-Result $true ([ordered]@{ action="type"; characters=$text.Length; replaced_existing=($request.replace_existing -eq $true) })
    }
    "keypress" {
      $bounds = Get-TargetBounds $request.selected_target
      Activate-Target $bounds
      $keys = @($request.keys)
      if ($keys.Count -lt 1 -or $keys.Count -gt 8) { throw "keypress requires 1-8 keys" }
      [int[]]$virtualKeys = @($keys | ForEach-Object { Get-VirtualKey ([string]$_) })
      [HarnessComputerUse.Native]::PressKeys($virtualKeys)
      Write-Result $true ([ordered]@{ action="keypress"; keys=$keys })
    }
    "scroll" {
      $bounds = Get-TargetBounds $request.selected_target
      Activate-Target $bounds
      $dx = [int]$request.delta_x; $dy = [int]$request.delta_y
      # mouse_event takes an unsigned DWORD, while negative wheel deltas are
      # represented as their two's-complement bit pattern. A direct PowerShell
      # cast rejects negative values instead of preserving those bits.
      if ($dy -ne 0) {
        $wheelY = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$dy), 0)
        [HarnessComputerUse.Native]::mouse_event(0x0800,0,0,$wheelY,[UIntPtr]::Zero)
      }
      if ($dx -ne 0) {
        $wheelX = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$dx), 0)
        [HarnessComputerUse.Native]::mouse_event(0x01000,0,0,$wheelX,[UIntPtr]::Zero)
      }
      Write-Result $true ([ordered]@{ action="scroll"; delta_x=$dx; delta_y=$dy })
    }
    "wait" {
      $duration = [Math]::Min([Math]::Max([int]$request.duration_ms,0),30000)
      Start-Sleep -Milliseconds $duration
      Write-Result $true ([ordered]@{ waited_ms=$duration })
    }
    default { throw "Unsupported Computer Use action: $action" }
  }
} catch {
  Write-Result $false @{} $_.Exception.Message
}
