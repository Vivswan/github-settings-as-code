---
order: 160
---

# Forward compatibility

GitHub ships new settings fields faster than any wrapper can track them, so this action is passthrough-first by design. Payloads are sent to the API verbatim except for documented normalizations (ref prefixes, topics splitting, vocabulary mapping), and new fields and rule types GitHub ships work the day they exist: declare them in `settings.yml`, no action update needed.

This page draws the line: where the passthrough tenet holds, and where a shape is deliberately closed.

The passthrough is the default: every section not named in the closed list below accepts fields it does not recognize and sends them through. The richest passthrough sections are `rulesets` (new rule types, bypass-actor fields, condition types), `repository`, `branches`, `environments`, `actions`, `pages`, and `code_scanning_default_setup`.

The published JSON Schema follows the same tenet. It is documentation, not a gate, so unknown fields validate on purpose: declaring a field GitHub ships tomorrow must never read as an error.

Two deliberate boundaries:

- A brand-new top-level settings *category* needs a handler: a new API endpoint cannot be guessed, so unknown sections fail loudly rather than no-op.
- The pinned `X-GitHub-Api-Version` only changes intentionally.

## The closed sections

Nine sections are closed rather than passthrough: `collaborators`, `teams`, `workflows`, `custom_properties`, `secret_scanning_custom_patterns`, and the secret sections `actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, and `agents_secrets` reject entry keys they do not recognize.

Their API calls carry at most the declared fields per entry (a `permission`, a property `value`, a sealed secret value, or a pattern's own fields; the workflow enable/disable calls carry none), so an extra key can only be a typo. Two typos a passthrough would have accepted silently:

- **A misspelled `permission`** would grant the default `push` role and never show up as drift.
- **A pattern's `state` and `push_protection_enabled`** are read-only through the custom-pattern endpoints and would do nothing.

A few nested shapes are strict for the same reason:

- **The actions section's `cache` object.** Each key of it is the entire body of its own endpoint, so an unrecognized cache key has nowhere to go and is rejected upfront; the rest of that section stays passthrough.
- **The `secrets` and `deployment_protection_rules` entries inside a declared environment.** Their write bodies are built from the named fields alone, so an extra entry key would silently do nothing.

The wrapped form of the list sections is strict the same way: its keys are this action's own vocabulary, never sent to GitHub, so any other wrapper key is rejected upfront as a typo. The [undeclared policy page](undeclared-policy.md) is the one place that lists them.
