const pending = new Set<Promise<unknown>>();

/** Keep a reload from interrupting a write the user already started. */
export function trackUpdateWrite<T>(operation: Promise<T>): Promise<T> {
  const tracked = operation.finally(() => pending.delete(tracked));
  pending.add(tracked);
  return tracked;
}

export async function waitForUpdateWrites() {
  while (pending.size) await Promise.all([...pending]);
}
