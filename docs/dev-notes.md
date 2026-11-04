# pi-keep-secret — Development Notes

Engineering log for pi-keep-secret: scaffolding decisions, test seams, fact
findings, and design rationale from the implementation tickets (T0–T20,
issues #2–#21). Everything here describes **how the extension is built and
why**; the user-facing documentation lives in the top-level
[README](../README.md) and the [threat model](threat-model.md). Nothing in
this file is needed to *use* the extension.

pi-keep-secret is a transparent egress secret-masking extension for pi
coding-agent sessions: credentials in outbound requests are replaced with
format-preserving deterministic placeholders, responses are restored on the
way back, and the local transcript and tool execution always see real
values. Original spec: GitHub issue jesset/pi-keep-secret#1.

## Contents

- [Scaffolding decisions (T0)](#scaffolding-decisions-t0-issue-2)
- [Test seam 1: in-process session + scripted faux provider harness](#test-seam-1-in-process-session--scripted-faux-provider-harness)
- [Egress masking extension (T2)](#egress-masking-extension-t2-issue-4)
- [Ingress restoration (T3)](#ingress-restoration-t3-issue-5)
- [Detector JSON config + clean cache (T4)](#detector-json-config--clean-cache-t4-issue-6)
- [Masked compaction (T6)](#masked-compaction-t6-issue-8)
- [Input preflight + /keep-secret commands (T7)](#input-preflight--keep-secret-commands-t7-issue-9)
- [System One judge (T5)](#system-one-judge-t5-issue-7)
- [T8: end-to-end hardening + packaging](#t8-end-to-end-hardening--packaging-issue-10)
- [T14: judge dual protocol](#t14-judge-dual-protocol-v1systemone--v1decisions-issue-14)
- [T16: judge.api wire preference](#t16-judgeapi-wire-preference-issue-16)
- [Behavioral notes (T20)](#behavioral-notes-t20-21)
- [Known limitations (0.1.0)](#known-limitations-010)
- [Conventions](#conventions)

## Scaffolding decisions (T0, issue #2)

- **Package manager / runtime: bun** (1.4.x). **Test framework: `bun test`.**
  Rationale: native TypeScript execution, no build pipeline, direct
  interoperability with the pi packages (TS ESM); this repo introduces no
  build pipeline.
- **devDependencies**:
  - `@earendil-works/pi-coding-agent@1.4.0` — the pi SDK
    (`createAgentSession`, `DefaultResourceLoader`, extension API types, …).
  - `@earendil-works/pi-ai@1.4.0`, `@earendil-works/pi-agent-core@1.4.0` —
    the harness references their types (`Message`, `JsonObject`, …) and faux
    provider utilities directly; declared as explicit dependencies to avoid
    transitive-dependency drift.
- **Commands**: `bun test` (tests), `bun run typecheck` (type checking,
  `tsc --noEmit -p tsconfig.json`, the same command CI runs). Versions match
  the globally installed pi 1.4.0.

## Test seam 1: in-process session + scripted faux provider harness

Code: `src/harness/fake-session.ts`; smoke test: `test/smoke.test.ts`.

```ts
import { createHarnessSession, requestText } from "./src/harness/fake-session.ts";

const h = await createHarnessSession({
  extensionFactories: [myMaskingExtension], // inline extension (for smoke tests)
  extensionPaths: ["./extension/index.ts"], // or extension file/directory paths
  customTools: [myRecordingTool],           // custom tools (built-in read/bash/edit/write disabled)
});
try {
  h.provider.setScript([
    { text: "reply text" },                                     // one model request consumes one entry
    { toolCall: { name: "my_tool", arguments: { k: "v" } } }, // a tool-call turn
  ]);
  await h.session.prompt("a prompt containing secrets");

  // Provider view: everything sent to the "provider" after the context hook
  for (const request of h.provider.requests()) {
    expect(requestText(request)).not.toContain(REAL_SECRET);
  }
  // Local transcript and tool execution see real values
  expect(h.session.getLastAssistantText()).toContain(REAL_SECRET);
} finally {
  h.dispose(); // closes the session and cleans up the temp directory
}
```

Harness features:

- The session runs in a temp directory (cwd/agentDir), in-memory settings,
  and an in-memory session store: no network, no disk persistence. The
  `settings` option injects initial in-memory settings (e.g. lowering
  `compaction.keepRecentTokens` to drive manual/threshold compaction cases).
- The `messages` recorded by the faux provider are exactly the "provider
  view": what remains after the `context_with_system` hook and
  `convertToLlm` (LLM-format messages).
- Scripted responses are consumed in request order; an `{ error }` variant
  returns a stopReason=error answer (failure-fallback cases); once the
  script is exhausted, further requests get an error message
  (`No more faux responses queued`), so under-scripted tests fail loudly.

### Main path and fallback decision

- **Main path (adopted, verified)**: SDK `createAgentSession` +
  `ModelRuntime.registerNativeProvider(faux.provider)`. pi-ai ships a
  [faux provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/faux.ts)
  for tests: its stream function is the injected fake streamFn, and outbound
  requests traverse the complete pi pipeline (extension hooks,
  convertToLlm, auth resolution) before being answered. Scripted responses
  are built with `fauxAssistantMessage`/`fauxToolCall` (text/thinking/
  toolCall blocks plus streaming events).
- **Rationale**: no need to replace the `Agent.streamFunction` field or
  bypass pi's internal pipeline; the injection point sits right next to the
  real provider path (ModelRuntime dispatch, request options, and cache
  warming all run real code). 5 smoke tests green, covering outbound
  assertions, message_end text restoration, toolCall argument restoration,
  cross-turn re-masking, and extension-file loading.
- **Fallback (not implemented)**: trigger condition was "SDK in-process
  injection turns out to be restricted". Never triggered. If it ever is:
  `pi -p --extension <dir>` subprocess + an in-extension
  `pi.registerProvider` pointing at a local fake HTTP provider (the pi
  package's `examples/extensions/custom-provider-gitlab-duo/` shows the
  full pattern); same assertion surface, slower.

### T0 fact findings (for later tickets)

- At the `context_with_system` hook, user content is already normalized to
  an array of text blocks (not a string); the real masking implementation
  must handle both shapes.
- `message_end` replacement messages take effect **before** transcript
  persistence and tool execution; tool results (echoing real values) enter
  the next outbound request, so egress masking must cover toolResult text.
- Assistant history (including restored toolCall arguments) is re-masked on
  every outbound turn, so the provider view always shows placeholders
  (deterministic placeholders).

## Egress masking extension (T2, issue #4)

Code: `src/masking/` (registry/walk/detectors/extension) + extension entry
`extension/index.ts`; acceptance cases: `test/egress-masking.test.ts`
(seam 1).

```ts
// Directory extension entry (built-in default detector set; pi --extension ./extension
// or user-level install). Equivalent parameterized factory (tests/customization):
import { createEgressMaskingExtension, createPlaceholderRegistry } from "./src/masking/index.ts";

const factory = createEgressMaskingExtension({
  detectors: [{ name: "openai-key", pattern: "sk-(?!ant-)[A-Za-z0-9_-]{20,}", template: "sk-{hash}" }],
  registryLimit: 5000, // default
  hashLength: 12,      // default
});
```

- Pipeline: `detectRegexSpans` (T1) → registry-level idempotent filtering (a
  hit whose text is already a placeholder is skipped, preventing nested
  masking) → `redactText` via the registry issuer (deterministic
  placeholders + collision "x"-suffix fallback + LRU write).
- Traversal (notes §2): user (string/text blocks), toolResult text blocks,
  assistant text/thinking/toolCall.arguments deep traversal, system prose
  and section string values, bashExecution command/output and custom
  message content (the latter two are projected by pi's convertToLlm into
  user text entering model context; a custom message's `details` never
  enters context and is left alone). Exemptions: ImageContent.data,
  *Signature, id/name/role/type, toolsAdded/toolsRemoved, nestedCalls,
  argumentsError, toolResult.details.
- Built-in default detectors: openai-key (`sk-`, excluding `sk-ant-`),
  github-pat (`ghp_`), aws-access-key-id (`AKIA`+16), google-api-key
  (`AIza`+35), slack-bot-token (`xoxb-`); PEM/JWT were added to the default
  set by T4 (see the T4 section).
- Placeholder registry (`createPlaceholderRegistry`, session-scoped closure
  state shared by T3/T5): `issue(secret, template)` is idempotent and
  **first-issuer-wins** (T20, #21) — the first template to issue a secret
  pins its placeholder form for the session, and later `template` arguments
  are only suggestions (one secret, one form); writes refresh LRU position,
  hash collisions fall back to an "x" suffix, and eviction cleans both the
  placeholder→secret and secret→placeholder indexes. `has`/`get` (idempotent
  filtering / restoration lookup), `snapshot()` (T3 restoration token copy),
  `size`/`clear`.

### T2 fact findings (for later tickets)

- A `before_agent_start`-returned forced `systemPrompt` is projected into
  the request head by pi's `_installAgentForcedPromptProjection` **after**
  the context hook, **bypassing `context_with_system` masking** — the
  extension itself forces no prompt and is unaffected; if some future
  extension writes secrets into a forced prompt, that is a leak path (a
  known out-of-spec limitation).
- AGENTS.md and other project instructions enter the system message's
  `sections.project_context`, are visible at `context_with_system`, and are
  covered by masking (anchored by acceptance cases).
- With the default hashLength=12 the placeholder `sk-`+12 chars does not
  match the `sk-` detector (`{20,}`), but with long configured hashes a
  placeholder can self-match — the idempotent filter exists for exactly
  this (case anchored).

## Ingress restoration (T3, issue #5)

Code: `src/ingress/` (restore/extension) + composition wiring in the
extension entry; acceptance cases: `test/ingress-restoration.test.ts`
(seam 1).

- `message_end` hook: placeholder→real-value deep traversal of assistant
  text/thinking/toolCall.arguments, returning the replacement message (same
  role); takes effect before transcript persistence and tool execution.
- `tool_call` hook: `event.input` restored in place (deep traversal of
  string values) as a second safety net for paths other than message_end;
  mutation checks confirmed hook sensitivity.
- Restoration tokens come from the `snapshot()` of the same registry
  instance the egress masker uses (merged view); truncated-prefix fallback
  (half a placeholder from max_tokens truncation) lives in the engine's
  `unmaskText`.
- Idempotent: with an empty registry or a placeholder-free message, nothing
  changes (no replacement message returned).

```ts
// Composition wiring (extension/index.ts): egress masking and ingress restoration
// share one registry instance
import { createIngressRestorationExtension } from "./src/ingress/index.ts";
import { createEgressMaskingExtension, createPlaceholderRegistry } from "./src/masking/index.ts";

const registry = createPlaceholderRegistry();
const compose = (pi: ExtensionAPI): void => {
	createEgressMaskingExtension({ registry })(pi);
	createIngressRestorationExtension({ registry })(pi);
};
```

### T3 fact findings (for later tickets)

- In-place rewriting at `message_end` is equivalent to returning a copy:
  pi's `_replaceMessageInPlace` returns directly when
  target===replacement, and the code comments explicitly bless in-place
  modification to keep agent state, event listeners, and SessionManager
  persistence in sync.
- Tool-execution arguments and the transcript's toolCall.arguments are the
  same object (`validateToolArguments` coerces in place): the tool_call
  hook's in-place restoration is reflected in both.
- Extension load order: `extensionPaths` register before
  `extensionFactories` (inline); handlers for the same event chain in that
  order (a message_end replacement message is passed on to later handlers).
- The faux provider trims leading whitespace from assistant text (test
  scripts avoid leading-whitespace as an unrelated variable).

## Detector JSON config + clean cache (T4, issue #6)

Code: `src/config/` (loader/extension) + `src/cache/` (clean-cache);
acceptance cases: `test/config-cache.test.ts` (seam 1),
`src/config/loader.test.ts`, `src/cache/clean-cache.test.ts`,
`src/masking/detectors.test.ts` (seam 2).

### Config schema and path resolution

The config file is a JSON object; unknown keys (including typos) always
error, preventing silent typo failures:

```json
{
  "detectors": [
    { "name": "corp-api-key", "pattern": "corp-[A-Za-z0-9]{20,}",
      "redactTemplate": "corp-{hash}" }
  ],
  "detectorsMode": "merge",
  "hashLength": 20,
  "cleanCache": { "limit": 20000, "ttlMs": 86400000 }
}
```

- `detectors`: detector list (`name`/`pattern`/`redactTemplate`; template
  defaults to `{hash}`; `{hash}` may appear multiple times to preserve
  shape, e.g. the JWT `"eyJ{hash}.{hash}.{hash}"`). Assembly semantics are
  decided by `detectorsMode` (below); an empty list is invalid (it would
  accidentally disable all local detection).
- `detectorsMode` (T13, #13): detector assembly strategy, `replace`
  (default) / `merge` — replace: `detectors` **wholly replaces** the
  built-in default set (current behavior); merge: built-in defaults + user
  `detectors` merged, **same-name user entries override the corresponding
  built-in in place** (fine-tune pattern/redactTemplate, e.g. tightening
  the sk- exclusion rule), non-matching entries appended after the built-ins
  (built-in order stays first); when `detectors` is absent both modes are
  equivalent to the pure built-in set. Invalid value → whole-config
  fallback to the built-in default set + visible error (the established
  all-or-nothing semantics). Mode and effective set are part of the config
  fingerprint: `/keep-secret reload` hot-applies (the status view shows the
  mode and effective detector count).
- `hashLength`: placeholder hash-segment length, integer 1..52
  (base32(sha256) length), default 12.
- `cleanCache`: `limit`/`ttlMs` tuning, defaults 20000 / 24h.
- Path resolution priority: explicit parameter > `PI_KEEP_SECRET_CONFIG`
  environment variable > default
  `~/.pi/agent/extensions/pi-keep-secret/config.json`.
- Missing file → built-in default set, no error; anything invalid (read
  failure / JSON parse / schema / regex compilation) → visible via
  `ResolvedConfig.errors` + **whole-config fallback** to the built-in
  default set (all-or-nothing). Config errors are visible in pi: from the
  first request, reported one by one via `ctx.ui.notify(..., "error")`
  (visible in TUI; without a UI — print/RPC — errors remain readable from
  `loader.get().errors`, shown by T7 status).

### Loading and hot-reload interfaces (load/reload/subscribe)

```ts
import { createConfigLoader, createConfiguredMaskingExtension } from "./src/config/index.ts";

// Pure loader: load (loads on creation) / reload (re-reads disk; notifies subscribers only on change)
const loader = createConfigLoader({ path?: string });
loader.get();          // ResolvedConfig { path, exists, detectors, detectorsMode, hashLength?, cleanCache?, errors }
loader.reload();       // re-reads and returns; notifies subscribers synchronously when the fingerprint changes
loader.subscribe(fn);  // subscribe to changes; returns an unsubscribe (no replay of the current value)

// Configured composition (how the formal entry extension/index.ts assembles; after
// merging T3/T6 it shares one pipeline with ingress restoration and masked
// compaction: const { factory, loader, pipeline } = createConfiguredMaskingExtension(...)
const { factory, loader, pipeline } = createConfiguredMaskingExtension({ configPath?, cleanCache?, registry? });
```

- Hot-reload semantics: after `reload()`, detector-set changes **apply
  immediately** (recompile + clear the clean cache — after the detector set
  changes, old clean verdicts are no longer trustworthy; acceptance cases
  anchor this anti-leak property); `hashLength`/`cleanCache` changes take
  effect only in new sessions (the placeholder registry and cache
  parameters are frozen at factory creation). T7's `/keep-secret reload`
  calls `loader.reload()` directly.
- The `detectors` resolved from config are the engine's
  `RegexDetectorSpec[]` (`redactTemplate` maps to `template`) and can be
  fed straight into `createEgressMaskingExtension`.

### Clean cache

- `createCleanCache({ limit=20000, ttlMs=24h, now })`: sha256(text) →
  expiry timestamp; writes refresh the LRU position, hits do not extend
  (write-refreshes-recency, not read-refreshes); `isClean`/
  `remember({ hasSecret })`/`stats()`/`clear()`.
- Attached at the masking pipeline's detection entry
  (`createMaskingPipeline`'s maskText, shared by the egress hook and masked
  compaction): detection runs only on an `isClean` miss, and clean verdicts
  enter the cache — a second request with the same history does not
  re-detect (per-round cost O(new messages)); texts containing secrets are
  never cached and re-scanned every round; `stats().misses` is the actual
  detection count (the "detection counting" assertion basis; `hits` is the
  cache short-circuit count). The hot-apply entry is
  `pipeline.applyDetectors(specs)` (recompile + clear the cache).
- `ScanOutcome.hasSecret` is a reserved semantic bit: T5 judge gate hits
  also set it true (not cached, re-scanned every round).

### Built-in default detector set (T4 completion)

- Added `pem-private-key` (multi-line
  `-----BEGIN [A-Z]+ )?PRIVATE KEY-----` blocks, covering RSA/EC/DSA/
  OPENSSH/ENCRYPTED variants; the placeholder remains a legal-shaped PEM
  block) and `jwt` (`eyJ` three base64url segments, each ≥10 chars; a
  two-segment truncation does not match; placeholder
  `eyJ{hash}.{hash}.{hash}` keeps the three-segment JWT shape).
- The engine's `makePlaceholder` now uses `replaceAll("{hash}")`: every
  `{hash}` in a template is replaced with the same hash segment
  (single-segment template behavior unchanged).

### T4 fact findings (for later tickets)

- System message text leaves are byte-stable across turns within a session
  (measured and anchored) — which is why the clean-cache detection-count
  assertions can be exact to "round two detects only new text" (all system
  + historical user leaves hit the cache).
- The formal entry's default export changed from an evaluated
  `createEgressMaskingExtension()` call to passing the function itself:
  environment variables are read at each extension assembly (module caching
  does not prevent pointing different sessions at different config files).
- `test/egress-masking.test.ts` pins `PI_KEEP_SECRET_CONFIG` to a path that
  deterministically does not exist, so default-set cases are immune to a
  real `~/.pi` config on the machine (tests never touch the real `~/.pi`
  path).
- `ctx.ui.notify` is a no-op in UI-less modes (print/RPC): in those
  environments config errors are visible only via `loader.get().errors`;
  T7 status is responsible for showing them.

## Masked compaction (T6, issue #8)

Code: `src/compaction/` (extension/prompts); acceptance cases:
`test/compaction.test.ts`, `test/compaction-judge.test.ts` (seam 1).

- `session_before_compact` returns a full `CompactionResult`, replacing
  pi's built-in compaction entirely (manual `/compact`, threshold and
  overflow all go through this hook): the preparation's messagesToSummarize
  + turnPrefixMessages → `convertToLlm` (including branchSummary/
  compactionSummary projections) → mask the text leaves with the egress
  chain's composition — judge masker first (when configured, ticket #12),
  then the regex pipeline → `serializeConversation` into the summary prompt
  → summarize via `ctx.modelRegistry.complete` (the session's current
  model) → restore the summary text via the registry →
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage } }`.
- Summary input is double-covered (ticket #12, closing the last leak
  surface where judge-only secrets rode the summary prompt): conversation
  messages, previousSummary and customInstructions all run the judge masker
  — the same instance the egress chain uses, so the registry/clean
  cache/tombstones are shared and placeholder forms stay unified
  (first-issuer-wins) — and then the regex pipeline. Judge classify
  failures fail closed (unverified candidates masked) and **compaction
  continues**; the retry/cancel path is reserved for the summarization call
  itself. A missing classifier model follows the egress `onMissing` policy:
  the default fail_closed masks unverified candidates before summarizing;
  explicit `regex_only` degrades the summary input to the regex layer only
  (in that mode, low-entropy, regex-invisible secrets still reach the
  summary request — see known limitation 2). Without a judge config section
  the summary input stays regex-only, unchanged.
- The summary prompt mirrors pi's default (pi 1.4.0 does not export the
  prompt constants; copied verbatim into `src/compaction/prompts.ts`, must
  be re-checked on upgrades); previousSummary / customInstructions are
  masked before entering the summary context; the result is restored.
- `session_before_tree` returns `{ summary: { summary: restored text,
  usage } }` the same way (entriesToSummarize via the `prepareBranchEntries`
  projection).
- Failure policy (spec story 24: zero leaks): the summary call retries (2
  retries, short backoff; user aborts are not retried and don't count as
  failures); retries exhausted → return `{ cancel: true }` cancelling this
  compaction (the session continues un-compacted) + `ctx.ui.notify` warning
  with a retry hint + status bar marker + `MaskedCompactionStatus` counter
  (UI-less mode counts only). **There is no "fall back to pi's default
  compaction" path** — the default compaction does not mask; falling back
  would leak.
- Egress safety net: the summary field of compaction/branch-summary
  messages (`compactionSummary`/`branchSummary` custom AgentMessages,
  carrying restored real values) is masked by the traversal walker
  (covered by egress since T6).

```ts
// Composition wiring (extension/index.ts): egress masking, ingress restoration
// and masked compaction share one pipeline; the judge masker (when the judge
// config section exists) is the same instance the egress chain uses (ticket #12).
import { createMaskedCompactionExtension } from "./src/compaction/index.ts";
import { createIngressRestorationExtension } from "./src/ingress/index.ts";
import { createEgressMaskingExtension, createMaskingPipeline } from "./src/masking/index.ts";

const pipeline = createMaskingPipeline();
const judge: JudgeTextMasker | undefined = undefined; // created by the config layer when judge is configured
const compose = (pi: ExtensionAPI): void => {
	createEgressMaskingExtension({ pipeline })(pi);
	createIngressRestorationExtension({ registry: pipeline.registry })(pi);
	createMaskedCompactionExtension({ pipeline, judge })(pi);
};
```

### T6 fact findings (for later tickets)

- The extension-side `ctx.modelRegistry` is a synchronous compatibility
  facade (`ModelRegistry`): it has `complete`/`streamSimple`, **not**
  `completeSimple` (that is a `ModelRuntime` method); the masked summary
  goes through `ctx.modelRegistry.complete` (auth resolved at request
  time).
- pi's default compaction retries (`retryAssistantCall`); the masked
  compaction's summary call retries the same way (2 retries, short
  backoff), absorbing transient failures; exhausted retries cancel this
  compaction (session continues un-compacted) and never fall back to the
  unmasked default compaction.
- After compaction, history before `firstKeptEntryId` is replaced by the
  compaction entry; the projection produces a `compactionSummary`-role
  message (the `summary` field carries real values), which `convertToLlm`
  expands into user text — if the traversal walker did not cover that role,
  every post-compaction outbound turn would leak real values (fixed in T6,
  anchored by cases).
- `SettingsManager.inMemory(partial)` can inject
  `compaction.keepRecentTokens`/`reserveTokens`; the harness uses this to
  drive manual/threshold compaction; keepRecentTokens must be smaller than
  the session-tail token count, otherwise `prepareCompaction` returns
  undefined ("Nothing to compact").
- `bashExecution`/`custom` custom messages (`!command` bangs, sendMessage
  injections) are projected by pi's `convertToLlm` into user text entering
  LLM context (`bashExecutionToText` includes command+output; a custom
  message's content projects directly) — covered by the egress walker
  (closed in T2, anchored; `!!`-prefixed excludeFromContext messages do not
  project, masking has no effect on them).

## Input preflight + /keep-secret commands (T7, issue #9)

Code: `src/commands/` (extension); acceptance cases: `test/commands.test.ts`
(seam 1 + direct command-handler tests).

### Input preflight

- `pi.on("input")` quick-scans submitted text with the **built-in default
  regex set** (a fixed advisory layer independent of config; masking
  enforcement always uses the currently configured detector set); a hit
  triggers `ctx.ui.notify(..., "warning")` listing the detector names;
  returns `undefined` (no rewriting, no blocking). Without a UI
  (print/json) notify is a no-op, silently.

### The /keep-secret command surface (three subcommands)

- `/keep-secret` (status): detector config summary (source / mode
  (replace|merge, T13) / count / name list, including an error line and
  fallback marker for an invalid config), placeholder registry entry count,
  clean cache entry count and hit ratio (hits x / detections y),
  per-detector hit counts (`name=N`), judge counters (wired in T8: with a
  judge config section, judged/truncated/fail-closed/degraded counters and
  the effective missing-model policy; "not wired" when unconfigured; since
  T16 a wire segment appended after model resolution: follows registration
  / overridden systemone|decisions / plugin custom name (judge.api
  preference ineffective marker)), masked-compaction cancellation count and
  the latest reason.
- `/keep-secret test`: synthetic samples (a fake sk- key, a key hidden in a
  URL, a fake password, a clean order number) each pass through the session
  chain (since T8, with the judge enabled they go through the judge→regex
  full chain in the same order as the egress chain), reporting masked/not
  masked versus expectation; matching expectation is a pass — all passed is
  info, any failure is a warning. The fake-password expectation is dynamic
  with the judge: enabled → expect masked (an honest failure under
  regex_only degradation — a visible degradation signal); disabled → expect
  not masked (the regex layer not matching is expected). If the current
  config does not cover a sample, that sample honestly fails. With a
  missing model + fail_closed (default) active, all samples are expected
  masked (unverified candidates are always masked as a safety net,
  including the clean order number) plus an explanatory line.
- `/keep-secret reload`: calls `loader.reload()` (on change, synchronously
  hot-applies: applyDetectors + clears the cache); change detection uses
  the same basis as the loader (`configFingerprint`), the result is
  reported via notify (detector set changed → hot-applied / detector set
  unchanged but other sections changed (judge/hashLength/cleanCache) →
  re-read, effective only in new sessions / no change / config error
  fallback).
- Unknown subcommand → usage hint.

### Safe degradation across the three modes

All output goes through `ctx.ui.notify` (directly visible in TUI; forwarded
via extension_ui_request in RPC, fire-and-forget, non-blocking; a no-op in
print/json — silent, the command action still executes), with no
interactive primitives (select/confirm/custom). Command handlers depend
only on the `(args, ctx)` signature and can be tested directly.

### Data sources and minimal increments

- The status view uniformly uses the modules' existing interfaces:
  `loader.get()` (config summary), `pipeline.registry.size`,
  `MaskedCompactionStatus` (held by the composition root
  `extension/index.ts` and passed to the compaction extension and command
  surface).
- Minimal pipeline increments: `pipeline.detectorHitCounts()` (merged spans
  accumulated per detector name; cache short-circuits not counted; zeroed
  by applyDetectors) and `pipeline.cacheStats()` (misses = actual detection
  count). Detector hit counts accumulate **before** the registry's
  idempotent filtering (including secret-bearing texts re-scanned every
  round, increasing with session events).

### T7 fact findings (for later tickets)

- pi's `prompt()` tries extension command dispatch first for `/`-prefixed
  text (`_tryExecuteExtensionCommand`) and returns on a hit — the input
  hook never sees `/keep-secret` itself; seam-1 verification of command
  registration requires a pre-set faux provider script (an unrecognized
  command is sent to the model as a prompt and recorded; requests().length
  is the signal; **without a script the faux provider errors before
  recording, so zero requests proves nothing about command execution**).
- The harness (SDK session) `ctx.ui` is `noOpUIContext` (mode "print"):
  notify is not observable; command-surface assertions use a stub pi to
  extract the registered handler + inject a recording ctx.ui and call it
  directly (the same call surface as pi; the "direct command handler test"
  accepted by the ticket).
- The T5 integration point (landed in T8):
  `createKeepSecretCommandsExtension({ judge })` receives the composition
  root's `JudgeTextMasker` (same instance/state) to light up the status
  view's judge line; the self-test fake-password expectation becomes
  "masked" with the judge enabled.

## System One judge (T5, issue #7)

- Adapter `createSystemOneJudge` (`src/judge/system-one.ts`): an injected
  classify channel (`ClassifyFn`) — the extension layer binds
  `ctx.modelRegistry.classify`, pure-logic tests inject an in-process fake
  function. Two phases: a gate single boolean question (threshold 0.5)
  short-circuits low risk → per-candidate boolean questions in batches
  (threshold 0.7); 128 questions/batch split across batches covering all
  candidates, truncating to keep the longest only beyond 8 batches —
  dropped candidates are masked as unverified (unverified must not egress
  by definition) + `truncatedCandidates` counter; long texts chunked at
  24000/block with overlap min(2000, maxChars/4); all classify calls go
  through a session-scoped shared FIFO semaphore (default 8 lanes,
  message-level concurrency safety).
- fail_closed: `classify` never rejects; errors surface in `stopReason`.
  Gate failure → all candidates of that block masked and no candidate
  batches that are doomed to fail; a candidate-batch failure → that batch
  fully masked, other batches' verdicts adopted as usual; candidates
  without an answer in a stop result count as unverified and are masked
  (≠ discarding as "judged non-credential"). Real values are retained by
  the shared registry and remain locally recoverable.
- Egress extension `createJudgeEgressExtension` (`src/judge/extension.ts`):
  registers `context_with_system` and must register **before** the regex
  egress extension (judging needs the original text; the regex layer
  idempotently skips already-issued placeholders). Hit spans are masked
  through the same registry as every other path: `redactTemplate`
  (default `key-{hash}`) shapes the placeholder only when this judge is
  the first issuer for that secret — a regex detector that issued the same
  secret earlier keeps its form, and vice versa (first-issuer-wins, T20
  #21; see Behavioral notes).
- Classifier model resolution: the config references `{provider, modelId}`
  (driven by config.json's judge section since T8 for the formal wiring) →
  `ctx.modelRegistry.findOfType("classifier", ...)`. A missing model
  (including resolution-channel exceptions) → handled per `judge.onMissing`
  policy (spec story 19 "down judge never means an unmasked request"):
  **fail_closed (default)** — same path as classify failures: unverified
  candidates of the message (engine extraction) all masked (the real-value
  registry stays local) + failClosed counter + notify/status bar;
  **regex_only (explicit informed choice)** — degraded passage through the
  regex layer only + `degradedTexts` counted per text leaf (UI-less mode
  counts only). Degraded leaves under both policies record a clean-cache
  **tombstone** (T8: prevents a judge that recovers later from being
  short-circuited by the cache and missing hits; see the T8 section).
- Cooperation with the T4 clean cache (implemented): the judge layer
  consults `pipeline.cleanCache.isClean` before the gate (already-judged
  clean texts never trigger a gate); non-clean verdicts (hit / gate hit /
  fail_closed) are recorded as **tombstones** with `hasSecret=true` — a
  later clean verdict for the same text (a following regex layer with zero
  hits) must not overwrite it; re-judged every round. Clean entries are
  still written by the regex layer's zero-hit pass (clean = both layers
  passed); tombstones are invalidated by `clear()` (detector-set hot
  update).

### The fake-classifier plan (three verification layers)

1. **Adapter pure double** (`src/judge/system-one.test.ts`): an in-process
   fake classify answers by question id; the probability script anchors the
   calibration numbers measured against a real gateway (password 0.96 /
   order number 0.04 / gate 0.98) while recording all calls to anchor the
   two-phase shape.
2. **Harness injection point** (`test/judge-egress.test.ts`, seam 1): the
   extension factory's `resolveModel`/`classify` options take in-process
   doubles, driving the full hook chain (judge → regex chaining,
   degradation, fail_closed end to end); the missing-model case goes
   through the default `findOfType` path (the harness registry has no such
   model).
3. **Real-gateway verification** (`research/systemone-gateway.test.ts`):
   skipped by default; enabled only when all three environment variables
   are present (`PI_KEEP_SECRET_JUDGE_BASE_URL`/`_MODEL`/`_API_KEY`;
   credentials via environment variables only, never committed; an optional
   fourth variable `PI_KEEP_SECRET_JUDGE_API=decisions` switches to the
   OpenAI Decisions wire, defaulting to systemone — T14); posts wire-level
   questions directly (noul / predicate) asserting calibrated anchor
   ranges.

## T8: end-to-end hardening + packaging (issue #10)

Code: `extension/index.ts` (`createKeepSecretExtension` composition + the
default export), `src/config/loader.ts` (judge section),
`src/config/extension.ts` (judge wiring), `src/judge/masker.ts`
(`createJudgeTextMasker`; T8-era path `src/judge/extension.ts`), `src/commands/extension.ts` (judge counters and
dynamic self-test expectations); acceptance cases:
`test/e2e-convergence.test.ts` (seam 1), `test/helpers.ts` (shared fake
classifier double).

### Formal composition wiring (judge integration)

> **ADR-0001 update**: the composition described below is the T8-era shape
> and has since been deepened — `createMaskingPipeline` now owns the egress
> composition and the Clean Verdict protocol (single egress extension,
> single traversal, judge layer internal to the pipeline; the "judge before
> regex" registration-order contract is gone). Kept for history.

- **Assembly**: `createConfiguredMaskingExtension` reads config.json's
  `judge` section (provider/modelId/thresholds/onMissing) to create a
  `JudgeTextMasker`; the egress factory registers in "judge before regex"
  order (judging needs the original text; the regex layer idempotently
  skips issued placeholders — the two layers chain safely);
  `extension/index.ts`'s `createKeepSecretExtension` hands the same masker
  instance to the `/keep-secret` command surface (status counters and the
  self-test share it) and shares one pipeline with ingress restoration and
  masked compaction (same registry + clean cache).
- **Degradation paths**: no judge section → the judge extension is not
  assembled at all (regex layer only, status shows "not wired"); configured
  but the classifier model is missing / the resolution channel throws →
  per `judge.onMissing` policy (spec story 19): default **fail_closed** —
  unverified candidates of the message (engine extraction) all masked (the
  real-value registry stays local) + failClosed counter + notify/status
  bar + the self-test expects all samples masked; explicit **regex_only** —
  degraded passage through the regex layer only + degradedTexts counted per
  text leaf + the self-test fake-password sample honestly fails. Degraded
  leaves under both policies record a clean-cache **tombstone** — the regex
  layer's zero-hit verdict must not mark a degraded-processed text clean,
  otherwise the judge (model registered later) would be short-circuited by
  the clean cache after recovery and miss hits (the clean = both-layers-
  passed invariant; the "re-judge after recovery" case anchors this).
- **Classify channel failures share the rule with missing models**: model
  present but classify errors (judge unreachable) → fail_closed
  (unverified candidates all masked, real values locally recoverable);
  both counted in `/keep-secret` status (failClosed / degradedTexts) and
  the effective policy display (missing-model policy:
  fail_closed|regex_only).
- **Injection points**:
  `createKeepSecretExtension({ configPath, resolveModel, classify })` —
  test doubles enter the formal assembly through the judge extension's
  existing injection points; the default export (directory extension
  loading) reads `PI_KEEP_SECRET_CONFIG`.
- **Packaging**: `package.json` gains the `"pi": { "extensions":
  ["extension/index.ts"] }` manifest — pi reads a directory extension's
  package.json pi manifest first, then index.ts; `--extension <repo>` and
  user-level directory discovery share that entry; `extension/index.ts`'s
  `../src/...` relative imports keep working in the installed layout (the
  manifest's directory is the root).

### End-to-end convergence cases (seam 1, formal composition entry)

`test/e2e-convergence.test.ts`: ① multi-turn mask-restore-re-mask
determinism (provider view always the same placeholder, local always real
values, assistant echo restored then re-masked); ② judge-failure fail_closed
full chain (formal entry shape: password and order number masked together,
zero unverified egress, re-judged every round, status-view fail-closed
counter); ③ conversation continues after compaction with consistent
placeholders (masked summary → restored persistence → retained region/
summary projection re-masked to the same placeholder); ④ image content
byte-identical (tool-result images byte-identical outbound, text in the
same message masked as usual); ⑤ composition four states (judge available /
threshold short-circuit / unconfigured / degraded).

### Cold-start smoke (real pi 1.4.0 binary, recorded in this ticket)

- `pi -p --extension <repo> "<harmless prompt>"` → model answers normally,
  no extension errors;
- `/keep-secret`, `/keep-secret test`, `/keep-secret reload` → all
  dispatched and executed (print mode: zero output, zero model requests,
  exit 0; contrast: a deliberately throwing extension prints `Error:
  Failed to load extension …` with an `-ne` hint).
- config.json with a judge section + unavailable model → degradation path
  loads without error, session normal;
- invalid config → fallback default set loads without error, session
  normal;
- user-level install layout (`PI_CODING_AGENT_DIR` temp agent dir +
  `extensions/pi-keep-secret/{package.json, extension/, src/}`) →
  auto-discovered and loaded (command dispatch proves it); "No API key
  found" counts as an unavailable model, not an extension load failure
  (per the ticket).
- Real-model smoke (optional acceptance item, executed):
  `pi -p --extension <repo> --extension <egress probe>` (the probe
  registers last and sees the masked, pre-provider messages) submitting a
  fake-key prompt → outbound shows only the placeholder `sk-<hash>`, zero
  real-value egress, model answers normally.

## T14: judge dual protocol (/v1/systemone and /v1/decisions, issue #14)

A LiteLLM gateway's `/v1/systemone` and `/v1/decisions` are two wire
protocols for the same backend route: the former corresponds to the pi-ai
`typesafe-system-one` transport (POST `<baseUrl>/systemone`, boolean
questions mapped to wire-level noul), the latter to `openai-decisions`
(POST `<baseUrl>/decisions`, `{model,input,questions}`, bool→predicate,
criteria folded into instructions, state as JSON text in input). Both
protocols' baseUrl is configured as `https://<host>/v1` (the wire path is
appended by the transport).

- **Adapter unchanged**: the judge adapter goes through
  `modelRegistry.classify()`; the transport protocol is decided by the
  model registration entry's `api` field — config.json's `judge.api` key is
  a wire preference (T16 semantics) and does not change request-path
  validity.
- **Division of labor**: the loader (`src/config/loader.ts`) validates
  `judge.api`'s legal values (`systemone`|`decisions`; invalid → the whole
  judge section falls back); the assembly site (`src/judge/extension.ts`)
  applies the preference after model resolution. T14's original semantics
  were "inconsistent with the registered model api → config error, don't
  assemble"; **T16 changed this to the three-branch wire preference** (see
  the next section) — a hard check would wrongly kill plugin-registered
  custom-api models (`modelRegistry.classify` itself dispatches correctly
  by model.api; a name check only adds false kills).
- **Gateway verification script** (`research/systemone-gateway.test.ts`):
  skipped by default; enabled when the three variables are present; the
  optional `PI_KEEP_SECRET_JUDGE_API=decisions` switches to the OpenAI
  wire (default systemone) running the same calibrated-range assertions
  (decisions-protocol probabilities may differ slightly from systemone;
  assertions use ranges).

### Dual-protocol models.json registration sample

Two classifier entries on the same LiteLLM gateway (either as needed;
`judge.provider`/`modelId` points at one):

```json
{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "litellm": {
      "baseUrl": "https://gateway.example.com/v1",
      "apiKey": "$LITELLM_API_KEY",
      "models": [
        {
          "type": "classifier",
          "id": "typesafe/jev-latest",
          "name": "Jev (System One)",
          "api": "typesafe-system-one",
          "input": ["text"],
          "contextWindow": 128000
        },
        {
          "type": "classifier",
          "id": "openai/gpt-6-luna",
          "name": "GPT-6 Luna (Decisions)",
          "api": "openai-decisions",
          "input": ["text"],
          "contextWindow": 128000
        }
      ]
    }
  }
}
```

### Dual-protocol config.json sample

`api` is a wire preference (absent `api` follows the registered entry;
plugin custom-api models assemble normally with the preference visibly
ineffective):

```json
{
  "judge": {
    "provider": "litellm",
    "modelId": "openai/gpt-6-luna",
    "api": "decisions",
    "gateThreshold": 0.5,
    "candidateThreshold": 0.7
  }
}
```

Code: `src/config/loader.ts` (judge.api legal values),
`src/judge/extension.ts` (MODEL_API_BY_JUDGE_API preference mapping),
`src/config/extension.ts` (pass-through),
`research/systemone-gateway.test.ts` (dual-wire gateway runs); acceptance
cases: `src/config/loader.test.ts`, `test/judge-egress.test.ts`,
`test/e2e-convergence.test.ts` (T16 describe).

## T16: judge.api wire preference (issue #16)

T14's name hard-check wrongly killed plugin-registered classifier models:
the user's provider came from the pi-provider-litellm-oidc plugin, the
model's api being the custom name `litellm-decisions` (an implementation of
the System One wire calling `/systemone`), and the mapping table only
recognized pi-ai built-in names → a false inconsistency report → judge
assembly refused. `modelRegistry.classify()` itself dispatches correctly
by model.api (built-in api → pi-ai transports; custom api → the plugin's
ProviderClassifier) — the extension need not know wire details; LiteLLM
translates both `/v1/systemone` and `/v1/decisions` in both directions, so
the wire choice does not affect availability.

- **Three-branch assembly** (the "inconsistent → don't assemble" hard check
  fully removed):
  1. `judge.api` unset → follow the model registration entry's api (the
     previous default);
  2. set + the model's api is a pi-ai-known classifier api
     (`typesafe-system-one`/`openai-decisions`) → dispatch override: the
     classify call passes `{...model, api: MODEL_API_BY_JUDGE_API[options.api]}`
     (a shallow copy changing only the api field; baseUrl/provider/headers
     unchanged, auth resolved per provider unaffected) — the configured
     wire choice takes effect;
  3. set + the model's api is a plugin-custom name (e.g.
     `litellm-decisions`) → respect the plugin implementation (the plugin
     author already chose the wire), assemble normally; the preference is
     recorded as ineffective + a one-time info notify (not an error, not a
     degradation: no scoring penalty, no status bar) + a status-view
     marker.
- **Status view** (`/keep-secret`): the judge line appends a wire segment
  after model resolution — follows registration (<registered api>) /
  overridden systemone|decisions (<effective api>) / plugin custom <api>
  (judge.api preference <value> ineffective); not shown before resolution.
- **Runtime classify-exception semantics unchanged**: fail_closed + visible
  counters (stronger than a warn, spec story 19).
- The loader's legal-value check stays (`systemone`|`decisions`; invalid
  still falls the whole judge section back) — the key's semantics became a
  wire preference.

Code: `src/judge/extension.ts` (three-branch assembly and `JudgeWire`),
`src/commands/extension.ts` (wire display), `src/config/loader.ts`
(comment semantics); acceptance cases: `test/judge-egress.test.ts` (T16
three branches), `test/commands.test.ts` (wire display),
`test/e2e-convergence.test.ts` (T16 user-scenario).

## Behavioral notes (T20, #21)

Findings from live behavioral testing (7 outbound requests, zero plaintext
leaks), documented so the reasoning and the accepted trade-offs stay
visible. (The user-facing version of these notes lives in the README's
"How it behaves".)

1. **Placeholder form unification.** One secret always leaves the session
   in exactly one placeholder form. The registry keeps a secret→placeholder
   reverse index and reuses the first-issued form wherever the same secret
   reappears, so a judge-hit leaf and a regex-hit leaf of the same request
   can no longer produce `key-<hash>` and `sk-<hash>` side by side
   (observed pre-T20: the model compared both forms in one request and
   reconciled them by its own reasoning — a "same key seen as two values"
   split-brain risk). The first issuer pins the form for the session; a
   fail-closed turn can therefore pin the judge template for a secret a
   regex detector would have shaped differently; after an LRU eviction,
   re-issuance deterministically follows the current suggestion. **This is
   a deliberate divergence from the pre-T20 behavior baseline** — where the
   same secret could take a different shape per detector — accepted because
   unification trades detector-template fidelity for model-side coherence.
   Known costs, accepted by the user: reduced detector template fidelity
   (executing tools always receive the restored real value anyway) and the
   first-issuer form freeze.
2. **Model awareness.** The model may notice the masking layer and comment
   on it; this carries no leak risk — the provider only ever sees
   placeholders. Awareness triggers observed in testing: placeholder
   salience; cross-leaf form inconsistency (eliminated by item 1); other
   security layers in the ecosystem intercepting messages (e.g. pi-verdict
   — outside this project's scope).
3. **Restoration illusion.** The model only ever sees placeholders. When
   the terminal shows the assistant "quoting the real key", that text is
   the ingress restoration layer's product — transparency by design: the
   local transcript and tool execution always hold real values.
4. **Ecosystem layering.** Tool-approval style extensions operate on the
   restored (real-value) layer, which is the correct complementary
   position. Configuration guidance: if model attention to placeholders
   matters in your environment, configure `judge.redactTemplate` (and
   detector `redactTemplate`s) close to the real key shapes of your
   environment.

## Known limitations (0.1.0)

Findings and accepted trade-offs from the implementation tickets,
collected in one place (the user-facing version lives in the README's
"Threat model & limitations"):

1. **Placeholders briefly visible during streaming**: `message_update` is
   purely a notification (not rewritable); during TUI streaming the
   assistant output briefly shows placeholders, turning into real values
   when the message completes (`message_end` restoration) (spec #1 user
   story 18 accepted; T3).
2. **Secrets invisible to the regex layer still egress while
   `judge.onMissing=regex_only` is degraded**: when the classifier model is
   missing/unresolvable, the default is fail_closed (unverified candidates
   always masked, zero leaks); only the explicit `onMissing: "regex_only"`
   degrades to the regex layer alone (visible: one-time notify + status
   bar + `/keep-secret` degraded counter + the self-test password item
   failing). In that mode low-entropy, regex-invisible secrets egress —
   and since ticket #12 the same policy governs the compaction summary
   input, so those secrets also reach the summarization model (the same
   informed trade-off; T5/T8/#12).
3. **The judge provider must be trusted**: judging sends message text to
   the judge model (a System One endpoint); that provider must sit inside
   the same trust boundary as the main session provider (spec #1; T5).
4. **The local transcript keeps real values**: session files retain real
   values by design (local-disk protection is a separate concern, out of
   spec); only outbound requests are always placeholders (since T2,
   anchored by each ticket).
5. **`before_agent_start` forced systemPrompt bypasses masking**: pi
   projects a forced systemPrompt after the context hook, not through
   `context_with_system` masking; this extension itself forces no prompt
   and is unaffected, but another extension writing secrets into a forced
   prompt is a leak path (found in T2, out of spec).
6. **Input preflight uses the fixed built-in default set**: the
   non-blocking warning for submitted prompts quick-scans with the
   built-in default regex set (a fixed advisory layer independent of
   config; masking enforcement always uses the current config) (T7).
7. **Masked compaction skips compaction on failure**: the summary call
   retries (2 retries, short backoff); retries exhausted → this compaction
   is cancelled with a warning (the session continues un-compacted, the
   context keeps growing, the user can retry `/compact` later). This is
   the zero-leak trade-off — there is no fallback to pi's default
   compaction (the default path does not mask; falling back would leak)
   (T6, spec story 24).
8. **Judge truncation guardrail**: candidates beyond
   `batchSize × maxBatches` are truncated keeping the longest; dropped
   candidates are masked as unverified (zero unverified egress; the
   truncation counter feeds `/keep-secret` status) — the cost is
   conservative masking under pathological large blocks (short low-entropy
   strings may be masked alongside) (T5, story 19).

## Conventions

- Conventional Commits; branches `ticket/<n>-<slug>` (each ticket in its
  own worktree). Merging to main requires explicit user approval.
- Issue tracking happens on GitHub; see
  [docs/agents/issue-tracker.md](agents/issue-tracker.md).
