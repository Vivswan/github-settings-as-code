---
order: 20
---

# Upgrading from v2 to v3

Four breaks. One is silent (the fallback), so run `mode: check` before the first v3 apply. The changelog entry for 3.0.0 will carry the release-please footers in the [CHANGELOG](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md).

| Break | v2 | v3 | What the old form does now |
|---|---|---|---|
| `defaults-file` is a fallback | Merged under every multi-repo target; a target without a settings file was skipped | Applied whole to a target that has no settings file; a target with its own file is applied as written, never merged | No error. A target file written as a partial overlay now runs alone, and `pages: null` in it disables Pages instead of opting out of the defaults |
| The wrapper key is `_undeclared` | `labels: {undeclared: keep, entries: [...]}` | `labels: {_undeclared: keep, entries: [...]}` | Validation fails before any section runs, naming the rename; the full error is under [section 2](#2-undeclared-becomes-_undeclared) |
| Layering happens in `mode: merge` | The only merge was the defaults-file one | An ordered list of files folds in a merge step; apply and check take one final document | No error. Reach for the [two-step workflow](../operate/layering.md#the-two-step-workflow) to get merging back |
| A `settings-file` path cannot contain a comma or newline | `settings-file: settings,prod.yml` named one file | A comma or newline is a list separator in every mode | Apply and check refuse the run before reading anything (the error is under [section 4](#4-commas-and-newlines-in-a-settings-file-path)); `mode: merge` reads two layer paths |

## 1. The defaults-file fallback

Blast radius first: with `repos: "*"`, every discovered repository that has no `.github/settings.yml` now receives the whole defaults document, where v2 skipped it. A defaults file with `labels: {_undeclared: delete, entries: [...]}` deletes labels on all of them.

1. Run the fleet workflow with `mode: check` on v3 and read which targets say `applying the defaults file: the repository has no .github/settings.yml on its default branch`.
2. For each, decide: give the repository its own file, or accept the defaults as its complete settings.
3. Targets that used a partial file as an overlay on the defaults now need the full document. Build it with [layering](../operate/layering.md): the old defaults file is the lowest layer, the old target file the highest, and `merged-file` is the document the target applies.

The token also matters: a target the token cannot read Contents on fails with an error naming `Contents: read`, where v2 could mistake the denial for a missing file. Grant the permission or drop the target from `repos`.

The [multi-repo guide](../operate/multi-repo.md) owns the rule.

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

The underscore marks the action's directives: `_undeclared` (live axis) and `_layering` (merge time). Other underscore keys at the top level stay private notes. The [undeclared policy](../reference/undeclared-policy.md) page owns the knob.

## 3. Layering only in mode: merge

If a v2 setup relied on the defaults merge for anything beyond "no file, use the defaults", it becomes a two-step workflow: a `mode: merge` step folds the layers into `merged-file`, and the apply or check step runs that file. The [layering guide](../operate/layering.md) has the rules, the worked example, and the workflow.

The fold is not the v2 merge. Three differences to audit when you rebuild an old overlay:

| In v2's defaults merge | In a `mode: merge` fold |
|---|---|
| Lists always replaced: a target's `labels` replaced the defaults' | `labels` and `rulesets` union by key under the default `layering: merge`; set `layering: replace` (or `_layering: replace` on the section) to keep the old replacement |
| A nested `null` in the target survived as a value (`pages.cname: null` removed the domain) | A `null` over a key a lower layer declared deletes the key from the merged document, with a notice; it only stays a value when nothing below declares it |
| A `null` section in the target opted out of the defaults' section | The same, now with a notice naming the layer and path; over nothing it keeps its engine meaning |

## 4. Commas and newlines in a settings-file path

`mode: merge` takes its layers as a newline- or comma-separated list in `settings-file`, and the separators are the same in every mode. So no settings file can be named with a comma or a newline in its path any more. v2 read `settings-file: settings,prod.yml` as one file; v3 apply refuses it:

```text
the "settings-file" input is "settings,prod.yml", which contains a list separator: apply mode reads exactly one settings file, and only mode: merge takes a newline- or comma-separated list. Name one file, or set mode: merge to fold the list into one document
```

Check mode says the same with `check mode`. The fix is a rename: move the file to a path without the separator (`settings-prod.yml`) and point `settings-file` at it.

## Order of operations

1. Rename any settings file whose path contains a comma, and rename `undeclared` to `_undeclared` in every settings file; the v2 line accepts the old spelling only, so do both together with the pin move.
2. Move the pin to `@v3` with `mode: check`.
3. Read the fallback notices and the drift; add merge steps where a target needs the old overlay behavior.
4. Switch back to apply.
