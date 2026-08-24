# Secrets and vaults

Some settings are secrets. The first one this action manages is the webhook delivery secret (`webhooks[].config.secret`), and the problem it raises is general: `settings.yml` is a committed file, so a secret value can never be written into it, yet the API needs the real value at apply time.

The answer is a reference. A designated secret field takes a whole-value `$NAME` token, and the action resolves it from the environment of the step that runs it - the same place a workflow already keeps secrets.

```yaml settings
webhooks:
  - config:
      url: https://ci.example.com/hook
      content_type: json
      secret: $WEBHOOK_SECRET
    events: [push, pull_request]
    active: true
```

## The `$NAME` pattern

A reference is the ENTIRE field value: a dollar sign followed by an environment variable name (`A-Z`, `0-9`, `_`, not starting with a digit). Nothing else is accepted in a secret field:

- A literal value is rejected. Committed plaintext is exactly what the mechanism exists to prevent, so the run fails before anything is written.
- An embedded fragment like `prefix-$TOKEN` is rejected too. There is no interpolation; shipping the value as a partial literal would be worse than failing.
- Reserved runner variables are refused: a reference may not name anything starting with `INPUT_`, `GITHUB_`, `ACTIONS_`, `RUNNER_`, or `NODE_`, because routing workflow inputs or runner context into a settings value would turn the settings file into an exfiltration channel.

GitHub does not interpolate `${{ secrets }}` inside repository files, which is why the reference names an env var rather than a workflow expression.

## Wiring the environment

Define the variable on the action's step. From a repository or organization secret:

```yaml
name: Apply Settings
on:
  push:
    branches: [main]
    paths: [.github/settings.yml]

permissions:
  contents: read

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
        env:
          WEBHOOK_SECRET: ${{ secrets.WEBHOOK_SECRET }}
```

The same shape works with a vault: any action that exports secrets into the job environment feeds references without further plumbing. With [hashicorp/vault-action](https://github.com/hashicorp/vault-action), the `env_var` output names become the reference names:

```yaml
name: Apply Settings
on:
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/vault-action@v3
        with:
          url: https://vault.example.com
          method: jwt
          role: settings-as-code
          secrets: |
            secret/data/ci webhook_secret | WEBHOOK_SECRET
      - uses: Vivswan/github-settings-as-code@v2 # x-release-please-major
        with:
          token: ${{ secrets.ADMIN_TOKEN }}
```

Here the vault step exports `WEBHOOK_SECRET` into the job environment, and the settings file's `$WEBHOOK_SECRET` picks it up.

## What happens at run time

In apply mode, the action resolves every declared reference up front - after the read-only preflight, before the first write of any section. Resolution failures fail the repository cleanly with zero mutations:

- An UNSET variable fails, naming the reference and pointing at the step's `env` block.
- A SET-BUT-EMPTY variable also fails. An empty vault lookup must not write an empty secret, so a failed lookup cannot pass silently.

Every resolved plaintext is registered with the runner's secret masker before it is used anywhere, on top of the protections the client always applies to secret-bearing requests: debug traces show `***` in place of the value, and the response body of a failed secret-carrying request is withheld wholesale (an error body can echo the rejected value). The value itself never appears in a drift line, a change line, a note, or a report.

## Check mode verifies syntax only

`mode: check` never reads the environment. References are validated for shape and policy (whole-value, not reserved, right provenance), so a typo'd literal still fails a check run - but the variable does not need to exist where checks run, and the secret's VALUE is never verified. For webhooks specifically, GitHub echoes a stored secret as `********`, so no mode can compare it; apply re-sends the declared secret on every run, which is also how a rotated value propagates. Check mode says this out loud as a "cannot verify" note.

## Multi-repo: operator files only

References are honored only in settings sources the OPERATOR authors: the single-repo settings file, `repos-dir` files, and the `defaults-file`. A settings.yml fetched from a target repository (the `repos` input) is target-authored, and a reference there is a hard error: a target repository must not be able to route the operator's environment - and its secrets - into itself. Declare secret-bearing sections centrally when you manage a fleet.

## Repository Actions secrets

The `actions_secrets` section manages a repository's Actions secrets with the same references:

```yaml settings
actions_secrets:
  - name: DEPLOY_TOKEN
    value: $DEPLOY_TOKEN
  - name: NPM_TOKEN
    value: $PUBLISH_TOKEN
```

GitHub never returns a secret's value, only names and timestamps, so check mode reconciles EXISTENCE: a declared-but-missing secret is drift, and the declared values get one cannot-verify note. Apply seals every declared value client-side against the repository's public key and re-writes it on every run, which is also how a rotated vault value propagates. Undeclared secrets are kept by default - a deleted secret's value is unrecoverable - and the wrapped `undeclared: delete` form opts into deletion.

Unlike the variables sections, a secret entry accepts ONLY `name` and `value` - an unknown key is rejected upfront rather than passed through. That is not an inconsistency: a variables entry's body goes to GitHub verbatim, so an extra key rides along and GitHub decides; a secret's PUT body is built from the sealed value alone, so an extra key has no destination and would "apply" successfully forever while doing nothing.

## Dependabot, Codespaces, and Copilot agents secrets

Three sibling sections manage the other repository-level secret stores with the exact same shape and semantics: `dependabot_secrets` (private-registry credentials Dependabot uses when it resolves dependencies), `codespaces_secrets` (secrets exposed to development environments), and `agents_secrets` (the Copilot agents secret store). Each seals against its own public key and needs its own PAT permission - "Dependabot secrets", "Codespaces secrets", and "Agent secrets" respectively; note GitHub gates even the Codespaces secret reads at write access.

```yaml settings
dependabot_secrets:
  - name: PRIVATE_REGISTRY_TOKEN
    value: $PRIVATE_REGISTRY_TOKEN
codespaces_secrets:
  - name: DOTFILES_PAT
    value: $DOTFILES_PAT
agents_secrets:
  - name: AGENT_TOKEN
    value: $AGENT_TOKEN
```

Everything said about `actions_secrets` applies: existence-only checks, one cannot-verify note, re-seal on every apply, undeclared secrets kept unless the wrapped `undeclared: delete` form says otherwise.

## Environment secrets

Deployment environments carry their own secret store, managed as a nested `secrets` key on an `environments` entry - next to the `variables` key it mirrors:

```yaml settings
environments:
  - name: staging
    secrets:
      - name: DEPLOY_TOKEN
        value: $STAGING_DEPLOY_TOKEN
  - name: prod
    secrets:
      - name: DEPLOY_TOKEN
        value: $PROD_DEPLOY_TOKEN
```

Each environment is its own sealing scope with its own public key, so the same secret name can carry a different value per environment, as above. Reconciliation runs after the environment itself is applied; in check mode against an environment that does not exist yet, the declared secrets cannot be listed, so a note says they are unverifiable until apply creates it. Within a declared `secrets` key, live secrets the entries do not declare are kept by default (their values are unrecoverable); the wrapped `{undeclared: delete, entries}` form opts into deletion. The endpoints ride the same "Environments" PAT permission as the rest of the section.

## Multi-repo fan-out

In multi-repo mode a defaults file merges under every target the run processes. A defaults file that declares a secret section (`actions_secrets`, `dependabot_secrets`, `codespaces_secrets`, `agents_secrets`, or environment secrets) therefore writes those secrets into EVERY discovered target - which is sometimes exactly the point (a fleet-wide deploy key), and sometimes a surprise (a token fanned out to repositories that should never hold it). Scope discovery deliberately before declaring secrets in a defaults file: prefer an explicit `repos` list or tight discovery filters over `repos: "*"`, and run `mode: check` first to see which repositories the run would process and which declared secrets are missing where. Check mode verifies existence only - apply re-writes every declared secret on every run regardless, so a "clean" check still means those values will be sealed and sent.
