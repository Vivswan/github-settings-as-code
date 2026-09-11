---
order: 110
---

# Sections

Every top-level key a settings file can declare, one row per section: the endpoints it drives, the fine-grained PAT permission it needs, what happens to the live resources the file does not declare, and the notes that matter when declaring it.

<!-- BEGIN GENERATED: sections-table (bun run build:docs; edit src/sections/<key>/<key>.docs.yml) -->
| Section | Endpoints | PAT permission | Undeclared default | Notes |
|---|---|---|---|---|
| `repository` | PATCH repo, PUT topics, vulnerability-alerts, automated-security-fixes, private-vulnerability-reporting, lfs, immutable-releases, GraphQL RepositoryFeatures + UpdateRepositoryFeatures | Administration: write | untouched | Probot repository payload plus `enable_*` feature toggles; `topics` as string or list; `enable_sponsorships` and `issue_creation_policy` (`all`/`collaborators_only`) route through GraphQL - REST has no surface for them; declared fields only, undeclared siblings untouched |
| `labels` | labels CRUD | Issues: write | deleted (settable) | upsert by name (rename via `new_name`); the delete-by-default is Probot parity |
| `rulesets` | repo rulesets CRUD | Administration: write | kept (settable) | branch, tag, and push targets; short ref names auto-prefixed (`staging` -> `refs/heads/staging`); deletion stays an explicit opt-in |
| `environments` | PUT environments + per-environment variables, secrets, deployment branch policies, deployment protection rules, and pins (GraphQL EnvironmentPins + PinEnvironment + ReorderEnvironment) | Environments: write; declared `deployment_branch_policies` and `deployment_protection_rules` keys additionally need Actions: read and Administration: write | untouched | reviewers, wait timer, branch-policy flags; nested `variables`, `secrets`, `deployment_branch_policies`, and `deployment_protection_rules` keys reconcile per environment, each with its own `_undeclared:` knob (within a declared key, undeclared variables and branch-policy patterns are deleted; secrets and protection rules are kept); a `pinned` key pins the environment on the home page's deployments sidebar over GraphQL (declaration order sets the pin order, max 10 pins; environments without the key are never unpinned) |
| `branches` | classic branch protection + required-signatures sub-endpoint + app-by-slug actor lookup + GraphQL BranchProtectionRules + BranchProtectionRepository + BranchProtectionActorUser + BranchProtectionActorTeam + CreateBranchProtectionRule + UpdateBranchProtectionRule + DeleteBranchProtectionRule | Administration: write | untouched | `protection: null` removes protection; the protection PUT drops `required_signatures`, so declare it on any branch already carrying it; `force_push_bypassers` (users, `org/team`, `app/slug`) and `required_deployments` ride the GraphQL rule mutation; wildcard entries (`release/*`) reconcile entirely through GraphQL with a fixed key set; add Contents: read so check mode can tell a missing branch from an unprotected one |
| `autolinks` | autolinks CRUD | Administration: write | deleted (settable) | immutable upstream, so changed entries are replaced |
| `actions` | actions permissions + selected-actions + workflow token + access level + artifact/log retention + cache limits + OIDC subject claim + fork PR policies | Administration: write; the `oidc_customization_sub` key alone instead needs Actions: write | untouched | keys with their own sub-endpoint route there; everything else rides the base permissions PUT verbatim |
| `actions_secrets` | actions secrets list + public-key + sealed PUT + delete | Secrets: write | kept (settable) | `{name, value: $NAME}` sealed writes, re-sent every apply; existence-only checks, values unrecoverable |
| `dependabot_secrets` | dependabot secrets list + public-key + sealed PUT + delete | Dependabot secrets: write | kept (settable) | as `actions_secrets`, over the Dependabot secret store |
| `codespaces_secrets` | codespaces secrets list + public-key + sealed PUT + delete | Codespaces secrets: write | kept (settable) | as `actions_secrets`, over the Codespaces secret store |
| `agents_secrets` | agents secrets list + public-key + sealed PUT + delete | Agent secrets: write | kept (settable) | as `actions_secrets`, over the Copilot agents secret store |
| `workflows` | Actions workflows list, enable/disable | Actions: write | untouched | `{path, state: active or disabled}`; bare file names match `.github/workflows/` |
| `check_suite_preferences` | check-suites preferences PATCH (no read endpoint exists upstream) | Checks: write | untouched | per-app `auto_trigger_checks` toggles; write-only: check mode cannot verify them (one note, zero requests) and apply re-asserts them every run; the token owner must be a repository administrator |
| `pages` | POST/PUT/DELETE pages | Pages: write | untouched | `build_type: workflow` or `legacy` + source, `cname`, `https_enforced`, `public` (GHEC site visibility); `pages: null` disables the site |
| `code_scanning_default_setup` | code scanning default setup | Administration or Code scanning alerts: write | untouched | `state`, `query_suite`, `languages`; needs Advanced Security on private repositories |
| `code_quality_setup` | code-quality setup | Administration: write | untouched | `state`, `languages`, runner and AI-findings options; a 202 means GitHub rolls the change out in a configuration run; needs code quality available on the repository |
| `collaborators` | direct collaborators + pending invitations | Administration: write | deleted (settable) | invitations for new users, pending ones reconciled (stale permission updated, expired re-sent, undeclared cancelled); the repository owner is never touched |
| `teams` | org team repo permissions | Members: read (org permission) + Administration: write | untouched | org repos only, skipped with a notice on personal accounts |
| `milestones` | milestones | Issues: write | kept (settable) | upsert by title; deleting a milestone detaches it from every issue carrying it, which is why keep is the default |
| `interaction_limits` | interaction-limits + pulls creation-cap/bypass-list | Administration: write | untouched | re-arms the self-expiring limit every apply run; `null` clears it (base limit only); a 409 (org/user-level limit overrides) becomes a note; the PR creation cap is persistent (PATCHed only on divergence, 405 where unavailable) and its bypass logins reconcile add/remove |
| `actions_variables` | Actions variables CRUD | Variables: write | deleted (settable) | plain-text variables upserted by name (case-insensitive); values read back in full, so check mode diffs them exactly |
| `agents_variables` | Copilot agents variables CRUD | Agent variables: write | deleted (settable) | as `actions_variables`, over the Copilot agents variable store |
| `webhooks` | hooks CRUD + hook config sub-endpoint | Webhooks: write | kept (settable) | one hook per `config.url`, the natural key; `config.secret` takes a `$NAME` reference and is re-sent every run |
| `custom_properties` | GET/PATCH properties/values; probes GET /orgs/{owner} | Custom properties: write | kept (settable) | values of org-defined properties (definitions are org-scoped); org repos only, skipped with a notice on personal accounts; `value: null` unsets |
| `deploy_keys` | deploy keys list/create/delete | Administration: write | kept (settable) | matched by title; the declared material is a PUBLIC key; immutable upstream, so changed entries are replaced |
| `secret_scanning_custom_patterns` | secret-scanning custom patterns: paginated list + bulk POST + PATCH by id + bulk DELETE | Secret scanning alerts: write | kept (settable) | matched by name (immutable upstream); `state` and `push_protection_enabled` are not declarable; deletes always resolve alerts |
<!-- END GENERATED: sections-table -->

## The Undeclared default column

What happens to a live resource the settings file does not declare:

| Value | Meaning |
|---|---|
| `deleted (settable)` | An undeclared resource is deleted on apply, so the declared list is the complete inventory. |
| `kept (settable)` | An undeclared resource is left in place; only declared entries are compared and written. |
| `untouched` | Undeclared top-level entries are neither compared nor changed; only declared keys are applied. A nested list inside a declared entry (an environment's variables, say) has its own default, named in the Notes cell. |

`(settable)` means the wrapped `_undeclared:` form overrides the default per file. [The undeclared policy](undeclared-policy.md) covers the knob and how it layers with a multi-repo defaults file.

## Where to read next

- [Semantics](semantics.md): the model every section shares (stateless, declared-keys-only, convergent applies, loud failures).
- [Forward compatibility](forward-compatibility.md): which sections pass payloads through verbatim and which are closed.
- [COVERAGE.md](https://github.com/Vivswan/github-settings-as-code/blob/main/COVERAGE.md): every row above expanded with its exact endpoints, semantics, and caveats, plus the gaps.
