# Sunset and decommission

Repositories at end of life need a defined terminal state, and archiving has an ordering trap: settings writes fail on archived repositories, and sections run in a fixed order with `repository` first, so a single file that sets `archived: true` alongside other sections archives the repository and then fails the rest. Sunset in two steps. First the terminal state:

```yaml settings
repository:
  description: "superseded by acme/payments-v2"
  has_issues: false
  has_wiki: false

actions:
  enabled: false

interaction_limits:
  limit: collaborators_only
  expiry: six_months
```

Then, once that run is green, a file containing only the archive flag:

```yaml settings
repository:
  archived: true
```

After that, leave the repository out of managed target lists: `repos: "*"` discovery skips archived repositories by default (`archived: skip`), and a scheduled check with `archived: only` and `mode: check` is the audit that the sunset fleet stays sunset.
