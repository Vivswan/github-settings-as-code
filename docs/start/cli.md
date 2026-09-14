---
order: 40
---

# Command line

The engine behind the action is also a command in the npm package `@vivswan/github-settings-as-code`: `github-settings-as-code`, or `gsac` for short.
It runs the same checks, applies, merges, and snapshots the action runs, from a terminal or any CI, plus three commands the action has no step for:
start managing a repository from its live settings (`init`), validate a settings file, and print the PAT grant it needs.

## Install

Run it without installing, with npm or bun. Until the first stable release publishes the package, ask for the `next` tag:

```bash
npx @vivswan/github-settings-as-code@next --help
bunx @vivswan/github-settings-as-code@next --help
```

Or install it and call `gsac`:

```bash
npm install --global @vivswan/github-settings-as-code@next
gsac --help
```

The package needs Node 22.14 or newer; `bunx` fetches it the same way and honors the executable's `node` shebang. The command reads its token from `--token` or the `GITHUB_TOKEN` environment variable; the same fine-grained PAT the action uses (see [Token permissions](../reference/permissions.md)).

## Commands

| Command | Does | Needs a token |
|---|---|---|
| `check` | Report drift between a settings file and the live repository; exits 1 on any drift | yes |
| `apply` | Apply a settings file to the repository | yes |
| `merge` | Fold an ordered list of settings files into one document | no |
| `snapshot` | Write a repository's live settings as a settings file, or one file per multi-repo target | yes |
| `init` | Write a repository's live settings to `.github/settings.yml` and print the PAT grant that file needs | yes |
| `validate <file>` | Validate a settings file against the schema | no |
| `permissions <file>` | Print the PAT grant each section the file declares needs | no |

### check

```bash
export GITHUB_TOKEN=github_pat_...
gsac check --repository octo-org/api --settings-file .github/settings.yml
```

Prints the drift lines the action would annotate, then `result: clean` or `result: drift`, and exits 1 on drift, exactly as [check mode](../operate/check-mode.md) describes.

The defaults are the action's, redaction included: a private repository's lines are hidden unless you pass `--private-repos show`
(a terminal has no `GITHUB_REPOSITORY` to exempt the repository you are standing in; see [private repositories](../operate/private-repositories.md)).

### apply

```bash
gsac apply --repository octo-org/api --settings-file .github/settings.yml --on-missing-permission warn
```

Every flag of the action's `apply` and `check` inputs is a flag here, spelled the same way, with two exceptions below. `--repos` or `--repos-dir` switches to [multi-repo mode](../operate/multi-repo.md); `--defaults-file` and the discovery filters apply there, as in the action.
Outside GitHub Actions there is no `GITHUB_REPOSITORY`, so single-repo runs need `--repository`.

### merge

```bash
gsac merge --settings-file fleet.yml --settings-file team.yml --merged-file merged.yml
```

A repeated `--settings-file` builds the layer list, lowest first; a comma-separated value does the same. The merged file is exactly what `apply` would run ([layering](../operate/layering.md)).

### snapshot

```bash
gsac snapshot --token "$ADMIN_TOKEN" --repository octocat/hello-world --snapshot-file settings.snapshot.yml
gsac snapshot --token "$FLEET_TOKEN" --repos "*" --snapshot-dir snapshots
```

Exactly one of `--snapshot-file` (one repository) and `--snapshot-dir` (one `<owner>/<name>.yml` per target) is required; the fleet flags are the multi-repo ones. The written file is what `check` reads clean against the repository it came from ([snapshot mode](../operate/snapshot.md)).

### init

```bash
gsac init --token "$ADMIN_TOKEN" --repository octocat/hello-world
```

The adoption path in one command: the snapshot of the repository lands in `.github/settings.yml`, the file `check` and `apply` read, and the grant its sections need follows:

```text
.github/settings.yml written from octocat/hello-world: 3 sections declared (labels, milestones, webhooks)
Token permissions the file needs:
  labels: grant "Issues" (read and write) under the PAT's Repository permissions
  milestones: grant "Issues" (read and write) under the PAT's Repository permissions
  webhooks: grant "Webhooks" (read and write) under the PAT's Repository permissions
```

The file is the one [snapshot mode](../operate/snapshot.md) writes, schema hint first; commit it, and `gsac check` reads clean against the repository it came from.
An existing settings file is refused (init never replaces the file you author) unless `--force` is passed; `--settings-file` writes elsewhere.
`--sections` and `--on-missing-permission` narrow the snapshot as they do under `snapshot`; a section the token cannot read is skipped under `warn` and listed on stdout, and the file's header names every section the snapshot does not read back.
A document that would declare no section is never written: the refusal names each selected section and why it declares nothing.
The notes print in the clear, as the file holds the same names: init has no `--private-repos`.

With `--json`, stdout is one object, the envelope every subcommand prints (`result` first, then the command's own fields). After a write:

| Field | Holds |
|---|---|
| `result` | `snapshot`, or `partial` when a section was skipped |
| `file`, `repository` | The written path and the `owner/name` it was read from |
| `skipped-sections` | Sections skipped under `--on-missing-permission warn`, as a list; the file omits them |
| `grant` | One entry per declared section: its key and the grant line printed above |

A refusal or a failure exits 1 with `{"result":"failed","file":"<the settings file>","problem":"<the line stderr carries>"}` instead; a section that fails on its own fails the whole snapshot, so no file is written.

### validate

```bash
gsac validate .github/settings.yml
```

Exits 0 with the sections the file declares, or 1 with the validator's message on stderr. No token, no API call: this is the command to run in a pre-commit hook or a pull request check.
With `--json`: `{"result":"valid","file":"<path>","sections":["labels","repository"]}`, or `{"result":"failed","file":"<path>","problem":"<the validator's line>"}`.

### permissions

```bash
gsac permissions .github/settings.yml
```

One line per declared section: the grant its declaration names, the same words a permission denial would print.
With `--json`: `{"result":"valid","file":"<path>","grant":{"labels":"<grant line>",...}}`, or the same failed envelope `validate` prints.

## Flags

The subcommand is the action's `mode` input. Every other input of that mode is a flag named `--<input>`, taking the value the action's `with:` key takes;
the [inputs reference](../reference/inputs.md) lists each one with its default and meaning, and `gsac <command> --help` prints the same descriptions.
A list input (`--settings-file` under merge, `--repos`, `--exclude`, `--topics`, `--affiliation`, `--sections`, `--required-sections`) takes a comma-separated value or the flag repeated; repeating any other value flag, `--token` and `--summary` included, is an error naming it.

Two inputs have no command-line form: `--private-report artifact` is refused (the artifact upload needs the Actions runner; `issue`, `issue-on-failure`, and `none` work), and `report-public-key`, which only that channel reads, is not a flag.

Four flags are the command line's own, and `init` has one more, `--force` (replace an existing settings file):

| Flag | Does |
|---|---|
| `--token <value>` | The token; `GITHUB_TOKEN` when absent |
| `--json` | Print the outputs as one JSON object on stdout; log lines move to stderr |
| `--summary <file>` | Append the run's markdown summary (the action's step summary) to this file; under GitHub Actions the step summary itself when absent; `init`, `validate`, and `permissions` have none |
| `--verbose` | Show the debug trace on stderr |

## Output and exit codes

Log lines go to stdout, annotations to stderr as `level: message` (`notice`, `warning`, `error`), and the action's three outputs close the run as `name=value` lines on stdout, in every mode:

```text
result: clean
result=clean
skipped-sections=
repos-result={}
```

As a GitHub Actions step (`GITHUB_ACTIONS=true` in the environment, as the runner sets it) the command line reports as the action does, in addition: a masked value is a `::add-mask::` command, an annotation a `::notice::`, `::warning::`, or `::error::` command on stdout instead of the stderr line, the outputs land in the step outputs (`GITHUB_OUTPUT`), and the summary in the step summary (`GITHUB_STEP_SUMMARY`) unless `--summary` names a file. Those commands share stdout with the `--json` object, so a step reads the outputs from the step outputs, not by parsing stdout; the one-object rule below holds in a terminal.

With `--json` the outputs are one object instead, and stdout carries nothing else; `skipped-sections` is a list there and `repos-result` a map, never a string to parse again:

```text
{"result":"clean","skipped-sections":[],"repos-result":{}}
```

A run that fails before any target runs (a missing input, a value the mode refuses) prints the same object with `result: "failed"` and the stderr line as `problem`; a parser error or a crash prints `{"result":"failed","problem":"<the line>"}`. Under `--json`, stdout is always exactly one object, with one exception: `--help` prints the usage and exits 0, as it does without the flag.

The exit codes are the action's:

| Command | Exits 1 when |
|---|---|
| `check` | drift, or a failure |
| `apply`, `merge`, `snapshot` | a failure |
| `init` | a failure, a document that would declare no section, or a settings file it refuses to replace |
| `validate` | the file is invalid |
| `permissions` | never for a valid file |

A flag the mode does not read is unknown to that subcommand and exits 1 with the parser's message, where the action rejects the same input by name;
a value the mode refuses (a filter without `--repos "*"`, a `--repository` that is not a slug) fails with the action's own message, reworded where the action's remedy names the workflow step.
The token passed on the command line is masked as `***` wherever a line would echo it.
