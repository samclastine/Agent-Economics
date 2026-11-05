/**
 * In-process registry of cancellable agent runs (demo pipeline + chat turns).
 * Next.js dev runs a single server process, so an AbortController map is
 * sufficient for the demo. Each key gets at most one active run —
 * acquiring a key aborts any previous run under it.
 */
// globalThis singleton: Next.js dev may evaluate this module once per route
// bundle, and abort keys must be shared across routes (chat vs demo/stop).
const g = globalThis as unknown as { __agentTreasuryRuns?: Map<string, AbortController> };
const controllers = (g.__agentTreasuryRuns ??= new Map<string, AbortController>());

export function acquireRun(key: string): { signal: AbortSignal; controller: AbortController } {
  // Mark supersession separately from a user stop so the old run can skip its
  // cancellation block — the replacement run will report the real outcome.
  controllers.get(key)?.abort('superseded');
  const controller = new AbortController();
  controllers.set(key, controller);
  return { signal: controller.signal, controller };
}

export function releaseRun(key: string, controller: AbortController) {
  if (controllers.get(key) === controller) controllers.delete(key);
}

/** Abort a single registered run by key (e.g. `chat:<agentId>`). */
export function abortRun(key: string): boolean {
  const c = controllers.get(key);
  if (!c || c.signal.aborted) return false;
  c.abort('user');
  return true;
}

/** Abort every registered run (demo pipeline and all chat turns). */
export function abortAllRuns(): number {
  let n = 0;
  for (const c of controllers.values()) {
    if (!c.signal.aborted) { c.abort('user'); n++; }
  }
  return n;
}

export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

export function abortError(): Error {
  const e = new Error('run cancelled by user');
  e.name = 'AbortError';
  return e;
}
