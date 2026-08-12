# Private repositories

When a run manages repositories more private than its own logs, the
details it prints become a leak. This page covers the `private-repos`
redaction that closes that leak, what a redacted run still shows, and the
`private-report` channels that deliver the full detail privately. It
matters to anyone whose admin repository is public (or merely less
restricted) while some of its multi-repo targets are private or internal.

GitHub Actions has no log-level access control. Run logs, step summaries,
and uploaded artifacts inherit the repository's visibility, so a public
admin repo managing a private target would print that target's slug, its
live settings, and its API error bodies where anyone can read them. The
only GitHub-ACL-private channel a public run has is another repository the
token can reach.

To stop the leak, `private-repos: redact` (the default) hides every
private or internal target from the public view. The target's slug becomes
a `private repository #N` placeholder, its live values and error bodies
become `hidden (private repository)`, and each slug is registered with the
runner's secret masker so it cannot resurface in a stray log line. The
visibility check fails closed: a repository the probe cannot prove public
is redacted anyway. A target equal to `GITHUB_REPOSITORY` is never
redacted, because a repository acting on itself discloses nothing new. Set
`private-repos: show` only when the run's own logs are already private.

The decision comes down to the policy and what the visibility probe finds:

| Condition | Redacted? |
|---|---|
| `private-repos: show` | no, everything is revealed |
| target is `GITHUB_REPOSITORY` (self) | no, the carve-out applies |
| probe proves the target public | no |
| probe proves the target private or internal | yes |
| probe cannot determine visibility | yes, redaction fails closed |

## What a redacted run still shows

Redaction hides values, not the shape of the outcome. The public surfaces
still carry the safe skeleton of each target. The step summary shows, per
target, the overall result (`applied`, `partial`, `clean`, `drift`,
`failed`, `skipped`), each section's key and status, and the HTTP status
code on a failed or skipped section; the `repos-result` output carries
`{result, source, skippedSections}` per target, keyed by the placeholder.
These are closed enumerations and numeric codes, safe to show, and enough
to tell whether the fleet is healthy and which section broke. What they
never carry is the slug, a live setting, a desired setting, or an API
error message.

## Seeing the full detail

Three ways to read the unredacted detail, in rough order of convenience.

The first is to run from a context whose logs are already private. Move
the workflow into the target repository itself (the self carve-out gives
full logs safely), or keep the admin repo private and set
`private-repos: show`.

The second is to reproduce locally. The action is a plain Node bundle -
build it first with `bun install && bun run build:bundle` (it is not
committed) - so the same PAT and the same inputs reproduce the run on your
machine, where the logs stay local. Put the PAT in a `YOUR_PAT` variable; a
shell variable name cannot contain a hyphen, so
pass the hyphenated inputs through `env`:

```bash
bun install && bun run build:bundle
env "INPUT_TOKEN=$YOUR_PAT" 'INPUT_REPOSITORY=owner/name' 'INPUT_PRIVATE-REPOS=show' \
  node lib/index.js
```

Every input maps to an `INPUT_<NAME>` variable, uppercased with dashes
kept (so `private-repos` is `INPUT_PRIVATE-REPOS`).

The third is to have the run deliver a private report, described next.

## Delivering a private report

`private-report` sends the full unredacted report for each redacted target
through a channel whose access control is not the public run. It defaults
to `private-report: none`, which delivers nothing. Any other channel
applies only to redacted targets, and only to those the visibility probe
proves private or internal: an unknown visibility is redacted from the
public view but excluded from delivery, so the report never reaches a
repository that might be public. It is rejected alongside
`private-repos: show`. The report mirrors the run's log, delivery stays
live in `mode: check`, and a delivery failure only warns; it never
changes the target's or the run's result.

`private-report: issue` posts each target's report to a reused issue on
that target repository, where the repository's own access control protects
it. The action finds the issue by a marker label, replaces the body every
run, and opens the issue when the target fails or drifts and closes it
when the target is healthy. This needs the PAT to hold
`"Issues"` (read and write) on every target repository, on top of the
section permissions.
Prefer this channel unless your readers lack GitHub access to the targets.

`private-report: issue-on-failure` is the quiet variant of `issue`. When
a target fails (or drifts in check mode) it behaves identically: the
reused, marker-labelled report issue is written and opened. On a healthy
run it only looks up an open report issue; one left over from an earlier
failure is updated with the healthy report and closed, and when there is
none, nothing is written - no issue, no label, zero notification noise.
A repository that never fails never sees an issue, at the cost that
healthy runs' reports are not delivered anywhere; choose `issue` or
`artifact` when you need the report mirror on every run.

Two caveats on the quiet variant. If the settings declare a `labels`
section, the `settings-as-code-report` marker label is still injected
into it, so the apply creates the label even on healthy repositories (a
label, not a notification). And if someone removes the marker label
while a report issue is open, the healthy path cannot find the issue, so
it stays open until the next failing run recreates the label and
reclaims it. Everything else matches `issue`: the same delivery gate,
the same Issues grant (the healthy lookup is a read; the open and close
are writes), and delivery still runs in `mode: check`.

`private-report: artifact` concatenates the report for every proven-private
target into one document, encrypts it to an age recipient, and uploads it
as the workflow artifact `settings-as-code-private-report` (file
`private-report.md.age`). Use it when the people who need the report
cannot be given repository access, since the archive travels with the run
rather than living in the target repo. This channel needs the Actions
artifact service, so it does not work on GitHub Enterprise Server (the
`@actions/artifact` client has no GHES backend): there the run warns and
uploads nothing.

Access control on the artifact channel is key possession, so the key setup
matters. Generate a keypair on your own machine; the private key must
never touch GitHub:

```bash
age-keygen -o key.txt
```

`key.txt` holds the secret identity; keep it off GitHub. The command also
prints the public recipient (`age1...`), which is safe to commit. Pass
that recipient as `report-public-key`. It is required when
`private-report` is `artifact` and rejected otherwise; a malformed
recipient fails the run at startup.

To read a report, download and decrypt. The browser "Download" button
gives a ZIP; unzip it, then decrypt with the identity file (or use
`gh run download`, which extracts the artifact for you):

```bash
gh run download <run-id> -n settings-as-code-private-report
age -d -i key.txt private-report.md.age
```

One caveat weighs against this channel: the ciphertext is downloadable by
anyone during the artifact's retention window, and copies persist after
that. If the age key is ever compromised, every archived run it encrypted
becomes readable retroactively. The `issue` channel has no such standing
exposure.

## What redaction does and does not protect

Redaction protects the target's live state and its errors. It does not
retroactively hide a name you already published. In a public admin repo,
the names in the `repos` input and the paths and contents of `repos-dir`
files are already public, so redaction there is limited:

| Target source | What is public regardless | What redaction protects |
|---|---|---|
| `repos` explicit list | the target name | live state, desired state, errors |
| `repos-dir` central file | the target name and the desired settings in the committed file | live state, errors |
| `repos: "*"` discovery | nothing | the name, live state, desired state, and errors |

Only `repos: "*"` discovery gives a target true non-disclosure, because
its name never appears in a committed file or input. For the other two
sources, the name is self-disclosed the moment you commit the workflow.

The visibility probe drives two decisions that fail closed in opposite
directions. Redaction fails closed toward hiding: a target the probe
cannot prove public is redacted. Delivery fails closed toward silence: a
report is sent only when the probe proves the target private or internal,
so an unknown visibility redacts the public view yet withholds the private
report rather than risk posting it to a repository that might be public.

A closing point on escape hatches: on a public repository, an unencrypted
artifact or a debug log is not a private channel. Both inherit the run's
public visibility. That is the whole reason the artifact channel encrypts,
and the reason redaction cannot be waved away with `ACTIONS_STEP_DEBUG`.

None of this requires a dedicated account. If you already run the fleet
under a machine user, it happens to fit well here: you can scope its PAT
to least privilege, point `repos: "*"` discovery at only what it owns, and
get bot-named authorship on the report issues. That is a convenience, not
a prerequisite; a personal PAT with the right permissions works the same
way.
