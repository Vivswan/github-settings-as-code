# The undeclared policy

Five sections list the live resources sitting next to the declared ones:
`labels`, `autolinks`, `collaborators`, `rulesets`, and `milestones`. Each
has a default answer for a live resource the settings file does not
declare, and each accepts a wrapped form that overrides it per file. This
page covers the knob, the defaults per section, and how it layers with a
multi-repo defaults file. The normative claims live in the README's
[Sections table](../README.md#sections) and
[Undeclared resources](../README.md#undeclared-resources) section.

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
| `rulesets` | keep | `delete`: make the file the complete ruleset inventory |
| `milestones` | keep | `delete`: prune stale milestones, with the caveat below |

The owner exemption for collaborators does not move with the knob: under
`undeclared: delete` (the default) every undeclared direct collaborator is
removed except the repository owner.

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

There is no way to set a policy without declaring an inventory - a
defaults wrapper requires `entries`, and `entries: []` is itself a
declaration: a
defaults-file section applies to every target the run processes, including
targets whose settings file omits the section entirely - that is what a
defaults file is. (A repository with no settings file at all is skipped
outright, defaults included, and reported as skipped - the defaults never
reach it.) So `entries: []` under a policy declares an empty
inventory fleet-wide. With `undeclared: keep` that only produces notes;
with `undeclared: delete` it deletes every eligible resource on every
processed target that does not declare the section itself. To harden a
fleet's policy to delete, declare the fleet's entries in the same defaults
section, so omitting targets keep them. A check run shows the resulting
deletions as drift before an apply performs them.

One boundary to know about: the policy is a property of these five
top-level section lists only. Nothing else inherits it - not other
sections, and not anything nested inside them.
