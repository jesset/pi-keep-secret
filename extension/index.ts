/**
 * pi-keep-secret 扩展入口（目录扩展 index.ts 工厂）。
 *
 * 当前能力：出站掩码（T2/ticket #4）+ 检测器 JSON 配置与 clean cache
 * （T4/ticket #6）——每次模型请求前对完整 transcript 的文本叶做检测
 * 并替换为确定性伪值；检测器集/调参来自配置文件（路径：参数 >
 * 环境变量 PI_KEEP_SECRET_CONFIG > ~/.pi/agent/extensions/pi-keep-secret/
 * config.json；文件缺失用内置默认集，非法回退默认集并报错可见），
 * 干净文本结论缓存把每轮成本降到 O(新增消息)。
 * 回程还原（T3）、judge（T5）、掩码压缩（T6）、/keep-secret 命令（T7）
 * 见规格 #1。
 *
 * 环境变量在工厂调用时读取（每次扩展装配重新解析，测试可按会话指向
 * 临时配置文件）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_PATH_ENV, createConfiguredMaskingExtension } from "../src/config/index.ts";

export default (pi: ExtensionAPI): void => {
	const { factory } = createConfiguredMaskingExtension({
		configPath: process.env[CONFIG_PATH_ENV],
	});
	factory(pi);
};
