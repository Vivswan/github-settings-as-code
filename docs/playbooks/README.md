# Playbooks

Operational playbooks for running this action as a platform team: rolling a baseline out in rings, previewing fleet changes, splitting trust between tokens, producing audit evidence, and handling incidents. Each playbook composes inputs and sections that the [README](../../README.md) documents individually; the [multi-repo guide](../operate/multi-repo.md) covers the underlying mechanics. All of these work with the action as it is today.

- [A fleet security baseline, rolled out in rings](fleet-baseline-rings.md)
- [Preview the blast radius of a fleet change](preview-blast-radius.md)
- [A cloud OIDC trust contract](oidc-trust-contract.md)
- [Private-fork PR containment](private-fork-containment.md)
- [Trust tiers: read-only preview, gated apply](trust-tiers.md)
- [Drift attestation for auditors](drift-attestation.md)
- [Access through teams, not direct collaborators](teams-not-collaborators.md)
- [Incident freeze and unfreeze](incident-freeze.md)
- [Sunset and decommission](sunset-decommission.md)
