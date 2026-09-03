# Guides

The documentation for GitHub Settings as Code, in four groups. Start here if the [README](../README.md) told you what the action does and you want to know how to put it to work: the start pages are enough to get a repository under management, and the rest are there when their topic comes up.

## start: getting a repository under management

- [Getting started](start/getting-started.md): create the PAT, add the workflow, run your first check, and read the drift output.
- [Migrating from the Probot Settings app](start/migrating-from-probot.md): the step-by-step move, including the parts that changed on purpose and an org-scale shadow run.
- [Examples](start/examples.md): a settings.yml cookbook, from a minimal file to a full-featured one, including what `null` means where it is meaningful.

## reference: the normative model

- [Semantics](reference/semantics.md): stateless, declared-keys-only, convergent applies, softenable errors, retries, and the preflight barrier.
- [Token permissions](reference/permissions.md): which grant each section needs, how a denial surfaces, and the `on-missing-permission` / `required-sections` policy.
- [The undeclared policy](reference/undeclared-policy.md): the `undeclared` knob on the list sections, per-section defaults, the milestone-deletion caveat, and how the policy layers with a defaults file.
- [Forward compatibility](reference/forward-compatibility.md): where payloads pass through verbatim and which sections are deliberately closed.
- [Secrets and vaults](reference/secrets-and-vaults.md): the `$NAME` references secret fields take, wiring them from GitHub Secrets or a vault action, and what check mode can and cannot verify.

## operate: day-to-day operation

- [Check mode](operate/check-mode.md): drift detection on a schedule, exit codes, and what a "cannot verify" note is telling you.
- [Multi-repo mode](operate/multi-repo.md): manage a fleet from one admin repository with defaults, per-repo files, and discovery.
- [Private repositories](operate/private-repositories.md): the redaction that keeps private targets out of public logs, and the private-report channels.
- [Troubleshooting](operate/troubleshooting.md): permission denials, ambiguous 403s, rate limits, debug logging, and a missing or stale bundle.

## playbooks: complete workflows to adapt

The [playbooks](playbooks/README.md) compose the pieces above into end-to-end setups: ring rollouts, change previews, trust tiers between tokens, audit evidence, incident freeze, and decommissioning.

## Where the facts live

Generated regions carry the load-bearing facts. The README's Sections and Inputs tables, [COVERAGE.md](../COVERAGE.md), the defaults table and count in [undeclared policy](reference/undeclared-policy.md), the grant phrases in [permissions](reference/permissions.md), and the gated-read bullets in [check mode](operate/check-mode.md) are rendered from their declarations and generator data. `bun run build:docs` and `bun run build:action-docs` render them, and `build:check` fails when a committed page drifts. Contract tests pin the remaining authored claims in [forward compatibility](reference/forward-compatibility.md), [private repositories](operate/private-repositories.md), and [troubleshooting](operate/troubleshooting.md): the commands and enumerations that must not drift. The rest is walkthrough prose. When a walkthrough disagrees with a generated or pinned claim, the claim wins, so guides link to the claims rather than duplicating their exact wording.

The settings examples in these pages are validated in CI against the real schema (`test/docs/guides.test.ts`): every fenced block tagged `yaml settings` must be a valid settings document, and a settings-shaped block without the tag fails the build. If you edit a guide, tag your example blocks.
