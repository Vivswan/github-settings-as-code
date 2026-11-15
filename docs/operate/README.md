---
order: 200
---

# Operate

For someone who has a first green run and now runs the action day to day: guides for check, snapshot, and render mode, for managing a fleet, and for when a run goes wrong. Read the one for what you are about to do; the [playbooks](../playbooks/README.md) compose these into fleet patterns.

- [Check mode](check-mode.md): `mode: check` runs the whole pipeline read-only and reports how the live state differs from the settings file.
- [Snapshot mode](snapshot.md): `mode: snapshot` reads a repository's live settings back and writes them as a settings file.
- [Multi-repo mode](multi-repo.md): one workflow in an admin repository manages a whole fleet: choosing targets, the discovery filters, and the defaults fallback.
- [Private repositories](private-repositories.md): the `private-repos` redaction for runs whose logs are less private than their targets, and the `private-report` channels that deliver the full detail privately.
- [Troubleshooting](troubleshooting.md): the symptoms where the error message alone benefits from context: denials, limits, validation errors, and runs that do not match the code you expect.
- [Layering settings files](layering.md): `mode: render` folds an ordered list of settings files into one document, which an apply or check step then takes.
