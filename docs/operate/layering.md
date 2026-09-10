---
order: 250
---

# Layering settings files

`mode: merge` folds an ordered list of settings files into one settings document and writes it to a file. Apply and check never merge: each takes exactly one final document per target. So layering is a two-step workflow: a merge step, then an apply or check step on the written file.

The fold is pure: no token is read and no GitHub API call is made. The engine that does it is [src/engine/layers.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/src/engine/layers.ts); its worked cases are in [test/engine/layers.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/layers.test.ts).

## A first fold

Two layers, lowest first. The fleet file:

```yaml layer
# .github/settings/fleet.yml
repository:
  has_wiki: false
labels:
  - name: bug
    color: d73a4a
```

The repository file adds a description and a label:

```yaml layer
# .github/settings/repo.yml
repository:
  description: mine
labels:
  - name: incident
    color: "b60205"
```

`mode: merge` over the two writes this document, which apply then runs:

```yaml settings
repository:
  has_wiki: false
  description: mine
labels:
  _undeclared: delete
  entries:
    - name: bug
      color: d73a4a
    - name: incident
      color: "b60205"
```

Mappings merged key by key, the two label lists unioned by name, and `labels` came out in its wrapper form with the section default filled in. The rest of this page is the full rule set behind that.

## Inputs in mode: merge

| Input | In `mode: merge` |
|---|---|
| `mode` | `merge` |
| `settings-file` | The ordered list of layer paths, newline- or comma-separated, lowest layer first |
| `merged-file` | Required: where the merged document is written (parent directories are created). It must not name one of the `settings-file` layers, compared as resolved paths: the run refuses that, naming the layer's position, because the merge would overwrite the layer and the next run would fold the merged document as one |
| `layering` | `merge` (default) or `replace`: the run-wide default for the keyed list sections, see below |
| `token` | Ignored: a merge makes no GitHub API call, so a token a workflow sets on every step does no harm |
| `repository`, `repos`, `repos-dir`, `defaults-file`, `visibility`, `archived`, `forks`, `exclude`, `topics`, `affiliation`, `sections`, `required-sections`, `on-missing-permission`, `api-version`, `private-repos`, `private-report`, `report-public-key` | Rejected when set to a non-default value: a merge addresses no repository, fleet, or report, calls no API, and writes every section its layers declare; a `sections` allowlist belongs on the step that runs the merged document |

The step ends with `result: merged` and exit 0, or exit 1 with an error naming the layer that was refused.

## Three knobs

| Knob | Where | Axis | Meaning |
|---|---|---|---|
| `layering` | The action input | Merge time | Run-wide default for how a keyed list section combines with the layers below it: `merge` (default) unions entries by key, `replace` lets the higher list win |
| `_layering` | A list section's `{entries}` wrapper, or a file's top level | Merge time | Overrides `layering` for that section, or for every section of that file. Consumed by the merge: the merged file never carries it |
| `_undeclared` | A list section's `{entries}` wrapper | Live state | What apply does to live resources the document does not declare: `keep` or `delete`. Travels through the merge and is resolved in the merged file. The [undeclared policy](../reference/undeclared-policy.md) page owns it |

The two underscore keys are this action's directives, never GitHub settings. Any other underscore key at a file's top level is a private note and is dropped from the merged file.

## The rules

Layers fold low to high. At each step the higher layer's value meets whatever the lower layers built so far.

| Higher layer | Over | Result |
|---|---|---|
| A mapping | A mapping | Merged key by key. Lower keys keep their order, higher-only keys follow |
| A scalar, a list, or a YAML-tagged value | Anything | Replaces |
| `null` (at any depth) | A declared value | Deletes the key, with a notice naming the layer and the path |
| `null` | Nothing, or another `null` | Stays as written, so `pages: null` still means "disable Pages" |
| `labels` entries, layering `merge` | `labels` entries | Union by name (case-folded). A same-name entry replaces the lower one in place, new names are appended |
| `rulesets` entries, layering `merge` | `rulesets` entries | Union by name. A same-name ruleset merges key by key; its `rules` pair by `type`, a same-type rule replacing in place and new types appended |
| Any list section under layering `replace`, or one without a key (`milestones`, `webhooks`, ...) | Its entries | The higher list wins. An omitted `_undeclared` still inherits the lower layer's |
| Any other list (`branches`, `environments`, `topics`, ...) | A list | Replaces, whatever the run's layering |

Only `labels` and `rulesets` declare a layering key today. Every other list section can only be replaced, and `_layering: merge` on one is refused.

The `_undeclared` knob across layers:

- A plain list, or a bare `{entries}` wrapper, inherits the policy a lower layer set.
- An explicit higher `_undeclared` wins.
- After the fold, a section that still has no explicit policy takes the section default, so the merged file is self-describing.

## A worked example

Three layers, lowest first. The fleet baseline:

```yaml layer
# .github/settings/fleet.yml
repository:
  has_wiki: false
  has_projects: false
labels:
  - name: bug
    color: d73a4a
  - name: docs
    color: "0075ca"
rulesets:
  - name: main
    target: branch
    enforcement: active
    rules:
      - type: deletion
pages:
  build_type: workflow
  source:
    branch: main
    path: /
```

The team layer removes the fleet's `has_projects` opinion, adds a label, and adds a rule to the `main` ruleset:

```yaml layer
# .github/settings/team.yml
repository:
  has_projects: null
labels:
  - name: team
    color: "00ff00"
rulesets:
  - name: main
    rules:
      - type: non_fast_forward
```

The repository layer sets its description, recolors `docs`, and opts out of Pages:

```yaml layer
# .github/settings/repo.yml
repository:
  description: mine
labels:
  - name: docs
    color: ffffff
pages: null
```

Merged under the default `layering: merge`, the written file is:

```yaml settings
repository:
  has_wiki: false
  description: mine
labels:
  _undeclared: delete
  entries:
    - name: bug
      color: d73a4a
    - name: docs
      color: ffffff
    - name: team
      color: "00ff00"
rulesets:
  _undeclared: keep
  entries:
    - name: main
      target: branch
      enforcement: active
      rules:
        - type: deletion
        - type: non_fast_forward
```

And the run annotates the two deletions:

```text
.github/settings/team.yml: null removed repository.has_projects declared by a lower layer
.github/settings/repo.yml: null removed pages declared by a lower layer
```

Reading it back:

- `has_projects` and `pages` are gone: a higher `null` met a lower declaration.
- `docs` kept its position and took the higher color.
- The `main` ruleset kept `target` and `enforcement` from the fleet and gained a rule.
- Both list sections came out in wrapper form with their section default filled in.

## What the merged file looks like

The merged file is exactly what apply runs, so it is worth knowing its shape:

- Every list section that takes the `_undeclared` knob (the fifteen the [undeclared policy](../reference/undeclared-policy.md) lists) is in its `{_undeclared, entries}` wrapper form, with `_undeclared` resolved to an explicit `keep` or `delete`. Other lists (`branches`, `environments`, and the nested per-environment lists) stay as written.
- No `_layering` anywhere, and no private underscore notes: both are consumed before the file is written.
- A `null` that met nothing below stays, keeping its engine meaning.
- Every layer was validated on its own before the fold, and the result is validated again before it is written.

## The two-step workflow

```yaml
name: Apply settings
on:
  push:
    branches: [main]
    paths: [".github/settings/**"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          mode: merge
          settings-file: |
            .github/settings/fleet.yml
            .github/settings/team.yml
            .github/settings/repo.yml
          merged-file: .github/settings/merged.yml
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          settings-file: .github/settings/merged.yml
```

Swap the second step to `mode: check` to preview what the merged document would change. The merge step is the same either way.

Commit the merged file only if you want to review it in pull requests; the step rewrites it on every run.

## Validation per layer

Each layer must be a valid settings document on its own, judged after its `null` markers are removed. So a layer may say `labels: null` or `rulesets: [{name: main, bypass_actors: null}]`.

Whatever a standalone settings file may not say, a layer may not say either:

- An unknown top-level section, a misspelled wrapper key, or a wrong shape in a closed section fails the merge step, naming the layer, before any fold happens.
- Fields the validator passes through to GitHub (a misspelled `repository` key, say) pass through here too.

The merge can never complete a broken declaration into a valid one.

## Refusals

Two gates refuse a layer, in this order. Each error names the layer.

The per-layer validation catches what a standalone settings file could not say, with the same messages a standalone file gets:

| The layer has | Caught by |
|---|---|
| A list section that is not a list or an `{entries}` wrapper (`labels: oops`) | Validation: `labels: Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_undeclared" policy), but this section parsed as string` |
| A keyed entry without its key, here a label with no `name` (`labels: [{name: bug}, {color: d73a4a}]`) | Validation: `labels[1].name: Invalid input: expected string, received undefined` |
| A non-mapping entry (`milestones: [v2]`) | Validation: `milestones[0]: Invalid input: expected object, received string` |

The fold itself refuses what only a merge can judge (`layer ".github/settings/repo.yml": ...`). A fold refusal names the key path (entries by index) and the kind of problem, never a value from the document: the merge runs without a repository's redaction context, so a label name or rule type echoed here could put a private repository's settings into a public log.

That guarantee covers the fold alone. The per-layer validation prints the same messages an apply or check run prints, and those can name what they find: an unrecognized key in a strict object (`actions.cache: Unrecognized key: "cache_ttl"`), an unknown top-level section by its name, a closed section's entry by its identity with the key it does not know (`collaborators[octocat]: declares "permision", which this section does not recognize`), and, where a section words its own error, the rejected value itself (`repository.enable_vulnerability_alerts: "yes" is not a boolean`; `interaction_limits.pull_request_creation_bypass: "Octocat" and "octocat" name the same login`; a duplicate environment or bypass actor under `branches`; the name of an `environments` entry missing its branch-policy flag). A YAML syntax error quotes the offending source line. A merge-mode log can therefore show your settings file's structure and, from those messages, a value from it: treat it like any log that prints a parse error for a file the runner holds.

| The layer has | The fold says |
|---|---|
| Two entries under one key in one list (`labels: [{name: bug}, {name: docs}, {name: Bug}]`) | `labels[0] and labels[2] both claim one name; each name belongs to one entry within a layer` |
| Two rules of one type in one ruleset (`rulesets: [{name: main, rules: [{type: deletion}, {type: deletion}]}]`) | `rulesets[0].rules[0] and rulesets[0].rules[1] both claim one type; each type belongs to one entry within a layer` |
| `_layering: merge` on a section with no layering key, on its wrapper or reached from the file level (`milestones: {_layering: merge, entries: [{title: v1}]}` or `{_layering: merge, milestones: [{title: v1}]}`) | `milestones has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive` |
| An unknown `_layering` value on a wrapper (`labels: {_layering: union, entries: [{name: bug}]}`) | `labels._layering must be "merge" or "replace"; got a string that is neither` |
| An unknown `_layering` value at the file's top level (`_layering: union`) | `_layering must be "merge" or "replace"; got a string that is neither` |
| A YAML anchor aliased inside its own node (`_notes: &loop {self: *loop}`) | `the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees` |

## Where to go next

[Multi-repo mode](multi-repo.md) explains how a `defaults-file` is a fallback for repositories without a settings file, not a layer. [The undeclared policy](../reference/undeclared-policy.md) owns the `_undeclared` knob the merged file resolves. [Architecture](../reference/architecture.md) shows where the fold sits in the pipeline.
