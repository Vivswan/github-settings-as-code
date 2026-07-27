# Access through teams, not direct collaborators

Quarterly access reviews stay manual while direct collaborator grants
accumulate. Making team rosters the only path to access turns the review
into reading one file:

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

An empty `collaborators` list is authoritative: apply removes every direct
collaborator (the repository owner is never touched), and team-derived
access is unaffected because the section manages direct grants only. In
check mode the same file emits one drift line per unauthorized direct
grant, which is the access review report. Two caveats complete the
picture. Undeclared collaborators are deleted under this file's plain-array
declaration (the section's default policy) while undeclared teams are
left untouched (see the [Sections table](../../README.md#sections)), so a
team you stop declaring keeps its access until removed by hand. And
pending invitations are outside the section's reach: it invites new
collaborators but does not list or cancel invitations already pending, so
an old invitation can still turn into direct access later;
`gh api repos/acme/payments/invitations` is the companion audit.
