---
order: 160
---

# Forward compatibility

GitHub ships new settings fields faster than any wrapper can track them, so this action is passthrough-first by design. Payloads are sent to the API verbatim except for documented normalizations (ref prefixes, topics splitting, vocabulary mapping), and new fields and rule types GitHub ships work the day they exist: declare them in `settings.yml`, no action update needed.

This page draws the line: where the passthrough tenet holds, and where a shape is deliberately closed.

The passthrough is the default: every section not named in the closed list below accepts fields it does not recognize and sends them through, outside the [closed nested shapes](#the-closed-nested-shapes) some of them hold. The richest passthrough sections are `rulesets` (new rule types, bypass-actor fields, condition types), `repository`, `branches`, `environments`, `actions`, `pages`, and `code_scanning_default_setup`.

The published JSON Schema follows the same tenet. It is documentation, not a gate, so unknown fields validate on purpose: declaring a field GitHub ships tomorrow must never read as an error.

Two deliberate boundaries:

- A brand-new top-level settings _category_ needs a handler: a new API endpoint cannot be guessed, so unknown sections fail loudly rather than no-op.
- The pinned `X-GitHub-Api-Version` only changes intentionally.

## The closed sections

Ten sections are closed rather than passthrough: `collaborators`, `teams`, `workflows`, `custom_properties`, `secret_scanning_custom_patterns`, the secret sections `actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, and `agents_secrets`, and `interaction_limits` reject keys they do not recognize.

The first nine are lists, and the key they refuse is an entry's. Their API calls carry at most the declared fields per entry (a `permission`, a property `value`, a sealed secret value, or a pattern's own fields; the workflow enable/disable calls carry none), so an extra key can only be a typo. Two typos a passthrough would have accepted silently:

- **A misspelled `permission`** would grant the default `push` role and never show up as drift.
- **A pattern's `state` and `push_protection_enabled`** are read-only through the custom-pattern endpoints and would do nothing.

`interaction_limits` is one mapping, and the key it refuses is its own: GitHub reports `origin` and `expires_at` beside the limit and accepts neither. Its `pull_request_creation_cap` stays passthrough.

## The closed nested shapes

These mappings inside passthrough sections are closed for the same reason. The rest of each section stays passthrough.

| Shape                                                   | Why an extra key is refused                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `actions.cache`                                         | Each key is the entire body of its own endpoint, so another key has nowhere to go                              |
| `actions.selected_actions`                              | The allowlist PUT documents its complete body, and a misspelled key would be re-sent on every run without note |
| `repository.security_and_analysis`                      | GitHub answers an unknown sub-key with a 422; each feature mapping and bypass reviewer under it is closed too  |
| `branches[].protection.required_status_checks.checks[]` | GitHub's protection PUT takes only `context` and `app_id` in a check item                                      |
| `branches[].protection.required_deployments`            | The rule mutation is built from `environments` alone                                                           |
| `environments[].secrets[]`                              | The write body is built from the sealed value alone                                                            |
| `environments[].deployment_protection_rules[]`          | The enable call sends only the App's resolved id                                                               |

The wrapped form of the list sections is strict the same way: its keys are this action's own vocabulary, never sent to GitHub, so any other wrapper key is rejected upfront as a typo. The [undeclared policy page](undeclared-policy.md) is the one place that lists them.
