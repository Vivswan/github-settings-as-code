---
order: 10
---

# Upgrading from v1 to v2

Four breaks, all listed in the [2.0.0 changelog entry](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md#200-2026-08-11). Do the audit step before you move the pin.

## 1. The repository moved

| v1 | v2 |
|---|---|
| `Vivswan/repo-settings-as-code@v1` | `Vivswan/github-settings-as-code@v2` |

A workflow still naming the old repository fails with "repository not found". Update every `uses:` line, then move the pin.

## 2. Four keys went from inert to acting

On v1 these keys were accepted and silently ignored (a notice said so, or check mode showed permanent drift). On v2 they act on the first apply.

| Key | v1 | v2 | Audit for |
|---|---|---|---|
| `branches[].protection.required_signatures` | Rode the protection PUT, where GitHub dropped it | Toggles the signed-commit requirement | A stale `required_signatures: false` REMOVES a hand-enabled requirement |
| `actions.fork_pr_contributor_approval`, `actions.fork_pr_workflows_private_repos` | Fell through to the base permissions PUT, ignored | Apply the fork pull request policies | Values copied in without intent |
| `actions.oidc_customization_sub` | Fell through to the base permissions PUT, ignored | Customizes the OIDC subject claim template | A template that no longer matches your cloud trust policy |

The changelog footers carry the full wording: [required_signatures](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md#200-2026-08-11), [the fork PR keys](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md#200-2026-08-11), and [oidc_customization_sub](https://github.com/Vivswan/github-settings-as-code/blob/main/CHANGELOG.md#200-2026-08-11).

## The audit step

1. Search every settings file for the four keys above.
2. For each hit, decide whether the value is what you want live today. Delete the key if you are not sure: an absent key is never touched.
3. Move the pin to `@v2` with `mode: check` and read the drift lines. Each key that would act shows up as drift before it changes anything.
4. Switch back to apply.

The v1 line keeps the old inert behavior, so a pin you cannot audit yet can stay on `@v1` until you can.
