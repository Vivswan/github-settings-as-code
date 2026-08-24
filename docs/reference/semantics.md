# Semantics

The rules every section obeys, whatever it manages: what the engine compares, what it deletes, which errors can be softened, and what happens around a failure. The [Sections table](../../README.md#sections) says what each section does; this page is the model those behaviors share. Read it when you need to predict what an apply or a check will do before running it.

The engine is stateless and declared-keys-only: a key you do not declare is never touched or compared. There is no state file; resources are matched by their natural names. Removing a section from the file stops managing it - it does not revert anything.

Apply is convergent: re-running preserves the declared state (some sections diff first and skip converged writes, others send idempotent full-payload writes), and a check right after an apply reports clean.

## What happens to undeclared resources

Three sections illustrate the range of default policies:

- Labels: declared labels are upserted (rename via `new_name`); undeclared labels are DELETED by default (Probot parity), loudly. The [`undeclared` policy](undeclared-policy.md) can soften this to keep.
- Rulesets: upserted by name with the full payload; undeclared rulesets are never deleted by default, since removing protection stays a human action. The [`undeclared` policy](undeclared-policy.md) can opt into deletion.
- Milestones: upserted by title; undeclared ones are kept by default (deleting a milestone detaches it from every issue carrying it) and listed as notices. The [`undeclared` policy](undeclared-policy.md) can opt into deletion.

Every section's own default is stated in the README Sections table's Undeclared default column, and the [undeclared policy](undeclared-policy.md) page covers the knob that overrides it.

## Errors and retries

Permission failures (403, or 404 on admin endpoints with a fine-grained token) are the only softenable errors; everything else always fails with the API message verbatim. The [permissions page](permissions.md) covers the `on-missing-permission` and `required-sections` inputs that do the softening.

Rate limits (429 and secondary limits) and transient 5xx or network failures are retried automatically with backoff, honoring Retry-After and the rate-limit reset, up to two retries; a reset more than 60 seconds away fails loudly instead of stalling the workflow. Permission errors are never retried.

## The preflight barrier

Under `on-missing-permission: fail`, every declared section is probed read-only before ANY write; if a section is inaccessible, nothing is applied at all (per repository in multi-repo mode; earlier targets in the same run are already done). The API has no transactions; a read-but-not-write token can still fail mid-apply, and a section whose reads need no grant at all (`custom_properties` - its values read is Metadata-gated) surfaces a missing write grant only at its first write. Re-running after fixing it converges because applies are idempotent.

See [COVERAGE.md](../../COVERAGE.md) for the full inventory: everything supported, every repo-scoped gap, and the user-scoped surface that is out of scope by design.
