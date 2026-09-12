# Security policy

## Reporting

Do not open a public issue for security problems. Report privately through GitHub's private vulnerability reporting: open this repository's Security tab and choose "Report a vulnerability". What a useful report contains, the response time to expect, and the disclosure expectations are in [Vivswan/.github's SECURITY.md](https://github.com/Vivswan/.github/blob/main/SECURITY.md).

## What counts as a vulnerability here

This action holds a repository-admin token and writes repository settings, so the interesting surface is:

- Token handling. The token travels only in the Authorization header and is never printed, not even in debug traces. Any path that puts it in logs, annotations, the step summary, or outputs is a vulnerability.
- Workflow-command injection. API responses and settings-file content are echoed into annotations and the step summary, escaped for workflow commands (%, CR, LF) and for summary tables (pipes, backslashes). Input that breaks out of that escaping and injects commands or forged log lines is a vulnerability.
- Settings escalation. A crafted settings file must never touch a repository or setting it does not declare, nor bypass the preflight barrier or the required-sections policy.
- Supply chain. A packaged commit whose bundle a rebuild of its recorded source does not reproduce, or whose tree is not that source's minus workflows plus the bundle, is a vulnerability. The next section says what each ref points at and how to verify it.
- npm provenance. Every CI-published version of `@vivswan/github-settings-as-code` carries an npm provenance attestation naming this repository and workflow, which `npm audit signatures` checks in a project that installs it. A version without one, or whose attestation names another repository or workflow, is a vulnerability; the one exception is the hand-published bootstrap pre-release, recognizable by run number 0 in its version (`-main.0.g<sha7>`).

## Verifying a release

What a `uses:` pin points at:

- The `vX.Y.Z` tags, the moving major, and `latest` point at packaged commits on the `build` branch: the source commit's tree without its workflows, plus the bundle built from that source by the workflow run named in its message. `main` carries no executable bundle, and the packaged commits carry no workflows (consumers run the action, never this repository's workflows).
- The tags up to v2.0.0 point at release commits on `main` from when `main` still committed the bundle. Nothing re-verifies them; the release-tags ruleset is what keeps them where they are.
- The release-tags ruleset freezes version tags for everything except deliberate repository-admin repair. The release workflow never moves a version tag; a rerun verifies the existing one byte-for-byte.
- npm publishes through trusted publishing (OIDC) from `ci.yml`. The package disallows tokens, so no registry token exists anywhere.

Every release attests its assets (`lib/index.js` and `lib/settings.schema.json`) in one build-provenance attestation while the repository is public (GitHub offers no attestations elsewhere). Fetch either asset from the `vX.Y.Z` tag or the release, then:

```sh
gh attestation verify <artifact> -R vivswan/github-settings-as-code \
  --signer-workflow Vivswan/repo-platform/.github/workflows/fleet-release-publish.yml
```

- `-R` names the source repository. `--signer-workflow` names the fleet's reusable publish workflow that ran the attest step; gh requires it whenever a reusable workflow signed, and with `-R` alone it expects the signer inside this repository and fails.
- Without the attestations API, pass `--bundle` with the `attestation.json` release asset.
- A release finished by hand carries no attestation, and a packaged commit appended by hand no workflow-run trailer: both need the workflow's OIDC identity.

## Scope of fixes

- Fixes ship in the next release and are not backported; move the `uses:` pin to pick them up.
- Drift-detection false positives, confusing messages, and similar problems are ordinary bugs; use the issue tracker for those.
