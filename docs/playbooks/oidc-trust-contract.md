---
order: 340
---

# A cloud OIDC trust contract

Cloud providers trust GitHub Actions through OIDC: a deploy role's trust policy matches conditions against the workflow token's subject claim. The default subject format varies by trigger (an environment-scoped job, a branch push, and a pull request each produce a different shape), so trust policies written against it tend to end up looser than intended. Pinning the claim keys turns the subject shape into a reviewable contract:

```yaml settings
actions:
  oidc_customization_sub:
    use_default: false
    # Per-repo template: this repository's OIDC jobs flow through a
    # reusable deploy workflow. The fleet baseline layer stops at
    # [repo, context] - see the fleet note below.
    include_claim_keys: [repo, context, job_workflow_ref]
```

With that template every subject carries the same claim-key sequence, `repo:ORG/REPO:<context>:job_workflow_ref:PATH`. The `context` segment's value still varies with the trigger, exactly as the default subject's tail does: an environment-scoped job yields `environment:ENV`, a branch push `ref:refs/heads/BRANCH`, a pull request `pull_request`. For an environment-scoped deploy job the subject reads:

```text
repo:acme/payments:environment:production:job_workflow_ref:acme/platform/.github/workflows/deploy.yml@refs/heads/main
```

and a trust policy that requires that exact string admits only production-environment deploys flowing through that one reusable deploy workflow. A minimal `[repo, context]` template reproduces the default subject shape exactly; that is still worth pinning as a drift guard against upstream format changes, but the hardening comes from the extra keys.

Three details carry the pattern:

- Claim-key order defines the subject format, so the list is compared positionally and a reordered live value is drift.
- The OIDC endpoints need the `Actions` PAT permission rather than the Administration grant the rest of the section uses (the [Sections table](../reference/sections.md) notes it).
- A claim key the job cannot supply becomes a requirement the moment it is included; GitHub documents `job_workflow_ref` for reusable-workflow jobs only, and says exactly that for `environment`, which turns mandatory once listed.

The fleet story is two layers. `[repo, context]` belongs in the fleet baseline layer, turning every repository's subject shape into one reviewed line; `job_workflow_ref` belongs in the layer of a repository whose OIDC jobs flow through reusable workflows. In a `mode: merge` fold the higher layer's `include_claim_keys` list replaces the baseline's wholesale (lists never concatenate; see the [layering guide](../operate/layering.md)), so the repository's template is exactly what it wrote.

A repository with no settings file of its own takes the baseline through the `defaults-file` fallback instead.

One adjacent setting to know about: `use_immutable_subject: true` opts the repository into a stable repository-ID-based subject (`repo:acme@OWNER-ID/payments@REPO-ID:...`). Repositories created after July 15, 2026 carry that format by default, organizations can opt in fleet-wide, and GitHub documents the flag only as an opt-in with no documented way back - so on a repository with immutable subjects, write the trust policy against the immutable shape rather than declaring `false` and expecting the name-based shape to return. Whichever subject model the repository actually has is the one the policy must match.
