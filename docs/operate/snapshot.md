---
order: 215
---

# Snapshot mode

`mode: snapshot` reads a repository's live settings back and writes them as a settings file. Nothing is written to GitHub, and the document reaches only the file: the log, the step summary, and the outputs carry section names, statuses, and the notes a check run prints for the same repository (a secret's name, a webhook's URL), never the document and never a secret's value.

Use it to start managing a repository from what it has today, to keep a backup before an apply, or to bring a fleet under `repos-dir` management one file per repository.

From a terminal, `gsac init --repository owner/name` is that first use in one step: it writes the snapshot to `.github/settings.yml` (the destination `snapshot-file` refuses) and prints the PAT grant the file needs.
See [the command line](../start/cli.md#init).

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
- Then one comment line per note, in code-point order within each section: a secret whose value GitHub never reveals, a section the snapshot cannot read back, a section with nothing live to declare. The same notes appear as annotations on the run, exactly as a check run would print them, so a note names a secret or a webhook by its name or URL and never by a value.
- The document follows in the one canonical order every rendered document has (`mode: render` writes the same one): the sections in the order the action applies them, each section's keys as the schema declares them, the entries of every keyed list sorted by their identity (a label's `name`, a webhook's `config.url`, a deploy key's `title`; `branches` keep their order, since GitHub applies overlapping wildcard rules in creation order, pinned environments keep theirs, since it is the pin rank, and the next paragraph names the lists with no identity), every knobbed list section (the sections [the undeclared policy](../reference/undeclared-policy.md) counts) in its `{_undeclared, entries}` wrapper form with the section's default policy spelled out, and `environments`, `branches`, and `workflows` as bare lists, since their wrapper takes no policy. An apply from the file does exactly what the header says, and two snapshots of one repository are the same bytes. The lists left as written keep the order GitHub lists them in: the mapping lists with no identity (`bypass_actors`, `reviewers`), the values inside a rule's `parameters` (`required_status_checks`), and every scalar list (`topics`, a webhook's `events`, a ruleset's `include` patterns). Byte-identical output holds for them while GitHub returns each in a stable order, as it does today; the one scalar list a section sorts itself is `force_push_bypassers`.
- Nothing in the file names the moment it was taken: the run's notice (`snapshot taken 2026-09-11T06:17:00.000Z`) and the step summary carry it, so a snapshot of an unchanged repository rewrites the file byte for byte and a diff between two snapshots shows only what changed on GitHub.

## The `$NAME` placeholders

GitHub never returns a secret's value, so the file cannot hold one. The snapshot writes a reference instead, and the note tells you which variable to export before an apply or check runs the file:

| What GitHub hides | What the file holds | What to export |
|---|---|---|
| A repository Actions secret named `DEPLOY_TOKEN` | `value: $SECRET_ACTIONS_DEPLOY_TOKEN` | `SECRET_ACTIONS_DEPLOY_TOKEN` |
| The same name in another store (`dependabot_secrets`, `codespaces_secrets`, `agents_secrets`) | `$SECRET_DEPENDABOT_DEPLOY_TOKEN`, `$SECRET_CODESPACES_DEPLOY_TOKEN`, `$SECRET_AGENTS_DEPLOY_TOKEN` | One variable per store, so two stores holding the same name never share a value by accident |
| A webhook's `config.secret`, one per hook | `secret: $SECRET_WEBHOOK_601` | `SECRET_WEBHOOK_<id>`, the hook's own id, so the reference survives a reordering |
| An environment secret named `DEPLOY_TOKEN` in the `production` environment | `value: $SECRET_ENVIRONMENT_PRODUCTION_DEPLOY_TOKEN` | `SECRET_ENVIRONMENT_<ENV>_<NAME>`, the environment name uppercased with every other character folded to `_`, so same-named secrets in two environments get two variables; two names the fold collapses (`prod-eu`, `prod_eu`) share one, and a header line names the entries to edit |

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

A second snapshot after the apply diffs against the first with only the applied change showing: an unchanged repository re-snapshots to the same bytes, since the file carries no timestamp and every section, key, and list entry sits in the canonical order. A clean re-snapshot produces no diff at all, which makes a committed snapshot a drift detector of its own.

## The round trip and its exceptions

A snapshot is written so that applying it changes nothing and checking it reads clean. The harness proves that for every supported section on every change (`test/sections/snapshot-roundtrip.test.ts` and the per-section `*-snapshot-roundtrip` scenarios). The exceptions are the values GitHub does not read back, each named in the file header:

| Exception | Why | What the file holds |
|---|---|---|
| Secret values | GitHub returns names only | A `$NAME` reference and a note per secret |
| `webhooks[].config.secret` | GitHub echoes `********` | A `$SECRET_WEBHOOK_<id>` reference and a note per hook |
| `interaction_limits.expiry` | GitHub reports only the computed `expires_at` | No `expiry` key; apply re-arms the limit with GitHub's default unless you declare one |
| `check_suite_preferences` | GitHub exposes no read endpoint | Nothing; the header says so |
| `repository.name` | The repository's identity: a reused file would rename its target | Nothing |
| `repository.<field>` GitHub reports as null | No declarable value | Nothing for that field |
| `repository.security_and_analysis.<sub-key>` the PATCH does not accept | Read-only state (dependabot_security_updates is `enable_automated_security_fixes`' own) | Only the PATCHable sub-keys |
| `repository.enable_immutable_releases` under owner enforcement | GitHub answers 409 to both writes | `true`, with a header line saying apply cannot change it from the repository |
| `repository.enable_git_lfs` | GitHub exposes no read endpoint | Nothing; the header says so, and apply re-asserts the declared value on every run |
| `repository.enable_*` toggles under a token whose every toggle probe answers 404 | A fine-grained token missing the Administration grant is answered like a disabled toggle | Nothing for the four toggles, under one header line |
| `actions.<key>` the token cannot read, under `on-missing-permission: warn` | A sub-endpoint has its own grant (the OIDC template needs Actions) | Nothing for that key; the header names it, and the other keys read back. Under `fail` the section fails instead: [what a denial does](#what-a-denial-does) |
| `rulesets[]` whose `bypass_actors` the token cannot see | GitHub returns the list only to a write-grade token | No entry (kept under `_undeclared: keep`) and a header line; an entry without the list would clear it on the next update |
| Organization and enterprise rulesets | Inherited, not the repository's to manage | Nothing; a header line names each |
| `branches[].protection.force_push_bypassers` empty, `required_deployments` off, `environments[].pinned` false | These GraphQL-routed keys leave the live value untouched when omitted (the REST keys reset it), so an empty or off state has nothing to pin | No key; declare `force_push_bypassers: []`, `required_deployments: null`, or `pinned: false` to have check report a later change |
| A `branches` rule with a literal pattern and no branch of that name | A literal entry applies through the protection PUT, which needs the branch | No entry and a header line naming the pattern; create the branch, then snapshot again |
| A branch only a wildcard rule protects | GitHub serves the rule's protection under the branch's name; a literal entry would create a second rule on apply | The wildcard entry alone (`release/*`), never the branch |
| `collaborators`: the repository owner, email invitations | The owner's access is implicit, and an email invitation has no username to declare | No entry and a note each; apply leaves both alone |
| `collaborators`: expired invitations | A declared one would be cancelled and re-sent; an undeclared one is cancelled under the delete default the file carries | No entry and a note per invitation; add the entry to re-invite |
| A custom role named `push` or `pull` | In a settings file those words mean the `write` and `read` roles, so no declaration plans as the live role | `collaborators` fails and the file is written without it; `teams` omits the team with a note |
| `teams`: access granted at the organization or enterprise level | Declaring it would grant direct repository access on top | No entry and a note; apply leaves it alone |

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

Private and internal targets are redacted by default, through the same seal a multi-repo apply closes its targets with (see [private repositories](private-repositories.md#one-seal-every-mode)): their file is written like the others, but the public surfaces know them only as `private repository #N`, with the file name, the notes, and every detail hidden; a private target that fails gets the same one-line annotation a fleet target gets. In the `snapshot-file` form a target other than the current repository is redacted the same way, as `private repository #1`. Their notes are in their file header; there is no report channel in snapshot mode. The uploaded `snapshots` artifact therefore holds those targets' full documents in the clear, and an artifact inherits the admin repository's visibility, so on a public admin repository encrypt it or skip the upload (see [what redaction does and does not protect](private-repositories.md#what-redaction-does-and-does-not-protect)).

## What a denial does

A denial is a read the token's grants refuse. Where it lands decides what `on-missing-permission` does with it:

| Denied read | `fail` (default) | `warn` |
|---|---|---|
| A section's main read (the labels list, the Actions permissions) | The section fails; the run fails with exit 1 and writes no file | The section is skipped with a warning and listed in `skipped-sections`; the rest is written |
| A key the section reads on its own (an `actions` key such as the OIDC template or a cache limit; an environment's branch policies or protection rules) | The same: the section fails and no file is written | That key alone is left out under a header line; the rest of its section reads back |

Under both policies the error or the header line names the grant to add.

## Inputs in mode: snapshot

| Input | In `mode: snapshot` |
|---|---|
| `mode` | `snapshot` |
| `snapshot-file` | One repository: where its document is written (parent directories are created). Exactly one of `snapshot-file` and `snapshot-dir` is required. Must not be `.github/settings.yml`: the snapshot would overwrite the file you author, so write it beside that file and copy it over deliberately |
| `snapshot-dir` | Many repositories: the directory receiving one `<owner>/<name>.yml` per `repos` or `repos-dir` target. Must be disjoint from the `repos-dir` (not the same directory, not above it, not below it): the snapshots would overwrite the central files or be read back as central files on the next run |
| `repository` | With `snapshot-file`: the target, defaulting to the current repository. Rejected with `snapshot-dir` |
| `repos`, `repos-dir`, `visibility`, `archived`, `forks`, `exclude`, `topics`, `affiliation` | With `snapshot-dir`: the targets and the discovery filters, as in multi-repo mode. Rejected with `snapshot-file` |
| `sections` | The allowlist of sections to read back; every other section is left out of the file |
| `on-missing-permission` | `fail` (default) fails the run on a read the token is denied, and no file is written for that target; `warn` reports the denial and writes what did read. What each policy does per read: [what a denial does](#what-a-denial-does) |
| `private-repos` | `redact` (default) hides private and internal targets from the public surfaces; `show` reveals them |
| `token`, `api-version` | The API calls, as in every mode that reaches GitHub |
| `settings-file`, `rendered-file`, `layering`, `required-sections`, `defaults-file`, `private-report`, `report-public-key` | Rejected when set to a non-default value: a snapshot applies no document, folds no layers, and delivers no report |

## Results and exit codes

| `result` | Exit | Meaning |
|---|---|---|
| `snapshot` | 0 | Every target read fully back and its file was written |
| `partial` | 0 | A section was skipped under `on-missing-permission: warn`; the file omits it, the header says why, and `skipped-sections` lists it |
| `failed` | 1 | A target failed: a denial on any read under `fail`, a section that failed on its own (an API error, a value its own schema rejects), or an unwritable path. No file is written for a failed target |

In the `snapshot-dir` form the worst result across targets decides, and `repos-result` maps each target to its own. The words and the exit rule are the ones every mode shares: [Inputs and outputs](../reference/inputs.md#outputs).
