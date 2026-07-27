# Guides

Task-oriented walkthroughs for Repo Settings as Code. Start here if the
[README](../README.md) told you what the action does and you want to know how
to put it to work.

- [Getting started](getting-started.md): create the PAT, add the workflow,
  run your first check, and read the drift output.
- [Examples](examples.md): a settings.yml cookbook, from a minimal file to a
  full-featured one, including what `null` means where it is meaningful.
- [Multi-repo mode](multi-repo.md): manage a fleet from one admin repository
  with defaults, per-repo files, and discovery.
- [Playbooks](playbooks.md): ring rollouts, change
  previews, trust tiers between tokens, audit evidence, incident freeze,
  and decommissioning.
- [Check mode](check-mode.md): drift detection on a schedule, exit codes, and
  what a "cannot verify" note is telling you.
- [Migrating from the Probot Settings app](migrating-from-probot.md): a
  step-by-step move, including the parts that changed on purpose.
- [Troubleshooting](troubleshooting.md): permission denials, ambiguous 403s,
  rate limits, debug logging, and a stale bundle.

## Where the facts live

These pages are walkthroughs, not the specification. The normative claims
about what the action supports and how each section behaves live in the
[README](../README.md) and in [COVERAGE.md](../COVERAGE.md), where contract
tests pin the prose to the code. The guides explain and compose that
behavior, but they are not the pinned source: when a guide and a pinned
claim disagree, the pinned claim wins. Link to the claims rather than
duplicating their exact wording.

The settings examples in these pages are validated in CI against the real
schema (`test/docs/guides.test.ts`): every fenced block tagged `yaml settings`
must be a valid settings document, and a settings-shaped block without the tag
fails the build. If you edit a guide, tag your example blocks.
