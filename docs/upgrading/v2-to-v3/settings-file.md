---
order: 2
title: "Settings-file keys and directives"
---

# Upgrading from v2 to v3: settings-file keys and directives

Sections 2, 16, 32, and 53 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 2. undeclared becomes _undeclared

Every list section wrapper, and every nested one (`environments[].variables`, `environments[].secrets`, `environments[].deployment_branch_policies`, `environments[].deployment_protection_rules`), spells the knob `_undeclared`.

```yaml settings
labels:
  _undeclared: keep
  entries:
    - name: bug
      color: "d73a4a"
```

The old spelling fails validation before any section runs, so a check run finds every stale file at once. A v2 `labels` wrapper in `.github/settings.yml` produces this error:

```text
.github/settings.yml has malformed section entries: labels: Unrecognized key: "undeclared"; the wrapper's policy key "undeclared" was renamed to "_undeclared" in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete. Fix these values in the settings file (only the named keys are validated; extra fields pass through, except in closed sections and strict nested objects like actions.cache, which reject unrecognized keys)
```

The underscore marks the action's directives: `_undeclared` (live axis), `_layering` (merge time), and `_remove` (merge time, on one keyed entry), and nothing else ([section 16](#16-underscore-keys-are-directives-never-notes)). The [undeclared policy](../../reference/undeclared-policy.md) page owns the knob.

## 16. Underscore keys are directives, never notes

v2 dropped any unknown top-level key starting with `_` as a private note, while rejecting the same key inside a section's `{entries}` wrapper.

v3 has one rule at the top level and on the wrappers: the underscore belongs to the three directives, and any other underscore key there fails validation before any section runs. Each directive has its place: `_layering` at the top level or on a list section's wrapper, `_undeclared` at the top level or on a knobbed wrapper ([section 32](#32-file-wide-_undeclared-and-the-undeclared-input)), and `_remove: true` on a keyed list entry ([section 31](layering.md#31-null-wins-and-means-empty-and-_remove-drops-an-entry)).

A directive out of its place is refused like any unknown key: `{name: bug, _remove: true}` drops an entry, while a top-level `_remove: true` or `labels: {_remove: true, entries: []}` fails validation. A removal also needs a fold to act in: in a single document (a one-file apply or check) it fails validation naming its site, since there is no lower layer to remove from.

```yaml settings
# owner: platform-team, see runbook RB-112
labels:
  - name: bug
    color: "d73a4a"
```

A v2 file with `_owner: platform-team` at its top level now fails with this line in the collected list (abbreviated):

```text
settings.yml has malformed section entries: unknown underscore key: _owner. The underscore marks this action's directives, "_layering" (...) and "_undeclared" (...), and nothing else; there are no private-note keys. Remove the key, or keep the note as a YAML comment (...)
```

A `sections` allowlist does not soften it (an unknown plain section outside the allowlist still only warns). The reason is the loud-failure promise: a misspelled `_layerin: replace` dropped as a note would merge a layer its author meant to replace.

Move each note into a YAML comment; the [layering guide](../../operate/layering.md#four-knobs) states the rule beside the directives.

## 32. File-wide _undeclared and the undeclared input

The policy no longer has to be repeated on every wrapper:

```text
pre-release   labels:
                _undeclared: delete
                entries: [...]
              milestones:
                _undeclared: delete
                entries: [...]
              webhooks:
                _undeclared: delete
                entries: [...]

v3            _undeclared: delete          # every knobbed section of this file, unless its wrapper says otherwise
              labels: [...]
              milestones: [...]
              webhooks:
                _undeclared: keep          # the wrapper wins for this one section
                entries: [...]
```

The run input `undeclared` (`keep` or `delete`, unset by default) sets the same default for every file an apply, check, or render reads; `mode: snapshot` rejects it. The precedence, highest first: the list's wrapper, then the file's top-level `_undeclared`, then the `undeclared` input, then the list's own default the [undeclared policy](../../reference/undeclared-policy.md) page lists.

A wrong value is refused before any section runs, one line in the collected list (abbreviated):

```text
settings.yml has malformed section entries: _undeclared must be one of "keep", "delete"; got a string that is none of them. Write _undeclared: keep or _undeclared: delete at the top of the file, or remove the key so each list's own policy applies (...)
```

A file-wide `delete` reaches the nested `environments[].deployment_protection_rules` list too: an undeclared deployment gate is disabled, where the nested default is `keep`. Set the nested wrapper to `keep` on the environment that must keep its gates.

One v2 file breaks: a top-level `_undeclared` that v2 dropped as a private note ([section 16](#16-underscore-keys-are-directives-never-notes)) is now the file-wide policy, so a `delete` note deletes the undeclared entries of every knobbed section on the first apply. Run `mode: check` first; the deletions appear there as drift. A file that set every wrapper by hand behaves as before, and a wrapper still beats every default.

The render consumes the top-level key and writes the resolved policy onto every knobbed wrapper, an environment's nested lists included, so a rendered document always carries those nested lists in wrapper form.

## 53. YAML merge keys resolve

```text
v2   labels:
       - &base
         name: bug
         color: ff0000
         description: Something broken
       - <<: *base
         name: defect
     -> the second label as parsed: {"<<": {"name": "bug", ...}, "name": "defect"}; the "<<" field rode into the create payload

v3   -> the second label as parsed: {"name": "defect", "color": "ff0000", "description": "Something broken"}
```

Every reader (single file, layers, central file, defaults file, the CLI) parses through one function, so `<<` resolves the way the Probot Settings app's parser did. Nothing to fix; a file that leaned on the literal `<<` key reaching GitHub had a 422 waiting.
