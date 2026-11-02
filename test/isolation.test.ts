/**
 * Ticket #18 Part 1: bare `bun test` must never read the user-level config
 * (~/.pi/agent/extensions/pi-keep-secret/config.json). The extension entry
 * falls back to that default path when PI_KEEP_SECRET_CONFIG is unset, which
 * made real-assembly tests fail on machines with the extension installed
 * (loader reads the real judge section -> missing model in the fake registry
 * -> fail_closed masking -> assertions break).
 *
 * Isolation contract: the global preload (bunfig.toml [test].preload ->
 * ./test/preload.ts) pins PI_KEEP_SECRET_CONFIG to a repo-local path that
 * never exists before any test module loads. An explicit value exported
 * before the run (the manual isolation flow) still wins and also satisfies
 * this contract as long as it points at a nonexistent file.
 */
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("Test isolation (ticket #18 Part 1)", () => {
	test("bare bun test cannot read the user-level config: PI_KEEP_SECRET_CONFIG points at a nonexistent path", () => {
		const path = process.env.PI_KEEP_SECRET_CONFIG;
		expect(path).toBeDefined();
		expect(existsSync(path!)).toBe(false);
	});
});
