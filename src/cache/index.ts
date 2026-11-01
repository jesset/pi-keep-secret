/** clean cache 公共出口（T4 交付；掩码检测入口与配置层共用）。 */
export {
	createCleanCache,
	type CleanCache,
	type CleanCacheOptions,
	type CleanCacheStats,
	type ScanOutcome,
} from "./clean-cache.ts";
