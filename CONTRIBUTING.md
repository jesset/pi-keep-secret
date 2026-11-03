# Contributing

Work happens in small, ticket-sized increments driven by GitHub issues;
issues labeled `ready-for-agent` are ready to pick up. Discussion before
large changes is appreciated — open an issue first.

## Setup

```bash
bun install
```

## Check your work

```bash
bun test            # full suite, run bare — test isolation is built in
bun run typecheck   # tsc --noEmit (the same command CI runs)
```

`bun test` needs no flags: a global preload (see `bunfig.toml`) pins
`PI_KEEP_SECRET_CONFIG` to a path that never exists, so no test can read
your real user-level config, and no live credentials are ever required.

## Testing seams

Two seams carry the suite: an **in-process session harness with a scripted
faux provider** (`src/harness/fake-session.ts` — the provider view is
asserted directly, no network) and **pure-function unit tests** for engine,
config, cache, and judge logic. Prefer extending these over new
infrastructure.

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/)
  (`docs:`, `feat:`, `fix:`, `test:`, `refactor:` …).
- **Branches**: one branch per issue, in its own worktree.
- Design rationale, fact findings, and the engineering history behind the
  seams live in [docs/dev-notes.md](docs/dev-notes.md) — read it before
  changing the masking pipeline, judge wiring, or compaction.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
