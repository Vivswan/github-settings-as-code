/**
 * Unit tests for the apply-idempotence layer: the declaration tables
 * (apply-idempotence.ts) and the proof engine's pure classifiers
 * (apply-idempotence-proof.ts). Each exported classifier is tested directly
 * so the corresponding e2e assertion is provably able to fire.
 */

import { describe, expect, test } from "bun:test";
import type { SectionKey } from "../../src/schema.js";
import {
  ALWAYS_REWRITE_ENDPOINT_FAMILIES,
  alwaysRewriteEndpointKeys,
  COMPARE_BEFORE_WRITE,
} from "./apply-idempotence.js";
import {
  changedFamilies,
  missingSecondApplyRewrites,
  recordUnconditionalWrites,
  secondApplyWriteFailures,
  type UnconditionalWriteWitness,
  unwitnessedUnconditionalSections,
} from "./apply-idempotence-proof.js";
import type { LoggedRequest } from "./mock/contract.js";

describe("always-rewrite lockstep (endpoint flag <-> mock state families)", () => {
  test("every alwaysRewrite endpoint declares its mock state family, and nothing else does", () => {
    // The required-rewrite obligation lives on the EndpointDecl (per
    // endpoint); the snapshot exclusion derives from the endpoint-to-family
    // mapping. Pinning the mapping's KEYS against the flags means a new
    // flagged endpoint fails here until it names its state family - even
    // when its section already carries another flagged endpoint.
    expect(alwaysRewriteEndpointKeys()).toEqual(
      Object.keys(ALWAYS_REWRITE_ENDPOINT_FAMILIES).sort(),
    );
    // The mapping itself, pinned literally: the families are mock storage
    // names (state.ts), which nothing can derive - a wrong family here would
    // silently stop stripping updated_at for that store.
    expect(ALWAYS_REWRITE_ENDPOINT_FAMILIES).toEqual({
      "actions_secrets.put": "actions_secrets",
      "dependabot_secrets.put": "dependabot_secrets",
      "codespaces_secrets.put": "codespaces_secrets",
      "agents_secrets.put": "agents_secrets",
      "environments.putSecret": "environment_secrets",
    });
  });
});

describe("secondApplyWriteFailures (apply-idempotence zero-write subset)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });

  test("a write to a compare-before-write section fires the assertion", () => {
    const failures = secondApplyWriteFailures([write("POST", "/repos/e2e-owner/e2e-repo/labels")]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"labels"');
    expect(failures[0]).toContain("compares before writing");
  });

  test("a write to an unconditional-PUT section passes", () => {
    // Rulesets and environments PUT existing resources on every apply, so a
    // second-apply write there is legitimate; only state stability binds them.
    expect(
      secondApplyWriteFailures([
        write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/production"),
      ]),
    ).toEqual([]);
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

  test("every compare-before-write section's own writes are flagged, per offender", () => {
    const failures = secondApplyWriteFailures([
      write("PATCH", "/repos/e2e-owner/e2e-repo/labels/bug"),
      write("POST", "/repos/e2e-owner/e2e-repo/milestones"),
      write("DELETE", "/repos/e2e-owner/e2e-repo/autolinks/1"),
      write("PUT", "/repos/e2e-owner/e2e-repo/collaborators/alice"),
      write("PUT", "/repos/e2e-owner/e2e-repo/actions/workflows/7/enable"),
    ]);
    expect(failures).toHaveLength(5);
  });
});

describe("missingSecondApplyRewrites (apply-idempotence always-rewrite subset)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });
  const secretPut = write("PUT", "/repos/e2e-owner/e2e-repo/actions/secrets/DEPLOY_TOKEN");

  test("a first-apply secret PUT the second apply skipped fires the assertion", () => {
    const failures = missingSecondApplyRewrites([secretPut], []);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("actions/secrets/DEPLOY_TOKEN");
    expect(failures[0]).toContain("re-written on EVERY apply");
  });

  test("a re-issued secret PUT passes; other sections' writes never bind", () => {
    // A rulesets PUT on the first run creates no re-write obligation - only
    // always-rewrite sections do.
    expect(
      missingSecondApplyRewrites(
        [secretPut, write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000")],
        [secretPut],
      ),
    ).toEqual([]);
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
    // The obligation derives from the EndpointDecl alwaysRewrite flag, so a
    // skipped first-apply PUT fires for each family - and crucially, the
    // ENVIRONMENT PUT itself (same section, no flag) creates no obligation.
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

describe("unwitnessedUnconditionalSections (apply-idempotence corpus witness)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });
  /** A witness map with every false-listed section fully covered. */
  const coveredWitness = (): UnconditionalWriteWitness => {
    const witness: UnconditionalWriteWitness = new Map();
    for (const [section, compares] of Object.entries(COMPARE_BEFORE_WRITE)) {
      if (!compares) {
        witness.set(section as SectionKey, { first: 1, second: 1 });
      }
    }
    return witness;
  };

  test("a fully covered corpus produces no failures", () => {
    expect(unwitnessedUnconditionalSections(coveredWitness())).toEqual([]);
  });

  test("an empty corpus flags EVERY false-listed section as unwitnessed", () => {
    const failures = unwitnessedUnconditionalSections(new Map());
    const falseListed = Object.values(COMPARE_BEFORE_WRITE).filter((v) => !v).length;
    expect(failures).toHaveLength(falseListed);
    for (const failure of failures) {
      expect(failure).toContain("NO apply_idempotent scenario");
    }
  });

  test("first-apply writes without any second-apply write name the opposite remedy", () => {
    const witness = coveredWitness();
    witness.set("teams", { first: 2, second: 0 });
    const failures = unwitnessedUnconditionalSections(witness);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"teams"');
    expect(failures[0]).toContain("never re-issued by any second apply");
  });

  test("recordUnconditionalWrites counts only false-listed sections, per side", () => {
    const witness: UnconditionalWriteWitness = new Map();
    recordUnconditionalWrites(
      witness,
      [
        // labels compares before writing, so it never enters the witness;
        // report traffic matches no section endpoint and is skipped too.
        write("POST", "/repos/e2e-owner/e2e-repo/labels"),
        write("POST", "/repos/e2e-owner/svc-private/issues"),
        write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
      ],
      [write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000")],
    );
    expect([...witness.keys()]).toEqual(["rulesets"]);
    expect(witness.get("rulesets")).toEqual({ first: 1, second: 1 });
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
