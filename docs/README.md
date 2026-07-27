# Guides

Task-oriented walkthroughs for Repo Settings as Code. Start here if the
[README](../README.md) told you what the action does and you want to know how
to put it to work. Reading the two "start here" pages in order is enough to
get a repository under management; the rest are there when their topic comes
up.

## Start here

- [Getting started](start/getting-started.md): create the PAT, add the workflow,
  run your first check, and read the drift output.
- [Examples](start/examples.md): a settings.yml cookbook, from a minimal file to a
  full-featured one, including what `null` means where it is meaningful.

## Running it

- [Check mode](operate/check-mode.md): drift detection on a schedule, exit codes, and
  what a "cannot verify" note is telling you.
- [Multi-repo mode](operate/multi-repo.md): manage a fleet from one admin repository
  with defaults, per-repo files, and discovery.
- [Playbooks](playbooks/README.md): ring rollouts, change previews, trust tiers
  between tokens, audit evidence, incident freeze, and decommissioning.

## The knobs in depth

- [The undeclared policy](concepts/undeclared-policy.md): the `undeclared` knob on the
  list sections, per-section defaults, the milestone-deletion caveat, and how
  the policy layers with a defaults file.
- [Secrets and vaults](concepts/secrets-and-vaults.md): the `$NAME` references secret
  fields take (webhook secrets, the `actions_secrets` /
  `dependabot_secrets` / `codespaces_secrets` sections, and per-environment
  secrets), wiring them from GitHub Secrets or a vault action, what check
  mode can and cannot verify, and the multi-repo fan-out to plan for.

## Coming from elsewhere, or stuck

- [Migrating from the Probot Settings app](help/migrating-from-probot.md): a
  step-by-step move, including the parts that changed on purpose.
- [Troubleshooting](help/troubleshooting.md): permission denials, ambiguous 403s,
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
