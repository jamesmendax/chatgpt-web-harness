import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const queues = new Map<string, Promise<void>>();
const transient = new Set(["EPERM", "EACCES", "EBUSY"]);

async function retryFileOperation(operation: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await operation(); return; }
    catch (error) {
      if (!transient.has((error as NodeJS.ErrnoException)?.code || "") || attempt >= 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function durableTemp(file: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temp, "wx");
  try { await handle.writeFile(content, "utf8"); await handle.sync(); }
  catch (error) { await handle.close(); await fs.rm(temp, { force: true }).catch(() => undefined); throw error; }
  await handle.close();
  return temp;
}

// Readers see one complete document. In-process heartbeats and final receipts
// are serialized so a late rename cannot roll a completed state backward.
export function writeRecoveryJson(file: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2) + "\n";
  const previous = queues.get(file) || Promise.resolve();
  const job = previous.then(async () => {
    const temp = await durableTemp(file, content);
    try { await retryFileOperation(() => fs.rename(temp, file)); }
    finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
  });
  const tail = job.catch(() => undefined);
  queues.set(file, tail);
  void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
  return job;
}

// Hard-link publication is exclusive and atomic. A second submitter never
// observes an empty destination created before its contents have been written.
export async function publishRecoveryFile(file: string, content: string): Promise<"created" | "exists"> {
  const temp = await durableTemp(file, content);
  try {
    try { await retryFileOperation(() => fs.link(temp, file)); return "created"; }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return "exists"; throw error; }
  } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
