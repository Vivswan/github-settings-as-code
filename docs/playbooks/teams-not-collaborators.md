---
order: 380
---

# Access through teams, not direct collaborators

Quarterly access reviews stay manual while direct collaborator grants accumulate. Making team rosters the only path to access turns the review into reading one file:

```yaml settings
collaborators: []

teams:
  - name: platform
    permission: admin
  - name: payments
    permission: maintain
  - name: security-review
    permission: pull
```

An empty `collaborators` list is authoritative: apply removes every direct collaborator (the repository owner is never touched), and team-derived access is unaffected because the section manages direct grants only. In check mode the same file emits one drift line per unauthorized direct grant, which is the access review report. Two caveats complete the picture. Undeclared collaborators are deleted under this file's plain-array declaration (the section's default policy) while undeclared teams holding a direct grant are kept and noted under the section's default (see the [Sections table](../reference/sections.md)): a team you stop declaring keeps its access until removed by hand, or until you set the wrapped `teams: {_undeclared: delete, entries: [...]}` form, which revokes the direct grants the file does not name. And pending invitations are reconciled alongside the collaborators: an undeclared pending invitation is cancelled under the same policy (kept as a note under `_undeclared: keep`), a declared user's pending invitation counts as converged at the declared permission, and only an invitation sent by email - which no username can declare - is left untouched, each surfaced as a note.
