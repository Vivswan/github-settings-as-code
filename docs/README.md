---
order: 1
---

# Guides

The documentation for GitHub Settings as Code, in four groups. Start here if the [README](https://github.com/Vivswan/github-settings-as-code#readme) told you what the action does and you want to know how to put it to work: the start pages are enough to get a repository under management, and the rest are there when their topic comes up.

## Pick by goal

| Goal | Read |
|---|---|
| Get one repository under management | [start/getting-started.md](start/getting-started.md) |
| Replace the Probot Settings app | [start/migrating-from-probot.md](start/migrating-from-probot.md) |
| Copy a settings.yml shape | [start/examples.md](start/examples.md) |
| Look up what a section manages and deletes | [reference/sections.md](reference/sections.md) |
| Look up an input or output | [reference/inputs.md](reference/inputs.md) |
| Scope the token | [reference/permissions.md](reference/permissions.md) |
| Predict what an apply or a check will do | [reference/semantics.md](reference/semantics.md) |
| Detect drift on a schedule | [operate/check-mode.md](operate/check-mode.md) |
| Manage a fleet from one repository | [operate/multi-repo.md](operate/multi-repo.md) |
| Keep private targets out of public logs | [operate/private-repositories.md](operate/private-repositories.md) |
| Read a failing run | [operate/troubleshooting.md](operate/troubleshooting.md) |
| Adapt a complete platform-team workflow | [playbooks/README.md](playbooks/README.md) |

## start: getting a repository under management

- [Getting started](start/getting-started.md): create the PAT, add the workflow, run your first check, and read the drift output.
- [Migrating from the Probot Settings app](start/migrating-from-probot.md): the step-by-step move, including the parts that changed on purpose and an org-scale shadow run.
- [Examples](start/examples.md): a settings.yml cookbook, from a minimal file to a full-featured one, including what `null` means where it is meaningful.

## reference: the normative model

- [Sections](reference/sections.md): every section with its endpoints, PAT permission, undeclared default, and notes.
- [Inputs and outputs](reference/inputs.md): every `with:` input with its default, and the `result`, `skipped-sections`, and `repos-result` outputs.
- [Semantics](reference/semantics.md): stateless, declared-keys-only, convergent applies, softenable errors, retries, and the preflight barrier.
- [Token permissions](reference/permissions.md): which grant each section needs, how a denial surfaces, and the `on-missing-permission` / `required-sections` policy.
- [The undeclared policy](reference/undeclared-policy.md): the `_undeclared` knob on the list sections, per-section defaults, the milestone-deletion caveat, and how the policy layers with a defaults file.
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

Generated regions carry the load-bearing facts. Each is rendered from its declarations or generator data by `bun run build:docs` and `bun run build:action-docs`, and `build:check` fails when a committed page drifts:

- the [Sections](reference/sections.md) and [Inputs](reference/inputs.md) tables, and the `result` values on the inputs page;
- [COVERAGE.md](https://github.com/Vivswan/github-settings-as-code/blob/main/COVERAGE.md), the per-section detail behind the Sections table;
- the defaults table and count in [undeclared policy](reference/undeclared-policy.md);
- the grant sentence and gated-read bullets in [permissions](reference/permissions.md) and [check mode](operate/check-mode.md).

Contract tests pin the remaining authored claims in [forward compatibility](reference/forward-compatibility.md), [private repositories](operate/private-repositories.md), and [troubleshooting](operate/troubleshooting.md): the commands and enumerations that must not drift. The rest is walkthrough prose. When a walkthrough disagrees with a generated or pinned claim, the claim wins, so guides link to the claims rather than duplicating their exact wording.

The settings examples in these pages are validated in CI against the real schema (`test/docs/guides.test.ts`): every fenced block tagged `yaml settings` must be a valid settings document, and a settings-shaped block without the tag fails the build. If you edit a guide, tag your example blocks.
