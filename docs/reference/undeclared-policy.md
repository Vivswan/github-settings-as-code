---
order: 150
---

# The undeclared policy

<!-- BEGIN GENERATED: policy-count-sentence (bun run build:action-docs; derived from UNDECLARED_POLICY_SECTIONS) -->
Fifteen sections list the live resources sitting next to the declared ones: `labels`, `autolinks`, `collaborators`, `actions_variables`, `agents_variables`, `rulesets`, `actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, `agents_secrets`, `milestones`, `webhooks`, `custom_properties`, `deploy_keys`, and `secret_scanning_custom_patterns`.
<!-- END GENERATED: policy-count-sentence -->

Each has a default answer for a live resource the settings file does not declare, and each accepts a wrapped form that overrides it per file. This page is the normative statement of that policy: the knob, the defaults per section, and how it travels through a layered merge. The [Sections table](sections.md) states each section's default in its Undeclared default column; this page says what the defaults mean and how to change them.

## The two forms

The plain array form is unchanged and keeps the section's default policy (in a layered merge a lower layer can set the policy instead - see [layering in mode: merge](#layering-in-mode-merge) below):

```yaml settings
labels:
  - name: bug
    color: "d73a4a"
```

The wrapped form names the policy explicitly. `entries` holds exactly what the array form would, and a wrapper that omits `_undeclared` behaves exactly like the plain array (the section default, or a policy inherited from a lower layer, applies):

```yaml settings
labels:
  _undeclared: keep
  entries:
    - name: bug
      color: "d73a4a"
```

`_undeclared: delete` removes live resources the file does not declare; `_undeclared: keep` leaves them alone and surfaces each one as a note in the run log, so nothing disappears from view. In check mode, a resource a delete policy would remove is reported as drift; under keep it stays a note.

The wrapper takes only `_undeclared`, `entries`, and (on a top-level section) the `_layering` merge directive. Unlike entry fields, which pass through to GitHub, these keys are this action's own vocabulary, so a misspelled wrapper key fails validation before anything is written. The directives wear the underscore: `_undeclared` and `_layering` steer this action, `entries` is what GitHub gets.

Before v3 the policy key was spelled `undeclared`. A file still writing it fails validation with an error that names `_undeclared` as the replacement; there is no compatibility alias.

## Defaults per section

<!-- BEGIN GENERATED: policy-defaults-table (bun run build:action-docs; edit .github/scripts/gen-action-docs.ts) -->
| Section | Default | The override buys you |
|---|---|---|
| `labels` | delete (Probot parity) | `keep`: manage a core set without deleting ad-hoc labels |
| `autolinks` | delete | `keep`: declare some references, tolerate the rest |
| `collaborators` | delete (owner always exempt) | `keep`: manage listed people without removing others |
| `actions_variables` | delete | `keep`: declare the managed variables, tolerate the rest |
| `agents_variables` | delete | `keep`: declare the managed variables, tolerate the rest |
| `rulesets` | keep | `delete`: make the file the complete ruleset inventory |
| `actions_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `dependabot_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `codespaces_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `agents_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `milestones` | keep | `delete`: prune stale milestones, with the caveat below |
| `webhooks` | keep (integrations create their own hooks) | `delete`: make the file the complete hook inventory |
| `custom_properties` | keep (an unset can revert to an org default the file does not model) | `delete`: make the file the complete property-value inventory, unsetting the rest |
| `deploy_keys` | keep (deployment tooling installs its own keys, and deleting a live key breaks whatever authenticates with it) | `delete`: make the file the complete key inventory |
| `secret_scanning_custom_patterns` | keep | `delete`: prune stale patterns - the pattern's alerts are resolved (never deleted), keeping the audit trail |
<!-- END GENERATED: policy-defaults-table -->

The owner exemption for collaborators does not move with the knob: under `_undeclared: delete` (the default) every undeclared direct collaborator is removed except the repository owner.

## The nested variables, secrets, and deployment knobs

Four lists carry the same wrapped form WITHOUT being top-level sections. Each environment entry's list accepts the plain array or `{_undeclared, entries}`, with its own fixed default:

| Nested list | Default | Why |
|---|---|---|
| `environments[].variables` | delete | The file is that environment's variable inventory |
| `environments[].deployment_branch_policies` | delete | Patterns are readable, recreatable configuration |
| `environments[].secrets` | keep | Matches the top-level secret sections: a deleted secret's value is unrecoverable, so deletion stays opt-in |
| `environments[].deployment_protection_rules` | keep | GitHub Apps can enable themselves as deployment gates; silently disabling a gate the file never named would weaken a protection nobody asked to weaken, so `_undeclared: delete` opts in |

The knob is set per environment entry, and it never inherits a policy through a layered merge. The `environments` list replaces wholesale in the fold, so a higher layer that declares `environments` replaces the whole lower list; individual entries never merge, and neither do the knobs inside them.

## Deleting milestones detaches issues

Deleting a milestone does not delete the issues in it; it detaches the milestone from every issue that carried it, and there is no undo beyond re-assigning the issues by hand. That is why milestones keep undeclared entries by default. Set `milestones: {_undeclared: delete, ...}` only when the settings file really is the complete list; the drift and change lines name the detachment every time, so a check run shows the consequence before an apply does it.

## Layering in mode: merge

In a `mode: merge` fold (the [layering guide](../operate/layering.md) owns the rules) the policy rides the section's wrapper as its own key:

- A plain list, or a bare `{entries}` wrapper, inherits the `_undeclared` a lower layer set for that section.
- An explicit higher `_undeclared` wins.
- A higher `_undeclared: null` removes the lower policy, with a notice, and the section default fills in.
- After the fold, every section that takes the knob carries an explicit policy in the merged file, so the document apply runs is self-describing.

So a fleet can set the policy once, in its lowest layer:

```yaml layer
labels:
  _undeclared: keep
  entries:
    - name: bug
      color: "d73a4a"
```

A higher layer declaring `labels: [{name: incident, color: "b60205"}]` comes out as `_undeclared: keep` over both labels (under the default `layering: merge`, which unions labels by name), and one declaring `labels: {_undeclared: delete, entries: [...]}` keeps its own delete policy.

There is no way to set a policy without declaring an inventory: a wrapper requires `entries`, and `entries: []` is itself a declaration. Under `_undeclared: keep` an empty inventory only produces notes; under `_undeclared: delete` it deletes every eligible resource on the repository. A check run shows the resulting deletions as drift before an apply performs them.

The multi-repo `defaults-file` does not merge: it is applied whole to a repository that has no settings file, so a policy in it reaches exactly those repositories (see [multi-repo mode](../operate/multi-repo.md)).

One boundary to know about: HAVING a policy and INHERITING one are different things. The top-level section lists take the policy through the fold as described above. The nested `environments[].variables`, `environments[].secrets`, `environments[].deployment_branch_policies`, and `environments[].deployment_protection_rules` lists have their own knobs, set per environment entry with their own fixed defaults - they never inherit a policy from their section, from another list, or through a merge.
