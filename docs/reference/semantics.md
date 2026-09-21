---
order: 130
---

# Semantics

The rules every section obeys, whatever it manages: what the file itself can get wrong, what the engine compares, what it deletes, which errors can be softened, and what happens around a failure. The [Sections table](sections.md) says what each section does; this page is the model those behaviors share. Read it when you need to predict what an apply or a check will do before running it.

The engine is stateless and declared-keys-only: a key you do not declare is never touched or compared, except under the three replacing writes below, where an omitted live value is reported because the write would clear it.
There is no state file; resources are matched by their natural names. Removing a section from the file stops managing it - it does not revert anything.

Three writes carry the whole object, the ruleset PUT, the environment PUT, and the branch protection PUT, so a live value under a declared ruleset, environment, or protected branch that its entry leaves out would be removed by that write.

Check reports each one as drift naming the key (`bypass_actors`, `conditions.ref_name.exclude`, `reviewers`, `required_status_checks`).

For a ruleset or an environment, apply refuses that write: the entry fails with the same line and nothing of it is written, until the file says which is meant.

Declare the key to keep the value, or declare it empty (`bypass_actors: []`, `reviewers: []`, `deployment_branch_policy: null`) to remove it on purpose. Empty values (an empty list, a zero, false, null) never count.
A ruleset's `target` and `enforcement` never count either: an entry without them is parsed with `branch` and `active`, so a live value under either key is compared, not reported as omitted.

The sweep stops where the settings schema stops naming keys, inside `rules[].parameters` and a bypass actor's own fields, because there it cannot tell a default GitHub filled from a value the file left out.
A live `require_code_owner_review: true` beside a declared `pull_request` rule reads clean, and the PUT resets it.

Apply is convergent: re-running preserves the declared state (some sections diff first and skip converged writes, others send idempotent full-payload writes), and a check right after an apply reports clean.

## What the parse refuses

Anything the settings file alone proves wrong is refused when the file is parsed, before any section reads or writes the repository, with an error naming the key and the fix. That covers a field GitHub reports but cannot set, a value outside its enum, two keys that contradict each other, and an unknown key inside a closed shape.

Under `private-repos: redact` the multi-repo flow reads and validates the shared `defaults-file` first when one is given, then resolves the visibility of every target but the workflow's own repository, before it reads any target's settings file. Then it reads each target's file: a remote target's from that repository, a `repos-dir` target's from the local directory. Those are the flow's own reads; no section has run for that target.

The field GitHub reports but cannot set is the case that motivated the rule:

| | `repository.has_downloads: false` in the file |
| --- | --- |
| Before | The GET reports `has_downloads`, the PATCH cannot set it, so every check saw drift and every apply re-sent it without converging. |
| Now | The parse refuses the file with an error naming `repository.has_downloads` and telling you to remove the key. No section reads or writes the repository. |

An unknown key has two fates, decided by the shape it sits in:

| Shape | Unknown key | What you see |
| --- | --- | --- |
| Closed: the write carries only the fields the shape names, so an extra key has nowhere to go | refused at parse | the error names the key and the shape it sits in |
| Open passthrough: extra fields ride into the write verbatim, so a field GitHub ships tomorrow works today | kept and sent | on the sections that already print it, a check-time note when GitHub does not echo the key: if GitHub ignores it, every apply re-sends it without converging |

The [forward compatibility page](forward-compatibility.md#the-closed-sections) lists which sections and nested shapes are closed.

## What happens to undeclared resources

Three sections illustrate the range of default policies:

- Labels: declared labels are upserted (rename via `new_name`); undeclared labels are DELETED by default (Probot parity), loudly. The [`_undeclared` policy](undeclared-policy.md) can soften this to keep.
- Rulesets: upserted by name with the full payload; undeclared rulesets are never deleted by default, since removing protection stays a human action. The [`_undeclared` policy](undeclared-policy.md) can opt into deletion.
- Milestones: upserted by title; undeclared ones are kept by default (deleting a milestone detaches it from every issue carrying it) and listed as notices. The [`_undeclared` policy](undeclared-policy.md) can opt into deletion.

Every section's own default is stated in the [Sections table](sections.md)'s Undeclared default column, and the [undeclared policy](undeclared-policy.md) page covers the knob that overrides it.

Within the six sections built on the list-section factory (`labels`, `milestones`, `autolinks`, `deploy_keys`, `webhooks`, `rulesets`), apply deletes the undeclared resources first and then walks the declared entries in file order (a changed resource GitHub cannot edit is deleted and recreated in place), so a delete has freed a name or prefix before the create that needs it is sent.

## Null is the empty state

A `null` in the settings file is a declared value: the EMPTY or OFF state on GitHub (`pages: null` turns Pages off, `cname: null` removes the custom domain, `protection: null` strips a branch's protection). A key with no empty state refuses it at validation, naming the values that exist: `repository.enable_git_lfs has no empty state; write true or false`.

A whole section takes `null` only where `null` is its off state (`pages`, `interaction_limits`).

A file written by hand and a file `mode: render` folded mean the same thing by it. The [layering guide](../operate/layering.md) covers how a higher layer's `null` wins and how `_remove` drops a keyed entry instead.

## Errors and retries

Permission failures (403, or 404 on admin endpoints with a fine-grained token) are the only softenable errors; everything else always fails with the API message verbatim. The [permissions page](permissions.md) covers the `on-missing-permission` and `required-sections` inputs that do the softening.

Rate limits (429 and secondary limits) and transient 5xx or network failures are retried automatically with backoff, honoring Retry-After and the rate-limit reset, up to two retries; a reset more than 60 seconds away fails loudly instead of stalling the workflow. Permission errors are never retried.

## The preflight barrier

Before the barrier, and in every mode, document validation runs every check that reads only the settings file: the section shapes, unknown keys, two entries naming one resource, a malformed deploy key. A settings-file mistake fails the run before any section runs, with the collected issues listed by path, so nothing is written.

A section's shape reports every mistake it finds in that one run, like a compiler: its cross-field rules (a contradictory pair, a key that belongs elsewhere) are judged even when a sibling value already failed its type.
A rule meeting such a raw sibling reports what it can and passes over what it cannot read; the sibling's own type issue is the report there.

The shape's own issues are capped at 5 per section; the line after them counts the rest ("...and N more issues in this section"). The checks that need the parsed section (two entries naming one resource) wait for its shape to pass and report every finding; only the unrecognized-key check of a closed section keeps a cap of its own, 5 entries.

Under `on-missing-permission: fail`, every active section (each declared section the `sections` input selects; all of them when that input is unset) is then probed read-only before ANY write; if a section is inaccessible, nothing is applied at all (per repository in multi-repo mode; earlier targets in the same run are already done).

The API has no transactions. A read-but-not-write token can still fail mid-apply, and a section whose reads need no grant at all (`custom_properties` - its values read is Metadata-gated) surfaces a missing write grant only at its first write. Re-running after fixing it converges because applies are idempotent.

See the [coverage page](coverage.md) for the full inventory: everything supported, every repo-scoped gap, and the user-scoped surface that is out of scope by design.
