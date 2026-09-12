---
order: 40
---

# Command line

The engine behind the action is also a command in the npm package `@vivswan/github-settings-as-code`: `github-settings-as-code`, or `gsac` for short.
It runs the same checks, applies, and merges the action runs, from a terminal or any CI, plus three file-only commands the action has no step for:
validate a settings file, print the PAT grant it needs, and (in a build that carries the snapshot mode) write a repository's live settings as a file.

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
| `validate <file>` | Validate a settings file against the schema | no |
| `permissions <file>` | Print the PAT grant each section the file declares needs | no |
| `snapshot` | Write the live repository settings as a settings file | yes |
| `init` | Snapshot into `.github/settings.yml` and print the PAT grant that file needs | yes |

`snapshot` and `init` need a build of the package whose library carries `mode: snapshot`; a build without it exits 1 naming the missing mode.

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

Every flag of the action's `apply` and `check` inputs is a flag here, spelled the same way; `--repos`, `--repos-dir`, and `--defaults-file` switch to [multi-repo mode](../operate/multi-repo.md), and the discovery filters follow.

### merge

```bash
gsac merge --settings-file fleet.yml --settings-file team.yml --merged-file merged.yml
```

A repeated `--settings-file` builds the layer list, lowest first; a comma-separated value does the same. The merged file is exactly what `apply` would run ([layering](../operate/layering.md)).

### validate

```bash
gsac validate .github/settings.yml
```

Exits 0 with the sections the file declares, or 1 with the validator's message on stderr. No token, no API call: this is the command to run in a pre-commit hook or a pull request check.

### permissions

```bash
gsac permissions .github/settings.yml
```

One line per declared section: the grant its declaration names, the same words a permission denial would print.

## Flags

The subcommand is the action's `mode` input. Every other input of that mode is a flag named `--<input>`, taking the value the action's `with:` key takes;
the [inputs reference](../reference/inputs.md) lists each one with its default and meaning, and `gsac <command> --help` prints the same descriptions.
A list input (`--settings-file` under merge, `--repos`, `--exclude`, `--topics`, `--affiliation`, `--sections`, `--required-sections`) takes a comma-separated value or the flag repeated; repeating any other value flag, `--token` and `--summary` included, is an error naming it.

Four flags are the command line's own:

| Flag | Does |
|---|---|
| `--token <value>` | The token; `GITHUB_TOKEN` when absent |
| `--json` | Print the outputs as one JSON object on stdout; log lines move to stderr |
| `--summary <file>` | Append the run's markdown summary (the action's step summary) to this file |
| `--verbose` | Show the debug trace on stderr |

## Output and exit codes

Log lines go to stdout, annotations to stderr as `level: message` (`notice`, `warning`, `error`), and the action's outputs close the run as `name=value` lines on stdout:

```text
result: clean
skipped-sections=
result=clean
```

With `--json` the outputs are one object instead, and stdout carries nothing else:

```text
{"skipped-sections":"","result":"clean"}
```

The exit codes are the action's: `check` exits 1 on drift or failure, `apply` and `merge` exit 1 on failure only, `validate` exits 1 on an invalid file, `permissions` exits 0 for a valid file.
A flag the mode does not read is unknown to that subcommand and exits 1 with the parser's message, where the action rejects the same input by name;
a value the mode refuses (a filter without `--repos "*"`, a `--repository` that is not a slug) fails with the action's own message.
The token passed on the command line is masked as `***` wherever a line would echo it.
