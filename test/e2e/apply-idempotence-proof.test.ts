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
  });

  test("the unverifiable flag sits on declared WRITE endpoints that are not alwaysRewrite", () => {
    // A flag on a read or on a sealed PUT (where "always" already binds) would change the recurrence rule silently.
    const declared = allEndpoints();
    expect(recurringEndpointKeys("may")).not.toEqual([]);
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
});

describe("missingSecondApplyRewrites (apply-idempotence always-rewrite subset)", () => {
  const secretPut = write("PUT", "/repos/e2e-owner/e2e-repo/actions/secrets/DEPLOY_TOKEN");
  const preferencesPatch = write("PATCH", "/repos/e2e-owner/e2e-repo/check-suites/preferences");

  // The obligation is the alwaysRewrite flag, whatever the method: a sealed PUT of every secret family and the
  // read-less preferences PATCH bind; the purge direction is one-shot (the second apply sees no live secret to
  // delete), and unflagged writes never bind, the unverifiable webhook one included.
  test.each<
    [
      label: string,
      first: LoggedRequest[],
      second: LoggedRequest[],
      count: number,
      mentions: string[],
      omits: string[],
    ]
  >([
    [
      "a first-apply secret PUT the second apply skipped fires",
      [secretPut],
      [],
      1,
      ["actions/secrets/DEPLOY_TOKEN", "re-issued on EVERY apply"],
      [],
    ],
    [
      "a re-issued secret PUT passes; unflagged writes never bind",
      [
        secretPut,
        write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
        write("PATCH", "/repos/e2e-owner/e2e-repo/hooks/601/config"),
      ],
      [secretPut],
      0,
      [],
      [],
    ],
    [
      "the read-less check suite preferences PATCH binds like a sealed PUT",
      [preferencesPatch],
      [],
      1,
      ["PATCH /repos/e2e-owner/e2e-repo/check-suites/preferences"],
      [],
    ],
    ["a re-issued preferences PATCH passes", [preferencesPatch], [preferencesPatch], 0, [], []],
    [
      "a first-apply secret DELETE creates no re-write obligation",
      [write("DELETE", "/repos/e2e-owner/e2e-repo/actions/secrets/STALE")],
      [],
      0,
      [],
      [],
    ],
    [
      "every family's sealed PUT binds: dependabot, codespaces, environment secrets",
      [
        write("PUT", "/repos/e2e-owner/e2e-repo/dependabot/secrets/REGISTRY_TOKEN"),
        write("PUT", "/repos/e2e-owner/e2e-repo/codespaces/secrets/DOTFILES_PAT"),
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/prod"),
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/prod/secrets/DEPLOY_KEY"),
      ],
      [],
      3,
      [
        "dependabot/secrets/REGISTRY_TOKEN",
        "codespaces/secrets/DOTFILES_PAT",
        "environments/prod/secrets/DEPLOY_KEY",
      ],
      ["environments/prod 1 time(s)"],
    ],
  ])("%s", (_label, first, second, count, mentions, omits) => {
    const failures = missingSecondApplyRewrites(first, second);
    expect(failures).toHaveLength(count);
    const joined = failures.join("\n");
    for (const text of mentions) {
      expect(joined).toContain(text);
    }
    for (const text of omits) {
      expect(joined).not.toContain(text);
    }
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
});

describe("unwitnessedExemptEndpoints (apply-idempotence corpus witness)", () => {
  const exemptKeys = [...recurringEndpointKeys("always"), ...recurringEndpointKeys("may")];
  const coveredWitness = (): ExemptWriteWitness =>
    new Map(exemptKeys.map((key) => [key, { first: 1, second: 1 }]));

  test.each<[label: string, witness: ExemptWriteWitness, unwitnessed: number]>([
    ["a fully covered corpus produces no failures", coveredWitness(), 0],
    ["an empty corpus flags EVERY exempt endpoint, once each", new Map(), exemptKeys.length],
  ])("%s", (_label, witness, unwitnessed) => {
    const failures = unwitnessedExemptEndpoints(witness);
    expect(failures).toHaveLength(unwitnessed);
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
  const issues = new Map([["a/b.issues", "[]"]]);
  test.each<
    [label: string, before: Map<string, string>, after: Map<string, string>, changed: string[]]
  >([
    [
      "names exactly the families whose serialized state moved",
      new Map([
        ["state.labels", '[{"name":"bug"}]'],
        ["state.rulesets", "[]"],
      ]),
      new Map([
        ["state.labels", "[]"],
        ["state.rulesets", "[]"],
      ]),
      ["state.labels"],
    ],
    [
      "identical snapshots report no change",
      new Map([["state.repo", '{"name":"x"}']]),
      new Map([["state.repo", '{"name":"x"}']]),
      [],
    ],
    ["a family present only after counts as changed", new Map(), issues, ["a/b.issues"]],
    ["a family present only before counts as changed", issues, new Map(), ["a/b.issues"]],
  ])("%s", (_label, before, after, changed) => {
    expect(changedFamilies(before, after)).toEqual(changed);
  });
});
