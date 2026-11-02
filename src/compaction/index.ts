/**
 * Masked compaction layer public exports (T6; judge coverage since ticket #12).
 *
 * - `createMaskedCompactionExtension`: registers `session_before_compact` /
 *   `session_before_tree` and replaces pi's built-in compaction/branch summary
 *   with a masked one (the stored result is restored to real values). Summary
 *   input runs the egress chain's composition — judge masker first (when
 *   provided via `options.judge`, the same instance the egress chain uses),
 *   then the regex pipeline; judge failures fail closed inside the masker and
 *   never cancel compaction. The summary call retries (SUMMARY_RETRIES times,
 *   short backoff); when retries are exhausted the compaction is cancelled
 *   with a warning and a counter (the session keeps running un-compacted,
 *   zero leaks; there is no fallback to pi's default compaction).
 * - `MaskedCompactionStatus`: cancellation counter and last reason, for the
 *   status command and tests to observe.
 */
export {
	createMaskedCompactionExtension,
	type MaskedCompactionOptions,
	type MaskedCompactionStatus,
} from "./extension.ts";
