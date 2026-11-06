/**
 * Office is a shared COM server. CreateObject + a before/after PID difference
 * cannot prove ownership, so rendering binds only to an explicitly launched
 * process on a private desktop. Its lifetime belongs to a kill-on-close job;
 * no process-name enumeration is used for teardown.
 */
export const privateOfficeAutomationScript = String.raw`
param([string]$InputPath,[string]$OutputPath,[string]$Kind,[int]$Width=1200,[int]$Height=675)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class PrivateOfficeProcess : IDisposable {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
    public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long perProcess, perJob; public uint flags; public UIntPtr minimum, maximum;
    public uint activeProcesses; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr devmode, uint flags, uint access, IntPtr attributes);
  [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT limit, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  delegate bool WindowCallback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desktop, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder value, int capacity);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object result);
  IntPtr desktop, job, process;
  public uint ProcessId { get; private set; }
  public string DesktopName { get; private set; }
  public string WindowClasses { get; private set; }
  public long NativeWindow { get; private set; }
  public bool Closed { get; private set; }
  public bool IsRunning { get { uint code; return process != IntPtr.Zero && GetExitCodeProcess(process, out code) && code == 259; } }
  static void Check(bool ok, string stage) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "OFFICE_ISOLATION_FAILED: " + stage); }
  static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
  public PrivateOfficeProcess(string executable, string inputPath, string workingDirectory) {
    PROCESS_INFORMATION info = new PROCESS_INFORMATION();
    try {
      DesktopName = "WHOffice-" + Guid.NewGuid().ToString("N");
      desktop = CreateDesktop(DesktopName, IntPtr.Zero, IntPtr.Zero, 0, 0x01ff, IntPtr.Zero);
      Check(desktop != IntPtr.Zero, "create private desktop");
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero, "create owned job");
      EXTENDED_LIMIT limit = new EXTENDED_LIMIT(); limit.basic.flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))), "set kill-on-close job");
      STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      startup.lpDesktop = "WinSta0\\" + DesktopName; startup.dwFlags = 1; startup.wShowWindow = 0;
      // /x requests a separate Office instance. If Office forwards or ignores
      // it, the launched PID has no native object on this desktop and we fail.
      Check(CreateProcess(executable, new StringBuilder(Quote(executable) + " /x " + Quote(inputPath)), IntPtr.Zero, IntPtr.Zero, false, 0x00000004, IntPtr.Zero, workingDirectory, ref startup, out info), "create suspended Office process");
      process = info.process; ProcessId = info.processId;
      Check(AssignProcessToJobObject(job, process), "assign exact process to owned job");
      Check(ResumeThread(info.thread) != 0xffffffff, "resume exact owned process");
    } catch { if (process != IntPtr.Zero) TerminateProcess(process, 1); Dispose(); throw; }
    finally { if (info.thread != IntPtr.Zero) CloseHandle(info.thread); }
  }
  public object FindNativeObject(string kind) {
    if (!IsRunning) throw new InvalidOperationException("OFFICE_ISOLATION_FAILED: explicitly launched Office process exited before binding");
    var windows = new List<IntPtr>();
    WindowCallback collect = delegate(IntPtr hwnd, IntPtr unused) { uint pid; GetWindowThreadProcessId(hwnd, out pid); if (pid == ProcessId) windows.Add(hwnd); return true; };
    EnumDesktopWindows(desktop, delegate(IntPtr hwnd, IntPtr unused) { collect(hwnd, unused); EnumChildWindows(hwnd, collect, IntPtr.Zero); return true; }, IntPtr.Zero);
    var classes = new List<string>();
    foreach (IntPtr hwnd in windows) {
      var className = new StringBuilder(256); GetClassName(hwnd, className, className.Capacity);
      string label = className.ToString().Split('[')[0];
      if (!classes.Contains(label) && classes.Count < 40) classes.Add(label);
      string windowClass = className.ToString();
      if (kind == "pptx" ? windowClass != "paneClassDC" && windowClass != "mdiClass" && windowClass != "PPTFrameClass" : windowClass != "_WwG") continue;
      uint pid; GetWindowThreadProcessId(hwnd, out pid); if (pid != ProcessId) continue;
      Guid iid = new Guid("00020400-0000-0000-C000-000000000046"); object result;
      if (AccessibleObjectFromWindow(hwnd, 0xfffffff0, ref iid, out result) == 0 && result != null) { NativeWindow = hwnd.ToInt64(); return result; }
    }
    WindowClasses = String.Join(",", classes.ToArray());
    return null;
  }
  public bool OwnsWindow(long window) { uint pid; GetWindowThreadProcessId(new IntPtr(window), out pid); return pid == ProcessId; }
  public void Dispose() {
    if (job != IntPtr.Zero) { TerminateJobObject(job, 0); CloseHandle(job); job = IntPtr.Zero; }
    if (process != IntPtr.Zero) { Closed = WaitForSingleObject(process, 5000) == 0; CloseHandle(process); process = IntPtr.Zero; }
    if (desktop != IntPtr.Zero) { CloseDesktop(desktop); desktop = IntPtr.Zero; }
  }
}
'@

$exeName=if($Kind -eq 'pptx'){'POWERPNT.EXE'}else{'WINWORD.EXE'}
$executable=$null
foreach($base in @([Environment]::GetFolderPath('ProgramFiles'),[Environment]::GetFolderPath('ProgramFilesX86'))){
  if(!$base){continue}
  foreach($relative in @('Microsoft Office\root\Office16','Microsoft Office\Office16')){
    $candidate=Join-Path (Join-Path $base $relative) $exeName
    if(Test-Path -LiteralPath $candidate -PathType Leaf){$executable=$candidate;break}
  }
  if($executable){break}
}
if(!$executable){throw "OFFICE_RENDERER_UNAVAILABLE: $exeName was not found in a supported Office installation"}
$owned=$null;$native=$null;$app=$null;$document=$null;$ownership=$null
$ownershipPath=Join-Path (Split-Path -Parent $InputPath) 'office-process.json'
try {
  $owned=[PrivateOfficeProcess]::new($executable,$InputPath,(Split-Path -Parent $InputPath))
  $ownership=@{ownership='explicit-process-private-desktop-job';pid=$owned.ProcessId;desktop=$owned.DesktopName;kind=$Kind;status='started'}
  $ownership|ConvertTo-Json -Compress|Write-Output
  $end=[DateTime]::UtcNow.AddSeconds(45)
  while(!$native -and [DateTime]::UtcNow -lt $end){
    $native=$owned.FindNativeObject($Kind)
    if(!$native){Start-Sleep -Milliseconds 100}
  }
  if(!$native){throw ('OFFICE_ISOLATION_FAILED: owned private-desktop window did not expose the Office native object; owned window classes: '+$owned.WindowClasses)}
  # Modern PowerPoint's main frame exposes Application itself; its document
  # windows and Word's _WwG expose a window with an Application property.
  if($Kind -eq 'pptx' -and $null -ne $native.Presentations){$app=$native}else{$app=$native.Application}
  $ownership['native_type']=$native.GetType().FullName
  $ownership['native_window']=$owned.NativeWindow
  if(!$app -or !$owned.OwnsWindow($owned.NativeWindow)){throw 'OFFICE_ISOLATION_FAILED: native application window did not belong to the explicitly launched process'}
  # Assign inside each branch: emitting an Office collection through the
  # PowerShell pipeline enumerates it into documents (or null during startup).
  if($Kind -eq 'pptx'){$documents=$app.Presentations}else{$documents=$app.Documents}
  while($documents.Count -eq 0 -and [DateTime]::UtcNow -lt $end){Start-Sleep -Milliseconds 100}
  if($documents.Count -ne 1){throw ('OFFICE_ISOLATION_FAILED: owned instance did not contain exactly its isolated input copy; document count: '+$documents.Count)}
  $document=$documents.Item(1)
  if([IO.Path]::GetFullPath($document.FullName) -ne [IO.Path]::GetFullPath($InputPath)){throw 'OFFICE_ISOLATION_FAILED: native document binding did not match the isolated input copy'}
  $ownership['binding']='exact-owned-window-and-input-copy'
  if($Kind -eq 'pptx'){$document.Export($OutputPath,'PNG',$Width,$Height)}else{$document.ExportAsFixedFormat($OutputPath,17)}
  $ownership['result']='rendered'
} finally {
  # This job contains only the process explicitly created on the private
  # desktop. Dispose uses its retained handle, never a PID or process name.
  if($owned){
    $owned.Dispose()
    $ownership['status']=if($owned.Closed){'closed'}else{'cleanup-incomplete'}
    [IO.File]::WriteAllText($ownershipPath,($ownership|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    if(!$owned.Closed){throw 'OFFICE_CLEANUP_FAILED: owned process did not exit within its job cleanup deadline'}
  }
}
`;
