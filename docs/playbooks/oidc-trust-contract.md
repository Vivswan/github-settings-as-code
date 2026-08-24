# A cloud OIDC trust contract

Cloud providers trust GitHub Actions through OIDC: a deploy role's trust policy matches conditions against the workflow token's subject claim. The default subject format varies by trigger (an environment-scoped job, a branch push, and a pull request each produce a different shape), so trust policies written against it tend to end up looser than intended. Pinning the claim keys turns the subject shape into a reviewable contract:

```yaml settings
actions:
  oidc_customization_sub:
    use_default: false
    # Per-repo template: this repository's OIDC jobs flow through a
    # reusable deploy workflow. For a fleet-wide defaults file, stop at
    # [repo, context] - see the fleet note below.
    include_claim_keys: [repo, context, job_workflow_ref]
```

With that template every subject carries the same claim-key sequence, `repo:ORG/REPO:<context>:job_workflow_ref:PATH`. The `context` segment's value still varies with the trigger, exactly as the default subject's tail does: an environment-scoped job yields `environment:ENV`, a branch push `ref:refs/heads/BRANCH`, a pull request `pull_request`. For an environment-scoped deploy job the subject reads:

```text
repo:acme/payments:environment:production:job_workflow_ref:acme/platform/.github/workflows/deploy.yml@refs/heads/main
```

and a trust policy that requires that exact string admits only production-environment deploys flowing through that one reusable deploy workflow. A minimal `[repo, context]` template reproduces the default subject shape exactly; that is still worth pinning as a drift guard against upstream format changes, but the hardening comes from the extra keys.

Three details carry the pattern. Claim-key order defines the subject format, so the list is compared positionally and a reordered live value is drift. The OIDC endpoints need the `Actions` PAT permission rather than the Administration grant the rest of the section uses (the [Sections table](../../README.md#sections) notes it). And the fleet story is two-tier: `[repo, context]` is what belongs in a fleet-wide defaults file, turning every repository's subject shape into one reviewed line, while `job_workflow_ref` belongs only on repositories whose OIDC jobs flow through reusable workflows - GitHub documents that claim for reusable-workflow jobs, and a claim key the job cannot supply becomes a requirement the moment it is included (the docs say exactly that for `environment`, which turns mandatory once listed). One adjacent setting to know about: `use_immutable_subject: true` opts the repository into a stable repository-ID-based subject (`repo:acme@OWNER-ID/payments@REPO-ID:...`). Repositories created after July 15, 2026 carry that format by default, organizations can opt in fleet-wide, and GitHub documents the flag only as an opt-in with no documented way back - so on a repository with immutable subjects, write the trust policy against the immutable shape rather than declaring `false` and expecting the name-based shape to return. Whichever subject model the repository actually has is the one the policy must match.
