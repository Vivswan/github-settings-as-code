# GitHub Settings as Code

Apply declarative repository settings from `.github/settings.yml`: a loud, stateless replacement for the [Probot Settings app](https://github.com/repository-settings/app) that also manages [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) (branch, tag, and push). Every apply is a visible workflow run that fails with the API's error message; nothing happens silently. The full documentation lives in [docs/](docs/README.md).

## Quick start

1. Create a [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) from the [pre-filled token form][pat-form]: it starts with every repository permission the action can need (for an organization owner, add Members: read by hand). Save it as the `ADMIN_TOKEN` repository secret. The default `GITHUB_TOKEN` can never hold these permissions.

2. Add `.github/settings.yml`. The first line gives editor autocomplete and hover docs:

   ```yaml
   # yaml-language-server: $schema=https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v3/lib/settings.schema.json # x-release-please-major

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
   - Drop the `mode: check` line once the report says what you expect.

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
         - uses: Vivswan/github-settings-as-code@v3 # x-release-please-major
           with:
             token: ${{ secrets.ADMIN_TOKEN }}
             mode: check
   ```

The [getting started guide](docs/start/getting-started.md) walks the same steps with the drift output explained.

## Versioning

- `@v3` is a moving major tag: <!-- x-release-please-major --> every release in that major line moves it, so fixes arrive without changing your pin. Stable within the line; pin it for production.
- `@latest` is a moving tag on the `build` branch's packaged commit of the newest `main` source: main's newest green commit with the built action, reconciled at every release and, where the repository's own CI can push, at every green push. Breaking changes arrive there unannounced, ahead of any release. The tag exists from the first release cut on the `build` branch.
- Pin `@vX.Y.Z` (or a commit SHA) for byte-stable behavior. Version tags cut from the `build` branch onward point at a packaged commit carrying the built action, whose recorded source is the audited release commit on main. A ruleset freezes the tags.
- Packaged commits live on the `build` branch: each is its source commit's tree without `.github/workflows/`, plus the built action (consumers run the action, not this repository's workflows). The tags cut before that branch existed (v2.0.0 and earlier) point at release commits on `main` from when `main` still committed the bundle. `main` is source-only now and not runnable as an action.
- v2 activates settings keys that were inert on v1: `actions.oidc_customization_sub`, `actions.fork_pr_contributor_approval`, `actions.fork_pr_workflows_private_repos`, and `branches[].protection.required_signatures`. Audit them in your files before moving a `@v1` pin; a stale `required_signatures: false` would remove a hand-enabled requirement.
- Only the latest release is supported; fixes are not backported (see [SECURITY.md](.github/SECURITY.md)). Each major has an [upgrade guide](docs/upgrading/README.md).

## Library

The same engine is the npm package `@vivswan/github-settings-as-code` (ESM, Node 22.14 or newer): validate, merge, check, and apply from your own code. It is built from this repository with `bun run build:lib`; the [library reference](docs/reference/library.md) has the API by group.

The package is also a command: `npx @vivswan/github-settings-as-code@next check --repository o/r --settings-file .github/settings.yml` runs the action's check from a terminal; the [command line guide](docs/start/cli.md) has every command.

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

The toolchain, the end-to-end harness, and the PR conventions are in [CONTRIBUTING.md](CONTRIBUTING.md).

Licensed under the [Individual and Small Organization License](LICENSE.md).

<!-- BEGIN GENERATED: readme-pat-url (bun run build:docs; derived from RESOURCE_SLUGS in src/sections/contract/permissions.ts) -->
[pat-form]: https://github.com/settings/personal-access-tokens/new?name=github-settings-as-code&description=Token+for+Vivswan%2Fgithub-settings-as-code&administration=write&issues=write&environments=write&pages=write&actions=write&actions_variables=write&repository_hooks=write&checks=write&secrets=write&dependabot_secrets=write&codespaces_secrets=write&agent_secrets=write&agent_variables=write&repository_custom_properties=write&secret_scanning_alerts=write&contents=read
<!-- END GENERATED: readme-pat-url -->
