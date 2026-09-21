---
order: 250
---

# Layering settings files

`mode: render` folds an ordered list of settings files into one settings document and writes it to a file. Apply and check never merge: each takes exactly one final document per target. So layering is a two-step workflow: a render step, then an apply or check step on the written file.

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

`mode: render` over the two writes this document, which apply then runs:

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

## Inputs in mode: render

| Input | In `mode: render` |
|---|---|
| `mode` | `render` |
| `settings-file` | The ordered list of layer paths, newline- or comma-separated, lowest layer first |
| `rendered-file` | Required: where the rendered document is written (parent directories are created). It must not name one of the `settings-file` layers, compared as resolved paths: the run refuses that, naming the layer's position, because the render would overwrite the layer and the next run would fold the rendered document as one |
| `layering` | `replace`, `shallow`, or `deep` (default): the run-wide default for how every list section's entries combine, see below |
| `token` | Ignored: a render makes no GitHub API call, so a token a workflow sets on every step does no harm |
| `repository`, `repos`, `repos-dir`, `defaults-file`, `snapshot-file`, `snapshot-dir`, `visibility`, `archived`, `forks`, `exclude`, `topics`, `affiliation`, `sections`, `required-sections`, `on-missing-permission`, `api-version`, `private-repos`, `private-report`, `report-public-key` | Rejected when set to a non-default value: a render addresses no repository, fleet, or report, calls no API, and writes every section its layers declare; a `sections` allowlist belongs on the step that runs the rendered document |

The step ends with `result: rendered` and exit 0, or exit 1 with an error naming the layer that was refused.

## Three knobs

| Knob | Where | Axis | Meaning |
|---|---|---|---|
| `layering` | The action input | Merge time | Run-wide default for how a list section combines with the layers below it: `deep` (default) unions the entries by the section's key and merges a same-key pair field by field, `shallow` unions and swaps a same-key entry for the higher one, `replace` lets the higher list win |
| `_layering` | A list section's `{entries}` wrapper, or a file's top level | Merge time | Overrides `layering` for that section, or for every section of that file. Consumed by the render: the rendered file never carries it. The wrapper of a section without an undeclared policy (`environments`, `branches`, `workflows`) takes this one key beside `entries`, and the rendered file holds its bare list |
| `_undeclared` | A knobbed list section's `{entries}` wrapper | Live state | What apply does to live resources the document does not declare: `keep` or `delete`. Travels through the render and is resolved in the rendered file. The [undeclared policy](../reference/undeclared-policy.md) page owns it |

The underscore marks this action's directives, never a GitHub setting, and each location takes a fixed set. A file's top level takes `_layering`; a knobbed section's wrapper takes `_layering` and `_undeclared`; a plain-list wrapper (`environments`, `branches`, `workflows`) takes `_layering` alone.

Any other underscore key at any of these locations fails validation with an error naming which directive belongs where (a note belongs in a YAML comment). A misspelled directive can therefore never pass as a private note and quietly merge a layer meant to replace.

## The rules

Layers fold low to high. At each step the higher layer's value meets whatever the lower layers built so far.

| Higher layer | Over | Result |
|---|---|---|
| A mapping | A mapping | Merged key by key. Lower keys keep their order, higher-only keys follow |
| A scalar, a list, or a YAML-tagged value | Anything | Replaces |
| `null` (at any depth) | A declared value | Deletes the key, with a notice naming the layer and the path, except on `pages` and `interaction_limits`, where `null` is the section's value and is written as such, with no notice. Inside a list section's entry the deletion holds under `deep` only: under `shallow` and `replace` the entry is copied as written, so a `null` there is a value the section must accept. A field the entry's schema types nullable (`custom_properties[].value`, where `null` unsets the property; `branches[].protection`, where it removes the protection; `environments[].deployment_branch_policy`) is a value under every directive, never a marker |
| `null` | Nothing, or another `null` | Below the top level, stays as written. At the top level it opted out of nothing and drops with no notice, except on `pages` and `interaction_limits`, where `null` is the section's value and stays (`pages: null` still means "disable Pages") |
| A list section's entries, layering `deep` | Its entries | Union by the section's key (the table below). A same-key pair merges field by field, the higher fields winning, in the lower entry's place; a nested keyed list (a ruleset's `rules` by `type`, an environment's `variables` by name) unions the same way under `deep`, its same-key pairs merging field by field too, in its bare or `{_undeclared, entries}` form alike (a lower wrapper's policy is inherited by a higher bare list); new keys are appended in the higher order |
| A list section's entries, layering `shallow` | Its entries | Union by the section's key. A same-key entry is swapped for the higher one in place, new keys are appended |
| A list section's entries, layering `replace` | Its entries | The higher list wins. An omitted `_undeclared` still inherits the lower layer's |
| Any other list (`topics`, a ruleset's `bypass_actors`, `check_suite_preferences.auto_trigger_checks`, ...) | A list | Replaces, whatever the run's layering |

Under `shallow` and `deep` an empty higher list adds nothing. To clear a list, write `_layering: replace` with an empty list.

Every list section layers by the key its planner matches entries by, folded the same way. The sixteen the [undeclared policy](../reference/undeclared-policy.md) counts take `_layering` beside `_undeclared`; `environments`, `branches`, and `workflows` take it in a `{_layering, entries}` wrapper of their own, which the render unwraps to the bare list:

| Section | Key | Folded |
|---|---|---|
| `labels` | `name` (a renaming entry also claims its `new_name`) | case-insensitive |
| `collaborators` | `username` | case-insensitive |
| `teams` | `name` | case-insensitive |
| `actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, `agents_secrets` | `name` | uppercased, as GitHub stores it |
| `actions_variables`, `agents_variables` | `name` | uppercased, as GitHub stores it |
| `rulesets` | `name`; its `rules` by `type` | verbatim |
| `environments` | `name`; its `variables` and `secrets` by `name` (uppercased), `deployment_branch_policies` by `name`, `deployment_protection_rules` by `app`, `reviewers` by `type` and `id` | case-insensitive |
| `branches` | `name` (a branch or a wildcard pattern) | verbatim |
| `workflows` | `path` (a bare file name and its `.github/workflows/` path are one workflow) | as GitHub lists it |
| `autolinks` | `key_prefix` | verbatim |
| `milestones` | `title` | verbatim |
| `webhooks` | `config.url` | verbatim |
| `custom_properties` | `property_name` | verbatim |
| `deploy_keys` | `title` | verbatim |
| `secret_scanning_custom_patterns` | `name` | verbatim |

So a fleet `Bug` and a repository `bug` are one label, a fleet `MY_SECRET` and a repository `my_secret` are one secret, and a fleet `Prod` environment and a repository `prod` are one environment, their variables unioned by name. When the spellings differ, the higher layer's spelling is the one written, under every directive.

Within one layer two entries may not share a key, at any depth; the fold refuses that layer (see [Refusals](#refusals)).

Under `shallow` a same-key entry is swapped whole, its nested lists with it: only `deep` enters an entry, so only `deep` unions an environment's variables with the fleet's.

Under `deep` a lower entry that two higher entries both claim (a lower label renaming into a name one higher entry declares while another declares its old name) is superseded by both as written: only a one-to-one pair merges field by field, so the rendered document never carries two entries claiming one key.

The rules above decide the content. The written file's order is the canonical one every rendered document has, the same order `mode: snapshot` writes:

- sections in the order the action applies them
- keys as the schema declares them
- the entries of every keyed list sorted by their identity

Reordering keys, or the entries of a keyed list, in a layer changes nothing in the rendered file. The lists kept as written do change it:

- `branches`: GitHub applies overlapping wildcard rules in creation order, so the union keeps the lower order and appends
- the `pinned: true` environments: their order is the pin rank
- `bypass_actors`, the mapping list with no layering identity, so a higher list replaces the lower one and never unions with it (the planner still pairs actors by `actor_type` plus `actor_id` for its drift lines); `reviewers` is not kept as written, since the fold unions it by type and id
- every scalar list: `topics`, `include` patterns

The `_undeclared` knob across layers:

- A plain list, or a bare `{entries}` wrapper, inherits the policy a lower layer set.
- An explicit higher `_undeclared` wins.
- After the fold, a section that still has no explicit policy takes the section default, so the rendered file is self-describing.

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

Rendered under the default `layering: deep`, the written file is:

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
- `docs` kept its position and took the higher color; under `deep` a same-key pair merges field by field, so a lower-only field would have survived too.
- The `main` ruleset kept `target` and `enforcement` from the fleet and gained a rule.
- Both list sections came out in wrapper form with their section default filled in.

## What the rendered file looks like

The rendered file is exactly what apply runs, so it is worth knowing its shape:

- Every list section that takes the `_undeclared` knob (the sections the [undeclared policy](../reference/undeclared-policy.md) counts in its opening sentence) is in its `{_undeclared, entries}` wrapper form, with `_undeclared` resolved to an explicit `keep` or `delete`.
- `environments`, `branches`, and `workflows` are bare lists: their wrapper carried only `_layering`, which the render consumed. A nested per-environment list is written as the higher entry declared it, except where `deep` merged a pair through it: then a wrapper on either side keeps the wrapper form.
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
          mode: render
          settings-file: |
            .github/settings/fleet.yml
            .github/settings/team.yml
            .github/settings/repo.yml
          rendered-file: .github/settings/rendered.yml
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          settings-file: .github/settings/rendered.yml
```

Swap the second step to `mode: check` to preview what the rendered document would change. The render step is the same either way.

Commit the rendered file only if you want to review it in pull requests; the step rewrites it on every run.

## Validation per layer

Each layer must be a valid settings document on its own, judged after its `null` markers are removed. So a layer may say `labels: null`, or `rulesets: [{name: main, bypass_actors: null}]` under `deep`, the one directive that opens an entry; under `shallow` or `replace` the same `bypass_actors: null` is copied as written and fails the layer's validation, since the section takes no null there.

Whatever a standalone settings file may not say, a layer may not say either:

- An unknown top-level section, a misspelled wrapper key, or a wrong shape in a closed section fails the render step, naming the layer, before any fold happens.
- Fields the validator passes through to GitHub (a misspelled `repository` key, say) pass through here too.

The render can never complete a broken declaration into a valid one.

## Refusals

Two gates refuse a layer, in this order. Each error names the layer.

The per-layer validation catches what a standalone settings file could not say, with the same messages a standalone file gets:

| The layer has | Caught by |
|---|---|
| A list section that is not a list or an `{entries}` wrapper (`labels: oops`) | Validation: `labels: Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_undeclared" policy), but this section parsed as string` |
| A plain-list section that is neither, named with the one directive its wrapper takes (`environments: oops`) | Validation: `environments: Invalid input: expected a list of entries, or a mapping with "entries" (and an optional "_layering" directive), but this section parsed as string` |
| The policy on a plain-list wrapper (`environments: {_undeclared: keep, entries: []}`) | Validation: `environments: Unrecognized key: "_undeclared"; the wrapper's directives are "_layering" alone (this section applies no undeclared policy, so its wrapper takes no "_undeclared"), and nothing else - there are no private-note keys. Remove the key, or keep the note as a YAML comment` |
| A keyed entry without its key, here a label with no `name` (`labels: [{name: bug}, {color: d73a4a}]`) | Validation: `labels[1].name: Invalid input: expected string, received undefined` |
| A non-mapping entry (`milestones: [v2]`) | Validation: `milestones[0]: Invalid input: expected object, received string` |
| An underscore key that is not a directive on a wrapper (`labels: {_notes: x, entries: [{name: bug}]}`) | Validation: `labels: Unrecognized key: "_notes"; the wrapper's directives are "_undeclared" and, on a top-level section, "_layering", and nothing else - there are no private-note keys. Remove the key, or keep the note as a YAML comment` |

The fold itself refuses what only the fold can judge (`layer ".github/settings/repo.yml": ...`). A fold refusal names the key path (entries by index) and the kind of problem, never a value from the document: the render runs without a repository's redaction context, so a label name or rule type echoed here could put a private repository's settings into a public log.

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
  - `environments` entries, by name: `environments[0].deployment_branch_policies: the "prod" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy`.
  - `actions.selected_actions`, repeating the declared `allowed_actions`, which has already passed its enum, so only `all`, `local_only`, or `selected` can appear: `actions.selected_actions: selected_actions is declared together with allowed_actions: "all", but an allowlist only applies under allowed_actions: "selected"`.
- A `branches` control declared as a scalar where a mapping belongs, on a literal branch and a wildcard entry alike, naming the key and nothing of the value:
  `branches[0].protection.required_status_checks: required_status_checks must be a mapping of its keys (strict, then contexts or checks), or null to turn the requirement off`.
- A YAML syntax error, quoting the offending source line with a caret under the column; an unresolved alias names the alias instead, and an anchor whose name carries whitespace or a control character prints that name after `Anchor must not contain whitespace or control characters:`.
- A YAML parser warning (an unresolved tag, an unknown directive, an ambiguous anchor, a collection used as a key) prints nothing: the parser runs with its warnings off, so such a document parses silently to the same object it always did, and only a parse failure reaches the log, printing what the bullet above describes.

A render-mode log can therefore show your settings file's structure and, through these messages, a value from it: treat it like any log that prints a parse error for a file the runner holds.

| The layer has | The fold says |
|---|---|
| Two entries under one key in one list (`labels: [{name: bug}, {name: docs}, {name: Bug}]`) | `labels[0] and labels[2] both claim one name; each name belongs to one entry within a layer` |
| Two rules of one type in one ruleset (`rulesets: [{name: main, rules: [{type: deletion}, {type: deletion}]}]`) | `rulesets[0].rules[0] and rulesets[0].rules[1] both claim one type; each type belongs to one entry within a layer` |
| Two milestones under one title in one list (`milestones: [{title: v1}, {title: v1, state: closed}]`) | `milestones[0] and milestones[1] both claim one title; each title belongs to one entry within a layer` |
| Two variables of one environment under one uppercased name, in either form (`environments: [{name: prod, variables: {entries: [{name: region, value: eu}, {name: REGION, value: us}]}}]`) | `environments[0].variables[0] and environments[0].variables[1] both claim one name; each name belongs to one entry within a layer` |
| A workflow named by its file and its path in one list (`workflows: [{path: ci.yml, state: active}, {path: .github/workflows/ci.yml, state: disabled}]`) | `workflows[0] and workflows[1] both claim one path; each path belongs to one entry within a layer` |
| An unknown `_layering` value on a wrapper, the retired `merge` included (`labels: {_layering: merge, entries: [{name: bug}]}`) | `labels._layering must be one of "replace", "shallow", "deep"; got a string that is none of them` |
| An unknown `_layering` value at the file's top level (`_layering: union`) | `_layering must be one of "replace", "shallow", "deep"; got a string that is none of them` |
| An unknown `_layering` value on a plain-list wrapper (`environments: {_layering: union, entries: []}`) | `environments._layering must be one of "replace", "shallow", "deep"; got a string that is none of them` |
| A YAML anchor aliased inside its own node (`repository: &loop {self: *loop}`) | `the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees` |

## Where to go next

[Multi-repo mode](multi-repo.md) explains how a `defaults-file` is a fallback for repositories without a settings file, not a layer. [The undeclared policy](../reference/undeclared-policy.md) owns the `_undeclared` knob the rendered file resolves. [Architecture](../reference/architecture.md) shows where the fold sits in the pipeline.
