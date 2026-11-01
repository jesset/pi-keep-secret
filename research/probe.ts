/**
 * 可行性探针(实验代码, 非正式实现):
 * 1. context_with_system: 出站把哨兵串 SENTINEL123 替换为伪值 ZZMASKED456
 * 2. message_end: 回程把伪值还原为哨兵串, 验证「provider 只见伪值 + 本地记录真值」闭环
 * 3. 顺带记录 before_provider_request payload / provider_stream_event 形态
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/pi-keep-secret-probe.log";
const REAL = "SENTINEL123";
const FAKE = "ZZMASKED456";

function log(label: string, data: unknown) {
	try {
		const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
		appendFileSync(LOG, `\n===== ${label} =====\n${(text ?? "").slice(0, 6000)}\n`);
	} catch {}
}

function maskText(s: string): string {
	return s.split(REAL).join(FAKE);
}
function unmaskText(s: string): string {
	return s.split(FAKE).join(REAL);
}

export default function (pi: ExtensionAPI) {
	log("probe-loaded", new Date().toISOString());

	pi.on("context_with_system", (event, ctx) => {
		log("ctx_with_system.roles", event.messages.map((m) => m.role));
		for (const m of event.messages) {
			if (m.role === "user") {
				if (typeof m.content === "string") {
					if (m.content.includes(REAL)) {
						m.content = maskText(m.content);
						log("ctx.user-masked", m.content);
					}
				} else if (Array.isArray(m.content)) {
					for (const part of m.content) {
						if (part.type === "text" && part.text.includes(REAL)) {
							part.text = maskText(part.text);
							log("ctx.user-block-masked", part.text);
						}
					}
				}
			}
		}
		return undefined;
	});

	pi.on("before_provider_request", (event) => {
		const p = event.payload as Record<string, unknown>;
		log("before_provider_request.keys", Object.keys(p ?? {}));
		const msgs = p?.messages as unknown[] | undefined;
		if (msgs) log("before_provider_request.last", JSON.stringify(msgs[msgs.length - 1])?.slice(0, 1500));
		// 证明该 hook 也能改写最终载荷(返回值替换)
		if (typeof p === "object" && p !== null && Array.isArray(msgs)) {
			// no-op: 只记录, 不改
		}
		return undefined;
	});

	pi.on("provider_stream_event", (event) => {
		// 只记录形态一次
		log("provider_stream_event", { provider: event.provider, api: event.api, type: (event.data as any)?.type });
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return undefined;
			const m = event.message;
		let changed = false;
		for (const part of m.content) {
			if (part.type === "text" && part.text.includes(FAKE)) {
				log("message_end.saw-fake", part.text.slice(0, 400));
				part.text = unmaskText(part.text);
				changed = true;
			}
			if (part.type === "thinking" && part.thinking.includes(FAKE)) {
				part.thinking = unmaskText(part.thinking);
				changed = true;
			}
			if (part.type === "toolCall") {
				const before = JSON.stringify(part.arguments);
				const after = unmaskText(before);
				if (after !== before) {
					part.arguments = JSON.parse(after);
					log("message_end.toolcall-unmasked", `${part.name}: ${after.slice(0, 300)}`);
					changed = true;
				}
			}
		}
		if (changed) {
			log("message_end.returned-unmasked", "yes");
			return { message: m };
		}
		return undefined;
	});
}
