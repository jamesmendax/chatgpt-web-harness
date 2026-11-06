export type ProcessOutputStream = "stdout" | "stderr";
interface OutputSource { pause(): unknown; resume(): unknown; }
interface QueueOptions {
  highWaterBytes?: number;
  lowWaterBytes?: number;
  highWaterChunks?: number;
  lowWaterChunks?: number;
  onError?: (error: unknown) => void;
}

/** A single ordered writer shared by both pipes, including the in-flight chunk. */
export class ProcessOutputQueue {
  private readonly sources: OutputSource[];
  private readonly consume: (stream: ProcessOutputStream, bytes: Buffer) => Promise<void>;
  private readonly options: Required<Omit<QueueOptions, "onError">> & Pick<QueueOptions, "onError">;
  private readonly queue: Array<{ stream: ProcessOutputStream; bytes: Buffer }> = [];
  private pumping = false;
  private sourcesStopped = false;
  private idlePromise = Promise.resolve();
  private idleResolve: (() => void) | undefined;
  pendingBytes = 0;
  pendingChunks = 0;
  backpressured = false;
  revision = 0;

  constructor(sources: OutputSource[], consume: (stream: ProcessOutputStream, bytes: Buffer) => Promise<void>, options: QueueOptions = {}) {
    this.sources = sources;
    this.consume = consume;
    this.options = {
      highWaterBytes: options.highWaterBytes ?? 1024 * 1024,
      lowWaterBytes: options.lowWaterBytes ?? 256 * 1024,
      highWaterChunks: options.highWaterChunks ?? 128,
      lowWaterChunks: options.lowWaterChunks ?? 32,
      onError: options.onError,
    };
    if (this.options.lowWaterBytes < 0 || this.options.lowWaterChunks < 0 || this.options.highWaterBytes <= this.options.lowWaterBytes || this.options.highWaterChunks <= this.options.lowWaterChunks) throw new Error("Invalid process-output high/low water marks");
  }

  enqueue(stream: ProcessOutputStream, bytes: Buffer): void {
    if (!bytes.length) return;
    if (this.pendingChunks === 0 && !this.pumping) this.idlePromise = new Promise(resolve => { this.idleResolve = resolve; });
    this.queue.push({ stream, bytes });
    this.pendingBytes += bytes.length;
    this.pendingChunks++;
    this.revision++;
    this.updateBackpressure();
    if (!this.pumping) { this.pumping = true; void this.pump(); }
  }

  idle(): Promise<void> { return this.idlePromise; }

  /** Freeze pipe intake at the inherited-pipe cutoff; accepted chunks still drain. */
  stopSources(): void {
    this.sourcesStopped = true;
    this.backpressured = true;
    for (const source of this.sources) source.pause();
  }

  private updateBackpressure(): void {
    if (this.sourcesStopped) return;
    if (!this.backpressured && (this.pendingBytes >= this.options.highWaterBytes || this.pendingChunks >= this.options.highWaterChunks)) {
      this.backpressured = true;
      for (const source of this.sources) source.pause();
    } else if (this.backpressured && this.pendingBytes <= this.options.lowWaterBytes && this.pendingChunks <= this.options.lowWaterChunks) {
      this.backpressured = false;
      for (const source of this.sources) source.resume();
    }
  }

  private async pump(): Promise<void> {
    for (;;) {
      const next = this.queue.shift();
      if (!next) break;
      try { await this.consume(next.stream, next.bytes); }
      catch (error) { this.options.onError?.(error); }
      finally {
        this.pendingBytes -= next.bytes.length;
        this.pendingChunks--;
        this.revision++;
        this.updateBackpressure();
      }
    }
    this.pumping = false;
    const resolve = this.idleResolve;
    this.idleResolve = undefined;
    resolve?.();
  }
}

interface OutputFile {
  write(bytes: Buffer, offset: number, length: number, position: null): Promise<{ bytesWritten: number }>;
}

/** FileHandle.write is allowed to write fewer bytes than requested. */
export async function writeAllProcessOutput(file: OutputFile, output: Buffer | string): Promise<void> {
  const bytes = typeof output === "string" ? Buffer.from(output, "utf8") : output;
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - offset) throw new Error("Process log write made zero or invalid progress");
    offset += result.bytesWritten;
  }
}

interface DrainSnapshot { pendingBytes: number; backpressured: boolean; bufferedBytes: number; revision: number; }

/** Wait for own buffered output, but keep inherited pipes from running forever. */
export class PostExitOutputDrain {
  private idleSince: number | undefined;
  private lastRevision: number | undefined;
  constructor(private readonly exitedAt: number, private readonly idleLingerMs: number, private readonly maxDrainMs: number) {
    if (idleLingerMs < 0 || maxDrainMs < idleLingerMs) throw new Error("Invalid post-exit output drain deadlines");
  }
  evaluate(now: number, snapshot: DrainSnapshot): "wait" | "idle-cutoff" | "grace-cutoff" {
    if (now - this.exitedAt >= this.maxDrainMs) return "grace-cutoff";
    const changed = this.lastRevision !== snapshot.revision;
    this.lastRevision = snapshot.revision;
    if (snapshot.pendingBytes > 0 || snapshot.backpressured || snapshot.bufferedBytes > 0 || changed) { this.idleSince = undefined; return "wait"; }
    this.idleSince ??= now;
    return now - this.idleSince >= this.idleLingerMs ? "idle-cutoff" : "wait";
  }
}
