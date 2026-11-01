/**
 * Map/Set 迭代序即 LRU 位序（头部 = 最旧写入）的超上限逐出工具：
 * clean cache 的 expiry/dirty 两表与伪值注册表 entries 三处同形循环的
 * 去重提取。返回逐出条数（调用方计入统计或忽略）。
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
