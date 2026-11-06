/** Process-local optimization only: eviction must never deny a tool operation. */
export class BoundedContextCache<T> {
  private readonly entries = new Map<string, { value: T; accessed: number }>();

  constructor(private readonly capacity: () => number, private readonly idleMs: () => number) {}

  private prune(now = Date.now()): void {
    const idle = this.idleMs();
    for (const [key, entry] of this.entries) {
      if (now - entry.accessed >= idle) this.entries.delete(key);
    }
    while (this.entries.size > this.capacity()) this.entries.delete(this.entries.keys().next().value!);
  }

  get(key: string): T | undefined {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.accessed = Date.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Identity check for async completion: neither revive nor replace a newer entry. */
  peek(key: string): T | undefined {
    this.prune();
    return this.entries.get(key)?.value;
  }

  set(key: string, value: T): void {
    this.prune();
    this.entries.delete(key);
    this.entries.set(key, { value, accessed: Date.now() });
    while (this.entries.size > this.capacity()) this.entries.delete(this.entries.keys().next().value!);
  }

  delete(key: string): boolean { return this.entries.delete(key); }
  keys(): IterableIterator<string> { this.prune(); return this.entries.keys(); }
  get size(): number { this.prune(); return this.entries.size; }
}

export function boundedCacheEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
