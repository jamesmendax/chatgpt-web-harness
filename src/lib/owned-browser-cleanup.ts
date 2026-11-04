import type { BrowserServer } from "playwright-core";

type OwnedServer = Pick<BrowserServer, "process" | "close" | "kill">;

// The BrowserServer handle is obtained from our own launchServer call. Never
// discover a PID by port/name or terminate a browser owned by another caller.
export async function closeOwnedBrowserServer(server: OwnedServer, budgetMs: number): Promise<void> {
  const child = server.process();
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const total = Math.max(1, Math.floor(budgetMs));
  const started = Date.now();
  const waitForExit = (ms: number): Promise<void> => new Promise((resolve, reject) => {
    if (exited()) return resolve();
    const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
    const timer = setTimeout(() => {
      child.removeListener("exit", done);
      reject(new Error("Owned visual browser did not exit within cleanup budget"));
    }, Math.max(1, ms));
    child.once("exit", done);
    if (exited()) done();
  });

  // Observe native process exit, not only a close acknowledgement or websocket
  // disconnect. Temp-directory cleanup may finish later without a live browser.
  void server.close().catch(() => undefined);
  try {
    await waitForExit(Math.min(3000, Math.max(1, Math.floor(total / 2))));
    return;
  } catch {
    if (exited()) return;
  }
  const remaining = Math.max(1, total - (Date.now() - started));
  const exit = waitForExit(remaining);
  void server.kill().catch(() => undefined);
  await exit;
}