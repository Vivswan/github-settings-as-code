# Token permissions

Every API call runs on the token you pass, so the grants on that token decide what the action can manage. This page is the permissions model: which grant each section needs, how to scope a PAT, what a denial looks like, and the policy inputs that decide whether a denial fails the run or skips the section.

## What to grant

The PAT permission column in the README's [Sections table](../../README.md#sections) names the grant each section needs. Grant only the permissions for the sections your settings file declares, plus the two cross-cutting grants that belong to no section: Contents at read when the action must fetch a settings file it does not have checked out (remote multi-repo targets), and Issues at read and write only when a `private-report` issue channel (`issue` or `issue-on-failure`) is enabled (see [private repositories](../operate/private-repositories.md)). The Contents grant earns its keep twice: as the Sections table notes, it also lets `branches` tell a missing branch from an unprotected one in check mode. Beyond those the action never needs more. In multi-repo mode the token needs the same permissions on every target repository.

To manage everything in one PAT, grant Administration, Issues, Environments, Pages, Actions, Variables, Webhooks, Checks, Secrets, Dependabot secrets, Codespaces secrets, Agent secrets, Agent variables, Custom properties, and Secret scanning alerts at write, plus Contents at read and (for org repos) the Members organization permission at read. The pre-filled token form linked under the README's [Usage](../../README.md#usage) grants exactly the repository half of that set.

The default `GITHUB_TOKEN` can never hold most of these grants (Administration in particular), so plan on a fine-grained PAT.

## How a denial surfaces

A section whose token lacks its grant fails with an error naming the denied request and its HTTP status, plus advice starting "To fix, grant" that names the exact fine-grained permission. Three things worth knowing when a run fails on permissions:

- `mode: check` changes no settings, so the read half of each permission is enough for a drift-report-only workflow - with two exceptions. GitHub gates even the Codespaces secrets reads at write, so `codespaces_secrets` needs its write grant in check mode too. And the `private-report` issue channels can write even in check mode (`issue` writes its report issue on every run; `issue-on-failure` opens it on drift and closes it on recovery), which takes the Issues grant.
- Fine-grained tokens surface a missing Administration permission as a 404, not a 403, on admin endpoints. The action treats both as permission errors and its messages name the exact permission to grant.
- `repos: "*"` discovery needs a user PAT; the workflow `GITHUB_TOKEN` and GitHub App installation tokens cannot enumerate a user's repositories. Remote multi-repo targets also need Contents: read on every target, because each repository's own settings.yml is fetched through the contents API.

Not every 403 is a missing grant. Rate limits can arrive as 403, and the action tells them apart by the API's own message; a few endpoints answer 403 for feature policies instead (an org-managed Actions cache policy, Advanced Security off on a private repository, Git LFS disabled account-wide). The [troubleshooting guide](../operate/troubleshooting.md) walks through reading each of these.

## The denial policy

Permission failures are the only errors the run can be told to tolerate; everything else always fails with the API message verbatim (see [Semantics](semantics.md)). Two inputs set the policy.

Under the default `on-missing-permission: fail`, any denied section fails the run. In apply mode the [preflight barrier](semantics.md#the-preflight-barrier) probes every declared section read-only before anything is written, so a read denial under `fail` stops the run before the first write. The probe cannot see the write half of a grant, though: a token that reads a section but cannot write it still fails mid-apply. The engine is idempotent, so fixing the token and re-running converges.

`on-missing-permission: warn` turns a denial into a skip: the section is skipped with a warning annotation, the run continues, and when nothing else drifts or fails the result is `partial` and the run stays green. That is partial success as a policy, useful when one token manages a fleet whose repositories do not all grant the same permissions.

`required-sections` names the sections that must still fully apply even under `warn`: a denial on a required section fails the run regardless. It is a minimum-requirements floor - soften everything else, but never report success while, say, `rulesets` could not be applied. A required section must also be allowed by the `sections` input when that allowlist is set: an excluded section is never attempted, so requiring it would be a promise the run cannot check, and the pairing is rejected before any API call.

## Organization repositories

Two caveats live on the organization rather than the repository. The `teams` section needs the Members organization permission at read, and the token form only offers organization permissions once an organization is selected as the resource owner - add it by hand when you use the pre-filled form. And a `custom_properties` write can be refused upstream regardless of the grant: a 403 on the values PATCH can mean the org restricts a property's values to org actors (`values_editable_by: org_actors`), and a 422 means the property is not defined at the organization level.
