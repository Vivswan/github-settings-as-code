---
order: 500
---

# Reference

For someone who needs the exact rule: what a key, an input, or a token grant does. These pages are looked up, not read in order; the guides under [Start](../start/README.md) and [Operate](../operate/README.md) link into them.

- [Sections](sections.md): every top-level key a settings file can declare, with its endpoints, its PAT permission, and what happens to live resources the file does not declare.
- [Coverage](coverage.md): the inventory of what works today, what is repo-scoped but not built yet, and what is out of scope.
- [Inputs and outputs](inputs.md): every `with:` input the action accepts, and the outputs it sets.
- [Semantics](semantics.md): the rules every section obeys: what the engine compares, what it deletes, and what happens around a failure.
- [Token permissions](permissions.md): which grant each section needs, how to scope a PAT, and what a denial looks like.
- [The undeclared policy](undeclared-policy.md): the default answer, per section, for a live resource the settings file does not declare, and how to override it.
- [Forward compatibility](forward-compatibility.md): where new GitHub fields pass through untouched, and where a shape is deliberately closed.
- [Secrets and vaults](secrets-and-vaults.md): how a secret field takes a `$NAME` reference resolved at apply time instead of a committed value.
- [Architecture](architecture.md): how the action works, one diagram at a time.
- [Library](library.md): the engine as the npm package `@vivswan/github-settings-as-code`.
