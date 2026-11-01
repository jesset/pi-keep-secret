/**
 * systemone 候选抽取(judge 判定输入,纯函数)。
 *
 * 字符类、URL 区间感知、句读修剪、长度闸门的语义全部对齐参考实现
 * _extract_candidates;判定本身(凭据/普通串)归 T5 的 judge,本模块只负责
 * 「送什么去判」。中文等非 ASCII 文本不会整句命中,只抽出其中嵌入的
 * ASCII 串;低熵短串(纯数字密码、简单口令)靠 minLength(默认 6)进入
 * 候选,由 judge 结合上下文甄别。
 */

/** judge 候选:[start, end) 区间 + 值(修剪后,span 与值同步收窄)。 */
export interface Candidate {
	start: number;
	end: number;
	value: string;
}

/** ASCII 高熵候选串:字母数字开头,后接凭据/密码常见字符(含 !@#$%&* 等)。 */
const CANDIDATE_RE = /[A-Za-z0-9][A-Za-z0-9+/_:=.$!@#%&*~-]*/g;

/** URL 区间:URL 内部的高熵串(缩略图/追踪参数/路径 hash)不是凭据,撕成碎片送判定只会误报。 */
const URL_RE = /(?:(?:https?|ftp):\/\/|www\.)[^\s<>"')\]]+/g;

/**
 * 凭据暗示参数名:api_key/token/secret/key/sig/signature/password/auth/
 * access_token/client_secret,容忍 -/_ 变体、大小写不敏感;其取值单独成
 * 候选——URL 里藏真 key 仍可检出。
 */
const URL_CRED_PARAM_RE =
	/[?&](?:api[_-]?key|access[_-]?token|auth|client[_-]?secret|key|password|secret|sig|signature|token)=([A-Za-z0-9/_:=%.$!~*-]+)/gi;

/** 候选长度上限:超长连续段是 base64/数据载荷而非 credential(真 secret 不会上千字符)。 */
const MAX_CANDIDATE_LEN = 512;

/**
 * 抽取 ASCII 高熵候选串(去重保首现),供 systemone 逐个判定:
 *
 * - 跳过含省略号(.../…)的串:错误信息/日志里对凭据的缩略回显
 *   (如 LiteLLM 401 的 "sk-...8989"),不是完整凭据;
 * - 尾部修剪 ./:(句读卷入会显著降判定概率);= 与 ! 是合法 secret
 *   字符(base64 padding/密码符号),不修剪,span 相应收窄;
 * - 长度 >512 丢弃;URL 区间不产碎片候选,凭据暗示参数名的取值除外;
 * - 结果按 (start, end, value) 升序。
 */
export function extractCandidates(text: string, minLength = 6): Candidate[] {
	const urlSpans: Array<[number, number]> = [];
	for (const m of text.matchAll(URL_RE)) {
		const start = m.index ?? 0;
		urlSpans.push([start, start + m[0].length]);
	}
	const inUrl = (pos: number): boolean =>
		urlSpans.some(([s, e]) => s <= pos && pos < e);

	const out = new Map<string, Candidate>();
	// 凭据暗示参数值:区间在 URL 内但单独成候选
	for (const m of text.matchAll(URL_CRED_PARAM_RE)) {
		const value = m[1];
		if (value.length < minLength || value.includes("...") || value.includes("…")) {
			continue;
		}
		const end = (m.index ?? 0) + m[0].length; // 捕获组在模式末尾,值区间的终点即匹配终点
		const start = end - value.length;
		out.set(`${start}:${end}:${value}`, { start, end, value });
	}

	const seen = new Map<string, number>();
	for (const m of text.matchAll(CANDIDATE_RE)) {
		const start = m.index ?? 0;
		const value = m[0].replace(/[.:]+$/, "");
		if (!value) {
			continue;
		}
		if (inUrl(start) || value.length < minLength || seen.has(value)) {
			continue;
		}
		if (value.includes("...") || value.includes("…")) {
			continue;
		}
		if (value.length > MAX_CANDIDATE_LEN) {
			continue;
		}
		seen.set(value, start);
	}
	for (const [value, start] of seen) {
		const end = start + value.length;
		const key = `${start}:${end}:${value}`;
		if (!out.has(key)) {
			out.set(key, { start, end, value });
		}
	}
	return [...out.values()].sort(
		(a, b) => a.start - b.start || a.end - b.end || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
	);
}
