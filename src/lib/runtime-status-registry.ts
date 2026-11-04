export type RuntimeStatusProvider = () => unknown;

const providers = new Map<string, RuntimeStatusProvider>();

/** Tools publish read-only runtime summaries here so other tools do not import
 * sibling tool modules. The registry is intentionally process-local and is not
 * an execution truth source; durable recovery remains in the dedicated stores. */
export function registerRuntimeStatusProvider(name: string, provider: RuntimeStatusProvider): void {
  providers.set(name, provider);
}

export function unregisterRuntimeStatusProvider(name: string, provider?: RuntimeStatusProvider): void {
  if (!provider || providers.get(name) === provider) providers.delete(name);
}

export function getRuntimeStatus(name: string): unknown {
  const provider = providers.get(name);
  if (!provider) return { available: false };
  try { return provider(); }
  catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function getRuntimeStatuses(): Record<string, unknown> {
  return Object.fromEntries([...providers.keys()].sort().map((name) => [name, getRuntimeStatus(name)]));
}
