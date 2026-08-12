# Security policy

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/github-settings-as-code/security/advisories/new)
("Report a vulnerability"). If that page is unavailable (GitHub offers no
advisories on private personal repositories), contact
[@Vivswan](https://github.com/vivswan)
directly instead. A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Expect an acknowledgement within a few days, and a fix in the next release
once the report is confirmed. Please allow reasonable time for that fix
before any public disclosure.

Never include real credentials in a report; redact everything that looks like
a key.

<!-- Repository-specific security documentation (scope, threat model, review
     expectations for security-relevant changes) goes below this line. It
     survives template updates via three-way merge. -->
<!-- repo-platform:local-section -->

## What counts as a vulnerability here

This action holds a repository-admin token and writes repository settings,
so the interesting surface is:

- Token handling. The token is used only in the Authorization header and is
  never printed, not even in debug traces. Any path that makes it appear in
  logs, annotations, the step summary, or outputs is a vulnerability.
- Workflow-command injection. API responses and settings-file content are
  echoed into annotations and the step summary, escaped for workflow
  commands (%, CR, LF) and for summary tables (pipes, backslashes). Input
  that breaks out of that escaping and injects commands or forged log lines
  is a vulnerability.
- Settings escalation. A crafted settings file should never be able to
  touch a repository or setting it does not declare, nor bypass the
  preflight barrier or the required-sections policy.
- Supply chain. The runnable ref is a build commit parented on the audited
  release commit, produced by the release workflow run named in its
  provenance message, and published as a `build/vX.Y.Z` tag in a namespace
  the release-tags ruleset freezes; main carries no executable bundle. A
  build commit whose bundle a rebuild of its parent's src/ does not
  reproduce is a vulnerability. The release workflow also attests the
  bundle's build provenance: fetch `lib/index.js` from the `build/vX.Y.Z`
  tag or the release assets, then check it with `gh attestation verify
  lib/index.js -R vivswan/github-settings-as-code` (add
  `--signer-workflow vivswan/github-settings-as-code/.github/workflows/release.yml`
  to also pin the producing workflow), or without the attestations API via
  `--bundle` against the `lib-index-js.sigstore.json` release asset. A
  release finished by hand carries no attestation at all: producing one
  needs the workflow's OIDC identity.

Fixes ship in the next release and are not backported; upgrade the `uses:`
pin to pick them up.

Drift-detection false positives, confusing messages, and similar problems
are ordinary bugs; use the issue tracker for those.
