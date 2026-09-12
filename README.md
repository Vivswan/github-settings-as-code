# GitHub Settings as Code

Apply declarative repository settings from `.github/settings.yml`: a loud, stateless replacement for the [Probot Settings app](https://github.com/repository-settings/app) that also manages [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) (branch, tag, and push). Every apply is a visible workflow run that fails with the API's error message; nothing happens silently. The full documentation lives in [docs/](docs/README.md).

## Quick start

1. Create a [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) from the [pre-filled token form][pat-form] and save it as the `ADMIN_TOKEN` repository secret. The form starts with every repository permission the action can need (an organization owner adds Members: read by hand); the default `GITHUB_TOKEN` can never hold them.

2. Add `.github/settings.yml`. The first line gives editor autocomplete and hover docs:

   ```yaml
   # yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v2/lib/settings.schema.json # x-release-please-major

   repository:
     description: My project
     delete_branch_on_merge: true

   labels:
     - name: bug
       color: "d73a4a"
   ```

3. Add the workflow and run it from the Actions tab.
   - Keep `mode: check` for the first run: the drift report lists everything an apply would change or delete, and nothing is written.
   - Read the report. An apply deletes undeclared labels, autolinks, collaborators, Actions variables, and Copilot agents variables.
   - Drop the `mode: check` line once the report says what you expect. The [getting started guide](docs/start/getting-started.md) explains the drift output; [Snapshot mode](docs/operate/snapshot.md) writes an existing repository's live settings as the file to start from.

   ```yaml
   # .github/workflows/settings.yml
   name: Apply Settings
   on:
     push:
       branches: [main]
       paths: [.github/settings.yml]
     workflow_dispatch:

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
             mode: check
   ```

## Versioning

| Pin | Points at | Use it for |
|---|---|---|
| `@v2` <!-- x-release-please-major --> | The newest release in the major line, so fixes arrive without changing your pin | Production |
| `@vX.Y.Z` or a commit SHA | One release, frozen by a ruleset | Byte-stable behavior |
| `@latest` | The newest green `main` commit, packaged; breaking changes arrive here unannounced, ahead of any release | Trying unreleased fixes |

- Every pin points at a packaged commit on the `build` branch: its source commit's tree without `.github/workflows/`, plus the built action. `main` is source-only and not runnable as an action. The tags up to v2.0.0 point at release commits on `main` from when `main` still committed the bundle.
- v2 activates settings keys that were inert on v1: `actions.oidc_customization_sub`, `actions.fork_pr_contributor_approval`, `actions.fork_pr_workflows_private_repos`, and `branches[].protection.required_signatures`. Audit them before moving a `@v1` pin; a stale `required_signatures: false` would remove a hand-enabled requirement.
- Only the latest release is supported; fixes are not backported (see [SECURITY.md](.github/SECURITY.md)). Each major has an [upgrade guide](docs/upgrading/README.md).

## Library

The same engine is the npm package `@vivswan/github-settings-as-code` (ESM, Node 22.14 or newer): validate, merge, check, and apply from your own code.

- `npm install @vivswan/github-settings-as-code` installs the released version; `@next` installs the newest green `main` commit as a pre-release. The [library reference](docs/reference/library.md) has the API by group and the versioning rules.
- `npx @vivswan/github-settings-as-code@next check --repository o/r --settings-file .github/settings.yml` runs the action's check from a terminal. The [command line guide](docs/start/cli.md) has every command.

## Docs

| Goal | Read |
|---|---|
| Get one repository under management | [Getting started](docs/start/getting-started.md) |
| Copy a settings.yml shape | [Examples](docs/start/examples.md) |
| Look up what a section manages and deletes | [Sections](docs/reference/sections.md) |
| Look up an input or output | [Inputs and outputs](docs/reference/inputs.md) |
| Predict what an apply or a check will do | [Semantics](docs/reference/semantics.md) |
| Scope the token | [Token permissions](docs/reference/permissions.md) |
| Decide what happens to resources the file does not declare | [The undeclared policy](docs/reference/undeclared-policy.md) |
| Feed secret values from GitHub Secrets or a vault | [Secrets and vaults](docs/reference/secrets-and-vaults.md) |
| Detect drift without changing anything | [Check mode](docs/operate/check-mode.md) |
| Manage a fleet from one repository | [Multi-repo mode](docs/operate/multi-repo.md) |
| Layer settings files and fold them with `mode: merge` | [Layering settings files](docs/operate/layering.md) |
| Keep private targets out of public logs | [Private repositories](docs/operate/private-repositories.md) |
| Replace the Probot Settings app | [Migrating from Probot](docs/start/migrating-from-probot.md) |
| Adapt a complete platform-team workflow | [Playbooks](docs/playbooks/README.md) |
| Read a failing run | [Troubleshooting](docs/operate/troubleshooting.md) |
| Move a pin to a new major | [Upgrading](docs/upgrading/README.md) |
| See how the code is laid out | [Architecture](docs/reference/architecture.md) |
| Use the engine from your own code | [Library](docs/reference/library.md) |
| Run check, apply, or validate from a terminal | [Command line](docs/start/cli.md) |

## Contributing

The toolchain, the end-to-end harness, and the PR conventions are in [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the [Individual and Small Organization License](LICENSE.md).

<!-- BEGIN GENERATED: readme-pat-url (bun run build:docs; derived from RESOURCE_SLUGS in src/sections/contract/permissions.ts) -->
[pat-form]: https://github.com/settings/personal-access-tokens/new?name=github-settings-as-code&description=Token+for+Vivswan%2Fgithub-settings-as-code&administration=write&issues=write&environments=write&pages=write&actions=write&actions_variables=write&repository_hooks=write&checks=write&secrets=write&dependabot_secrets=write&codespaces_secrets=write&agent_secrets=write&agent_variables=write&repository_custom_properties=write&secret_scanning_alerts=write&contents=read
<!-- END GENERATED: readme-pat-url -->
