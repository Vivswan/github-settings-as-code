---
order: 115
---

# Coverage

<!-- BEGIN GENERATED: coverage (bun run build:docs; edit src/sections/<key>/<key>.docs.yml and .github/scripts/coverage-data.yml; REST pages come from the OpenAPI descriptor, the rest from .github/scripts/endpoint-docs.yml) -->
The tenet: this action can control everything about a repository and nothing about the user.

This page is the honest inventory: what works today, what is repo-scoped but not built yet, and what is out of scope because it belongs to a user or organization account.

Each Supported row lists the calls specific to that area, one link per call; a section's own reads and writes sit on its first row, and a row that rides those says so. The notes under the table carry the facts, one per bullet.

The side-by-side comparison with the Probot Settings app lives in the migration guide, under [Compared to the Probot Settings app](../start/migrating-from-probot.md#compared-to-the-probot-settings-app).

## Supported

| Area | Key in settings.yml | Endpoints |
|---|---|---|
| [Repository core settings](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) | [GET /repos/{owner}/{repo}](https://docs.github.com/en/rest/repos/repos#get-a-repository)<br>[PATCH /repos/{owner}/{repo}](https://docs.github.com/en/rest/repos/repos#update-a-repository) |
| [security_and_analysis](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`security_and_analysis`) | shares the calls of the Repository core settings row |
| [Forking policy](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`allow_forking`) | shares the calls of the Repository core settings row |
| [Topics](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`topics`) | [PUT /repos/{owner}/{repo}/topics](https://docs.github.com/en/rest/repos/repos#replace-all-repository-topics) |
| [Dependabot alerts](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`enable_vulnerability_alerts`) | [GET /repos/{owner}/{repo}/vulnerability-alerts](https://docs.github.com/en/rest/repos/repos#check-if-vulnerability-alerts-are-enabled-for-a-repository)<br>[PUT /repos/{owner}/{repo}/vulnerability-alerts](https://docs.github.com/en/rest/repos/repos#enable-vulnerability-alerts)<br>[DELETE /repos/{owner}/{repo}/vulnerability-alerts](https://docs.github.com/en/rest/repos/repos#disable-vulnerability-alerts) |
| [Dependabot security updates](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`enable_automated_security_fixes`) | [GET /repos/{owner}/{repo}/automated-security-fixes](https://docs.github.com/en/rest/repos/repos#check-if-dependabot-security-updates-are-enabled-for-a-repository)<br>[PUT /repos/{owner}/{repo}/automated-security-fixes](https://docs.github.com/en/rest/repos/repos#enable-dependabot-security-updates)<br>[DELETE /repos/{owner}/{repo}/automated-security-fixes](https://docs.github.com/en/rest/repos/repos#disable-dependabot-security-updates) |
| [Private vulnerability reporting](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`enable_private_vulnerability_reporting`) | [GET /repos/{owner}/{repo}/private-vulnerability-reporting](https://docs.github.com/en/rest/repos/repos#check-if-private-vulnerability-reporting-is-enabled-for-a-repository)<br>[PUT /repos/{owner}/{repo}/private-vulnerability-reporting](https://docs.github.com/en/rest/repos/repos#enable-private-vulnerability-reporting-for-a-repository)<br>[DELETE /repos/{owner}/{repo}/private-vulnerability-reporting](https://docs.github.com/en/rest/repos/repos#disable-private-vulnerability-reporting-for-a-repository) |
| [Git LFS enable/disable](https://docs.github.com/en/rest/repos/lfs) | [`repository`](sections.md) (`enable_git_lfs`) | [PUT /repos/{owner}/{repo}/lfs](https://docs.github.com/en/rest/repos/lfs#enable-git-lfs-for-a-repository)<br>[DELETE /repos/{owner}/{repo}/lfs](https://docs.github.com/en/rest/repos/lfs#disable-git-lfs-for-a-repository) |
| [Immutable releases](https://docs.github.com/en/rest/repos/repos) | [`repository`](sections.md) (`enable_immutable_releases`) | [GET /repos/{owner}/{repo}/immutable-releases](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)<br>[PUT /repos/{owner}/{repo}/immutable-releases](https://docs.github.com/en/rest/repos/repos#enable-immutable-releases)<br>[DELETE /repos/{owner}/{repo}/immutable-releases](https://docs.github.com/en/rest/repos/repos#disable-immutable-releases) |
| [Sponsor button](https://docs.github.com/en/graphql/reference/repos#mutation-updaterepository) | [`repository`](sections.md) (`enable_sponsorships`) | [GraphQL RepositoryFeatures](https://docs.github.com/en/graphql/reference/repos#object-repository)<br>[GraphQL UpdateRepositoryFeatures](https://docs.github.com/en/graphql/reference/repos#mutation-updaterepository) |
| [Issue creation policy](https://docs.github.com/en/graphql/reference/repos#input-object-updaterepositoryinput) | [`repository`](sections.md) (`issue_creation_policy`) | shares the calls of the Sponsor button row |
| [Labels](https://docs.github.com/en/rest/issues/labels) | [`labels`](sections.md) | [GET /repos/{owner}/{repo}/labels](https://docs.github.com/en/rest/issues/labels#list-labels-for-a-repository)<br>[POST /repos/{owner}/{repo}/labels](https://docs.github.com/en/rest/issues/labels#create-a-label)<br>[PATCH /repos/{owner}/{repo}/labels/{name}](https://docs.github.com/en/rest/issues/labels#update-a-label)<br>[DELETE /repos/{owner}/{repo}/labels/{name}](https://docs.github.com/en/rest/issues/labels#delete-a-label) |
| [Rulesets](https://docs.github.com/en/rest/repos/rules) | [`rulesets`](sections.md) | [GET /repos/{owner}/{repo}/rulesets](https://docs.github.com/en/rest/repos/rules#get-all-repository-rulesets)<br>[POST /repos/{owner}/{repo}/rulesets](https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset)<br>[GET /repos/{owner}/{repo}/rulesets/{ruleset_id}](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)<br>[PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset)<br>[DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}](https://docs.github.com/en/rest/repos/rules#delete-a-repository-ruleset) |
| [Merge queue](https://docs.github.com/en/rest/repos/rules) | [`rulesets`](sections.md) | shares the calls of the Rulesets row |
| [Tag protection (modern)](https://docs.github.com/en/rest/repos/rules) | [`rulesets`](sections.md) | shares the calls of the Rulesets row |
| [Classic branch protection](https://docs.github.com/en/rest/branches/branch-protection) | [`branches`](sections.md) | [GET /repos/{owner}/{repo}/branches/{branch}/protection](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)<br>[PUT /repos/{owner}/{repo}/branches/{branch}/protection](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection)<br>[DELETE /repos/{owner}/{repo}/branches/{branch}/protection](https://docs.github.com/en/rest/branches/branch-protection#delete-branch-protection)<br>[GET /repos/{owner}/{repo}/branches/{branch}](https://docs.github.com/en/rest/branches/branches#get-a-branch)<br>[GET /repos/{owner}/{repo}/branches](https://docs.github.com/en/rest/branches/branches#list-branches) |
| [Required signatures](https://docs.github.com/en/rest/branches/branch-protection#create-commit-signature-protection) | [`branches`](sections.md) (`required_signatures`) | [POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures](https://docs.github.com/en/rest/branches/branch-protection#create-commit-signature-protection)<br>[DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures](https://docs.github.com/en/rest/branches/branch-protection#delete-commit-signature-protection) |
| [Force-push bypassers and required deployments](https://docs.github.com/en/graphql/reference/branches#mutation-updatebranchprotectionrule) | [`branches`](sections.md) (`force_push_bypassers, required_deployments`) | [GraphQL BranchProtectionRules](https://docs.github.com/en/graphql/reference/branches#object-branchprotectionrule)<br>[GraphQL BranchProtectionRulesSnapshot](https://docs.github.com/en/graphql/reference/branches#object-branchprotectionrule)<br>[GraphQL BranchProtectionActorUser](https://docs.github.com/en/graphql/reference/users#query-user)<br>[GraphQL BranchProtectionActorTeam](https://docs.github.com/en/graphql/reference/teams#object-team)<br>[GET /apps/{app_slug}](https://docs.github.com/en/rest/apps/apps#get-an-app)<br>[GraphQL UpdateBranchProtectionRule](https://docs.github.com/en/graphql/reference/branches#mutation-updatebranchprotectionrule) |
| [Wildcard branch protection rules](https://docs.github.com/en/graphql/reference/branches#object-branchprotectionrule) | [`branches`](sections.md) | [GraphQL BranchProtectionRules](https://docs.github.com/en/graphql/reference/branches#object-branchprotectionrule)<br>[GraphQL BranchProtectionRepository](https://docs.github.com/en/graphql/reference/repos#object-repository)<br>[GraphQL CreateBranchProtectionRule](https://docs.github.com/en/graphql/reference/branches#mutation-createbranchprotectionrule)<br>[GraphQL UpdateBranchProtectionRule](https://docs.github.com/en/graphql/reference/branches#mutation-updatebranchprotectionrule)<br>[GraphQL DeleteBranchProtectionRule](https://docs.github.com/en/graphql/reference/branches#mutation-deletebranchprotectionrule)<br>[GraphQL BranchProtectionActorUser](https://docs.github.com/en/graphql/reference/users#query-user)<br>[GraphQL BranchProtectionActorTeam](https://docs.github.com/en/graphql/reference/teams#object-team)<br>[GET /apps/{app_slug}](https://docs.github.com/en/rest/apps/apps#get-an-app)<br>[GraphQL BranchProtectionRulesSnapshot](https://docs.github.com/en/graphql/reference/branches#object-branchprotectionrule) |
| [Environments](https://docs.github.com/en/rest/deployments/environments) | [`environments`](sections.md) | [GET /repos/{owner}/{repo}/environments](https://docs.github.com/en/rest/deployments/environments#list-environments)<br>[GET /repos/{owner}/{repo}/environments/{environment_name}](https://docs.github.com/en/rest/deployments/environments#get-an-environment)<br>[PUT /repos/{owner}/{repo}/environments/{environment_name}](https://docs.github.com/en/rest/deployments/environments#create-or-update-an-environment) |
| [Environment variables](https://docs.github.com/en/rest/actions/variables) | [`environments`](sections.md) (`variables`) | [GET /repos/{owner}/{repo}/environments/{environment_name}/variables](https://docs.github.com/en/rest/actions/variables#list-environment-variables)<br>[POST /repos/{owner}/{repo}/environments/{environment_name}/variables](https://docs.github.com/en/rest/actions/variables#create-an-environment-variable)<br>[PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}](https://docs.github.com/en/rest/actions/variables#update-an-environment-variable)<br>[DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}](https://docs.github.com/en/rest/actions/variables#delete-an-environment-variable) |
| [Environment secrets](https://docs.github.com/en/rest/actions/secrets) | [`environments`](sections.md) (`secrets`) | [GET /repos/{owner}/{repo}/environments/{environment_name}/secrets](https://docs.github.com/en/rest/actions/secrets#list-environment-secrets)<br>[GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key](https://docs.github.com/en/rest/actions/secrets#get-an-environment-public-key)<br>[PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}](https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret)<br>[DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}](https://docs.github.com/en/rest/actions/secrets#delete-an-environment-secret) |
| [Deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies) | [`environments`](sections.md) (`deployment_branch_policies`) | [GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies](https://docs.github.com/en/rest/deployments/branch-policies#list-deployment-branch-policies)<br>[POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies](https://docs.github.com/en/rest/deployments/branch-policies#create-a-deployment-branch-policy)<br>[DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}](https://docs.github.com/en/rest/deployments/branch-policies#delete-a-deployment-branch-policy) |
| [Custom deployment protection rules](https://docs.github.com/en/rest/deployments/protection-rules) | [`environments`](sections.md) (`deployment_protection_rules`) | [GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules](https://docs.github.com/en/rest/deployments/protection-rules#get-all-deployment-protection-rules-for-an-environment)<br>[GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps](https://docs.github.com/en/rest/deployments/protection-rules#list-custom-deployment-rule-integrations-available-for-an-environment)<br>[POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules](https://docs.github.com/en/rest/deployments/protection-rules#create-a-custom-deployment-protection-rule-on-an-environment)<br>[DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}](https://docs.github.com/en/rest/deployments/protection-rules#disable-a-custom-protection-rule-for-an-environment) |
| [Pinned environments](https://docs.github.com/en/graphql/reference/deployments#mutation-pinenvironment) | [`environments`](sections.md) (`pinned`) | [GraphQL EnvironmentPins](https://docs.github.com/en/graphql/reference/deployments#object-pinnedenvironment)<br>[GraphQL EnvironmentPinsSnapshot](https://docs.github.com/en/graphql/reference/deployments#object-pinnedenvironment)<br>[GraphQL PinEnvironment](https://docs.github.com/en/graphql/reference/deployments#mutation-pinenvironment)<br>[GraphQL ReorderEnvironment](https://docs.github.com/en/graphql/reference/deployments#mutation-reorderenvironment) |
| [Autolinks](https://docs.github.com/en/rest/repos/autolinks) | [`autolinks`](sections.md) | [GET /repos/{owner}/{repo}/autolinks](https://docs.github.com/en/rest/repos/autolinks#get-all-autolinks-of-a-repository)<br>[POST /repos/{owner}/{repo}/autolinks](https://docs.github.com/en/rest/repos/autolinks#create-an-autolink-reference-for-a-repository)<br>[DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}](https://docs.github.com/en/rest/repos/autolinks#delete-an-autolink-reference-from-a-repository) |
| [Actions permissions](https://docs.github.com/en/rest/actions/permissions) | [`actions`](sections.md) | [GET /repos/{owner}/{repo}/actions/permissions](https://docs.github.com/en/rest/actions/permissions#get-github-actions-permissions-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions](https://docs.github.com/en/rest/actions/permissions#set-github-actions-permissions-for-a-repository) |
| [Allowed actions and reusable workflows](https://docs.github.com/en/rest/actions/permissions#set-allowed-actions-and-reusable-workflows-for-a-repository) | [`actions`](sections.md) (`selected_actions`) | [GET /repos/{owner}/{repo}/actions/permissions/selected-actions](https://docs.github.com/en/rest/actions/permissions#get-allowed-actions-and-reusable-workflows-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions/selected-actions](https://docs.github.com/en/rest/actions/permissions#set-allowed-actions-and-reusable-workflows-for-a-repository) |
| [Workflow token permissions](https://docs.github.com/en/rest/actions/permissions#set-default-workflow-permissions-for-a-repository) | [`actions`](sections.md) (`default_workflow_permissions, can_approve_pull_request_reviews`) | [GET /repos/{owner}/{repo}/actions/permissions/workflow](https://docs.github.com/en/rest/actions/permissions#get-default-workflow-permissions-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions/workflow](https://docs.github.com/en/rest/actions/permissions#set-default-workflow-permissions-for-a-repository) |
| [Workflow access level](https://docs.github.com/en/rest/actions/permissions#set-the-level-of-access-for-workflows-outside-of-the-repository) | [`actions`](sections.md) (`access_level`) | [GET /repos/{owner}/{repo}/actions/permissions/access](https://docs.github.com/en/rest/actions/permissions#get-the-level-of-access-for-workflows-outside-of-the-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions/access](https://docs.github.com/en/rest/actions/permissions#set-the-level-of-access-for-workflows-outside-of-the-repository) |
| [Artifact and log retention](https://docs.github.com/en/rest/actions/permissions#set-artifact-and-log-retention-settings-for-a-repository) | [`actions`](sections.md) (`artifact_and_log_retention`) | [GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention](https://docs.github.com/en/rest/actions/permissions#get-artifact-and-log-retention-settings-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention](https://docs.github.com/en/rest/actions/permissions#set-artifact-and-log-retention-settings-for-a-repository) |
| [Cache limits](https://docs.github.com/en/rest/actions/cache) | [`actions`](sections.md) (`cache`) | [GET /repos/{owner}/{repo}/actions/cache/retention-limit](https://docs.github.com/en/rest/actions/cache#get-github-actions-cache-retention-limit-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/cache/retention-limit](https://docs.github.com/en/rest/actions/cache#set-github-actions-cache-retention-limit-for-a-repository)<br>[GET /repos/{owner}/{repo}/actions/cache/storage-limit](https://docs.github.com/en/rest/actions/cache#get-github-actions-cache-storage-limit-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/cache/storage-limit](https://docs.github.com/en/rest/actions/cache#set-github-actions-cache-storage-limit-for-a-repository) |
| [OIDC subject claim customization](https://docs.github.com/en/rest/actions/oidc) | [`actions`](sections.md) (`oidc_customization_sub`) | [GET /repos/{owner}/{repo}/actions/oidc/customization/sub](https://docs.github.com/en/rest/actions/oidc#get-the-customization-template-for-an-oidc-subject-claim-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/oidc/customization/sub](https://docs.github.com/en/rest/actions/oidc#set-the-customization-template-for-an-oidc-subject-claim-for-a-repository) |
| [Fork PR contributor approval](https://docs.github.com/en/rest/actions/permissions#set-fork-pr-contributor-approval-permissions-for-a-repository) | [`actions`](sections.md) (`fork_pr_contributor_approval`) | [GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval](https://docs.github.com/en/rest/actions/permissions#get-fork-pr-contributor-approval-permissions-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval](https://docs.github.com/en/rest/actions/permissions#set-fork-pr-contributor-approval-permissions-for-a-repository) |
| [Private-repo fork PR workflows](https://docs.github.com/en/rest/actions/permissions#set-private-repo-fork-pr-workflow-settings-for-a-repository) | [`actions`](sections.md) (`fork_pr_workflows_private_repos`) | [GET /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos](https://docs.github.com/en/rest/actions/permissions#get-private-repo-fork-pr-workflow-settings-for-a-repository)<br>[PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos](https://docs.github.com/en/rest/actions/permissions#set-private-repo-fork-pr-workflow-settings-for-a-repository) |
| [Actions secrets](https://docs.github.com/en/rest/actions/secrets) | [`actions_secrets`](sections.md) | [GET /repos/{owner}/{repo}/actions/secrets](https://docs.github.com/en/rest/actions/secrets#list-repository-secrets)<br>[GET /repos/{owner}/{repo}/actions/secrets/public-key](https://docs.github.com/en/rest/actions/secrets#get-a-repository-public-key)<br>[PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret)<br>[DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}](https://docs.github.com/en/rest/actions/secrets#delete-a-repository-secret) |
| [Dependabot secrets](https://docs.github.com/en/rest/dependabot/secrets) | [`dependabot_secrets`](sections.md) | [GET /repos/{owner}/{repo}/dependabot/secrets](https://docs.github.com/en/rest/dependabot/secrets#list-repository-secrets)<br>[GET /repos/{owner}/{repo}/dependabot/secrets/public-key](https://docs.github.com/en/rest/dependabot/secrets#get-a-repository-public-key)<br>[PUT /repos/{owner}/{repo}/dependabot/secrets/{secret_name}](https://docs.github.com/en/rest/dependabot/secrets#create-or-update-a-repository-secret)<br>[DELETE /repos/{owner}/{repo}/dependabot/secrets/{secret_name}](https://docs.github.com/en/rest/dependabot/secrets#delete-a-repository-secret) |
| [Codespaces repository secrets](https://docs.github.com/en/rest/codespaces/repository-secrets) | [`codespaces_secrets`](sections.md) | [GET /repos/{owner}/{repo}/codespaces/secrets](https://docs.github.com/en/rest/codespaces/repository-secrets#list-repository-secrets)<br>[GET /repos/{owner}/{repo}/codespaces/secrets/public-key](https://docs.github.com/en/rest/codespaces/repository-secrets#get-a-repository-public-key)<br>[PUT /repos/{owner}/{repo}/codespaces/secrets/{secret_name}](https://docs.github.com/en/rest/codespaces/repository-secrets#create-or-update-a-repository-secret)<br>[DELETE /repos/{owner}/{repo}/codespaces/secrets/{secret_name}](https://docs.github.com/en/rest/codespaces/repository-secrets#delete-a-repository-secret) |
| [Copilot agents secrets](https://docs.github.com/en/rest/agents/secrets) | [`agents_secrets`](sections.md) | [GET /repos/{owner}/{repo}/agents/secrets](https://docs.github.com/en/rest/agents/secrets#list-repository-secrets)<br>[GET /repos/{owner}/{repo}/agents/secrets/public-key](https://docs.github.com/en/rest/agents/secrets#get-a-repository-public-key)<br>[PUT /repos/{owner}/{repo}/agents/secrets/{secret_name}](https://docs.github.com/en/rest/agents/secrets#create-or-update-a-repository-secret)<br>[DELETE /repos/{owner}/{repo}/agents/secrets/{secret_name}](https://docs.github.com/en/rest/agents/secrets#delete-a-repository-secret) |
| [Workflow enable/disable state](https://docs.github.com/en/rest/actions/workflows) | [`workflows`](sections.md) | [GET /repos/{owner}/{repo}/actions/workflows](https://docs.github.com/en/rest/actions/workflows#list-repository-workflows)<br>[PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable](https://docs.github.com/en/rest/actions/workflows#enable-a-workflow)<br>[PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable](https://docs.github.com/en/rest/actions/workflows#disable-a-workflow) |
| [Check suite preferences](https://docs.github.com/en/rest/checks/suites) | [`check_suite_preferences`](sections.md) | [PATCH /repos/{owner}/{repo}/check-suites/preferences](https://docs.github.com/en/rest/checks/suites#update-repository-preferences-for-check-suites) |
| [GitHub Pages](https://docs.github.com/en/rest/pages/pages) | [`pages`](sections.md) | [GET /repos/{owner}/{repo}/pages](https://docs.github.com/en/rest/pages/pages#get-a-github-pages-site)<br>[POST /repos/{owner}/{repo}/pages](https://docs.github.com/en/rest/pages/pages#create-a-github-pages-site)<br>[PUT /repos/{owner}/{repo}/pages](https://docs.github.com/en/rest/pages/pages#update-information-about-a-github-pages-site)<br>[DELETE /repos/{owner}/{repo}/pages](https://docs.github.com/en/rest/pages/pages#delete-a-github-pages-site) |
| [Fields the Pages update ignores](https://docs.github.com/en/rest/pages/pages#update-information-about-a-github-pages-site) | [`pages`](sections.md) | shares the calls of the GitHub Pages row |
| [Pages site visibility](https://docs.github.com/en/enterprise-cloud@latest/rest/pages/pages#update-information-about-a-github-enterprise-cloud-pages-site) | [`pages`](sections.md) (`public`) | shares the calls of the GitHub Pages row |
| [Code scanning default setup](https://docs.github.com/en/rest/code-scanning/code-scanning) | [`code_scanning_default_setup`](sections.md) | [GET /repos/{owner}/{repo}/code-scanning/default-setup](https://docs.github.com/en/rest/code-scanning/code-scanning#get-a-code-scanning-default-setup-configuration)<br>[PATCH /repos/{owner}/{repo}/code-scanning/default-setup](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration) |
| [Code quality setup](https://docs.github.com/en/rest/code-quality/code-quality) | [`code_quality_setup`](sections.md) | [GET /repos/{owner}/{repo}/code-quality/setup](https://docs.github.com/en/rest/code-quality/code-quality#get-a-code-quality-setup-configuration)<br>[PATCH /repos/{owner}/{repo}/code-quality/setup](https://docs.github.com/en/rest/code-quality/code-quality#update-a-code-quality-setup-configuration) |
| [Collaborators](https://docs.github.com/en/rest/collaborators/collaborators) | [`collaborators`](sections.md) | [GET /repos/{owner}/{repo}/collaborators](https://docs.github.com/en/rest/collaborators/collaborators#list-repository-collaborators)<br>[PUT /repos/{owner}/{repo}/collaborators/{username}](https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator)<br>[DELETE /repos/{owner}/{repo}/collaborators/{username}](https://docs.github.com/en/rest/collaborators/collaborators#remove-a-repository-collaborator) |
| [Repository invitations](https://docs.github.com/en/rest/collaborators/invitations) | [`collaborators`](sections.md) | [GET /repos/{owner}/{repo}/invitations](https://docs.github.com/en/rest/collaborators/invitations#list-repository-invitations)<br>[PATCH /repos/{owner}/{repo}/invitations/{invitation_id}](https://docs.github.com/en/rest/collaborators/invitations#update-a-repository-invitation)<br>[DELETE /repos/{owner}/{repo}/invitations/{invitation_id}](https://docs.github.com/en/rest/collaborators/invitations#delete-a-repository-invitation) |
| [Team repository permissions](https://docs.github.com/en/rest/teams/teams) | [`teams`](sections.md) | [GET /orgs/{org}](https://docs.github.com/en/rest/orgs/orgs#get-an-organization)<br>[GET /repos/{owner}/{repo}/teams](https://docs.github.com/en/rest/repos/repos#list-repository-teams)<br>[GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}](https://docs.github.com/en/rest/teams/teams#check-team-permissions-for-a-repository)<br>[PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}](https://docs.github.com/en/rest/teams/teams#add-or-update-team-repository-permissions)<br>[DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}](https://docs.github.com/en/rest/teams/teams#remove-a-repository-from-a-team) |
| [Milestones](https://docs.github.com/en/rest/issues/milestones) | [`milestones`](sections.md) | [GET /repos/{owner}/{repo}/milestones](https://docs.github.com/en/rest/issues/milestones#list-milestones)<br>[POST /repos/{owner}/{repo}/milestones](https://docs.github.com/en/rest/issues/milestones#create-a-milestone)<br>[PATCH /repos/{owner}/{repo}/milestones/{milestone_number}](https://docs.github.com/en/rest/issues/milestones#update-a-milestone)<br>[DELETE /repos/{owner}/{repo}/milestones/{milestone_number}](https://docs.github.com/en/rest/issues/milestones#delete-a-milestone) |
| [Interaction limits](https://docs.github.com/en/rest/interactions/repos) | [`interaction_limits`](sections.md) | [GET /repos/{owner}/{repo}/interaction-limits](https://docs.github.com/en/rest/interactions/repos#get-interaction-restrictions-for-a-repository)<br>[PUT /repos/{owner}/{repo}/interaction-limits](https://docs.github.com/en/rest/interactions/repos#set-interaction-restrictions-for-a-repository)<br>[DELETE /repos/{owner}/{repo}/interaction-limits](https://docs.github.com/en/rest/interactions/repos#remove-interaction-restrictions-for-a-repository) |
| [Pull request creation cap](https://docs.github.com/en/rest/interactions/repos#update-pull-request-creation-cap-for-a-repository) | [`interaction_limits`](sections.md) (`pull_request_creation_cap`) | [GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap](https://docs.github.com/en/rest/interactions/repos#get-pull-request-creation-cap-for-a-repository)<br>[PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap](https://docs.github.com/en/rest/interactions/repos#update-pull-request-creation-cap-for-a-repository) |
| [Pull request creation cap bypass list](https://docs.github.com/en/rest/interactions/repos#add-users-to-the-pull-request-creation-cap-bypass-list-for-a-repository) | [`interaction_limits`](sections.md) (`pull_request_creation_bypass`) | [GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list](https://docs.github.com/en/rest/interactions/repos#get-pull-request-creation-cap-bypass-list-for-a-repository)<br>[PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list](https://docs.github.com/en/rest/interactions/repos#add-users-to-the-pull-request-creation-cap-bypass-list-for-a-repository)<br>[DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list](https://docs.github.com/en/rest/interactions/repos#remove-users-from-the-pull-request-creation-cap-bypass-list-for-a-repository) |
| [Actions variables](https://docs.github.com/en/rest/actions/variables) | [`actions_variables`](sections.md) | [GET /repos/{owner}/{repo}/actions/variables](https://docs.github.com/en/rest/actions/variables#list-repository-variables)<br>[POST /repos/{owner}/{repo}/actions/variables](https://docs.github.com/en/rest/actions/variables#create-a-repository-variable)<br>[PATCH /repos/{owner}/{repo}/actions/variables/{name}](https://docs.github.com/en/rest/actions/variables#update-a-repository-variable)<br>[DELETE /repos/{owner}/{repo}/actions/variables/{name}](https://docs.github.com/en/rest/actions/variables#delete-a-repository-variable) |
| [Copilot agents variables](https://docs.github.com/en/rest/agents/variables) | [`agents_variables`](sections.md) | [GET /repos/{owner}/{repo}/agents/variables](https://docs.github.com/en/rest/agents/variables#list-repository-variables)<br>[POST /repos/{owner}/{repo}/agents/variables](https://docs.github.com/en/rest/agents/variables#create-a-repository-variable)<br>[PATCH /repos/{owner}/{repo}/agents/variables/{name}](https://docs.github.com/en/rest/agents/variables#update-a-repository-variable)<br>[DELETE /repos/{owner}/{repo}/agents/variables/{name}](https://docs.github.com/en/rest/agents/variables#delete-a-repository-variable) |
| [Webhooks](https://docs.github.com/en/rest/repos/webhooks) | [`webhooks`](sections.md) | [GET /repos/{owner}/{repo}/hooks](https://docs.github.com/en/rest/repos/webhooks#list-repository-webhooks)<br>[POST /repos/{owner}/{repo}/hooks](https://docs.github.com/en/rest/repos/webhooks#create-a-repository-webhook)<br>[PATCH /repos/{owner}/{repo}/hooks/{hook_id}](https://docs.github.com/en/rest/repos/webhooks#update-a-repository-webhook)<br>[PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config](https://docs.github.com/en/rest/repos/webhooks#update-a-webhook-configuration-for-a-repository)<br>[DELETE /repos/{owner}/{repo}/hooks/{hook_id}](https://docs.github.com/en/rest/repos/webhooks#delete-a-repository-webhook) |
| [Custom property values](https://docs.github.com/en/rest/repos/custom-properties) | [`custom_properties`](sections.md) | [GET /orgs/{org}](https://docs.github.com/en/rest/orgs/orgs#get-an-organization)<br>[GET /repos/{owner}/{repo}/properties/values](https://docs.github.com/en/rest/repos/custom-properties#get-all-custom-property-values-for-a-repository)<br>[PATCH /repos/{owner}/{repo}/properties/values](https://docs.github.com/en/rest/repos/custom-properties#create-or-update-custom-property-values-for-a-repository) |
| [Deploy keys](https://docs.github.com/en/rest/deploy-keys/deploy-keys) | [`deploy_keys`](sections.md) | [GET /repos/{owner}/{repo}/keys](https://docs.github.com/en/rest/deploy-keys/deploy-keys#list-deploy-keys)<br>[POST /repos/{owner}/{repo}/keys](https://docs.github.com/en/rest/deploy-keys/deploy-keys#create-a-deploy-key)<br>[DELETE /repos/{owner}/{repo}/keys/{key_id}](https://docs.github.com/en/rest/deploy-keys/deploy-keys#delete-a-deploy-key) |
| [Secret scanning custom patterns](https://docs.github.com/en/rest/secret-scanning/custom-patterns) | [`secret_scanning_custom_patterns`](sections.md) | [GET /repos/{owner}/{repo}/secret-scanning/custom-patterns](https://docs.github.com/en/rest/secret-scanning/custom-patterns#list-repository-custom-patterns)<br>[POST /repos/{owner}/{repo}/secret-scanning/custom-patterns](https://docs.github.com/en/rest/secret-scanning/custom-patterns#bulk-create-repository-custom-patterns)<br>[PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}](https://docs.github.com/en/rest/secret-scanning/custom-patterns#update-a-repository-custom-pattern)<br>[DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns](https://docs.github.com/en/rest/secret-scanning/custom-patterns#bulk-delete-repository-custom-patterns) |

### Notes

**Repository core settings** (`repository`)

- Covers name, description, homepage, visibility/private, has_issues, has_wiki, has_projects, has_discussions, the merge-strategy toggles, squash/merge commit title and message, delete_branch_on_merge, allow_update_branch, allow_auto_merge, web_commit_signoff_required, is_template, archived, and default_branch.
- PATCH /repos/{owner}/{repo} passthrough: documented fields are typed (toggles true or false; description and homepage also null, the API's clear); a field GitHub adds later works day one.
- GET-only fields, a commit message without its title, and illegal squash pairs are refused at parse: each would drift or 422 every run.
- Check diffs the declared keys against GET /repos; snapshot reads back the PATCH fields, topics, toggles, and GraphQL keys (docs/operate/snapshot.md).

**security_and_analysis** (`repository`)

- Covers GitHub Advanced Security, secret scanning, push protection, delegated bypass, and validity checks.
- Nested in the same PATCH, closed to the sub-keys the PATCH accepts (GitHub 422s any other): each feature is {status: enabled/disabled}, delegated-bypass reviewers are {reviewer_id, reviewer_type: TEAM/ROLE, mode: ALWAYS/EXEMPT}, and the GET-only dependabot_security_updates points at enable_automated_security_fixes.
- secret_scanning_validity_checks nests here too (documented in the GHEC flavor of the spec).
- The GET echoes all of it, so check verifies it.

**Forking policy** (`repository`)

- allow_forking and any other fork-policy fields on the repo object ride the PATCH passthrough.
- The org-side 'members can fork' policy is org-scoped, out of scope.

**Topics** (`repository`)

- PUT /repos/{owner}/{repo}/topics, with string-to-list splitting (normalizeTopics), lowercasing, and order-insensitive compare in check mode.
- GitHub's topic rule (1 to 50 letters, digits, and hyphens, starting with a letter or digit; at most 20 distinct topics) is checked at parse on every entry, empty ones included; the grammar is published in the settings schema while the cap is the runtime's alone.
- `topics: []` is the one spelling of the wholesale clear.

**Dependabot alerts** (`repository`)

- Also called vulnerability alerts. PUT/DELETE /repos/{owner}/{repo}/vulnerability-alerts; check mode probes GET and treats 404 as disabled.
- GitHub couples the dependency graph to this endpoint: the PUT/DELETE also enable/disable the graph as a side effect (the graph toggle itself has no API of its own; see No public API).

**Dependabot security updates** (`repository`)

- Also called automated security fixes. PUT/DELETE /repos/{owner}/{repo}/automated-security-fixes; check reads the {enabled} body from GET, and a 404 reads as disabled.

**Private vulnerability reporting** (`repository`)

- PUT/DELETE /repos/{owner}/{repo}/private-vulnerability-reporting; check reads the {enabled} body from GET.
- Repositories where the feature does not apply (observed: private repos) answer 404 or 422, which check treats as "not enabled" and disable treats as already done.

**Git LFS enable/disable** (`repository`)

- PUT /repos/{owner}/{repo}/lfs (202) or DELETE (204).
- GitHub exposes NO endpoint to read the state back, so check mode emits a cannot-verify note instead of drift, apply re-asserts the declared state on every run, and the apply-mode preflight cannot probe it (a denied LFS write surfaces only after the section's other writes landed).
- A 403 can mean LFS is disabled account-wide or for the root of the repository network, or a credential without billing access, rather than a missing token grant; the error says so.
- GitHub's OpenAPI descriptor does not document this endpoint (real per the REST docs), so the e2e validator carries it in UNDOCUMENTED_ROUTES.

**Immutable releases** (`repository`)

- GET/PUT/DELETE /repos/{owner}/{repo}/immutable-releases; check mode probes GET and treats 404 as disabled.
- CAVEAT: enforced_by_owner in the GET body is read-only owner-level enforcement - both writes then answer 409, which apply surfaces as a note rather than a failure or a false change line, and check mode still reports a mismatched declaration as drift while saying apply cannot change it from the repository.

**Sponsor button** (`repository`)

- The "Display a Sponsor button" checkbox under Settings > General > Features.
- GraphQL only: read via Repository.hasSponsorshipsEnabled, written via the updateRepository mutation's hasSponsorshipsEnabled input field - the PATCH /repos body carries no such field and no REST GET returns one.
- One RepositoryFeatures query serves this key, issue_creation_policy, and the node id the UpdateRepositoryFeatures mutation addresses; apply compares first, mutates only on divergence, and verifies the mutation's echoed state.
- A stored repository boolean independent of FUNDING.yml (repo content, out of scope).

**Issue creation policy** (`repository`)

- The Issues "Creation allowed by" control: everyone vs collaborators only.
- GraphQL only, sharing the Sponsor button's RepositoryFeatures query and updateRepository mutation: declared lowercase ("all"/"collaborators_only") and mapped to GitHub's ALL/COLLABORATORS_ONLY IssueCreationPolicy enum at the boundary.
- Live-probed before building: the REST PATCH ACCEPTS an issue_creation_policy field and silently ignores it (HTTP 200, no echo, no effect), and no REST GET carries it (the GET has pull_request_creation_policy but not the issue twin) - so GraphQL is the only read and write surface and the passthrough cannot absorb the key.
- A persistent two-value enum with full read-back, so check mode diffs it exactly.

**Labels** (`labels`)

- Full CRUD on /repos/{owner}/{repo}/labels: upsert by name, rename via new_name (Probot parity).
- Undeclared labels are DELETED loudly by default; the wrapped `_undeclared: keep` form keeps them, each surfaced as a note.
- Snapshot reads the live labels back as entries under the delete default.

**Rulesets** (`rulesets`)

- Covers branch, tag, and push targets; all rule types, conditions, and bypass_actors.
- GET/POST/PUT/DELETE /repos/{owner}/{repo}/rulesets: upsert-by-name, full-payload PUT, passthrough except ref-name prefixing (staging -> refs/heads/staging, ~DEFAULT_BRANCH passes through) and the actor fill GitHub applies (bypass_mode always, an OrganizationAdmin's actor_id 1).
- What the file alone shows wrong is refused at parse, before any request: the enforcement level, a bypass actor's type, mode, and id rules, a "~" ref-name value other than ~ALL or ~DEFAULT_BRANCH, and the parameters of the rule types the vendored OpenAPI spec knows (types, enums in GitHub's casing, integer bounds, required fields).
- A rule type the spec does not know passes through verbatim, as does a new field on a known rule or a bypass actor, so what GitHub ships tomorrow works today.
- The list carries summaries, so each matched ruleset is read whole before the comparison.
- A live value the entry omits is drift, and apply refuses the PUT (the [replace-write rule](semantics.md)).
- Undeclared rulesets are kept by default (notes only); the wrapped `_undeclared: delete` form deletes them.
- Org-sourced rulesets are outside the section (source_type other than Repository).
- GitHub returns bypass_actors only to a token with write access to the ruleset, so under a token without Administration write a declared bypass_actors is left out of the comparison and noted as not visible instead of reported as drift.
- Snapshot reads repository rulesets back as entries under the keep default (id, source, links, timestamps, and the caller's bypass state fall away).
- Snapshot leaves out an inherited organization ruleset with a note, and so a ruleset whose bypass_actors the token cannot see (kept undeclared), since an entry without the key would clear the bypass list on the next full-payload update.

**Merge queue** (`rulesets`)

- Configured as the merge_queue rule type inside a branch ruleset, its parameters typed from the spec (merge_method MERGE, SQUASH, or REBASE; grouping_strategy ALLGREEN or HEADGREEN; the minute and entry bounds), so a mis-cased value is refused at parse instead of as a 422.
- No dedicated endpoint exists; rulesets ARE the API for merge queue.

**Tag protection (modern)** (`rulesets`)

- target: tag rulesets cover everything the retired legacy tag-protection API did (the legacy API itself is out of scope, removed by GitHub).

**Classic branch protection** (`branches`)

- Covers literal branches, wildcard patterns, force-push bypass actors, and required deployments; the last three have their own rows below.
- PUT /repos/{owner}/{repo}/branches/{branch}/protection passthrough; the four required keys are null-filled; protection: null issues DELETE (deleteBranchProtectionRule for a wildcard entry).
- GET /repos/{owner}/{repo}/branches/{branch} probes whether a literal branch exists, so check mode can tell a missing branch from an unprotected one; the probe needs Contents: read.
- What the settings file alone shows wrong is refused before any request, naming the key and the fix: required_status_checks without strict or without a check list (contexts or checks), required_approving_review_count outside 0-6, and the GET-only vocabulary a copied GET response carries (name, enabled, enforcement_level, url and *_url keys, at any depth).
- Also refused at parse: an actor object copied from the GET into restrictions, dismissal_restrictions, or bypass_pull_request_allowances, where the PUT takes login/slug strings (the refusal names the string to write).
- Check mode flattens the GET shape ({enabled} wrappers, actor objects -> login/slug strings, *_url dropped) to compare like with like (src/sections/branches/index.ts flattenProtection).
- Check mode notes a declared key outside the PUT vocabulary that the GET never echoes as never converging; a documented key the GET omits, such as an off control, is drift the PUT resolves.
- Actor logins and slugs compare case-insensitively (GitHub matches them in any case and reads back its own spelling), and a live review block without dismissal_restrictions or bypass_pull_request_allowances compares as the all-empty holder, which is how GitHub reads an empty one back.
- Every write is drift-gated: the PUT is planned when a declared key diverges or when the replacing PUT would remove a live setting the file omits, and a converged branch plans nothing.
- A live restrictions holder with empty users, teams, and apps is such a setting (it lets nobody push, and GitHub omits the key only when the branch is unrestricted), so a file that omits restrictions is told the PUT would lift it; declaring the all-empty holder keeps it.
- Snapshot lists the protected branches (GET /repos/{owner}/{repo}/branches?protected=true) and reads each one's classic protection back in the PUT vocabulary, controls that are off omitted.
- The snapshot writes the required checks in both spellings the PUT takes, `contexts` and `checks` (an any-App check as app_id -1, the PUT's spelling of GitHub's null read-back, which the diff normalizes the same way); a listed branch whose protection read answers 404 (a ruleset protects it) is left out.

**Required signatures** (`branches`)

- One of three routed keys that never ride the PUT: the PUT silently drops required_signatures, so it goes through its own POST/DELETE .../protection/required_signatures sub-endpoint when it drifts and again after any planned PUT.
- Declared true POSTs, false DELETEs, undeclared is untouched; a GET that omits the field reads as false.
- GitHub does not document whether the PUT preserves an existing requirement, so declare the toggle on any branch that carries one.

**Force-push bypassers and required deployments** (`branches`)

- The other two routed keys: both are REST-invisible entirely and ride ONE updateBranchProtectionRule GraphQL mutation on the same terms as required_signatures, when they drift and again after any planned protection PUT.
- force_push_bypassers is a list of actor strings - a bare login is a user, "org/team-slug" a team, "app/slug" a GitHub App - resolved to node ids when apply executes, ahead of the section's first write, so a misspelled actor fails before any write lands (check mode issues no lookup and reports the drift).
- Users and teams resolve through GraphQL (the BranchProtectionActorUser and BranchProtectionActorTeam lookups, new-format ids), Apps through the public GET /apps/{app_slug} REST lookup, whose node_id can still be the legacy format for old Apps (GitHub accepts it with a deprecation warning).
- required_deployments takes {environments: [...]}; declaring null turns the requirement off, an absent key leaves the live state untouched.
- CAVEAT (verified live): GitHub SILENTLY drops required-deployment environment names that do not exist while the mutation succeeds, so apply verifies the mutation's read-back and fails loudly naming any dropped name - the environments section runs before branches, so environments declared in the same file exist by then.
- Actor and environment names compare case-insensitively (GitHub canonicalizes them), and the routed lists reject duplicate names upfront.

**Wildcard branch protection rules** (`branches`)

- WILDCARD entries (a name containing `*`, `?`, or `[`, e.g. release/*) are invisible to the REST endpoints (their docs point wildcard use at the GraphQL API), so they reconcile entirely through the createBranchProtectionRule/updateBranchProtectionRule/deleteBranchProtectionRule mutations against the Repository.branchProtectionRules read.
- A create addresses the repository node id the BranchProtectionRepository query fetches.
- A wildcard protection accepts exactly the keys this section can round-trip through the GraphQL rule surface: enforce_admins (its isAdminEnforced twin live-verified bidirectionally against the REST view of the same rule), required_linear_history, allow_force_pushes, allow_deletions, block_creations, required_conversation_resolution, lock_branch, allow_fork_syncing, and required_signatures.
- Also accepted on a wildcard rule: required_status_checks (strict, contexts), required_pull_request_reviews (required_approving_review_count, require_code_owner_reviews, dismiss_stale_reviews, require_last_push_approval), force_push_bypassers, and required_deployments.
- Anything else is rejected upfront, pointing at rulesets as the recommended path for new configuration: this section neither reads nor writes the rule's push, dismissal, or review-bypass actor lists over GraphQL, so restrictions, dismissal_restrictions, and bypass_pull_request_allowances (login and slug strings in the file) are not managed on a wildcard rule; force_push_bypassers is, through its own key.
- The rules query fires only when an entry has a wildcard name or declares a GraphQL-routed key (a pure-REST declaration issues no GraphQL request).
- That also scopes the undeclared-rule NOTE: only a run whose declaration fires the query reports a live wildcard rule the file does not declare, as a note and never a deletion.
- Wildcard updates have PATCH semantics (an omitted key keeps its live value, unlike the literal PUT's replace).
- The snapshot's own rules read is BranchProtectionRulesSnapshot, the planner's selection under a declaration that tolerates no denial: a concealed 404 is a PermissionDenied naming the grant, which the engine turns into a skipped section under on-missing-permission: warn and a failed run under fail, instead of reading as no rules.
- That read supplies the GraphQL-only surface: a literal entry carries its force_push_bypassers (actor strings in the file's spelling, sorted) and required_deployments when set, an empty allowance list and an off requirement omitted since an absent routed key leaves the live value untouched.
- Every wildcard rule is written as its own snapshot entry with the off controls dropped.
- A branch only a wildcard rule protects is NOT written as a literal entry (the REST read serves that rule's protection under the branch's name, and a literal entry would create a second rule on apply).
- A literal-pattern rule whose branch the REST read did not surface (no such branch, or a denied probe) is a note, since a literal entry applies through the PUT that needs the branch.

**Environments** (`environments`)

- Covers wait_timer, reviewers, prevent_self_review, and the deployment_branch_policy protected_branches/custom_branch_policies flags; the nested lists have their own rows below.
- PUT /repos/{owner}/{repo}/environments/{name} passthrough; check mode flattens GET's protection_rules[] back into the PUT shape.
- A live wait timer or reviewers list the entry omits is drift, and apply refuses the PUT (the [replace-write rule](semantics.md)).
- Undeclared environments are left untouched.
- In check mode against a missing environment the declared variables, secrets, patterns, and protection rules cannot be listed, so notes say they are unverifiable until it exists; against a live environment whose custom_branch_policies flag is off, the patterns earn the same note while the flag drift comes from the environment diff.
- Snapshot lists the environments (GET /repos/{owner}/{repo}/environments) and reads each one back as an entry: the PUT-shape settings off its GET body, and every nested list that has live items in its wrapped form under that list's default policy.
- The snapshot writes variables with their values, branch-policy patterns while the custom_branch_policies flag is on, and the enabled protection rules by App slug; those two lists sit behind the Actions grant: under on-missing-permission: warn a denial leaves the key out with a note and the rest of the environment reads back, under fail it fails the section.
- The snapshot writes secrets as `$SECRET_ENVIRONMENT_<NAME>_<SECRET>` references with a note each: the per-store minting the secret sections use, the environment folded into the store so same-named secrets in two environments get two variables; two names the fold collapses are noted once.

**Environment variables** (`environments`)

- A declared per-environment `variables` key reconciles that environment's Actions variables AFTER the PUT, through GET/POST /repos/{owner}/{repo}/environments/{name}/variables and PATCH/DELETE .../variables/{name}: create missing, update divergent values, and delete undeclared ones by default (the wrapped `_undeclared: keep` form keeps them as notes).
- Names match case-insensitively, values are plain text by design.

**Environment secrets** (`environments`)

- A declared per-environment `secrets` key reconciles that environment's Actions secrets the same way the shipped secret sections do: GET .../environments/{name}/secrets (names + timestamps), GET .../secrets/public-key, and sealed PUT/DELETE .../secrets/{secret_name}.
- The public key is issued at apply, inside the secret PUT, since that PUT may follow the environment's own creation; check mode never reads it.
- One sealing scope per environment, so same-named secrets in sibling environments resolve independently.
- Undeclared secrets within a declared key are KEPT by default (values unrecoverable; `_undeclared: delete` opts in).

**Deployment branch policies** (`environments`)

- A declared per-environment `deployment_branch_policies` key reconciles that environment's custom branch-policy patterns through GET/POST .../environments/{name}/deployment-branch-policies and DELETE .../deployment-branch-policies/{branch_policy_id}: create missing patterns, delete undeclared ones by default (`_undeclared: keep` softens to notes), and replace a matching pattern whose type differs.
- Type is immutable upstream, so the change is delete + recreate; the upstream PUT is deliberately unused - its body is the name alone, and the name is the pattern's identity, so it can never help reconciliation.
- Declaring the key requires the singular `deployment_branch_policy` sibling with custom_branch_policies: true (rejected upfront otherwise, since the pattern writes would 404 only after the environment PUT landed).
- These endpoints sit outside the Environments PAT permission: the list read needs Actions read, the writes need Administration write.

**Custom deployment protection rules** (`environments`)

- A declared per-environment `deployment_protection_rules` key reconciles that environment's custom deployment protection rules (GitHub App gates) through GET/POST .../environments/{name}/deployment_protection_rules and DELETE .../deployment_protection_rules/{protection_rule_id}: enable/disable ONLY, since GitHub offers no update call.
- The list documents NO pagination, so it is fetched in one call; the POST body is {integration_id}.
- Rules are declared by App slug and resolved to the integration id via ONE GET .../deployment_protection_rules/apps fetch per environment with a missing rule.
- The fetch happens at plan time for an environment that exists (so a slug the listing does not carry, or two Apps under one slug, fails before any write, naming the available slugs), and inside the enabling POST for an environment the run creates (the listing 404s until the environment's PUT lands).
- Undeclared rules within a declared key are KEPT by default - Apps can enable themselves as gates, and silently disabling a deployment gate is security-relevant - with `_undeclared: delete` opting into disabling.
- These endpoints also sit outside the Environments PAT permission (the enabled-rules list under Actions read, the Apps read and both writes under Administration).

**Pinned environments** (`environments`)

- A declared per-environment `pinned` key reconciles the repository's pinned deployments sidebar over POST /graphql, AFTER every environment PUT; each mutation addresses the node_id the environment PUT/GET bodies already carry, so no extra lookup is made.
- The live pins read back through the repository's pinnedEnvironments connection (the EnvironmentPins query), where the ordering is the 1-based `position` field ON THE PinnedEnvironment NODE (it does not live on the Environment object).
- Verified against live GitHub, those numbers may be NON-CONTIGUOUS: unpinning leaves a hole, a new pin appends at the tail via a monotonic counter, and only a reorder renormalizes the list.
- Positions are therefore consumed as a sort key only, and reconciliation compares RANK ORDER: the entries declaring pinned: true must LEAD the pinned list in settings-file declaration order.
- pinEnvironment ({environmentId, pinned}) pins a missing pin (tail append) and unpins a pinned: false entry; reorderEnvironment ({environmentId, position}) pulls a divergent pin left into its declared rank.
- Unpins are issued before pins, so a swap can never transiently exceed GitHub's cap of 10 pins; more than 10 declared pinned: true entries are rejected upfront.
- A final count that would overflow the cap - live pins nobody declared count toward it - fails BEFORE the first pin mutation, naming the cap and the way to make room; check mode surfaces the same overflow as a note.
- Pins with no pinned declaration - undeclared environments, or entries without the key - are never unpinned; one sitting among the leading ranks is moved after the declared block, surfaced as a note in BOTH modes so check and apply agree exactly.
- Everything reads back, so check mode reports exact pin membership and order drift (the order line names both sequences).
- The pin state reads back through the snapshot's own pins read, EnvironmentPinsSnapshot, the planner's selection under a declaration that tolerates no denial: a concealed 404 is a PermissionDenied naming the grant, which the engine turns into a skipped section under on-missing-permission: warn and a failed run under fail, instead of reading as no pins.
- In the snapshot the pinned environments LEAD the file in rank order with `pinned: true`, since the planner reads declaration order as pin order, and the unpinned ones follow without the key (an absent key leaves a pin untouched); a pin naming no listed environment is a note.

**Autolinks** (`autolinks`)

- GET/POST/DELETE /repos/{owner}/{repo}/autolinks; immutable upstream so changed entries are delete+recreate.
- Undeclared autolinks are DELETED by default, kept as notes under the wrapped `_undeclared: keep` form.
- Snapshot reads the live autolinks back as entries under the delete default.

**Actions permissions** (`actions`)

- Covers enabled, allowed_actions, sha_pinning_required, and any base-permission field GitHub adds; the keys with a sub-endpoint of their own have rows below.
- Key routing (src/sections/actions/index.ts): a key with its own sub-endpoint routes there, EVERYTHING else rides the base PUT .../actions/permissions verbatim.
- Whenever any base-permissions key is present in that PUT body, an undeclared `enabled` is defaulted to `true` (declaring a permissions field implies Actions are on).
- RISK: a key GitHub adds that belongs on a NEW sub-endpoint gets routed to the base PUT where GitHub ignores it; audit the routing whenever GitHub adds a permissions sub-endpoint.
- Fields a GET reports that its PUT does not take (selected_actions_url, artifact_and_log_retention.maximum_allowed_days, oidc_customization_sub.sub_claim_prefix) are refused when the file is parsed, since a declared value could only diff against live and re-PUT on every run.
- Snapshot reads every endpoint back onto its key (the allowlist only under the selected policy; the reported-only fields fall away); a sub-endpoint the token cannot read, such as the OIDC template under a token without the Actions permission, is noted and left out under on-missing-permission: warn and fails the section under fail.

**Allowed actions and reusable workflows** (`actions`)

- selected_actions -> PUT .../permissions/selected-actions; the allowlist body is closed to its three documented keys, since that PUT has no unrecognized-key note to catch a typo.
- selected_actions with no allowed_actions infers allowed_actions: selected.

**Workflow token permissions** (`actions`)

- The two known workflow-token keys, the default permissions and can_approve_pull_request_reviews, route to PUT .../actions/permissions/workflow.

**Workflow access level** (`actions`)

- access_level -> PUT .../permissions/access (private repositories only).

**Artifact and log retention** (`actions`)

- artifact_and_log_retention -> PUT .../permissions/artifact-and-log-retention (body {days}, verbatim).

**Cache limits** (`actions`)

- cache.max_cache_retention_days -> PUT .../actions/cache/retention-limit and cache.max_cache_size_gb -> PUT .../actions/cache/storage-limit; each limit is its own single-field endpoint, so unrecognized cache keys are rejected.
- A 403 on the cache endpoints can mean an org- or enterprise-managed policy rather than a missing grant.

**OIDC subject claim customization** (`actions`)

- oidc_customization_sub -> GET/PUT .../actions/oidc/customization/sub (201 on write); it needs the "Actions" PAT permission instead of Administration, and include_claim_keys is compared positionally because claim-key order defines the subject format.

**Fork PR contributor approval** (`actions`)

- fork_pr_contributor_approval -> GET/PUT .../permissions/fork-pr-contributor-approval (the approval_policy object, verbatim).

**Private-repo fork PR workflows** (`actions`)

- fork_pr_workflows_private_repos -> GET/PUT .../permissions/fork-pr-workflows-private-repos; only run_workflows_from_fork_pull_requests is required, as in the request body.
- The pair is documented for private repositories, so a denial on it can also mean the repository is public.

**Actions secrets** (`actions_secrets`)

- GET /repos/{owner}/{repo}/actions/secrets (names + timestamps), GET .../actions/secrets/public-key (read at apply, never in check mode), PUT .../actions/secrets/{secret_name} (a sealed box in libsodium's crypto_box_seal format, {encrypted_value, key_id}), DELETE .../actions/secrets/{secret_name}.
- Values never live in settings.yml: each entry's `value` is a whole-value `$NAME` reference resolved from the step's env at apply time, sealed client-side, and re-written on EVERY apply so a rotated source value propagates.
- CAVEAT (existence-only): GitHub cannot return a value, so drift detection is presence, not content - check mode reports a declared-but-missing secret as drift and adds one cannot-verify note for the values; a changed value on GitHub's side is undetectable.
- Undeclared secrets are kept by default (their values are unrecoverable); the wrapped `_undeclared: delete` form opts into deletion.
- Snapshot lists the secret names as per-store `$SECRET_<STORE>_<NAME>` references (so one name in two stores never shares a variable) with one note per value to export, since values are not readable.

**Dependabot secrets** (`dependabot_secrets`)

- GET /repos/{owner}/{repo}/dependabot/secrets, GET .../dependabot/secrets/public-key (read at apply), sealed PUT/DELETE .../dependabot/secrets/{secret_name}.
- Same shape, sealing, and existence-only semantics as `actions_secrets`, over the Dependabot secret store (private-registry credentials Dependabot uses).
- Undeclared secrets kept by default; `_undeclared: delete` opts into deletion.
- Snapshot lists the secret names as per-store `$SECRET_<STORE>_<NAME>` references with one note per value to export, since values are not readable.

**Codespaces repository secrets** (`codespaces_secrets`)

- GET /repos/{owner}/{repo}/codespaces/secrets, GET .../codespaces/secrets/public-key (read at apply), sealed PUT/DELETE .../codespaces/secrets/{secret_name}.
- Same shape, sealing, and existence-only semantics as `actions_secrets`, over the Codespaces secret store (development environment secrets); the only repo-scoped Codespaces configuration surface.
- CAVEAT: GitHub's fine-grained "Codespaces secrets" permission gates even the reads at WRITE, so a read-only grant cannot run this section in check mode either.
- Undeclared secrets kept by default; `_undeclared: delete` opts into deletion.
- Snapshot lists the secret names as per-store `$SECRET_<STORE>_<NAME>` references with one note per value to export, since values are not readable.

**Copilot agents secrets** (`agents_secrets`)

- GET /repos/{owner}/{repo}/agents/secrets, GET .../agents/secrets/public-key (read at apply), sealed PUT/DELETE .../agents/secrets/{secret_name}.
- Same shape, sealing, and existence-only semantics as `actions_secrets`, over the Copilot agents secret store.
- GET .../agents/organization-secrets is a read-only view of org-inherited secrets, not a reconciliation target.
- Undeclared secrets kept by default; `_undeclared: delete` opts into deletion.
- Snapshot lists the secret names as per-store `$SECRET_<STORE>_<NAME>` references with one note per value to export, since values are not readable.

**Workflow enable/disable state** (`workflows`)

- GET /repos/{owner}/{repo}/actions/workflows (paginated envelope), then PUT .../workflows/{id}/enable or /disable.
- Declared as {path, state: active or disabled}; a bare file name matches `.github/workflows/<name>`.
- Every live disabled_* state counts as disabled and a live "deleted" workflow counts as absent; undeclared workflows are never touched.
- Snapshot reads every present workflow back as {path, state}, each disabled_* state as disabled; deleted workflows are left out.

**Check suite preferences** (`check_suite_preferences`)

- PATCH /repos/{owner}/{repo}/check-suites/preferences: per-app auto_trigger_checks toggles ({app_id, setting} pairs) controlling whether pushes automatically create check suites, sent verbatim.
- CAVEAT (write-only upstream): GitHub exposes NO companion GET, so check mode cannot verify the preferences - it emits one cannot-verify note and issues zero requests - and apply re-asserts the declared preferences on EVERY run (the PATCH's 200 echoes the resulting preferences, which the change line reads).
- With nothing to read, the apply-mode preflight cannot probe this section either, so a denied write surfaces only after other sections' writes landed (the Git LFS precedent).
- The token owner must be a repository administrator (fine-grained PATs with Checks read+write work).

**GitHub Pages** (`pages`)

- Covers build_type, source, cname, https_enforced, and any PUT field GitHub adds; pages: null disables the site.
- POST /repos/{owner}/{repo}/pages (create accepts only build_type/source) then PUT for the rest; existing sites get straight PUT passthrough; pages: null issues DELETE, mirroring branches' protection: null.
- In a mode: render fold, pages: null is written as the section's value even over a lower layer's pages declaration, so the rendered file turns the site off (the layering guide owns that rule); a multi-repo defaults-file never merges into a target's file.
- Snapshot reads the live site back on the declared keys; a repository without Pages is omitted rather than declared null.

**Fields the Pages update ignores** (`pages`)

- Parsing the file refuses the fields only the site GET reports (url, html_url, status, custom_404, protected_domain_state, pending_domain_unverified_at, https_certificate) and a source.path other than / or /docs, the only directories Pages publishes from.
- Sent, GitHub would drop the fields and report them as drift on every run, and the path would 422 at apply.
- A workflow-built site still reports its source, so build_type: workflow beside a source converges.

**Pages site visibility** (`pages`)

- The boolean `public` rides the PUT passthrough.
- Only an organization on Enterprise Cloud can set it; everywhere else GitHub reports public: true and ignores the field, so a public: false declaration drifts on every run and the check run's note says why.
- A live public: false proves the host sets visibility, so declaring true there is ordinary drift with no note.

**Code scanning default setup** (`code_scanning_default_setup`)

- GET/PATCH /repos/{owner}/{repo}/code-scanning/default-setup, PATCH body verbatim (state, query_suite, languages, runner_type, runner_label, threat_model).
- A 202 answer means GitHub rolls the change out in a configuration run, which the log names.
- Check compares declared keys only, languages as a set in the PATCH's vocabulary, and notes a key the GET never echoes as never converging; parse refuses the GET-only schedule and updated_at.
- Needs GitHub Advanced Security on private repositories; a 403 can mean that (or an archived repository) rather than a missing permission.
- Snapshot reads the GET body back on the declared keys; a null the slice does not take (a not-configured setup's runner_type) is omitted.

**Code quality setup** (`code_quality_setup`)

- GET/PATCH /repos/{owner}/{repo}/code-quality/setup, PATCH body verbatim (state, languages, runner_type, runner_label, ai_findings_option), the near field-for-field mirror of code_scanning_default_setup.
- A 202 answer means GitHub rolls the change out in a configuration run, which the log names; a 409 means a configuration run is already in progress (re-run the workflow after it finishes).
- A 403 can mean code quality is unavailable on the repository or the repository is archived, rather than a missing permission, and a 422 (the change cannot be applied) carries GitHub's message verbatim.
- Check compares declared keys only, languages as a set in the PATCH's vocabulary, and notes a key the GET never echoes as never converging; parse refuses the GET-only schedule and updated_at.
- GitHub gates the GET at write (the Codespaces secrets precedent), so a read-only Administration grant cannot run this section in check mode either; the declaration grades the read as write (src/sections/shared/setup-section.ts).
- The sibling /code-quality/findings endpoints are read-only and stay out of scope.
- Snapshot reads the GET body back on the declared keys; a null the slice does not take (a not-configured setup's runner_type) is omitted.

**Collaborators** (`collaborators`)

- Direct collaborators only. PUT/DELETE /repos/{owner}/{repo}/collaborators/{username} (affiliation=direct); new users get invitations.
- Vocabulary mapping push<->write, pull<->read for check mode; custom org role names pass through.
- Undeclared direct collaborators are REMOVED by default (kept as notes under the wrapped `_undeclared: keep` form); the owner is never touched.
- Snapshot reads the direct collaborators and the pending username invitations back as entries under the delete default, each role through the inverse mapping (write -> push, read -> pull, custom role names verbatim).
- The snapshot leaves out the repository owner, email invitations, and expired invitations with a note; a live role no declaration plans as (a custom role named "push" or "pull") fails the collaborators section, and the snapshot is written as partial without it.

**Repository invitations** (`collaborators`)

- Pending invitations are reconciled alongside the collaborators via GET /repos/{owner}/{repo}/invitations and PATCH/DELETE /repos/{owner}/{repo}/invitations/{invitation_id}.
- A declared user's matching pending invitation converges, a stale permission is PATCHed in place, and an expired invitation is cancelled and re-sent.
- A declared custom role cannot be verified against an invitation (the standard-roles enum), so the invitation is kept with a note.
- Undeclared pending invitations follow the section's one undeclared policy; email invitations, which no username can declare, are noted and left untouched.

**Team repository permissions** (`teams`)

- Org repos only. PUT/DELETE /orgs/{org}/teams/{slug}/repos/{owner}/{repo}; the section probes GET /orgs/{owner} and no-ops with a note on personal accounts (404 only; 403/5xx still fail).
- Both modes probe each declared team's access with the v3.repository media type to read role_name, and the grant is issued only when the team lacks access or its live role diverges.
- The repository's team list (GET /repos/{owner}/{repo}/teams) names the undeclared teams: kept by default and noted (a team is often granted by the org for reasons outside one repository's file).
- Under the wrapped `_undeclared: delete` form a team's DIRECT grant is revoked, while access granted at the organization or enterprise level is noted as beyond the repository's reach.
- A declared child team whose access comes through an undeclared parent's grant loses it with that revocation (the probe reads the inherited role as converged): declare the parent too, or keep.
- Snapshot lists the same teams and reads each team's role through the same probe, so a custom role reads back by name, and writes the wrapped form with the keep default spelled out.
- Left out of the snapshot with a note: access granted at the organization or enterprise level, a probe 404 (no access, or a fine-grained token missing the grant; the note names both), a role the probe does not report, and a role no declaration plans as (a custom role named "push" or "pull").
- A personal account snapshots nothing.

**Milestones** (`milestones`)

- POST/PATCH/DELETE /repos/{owner}/{repo}/milestones, matched by title, declared-keys-only (description/state/due_on untouched unless declared; a due_on is a calendar day, compared and converged as the day GitHub keeps).
- Undeclared milestones are kept by default and surfaced as notes, because deleting a milestone DETACHES it from every issue carrying it - the wrapped `_undeclared: delete` form opts into exactly that.
- Snapshot reads every milestone, open and closed, back as entries under the keep default.

**Interaction limits** (`interaction_limits`)

- GET/PUT/DELETE /repos/{owner}/{repo}/interaction-limits, plus the two routed keys in the rows below.
- The section takes exactly four keys; any other one fails at parse time, GitHub's read-back origin and expires_at included, as do a limit or expiry outside GitHub's enums and a cap outside 1-1000.
- Limits self-expire (expiry tops out at six_months), so apply re-arms the declared limit on EVERY run and check mode reports drift once it lapses - schedule apply more often than the chosen expiry to keep it armed.
- The declared expiry is write-only (GitHub reads back only the computed expires_at), so check verifies the limit value, not the duration.
- `interaction_limits: null` clears a live repo-level limit - the base limit only, never the cap or bypass list below.
- In a mode: render fold, interaction_limits: null is written as the section's value even over a lower layer's declaration, mirroring pages: null, so the rendered file clears the limit.
- A 409 means an organization- or user-level limit overrides the repository's; writes surface that as a note, not a failure, while check mode still reports a mismatched declaration as drift - the org is the place to change it.
- Snapshot reads back the repository-level limit (an inherited one is left out with a note, and the expiry duration is not readable), the cap when the feature exists and is enabled, and the bypass list when it has members.

**Pull request creation cap** (`interaction_limits`)

- `pull_request_creation_cap` routes to GET/PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap: persistent desired state with no self-expiry (enabled plus max_open_pull_requests 1-1000, read back verbatim), so check diffs it exactly and apply PATCHes only on divergence - no re-arm.
- GitHub gates the cap GET at write, so a read-only Administration grant cannot check this key.
- Where the cap is unavailable the endpoints answer 405, which apply surfaces as a note (like the 409) and check as honest drift.

**Pull request creation cap bypass list** (`interaction_limits`)

- `pull_request_creation_bypass` routes to GET/PUT/DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list and reconciles: apply DELETEs only the undeclared logins and then PUTs only the missing ones ({users: [logins]}, compared case-insensitively), never a wholesale replace.
- GitHub gates the bypass-list GET at write, so a read-only Administration grant cannot check this key.
- Removals go first because the list holds at most 100 users, which also caps the declaration; a declared empty list removes everyone.

**Actions variables** (`actions_variables`)

- GET/POST /repos/{owner}/{repo}/actions/variables and PATCH/DELETE /repos/{owner}/{repo}/actions/variables/{name}: plain-text repository variables, upserted by name.
- Names are case-insensitive (GitHub stores them uppercased regardless of how they are entered), so matching and duplicate rejection compare uppercased names.
- Values read back in full, which is what makes exact check-mode diffing possible; undeclared variables are DELETED by default, kept as notes under the wrapped `_undeclared: keep` form.
- The list endpoint caps per_page at 30 (not the usual 100), which the page loop honors so a large inventory is never truncated.
- Secrets are write-only material and deliberately NOT this section: they live in the `actions_secrets` section above.
- Snapshot reads the variables back as name and value entries under the delete default.

**Copilot agents variables** (`agents_variables`)

- GET/POST /repos/{owner}/{repo}/agents/variables and PATCH/DELETE /repos/{owner}/{repo}/agents/variables/{name}: same upsert-by-uppercase-name semantics, exact check-mode diffing, and 30-item per_page cap as `actions_variables`, over the Copilot agents variable store.
- GET .../agents/organization-variables is the read-only org-inherited view, out of scope.
- Undeclared variables are DELETED by default, kept as notes under the wrapped `_undeclared: keep` form.
- CAVEAT: GitHub auto-migrated values from the older `copilot` Actions environment into this store, so a repository can hold agents variables nobody created here - run `mode: check` first (it lists them as deletion drift) before the first apply, or declare `_undeclared: keep`.
- Snapshot reads the variables back as name and value entries under the delete default.

**Webhooks** (`webhooks`)

- GET/POST /repos/{owner}/{repo}/hooks, PATCH/DELETE .../hooks/{hook_id}, and PATCH .../hooks/{hook_id}/config.
- At most ONE web hook per config.url (the natural key); two live hooks under one url fail loudly, and a changed url is a NEW hook (the old one turns _undeclared: kept and noted by default, deleted under `_undeclared: delete`).
- A legacy service hook (name other than "web") or a hook without a config.url is outside the section: plan neither matches nor deletes it, snapshot notes it.
- Config-field drift goes through the config sub-endpoint, which updates named fields without the general PATCH's whole-config replacement, so a live secret the file does not declare is never removed; events/active drift rides the general PATCH with no config key.
- config.secret is declared as a whole-value `$NAME` reference resolved from the step env at apply time ([secrets and vaults](secrets-and-vaults.md)); GitHub echoes a live secret as "********", so check mode verifies everything except the secret (a cannot-verify note) and apply re-sends the declared secret every run so rotations propagate.
- insecure_ssl compares number and string spellings as equal (GitHub stores strings); events compare as a set.
- Hook urls appear in drift and change lines on purpose: they are configuration, not credentials (the secret is the masked part).
- Snapshot reads the hooks back as entries under the keep default, a set secret as a `$SECRET_WEBHOOK_<id>` reference with a note to export it.

**Custom property values** (`custom_properties`)

- GET /repos/{owner}/{repo}/properties/values (unpaginated) and ONE bulk PATCH on the same path carrying every divergent declared property, skipped entirely when nothing diverges.
- Values of org-defined properties only: property DEFINITIONS are /orgs/-scoped and not managed here, so the section probes GET /orgs/{owner} and no-ops with a note on personal accounts (404 only; 403/5xx still fail), mirroring `teams`.
- `value: null` unsets a property (reverting to the org default, if any); booleans/numbers normalize to their string form (GitHub transports true_false values as the strings "true"/"false"); multi_select lists compare order-insensitively.
- The values READ is gated by Metadata only (every fine-grained token holds it), so only the PATCH needs the "Custom properties" grant; a 403 on it can also mean the org restricts a property's values to org actors (values_editable_by: org_actors), and a 422 means the property is not defined at the organization level or the value does not fit its definition.
- Undeclared live values are KEPT by default (an unset can revert to an org default the action does not model); the wrapped `_undeclared: delete` form opts into unsetting them.
- Snapshot reads the set values back as entries under the keep default; unset (null) values are omitted, and a personal account yields nothing with a note.

**Deploy keys** (`deploy_keys`)

- GET/POST /repos/{owner}/{repo}/keys and DELETE /repos/{owner}/{repo}/keys/{key_id}, matched by exact title (two live keys under one title fail loudly, since GitHub does not enforce title uniqueness).
- The declared material is a PUBLIC key, so it is safe to keep in settings.yml (unlike secrets).
- Keys are immutable upstream (no update endpoint exists), so a changed key or declared read_only is applied as delete + recreate, the autolinks pattern; an UNDECLARED read_only survives the recreate, since the live value is re-sent, so a rotation never widens access.
- Renaming a key while keeping its material cannot be applied - the one-repository-per-key rule makes the create collide with the live key - so the section fails loudly naming the live holder; delete or rename the live key on GitHub first.
- Material is compared as algorithm + base64 blob with the trailing comment ignored, because GitHub may strip or rewrite comments on storage - a raw-string compare would replace the key on every apply.
- A live key under an algorithm the settings file cannot declare is outside the section: GitHub accepted it, so it is never matched, deleted, or aborted on, and a snapshot leaves it out with a note.
- A 422 on create can mean the public key is already attached to another repository (one repository per key, account-wide); the error says so.
- Undeclared keys are KEPT by default (deleting a live deploy key breaks whatever service authenticates with it, and deployment tooling installs its own keys); the wrapped `_undeclared: delete` form opts into deletion.
- Snapshot reads the live keys back (title, comparable material, read_only) under the keep default.

**Secret scanning custom patterns** (`secret_scanning_custom_patterns`)

- Repository-level patterns. GET /repos/{owner}/{repo}/secret-scanning/custom-patterns (paginated), bulk POST on the same path ({patterns: [...]}), PATCH .../custom-patterns/{pattern_id}, and bulk DELETE on the collection path (ids in the request body).
- Patterns are matched by name; the name is immutable upstream (the PATCH takes no name field), so a rename creates the new name and the old pattern follows the undeclared policy - deleted under `_undeclared: delete`, kept and noted under the default keep.
- The declarable surface is name, pattern, start_delimiter, end_delimiter, and the must_match/must_not_match regex lists; `state` and `push_protection_enabled` are READABLE in the GET but NOT writable through these endpoints (no field in the POST/PATCH bodies, no sub-endpoint), so they cannot be declared and the validator says so.
- CAVEAT (state is invisible to drift): an UNPUBLISHED live pattern whose fields match the declaration reads as converged even though it is not enforcing - no publish endpoint exists, so publishing stays a UI action, and that includes a pattern this action just created.
- GitHub does not document the state a bulk-created pattern lands in, so verify the first apply in the UI.
- A delimiter, once set, cannot be cleared back to GitHub's default through the PATCH (it updates provided fields only); delete and redeclare the pattern without the field instead.
- Every regex field passes a syntax check at parse or the file is refused naming the field, before any pattern is read or written.
- The check translates the PCRE-only forms Hyperscan accepts (`(?P<name>`, `(?#comment)`, `\x{HH}`, inline modifiers such as `(?i)`, atomic groups, possessive quantifiers, `\Q...\E`, POSIX classes, the start-of-pattern control verbs `(*UTF8)`, `(*UTF)` and `(*UCP)`) and compiles the result as a flagless JavaScript RegExp.
- It refuses what PCRE syntax refuses (an unbalanced group or class, a dangling quantifier, a quantifier on an anchor, a trailing backslash, a range out of order, a group name declared twice) and the `(?` openings it does not know, such as the subroutine call `(?1)`, which Hyperscan refuses as well.
- It cannot see what Hyperscan alone refuses (lookbehind, backreferences, the option modifiers GitHub documents as unsupported), and it leaves an extended-mode pattern (`(?x)`) unchecked, so GitHub can still refuse an expression at apply.
- A live pattern the check cannot verify is left out of a snapshot with a note naming it, never a failed snapshot.
- Writes ride optimistic concurrency whenever GitHub supplies a version: the list GET carries each pattern's custom_pattern_version, the PATCH/DELETE send it back, and a 412 means the pattern changed mid-run (re-run the workflow); a version-less pattern (the field is optional and nullable upstream) writes without the check, as the API allows.
- Undeclared patterns are KEPT by default (removing a pattern disposes of its alerts, so it stays a human opt-in; `_undeclared: delete` opts in), and every delete this action issues sends post_delete_action: "resolve_alerts" - never upstream's alert-deleting default - so the audit trail survives.
- Needs secret scanning enabled (GitHub Advanced Security on private repositories); a 404 can mean that rather than a missing grant.
- Snapshot reads the live patterns back (name, pattern, delimiters, must_match lists) under the keep default.

## Repo-scoped gaps (not built yet)

The table is EMPTY right now: every previously known gap has been implemented (see the Supported table). A new row belongs here the moment GitHub ships a repo-scoped setting this action cannot yet apply; PRs welcome.

| Area | Endpoints | Why it matters |
|---|---|---|

## No public API (cannot be built)

Repo-scoped settings the GitHub UI offers but no REST or GraphQL endpoint can write independently (a few carry a read-only GET, and the dependency graph flips only as a side effect of another endpoint; both noted inline). These stay unsupported until GitHub ships a write API for them:

- The "Include in the home page" sidebar checkboxes (Releases, Packages, Deployments/Environments). [PATCH /repos/{owner}/{repo}](https://docs.github.com/en/rest/repos/repos) has toggles for issues, wiki, projects, pull requests, and discussions, but nothing controls those three sections' visibility.
- Discussion categories. No REST endpoint creates or manages them, and GraphQL can only read them; category management is UI-only. Enabling discussions itself (has_discussions) rides the repository PATCH passthrough (verified live; the [PATCH docs](https://docs.github.com/en/rest/repos/repos) omit the field but the API accepts it).
- The social preview image (Open Graph image). No PATCH /repos field and no standalone endpoint; GraphQL's openGraphImageUrl is read-only. Upload is UI-only under Settings.
- The wiki "Restrict editing to collaborators only" checkbox. The only wiki field anywhere is the has_wiki on/off toggle (supported via the repository PATCH passthrough); no REST or GraphQL surface controls who may edit.
- The Copilot Autofix repository checkboxes for code scanning: the main toggle and the separate "Copilot Autofix for third-party tools" one, independently settable stored booleans (each has its own repo.* audit log event pair). The code-scanning REST surface only exposes imperative autofix operations on individual alerts; no endpoint reads or writes either repo toggle.
- Dependabot auto-triage rules (custom alert-handling rules). UI-only; the Dependabot REST category has alerts, dismissal requests, and secrets, but no rules endpoints.
- Automatic dependency submission (the Settings dropdown that makes Actions submit build-time dependencies). No repo REST endpoint reads or writes it; org-side enablement goes through org-scoped code security configurations.
- Codespaces prebuild configurations. A real per-repo settings surface (branch, devcontainer path, triggers, regions) with no REST or GraphQL management endpoints; the builds themselves run as Actions workflows.
- Copilot coding agent repository configuration (MCP servers, firewall and custom allowlist, enabled tools, Actions workflow approval, automations; Settings > Copilot). Writes are UI-only; the sole API is the read-only GET /repos/{owner}/{repo}/copilot/cloud-agent/configuration (public preview), enough to audit drift but not to apply.
- Copilot coding agent, continued: the org-side PUTs control which repositories may use the agent, not this per-repo configuration; a shipped write endpoint would move this to the gaps table. (Copilot code review is NOT missing: it is the copilot_code_review rule type, already covered by the rulesets passthrough.)
- Repo-level Copilot content exclusion ("Paths to exclude in this repository"). The content-exclusion REST surface has only org- and enterprise-level GET/PUT; repo names in the org payload edit the org layer, and the repository's own layer has no endpoint.
- The Copilot Memory repository toggle (Settings > Copilot > Memory; lets repo admins disable storing and reading repository-level memories; public preview since May 2026). UI-only: the REST Copilot category has no memory endpoints, no GraphQL surface exists, and unlike the coding agent configuration above there is not even a read-only GET to audit it.
- The dependency graph toggle. No standalone field anywhere (not in security_and_analysis); PUT/DELETE /repos/{owner}/{repo}/vulnerability-alerts flips the graph only as a coupled side effect of Dependabot alerts (see the Supported table), and the graph-on/alerts-off combination is neither writable nor readable. A live decision since June 2025, when new public repositories started defaulting the graph to off.
- Code review limits (Settings > Moderation options: "Limit to users explicitly granted read or higher access"). UI-only; a different setting from the supported interaction limits, and neither PATCH /repos nor any GraphQL mutation carries it.
- Email notifications for pushes (up to two addresses under Settings). The legacy write path (email service hooks) died with the GitHub Services sunset; the webhooks API now accepts only name "web".
- Reported content / "allow contributors to report abuse" (Settings > Moderation options on public org-owned repositories). UI-only; the nearest API, the minimizeComment GraphQL mutation, is imperative per-comment triage, not this setting.
- The "Include Git LFS objects in archives" checkbox (Settings > General > Archives). Distinct from LFS enable/disable (supported); no REST or GraphQL surface reads or writes it.
- The push policy ("Limit how many branches and tags can be updated in a single push", Settings > General > Pushes). max_ref_updates appears nowhere in GitHub's REST OpenAPI description, and GraphQL's RepositoryRuleType enum carries MAX_REF_UPDATES with no corresponding parameters type in RuleParameters or RuleParametersInput, so neither the rulesets passthrough nor GraphQL can write it.
- The push policy, continued: given the rulesets row's day-one promise for new rule types and that enum value's existence, probe the rulesets POST with a max_ref_updates rule once before treating it as unwritable.
- The grouped security updates toggle (Settings > Advanced Security > Dependabot). No REST or GraphQL field; distinct from automated-security-fixes (supported) and from dependabot.yml's groups key (repo content, out of scope). A security_and_analysis subfield, once GitHub ships one, is refused at parse until the closed schema adds it.
- The secret scanning "Extended metadata" sub-toggle (Settings > Advanced Security > Secret Protection > Validity checks; public preview, requires validity checks on). Writable only through org- and enterprise-level code security configurations (secret_scanning_extended_metadata); no repo-level field exists even in the GHEC docs, and the per-repo GET /repos/{owner}/{repo}/code-security-configuration is read-only.
- Extended metadata, continued: the parent validity-checks toggle IS writable, since security_and_analysis.secret_scanning_validity_checks rides the supported passthrough (see the Supported table).
- Code scanning delegated alert dismissal (the "Prevent direct alert dismissals" checkbox under Settings > Advanced Security). The only writable code_scanning_delegated_alert_dismissal field lives on org- and enterprise-level code security configurations; PATCH /repos' security_and_analysis carries only the SECRET-scanning delegated fields (explicit keys of the closed schema), and the repo-scoped dismissal-requests endpoints are imperative per-alert triage. A security_and_analysis subfield, once GitHub ships one, is refused at parse until the closed schema adds it.
- The code scanning "AI findings" toggle (AI-powered findings for CodeQL default setup, public preview; repos can opt out of the org default individually). The default-setup PATCH body carries no AI-findings field - ai_findings_option exists only on the separate code-quality setup endpoints, supported via the `code_quality_setup` section - and no security_and_analysis subfield or GraphQL surface exists.
- AI findings, continued: the only trace is the repo.code_scanning_ai_findings_* audit events. A default-setup field, once GitHub ships one, would be absorbed by that section's verbatim PATCH passthrough.
- The "Dependabot on self-hosted runners" toggle (Settings > Advanced Security > Dependabot, private repositories). No REST or GraphQL read or write surface; the Dependabot REST category has only alerts, dismissal requests, and secrets. Distinct from out-of-scope runner registration: this is a stored repo boolean (audit events repository_dependency_updates_self_hosted.enabled/.disabled).
- The "Access to alerts" list (Settings > Advanced Security; extra users/teams granted Dependabot/security alert access on private org repositories). A persistent, reconcilable actor list - the natural sibling of the collaborators section - but UI-only: no REST endpoint or GraphQL mutation manages it (the org-scoped PATCH /orgs/{org}/dependabot/repository-access is a different surface).
- Pinned workflows in the Actions tab (up to 5, repo-wide display state). No pin route exists among the REST workflows endpoints and GraphQL has no pinWorkflow mutation - unlike environments, whose pinEnvironment mutation the environments section drives through the per-environment `pinned` key. Only the workflows.pin_workflow/unpin_workflow audit events betray that it is stored repo state.
- The "Auto-close issues with merged linked pull requests" toggle (Settings > General > Issues; shipped April 2025, default on). Neither PATCH /repos (per the OpenAPI descriptor) nor GraphQL updateRepository carries a corresponding field. Probe the PATCH for an undocumented field (the has_discussions precedent) before treating it as unbuildable.
- The GitHub Archive Program opt-in (the "Preserve this repository" checkbox under Settings > General > Features on public repositories; default on, admin-only). No field on PATCH /repos in either doc flavor, no standalone endpoint, no GraphQL surface; the supported `archived` PATCH boolean is the unrelated read-only-archive toggle.
- Workflow execution protections (Settings > Actions > Policies; public preview since June 2026): repository-level rulesets with actor allow rules (users, repo roles, GitHub Apps, Copilot, Dependabot) and event allow rules (push, pull_request, pull_request_target, workflow_dispatch), plus an evaluate mode.
- Workflow execution protections, continued: built on the rulesets framework, but the REST rulesets endpoints accept only branch, tag, and push targets and the feature docs name no API, so the supported rulesets passthrough cannot reach it - its day-one promise covers new rule types within documented targets, not a new target flavor.
- Workflow execution protections, continued: probe the rulesets endpoints with the new flavor once before treating it as unwritable; a shipped write API moves this to the gaps table.

## Out of scope (user or org account surface)

- User account surface (profile, emails, notification settings, SSH/GPG/signing keys, blocking, starring/watching, user migrations): User-scoped, not repository configuration, exactly what the tenet's second half excludes. Watching/subscription state on a repo is likewise per-user, not a property of the repo.
- Organization settings (membership, org-level Actions policies, runner groups, org webhooks, org rulesets, org secrets/variables and their repo-selection lists, custom property DEFINITIONS, custom repository roles, code security configurations): Org-account-scoped (/orgs/* endpoints); they influence repos from above but are not settings OF a repository. Their repo-visible effects (org rulesets, applied security configs) surface read-only and are already filtered out (e.g. rulesets skips source_type != Repository).
- GitHub Packages: Package namespaces and their settings belong to the user or org account even when a package is linked to a repo; explicitly user/account territory under the tenet.
- Legacy tag protection API: Deprecated and removed by GitHub (sunset August 2024); no endpoints remain. Its function is fully covered by tag-target rulesets, which are supported.
- Projects: Classic repo projects are sunset; Projects v2 are user/org-owned GraphQL objects merely linked to repos. The repo-level has_projects flag rides the repository PATCH passthrough.
- Pinned issues: GraphQL pinIssue/unpinIssue exist (max 3 pins, readable back via Repository.pinnedIssues), but a pin's value is an issue number - per-repo work-item content, not repository configuration - and re-asserting pins from YAML would fight ongoing triage. Named here because the surface is real and settings-adjacent; deliberately unmanaged, unlike pinned environments, whose values are environment names the settings file already owns (the environments section's `pinned` key).
- Releases: Releases are content/artifacts, not configuration. The one release-policy setting with a REST surface, immutable releases, is supported via the repository section's enable_immutable_releases toggle (see the Supported table); anything else GitHub ships as a field on PATCH /repos gets picked up by the repository passthrough automatically.
- Repo-content-borne configuration (CODEOWNERS, dependabot.yml, workflow files, issue/PR templates, FUNDING.yml, .gitattributes): These are versioned files in the repository tree, managed by commits/PRs (e.g. by the fleet sync), not by the settings REST API. Writing repo content is a different tool's job.
- Self-hosted runners (repo-level registration, labels): Operational infrastructure lifecycle: registration requires short-lived tokens and a live agent process; there is no meaningful declarative desired-state to reconcile from a YAML file.
- Imperative repository operations (transfer, archive-via-migration, fork creation, branch create/rename, workflow/repository dispatch, cache purges, alert triage for code scanning / secret scanning / Dependabot alerts, issues and PRs): One-shot actions or work items, not settings; running them repeatedly from declarative state is meaningless or destructive. (The archived boolean itself IS supported via repository PATCH.)
- Codespaces user/org configuration (user secrets, machine-type policies, org access controls): User- and org-scoped; the only repo-scoped Codespaces surface is repository Codespaces secrets, supported via the `codespaces_secrets` section.
- Read-only repository surfaces (traffic, statistics, languages, SBOM/dependency graph exports, attestations, community profile): Nothing to configure; GET-only endpoints with no desired state to apply.
<!-- END GENERATED: coverage -->
