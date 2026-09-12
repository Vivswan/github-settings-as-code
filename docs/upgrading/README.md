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

Every version tag points at a packaged commit carrying the built action; tags cut after the library joined the packaged branch also carry the library build (`lib/pkg/`, what the npm package of the same version ships), and v2.0.0 and earlier carry the action bundle alone. Its parent is the audited release commit on `main`, and a ruleset freezes the tag. Only the latest release is supported; fixes are not backported.

## The guides

| From | To | Guide |
|---|---|---|
| v1 | v2 | [v1 to v2](v1-to-v2.md): the repository rename in `uses:`, and four keys that went from inert to acting |
| v2 | v3 | [v2 to v3](v2-to-v3.md): `defaults-file` becomes a fallback, `undeclared` becomes `_undeclared`, and layering moves to `mode: merge` |

## The convention

Every future major adds a page to this folder and a row to the table above before it ships. The [CHANGELOG](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md) keeps the release-please footers; the guide is the reading order, with a row per break and a check-first step where a break is silent.
