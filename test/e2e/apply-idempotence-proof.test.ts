/** Each exported classifier is tested directly so the corresponding e2e assertion is provably able to fire. */

import { describe, expect, test } from "bun:test";
import { endpointMethod } from "../../src/sections/contract/endpoints.js";
import { allEndpoints, type SectionEndpointKey } from "../../src/sections/registry.js";
import { ALWAYS_REWRITE_ENDPOINT_FAMILIES, recurringEndpointKeys } from "./apply-idempotence.js";
import {
  changedFamilies,
  type ExemptWriteWitness,
  missingSecondApplyRewrites,
  recordExemptWrites,
  secondApplyWriteFailures,
  unwitnessedExemptEndpoints,
} from "./apply-idempotence-proof.js";
import type { LoggedRequest } from "./mock/contract.js";

const write = (method: string, pathname: string): LoggedRequest => ({
  method,
  pathname,
  query: "",
  status: 200,
});

describe("recurrence (endpoint flags <-> harness declarations)", () => {
  test("every alwaysRewrite endpoint declares its mock state family, and nothing else does", () => {
    // The required-rewrite obligation lives on the EndpointDecl; the snapshot exclusion derives
    // from this mapping, so a newly flagged endpoint fails here until it names its family.
    expect(recurringEndpointKeys("always")).toEqual(
      Object.keys(ALWAYS_REWRITE_ENDPOINT_FAMILIES).sort(),
    );
    // Pinned literally: the families are mock storage names (state.ts), which nothing can derive.
    expect(ALWAYS_REWRITE_ENDPOINT_FAMILIES).toEqual({
      "actions_secrets.put": "actions_secrets",
      "dependabot_secrets.put": "dependabot_secrets",
      "codespaces_secrets.put": "codespaces_secrets",
      "agents_secrets.put": "agents_secrets",
      "environments.putSecret": "environment_secrets",
      "interaction_limits.put": "interaction_limits",
      "repository.lfsPut": null,
      "repository.lfsRemove": null,
      "check_suite_preferences.update": null,
    });
  });

  test("the unverifiable flag sits on declared WRITE endpoints that are not alwaysRewrite", () => {
    // Pinned literally so a flag moving onto a read or a sealed PUT (where "always" already
    // binds) is a visible decision, not a silent recurrence change.
    const declared = allEndpoints();
    expect(recurringEndpointKeys("may")).toEqual(["webhooks.create", "webhooks.updateConfig"]);
    for (const key of recurringEndpointKeys("may")) {
      const endpoint = declared[key as SectionEndpointKey];
      expect(endpointMethod(endpoint.route)).not.toBe("GET");
      expect(endpoint.alwaysRewrite).toBeUndefined();
    }
  });
});

describe("secondApplyWriteFailures (apply-idempotence zero-write rule)", () => {
  test("a write to a compare-before-write endpoint fires the assertion", () => {
    const failures = secondApplyWriteFailures([write("POST", "/repos/e2e-owner/e2e-repo/labels")]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"labels"');
    expect(failures[0]).toContain("live state already matched");
  });

  test("the exemption is per endpoint: a section's alwaysRewrite write passes while its drift-gated sibling fires", () => {
    const pairs: Array<[LoggedRequest, LoggedRequest]> = [
      [write("PUT", "/repos/e2e-owner/e2e-repo/lfs"), write("PATCH", "/repos/e2e-owner/e2e-repo")],
      [
        write("PUT", "/repos/e2e-owner/e2e-repo/actions/secrets/DEPLOY_TOKEN"),
        write("DELETE", "/repos/e2e-owner/e2e-repo/actions/secrets/STALE"),
      ],
      [
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/production/secrets/DEPLOY_TOKEN"),
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/production"),
      ],
    ];
    for (const [exempt, gated] of pairs) {
      expect(secondApplyWriteFailures([exempt])).toEqual([]);
      const failures = secondApplyWriteFailures([exempt, gated]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain(`${gated.method} ${gated.pathname}`);
    }
  });

  test("an unverifiable webhook write may recur; the same section's drift-gated writes may not", () => {
    const hooks = "/repos/e2e-owner/e2e-repo/hooks";
    expect(secondApplyWriteFailures([write("PATCH", `${hooks}/601/config`)])).toEqual([]);
    expect(secondApplyWriteFailures([write("POST", hooks)])).toEqual([]);
    const failures = secondApplyWriteFailures([
      write("PATCH", `${hooks}/601`),
      write("DELETE", `${hooks}/602`),
    ]);
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain(`PATCH ${hooks}/601`);
    expect(failures.join("\n")).toContain(`DELETE ${hooks}/602`);
  });

  test("a write matching no section endpoint fires the outside-section failure", () => {
    // Report traffic (the issue channel) is the realistic offender: an
    // idempotence re-run must not deliver a report at all.
    const failures = secondApplyWriteFailures([
      write("POST", "/repos/e2e-owner/svc-private/issues"),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("outside any section endpoint");
  });

  test("every compare-before-write write is flagged, per offender", () => {
    const failures = secondApplyWriteFailures([
      write("PATCH", "/repos/e2e-owner/e2e-repo/labels/bug"),
      write("POST", "/repos/e2e-owner/e2e-repo/milestones"),
      write("DELETE", "/repos/e2e-owner/e2e-repo/autolinks/1"),
      write("PUT", "/repos/e2e-owner/e2e-repo/collaborators/alice"),
      write("PUT", "/repos/e2e-owner/e2e-repo/actions/workflows/7/enable"),
      write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
    ]);
    expect(failures).toHaveLength(6);
  });
});

describe("missingSecondApplyRewrites (apply-idempotence always-rewrite subset)", () => {
  const secretPut = write("PUT", "/repos/e2e-owner/e2e-repo/actions/secrets/DEPLOY_TOKEN");

  test("a first-apply secret PUT the second apply skipped fires the assertion", () => {
    const failures = missingSecondApplyRewrites([secretPut], []);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("actions/secrets/DEPLOY_TOKEN");
    expect(failures[0]).toContain("re-issued on EVERY apply");
  });

  test("a same-path write in the other direction is not a re-issue", () => {
    const lfs = "/repos/e2e-owner/e2e-repo/lfs";
    const failures = missingSecondApplyRewrites([write("PUT", lfs)], [write("DELETE", lfs)]);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain(`DELETE ${lfs} 0 time(s) and the second 1`);
    expect(failures[1]).toContain(`PUT ${lfs} 1 time(s) and the second 0`);
    expect(missingSecondApplyRewrites([write("PUT", lfs)], [write("PUT", lfs)])).toEqual([]);
    expect(
      missingSecondApplyRewrites([write("PUT", lfs), write("PUT", lfs)], [write("PUT", lfs)]),
    ).toHaveLength(1);
    expect(
      missingSecondApplyRewrites([write("PUT", lfs)], [write("PUT", lfs), write("PUT", lfs)]),
    ).toHaveLength(1);
    const withQuery = (query: string): LoggedRequest => ({ ...write("PUT", lfs), query });
    expect(missingSecondApplyRewrites([withQuery("a=1")], [withQuery("a=2")])).toHaveLength(2);
    expect(missingSecondApplyRewrites([withQuery("a=1")], [withQuery("a=1")])).toEqual([]);
  });

  test("a re-issued secret PUT passes; unflagged writes never bind, an unverifiable one included", () => {
    expect(
      missingSecondApplyRewrites(
        [
          secretPut,
          write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
          write("PATCH", "/repos/e2e-owner/e2e-repo/hooks/601/config"),
        ],
        [secretPut],
      ),
    ).toEqual([]);
  });

  test("the read-less check suite preferences PATCH binds like a sealed PUT", () => {
    // Not a secret and not a PUT: the obligation is the alwaysRewrite flag,
    // whatever the method, so a second apply that skips it fires.
    const patch = write("PATCH", "/repos/e2e-owner/e2e-repo/check-suites/preferences");
    const failures = missingSecondApplyRewrites([patch], []);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("PATCH /repos/e2e-owner/e2e-repo/check-suites/preferences");
    expect(missingSecondApplyRewrites([patch], [patch])).toEqual([]);
  });

  test("a first-apply secret DELETE creates no re-write obligation", () => {
    // The purge direction is one-shot: the second apply sees no live secret
    // to delete, so only PUTs bind.
    expect(
      missingSecondApplyRewrites(
        [write("DELETE", "/repos/e2e-owner/e2e-repo/actions/secrets/STALE")],
        [],
      ),
    ).toEqual([]);
  });

  test("every family's sealed PUT binds: dependabot, codespaces, environment secrets", () => {
    const firstWrites = [
      write("PUT", "/repos/e2e-owner/e2e-repo/dependabot/secrets/REGISTRY_TOKEN"),
      write("PUT", "/repos/e2e-owner/e2e-repo/codespaces/secrets/DOTFILES_PAT"),
      write("PUT", "/repos/e2e-owner/e2e-repo/environments/prod"),
      write("PUT", "/repos/e2e-owner/e2e-repo/environments/prod/secrets/DEPLOY_KEY"),
    ];
    const failures = missingSecondApplyRewrites(firstWrites, []);
    expect(failures).toHaveLength(3);
    expect(failures.join("\n")).toContain("dependabot/secrets/REGISTRY_TOKEN");
    expect(failures.join("\n")).toContain("codespaces/secrets/DOTFILES_PAT");
    expect(failures.join("\n")).toContain("environments/prod/secrets/DEPLOY_KEY");
    expect(failures.join("\n")).not.toContain("environments/prod but");
  });
});

describe("unwitnessedExemptEndpoints (apply-idempotence corpus witness)", () => {
  const coveredWitness = (): ExemptWriteWitness =>
    new Map(
      [...recurringEndpointKeys("always"), ...recurringEndpointKeys("may")].map((key) => [
        key,
        { first: 1, second: 1 },
      ]),
    );

  test("a fully covered corpus produces no failures", () => {
    expect(unwitnessedExemptEndpoints(coveredWitness())).toEqual([]);
  });

  test("an empty corpus flags EVERY exempt endpoint as unwitnessed, once each", () => {
    const failures = unwitnessedExemptEndpoints(new Map());
    const exempt = recurringEndpointKeys("always").length + recurringEndpointKeys("may").length;
    expect(failures).toHaveLength(exempt);
    for (const failure of failures) {
      expect(failure).toContain("NO apply_idempotent scenario");
    }
  });

  test("unverifiable writes seen only on first applies name the drop-the-exemption remedy, per section", () => {
    const witness = coveredWitness();
    for (const key of recurringEndpointKeys("may")) {
      witness.set(key, { first: 2, second: 0 });
    }
    const failures = unwitnessedExemptEndpoints(witness);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"webhooks"');
    expect(failures[0]).toContain("no second apply in the corpus re-issued");
    witness.set("webhooks.updateConfig", { first: 2, second: 2 });
    expect(unwitnessedExemptEndpoints(witness)).toEqual([]);
  });

  test("recordExemptWrites counts only exempt endpoints, per side", () => {
    const witness: ExemptWriteWitness = new Map();
    recordExemptWrites(
      witness,
      [
        write("POST", "/repos/e2e-owner/e2e-repo/labels"),
        write("POST", "/repos/e2e-owner/svc-private/issues"),
        write("PATCH", "/repos/e2e-owner/e2e-repo"),
        write("PUT", "/repos/e2e-owner/e2e-repo/lfs"),
        write("PATCH", "/repos/e2e-owner/e2e-repo/hooks/601/config"),
      ],
      [write("PUT", "/repos/e2e-owner/e2e-repo/lfs")],
    );
    expect([...witness.entries()].sort()).toEqual([
      ["repository.lfsPut", { first: 1, second: 1 }],
      ["webhooks.updateConfig", { first: 1, second: 0 }],
    ]);
  });
});

describe("changedFamilies (apply-idempotence state stability)", () => {
  test("names exactly the families whose serialized state moved", () => {
    const before = new Map([
      ["state.labels", '[{"name":"bug"}]'],
      ["state.rulesets", "[]"],
    ]);
    const after = new Map([
      ["state.labels", "[]"],
      ["state.rulesets", "[]"],
    ]);
    expect(changedFamilies(before, after)).toEqual(["state.labels"]);
  });

  test("identical snapshots report no change", () => {
    const snap = new Map([["state.repo", '{"name":"x"}']]);
    expect(changedFamilies(snap, new Map(snap))).toEqual([]);
  });

  test("a family present on only one side counts as changed", () => {
    expect(changedFamilies(new Map(), new Map([["a/b.issues", "[]"]]))).toEqual(["a/b.issues"]);
    expect(changedFamilies(new Map([["a/b.issues", "[]"]]), new Map())).toEqual(["a/b.issues"]);
  });
});
