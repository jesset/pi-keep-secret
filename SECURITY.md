# Security Policy

## Reporting a vulnerability

**Use [GitHub's private vulnerability reporting](https://github.com/jesset/pi-keep-secret/security/advisories/new)** — the *Security* tab → *Report a vulnerability*. This is the only channel for vulnerability reports; please do not open public issues or PRs for security bugs.

Include what you can of: affected version, a minimal reproduction, and the impact you see (e.g. a path where a real value reaches an outbound request).

## What to expect

- **Acknowledgement** of a valid report within 72 hours.
- **Assessment and triage** within one week; we will keep you informed of
  progress.
- **Fixes** are prioritized by severity and released as soon as practical;
  reporters are credited in the advisory unless they prefer otherwise.

This project's own scope is worth reading before reporting: pi-keep-secret
masks secrets in **outbound model requests** only. Local session files keep
real values by design, and other explicit non-goals are documented in the
[threat model](docs/threat-model.md) — those are known limitations, not
vulnerabilities.

## Non-vulnerability security discussions

Questions about hardening, configuration for sensitive environments, or the
threat model are welcome as regular [GitHub issues](https://github.com/jesset/pi-keep-secret/issues).
