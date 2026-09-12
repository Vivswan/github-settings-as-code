---
order: 1
---

# Upgrading

One page per major version. A major is the only release that can change what an existing settings file or workflow does, so each one gets a guide here listing every break with its before, its after, and the error the old form now produces.

## How the tags move

| Pin | Moves when | Use it for |
|---|---|---|
| `@v2` (the moving major) <!-- x-release-please-major --> | Every release in that major line | Fixes arrive without touching your pin; the line never breaks a working file |
| `@vX.Y.Z` | Never | Byte-stable behavior; upgrade deliberately |
| A commit SHA | Never | The same, for repositories that pin actions by digest |

Every version tag cut since the `build` branch exists points at a packaged commit on it carrying the built action, and those cut since the library joined it also carry the library build (`lib/pkg/`, what the npm package of the same version ships); the packaged commit records its source, the audited release commit on `main`, in a trailer, and a ruleset freezes the tag. The tags up to v2.0.0 point at release commits on `main` from when main still committed the bundle. Only the latest release is supported; fixes are not backported.

## The guides

| From | To | Guide |
|---|---|---|
| v1 | v2 | [v1 to v2](v1-to-v2.md): the repository rename in `uses:`, and four keys that went from inert to acting |
| v2 | v3 | [v2 to v3](v2-to-v3.md): `defaults-file` becomes a fallback, `undeclared` becomes `_undeclared`, and layering moves to `mode: merge` |

## Additions inside a major

A minor release can add a mode, an input, or a `result` value without breaking a working file or workflow. Two additions worth knowing when a step branches on `result`:

| Since | Addition | What to check |
|---|---|---|
| v3 | `mode: snapshot` ([guide](../operate/snapshot.md)) | `result` may read `snapshot` in that mode, beside `partial` and `failed`; a step that treats every unknown `result` as a failure should list it |

## The convention

Every future major adds a page to this folder and a row to the table above before it ships. The [CHANGELOG](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md) keeps the release-please footers; the guide is the reading order, with a row per break and a check-first step where a break is silent.
