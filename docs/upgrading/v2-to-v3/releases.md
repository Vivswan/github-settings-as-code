---
order: 8
title: "Releases and tags"
---

# Upgrading from v2 to v3: releases and tags

Sections 21 and 59 of the [v2 to v3 guide](../v2-to-v3.md), whose index page carries the summary table and the order of operations.

## 21. The build branch retires

The `build` branch was deleted on 2026-09-13. A `Vivswan/github-settings-as-code@<sha>` pin into it names a commit no ref keeps alive, so GitHub may collect it at any time: repin to a release tag, `@v3`, `@latest`, a `build/<position>.<sha7>` tag (the ten newest kept), or an npm version.

Every green push to `main` now mints one packaged commit, the main commit's child carrying the built action and library, under the tag `build/<position>.<sha7>` (the position is the commit's first-parent count on `main`). Each green push then prunes those tags to the ten newest: a tag goes once ten newer commits have been packaged, and GitHub may then collect its commit.

| You pin | Lifetime | Do |
|---|---|---|
| `@v3` or `@latest` | Moves forward only, never deleted | Nothing |
| A release tag or its commit sha (`git rev-parse v3.0.0`) | Permanent | Nothing |
| A sha from the `build` branch | Unreachable since the branch was deleted on 2026-09-13; GitHub may collect the commit at any time | Repin to `@v3` or a release tag's commit now |
| A sha from a `build/*` tag | Until ten newer commits are packaged (the next merge, for an old tag) | Pin the release tag's commit or an npm version instead |

## 59. `next` publishes on a release-PR refresh

For anyone installing `@vivswan/github-settings-as-code@next`. The pre-release v3 builds published a `next` pre-release from every green push to `main` that changed what the tarball ships or builds it; v3 publishes one when release-please creates or refreshes the release PR, and nowhere else.

A releasable commit publishes in the run that lands it; a merge of hidden types alone (a `build(deps)` bump, a test, a doc) publishes nothing. [Versioning](../../reference/library.md#versioning) owns the rule, the guard that keeps `next` from moving back, and its residual window.

```text
pre-release   merge build(deps): bump yaml   -> green -> bun.lock changed        -> publish 3.0.1-main.447.20260922.gabc1234 under next
              merge fix(x): ...              -> green -> src/ changed             -> publish 3.0.1-main.448.20260922.gdef5678 under next

v3            merge build(deps): bump yaml   -> green -> no release-PR refresh    -> nothing published
              merge fix(x): ...              -> green -> release PR refreshed     -> publish 3.0.1-main.448.20260922.gdef5678 under next
```

Fix: nothing for a consumer of `@next`. For a build of one exact commit, install the packaged commit (`github:Vivswan/github-settings-as-code#<packaged sha>`, from a `build/<position>.<sha7>` tag, the ten newest kept, or a release tag).
