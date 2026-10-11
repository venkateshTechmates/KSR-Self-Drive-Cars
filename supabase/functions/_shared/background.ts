// Fire-and-forget work (e.g. draining the outbox) that should not delay the response.
// On Supabase, EdgeRuntime.waitUntil keeps the worker alive until the promise settles.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

export function runInBackground(name: string, promise: Promise<unknown>): void {
  const guarded = promise.catch((err) => {
    const e = err as { name?: string; message?: string };
    console.error(`[${name}] background task failed`, e?.name ?? 'Error', e?.message ?? String(err));
  });
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime && typeof EdgeRuntime.waitUntil === 'function') {
    EdgeRuntime.waitUntil(guarded);
  }
}
