---
order: 1
---

# Guides

The documentation for GitHub Settings as Code, in five groups. Start here if the [README](https://github.com/Vivswan/github-settings-as-code#readme) told you what the action does and you want to know how to put it to work: the start pages are enough to get a repository under management, and the rest are there when their topic comes up.

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
| See how the action works, module by module | [reference/architecture.md](reference/architecture.md) |
| Use the engine from your own code | [reference/library.md](reference/library.md) |
| Run check, apply, or validate from a terminal | [start/cli.md](start/cli.md) |
| Detect drift on a schedule | [operate/check-mode.md](operate/check-mode.md) |
| Write a repository's live settings to a file | [operate/snapshot.md](operate/snapshot.md) |
| Fold several settings files into one | [operate/layering.md](operate/layering.md) |
| Manage a fleet from one repository | [operate/multi-repo.md](operate/multi-repo.md) |
| Keep private targets out of public logs | [operate/private-repositories.md](operate/private-repositories.md) |
| Read a failing run | [operate/troubleshooting.md](operate/troubleshooting.md) |
| Adapt a complete platform-team workflow | [playbooks/README.md](playbooks/README.md) |
| Move to a new major version | [upgrading/README.md](upgrading/README.md) |

## start: getting a repository under management

- [Getting started](start/getting-started.md): create the PAT, add the workflow, run your first check, and read the drift output.
- [Migrating from the Probot Settings app](start/migrating-from-probot.md): the step-by-step move, including the parts that changed on purpose and an org-scale shadow run.
- [Examples](start/examples.md): a settings.yml cookbook, from a minimal file to a full-featured one, including what `null` means where it is meaningful.
- [Command line](start/cli.md): the `github-settings-as-code` and `gsac` commands in the npm package, one per action mode plus `validate` and `permissions`, their flags, outputs, and exit codes.

## reference: the normative model

- [Sections](reference/sections.md): every section with its endpoints, PAT permission, undeclared default, and notes.
- [Inputs and outputs](reference/inputs.md): every `with:` input with its default, and the `result`, `skipped-sections`, and `repos-result` outputs.
- [Semantics](reference/semantics.md): stateless, declared-keys-only, convergent applies, softenable errors, retries, and the preflight barrier.
- [Architecture](reference/architecture.md): how the action works in diagrams, from one settings file's journey to the module map, each pinned to the code.
- [Token permissions](reference/permissions.md): which grant each section needs, how a denial surfaces, and the `on-missing-permission` / `required-sections` policy.
- [The undeclared policy](reference/undeclared-policy.md): the `_undeclared` knob on the list sections, per-section defaults, the milestone-deletion caveat, and how the policy layers in `mode: merge`.
- [Forward compatibility](reference/forward-compatibility.md): where payloads pass through verbatim and which sections are deliberately closed.
- [Secrets and vaults](reference/secrets-and-vaults.md): the `$NAME` references secret fields take, wiring them from GitHub Secrets or a vault action, and what check mode can and cannot verify.
- [Library](reference/library.md): the npm package `@vivswan/github-settings-as-code`, how it is built, the API by group with one example each, and how its version tracks the action's.

## operate: day-to-day operation

- [Check mode](operate/check-mode.md): drift detection on a schedule, exit codes, and what a "cannot verify" note is telling you.
- [Snapshot mode](operate/snapshot.md): `mode: snapshot` writes the live settings as a settings file, the `$NAME` placeholders secrets become, the round trip and its exceptions, and the per-repo directory form.
- [Layering settings files](operate/layering.md): `mode: merge` folds an ordered list of files into one document, the rules of the fold, the `_layering` directive, and the two-step workflow.
- [Multi-repo mode](operate/multi-repo.md): manage a fleet from one admin repository with per-repo files, discovery, and a defaults-file fallback for repositories without a file.
- [Private repositories](operate/private-repositories.md): the redaction that keeps private targets out of public logs, and the private-report channels.
- [Troubleshooting](operate/troubleshooting.md): permission denials, ambiguous 403s, rate limits, debug logging, and a missing or stale bundle.

## playbooks: complete workflows to adapt

The [playbooks](playbooks/README.md) compose the pieces above into end-to-end setups: ring rollouts, change previews, trust tiers between tokens, audit evidence, incident freeze, and decommissioning.

## upgrading: one guide per major

[Upgrading](upgrading/README.md) explains how the moving tags work and holds one page per major: [v1 to v2](upgrading/v1-to-v2.md) and [v2 to v3](upgrading/v2-to-v3.md), each break as a row with its before, after, and the error the old form now produces.

## Where the facts live

Generated regions carry the load-bearing facts. Each is rendered from its declarations or generator data by `bun run build:docs` and `bun run build:action-docs`, and `build:check` fails when a committed page drifts:

- the [Sections](reference/sections.md) and [Inputs](reference/inputs.md) tables, and the `result` values on the inputs page;
- [COVERAGE.md](https://github.com/Vivswan/github-settings-as-code/blob/main/COVERAGE.md), the per-section detail behind the Sections table;
- the defaults table and count in [undeclared policy](reference/undeclared-policy.md);
- the grant sentence and gated-read bullets in [permissions](reference/permissions.md) and [check mode](operate/check-mode.md);
- the module map in [architecture](reference/architecture.md), rendered from `architecture.yml`, which `bun run lint:arch` keeps equal to the import graph.

Contract tests pin the remaining authored claims in [forward compatibility](reference/forward-compatibility.md), [private repositories](operate/private-repositories.md), and [troubleshooting](operate/troubleshooting.md): the commands and enumerations that must not drift. The rest is walkthrough prose. When a walkthrough disagrees with a generated or pinned claim, the claim wins, so guides link to the claims rather than duplicating their exact wording.

The settings examples in these pages are validated in CI against the real schema (`test/docs/guides.test.ts`): every fenced block tagged `yaml settings` must be a valid settings document, every block tagged `yaml layer` must validate as one layer of a merge (nulls stripped first, as the merge step does), and a settings-shaped block without a tag fails the build. Every `mermaid` diagram must name real files and exported symbols and link the test that demonstrates it (`test/docs/diagrams.test.ts`). If you edit a guide, tag your example blocks.
