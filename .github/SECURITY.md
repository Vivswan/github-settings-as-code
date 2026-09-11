# Security policy

## Reporting

Do not open a public issue for security problems. Report privately through GitHub's private vulnerability reporting: open this repository's Security tab and choose "Report a vulnerability". What a useful report contains, the response time to expect, and the disclosure expectations are in [Vivswan/.github's SECURITY.md](https://github.com/Vivswan/.github/blob/main/SECURITY.md).

## What counts as a vulnerability here

This action holds a repository-admin token and writes repository settings, so the interesting surface is:

- Token handling. The token is used only in the Authorization header and is never printed, not even in debug traces. Any path that makes it appear in logs, annotations, the step summary, or outputs is a vulnerability.
- Workflow-command injection. API responses and settings-file content are echoed into annotations and the step summary, escaped for workflow commands (%, CR, LF) and for summary tables (pipes, backslashes). Input that breaks out of that escaping and injects commands or forged log lines is a vulnerability.
- Settings escalation. A crafted settings file should never be able to touch a repository or setting it does not declare, nor bypass the preflight barrier or the required-sections policy.
- Supply chain. From the `build` branch onward, every ref a `uses:` pin can name - the `vX.Y.Z` release tags, the moving major, and the `latest` tag - points at a packaged commit on that branch: the recorded source commit's tree without its workflows, plus the bundle built from that source by the workflow run named in its provenance message; main carries no executable bundle, and the packaged commits carry no workflows (consumers run the action, never this repository's workflows). The tags cut before the `build` branch existed (v2.0.0 and earlier) point at release commits on main from when main still committed the bundle; nothing re-verifies them, and the release-tags ruleset is what keeps them where they are. The release-tags ruleset freezes version tags for everything except deliberate repository-admin action (the bypass exists for repair; the release workflow itself never moves a version tag, reruns verify the existing one byte-for-byte instead). A packaged commit whose bundle a rebuild of its recorded source's src/ does not reproduce, or whose tree is not that source's minus workflows plus the bundle, is a vulnerability. The release pipeline also attests every release asset (`lib/index.js` and `lib/settings.schema.json`) in one build-provenance attestation while the repository is public (GitHub offers no attestations elsewhere): fetch either from the `vX.Y.Z` tag or the release assets, then check it with `gh attestation verify
  <artifact> -R vivswan/github-settings-as-code
  --signer-workflow Vivswan/repo-platform/.github/workflows/fleet-release-publish.yml` (`-R` names the source repository; the signer is the fleet's publish workflow, the reusable workflow that ci.yml's `publish-release` job calls to run the attest step, and gh requires the signer flag whenever a reusable workflow signed the attestation: with `-R` alone it expects the signer inside this repository and fails), or without the attestations API via `--bundle` against the `attestation.json` release asset. A release finished by hand carries no attestation at all, and a packaged commit appended by hand no workflow-run trailer: both need the workflow's OIDC identity.

Fixes ship in the next release and are not backported; upgrade the `uses:` pin to pick them up.

Drift-detection false positives, confusing messages, and similar problems are ordinary bugs; use the issue tracker for those.
