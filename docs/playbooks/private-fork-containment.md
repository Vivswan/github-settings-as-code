# Private-fork PR containment

A workflow triggered by a fork's pull request runs the fork's code, and on a private repository the settings decide what that code can reach: whether it runs at all, whether it gets a write-capable token, and whether secrets and variables flow into it. A contributor who can open a pull request from a fork should not be able to exfiltrate secrets or approve their own changes. One settings block declares the containment posture:

```yaml settings
actions:
  default_workflow_permissions: read
  can_approve_pull_request_reviews: false
  fork_pr_contributor_approval:
    approval_policy: all_external_contributors
  fork_pr_workflows_private_repos:
    run_workflows_from_fork_pull_requests: true
    send_write_tokens_to_workflows: false
    send_secrets_and_variables: false
    require_approval_for_fork_pr_workflows: true
```

The two halves cover different surfaces. `fork_pr_contributor_approval` decides who needs a maintainer's approval before their fork PR workflows run (`all_external_contributors` gates everyone outside the repository; the looser policies gate only first-time contributors, or only contributors new to GitHub). `fork_pr_workflows_private_repos` decides what a fork PR workflow receives once it runs: this file lets fork PRs run CI at all (`run_workflows_from_fork_pull_requests: true`) while keeping write tokens and secrets out of them and requiring an administrator's approval per run. GitHub documents each approval control independently and does not document how the two interact when both apply, so read the block as defense in depth - every layer declared, whichever gates first - rather than as a precise approval flow. Alongside `default_workflow_permissions: read` and `can_approve_pull_request_reviews: false`, even a workflow that does run holds a read-only token and cannot approve the pull request that triggered it.

Two scope notes keep expectations honest. The `fork_pr_workflows_private_repos` endpoint is documented for private repositories, where private forks exist; GitHub does not document what it answers on a public repository (the documented failure statuses are bare denials), so in a mixed fleet this block belongs in a `visibility: private` cohort, while public repositories rely on the approval policy and GitHub's public-fork defaults. And all four toggles are required on purpose: GitHub does not document whether the PUT preserves or resets a toggle the body omits, so this action only accepts the complete policy - which also means no toggle is ever a policy nobody is watching.
