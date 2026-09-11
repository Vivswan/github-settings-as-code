---
order: 180
---

# Architecture

How the action works, one diagram at a time. Every box that names a file in this repository lists the symbols it exports, and a test checks that each one exists. Under each concept diagram, a "Demonstrated by" line links the test or scenario that covers it.

The check is existence only: a caption-only box (`mode`, `merged-file`) names no file and is not checked, and a demonstration link is checked to resolve, not to test the claim above it.

The [module map](#the-module-map) at the end is generated from [architecture.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/architecture.yml). The `lint:arch` script keeps that declaration equal to the import graph, so the map cannot show an edge the code does not draw.

## The journey of one settings file

```mermaid
flowchart TD
  read["src/flows/settings-read.ts<br>readSettingsFile()"]
  mode{"mode"}
  fold["src/engine/layers.ts<br>stripNulls() mergeLayers()"]
  validate["src/engine/orchestrate.ts<br>validateSettingsDoc()"]
  merged["merged-file"]
  repo["src/engine/orchestrate.ts<br>runForRepo()"]
  sections["src/sections/registry.ts<br>SECTIONS"]
  plan["each section plans<br>src/sections/contract/plan.ts planContext() SectionPlan<br>src/engine/diff.ts deltas()"]
  api["src/github/api.ts<br>GithubClient"]
  drift["check: the plan's drift lines<br>src/sections/contract/plan.ts planDrift() planCheckNotes()"]
  exec["apply: the plan's writes<br>src/engine/execute.ts executePlan()"]
  report["src/flows/deliver.ts<br>concludeRun()"]
  read -->|YAML text, parsed to an unknown document per file| mode
  mode -->|merge: every layer, each validated on its own first| fold
  fold -->|one folded document, a notice per null opt-out| validate
  mode -->|check or apply: the one file| validate
  validate -->|ValidatedSettings, in merge mode| merged
  validate -->|ValidatedSettings, in check or apply| repo
  repo -->|the declared value of each active section| sections
  sections -->|one section at a time| plan
  plan -->|read-only calls for the live state| api
  api -->|live values, diffed into the plan's ops| plan
  plan -->|check: the plan| drift
  plan -->|apply: the plan| exec
  exec -->|REST and GraphQL writes| api
  drift -->|drift lines, exit 1 when any| report
  exec -->|one outcome per section| report
```

- A settings file is YAML text until the reader parses it, and an unknown document until validation brands it.
- `mode: merge` is the only path through the fold: every layer is validated on its own, folded, validated again, and written to `merged-file`.
- Check and apply take one file straight to validation, then through each active section module.
- Planning is where the reads happen: a section reads its live state through the client, diffs it against the declaration, and returns a plan of ops, each carrying its drift line.
- Check renders the plan's drift lines and never calls the API again. Apply executes the plan's writes, reading only what a write needs on the way (a public key before sealing a secret).
- The run ends with a summary, outputs, and an exit code.

Demonstrated by: [test/engine/orchestrate.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/orchestrate.test.ts), [test/e2e/scenarios/apply-idempotent-mixed.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/apply-idempotent-mixed.yml).

## The mental model: declare, diff, converge

```mermaid
flowchart LR
  declared["settings.yml<br>declared keys only"]
  live["the live repository<br>src/sections/contract/live.ts parseLive()"]
  knob["_undeclared: keep or delete<br>src/sections/contract/module.ts defaultUndeclaredPolicy()"]
  diff["src/engine/diff.ts<br>deltas()"]
  drift["check: drift lines, exit 1"]
  converge["apply: writes, then a check reads clean"]
  declared --> diff
  live --> diff
  knob --> diff
  diff --> drift
  diff --> converge
```

- You declare, the engine diffs the declaration against the live repository, and apply converges the two.
- A key you do not declare is never compared or touched.
- The one knob on the live axis is `_undeclared`: what happens to a live resource the file does not declare, per list section.
- Re-running an apply rewrites nothing the engine can read back, and a check right after it reads clean. Two writes recur by design because their values cannot be read back: `interaction_limits` re-arms its expiry on every apply, and every declared secret is re-sealed and rewritten on every apply.

Demonstrated by: [test/e2e/scenarios/apply-idempotent-unconditional.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/apply-idempotent-unconditional.yml), [src/sections/actions_variables/scenarios/actions-variables-undeclared-keep.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/src/sections/actions_variables/scenarios/actions-variables-undeclared-keep.yml), [src/sections/actions_secrets/scenarios/actions-secrets-undeclared-delete.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/src/sections/actions_secrets/scenarios/actions-secrets-undeclared-delete.yml).

## The mode ladder

```mermaid
flowchart LR
  merge["mode: merge<br>src/engine/layers.ts mergeLayers()"]
  check["mode: check<br>src/engine/orchestrate.ts runForRepo()"]
  apply["mode: apply<br>src/engine/execute.ts executePlan()"]
  merge -->|writes merged-file, no token, no API call| check
  check -->|the same document, plans and diffs only, exit 1 on drift| apply
```

Each rung is safe to run before the next, and moving a file up the ladder changes nothing about the file.

- Merge touches only local files.
- Check plans and diffs every active section; nothing executes.
- Apply executes the plan. Under the default `on-missing-permission: fail`, a read-only preflight over the active sections runs first and refuses to write anything when one is denied.

Demonstrated by: [test/engine/check-purity.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/check-purity.test.ts), [test/engine/layers.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/layers.test.ts).

## The layering fold as a stack

```mermaid
flowchart BT
  fleet["fleet.yml, the lowest layer"]
  team["team.yml"]
  repo["repo.yml, the highest layer"]
  out["the merged document<br>src/engine/layers.ts mergeLayers()"]
  fleet -->|mappings merge, lists replace, null deletes| team
  team -->|labels and rulesets union by key| repo
  repo -->|_undeclared resolved, _layering consumed| out
```

The stack folds bottom up, one layer per step:

- The higher layer's mappings merge key by key; its scalars and lists replace.
- Its `null` deletes what a lower layer declared.
- The list sections with a layering key (`labels`, `rulesets`) union their entries by key instead of replacing.

The [layering guide](../operate/layering.md) has the full rule table and a worked example.

Demonstrated by: [test/e2e/scenarios/merge-union-optout.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/merge-union-optout.yml), [test/engine/layers.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/layers.test.ts).

## Trust and provenance

```mermaid
flowchart LR
  operator["operator-authored documents<br>settings-file layers, repos-dir files, the defaults-file"]
  target["target-authored documents<br>a repository's own settings file, fetched via repos"]
  refs["src/engine/secret-refs.ts<br>validateSecretRef()"]
  resolve["src/engine/secret-refs.ts<br>resolveSecretRefs()"]
  refused["hard error for that section"]
  operator -->|SettingsSource operator| refs
  target -->|SettingsSource target| refs
  refs -->|operator: $NAME resolves from the step env| resolve
  refs -->|target: a $NAME reference is refused| refused
```

Two kinds of document reach the engine:

- Operator-authored: the settings-file layers, the `repos-dir` files, and the `defaults-file`. They live in the repository that runs the workflow.
- Target-authored: a repository's own `.github/settings.yml`, fetched from the target itself.

A `$NAME` secret reference resolves from the workflow step's environment, so it is honored only in operator documents. A target repository must never be able to route the operator's secrets into itself. Provenance is a property of the source document, decided once where the document is chosen, and every value in it shares that one source.

Demonstrated by: [test/engine/secret-refs.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/secret-refs.test.ts), [test/engine/secrets.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/secrets.test.ts), [test/e2e/scenarios/multi-secrets-target-ref-rejected.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/multi-secrets-target-ref-rejected.yml).

## The section-module contract

```mermaid
flowchart LR
  module["src/sections/contract/module.ts<br>SectionModule"]
  permission["permission"]
  endpoints["ENDPOINTS"]
  undeclared["undeclaredDefault"]
  layering["layering"]
  grant["the PAT grant prose<br>src/sections/contract/permissions.ts grantFor()"]
  gate["the mock's permission gate<br>test/e2e/mock/handlers.ts"]
  oracle["the fuzz oracle<br>test/e2e/oracle.ts"]
  routes["the mock routes<br>test/e2e/mock/routes.ts"]
  paths["test/e2e/openapi/paths.ts<br>USED_PATHS"]
  calls["the request helpers<br>src/sections/contract/requests.ts call() listAll()"]
  column["the Sections table column<br>.github/scripts/gen-docs.ts"]
  policy["src/sections/contract/module.ts<br>defaultUndeclaredPolicy()"]
  fold["src/engine/layers.ts<br>mergeLayers()"]
  module --> permission
  module --> endpoints
  module --> undeclared
  module --> layering
  permission --> grant
  permission --> gate
  permission --> oracle
  endpoints --> routes
  endpoints --> paths
  endpoints --> calls
  undeclared --> column
  undeclared --> policy
  layering --> fold
```

One section declares each fact once and the rest of the system derives from it:

- `permission` drives the grant advice a denial prints, the mock's permission gate, and the fuzz oracle.
- `ENDPOINTS` drives the paths the handlers call, the mock's routes, and the OpenAPI path set.
- `undeclaredDefault` drives the Sections table column and the policy a plain list falls back to.
- `layering` tells the fold how the section's entries union across layers.

Change the declaration and every consumer follows.

Demonstrated by: [test/sections/registry.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/sections/registry.test.ts), [test/sections/contract.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/sections/contract.test.ts).

## The multi-repo flow

```mermaid
flowchart TD
  targets["src/discovery/central.ts resolveCentralTargets()<br>src/discovery/discover.ts discoverRepos()"]
  each["one target at a time<br>src/flows/multi.ts runMulti()"]
  own["applied from that file, as written"]
  fetch["src/github/repo-file.ts<br>getRepoFile()"]
  probe["the repository object names the default branch"]
  ref["the default-branch ref read, which needs Contents: read"]
  defaults{"defaults-file set?"}
  fallback["applied from the defaults document, with a notice"]
  skipped["skipped, with a notice"]
  failed["the target fails, naming Contents: read"]
  targets --> each
  each -->|a repos-dir file| own
  each -->|a repos target| fetch
  fetch -->|the contents read returns the file| own
  fetch -->|the contents read returns 404| probe
  probe --> ref
  ref -->|200: the token could read the file, so it is proven absent| defaults
  ref -->|404 or 403: unproven| failed
  defaults -->|yes| fallback
  defaults -->|no| skipped
```

Targets come from checked-in files under `repos-dir`, from the `repos` list, or from `repos: "*"` discovery. Targets run independently; one failure never stops the rest.

- A target with a settings file, central or remote, is applied from that file alone.
- The `defaults-file` is a fallback: applied whole to a `repos` target proven to have no settings file.
- A contents 404 alone proves nothing (a missing file, a missing grant, or an invisible repository all look the same). The proof is the default-branch ref read, a call that needs Contents: read and succeeds whether or not the file exists: 200 means the token could have read the file, so the file is absent.
- A ref read that is denied leaves the proof inconclusive, and the target fails naming the grant. A denial must never look like a missing file.

Demonstrated by: [test/flows/multi.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/flows/multi.test.ts), [test/e2e/scenarios/multi-missing-and-failing.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/multi-missing-and-failing.yml), [test/e2e/scenarios/multi-contents-denied.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/multi-contents-denied.yml).

## The module map

Each node is one layer of `src/`, labelled with the paths it owns; an arrow means the layer imports the other. The map is rendered from `architecture.yml` by `bun run build:docs`, and `bun run lint:arch` fails when the import graph and the declaration disagree in either direction.

<!-- BEGIN GENERATED: architecture-map (bun run build:docs; derived from architecture.yml) -->
```mermaid
graph TD
  main["src/main.ts"]
  action["src/action/"]
  library["src/index.ts"]
  flows["src/flows/"]
  engine["src/engine/"]
  sections["src/sections/"]
  github["src/github/"]
  discovery["src/discovery/"]
  report["src/report/"]
  schema["src/schema.ts"]
  io["src/io.ts"]
  types["src/types.ts"]
  plain_data["src/plain-data.ts"]
  private["src/private.ts<br>src/private-open.ts"]
  upstream_gaps["src/upstream-gaps/"]
  main --> action
  action --> library
  library --> discovery
  library --> engine
  library --> flows
  library --> github
  library --> io
  library --> report
  library --> schema
  library --> sections
  library --> types
  flows --> discovery
  flows --> engine
  flows --> github
  flows --> io
  flows --> private
  flows --> report
  flows --> schema
  engine --> discovery
  engine --> github
  engine --> io
  engine --> plain_data
  engine --> schema
  engine --> sections
  engine --> types
  sections --> discovery
  sections --> engine
  sections --> github
  sections --> schema
  sections --> types
  sections --> upstream_gaps
  github --> io
  github --> plain_data
  discovery --> github
  discovery --> private
  report --> discovery
  report --> engine
  report --> github
  report --> io
  report --> private
  report --> schema
  report --> sections
  report --> types
  schema --> sections
  schema --> types
  upstream_gaps --> types
```
<!-- END GENERATED: architecture-map -->

The e2e harness fragments beside each section (`mock.ts`, `generators.ts`) are test code and sit outside the map.
