import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = process.env.HARNESS_TEST_DIST_ROOT ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT) : path.join(sourceRoot, "dist");
const { chromeProcessMatchesLaunch, selectReexecutedChrome, sameChromeProcess, OwnedChromeProcess, ownedChromeDefinitelyExited } =
  await import(pathToFileURL(path.join(distRoot, "lib", "browser-use-chrome.js")).href);

const started = Date.parse("2026-11-04T11:00:00.000Z");
const launch = {
  launcher_pid: 4200, executable: "C:/Harness/chrome/chrome.exe",
  profile: "C:/Harness/隔离 browser/profile", port: 50851, started_at_ms: started,
};
const root = {
  pid: 4201, parent_pid: 4200, created_at: "2026-11-04T11:00:00.1200000Z",
  executable: launch.executable,
  command_line: '"C:/Harness/chrome/chrome.exe" "--user-data-dir=C:/Harness/隔离 browser/profile" --remote-debugging-port=50851 --do-not-de-elevate',
};
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS " + name);
}
await test("accept exact Windows launch identity across quoting and normalized paths", () => {
  for (const args of [
    '"--user-data-dir=C:/Harness/隔离 browser/profile" --remote-debugging-port=50851',
    '--user-data-dir="c:\\HARNESS\\隔离 browser\\profile\\" "--remote-debugging-port=50851"',
    '--remote-debugging-port="50851" "--user-data-dir=C:/Harness/隔离 browser/profile"',
  ]) {
    assert.equal(chromeProcessMatchesLaunch({ ...root, executable: "c:\\harness\\chrome\\CHROME.EXE", command_line: args }, launch), true);
  }
  const simple = { ...launch, profile: "C:/Harness/private" };
  assert.equal(chromeProcessMatchesLaunch({ ...root, command_line: "--user-data-dir=C:/Harness/private --remote-debugging-port=50851" }, simple), true);
  assert.equal(selectReexecutedChrome([root], launch), root);
});
await test("reject unrelated roots, partial paths, duplicate ownership flags and renderer children", () => {
  for (const candidate of [
    { ...root, pid: 0 },
    { ...root, parent_pid: 4199 },
    { ...root, executable: "C:/Other/chrome.exe" },
    { ...root, command_line: root.command_line.replace("profile", "profile-other") },
    { ...root, command_line: root.command_line.replace("50851", "50852") },
    { ...root, command_line: root.command_line + ' "--user-data-dir=C:/Harness/隔离 browser/profile"' },
    { ...root, command_line: root.command_line + " --remote-debugging-port=50851" },
    { ...root, command_line: root.command_line + " --type=renderer" },
    { ...root, command_line: root.command_line + ' "--type=gpu-process"' },
    { ...root, command_line: "--user-data-dir= --remote-debugging-port=50851" },
  ]) assert.equal(chromeProcessMatchesLaunch(candidate, launch), false, JSON.stringify(candidate));
  assert.equal(selectReexecutedChrome([{ ...root, parent_pid: 4201 }], launch), undefined);
  assert.throws(() => selectReexecutedChrome([root, { ...root, pid: 4202 }], launch), /IDENTITY_AMBIGUOUS/);
});
await test("reject stale creation windows and reused PIDs", () => {
  for (const created_at of ["invalid", "2026-11-04T10:59:59.749Z", "2026-11-04T11:00:25.001Z"])
    assert.equal(chromeProcessMatchesLaunch({ ...root, created_at }, launch), false);
  assert.equal(sameChromeProcess({ ...root }, root, launch), true);
  assert.equal(sameChromeProcess({ ...root, created_at: "2026-11-04T11:00:00.1210000Z" }, root, launch), false);
  assert.equal(sameChromeProcess({ ...root, pid: 4202 }, root, launch), false);
});

function ownerFixture(kill, definitelyExited) {
  const registrations = new Map();
  const launcher = { pid: launch.launcher_pid, exitCode: null, signalCode: null };
  const owner = new OwnedChromeProcess(launcher, launch,
    (pid, guard) => registrations.set(pid, guard),
    pid => registrations.delete(pid), kill, definitelyExited);
  assert.equal(registrations.get(launch.launcher_pid)(), launch.launcher_pid);
  return { owner, registrations, launcher };
}
await test("close terminates both the original root and a replacement adopted during cleanup", async () => {
  const killed = [];
  const { owner, registrations } = ownerFixture(pid => killed.push(pid));
  let checks = 0;
  owner.refresh = async () => {
    checks++;
    if (checks === 2) owner.identity = root;
    return checks < 3;
  };
  await owner.close();
  assert.deepEqual(killed, [launch.launcher_pid, root.pid]);
  assert.equal(registrations.size, 0);
});
await test("slow successful termination confirms exit before reporting a deadline failure", async () => {
  const realNow = Date.now;
  let now = realNow(), alive = true, checks = 0;
  const { owner, registrations } = ownerFixture(() => { now += 20_000; alive = false; });
  owner.refresh = async () => { checks++; return alive; };
  Date.now = () => now;
  try { await owner.close(); }
  finally { Date.now = realNow; }
  assert.ok(checks >= 2, "cleanup must confirm exit after the slow termination");
  assert.equal(registrations.size, 0);
});
await test("a surviving owned root retains its cleanup registration and reports failure", async () => {
  const realNow = Date.now;
  let now = realNow(), kills = 0;
  const { owner, registrations } = ownerFixture(() => { kills++; now += 20_000; });
  owner.refresh = async () => true;
  Date.now = () => now;
  try { await assert.rejects(() => owner.close(), /CLOSE_INCOMPLETE/); }
  finally { Date.now = realNow; }
  assert.equal(kills, 1);
  assert.equal(registrations.size, 1);
});
await test("ambiguous native ownership never authorizes termination", async () => {
  let kills = 0;
  const { owner, registrations } = ownerFixture(() => kills++);
  owner.refresh = async () => { throw new Error("BROWSER_CHROME_IDENTITY_AMBIGUOUS"); };
  await assert.rejects(() => owner.close(), /IDENTITY_AMBIGUOUS/);
  assert.equal(kills, 0);
  assert.equal(registrations.size, 1);
});
await test("matching terminated identity releases a retained CIM object after one kill", async () => {
  const killed = [], observed = [];
  const { owner, registrations } = ownerFixture(pid => killed.push(pid), async identity => {
    observed.push(identity); return true;
  });
  owner.identity = root;
  owner.refresh = async () => true;
  await owner.close();
  assert.deepEqual(killed, [root.pid]); assert.equal(observed.length, 1);
  assert.deepEqual(observed[0], root); assert.equal(registrations.size, 0);
});
await test("unknown native status preserves the cleanup registration and fails closed", async () => {
  const realNow = Date.now;
  let now = realNow(), probes = 0, kills = 0;
  const { owner, registrations } = ownerFixture(() => { kills++; now += 20_000; }, async () => { probes++; return false; });
  owner.identity = root;
  owner.refresh = async () => true;
  Date.now = () => now;
  try { await assert.rejects(() => owner.close(), /CLOSE_INCOMPLETE/); }
  finally { Date.now = realNow; }
  assert.equal(kills, 1); assert.equal(probes, 1); assert.equal(registrations.size, 1);
});
await test("a replacement identity is killed before its exit proof can release it", async () => {
  const killed = [], probes = [];
  const replacement = { ...root, pid: root.pid + 1 };
  const { owner } = ownerFixture(pid => killed.push(pid), async identity => { probes.push(identity.pid); return true; });
  owner.identity = root;
  let checks = 0;
  owner.refresh = async () => { if (++checks === 2) owner.identity = replacement; return true; };
  await owner.close();
  assert.deepEqual(killed, [root.pid, replacement.pid]);
  assert.deepEqual(probes, [replacement.pid]);
});
if (process.platform === "win32") await test("native handle proves only matching terminated process, even while a handle remains open", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  assert.ok(child.pid);
  let holder;
  try {
    const query = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}"; if(-not $p){exit 1}; [Console]::Out.Write($p.CreationDate.ToUniversalTime().ToString('o'))`;
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], { windowsHide: true, timeout: 10000 });
    const identity = { ...root, pid: child.pid, created_at: String(stdout).trim() };
    const holdScript = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HoldFixtureHandle {
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h=[HoldFixtureHandle]::OpenProcess(0x1000,$false,${child.pid})
if($h -eq [IntPtr]::Zero){throw 'OpenProcess failed'}
try {[Console]::Out.WriteLine('READY');[Console]::Out.Flush();[void][Console]::In.ReadLine()}
finally {[HoldFixtureHandle]::CloseHandle($h)|Out-Null}
`;
    holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(holdScript, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      let output = "", errors = "";
      const timer = setTimeout(() => reject(new Error("fixture handle did not open: " + errors)), 10000);
      holder.stderr.on("data", chunk => errors += chunk);
      holder.stdout.on("data", chunk => { output += chunk; if (output.includes("READY")) { clearTimeout(timer); resolve(); } });
      holder.once("error", error => { clearTimeout(timer); reject(error); });
      holder.once("exit", code => { if (!output.includes("READY")) { clearTimeout(timer); reject(new Error("fixture handle exit: " + code + " " + errors)); } });
    });
    assert.equal(await ownedChromeDefinitelyExited(identity), false, "active process cannot be declared exited");
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill(); await exited;
    assert.equal(await ownedChromeDefinitelyExited(identity), true, "terminated process handle should prove exit");
    const altered = identity.created_at.slice(0, 25) + (identity.created_at[25] === "9" ? "8" : "9") + identity.created_at.slice(26);
    assert.equal(await ownedChromeDefinitelyExited({ ...identity, created_at: altered }), false, "different microsecond cannot authorize exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const closed = new Promise(resolve => holder.once("close", resolve)); holder.stdin.end("\n"); await closed;
    }
  }
});
console.log("browser-use-chrome: " + passed + " checks passed");
