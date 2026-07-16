// A tiny worker-pool: run `fn` over `items` with at most `limit` in flight at
// once. Fail-fast — the first rejection stops any worker from picking up new
// work and propagates once the in-flight calls it started have settled. This
// is the same pattern client.ts already hand-rolled twice (copyObjects'
// object pool, copyObject's part pool); factored out here so every caller —
// s3 copy/delete batching, and the UI's bulk move/delete loops — shares one
// implementation instead of a third (or fourth) copy of it.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => worker()),
  );

  return results;
}
