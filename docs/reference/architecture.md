---
order: 180
---

# Architecture

How the action works, one diagram at a time. Every box that names a file in this repository lists the symbols it exports, and a test checks that each one exists. Under each concept diagram, a "Demonstrated by" line links the test or scenario that covers it.

The check is existence only: a caption-only box (`mode`, `rendered-file`) names no file and is not checked, and a demonstration link is checked to resolve, not to test the claim above it.

The [module map](#the-module-map) at the end is generated from [architecture.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/architecture.yml). The `lint:arch` script keeps that declaration equal to the import graph, so the map cannot show an edge the code does not draw.

The same lint enforces the never-throw rule: a function that can fail returns a neverthrow `Result` carrying a typed `Problem`, so an error is a value the caller handles. A section's `plan()`, `snapshot()`, and operation hooks carry a `SectionFailure` instead, which the engine loops match on by kind.

A `throw` is allowed as a `BUG:` invariant, as a bare rethrow inside its own `catch`, or where a third party's contract demands it, in a file the `throws` block of `architecture.yml` names with its reason.

That block counts the remaining throws per file. The lint fails when the count and the tree disagree in either direction, so a converted throw lowers its file's count and the entry leaves the list once no throw remains; that a count only goes down is the review rule in AGENTS.md.

## The journey of one settings file

```mermaid
flowchart TD
  read["src/flows/settings-read.ts<br>readSettingsFile()"]
  mode{"mode"}
  fold["src/engine/layers.ts<br>standaloneView() mergeLayers()"]
  validate["src/engine/orchestrate.ts<br>validateSettingsDoc()"]
  rendered["rendered-file"]
  repo["src/engine/orchestrate.ts<br>runForRepo()"]
  sections["src/sections/registry.ts<br>SECTIONS"]
  plan["each section plans<br>src/sections/contract/plan.ts planContext() SectionPlan<br>src/engine/diff.ts deltas()"]
  api["src/github/api.ts<br>GitHubClient"]
  drift["check: the plan's drift lines<br>src/sections/contract/plan.ts planDrift() planCheckNotes()"]
  exec["apply: the plan's writes<br>src/engine/execute.ts executePlan()"]
  report["src/flows/deliver.ts<br>concludeRun()"]
  read -->|YAML text, parsed to an unknown document per file| mode
  mode -->|render: every layer, each validated on its own first| fold
  fold -->|one folded document, its directives consumed, a notice per removal| validate
  mode -->|check or apply: the one file| validate
  validate -->|the fold, proven valid, in canonical order| rendered
  validate -->|ValidatedSettings, in check or apply| repo
  repo -->|the validated value of each active section| sections
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
- `mode: render` is the only path through the fold: every layer is validated on its own, folded, validated again, and written to `rendered-file`.
- Check and apply take one file straight to validation, then through each active section module. Every check that reads only the file runs there, before the first request to that repository's sections ([the validation phase](#the-validation-phase)).
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
- A key you do not declare is never compared or touched, except under the three replacing writes ([Semantics](semantics.md) names them).
- The one live-axis knob is `_undeclared`: what happens to a live resource the file does not declare. A knobbed list section's wrapper sets it; a file's top-level `_undeclared` sets it for every knobbed list section of that file, and the run input `undeclared` for every file; the section's default applies where none is set. `environments`, `branches`, and `workflows` apply no policy and refuse the knob ([Undeclared policy](undeclared-policy.md)).
- Re-running an apply rewrites nothing the engine can read back, and a check right after it reads clean. Writes whose value GitHub does not read back recur by design: `interaction_limits` re-arms its expiry, every declared secret is re-sealed, and the Git LFS toggle and `check_suite_preferences` are re-sent on every apply.

Demonstrated by: [test/e2e/scenarios/apply-idempotent-unconditional.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/apply-idempotent-unconditional.yml), [src/sections/actions_variables/scenarios/actions-variables-undeclared-keep-note.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/src/sections/actions_variables/scenarios/actions-variables-undeclared-keep-note.yml), [src/sections/actions_secrets/scenarios/actions-secrets-undeclared-delete.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/src/sections/actions_secrets/scenarios/actions-secrets-undeclared-delete.yml).

## The mode ladder

```mermaid
flowchart LR
  render["mode: render<br>src/flows/render.ts runRender()"]
  check["mode: check<br>src/engine/orchestrate.ts runForRepo()"]
  apply["mode: apply<br>src/engine/execute.ts executePlan()"]
  render -->|writes rendered-file, no token, no API call| check
  check -->|the same document, plans and diffs only, exit 1 on drift| apply
```

Each rung is safe to run before the next, and moving a file up the ladder changes nothing about the file.

- Render touches only local files.
- Check plans and diffs every active section; nothing executes.
- Apply executes the plan. Under the default `on-missing-permission: fail`, a read-only preflight over the active sections runs first and refuses to write anything when one is denied.

Demonstrated by: [test/engine/check-purity.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/check-purity.test.ts), [test/flows/render.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/flows/render.test.ts).

## The validation phase

```mermaid
flowchart TD
  doc["one unknown document<br>src/flows/settings-read.ts readSettingsFile()"]
  top["the top level<br>src/engine/orchestrate.ts validateSettingsDoc()"]
  shapes["every section, in turn<br>src/engine/validate.ts validateSectionShapes()"]
  hook["the section's validate hook<br>src/sections/contract/module.ts SectionModule"]
  issues["one collected list of issues, exit 1, zero section requests"]
  minted["src/engine/orchestrate.ts<br>ValidatedSettings"]
  plan["src/sections/contract/plan.ts<br>planContext() SectionPlan"]
  doc --> top
  top -->|a plain mapping of known sections and directives| shapes
  shapes -->|the zod shape's output| hook
  hook -->|issues with paths under the section key| shapes
  top -->|an unknown directive, an unknown section the sections input did not exclude| issues
  shapes -->|a shape issue, a hook issue, a non-plain value| issues
  shapes -->|every check passed| minted
  minted -->|the only input a planner accepts| plan
```

One rule decides what belongs here: what the settings file alone shows wrong is refused when the file is parsed, naming the key and the fix, never discovered at apply time. A GET-only field, a value outside its enum, a contradictory key pair, two entries naming one label, a secret name GitHub would reject: each is an issue of this phase.

The phase runs in check and apply before the first request to that repository's sections, and in render mode on every layer and on the fold. A layer of the fold is judged as its standalone view, the document minus the directives the fold consumes (`_layering`, the file-wide `_undeclared`, and the `_remove` entries); the fold itself is judged whole.

 In a multi-repo run the `defaults-file` document is validated before target resolution, so an invalid default stops the run before any write; a target's file is validated once fetched, so an earlier target's writes precede a later target's refusal. Three kinds of check take part:

- The zod shape of each section, with its cross-field rules. A rule still runs beside a sibling that failed, so one run reports the bad enum and the contradictory pair together.
- The section's `validate` hook, required on every list section: duplicates by the section's key, a rename that collides, a nested list's own duplicates. Its issues carry paths under the section key, like the shape's.
- Two document-wide walks: a value that is not plain YAML data (a tagged mapping, a list with a hole) and a passthrough number that is not finite.

Every issue the phase finds lands in one list: unknown directives, unknown sections, a single document's `_remove` markers, then each section's issues in apply order. Zero section requests reach that repository, and the run exits 1; in a multi-repo run only that target fails. One downgrade: an unknown section outside a non-empty `sections` allowlist is a warning, so an older action can run a file written for a newer one.

Two limits. A shape's own issues are capped at five per section, with a count of the rest; and a section's hook runs once its shape parsed, so a shape error in an entry can hide a duplicate until it is fixed.

The success path mints the input a planner accepts: a section's `plan()` takes the section's value carrying a type-level brand that names the section it was validated as. A hand-built entry list does not compile. A nullable section's `null` carries no brand: it holds nothing a file-only check could judge.

Secret references are the exception. The `$NAME` syntax is judged per section when the run starts, because the verdict needs the document's provenance ([Trust and provenance](#trust-and-provenance)).

Demonstrated by: [test/engine/validate.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/validate.test.ts), [test/engine/orchestrate.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/orchestrate.test.ts), [src/sections/interaction_limits/scenarios/interaction-limits-invalid-values-and-unknown-key-rejected.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/src/sections/interaction_limits/scenarios/interaction-limits-invalid-values-and-unknown-key-rejected.yml).

## The layering fold

```mermaid
flowchart TD
  layers["settings-file, the layers lowest first<br>src/flows/layers.ts readLayerFiles() foldLayers()"]
  each["each layer validated alone, as its standalone view<br>src/engine/layers.ts standaloneView()<br>src/engine/orchestrate.ts validateSettingsDoc()"]
  fold["the fold, low to high<br>src/engine/layers.ts mergeLayers()"]
  directive{"a list section's directive"}
  replace["replace<br>the higher list wins whole"]
  shallow["shallow<br>union by key, a same-key entry swapped whole"]
  deep["deep, the default<br>union by key, a same-key pair merged field by field"]
  consumed["directives consumed, the plain-list wrapper unwrapped, _undeclared resolved"]
  whole["the fold validated once more<br>src/engine/orchestrate.ts validateSettingsDoc()"]
  out["rendered-file, in canonical order<br>src/engine/canonical.ts renderCanonicalYaml()"]
  layers --> each
  each -->|mappings merge key by key, every other value wins whole, null included| fold
  fold -->|the wrapper's _layering, else the file's, else the run input layering| directive
  directive --> replace
  directive --> shallow
  directive --> deep
  replace --> consumed
  shallow --> consumed
  deep --> consumed
  consumed --> whole
  whole --> out
```

The fold is a cascade: the higher layer's value wins at every depth, and `null` is a value. Every list section is keyed by what its planner matches entries by, so a fleet `Bug` and a repository `bug` are one label. Three directives say how a keyed list meets the list below it; here the highest layer, in a run with `layering: replace`:

```yaml layer
_layering: shallow          # every list section of this file, unless it says otherwise
labels:
  _layering: deep           # this section only
  entries:
    - name: bug
      color: d73a4a         # merged field by field into the fleet's bug
    - name: wontfix
      _remove: true         # drops the fleet's wontfix; the marker never reaches the file
rulesets:
  - name: main              # swaps the fleet's main whole, under the file's shallow
    enforcement: active
```

- Under `deep` a same-key pair's nested keyed lists union too: a ruleset's `rules` by type, an environment's `variables` by name.
- The sixteen sections with an `_undeclared` knob take `_layering` beside it. `environments`, `branches`, and `workflows` take it in a `{_layering, entries}` wrapper of their own, which the render unwraps to the bare list.
- `null` is the empty or off state on GitHub, written as such: `pages: null` turns Pages off, `protection: null` strips a branch's protection. A key with no empty state refuses `null` at validation, naming the values that exist.
- `_remove: true` on a keyed entry drops the lower entry under that key, with a notice, and is consumed. It is refused under `replace`, inside an entry copied whole, and where no lower layer declares the key. A single document in check or apply is nobody's higher layer, so validation refuses the marker there and names the fold.
- `_undeclared` travels through the fold and is resolved in the rendered file, so the apply step reads a policy on each of the sixteen sections that carry one.

The [layering guide](../operate/layering.md) has the full rule table and a worked example.

Demonstrated by: [test/engine/layers.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/engine/layers.test.ts), [test/flows/layers.test.ts](https://github.com/Vivswan/github-settings-as-code/blob/main/test/flows/layers.test.ts), [test/e2e/scenarios/render-null-wins.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/render-null-wins.yml), [test/e2e/scenarios/render-file-directive.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/render-file-directive.yml), [test/e2e/scenarios/render-replace-section.yml](https://github.com/Vivswan/github-settings-as-code/blob/main/test/e2e/scenarios/render-replace-section.yml).

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
  validate["validate"]
  grant["the PAT grant prose<br>src/sections/contract/permissions.ts grantFor()"]
  gate["the mock's permission gate<br>test/e2e/mock/handlers.ts"]
  oracle["the fuzz oracle<br>test/e2e/oracle.ts"]
  routes["the mock routes<br>test/e2e/mock/routes.ts"]
  paths["test/e2e/openapi/paths.ts<br>USED_PATHS"]
  calls["the request helpers<br>src/sections/contract/requests.ts call() listAll()"]
  column["the Sections table column<br>.github/scripts/gen-docs.ts"]
  policy["src/sections/contract/module.ts<br>defaultUndeclaredPolicy()"]
  fold["src/engine/layers.ts<br>mergeLayers()"]
  phase["the validation phase<br>src/engine/validate.ts validateSectionShapes()"]
  module --> permission
  module --> endpoints
  module --> undeclared
  module --> layering
  module --> validate
  permission --> grant
  permission --> gate
  permission --> oracle
  endpoints --> routes
  endpoints --> paths
  endpoints --> calls
  undeclared --> column
  undeclared --> policy
  layering --> fold
  validate --> phase
```

One section declares each fact once and the rest of the system derives from it:

- `permission` drives the grant advice a denial prints, the mock's permission gate, and the fuzz oracle.
- `ENDPOINTS` drives the paths the handlers call, the mock's routes, and the OpenAPI path set.
- `undeclaredDefault` drives the Sections table column and the policy a plain list falls back to.
- `layering` tells the fold how the section's entries union across layers; every list section declares one, and the registry refuses a list module without it.
- `validate` is the section's file-only check, run by the validation phase; the list-section factory derives it from the key, and a hand-written list module implements it.

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
  cli["src/cli.ts<br>src/cli/"]
  library["src/index.ts"]
  internal["src/internal.ts"]
  flows["src/flows/"]
  engine["src/engine/"]
  sections["src/sections/"]
  github["src/github/"]
  discovery["src/discovery/"]
  report["src/report/"]
  schema["src/schema.ts"]
  io["src/io.ts"]
  problem["src/problem.ts"]
  types["src/types.ts"]
  plain_data["src/plain-data.ts"]
  text["src/text.ts"]
  private["src/private.ts<br>src/private-open.ts"]
  upstream_gaps["src/upstream-gaps/"]
  main --> action
  action --> library
  cli --> library
  cli --> internal
  library --> discovery
  library --> engine
  library --> flows
  library --> github
  library --> io
  library --> problem
  library --> report
  library --> schema
  library --> sections
  internal --> discovery
  internal --> engine
  internal --> flows
  internal --> github
  internal --> problem
  internal --> report
  internal --> schema
  internal --> sections
  internal --> text
  internal --> types
  flows --> discovery
  flows --> engine
  flows --> github
  flows --> io
  flows --> private
  flows --> problem
  flows --> report
  flows --> schema
  flows --> text
  flows --> types
  engine --> discovery
  engine --> github
  engine --> io
  engine --> plain_data
  engine --> problem
  engine --> schema
  engine --> sections
  engine --> text
  engine --> types
  sections --> discovery
  sections --> engine
  sections --> github
  sections --> schema
  sections --> text
  sections --> types
  sections --> upstream_gaps
  github --> io
  github --> plain_data
  discovery --> github
  discovery --> private
  discovery --> problem
  discovery --> text
  report --> discovery
  report --> engine
  report --> github
  report --> io
  report --> private
  report --> problem
  report --> schema
  report --> sections
  report --> types
  problem --> plain_data
  problem --> schema
  problem --> text
  schema --> sections
  schema --> types
  upstream_gaps --> types
```
<!-- END GENERATED: architecture-map -->

The e2e harness fragments beside each section (`mock.ts`, `generators.ts`) are test code and sit outside the map.
