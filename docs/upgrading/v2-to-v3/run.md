---
order: 1
title: "Run inputs and outputs"
---

# Upgrading from v2 to v3: run inputs and outputs

Sections 1, 4, 5, 6, 7, 8, 10, 13, 18, 22, 25, 26, 33, 34, and 61 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 1. The defaults-file fallback

Blast radius first: with `repos: "*"`, every discovered repository that has no `.github/settings.yml` now receives the whole defaults document, where v2 skipped it. A defaults file with `labels: {_undeclared: delete, entries: [...]}` deletes labels on all of them.

1. Run the fleet workflow with `mode: check` on v3 and read which targets say `applying the defaults file: the repository has no .github/settings.yml on its default branch`.
2. For each, decide: give the repository its own file, or accept the defaults as its complete settings.
3. Targets that used a partial file as an overlay on the defaults now need the full document. Build it with [layering](../../operate/layering.md): the old defaults file is the lowest layer, the old target file the highest, and `rendered-file` is the document the target applies.

The token also matters: a target the token cannot read Contents on fails with an error naming `Contents: read`, where v2 could mistake the denial for a missing file. Grant the permission or drop the target from `repos`.

The [multi-repo guide's fallback section](../../operate/multi-repo.md#fallback-for-repositories-without-a-settings-file) owns the rule.

## 4. Commas and newlines in a settings-file path

`mode: render` takes its layers as a newline- or comma-separated list in `settings-file`, and the separators are the same in every mode. So no settings file can be named with a comma or a newline in its path any more. v2 read `settings-file: settings,prod.yml` as one file; v3 apply refuses it:

```text
the "settings-file" input is "settings,prod.yml", which contains a list separator: apply mode reads exactly one settings file, and only mode: render takes a newline- or comma-separated list. Name one file, or set mode: render to fold the list into one document
```

Check mode says the same with `check mode`. The fix is a rename: move the file to a path without the separator (`settings-prod.yml`) and point `settings-file` at it.

## 5. repos-result rows spell skipped-sections

Every key inside the `repos-result` map is spelled like the outputs themselves: kebab-case. The one camelCase key, `skippedSections`, is gone.

```text
{"o/r": {"result": "partial", "source": "central", "skipped-sections": ["actions_variables"]}}
```

A step that read `fromJSON(steps.settings.outputs.repos-result)['o/r'].skippedSections` now reads `null`; rename the key in the expression.

## 6. The three outputs are always set

| Output | v2 | v3 |
|---|---|---|
| `result` | Every mode | Every mode |
| `skipped-sections` | Apply, check, snapshot; the pre-release `merge` mode set it to `""` | Every mode, `""` when none |
| `repos-result` | Multi-repo runs and `snapshot-dir` only; unset elsewhere | Every mode; `{}` for a run over one repository or a render |

A step that used an unset `repos-result` to tell a single-repo run from a fleet run must test `repos-result == '{}'` instead. The exit rule did not move: 1 exactly when `result` is `failed`, or `drift` in `mode: check`.

## 7. One --json envelope

Every `gsac` subcommand prints one object under `--json`, `result` first:

| Command | v2 | v3 |
|---|---|---|
| `check`, `apply`, `render`, `snapshot` | `{"skipped-sections": "", "result": "clean"}` | `{"result": "clean", "skipped-sections": [], "repos-result": {}}`: the list is a list, the map a map |
| `validate` | `{"file": ..., "valid": true, "sections": [...]}` | `{"result": "valid", "file": ..., "sections": [...]}` |
| `permissions` | `{"labels": "<grant>", ...}` | `{"result": "valid", "file": ..., "grant": {"labels": "<grant>", ...}}` |
| `init` | `{"file", "repository", "result", "skippedSections", "failedSections", "grant"}` | `{"result", "file", "repository", "skipped-sections", "grant"}`; `failedSections` is gone, since a failed section now fails init |
| any failure | `{"file", "valid": false, "problem"}` or `{"result": "failed", "problem"}`; a mode command's fatal problem and a parser error printed no `problem` | `{"result": "failed", "file"?: ..., "problem": ...}`; a mode command that fails before any target runs prints `problem` beside its three outputs, a parser error or a crash prints it alone. A target that fails while running has no `problem`: its errors are on stderr and its row in `repos-result` |

## 8. A failed snapshot section fails the target

Every mode now applies one crash rule: a section whose read throws (an API error) fails its target, `result` is `failed`, the run exits 1, and no snapshot file is written for that target. v2 wrote the file without the section and reported `partial` with exit 0.

A value the section's own schema rejects already failed the target in v2; that case did not move. A denial under `on-missing-permission: warn` still skips the section and still reports `partial`.

`gsac init` follows: a failed section refuses to write the settings file, with the errors above naming the section and the fix.

## 10. One redacted label in every mode

Every hidden target is labelled `private repository #N`, numbered in target order, whatever the mode. A run over one repository (`repository:` with `private-repos: redact`, or `snapshot-file`) is a fleet of one, so its label is `private repository #1`:

```text
v2: warning: private repository: drift - repository. details hidden: ...
v3: warning: private repository #1: drift - repository. details hidden: ...
```

The `artifact` report channel heads that run's report `<!-- private repository #1 -->` for the same reason. A filter matching the bare label needs the `#1`.

Snapshot targets ride the same seal now: a private target's notes, file path, and section detail close sealed exactly as a multi-repo apply target's do, and a private target that fails gets the same one-line annotation (`private repository #N: failed - <sections>`) a fleet target gets. The [private repositories guide](../../operate/private-repositories.md#one-seal-every-mode) owns the rule.

## 13. One wording per concept in drift lines and notes

Anything that greps the check output for these lines needs the new spelling. Two templates reach every site:

- the cannot-verify line: the webhook secret, the write-only `check_suite_preferences` note, `interaction_limits.expiry`, and the repository toggles GitHub cannot read back (`enable_git_lfs`);
- the left-out line: rulesets, webhooks, the teams and collaborators snapshot notes, an inherited interaction limit, and the secondary snapshot reads (actions, environments, repository) a denied grant skips under `on-missing-permission: warn`; a denied primary read still says `skipped`.

| Line | v2 | v3 |
|---|---|---|
| A webhook's label | `webhooks["https://ci.example.com/hook"].active` | `webhooks[https://ci.example.com/hook].active` |
| A field mismatch (milestones, rulesets, collaborators, teams, every list section) | `milestones[v1].state: "closed" != "open"` and `teams[platform]: live role "read" != declared "write"` | `milestones[v1].state: declared "closed" != live "open"; apply will set the declared value` |
| A webhook's events | `... declared [...] != live [...] (compared order-insensitively)` | one line per element: `webhooks[<url>].events: missing "release"` |
| A value check mode cannot compare | `... so the declared value cannot be verified; apply re-sends it on every run so rotations propagate` | `<label>: <why>, so check mode cannot verify <what>; apply <re-sends it> on every run` |
| A resource a snapshot reads but does not declare | `rulesets[x]: inherited from the organization ..., so it is not part of the repository's snapshot` and `teams[x]: ...; not declared` | `<label>: left out of the snapshot - <reason>` |
| An email invitation in a collaborators snapshot | `invitation 502 was sent by email, so no username can declare it; not declared, and apply leaves it untouched` | `collaborators[invitation 502]: left out of the snapshot - sent by email, so no username can declare it; apply leaves it untouched` |
| A personal account under `teams` or `custom_properties` | `teams: owner "o" is a personal account, not an organization, so team access does not apply` and `custom_properties: owner "o" is a personal account, and custom properties require an organization-owned repository` | `<section>: owner "o" is a personal account, not an organization, so this section does not apply` |
| A ruleset update's change line | `updated ruleset "main" (id 42)` | `updated ruleset "main"` |
| A milestone delete's change line | `DELETED undeclared milestone "v0.9" (detached from every issue that carried it)` | `DELETED undeclared milestone "v0.9"` (the drift line beside it still names the detaching) |

## 18. GSAC_RETRY_BASE_MS

The one environment variable of the tool's own, the retry-timing test knob, is `GSAC_RETRY_BASE_MS`; v2 read it as `RETRY_BASE_MS`, undocumented. An environment variable has no channel for a loud error, so the old name is simply ignored: a harness that set `RETRY_BASE_MS=1` to speed a mock run up now waits real seconds until it is renamed. The [inputs reference](../../reference/inputs.md#environment-variables) lists it with the other variables a run reads.

## 22. One wording for every face

The action and the command line print the same line for the same problem; the remedy names the input and, where one exists, its flag.

| Problem | v2 (action) | v2 (command line) | v3 (both) |
|---|---|---|---|
| No token | `Set the "token" input on the action step (or export GITHUB_TOKEN)` | `Pass --token, or export GITHUB_TOKEN` | `Set the "token" input (--token on the command line), or export GITHUB_TOKEN` |
| No repository | `Set the "repository" input (or GITHUB_REPOSITORY) to a value like "octocat/hello-world"` | `Pass --repository owner/name (inside GitHub Actions, GITHUB_REPOSITORY supplies it)` | `Set the "repository" input (--repository on the command line) to a value like "octocat/hello-world"; inside GitHub Actions, GITHUB_REPOSITORY supplies it` |
| Unknown section in `sections` | `Fix the name in the workflow's input list` | same | `Fix the section name` |
| A transient API failure | `... re-run the workflow, and retry later if it persists` | same | `... re-run, and retry later if it persists` (the report channels say `Re-run, or set private-report: none if it persists`) |
| `private-report: artifact` off the runner | accepted at the parse (the action has the upload; a library caller without an uploader failed later with `artifact-uploader-missing`) | `the "private-report" input is "artifact", which is not a supported private-report channel from the command line ...` | `private-report: artifact uploads the reports as a workflow artifact, which only the GitHub Actions runner can do, and this run has no artifact upload ... Set private-report to "issue", "issue-on-failure", or "none"` |
| `gsac init --settings-file a,b` | `the --settings-file value "a,b" contains a comma or a newline, which check and apply read as a list separator ...` | | `the "settings-file" input is "a,b", which contains a list separator: init writes exactly one settings file ... Name one file` |
| An unreadable `repos-dir` file | `cannot read settings from <path>: ... Fix the file, or delete it to stop managing this repository` | | `cannot read the central settings file <path>: ... Fix the file, or delete it to stop managing this repository` (a YAML syntax error in it reads the same way, where v2 said `cannot parse`) |

For `@vivswan/github-settings-as-code` consumers: `parseConfig` takes a third argument, the face's `RunCapabilities`, and refuses `private-report: artifact` there (`input-artifact-unsupported`); a two-argument call stops compiling.

## 25. Every live read is parsed at the port

Every GET and GraphQL query a section issues now passes through one parser before the section sees the body, so a response off the documented shape fails the section instead of flowing into a comparison.

v2 parsed some reads (the lists, the toggles) and compared others raw: a `null` Actions permissions body read as drift on every declared key and re-applied the PUT on every run. A pinned environment without a position was reported by its own message.

```text
actions: GET /repos/{owner}/{repo}/actions/permissions returned a body outside the documented shape - (body): Invalid input: expected object, received null. Check the "api-version" input against the GitHub REST docs for this endpoint
```

A GraphQL read says `GRAPHQL <operation>` in place of the method and path and points at the GraphQL reference. Where a read names its resource, the denial and the shape failure both carry it (`GET .../deployment_protection_rules (environment "production"): 403 ...`). The `api-version` advice is the fix in every case: the shapes are GitHub's documented ones.

Two smaller moves ride along:

- A section that reads anything must declare `snapshot()`; only the write-only `check_suite_preferences` reports `unsupported`, and the `snapshot is not implemented for this section yet` note is gone.
- The organization-only sections (`teams`, `custom_properties`) are probed for the owner kind by the registry, ahead of their own plan and snapshot. The personal-account note is unchanged. A settings-file mistake in those sections (two entries naming one team) is validation's, before any request ([section 34](#34-file-only-checks-run-before-the-first-write)).

For `@vivswan/github-settings-as-code` consumers, a `SectionModule` typed over its literal endpoint dictionaries requires `snapshot()` when an endpoint declares a read; with the erased default, which `sectionModule()` returns, nothing is checked.

## 26. The snapshot file is canonical and undated

The file `mode: snapshot`, `gsac init`, and `snapshotRepository` write carries no timestamp, and its document renders in the one canonical order the rendered file shares, so a snapshot of an unchanged repository is byte for byte the last one and a diff between two snapshots shows only what changed on GitHub.

```text
v2   # <the schema pin>
     # Snapshot of octocat/hello-world taken 2026-09-11T06:17:00.000Z
     labels:
       _undeclared: delete
       entries:
         - name: docs                  # the order GitHub listed them
         - name: bug

v3   # <the schema pin>
     labels:
       _undeclared: delete
       entries:
         - name: bug                   # by name
         - name: docs
```

The moment moves to the run: one `notice: snapshot taken 2026-09-11T06:17:00.000Z` annotation and a `Snapshot taken ...` line in the step summary. A script that read the instant from the file's second line reads the notice instead.

The canonical order, the same for the snapshot and the rendered file:

| Node | Order |
|---|---|
| The top level | The sections in the order the action applies them (`SECTION_KEYS`), then `_layering`, then any other key by code point |
| A mapping the schema declares | Its properties as the schema (and the published JSON schema) lists them; keys the schema does not declare follow by code point (an integer-like key such as `"10"` leads, in numeric order, as JavaScript enumerates it) |
| A mapping the schema leaves open (a rule's `parameters`, a bypass actor) | Keys by code point |
| A list of entries with an identity (labels by `name`, webhooks by `config.url`, milestones by `title`, collaborators by `username`, `rules` by `type`, and so on) | Sorted by the identity, ties by the entry's canonical JSON |
| `environments` | The `pinned: true` entries first in their written order, since that order is the pin rank; the rest by `name` |
| `branches` | As written: GitHub applies overlapping wildcard rules in creation order, and apply creates them in file order; the fold unions them by name in that order |
| Any other list (`topics`, `include` patterns, `bypass_actors`, `reviewers`) | As written |
| Each section's header notes | By code point within the section |

The snapshot's notes are sorted the same way, in the file header and in the annotations. A snapshot committed under v2 reorders once.

## 33. Apply refuses over omitted live values

Check compared declared keys only, but the ruleset PUT and the environment PUT write the whole object. A live value the file left out was deleted by the next apply while check said clean.

```text
v2 check    | rulesets     | clean |
            | environments | clean |
            (apply then cleared the live bypass list and the reviewers rule without a word)

v3 check    rulesets[main-protection].bypass_actors: live has [{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}] but the settings file omits it, so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose
            environments[production].reviewers: live has [{"type":"User","id":101}] but the settings file omits it, so apply would REMOVE it; declare reviewers to keep it, or reviewers: [] to remove it on purpose

v3 apply    rulesets[main-protection]: not applied - the update would remove a live value the settings file omits. rulesets[main-protection].bypass_actors: live has [...] but the settings file omits it, so apply would REMOVE it; declare bypass_actors to keep it, or bypass_actors: [] to remove it on purpose
            (the entry's PUT is never sent, the section fails, exit 1)
```

A file that was stable can now drift: an environment entry declaring `variables` alone, beside a live wait timer, reports the timer in check and refuses the PUT in apply. Declare `wait_timer` to keep it, or `wait_timer: 0` to remove it; an omitted object whose key accepts null offers `<key>: null` (`deployment_branch_policy: null`).

The sweep stops where the entry shape stops naming keys (`rules[].parameters`, the fields inside a bypass actor): a live non-default rule parameter beside a declared rule still reads clean and the PUT resets it, as before. The [semantics page](../../reference/semantics.md) states the boundary.

## 34. File-only checks run before the first write

```text
v2   sections: repository                 # labels excluded from the run
     labels:
       - name: bug
       - name: Bug
     -> repository: patched repository fields: description
        (the excluded duplicate was never seen; a selected duplicate threw mid-run, after the PATCH landed)

v3   -> ::error::settings.yml has malformed section entries: labels[1].name: "Bug" names the same label as "bug" declared earlier; keep exactly one entry per label. Fix these values in the settings file (...)
        result: failed, zero requests
```

Every section's file-only checks run at validation, selected or not: duplicate identities (a rename target and the pre-rename name included), malformed lists, an unreadable deploy key, a secret value that is not a whole-value `$NAME` reference the document's author may use, a non-plain value, a non-finite passthrough number, a passthrough alias cycle. The collected issues name their paths, and the run exits 1 before any request.

Fix the declaration, in the excluded section too. For `@vivswan/github-settings-as-code` consumers: `SectionModule` gains a required `validate(declared)` hook on list modules, so a custom list module without one stops compiling; the [library page](../../reference/library.md) documents its shape.

## 61. Discovery: `exclude` patterns are globs under an owned grammar

For every `repos: "*"` workflow that sets `exclude`, and for `@vivswan/github-settings-as-code` consumers building `DiscoveryFilters`. In v2 an `exclude` pattern knew one operator, `*`, and matched every other character literally, so a `?`, a `[`, or a leading `!` could only ever match nothing.

In v3 the pattern is a glob matched by picomatch inside a grammar the input boundary owns. The scope rule is unchanged: a pattern with `/` matches `owner/name`, any other the name alone, case-insensitively.

| In the pattern | Matches |
|---|---|
| `*` | any run of characters |
| `?` | one character |
| `[abc]` | one of a set |
| `[!abc]` or `[^abc]` | one outside it |
| one leading `!` | negates the whole pattern |
| anything else | name characters only (letters, digits, `.`, `-`, `_`), with at most one `/` |

A pattern that gains glob meaning matched nothing in v2 and matches now: `exclude: "!svc-*"` discovered every repository, and now excludes every one whose name is not `svc-*`:

```text
notice: repos: "*" discovery skipped 2 repositories by exclude pattern "!svc-*": o/tooling, o/website
```

A pattern outside the grammar (a leading `./`, a run of stars, a `.` or `..` side, a second `/`, a doubled `!!`, a regex token such as `(a)+`) is your input, so it fails the run before discovery starts, naming every flaw and its fix, never repaired. `exclude: "./tmp-**"` matched nothing in v2 and now exits with:

```text
error: the "exclude" input pattern "./tmp-**" is not a usable glob: it starts with "./", which names no owner, so drop every leading "./", and it holds a run of stars, which matches no more than one "*" does, so write one "*". Write ...
```

Fix: delete a pattern that relied on `?`, `[`, `]`, or `!` matching literally, since it never matched a repository; rewrite one that meant a glob in the grammar above, following the fix each refusal names. For library callers, `DiscoveryFilters.exclude` takes compiled `ExcludePattern` values instead of strings: run each pattern through `compileExcludePattern` at your input boundary and pass the `Result`'s value.
