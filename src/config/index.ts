/**
 * 配置层公共出口（T4 交付）。
 *
 * - `createConfiguredMaskingExtension`：配置 × 出站掩码组合（正式扩展
 *   入口的装配方式；T7 的 /keep-secret reload/status 消费其 loader）。
 * - `createConfigLoader`：JSON 配置加载/校验/热重载（load/reload/订阅）。
 * - `CONFIG_PATH_ENV` / `defaultConfigPath()`：路径解析（参数 > 环境变量
 *   > ~/.pi/agent/extensions/pi-keep-secret/config.json）。
 */
export {
	createConfiguredMaskingExtension,
	type ConfiguredMasking,
	type ConfiguredMaskingOptions,
} from "./extension.ts";
export {
	CONFIG_PATH_ENV,
	configFingerprint,
	createConfigLoader,
	defaultConfigPath,
	type CleanCacheConfig,
	type ConfigLoader,
	type ConfigLoaderOptions,
	type JudgeConfig,
	type JudgeOnMissing,
	type ResolvedConfig,
} from "./loader.ts";
