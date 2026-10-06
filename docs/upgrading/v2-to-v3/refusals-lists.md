---
order: 6
title: "Parse-time refusals: list sections"
---

# Upgrading from v2 to v3: parse-time refusals: list sections

Sections 36, 41, 42, 43, 46, 47, 48, 49, 50, 51, 52, 55, and 57 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 36. Labels: colors and descriptions

```text
v2   labels:
       - name: bug
         color: red                 # POST -> 422; on an existing label, re-PATCHed on every run
       - name: docs
         color: "#0075ca"
         description: <150 characters>

v3   labels[0].color: a label color is six hex digits, the leading "#" optional ("#d73a4a" or "d73a4a"); color names and three-digit shorthand are not accepted
     labels[1].description: a label description is at most 100 characters (GitHub's cap); this one has 150
     (exit 1, zero requests)
```

Fix: write the six-digit hex value and cut the description to 100 characters; the published JSON schema carries both rules, so an editor flags them first.

## 41. Branches: protection shapes

```text
v2   branches:
       - name: main
         protection:                # copied from GitHub's GET response
           url: https://api.github.com/repos/octocat/hello-world/branches/main/protection
           enforce_admins: {url: "...", enabled: true}
           required_status_checks: {strict: true, contexts: [ci], enforcement_level: everyone}
           restrictions: {users: [{login: octocat}], teams: []}
     -> PUT .../branches/main/protection -> 422 on the {url, enabled} wrapper; without it the PUT landed and the other GET-only keys drifted on every check

v3   branches[0].protection.required_status_checks.enforcement_level: ... is GitHub's GET-only echo, which the protection PUT has no word for; remove it (strict and the check list carry the requirement)
     branches[0].protection.url: ... is a link GitHub's GET response carries and the protection PUT has no word for; remove it
     branches[0].protection.enforce_admins.enabled: ... is GitHub's GET wrapper around the toggle, which the protection PUT takes as a bare boolean; declare enforce_admins: true instead
     branches[0].protection.restrictions.users[0]: ... carries an actor object copied from GitHub's GET response, which the protection PUT takes as the login string; write "octocat" instead
     (exit 1, zero requests)
```

| Declared | v2 | v3 |
|---|---|---|
| A GET-only key at any depth (`name`, `enabled`, `enforcement_level`, `url`, `*_url`) | A `{url, enabled}` wrapper 422ed at apply; the other keys applied, then drifted forever | Refused with the fix |
| `required_status_checks` without `strict`, or without `contexts` or `checks` | 422 at apply | Refused |
| `required_approving_review_count: 7` | 422 at apply | Refused: a whole number 0 to 6 |
| A `checks` item with a key other than `context` and `app_id` | Sent as written | Refused naming the key |
| A scalar where `required_status_checks` or `required_pull_request_reviews` goes | Refused on a wildcard entry, passed through to the PUT on a literal one | Refused: a mapping or `null` on every entry |
| An actor object copied from the GET (`restrictions.users: [{login: octocat}]`) | Sent to the PUT, which 422ed | Refused: write the `login` or `slug` string, `octocat` |

Fix: declare the PUT's shape (bare booleans, `strict` beside the check list, actors as their login or slug strings) instead of pasting the GET. Also new: a live `restrictions` holder whose `users`, `teams`, and `apps` are all empty is a push restriction that lets nobody through, so a file that omits it now sees the omitted-live drift line and a loud PUT instead of a silent lift.

## 42. Collaborators and teams: permissions and slugs

```text
v2   collaborators:
       - username: alice
         permission: write          # converged on an existing Write grant; PUT {"permission":"write"} on a new one -> 422
       - username: bob
         permission: Admin          # 422
     teams:
       - name: Core Team            # probed /teams/Core%20Team, 404; check said: no access to <repo>; apply will grant "push"
         permission: push

v3   collaborators[0].permission: "write" is the vocabulary GitHub reports a role in (role_name), not one a grant accepts; declare "push" ("pull", "triage", "push", "maintain", "admin", or a custom org role name)
     collaborators[1].permission: "Admin" is not a permission GitHub accepts; the standard permissions are lowercase: declare "admin"
     teams[0].name: a team is declared by its slug (the name in its URL, /orgs/<org>/teams/<slug>): letters, digits, ".", "_", and "-" only, at least one letter or digit; a team named "Core Team" usually has the slug "core-team"
```

Fix: declare `pull`, `triage`, `push`, `maintain`, `admin`, or a custom org role name as spelled, and name a team by its slug. Every suggested value in a message is one the schema accepts, and a block scalar's trailing newline is refused with the rule rather than a guess.

## 43. Secret and variable names, and the value cap

```text
v2   actions_secrets:
       - name: deploy-token         # parsed; earlier sections wrote; PUT .../secrets/DEPLOY-TOKEN -> 422 mid-apply
         value: $SECRET_DEPLOY_TOKEN

v3   actions_secrets[0].name: the secret name "deploy-token" has characters outside ASCII letters, digits, and underscore - GitHub accepts ASCII letters, digits, and underscores, not starting with a digit or with the reserved GITHUB_ prefix (in any case: names are stored uppercased)
     (exit 1, zero requests)
```

The rule covers every secret and variable family, the environment lists included: ASCII letters, digits, and underscores, no leading digit, no `GITHUB_` prefix in any case. A variable value is capped at 49152 bytes of UTF-8, counted as GitHub counts it.

Fix: rename the entry (`DEPLOY_TOKEN`) or shorten the value; the problem line names the entry's path.

## 46. Deploy keys: a public SSH key only

```text
v2   deploy_keys:
       - title: deploy-bot
         key: "-----BEGIN ..."      # a pasted private key: POST .../keys -> 201 against the mock, 422 on GitHub
     -> deploy_keys: created deploy key "deploy-bot", 3 requests

v3   deploy_keys[0].key: entry "deploy-bot": this is a private key; a deploy key takes the public half (the .pub file)
     (exit 1, zero requests; the material is never echoed)
```

`key` is `<algorithm> <base64> [comment]`, the algorithm one of `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`. `ssh-dss` is refused naming 2022-03-15, the day GitHub stopped accepting DSA keys; a PEM block is told to use the one-line form.

Fix: declare the contents of the `.pub` file. A live key under an algorithm the file cannot declare (an `ssh-ed448` key, a DSA key from before 2022) is outside the section: never matched, deleted, or aborted on, and a snapshot leaves it out with a note.

## 47. Webhooks: events, content type, insecure_ssl, and the url

```text
v2   webhooks:
       - config:
           url: hooks.example.com/ci
           content_type: JSON
           insecure_ssl: 2
         events: [push, pushes]
     -> validation accepted the file; POST /repos/{owner}/{repo}/hooks -> 422, after the other sections ran

v3   webhooks[0].config.url: "hooks.example.com/ci" is not an absolute URL (the shape is https://hooks.example.com/ci); GitHub refuses the hook otherwise
     webhooks[0].config.content_type: "JSON" is not a payload encoding GitHub accepts; use "json" or "form"
     webhooks[0].config.insecure_ssl: 2 is not a value GitHub accepts; use "0" (verify the TLS certificate) or "1" (skip verification), as a string or a number
     webhooks[0].events[1]: "pushes" is not an event GitHub delivers to repository webhooks ("*" means every event); the accepted names are GitHub's list at https://docs.github.com/webhooks/webhook-events-and-payloads, read from @octokit/openapi-webhooks, so an event GitHub added since arrives in the release that bumps that package
```

Fix: an absolute URL, `json` or `form`, `"0"` or `"1"`, and event names from GitHub's repository list. The list is pinned to `@octokit/openapi-webhooks`, so an event GitHub adds later is refused until the release that bumps that package.

## 48. Secret scanning patterns must compile

```text
v2   secret_scanning_custom_patterns:
       - name: internal-api-token
         pattern: "([a-z"           # parsed clean; check saw only a missing pattern; apply -> bulk create 422
         must_match: ["[0-9]", "*prod"]

v3   secret_scanning_custom_patterns[0].pattern: cannot be compiled as a regular expression (Invalid regular expression: missing terminating ] for character class); fix the expression, or report a documentation issue if Hyperscan accepts it as written - ...
     secret_scanning_custom_patterns[0].must_match[1]: cannot be compiled as a regular expression (quantifier does not follow a repeatable item); ...
```

The five regex fields pass a syntax check at parse. The check first translates the PCRE-only spellings Hyperscan accepts (named groups, comments, modifiers, atomic and possessive forms, quoted literals, code point escapes, POSIX classes), then compiles the result as a flagless JavaScript `RegExp`, so a pattern GitHub already holds is never refused.

Fix the expression. A snapshot leaves out a live pattern the check cannot verify, with a note naming it, and writes the rest; Hyperscan can still refuse at apply what it alone refuses (lookbehind, backreferences).

## 49. Rulesets: enforcement, actors, tokens, and parameters

```text
v2   rulesets:
       - name: main-protection
         enforcement: enabled
         conditions: {ref_name: {include: ["~all"]}}
         bypass_actors: [{actor_type: Team}]
         rules:
           - type: merge_queue
             parameters: {merge_method: squash, grouping_strategy: allgreen}
     -> POST /repos/{owner}/{repo}/rulesets -> 422, after the sections before rulesets wrote

v3   rulesets[0].enforcement: Invalid option: expected one of "active"|"evaluate"|"disabled"
     rulesets[0].conditions.ref_name.include[0]: "~all" is not a ref-name token: the tokens are ~ALL and ~DEFAULT_BRANCH (case-sensitive), and no ref name contains "~"
     rulesets[0].rules[0]: parameters.grouping_strategy: Invalid option: expected one of "ALLGREEN"|"HEADGREEN"; parameters.merge_method: Invalid option: expected one of "MERGE"|"SQUASH"|"REBASE"; parameters.check_response_timeout_minutes: Invalid input: expected number, received undefined; ... (the four other numeric merge_queue parameters the file left out, the same way)
     rulesets[0].bypass_actors[0].actor_id: a Team bypass actor needs its numeric actor_id (the id GitHub assigns the app, role, team, or user); GitHub rejects the ruleset without it
```

Bypass actors are typed from the spec: Integration, RepositoryRole, Team, and User need an `actor_id`; DeployKey takes none and never `pull_request`; `pull_request` applies to branch rulesets only. The 23 known rule types carry their parameters typed from the spec, in GitHub's casing; an unknown rule type still passes through, so a type GitHub ships tomorrow works the day it ships.

Fix: spell the enums as GitHub does, give each actor its id, and write `~ALL` or `~DEFAULT_BRANCH`.

## 50. Milestones: due_on is a day

```text
v2   milestones:
       - title: v1.0
         due_on: 2026-01-15            # compared verbatim to the "2026-01-15T08:00:00Z" GitHub echoes: drift forever
       - title: v2.0
         due_on: 2026-07-01T00:00:00Z  # sent verbatim: GitHub stored the PREVIOUS day

v3   due_on: 2026-01-15                # a calendar day; written as 2026-01-15T12:00:00Z, compared by day, converges
     due_on: null                      # refused, naming the day form
     due_on: 2026-01-15T00:00:00+02:00 # refused, naming the day form
```

GitHub reads the sent instant in US Pacific time, keeps the day, and stores Pacific midnight. v3 writes noon UTC (the same day in PST and PDT), compares the live timestamp by its UTC day, and a snapshot writes the day. A UTC timestamp `YYYY-MM-DDTHH:MM:SSZ` is still accepted, read for its date part.

Fix: write the day. There is no `null` to clear a due date yet.

## 51. Environments: disabled defaults and the refusals

```text
v2   environments:
       - name: production
         wait_timer: 0
         prevent_self_review: false
         reviewers: []
     -> drift: environments[production].wait_timer: declared 0 but the API response has no such field (new or write-only field?)
        (and the same for the other two; PUT on every run, never converged)

v3   -> result: clean
```

GitHub answers `protection_rules: []` for an unprotected environment, and the flattened body now starts from the disabled values, so the declaration is satisfied by the absence of the rule. A snapshot writes the three disabled values out for an unprotected environment.

| Declared | v2 | v3 |
|---|---|---|
| `deployment_branch_policy: {protected_branches: false, custom_branch_policies: false}` | 422 | Refused: GitHub spells "any branch may deploy" as `deployment_branch_policy: null`, so write `null` |
| Both flags `true` | 422 | Refused: the flags are mutually exclusive |
| `prevent_self_review: true` with no reviewers | Drifted forever (the flag rides the required-reviewers rule) | Refused: declare a reviewer, or write `false` |
| `wait_timer: 2.5`, or outside 0 to 43200 | 422 | Refused: a whole number of minutes in GitHub's range |
| More than 6 `reviewers` | 422 | Refused: GitHub's cap |
| `deployment_branch_policies[].type: wildcard` | Deleted the live policy, then the create 422ed; every run retried | Refused: `branch` or `tag` |

## 52. Autolinks: charset, placeholder, and overlapping prefixes

```text
v2   autolinks:
       - key_prefix: TICKET-
         url_template: https://example.com/TICKET       # 422 on the create
       - key_prefix: ""
         url_template: https://example.com/<num>        # 422
       - key_prefix: "BUG "
         url_template: https://example.com/BUG/<num>    # 422

v3   autolinks[0].url_template: url_template "https://example.com/TICKET" has no "<num>" placeholder, so GitHub rejects the create; put "<num>" where the reference number goes, e.g. "https://example.com/TICKET/<num>"
     autolinks[1].key_prefix: key_prefix is empty; it is the text GitHub matches before the reference number, e.g. "TICKET-"
     autolinks[2].key_prefix: key_prefix "BUG " may only contain letters, digits, and . - _ + = : / #, which is all GitHub accepts; remove the other characters
```

Two prefixes where one begins the other (`TICKET-` and `TICKET-A`) are refused as a pair before the section's read, since GitHub rejects the second create. A recreate (the template changed) now carries the live `is_alphanumeric`; v2's create sent `is_alphanumeric: true` itself when the file left the flag out, flipping a live `false` with no drift line.

Fix: a non-empty prefix in GitHub's charset, `<num>` in every template, and prefixes where neither begins another.

## 55. Branches: a restrictions block carries users and teams

```text
v2   branches:
       - name: main
         protection:
           restrictions: {}                    # parsed clean
       - name: develop
         protection:
           restrictions:
             users: [octocat]
             apps: [deploy-gate]               # parsed clean
     -> PUT .../branches/main/protection -> 422, with v2's hint: "restrictions" needs "users" and "teams" lists (or declare the whole key as null)

v3   branches[0].protection.restrictions.users: protection.restrictions must carry both users and teams ([] when none; apps is optional), since GitHub's protection PUT requires the two lists; restrictions: null lifts the push restriction
     branches[0].protection.restrictions.teams: protection.restrictions must carry both users and teams ...
     branches[1].protection.restrictions.teams: protection.restrictions must carry both users and teams ...
     (exit 1, zero requests)
```

GitHub's protection PUT requires `users` and `teams` under `restrictions` and takes `apps` as optional, so each missing list is refused before any request. The two review-side holders are unchanged: `dismissal_restrictions: {}` and `bypass_pull_request_allowances: {}` stay legal, since GitHub documents the empty mapping there as "disabled".

Fix: declare both lists (`users: []` and `teams: []` when none), or write `restrictions: null` to lift the push restriction.

## 57. A closed section's unrecognized key names the entry by index

A bracket in a validation issue's path always holds an index now. The unrecognized-key message of the closed sections (`collaborators`, `teams`, `workflows`, `custom_properties`, `secret_scanning_custom_patterns`, and the four secrets sections) was the one message that put the entry's identity there; it names the entry by its index and carries the identity in the text.

```text
v2   collaborators[octocat]: declares "permision", which this section does not recognize (known keys: username, permission) - ...

v3   collaborators[0] (username "octocat"): declares "permision", which this section does not recognize (known keys: username, permission) - ...
```

Under an `{_undeclared, entries}` wrapper the path reads `collaborators.entries[0] (username "octocat")`, as every other issue under a wrapper does.

Fix: anything that greps the bracket for the entry's identity reads the parenthesis instead.
