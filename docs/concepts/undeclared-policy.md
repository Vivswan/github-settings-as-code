# The undeclared policy

Thirteen sections list the live resources sitting next to the declared
ones: `labels`, `autolinks`, `collaborators`, `actions_variables`,
`rulesets`, `milestones`, `webhooks`, `custom_properties`, `deploy_keys`,
`actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, and
`secret_scanning_custom_patterns`. Each has
a default answer for a live resource the settings file does not declare,
and each accepts a wrapped form that overrides it per file. This page
covers the knob, the defaults per section, and how it layers with a
multi-repo defaults file.
The normative claims live in the README's
[Sections table](../../README.md#sections) and
[Undeclared resources](../../README.md#undeclared-resources) section.

## The two forms

The plain array form is unchanged and keeps the section's default policy
(in multi-repo mode a defaults file can set the policy instead - see
[layering](#layering-with-a-multi-repo-defaults-file) below):

```yaml settings
labels:
  - name: bug
    color: "d73a4a"
```

The wrapped form names the policy explicitly. `entries` holds exactly what
the array form would, and a wrapper that omits `undeclared` behaves exactly
like the plain array (the section default, or an inherited defaults-file
policy, applies):

```yaml settings
labels:
  undeclared: keep
  entries:
    - name: bug
      color: "d73a4a"
```

`undeclared: delete` removes live resources the file does not declare;
`undeclared: keep` leaves them alone and surfaces each one as a note in the
run log, so nothing disappears from view. In check mode, a resource a
delete policy would remove is reported as drift; under keep it stays a
note.

The wrapper takes only these two keys. Unlike entry fields, which pass
through to GitHub, `undeclared` and `entries` are this action's own
vocabulary, so a misspelled wrapper key fails validation before anything is
written.

## Defaults per section

| Section | Default | The override buys you |
|---|---|---|
| `labels` | delete (Probot parity) | `keep`: manage a core set without deleting ad-hoc labels |
| `autolinks` | delete | `keep`: declare some references, tolerate the rest |
| `collaborators` | delete (owner always exempt) | `keep`: manage listed people without removing others |
| `actions_variables` | delete | `keep`: declare the managed variables, tolerate the rest |
| `rulesets` | keep | `delete`: make the file the complete ruleset inventory |
| `milestones` | keep | `delete`: prune stale milestones, with the caveat below |
| `webhooks` | keep (integrations create their own hooks) | `delete`: make the file the complete hook inventory |
| `deploy_keys` | keep (deployment tooling installs its own keys, and deleting a live key breaks whatever authenticates with it) | `delete`: make the file the complete key inventory |
| `actions_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `dependabot_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `codespaces_secrets` | keep | `delete`: prune stale secrets - a deleted secret's value is unrecoverable |
| `custom_properties` | keep (an unset can revert to an org default the file does not model) | `delete`: make the file the complete property-value inventory, unsetting the rest |
| `secret_scanning_custom_patterns` | keep | `delete`: prune stale patterns - the pattern's alerts are resolved (never deleted), keeping the audit trail |

The owner exemption for collaborators does not move with the knob: under
`undeclared: delete` (the default) every undeclared direct collaborator is
removed except the repository owner.

## The nested variables, secrets, and deployment knobs

Four lists carry the same wrapped form WITHOUT being top-level sections:
`environments[].variables`, `environments[].secrets`,
`environments[].deployment_branch_policies`, and
`environments[].deployment_protection_rules`. Each environment entry's list
accepts the plain array or `{undeclared, entries}`, with its own fixed
default: within a declared `variables` key the default is delete (the file
is that environment's variable inventory), and the same holds for a
declared `deployment_branch_policies` key (patterns are readable,
recreatable configuration), while within a declared `secrets` key the
default is keep, matching the top-level secret sections - a deleted
secret's value is unrecoverable, so deletion stays opt-in. A declared
`deployment_protection_rules` key also defaults to keep, for a security
reason rather than an unrecoverable one: GitHub Apps can enable themselves
as deployment gates, and silently disabling a gate the file never named
would weaken a protection nobody asked to weaken - `undeclared: delete`
opts into disabling. The knob is set
per environment entry, and it never inherits a policy through the
multi-repo defaults merge: arrays replace wholesale in that merge, so a
target that declares `environments` replaces the defaults' entire
environments array - individual entries never merge, and neither do the
knobs inside them.

## Deleting milestones detaches issues

Deleting a milestone does not delete the issues in it; it detaches the
milestone from every issue that carried it, and there is no undo beyond
re-assigning the issues by hand. That is why milestones keep undeclared
entries by default. Set `milestones: {undeclared: delete, ...}` only when
the settings file really is the complete list; the drift and change lines
name the detachment every time, so a check run shows the consequence before
an apply does it.

## Layering with a multi-repo defaults file

In multi-repo mode the defaults file merges under every target the run
processes (a repository with no settings file is skipped outright, defaults
included), and the policy rides that merge as its own key:

- Entries never concatenate: a target that declares the section replaces
  the defaults' entry list wholesale, same as every other array.
- A target using the plain array form inherits the policy the defaults file
  set for that section.
- A target's explicit `undeclared` wins over the defaults'.

So a fleet can set the policy once. With this defaults file:

```yaml settings
labels:
  undeclared: keep
  entries:
    - name: bug
      color: "d73a4a"
```

a target declaring `labels: [{name: incident}]` gets `undeclared: keep`
with only its own entry, and a target declaring
`labels: {undeclared: delete, entries: [...]}` keeps its own delete policy.

There is no way to set a policy without declaring an inventory: a defaults
wrapper requires `entries`, and `entries: []` is itself a declaration. A
defaults-file section applies to every target the run processes, including
targets whose settings file omits the section entirely - that is what a
defaults file is. (A repository with no settings file at all is skipped
outright, defaults included, and reported as skipped - the defaults never
reach it.) So `entries: []` under a policy declares an empty inventory
fleet-wide. With `undeclared: keep` that only produces notes; with
`undeclared: delete` it deletes every eligible resource on every
processed target that does not declare the section itself. To harden a
fleet's policy to delete, declare the fleet's entries in the same defaults
section, so omitting targets keep them. A check run shows the resulting
deletions as drift before an apply performs them.

One boundary to know about: HAVING a policy and INHERITING one are
different things. The thirteen top-level section lists take the policy
through the multi-repo defaults merge as described above. The nested
`environments[].variables`, `environments[].secrets`,
`environments[].deployment_branch_policies`, and
`environments[].deployment_protection_rules` lists have their own knobs,
set per environment entry with their own fixed defaults - they never
inherit a policy from their section, from another list, or through the
defaults merge.
