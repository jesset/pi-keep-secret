# Threat Model

How pi-keep-secret reasons about secrets in pi coding-agent sessions: what
is worth protecting, from whom, what the extension covers, and — as
importantly — what it deliberately does not.

The user-facing summary lives in the
[README](../README.md#threat-model--limitations); this document is the full
framework.

## Assets

- **Credentials that appear inside a session.** API keys pasted into a
  prompt (deliberately or accidentally), tokens and passwords read out of
  files by tools and echoed into tool results, secrets embedded in logs or
  config fragments the agent inspects, private key material and JWTs the
  session happens to process.
- **The session context itself.** Once a secret enters the conversation
  history, every subsequent model request would re-ship it — including
  re-projections such as compaction summaries and branch summaries — unless
  something rewrites it on the way out. That "every subsequent request"
  property is why per-request, in-process masking (rather than a one-time
  scrub) is the design center.

## Adversaries

- **Primary: the model provider and its logging surfaces.** Anyone who can
  read what the provider receives or records: request logs, abuse-review
  queues, analytics pipelines, third-party subprocessors, or a compromised
  provider account. The extension's contract with this adversary is simple:
  everything that arrives contains placeholders only.
- **Secondary: exfiltration of session artifacts.** A party that obtains
  session transcripts or exports. **This adversary is explicitly out of
  scope**: transcripts keep real values by design (below).

## Covered

Every outbound model request leaving the pi process:

- **The main chain** — every turn of the conversation, re-masked every
  round (assistant history containing restored real values is masked again
  on the way out).
- **Cache warming.** Provider-side context cache population goes through
  the same egress hook; warmed content carries placeholders only.
- **Compaction summaries.** pi's built-in compaction is replaced entirely
  by a masked variant: the summarization request's input — conversation
  messages, the previous summary, custom instructions — is masked
  (judge-first, then regex) before it is serialized into the summary
  prompt; the stored summary is restored to real values locally.
- **Branch summaries.** The same masking chain covers branch-summary
  inputs and outputs.

Detection layers and their failure semantics:

- **Two chained layers.** An optional System One judge (classifier model)
  runs first — it needs the original text — followed by the regex pipeline,
  which idempotently skips already-issued placeholders. Either layer's hit
  issues a placeholder from the shared registry; one secret keeps one
  placeholder form for the session regardless of which layer detected it.
- **fail_closed everywhere a verdict is missing.** Judge classify errors,
  unanswered candidates, a missing classifier model (default policy), and
  candidates dropped by the batch-size guardrail are all masked as
  unverified. A down judge never means an unmasked request.
- **Compaction failure never falls back.** If the summarization call fails
  after retries, the compaction is cancelled — the session continues
  un-compacted — rather than falling back to pi's unmasked default
  compaction.
- **No stale-clean shortcuts.** Texts that were ever hit (or fail-closed,
  or degraded) are tombstoned in the clean cache and re-examined every
  round; the clean verdict requires both layers to pass.

## Explicitly not covered

- **Local disk.** Session transcripts, and everything the tools read and
  write, keep real values — that is the product's transparency contract.
  Local-disk protection (disk encryption, file permissions, endpoint
  compromise) is a separate concern.
- **Streaming display transient.** While an assistant response streams,
  the terminal briefly renders placeholder text; restoration happens when
  the message completes. A shoulder-surfer during streaming sees
  placeholders (not real values) — the exposure here is cosmetic, not a
  leak.
- **`before_agent_start` forced system prompts.** pi projects a
  forced system prompt *after* the masking hook; another extension that
  injects secrets into a forced prompt bypasses masking. pi-keep-secret
  itself forces no prompt.
- **`judge.onMissing: "regex_only"` degradation.** The one informed gap:
  with the judge configured but its classifier model missing, the default
  is fail-closed masking; the explicit `regex_only` choice degrades to the
  regex layer only, and low-entropy, regex-invisible secrets can then
  egress (including into compaction summary inputs). The degradation is
  visible: one-time notification, status-bar marker, `/keep-secret`
  counters, and the self-test reporting the password sample as failing.

## Known behavioral trade-offs

- **Model awareness.** The model may notice consistent placeholders and
  comment on them. No leak is implied — the provider only ever sees
  placeholders.
- **Restoration illusion.** When the assistant appears to quote a real
  key, the model actually emitted a placeholder; the ingress restoration
  layer produced the real text locally. Transparency by design.
- **Form unification.** One secret, one placeholder form per session —
  chosen by whichever layer issued it first. Cost: a fail-closed turn can
  pin the judge's template shape for a secret a regex detector would have
  shaped differently, and detector-template fidelity yields to model-side
  coherence. Executing tools always receive the restored real value
  regardless.

## Trust boundaries

- **The judge provider must be as trusted as the main provider.** Judge
  questions carry the *candidate-bearing message text* to the classifier
  endpoint (System One / OpenAI Decisions wire). That is by construction:
  judging requires the original text. Point the judge at a provider inside
  the same trust boundary as your main session model — e.g. a gateway you
  operate. If no such endpoint exists, run regex-only (omit the `judge`
  section) rather than sending text to a less-trusted party.
- **The extension itself runs in-process with full session access.** It is
  code you install into pi; review it like any other extension. It makes
  no network calls of its own — only the session's existing model requests
  (plus judge questions when configured).
- **Placeholders are derived from secrets.** Placeholder hashes are
  deterministic functions of the secret (shape-preserving templates over
  an unkeyed base32(SHA-256) segment), so the same secret always maps to
  the same placeholder. They reveal the secret's *shape class* (that it
  looked like an `sk-` key) but not the plaintext: for high-entropy secrets
  the hash segment is not invertible in practice. It is not a commitment
  scheme, though — a low-entropy secret (a short password) could in
  principle be brute-forced from its hash by a determined adversary. The
  primary guarantee stands regardless: the plaintext never egresses, and
  any secret pasted into any model session should be rotated anyway.
