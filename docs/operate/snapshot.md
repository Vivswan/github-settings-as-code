---
order: 215
---

# Snapshot mode

`mode: snapshot` reads a repository's live settings back and writes them as a settings file. Nothing is written to GitHub, and the document reaches only the file: the log, the step summary, and the outputs carry section names, statuses, and the notes a check run prints for the same repository (a secret's name, a webhook's URL), never the document and never a secret's value.

Use it to start managing a repository from what it has today, to keep a backup before an apply, or to bring a fleet under `repos-dir` management one file per repository.

## One repository

```yaml
name: Snapshot settings
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          mode: snapshot
          snapshot-file: settings.snapshot.yml
      - uses: actions/upload-artifact@v4
        with:
          name: settings-snapshot
          path: settings.snapshot.yml
```

The token needs the same read grants a check run needs for the sections you want (see [Token permissions](../reference/permissions.md)). No checkout is needed: a snapshot reads nothing from the working tree.

## What the file looks like

```yaml settings
# yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json # x-release-please-major
# Snapshot of octocat/hello-world taken 2026-09-11T06:17:00.000Z
# actions_secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN before apply
# check_suite_preferences: GitHub exposes no read endpoint for this section, so there is nothing to snapshot; apply re-asserts the declared value on every run
# milestones: nothing exists on the repository, so the section is omitted
labels:
  _undeclared: delete
  entries:
    - name: bug
      color: d73a4a
      description: Something is broken
actions_secrets:
  _undeclared: keep
  entries:
    - name: DEPLOY_TOKEN
      value: $SECRET_ACTIONS_DEPLOY_TOKEN
```

Reading it top to bottom:

- The first line pins the published schema, so an editor validates and autocompletes the file.
- The second line names the repository and the moment the snapshot was taken.
- Then one comment line per note: a secret whose value GitHub never reveals, a section the snapshot cannot read back, a section with nothing live to declare. The same notes appear as annotations on the run, exactly as a check run would print them, so a note names a secret or a webhook by its name or URL and never by a value.
- The document follows in the same form `mode: merge` writes: every list section in its wrapper form with the section's default `_undeclared` policy spelled out (see [the undeclared policy](../reference/undeclared-policy.md)), so an apply from the file does exactly what the header says.

## The `$NAME` placeholders

GitHub never returns a secret's value, so the file cannot hold one. The snapshot writes a reference instead, and the note tells you which variable to export before an apply or check runs the file:

| What GitHub hides | What the file holds | What to export |
|---|---|---|
| A repository Actions secret named `DEPLOY_TOKEN` | `value: $SECRET_ACTIONS_DEPLOY_TOKEN` | `SECRET_ACTIONS_DEPLOY_TOKEN` |
| The same name in another store (`dependabot_secrets`, `codespaces_secrets`, `agents_secrets`) | `$SECRET_DEPENDABOT_DEPLOY_TOKEN`, `$SECRET_CODESPACES_DEPLOY_TOKEN`, `$SECRET_AGENTS_DEPLOY_TOKEN` | One variable per store, so two stores holding the same name never share a value by accident |
| A webhook's `config.secret`, one per hook | `secret: $WEBHOOK_SECRET_601` | `WEBHOOK_SECRET_<id>`, the hook's own id, so the reference survives a reordering |

Wire them the way the [secrets guide](../reference/secrets-and-vaults.md) describes: an `env:` block on the apply step, fed from GitHub Secrets or a vault action. A reference that is not exported fails the run that reads the file, naming the variable.

## Backup, then check

The written file is a settings document, so a check run can read it back against the repository it came from. Snapshot before an apply, and the check proves the file matches what was live:

```yaml
name: Backup then check
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          mode: snapshot
          snapshot-file: backup/settings.yml
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        env:
          SECRET_ACTIONS_DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
          mode: check
          settings-file: backup/settings.yml
      - uses: actions/upload-artifact@v4
        with:
          name: settings-backup
          path: backup/settings.yml
```

The check reads `clean`: the round trip holds for every section the snapshot reads back. Commit the file as your `.github/settings.yml` when it says what you expect, or keep the artifact as the record of what was live before a change.

## The round trip and its exceptions

A snapshot is written so that applying it changes nothing and checking it reads clean. The harness proves that for every supported section on every change (`test/sections/snapshot-roundtrip.test.ts` and the per-section `*-snapshot-roundtrip` scenarios). The exceptions are the values GitHub does not read back, each named in the file header:

| Exception | Why | What the file holds |
|---|---|---|
| Secret values | GitHub returns names only | A `$NAME` reference and a note per secret |
| `webhooks[].config.secret` | GitHub echoes `********` | A `$WEBHOOK_SECRET_N` reference and a note per hook |
| `interaction_limits.expiry` | GitHub reports only the computed `expires_at` | No `expiry` key; apply re-arms the limit with GitHub's default unless you declare one |
| `check_suite_preferences` | GitHub exposes no read endpoint | Nothing; the header says so |
| `collaborators`: the repository owner, email invitations | The owner's access is implicit, and an email invitation has no username to declare | No entry and a note each; apply leaves both alone |
| `collaborators`: expired invitations | A declared one would be cancelled and re-sent; an undeclared one is cancelled under the delete default the file carries | No entry and a note per invitation; add the entry to re-invite |
| A custom role named `push` or `pull` | In a settings file those words mean the `write` and `read` roles, so no declaration plans as the live role | `collaborators` fails and the file is written without it; `teams` omits the team with a note |
| `teams`: access granted at the organization or enterprise level | Declaring it would grant direct repository access on top | No entry and a note; apply leaves it alone |
| Sections the snapshot does not read back yet | Not implemented for that section | Nothing; the header lists each, and the run notices them |

A section that exists but holds nothing live (no milestones, no Pages site) is omitted with a header line, never written as an empty list: an empty list under `_undeclared: delete` would delete on apply.

## Many repositories

`snapshot-dir` writes one file per target in the layout `repos-dir` reads, `<snapshot-dir>/<owner>/<name>.yml`. The targets come from `repos` and `repos-dir` exactly as in a [multi-repo](multi-repo.md) apply, `repos: "*"` discovery and its filters included; `defaults-file` has no meaning here and is rejected.

```yaml
name: Snapshot the fleet
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.FLEET_TOKEN }}
          mode: snapshot
          snapshot-dir: snapshots
          repos: "*"
          archived: skip
      - uses: actions/upload-artifact@v4
        with:
          name: fleet-snapshots
          path: snapshots
```

Copy the directory in as your `repos-dir` to bring the fleet under management, one reviewable file per repository. The step summary lists every target with its result and file, then one section table per target, and the `repos-result` output carries the per-repository results as JSON.

Private and internal targets are redacted by default, exactly as in a multi-repo apply (see [private repositories](private-repositories.md)): their file is written like the others, but the public surfaces know them only as `private repository #N`, with the file name and every detail hidden. Their notes are in their file header; there is no report channel in snapshot mode. The uploaded `snapshots` artifact therefore holds those targets' full documents in the clear, and an artifact inherits the admin repository's visibility, so on a public admin repository encrypt it or skip the upload (see [what redaction does and does not protect](private-repositories.md#what-redaction-does-and-does-not-protect)).

## Inputs in mode: snapshot

| Input | In `mode: snapshot` |
|---|---|
| `mode` | `snapshot` |
| `snapshot-file` | One repository: where its document is written (parent directories are created). Exactly one of `snapshot-file` and `snapshot-dir` is required. Must not be `.github/settings.yml`: the snapshot would overwrite the file you author, so write it beside that file and copy it over deliberately |
| `snapshot-dir` | Many repositories: the directory receiving one `<owner>/<name>.yml` per `repos` or `repos-dir` target. Must be disjoint from the `repos-dir` (not the same directory, not above it, not below it): the snapshots would overwrite the central files or be read back as central files on the next run |
| `repository` | With `snapshot-file`: the target, defaulting to the current repository. Rejected with `snapshot-dir` |
| `repos`, `repos-dir`, `visibility`, `archived`, `forks`, `exclude`, `topics`, `affiliation` | With `snapshot-dir`: the targets and the discovery filters, as in multi-repo mode. Rejected with `snapshot-file` |
| `sections` | The allowlist of sections to read back; every other section is left out of the file |
| `on-missing-permission` | `fail` (default) fails the run on a section the token cannot read, and no file is written for that target; `warn` skips the section with a warning and writes the rest |
| `private-repos` | `redact` (default) hides private and internal targets from the public surfaces; `show` reveals them |
| `token`, `api-version` | The API calls, as in every mode that reaches GitHub |
| `settings-file`, `merged-file`, `layering`, `required-sections`, `defaults-file`, `private-report`, `report-public-key` | Rejected when set to a non-default value: a snapshot applies no document, folds no layers, and delivers no report |

## Results and exit codes

| `result` | Exit | Meaning |
|---|---|---|
| `snapshot` | 0 | Every target read fully back and its file was written |
| `partial` | 0 | A section was skipped under `on-missing-permission: warn`, or failed on its own; the file omits it, the header says why, and `skipped-sections` lists the skipped ones |
| `failed` | 1 | A target failed: a denial under `fail`, an unwritable path, or a value a section's own schema rejects (a bug, reported as such). No file is written for a failed target |

In the `snapshot-dir` form the worst result across targets decides, and `repos-result` maps each target to its own.
