/**
 * Evict-beyond-limit helper for collections whose Map/Set iteration order is
 * the LRU position (head = oldest write). Used by the clean cache's expiry
 * and dirty tables. The placeholder registry keeps its own eviction loop
 * because it must clean a reverse index alongside the entries (T20, #21).
 * Returns the number of evicted entries (callers count stats or ignore).
 */
export function evictLRU<T>(collection: Set<string> | Map<string, T>, limit: number): number {
	let evicted = 0;
	while (collection.size > limit) {
		const oldest = collection.keys().next().value;
		if (oldest === undefined) break;
		collection.delete(oldest);
		evicted++;
	}
	return evicted;
}
