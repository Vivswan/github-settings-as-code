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
  description: mine
  has_wiki: false
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
| `repository`, `repos`, `repos-dir`, `defaults-file`, `snapshot-file`, `snapshot-dir`, `visibility`, `archived`, `forks`, `exclude`, `topics`, `affiliation`, `sections`, `required-sections`, `on-missing-permission`, `api-version`, `private-repos`, `private-report`, `report-public-key` | Rejected when set to a non-default value: a merge addresses no repository, fleet, or report, calls no API, and writes every section its layers declare; a `sections` allowlist belongs on the step that runs the merged document |

The step ends with `result: merged` and exit 0, or exit 1 with an error naming the layer that was refused.

## Three knobs

| Knob | Where | Axis | Meaning |
|---|---|---|---|
| `layering` | The action input | Merge time | Run-wide default for how a keyed list section combines with the layers below it: `merge` (default) unions entries by key, `replace` lets the higher list win |
| `_layering` | A list section's `{entries}` wrapper, or a file's top level | Merge time | Overrides `layering` for that section, or for every section of that file. Consumed by the merge: the merged file never carries it |
| `_undeclared` | A list section's `{entries}` wrapper | Live state | What apply does to live resources the document does not declare: `keep` or `delete`. Travels through the merge and is resolved in the merged file. The [undeclared policy](../reference/undeclared-policy.md) page owns it |

The two underscore keys are this action's directives, never GitHub settings, and they are the whole underscore vocabulary: any other underscore key, at a file's top level or on a wrapper, fails validation with an error naming these two (a note belongs in a YAML comment). A misspelled directive can therefore never pass as a private note and quietly merge a layer meant to replace.

## The rules

Layers fold low to high. At each step the higher layer's value meets whatever the lower layers built so far.

| Higher layer | Over | Result |
|---|---|---|
| A mapping | A mapping | Merged key by key. Lower keys keep their order, higher-only keys follow |
| A scalar, a list, or a YAML-tagged value | Anything | Replaces |
| `null` (at any depth) | A declared value | Deletes the key, with a notice naming the layer and the path, except on `pages` and `interaction_limits`, where `null` is the section's value and is written as such, with no notice |
| `null` | Nothing, or another `null` | Below the top level, stays as written. At the top level it opted out of nothing and drops with no notice, except on `pages` and `interaction_limits`, where `null` is the section's value and stays (`pages: null` still means "disable Pages") |
| `labels` entries, layering `merge` | `labels` entries | Union by name (case-folded). A same-name entry replaces the lower one in place, new names are appended |
| `rulesets` entries, layering `merge` | `rulesets` entries | Union by name. A same-name ruleset merges key by key; its `rules` pair by `type`, a same-type rule replacing in place and new types appended |
| Any list section under layering `replace`, or one without a key (`milestones`, `webhooks`, ...) | Its entries | The higher list wins. An omitted `_undeclared` still inherits the lower layer's |
| Any other list (`branches`, `environments`, `topics`, ...) | A list | Replaces, whatever the run's layering |

Only `labels` and `rulesets` declare a layering key today. Every other list section can only be replaced, and `_layering: merge` on one is refused.

The rules above decide the content; the written file's order is the canonical one every rendered document has, the same order `mode: snapshot` writes: sections in the order the action applies them, keys as the schema declares them, the entries of every keyed list sorted by their identity. Reordering keys, or the entries of a keyed list, in a layer changes nothing in the merged file. The lists kept as written do change it: `branches` (GitHub applies overlapping wildcard rules in creation order), the `pinned: true` environments (their order is the pin rank), the two mapping lists with no identity (`bypass_actors`, `reviewers`), and every scalar list (`topics`, `include` patterns).

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

The repository layer sets its description, recolors `docs`, and turns Pages off:

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
  description: mine
  has_wiki: false
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
pages: null
```

And the run annotates the one deletion:

```text
.github/settings/team.yml: null removed repository.has_projects declared by a lower layer
```

Reading it back:

- `has_projects` is gone: a higher `null` met a lower declaration.
- `pages` is `null`, not gone: on this section `null` is the value that turns Pages off, so it replaces the fleet's site with no notice.
- `docs` kept its position and took the higher color.
- The `main` ruleset kept `target` and `enforcement` from the fleet and gained a rule.
- Both list sections came out in wrapper form with their section default filled in.

## What the merged file looks like

The merged file is exactly what apply runs, so it is worth knowing its shape:

- Every list section that takes the `_undeclared` knob (the sections the [undeclared policy](../reference/undeclared-policy.md) counts in its opening sentence) is in its `{_undeclared, entries}` wrapper form, with `_undeclared` resolved to an explicit `keep` or `delete`. Other lists (`branches`, `environments`, and the nested per-environment lists) stay as written.
- No `_layering` anywhere: the directive is consumed before the file is written, and YAML comments do not survive the fold.
- A top-level `null` that met nothing below is gone, except `pages: null` and `interaction_limits: null`, which keep their engine meaning; a nested one stays as written.
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
| An underscore key that is not a directive on a wrapper (`labels: {_notes: x, entries: [{name: bug}]}`) | Validation: `labels: Unrecognized key: "_notes"; the wrapper's directives are "_undeclared" and, on a top-level section, "_layering", and nothing else - there are no private-note keys. Remove the key, or keep the note as a YAML comment` |

The fold itself refuses what only a merge can judge (`layer ".github/settings/repo.yml": ...`). A fold refusal names the key path (entries by index) and the kind of problem, never a value from the document: the merge runs without a repository's redaction context, so a label name or rule type echoed here could put a private repository's settings into a public log.

That guarantee covers the fold alone. The per-layer validation prints the same messages an apply or check run prints, and these message families can name what they find:

- An unrecognized key in a strict object: `actions.cache: Unrecognized key: "cache_ttl"`, and `interaction_limits: Unrecognized key: "private_project"; interaction_limits takes limit, expiry, ...`, whose four keys are closed. A type mismatch prints only the type received, except a non-finite number, which prints as itself: `actions.cache.max_cache_size_gb: .inf` gives `Invalid input: expected number, received Infinity` (the vocabulary is Infinity, -Infinity, and NaN).
- An unknown top-level section, by its name: `unknown top-level section in repo.yml: lables`.
- A key path through keys you chose, wherever a section accepts arbitrary ones: `repository.private_project is not plain YAML data`.
- A closed section's entry, by its identity, with the key it does not know: `collaborators[octocat]: declares "permision", which this section does not recognize`.
- A section-worded error that prints the rejected value:
  - `repository` toggles and the issue policy: `repository.enable_vulnerability_alerts: "yes" is not a boolean` and `repository.issue_creation_policy: "everyone" is not a recognized policy`.
  - `interaction_limits` logins: `interaction_limits.pull_request_creation_bypass: "Octocat" and "octocat" name the same login`.
  - `branches` duplicates: `branches[0].protection.force_push_bypassers: force_push_bypassers lists "octocat" more than once`, and the same for `required_deployments.environments`.
  - `branches` wildcard entries, by name with the unrecognized key: `branches[0].protection.enforce_admin: the wildcard entry "release/*" declares protection.enforce_admin, which this section does not manage on wildcard rules`.
  - `branches` wildcard entries, by name with the scalar declared where a mapping belongs, the widest echo in the set: `branches[0].protection.required_status_checks: the wildcard entry "release/*" declares protection.required_status_checks as "strict", but on a wildcard rule it must be a mapping`.
  - `environments` entries, by name: `environments[0].deployment_branch_policies: the "prod" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy`.
  - `actions.selected_actions`, repeating the declared `allowed_actions`, which has already passed its enum, so only `all`, `local_only`, or `selected` can appear: `actions.selected_actions: selected_actions is declared together with allowed_actions: "all", but an allowlist only applies under allowed_actions: "selected"`.
- A YAML syntax error, quoting the offending source line with a caret under the column; an unresolved alias names the alias instead, and an anchor whose name carries whitespace or a control character prints that name after `Anchor must not contain whitespace or control characters:`.
- A YAML parser warning (an unresolved tag, an unknown directive, an ambiguous anchor, a collection used as a key) prints nothing: the parser runs with its warnings off, so such a document parses silently to the same object it always did, and only a parse failure reaches the log, printing what the bullet above describes.

A merge-mode log can therefore show your settings file's structure and, through these messages, a value from it: treat it like any log that prints a parse error for a file the runner holds.

| The layer has | The fold says |
|---|---|
| Two entries under one key in one list (`labels: [{name: bug}, {name: docs}, {name: Bug}]`) | `labels[0] and labels[2] both claim one name; each name belongs to one entry within a layer` |
| Two rules of one type in one ruleset (`rulesets: [{name: main, rules: [{type: deletion}, {type: deletion}]}]`) | `rulesets[0].rules[0] and rulesets[0].rules[1] both claim one type; each type belongs to one entry within a layer` |
| `_layering: merge` on a section with no layering key, on its wrapper or reached from the file level (`milestones: {_layering: merge, entries: [{title: v1}]}` or `{_layering: merge, milestones: [{title: v1}]}`) | `milestones has no layering key, so it cannot be layered by "merge"; declare _layering: replace or drop the directive` |
| An unknown `_layering` value on a wrapper (`labels: {_layering: union, entries: [{name: bug}]}`) | `labels._layering must be "merge" or "replace"; got a string that is neither` |
| An unknown `_layering` value at the file's top level (`_layering: union`) | `_layering must be "merge" or "replace"; got a string that is neither` |
| A YAML anchor aliased inside its own node (`repository: &loop {self: *loop}`) | `the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees` |

## Where to go next

[Multi-repo mode](multi-repo.md) explains how a `defaults-file` is a fallback for repositories without a settings file, not a layer. [The undeclared policy](../reference/undeclared-policy.md) owns the `_undeclared` knob the merged file resolves. [Architecture](../reference/architecture.md) shows where the fold sits in the pipeline.
