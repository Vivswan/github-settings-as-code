# Troubleshooting

Errors from this action are written to carry their own fix: the failing
request, the API's message verbatim, and what to change. The step summary
table shows the outcome per section, so start there. This page covers the
symptoms where the message alone benefits from context: denials that are not
what they look like, limits, validation errors, and runs that do not match
the code you think they are running.

## A section fails with "the token was denied ..."

What you see: an error annotation naming the section, the denied request with
its HTTP status, and advice starting "To fix, grant" that names the exact
fine-grained PAT permission the section needs.

What it means: the token lacks that section's grant. Each section's
permission is listed in the [Sections table](../../README.md#sections). The
default `GITHUB_TOKEN` cannot hold most of them (Administration in
particular), so a missing or under-scoped PAT is the usual cause.

What to do: edit the PAT's permissions as the message says (see
[Token permissions](../reference/permissions.md)). If you would rather
skip sections the token cannot reach, set `on-missing-permission: warn`:
denied sections are skipped with a warning instead of failing the run, and
when nothing else drifts or fails the result is `partial` and the run stays
green. The `required-sections` input names sections that must still fully
apply even under `warn`.

One related surprise: under the default `on-missing-permission: fail`, an
apply run probes every declared section read-only before writing anything.
If any probe is denied you get error annotations prefixed `preflight:` and
nothing at all is applied, by design; the API has no transactions, so the
barrier prevents a half-applied repository. See
[Semantics](../reference/semantics.md).

## A 404 for something that exists

Fine-grained tokens surface a missing Administration permission as a 404,
not a 403, on admin endpoints; GitHub hides the resource rather than admit
it exists. The action treats both statuses as permission errors, and a
404 denial appends "(a 404 here can also mean the resource does not
exist)". Check the grant first. If the grant is right, check the resource:
the repository slug, a branch name, a workflow file path. On the
`secret_scanning_custom_patterns` endpoints a 404 has a third reading,
which the denial message carries: secret scanning is not enabled for the
repository (it requires GitHub Advanced Security on private repositories).
Enabling scanning and declaring patterns cannot land in ONE apply under the
default `on-missing-permission: fail`: the preflight barrier probes every
declared section read-only before anything is written, so the patterns
list 404s and aborts the run before the `repository` section could enable
scanning via `security_and_analysis`. Either enable scanning first (a
separate run, or by hand in the repository's security settings), or set
`on-missing-permission: warn` for the bootstrap run - the first apply then
enables scanning and skips the patterns section with a warning, and the
next apply converges.

## A 412 on secret scanning custom patterns

What you see: a `secret_scanning_custom_patterns` write fails with a 412
and the advice "the pattern changed on GitHub between this run's read and
its write (stale custom_pattern_version); re-run the workflow".

What it means: the pattern updates and deletes carry the version each
pattern had when this run listed them, so a pattern someone edited on
GitHub mid-run is not silently overwritten - GitHub rejects the stale
write instead. Nothing is broken and nothing was clobbered.

What to do: re-run the workflow. The fresh run reads the current versions
and converges; if the 412 repeats, someone (or something) is editing the
patterns concurrently on every run, and that editor is the thing to find.

## A 403 that is not about a grant

Two other things arrive as 403. First, rate limiting: both the primary
limit and secondary (abuse) limits can be delivered as 403. The action
recognizes these by the API's own message and reports them as rate limits,
never as missing permissions. Second, feature policies: on a few endpoints
a 403 means something other than the token. An org- or enterprise-managed
policy can lock the Actions cache limits, code scanning default setup needs
Advanced Security on private repositories, and Git LFS can be disabled
account-wide. For Git LFS the denial message itself carries a note saying
so; for the others the caveat lives in that section's row of the
[COVERAGE.md Supported table](../../COVERAGE.md#supported).

## Rate limited

What you see: a failure ending "The API rate limit was hit; re-run the
workflow after the limit resets, or use a token with a higher rate limit".

What it means: the retries already happened, or were deliberately skipped
because the wait was too long. Rate limits (429 and secondary
limits) are retried automatically, honoring Retry-After and the rate-limit
reset; transient 5xx and network failures are retried on their own backoff.
Both paths allow up to two retries, and a reset more than 60 seconds away
fails loudly instead of stalling the workflow (see
[Semantics](../reference/semantics.md)). By the time this
error surfaces, the run has waited as long as it reasonably could.

What to do: re-run after the reset. If a multi-repo run keeps hitting the
limit, reduce its scope: fewer targets per run, or a `sections` allowlist so
each target makes fewer calls.

## "unknown top-level section(s) in ..."

What you see: the run fails during validation, naming the unknown keys and
listing every known section name.

What it means: a misspelled section that silently did nothing would break
the loud-failure promise, so unknown top-level keys are hard errors (see
[Forward compatibility](../reference/forward-compatibility.md)).

What to do: the message names all three options. Fix the typo. Or, for a
deliberate private key, prefix it with an underscore, which the validator
skips:

```yaml settings
_owner_notes: contact the platform team before editing this file
labels:
  - name: bug
    color: d73a4a
```

Or, when the file is written for a newer action version than the one running
(version skew during an upgrade), set the `sections` input: unknown keys
outside the allowlist downgrade to warnings instead of failing the run.

## The run fails with a 401

The message says "The token was rejected as invalid or expired". This is not
a permissions problem: the PAT itself expired or was revoked, or the secret
the `token` input reads holds a stale value. Mint or rotate the token and
update the secret.

## Check mode "fails" with nothing broken

`mode: check` exits 1 on any drift by design, so a red scheduled check run
means the file and the repository disagree, not that something errored. The
drift lines in the log list each difference. See the
[check mode guide](check-mode.md).

## Turning on debug logging

Every API call the action makes is traced as a debug line: method, path,
request payload, response status, and timing. Debug lines are hidden in
normal runs; re-run the workflow with "[Enable debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging)"
checked, or set the `ACTIONS_STEP_DEBUG` secret to `true`. The trace never
prints the token: the
authorization header is not part of the trace line, and a token stored as a
repository secret is masked by the runner wherever it appears in output. For
redacted private targets in multi-repo mode, the traced path collapses to
`<redacted>` and the payload is dropped entirely. Failures do not need debug
mode; every error already carries the API's message and the fix, so reach
for the trace when you need to see the requests that succeeded.

## Behavior does not match src/ (missing or stale bundle)

When you run the action from a ref (`uses: your-fork/github-settings-as-code@your-branch`),
what executes is `lib/index.js`, the bundle, not the TypeScript under
`src/`. The release tags (`vX.Y.Z`) and the moving major tag carry a
freshly built bundle; branches do not - the bundle
is not committed on main. So on a fork or working branch, build
it yourself: run `bun run build:bundle` and commit the result on your
branch (and `bun run build:schema` if you changed the settings types). A
ref without the bundle fails to start; a branch where you rebuilt `src/`
without rebuilding behaves like the old code and no error tells you so.
The rebuild is on you.
