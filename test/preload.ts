/**
 * Global bun test preload (ticket #18 Part 1): runs before any test module
 * loads and pins PI_KEEP_SECRET_CONFIG to a repo-local path that never
 * exists, so no test can read the user-level
 * ~/.pi/agent/extensions/pi-keep-secret/config.json by accident (the
 * extension entry falls back to that default path when the env var is unset,
 * which broke real-assembly tests on machines with the extension installed).
 *
 * An explicit value exported before the run (manual isolation, CI env
 * pinning) still wins — this preload only supplies the default.
 *
 * Wired in via bunfig.toml:
 *   [test]
 *   preload = ["./test/preload.ts"]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const isolatedConfigPath = join(import.meta.dir, "..", ".test-isolated-config.json");

if (process.env.PI_KEEP_SECRET_CONFIG === undefined) {
	if (existsSync(isolatedConfigPath)) {
		throw new Error(
			`Test isolation broken: ${isolatedConfigPath} must not exist — ` +
				"tests would read it as a real config. Delete the file.",
		);
	}
	process.env.PI_KEEP_SECRET_CONFIG = isolatedConfigPath;
}
