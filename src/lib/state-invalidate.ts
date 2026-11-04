/**
 * Cross-module state invalidation seam. goals.ts / durable-tasks.ts mutate the
 * snapshot stores the Context Broker caches; they emit here and the broker
 * drops its cache for that workspace immediately, so the next tool call always
 * sees fresh state. The broker subscribes at module load; emitters must not
 * import the broker (circular).
 */

type Listener = (workspaceRoot: string) => void;

const listeners = new Set<Listener>();

export function onStateInvalidated(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyStateInvalidated(workspaceRoot: string): void {
  for (const listener of listeners) {
    try {
      listener(workspaceRoot);
    } catch {}
  }
}
