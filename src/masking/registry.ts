/**
 * Placeholder registry: in-process Map<placeholder, secret> plus a reverse
 * index Map<secret, placeholder>, session-scoped, capped at 5000 LRU entries.
 *
 * Lifecycle: created with the extension factory (one closure state per
 * session), dies with the process; no cross-process sharing or persistence
 * (spec #1 Implementation Decisions).
 *
 * Access surface (shared by T3 restoration / T5 judge):
 * - `issue(secret, template)`: issue a placeholder. **First-issuer-wins**
 *   (ticket #21): the first template that issues a secret pins its
 *   placeholder form for the session; later `template` arguments are only
 *   suggestions — one secret must never reach the provider in two different
 *   forms. Re-issuing refreshes the LRU order.
 * - Hash-collision fallback: when the computed placeholder already maps to a
 *   *different* secret, append "x" until free (reference secret_mask.py
 *   `_placeholder` ph+"x" strategy, applied at registry write). The reuse
 *   path never runs collision logic (its form is already pinned).
 * - `has`/`get`: idempotent filtering for the masking layer (skip spans that
 *   are already placeholders) and restoration lookups.
 * - `snapshot()`: placeholder→secret copy (tokens for engine unmaskText).
 *
 * LRU eviction keeps both indexes consistent: evicting a placeholder entry
 * drops its reverse entry too, so a post-eviction re-issue deterministically
 * follows the current template suggestion (no stale-form resurrection).
 */
import { makePlaceholder, redactText, type Span } from "../engine/index.ts";

/** Default capacity cap (aligned with the reference implementation 5000 LRU). */
const DEFAULT_LIMIT = 5000;
/** Default placeholder hash length (same default as engine makePlaceholder). */
const DEFAULT_HASH_LENGTH = 12;

export interface PlaceholderRegistryOptions {
	/** Capacity cap, default 5000; LRU-evicts the oldest writes beyond it. */
	limit?: number;
	/** Placeholder hash length, default 12. */
	hashLength?: number;
}

export interface PlaceholderRegistry {
	/** Issue a placeholder for a secret (deterministic; "x" suffix on hash
	 *  collision; first-issuer-wins across templates; write refreshes LRU). */
	issue(secret: string, template: string): string;
	/** Whether the value is already a placeholder in this registry (idempotent filtering). */
	has(placeholder: string): boolean;
	/** Placeholder → secret; undefined when unregistered. */
	get(placeholder: string): string | undefined;
	/** Full placeholder→secret copy (restoration tokens; mutating the copy does not affect the registry). */
	snapshot(): Map<string, string>;
	/** Current entry count. */
	readonly size: number;
	/** Clear (session end / tests). */
	clear(): void;
}

/** Span 掩码共享尾段：注册表幂等过滤（已是本注册表伪值的 span 跳过，防嵌
 *  套）→ redactText（注入注册表签发器：确定性伪值 + 碰撞兑底 + LRU 写入）。
 *  regex 管线阶段与 judge 层（命中/兑底 span）同形去重；返回应用后的文本
 *  与应用的 span 数（0 = 原样返回）。置于此处供掩码管线与 judge 层共用，
 *  避免两模块经掩码管线 barrel 形成环依赖。 */
export function redactSpansWithRegistry(
	text: string,
	spans: readonly Span[],
	registry: PlaceholderRegistry,
	templates: Map<string, string>,
): { text: string; applied: number } {
	const applicable = spans.filter((span) => !registry.has(text.slice(span.start, span.end)));
	if (applicable.length === 0) {
		return { text, applied: 0 };
	}
	return {
		text: redactText(text, applicable, templates, {
			issuePlaceholder: (secret, detector) => registry.issue(secret, templates.get(detector)!),
		}).text,
		applied: applicable.length,
	};
}

/** Create an in-process placeholder registry. */
export function createPlaceholderRegistry(
	options: PlaceholderRegistryOptions = {},
): PlaceholderRegistry {
	const limit = options.limit ?? DEFAULT_LIMIT;
	const hashLength = options.hashLength ?? DEFAULT_HASH_LENGTH;
	/** placeholder → secret (authoritative LRU entries; Map order = recency). */
	const entries = new Map<string, string>();
	/** secret → placeholder (first-issued form; kept in lockstep with `entries`). */
	const reverse = new Map<string, string>();

	/** Evict the oldest entries beyond the cap, cleaning their reverse mappings. */
	const evict = (): void => {
		while (entries.size > limit) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			const secret = entries.get(oldest);
			entries.delete(oldest);
			if (secret !== undefined && reverse.get(secret) === oldest) {
				reverse.delete(secret);
			}
		}
	};

	return {
		issue(secret, template) {
			const pinned = reverse.get(secret);
			if (pinned !== undefined) {
				// First-issuer-wins: the suggested template is only a hint; reuse
				// the pinned form (delete+set refreshes its LRU position).
				entries.delete(pinned);
				entries.set(pinned, secret);
				evict();
				return pinned;
			}
			let placeholder = makePlaceholder(secret, template, hashLength);
			while (entries.has(placeholder) && entries.get(placeholder) !== secret) {
				placeholder += "x";
			}
			// Every write (fresh issuance included) moves to the most recent
			// position (Map tail = most recently used).
			entries.delete(placeholder);
			entries.set(placeholder, secret);
			reverse.set(secret, placeholder);
			evict();
			return placeholder;
		},
		has(placeholder) {
			return entries.has(placeholder);
		},
		get(placeholder) {
			return entries.get(placeholder);
		},
		snapshot() {
			return new Map(entries);
		},
		get size() {
			return entries.size;
		},
		clear() {
			entries.clear();
			reverse.clear();
		},
	};
}
