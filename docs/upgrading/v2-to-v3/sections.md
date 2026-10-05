---
order: 4
title: "Per-section behavior"
---

# Upgrading from v2 to v3: per-section behavior

Sections 11, 12, 14, 15, 17, 19, and 20 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 11. Two live items under one identity fail the section

v2 picked one silently. The factory sections refused only a claimed pair; milestones, rulesets, webhooks, custom properties, secret scanning patterns, environment secrets and variables kept the last one listed; workflows matched the first; teams acted on both.

v3 refuses every live list the same way, whether or not the settings file declares the pair: the list sections, the nested environment lists, and the seven reads that had no guard before. Those seven are the teams listing, the workflows listing, the environment listing, the pinned environments, the protected-branch listing, the GraphQL protection rules, and the protection-rule Apps an environment can enable.

Each pair is named the same way, the key first and the server id beside it when one exists:

```text
webhooks: GitHub holds webhooks that resolve to one identity: "https://ci.example.com/hook (hook id 11)" and "https://ci.example.com/hook (hook id 12)". This section manages one webhook per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again
```

Snapshot says the same. Delete the duplicates on GitHub, then re-run. The protection-rule Apps list is the one read whose refusal can follow a write: for an environment the run creates, GitHub serves the list only once the environment's PUT has landed, so that refusal lands after it; for an existing environment it lands at plan, before any write.

## 12. The webhook snapshot placeholder leads with SECRET_

```yaml settings
webhooks:
  entries:
    - config:
        url: https://ci.example.com/hook
        secret: $SECRET_WEBHOOK_601   # v2 wrote $WEBHOOK_SECRET_601
```

Every snapshot secret now leads with `SECRET_`, the store name second. A file holding the old reference keeps working with its old export; to move, change the reference in the file and the exported variable together (`WEBHOOK_SECRET_601` becomes `SECRET_WEBHOOK_601` in both), or re-snapshot and export the new name.

## 14. Webhooks manage web hooks only

- A legacy service hook (`name` other than `web`) or a hook without a `config.url` is outside the section: plan neither matches, notes, nor deletes it (v2 deleted one under `_undeclared: delete`); snapshot leaves it out with a note.
- No write carries `name`: GitHub defaults a new hook to `web`, the one value the slice admits, and the update endpoint takes no name.
- A declared `insecure_ssl: 0` is written as GitHub stores it, the string `"0"`.
- A snapshot writes a hook's `config` keys in the order GitHub lists them, the `$SECRET_WEBHOOK_<id>` reference last.

## 15. A ruleset without `source_type` is repository-owned

v2 refused to delete an undeclared ruleset whose list entry lacked `source_type`, with a note. v3 reads a missing `source_type` as `Repository`, the only kind the repository endpoints can write, so `_undeclared: delete` deletes it.

## 17. teams takes the _undeclared knob

`teams` joins the sections that take the `{_undeclared, entries}` wrapper, with the default `keep`: a team with direct access that the file does not name is left alone, as before. What changes:

- Every apply and check now lists the repository's teams (`GET /repos/{owner}/{repo}/teams`; the same Administration grant) and prints one note per undeclared direct team, naming the knob.
- `_undeclared: delete` revokes the direct grants the file does not name (`DELETE /orgs/{org}/teams/{slug}/repos/{owner}/{repo}`). Access granted at the organization or enterprise level is never touched; under `delete` it is noted as beyond the repository's reach.
- `mode: snapshot` and `gsac init` write the wrapper form with `_undeclared: keep` spelled out, as the other knobbed sections do.

The plain array form keeps working, and the [undeclared policy](../../reference/undeclared-policy.md) page lists the default beside the others.

## 19. The sealing key is read at apply time

Every secret family (`actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, `agents_secrets`) now reads `GET .../secrets/public-key` from the first sealed PUT, as environment secrets always did.

- Check mode issues one request fewer per family and never touches the key endpoint.
- A malformed key fails the first PUT at apply, before its request leaves, where v2 failed the plan in check mode too.
- The cannot-verify note carries the section label and the shared template: `actions_secrets: Actions secret values cannot be read back from GitHub, so check mode cannot verify them, only that each declared secret exists; apply re-seals and rewrites every declared value on every run`.

## 20. Environment secrets and variables plan through the shared engines

Their lines are the engines' lines now:

| Line | v2 | v3 |
|---|---|---|
| A missing declared variable | `environments[prod].variables[X]: missing - declared in the settings file but not on the environment; ...` | `... but not on environment "prod"; ...` |
| A variable delete | `DELETED undeclared variable "X" from environment "prod"` | `DELETED undeclared variable "X" in environment "prod"` |
| Two entries naming one variable or secret | `environments: the "prod" entry declares variables that GitHub treats as the same variable ...` | `environments: the settings file declares entries that name the same variable of the "prod" environment: "a" and "A". Keep exactly one entry per resource` (branch policies and protection rules spell theirs the same way) |
| The secrets cannot-verify note | once per environment that exists | once per environment with declared secrets, the missing environment included, under the `environments[prod].secrets` label |

Repository variable operations (`actions_variables`, `agents_variables`) gain a describe line in failure prose (`creating Actions variable "X"`); nothing else moves.
