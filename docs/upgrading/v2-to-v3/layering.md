---
order: 3
title: "Layering and the render step"
---

# Upgrading from v2 to v3: layering and the render step

Sections 3, 24, 28, 29, 30, and 31 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 3. Layering only in mode: render

If a v2 setup relied on the defaults merge for anything beyond "no file, use the defaults", it becomes a two-step workflow: a `mode: render` step folds the layers into `rendered-file`, and the apply or check step runs that file. The [layering guide](../../operate/layering.md) has the rules, the worked example, and the workflow.

The fold is not the v2 merge. Three differences to audit when you rebuild an old overlay:

| In v2's defaults merge | In a `mode: render` fold |
|---|---|
| Lists always replaced: a target's `labels` replaced the defaults' | Every list section unions by its key under the default `layering: deep` ([section 28](#28-_layering-takes-replace-shallow-or-deep)); set `layering: replace` (or `_layering: replace` on the section) to keep the old replacement |
| A nested `null` in the target survived as a value (`pages.cname: null` removed the domain) | The same: `null` wins and is written as the value, the empty or off state on GitHub. A key with no empty state refuses it at validation ([section 31](#31-null-wins-and-means-empty-and-_remove-drops-an-entry)) |
| A `null` section in the target opted out of the defaults' section | Only `pages: null` and `interaction_limits: null` are legal, and they turn the site or the limit off rather than opting out; any other whole-section `null` fails validation. To drop a lower entry, write `_remove: true` on it |

## 24. The rendered file is the fold in the canonical order

The document `mode: render` writes, and `mergeSettings` returns as `yaml`, is the fold in one canonical order:

```text
pre-release   repository:                  # zod's order: the schema declares enable_vulnerability_alerts first
                enable_vulnerability_alerts: true
                has_issues: true

v3            repository:                  # the canonical order: declared keys as the schema lists them, then the rest by code point
                enable_vulnerability_alerts: true
                has_issues: true
```

The written file is the fold in the canonical order every rendered document shares ([section 26](run.md#26-the-snapshot-file-is-canonical-and-undated) names the rules); validation judges the fold and never re-serializes it. A rendered file committed under a pre-release build reorders once.

Reordering keys, or the entries of a sorted list, in a layer changes nothing in the file. `branches`, the pinned environments, `bypass_actors`, `reviewers`, and scalar lists keep their written order, since it is content.

## 28. _layering takes replace, shallow, or deep

Two layers, one `bug` label declared in both. What the rendered file holds under each `_layering` value:

```text
fleet.yml (lower)         labels:
                            - name: Bug
                              color: d73a4a
                            - name: docs
                              color: "0075ca"

repo.yml (higher)         labels:
                            - name: bug
                              description: mine

layering: replace         labels:                      # the higher list wins
                            _undeclared: delete        # the section default, resolved onto the rendered wrapper
                            entries:
                              - name: bug
                                description: mine

layering: shallow         labels:                      # union by name (case-folded); the same-name entry is swapped
                            _undeclared: delete
                            entries:
                              - name: bug
                                description: mine
                              - name: docs
                                color: "0075ca"

layering: deep (default)  labels:                      # union by name; the same-name pair merges field by field
                            _undeclared: delete
                            entries:
                              - name: bug
                                color: d73a4a
                                description: mine
                              - name: docs
                                color: "0075ca"
```

Every list section folds this way, by the key its planner matches on: labels, collaborators, teams, and environments case-folded; the secret and variable families uppercased; workflow paths as GitHub lists them; the rest verbatim (a ruleset's `rules` by `type` inside a deep pair). The pre-release builds unioned labels and rulesets only and replaced the other seventeen silently, the three plain lists of [section 30](#30-environments-branches-and-workflows-layer-by-key) among them.

The value `merge` is gone. `labels: {_layering: merge, entries: [...]}` fails with `labels._layering must be one of "replace", "shallow", "deep"; got a string that is none of them`, and the `layering` input refuses it too, naming the same three values.

Fix: write `deep` where a layer said `merge`, and `_layering: replace` on any list section a higher layer meant to replace whole. Under `shallow` and `deep` an empty higher list adds nothing; clearing a list takes `replace` with an empty list. The [layering guide](../../operate/layering.md#four-knobs) owns the rules.

## 29. mode: merge is mode: render

```text
pre-release   with:
                mode: merge
                settings-file: |
                  fleet.yml
                  repo.yml
                merged-file: rendered.yml

v3            with:
                mode: render
                settings-file: |
                  fleet.yml
                  repo.yml
                rendered-file: rendered.yml
```

| Face | Pre-release | v3 |
|---|---|---|
| The mode | `mode: merge` | `mode: render` |
| The output input | `merged-file` | `rendered-file` |
| The CLI subcommand | `gsac merge` | `gsac render` |
| The result word (`result` output, `--json`, `RUN_RESULTS`) | `merged` | `rendered` |
| Problem codes | `input-merge-only`, `input-rejected-in-merge`, `input-merged-file-missing`, `merged-file-is-layer`, `merged-file-unwritable` | `input-render-only`, `input-rejected-in-render`, `input-rendered-file-missing`, `rendered-file-is-layer`, `rendered-file-unwritable` |
| The library flow | `runMerge`, `MergeConfig`, `FinishedMerge`, `concludeMerge` | `runRender`, `RenderConfig`, `FinishedRender`, `concludeRender` |

`mode: merge` fails as an unsupported mode value, naming the four modes. There is no alias: rename the mode, the input, and the subcommand together, and a step that branches on `result == 'merged'` tests `rendered`. The library keeps `mergeSettings`, `MergeOptions`, and `MergeReport`, which name the fold, not the mode.

## 30. environments, branches, and workflows layer by key

Two layers, one `prod` environment, one `main` branch, one workflow each:

```text
fleet.yml (lower)   environments:
                      - name: prod
                        wait_timer: 5
                        variables:
                          - name: REGION
                            value: eu-west-1
                    branches:
                      - name: main
                        protection:
                          enforce_admins: true
                    workflows:
                      - path: nightly.yml
                        state: active

repo.yml (higher)   environments:
                      - name: Prod
                        variables:
                          - name: TIMEOUT
                            value: "30"
                    branches:
                      - name: main
                        protection:
                          required_signatures: true
                    workflows:
                      - path: ci.yml
                        state: disabled
```

The pre-release fold replaced all three lists whole, so the fleet's wait timer, `REGION`, `enforce_admins`, and `nightly.yml` were gone. Under v3's default `deep` they union like every other list section:

```text
rendered   environments:
             - name: Prod
               wait_timer: 5
               variables:
                 - name: REGION
                   value: eu-west-1
                 - name: TIMEOUT
                   value: "30"
           branches:
             - name: main
               protection:
                 required_signatures: true
                 enforce_admins: true
           workflows:
             - path: ci.yml
               state: disabled
             - path: nightly.yml
               state: active
```

Environment names fold case-insensitively, branch names verbatim, workflow paths as GitHub lists them. An environment's nested lists union by their own keys: `variables` and `secrets` by uppercased name, `deployment_branch_policies` by name, `deployment_protection_rules` by app, `reviewers` by type and id.

Each of the three accepts a `{_layering, entries}` wrapper, which the render consumes; the rendered file holds the bare list. `_layering: replace` on the wrapper keeps the old outcome. The wrapper takes no `_undeclared`, since these sections apply no undeclared policy.

The nested `variables` list renders bare above because both layers wrote it bare; the file-wide `_undeclared` of [section 32](settings-file.md#32-file-wide-_undeclared-and-the-undeclared-input) arrives separately and makes the render write every nested knobbed list in wrapper form, its resolved `_undeclared` spelled out.

## 31. null wins and means empty, and _remove drops an entry

The fold is a cascade: the higher layer's value wins at every depth, and `null` is a value like any other. Our `null` is the EMPTY or OFF state on GitHub, never a marker that deletes a lower key.

```text
fleet.yml (lower)   labels:
                      - name: bug
                        color: d73a4a
                      - name: wontfix
                        color: ffffff
                    branches:
                      - name: main
                        protection:
                          enforce_admins: true
                    pages:
                      build_type: workflow
                      source:
                        branch: main
                        path: /

repo.yml (higher)   labels:
                      - name: wontfix
                        _remove: true
                    branches:
                      - name: main
                        protection: null
                    pages: null

rendered            labels:
                      _undeclared: delete
                      entries:
                        - name: bug
                          color: d73a4a
                    branches:
                      - name: main
                        protection: null           # apply strips the protection
                    pages: null                    # apply turns Pages off
```

The removal drops `wontfix` and is consumed, with one notice:

```text
notice: repo.yml: labels[0] carries _remove: true and dropped the entry a lower layer declared under its key
```

Where GitHub has no empty state, a `null` is the layer's own error, naming the values that exist. So is a whole-section `null` outside `pages` and `interaction_limits`:

```text
error: bad.yml has malformed section entries: repository.enable_git_lfs has no empty state; write true or false; labels: null has no meaning; remove the section or declare its entries. ...
```

The pre-release fold read a higher `null` as "delete the lower key" with a notice, and dropped a top-level `null` that met nothing. Both readings are gone: every `null` that won its key is in the rendered file, and validation refused every one a key does not admit. `_undeclared: null` is refused the same way; omit the key to inherit the lower policy.

`_remove: true` is refused where nothing meets it: under `replace`, inside an entry copied whole (a new key, or a shallow swap), when no lower layer declares the key, or beside any field other than the entry's key. The [layering guide](../../operate/layering.md#the-rules) lists each refusal.

The destructive-write caveat: a `null` written to mean "stop managing this" gets the empty state instead.

```text
fleet.yml   repository:
              description: Shared project description
            branches:
              - name: main
                protection:
                  required_status_checks:
                    strict: true
                    contexts: [ci]

local.yml   repository:
              description: null                    # apply sends {"description": null}: the description is cleared
            branches:
              - name: main
                protection:
                  required_status_checks: null     # apply removes the required checks
```

Both layers validate, since GitHub accepts `null` on those keys. Never write `null` for "leave it alone".

To stop managing a key, omit it from every layer; a live ruleset or environment key then needs a declared or empty value instead ([section 33](run.md#33-apply-refuses-over-omitted-live-values)). To drop a keyed entry, write `_remove: true`. To clear a list, write `_layering: replace` with an empty list.
