import { describe, expect, test } from "bun:test";
import { describeOptOut, mergeLayers, type OptOutNotice } from "../../src/engine/layers.js";
import { describeProblem } from "../../src/problem.js";
import { UNDECLARED_POLICY_SECTIONS } from "../../src/schema.js";
import { sectionModule } from "../../src/sections/registry.js";
import { ADMIN_SLUG } from "./constants.js";
import { UNDECLARED_KEY } from "./gen-support.js";
import type { MergeLayer, MultiRepoTarget, MultiScenarioMeta, ScenarioMeta } from "./generators.js";
import {
  type AbortVerdict,
  effectiveGrades,
  foldMergeLayers,
  foldRepoResults,
  foldSectionOutcomes,
  judgePreflightAbort,
  KEYED_MERGE_SECTIONS,
  NO_READ_SECTIONS,
  type PreflightAbort,
  predictDiscovery,
  predictMerge,
  predictMulti,
  predictOutcomes,
  predictSection,
  predictSectionAt,
  preflightDeniable,
  refusedMergeLayer,
  sectionGrade,
} from "./oracle.js";
import type { MaskGrade, MaskKey } from "./schema.js";

describe("NO_READ_SECTIONS derivation", () => {
  test("counts GraphQL reads: only the write-only section remains, exactly as before", () => {
    // The derivation walks sectionOperations (REST + GraphQL); this exact-set
    // pin proves the widened walk left today's membership unchanged - and
    // that a section carrying only a GraphQL read (repository's features
    // query would be that shape without its REST GETs) is not misread as
    // read-free. A new member here is a conscious change, not drift.
    expect([...NO_READ_SECTIONS].sort()).toEqual(["check_suite_preferences"]);
  });
});

/** Build a ScenarioMeta with sensible defaults for one focused assertion. */
function meta(overrides: Partial<ScenarioMeta>): ScenarioMeta {
  return {
    sections: overrides.sections ?? ["labels"],
    mask: overrides.mask ?? {},
    mode: overrides.mode ?? "apply",
    policy: overrides.policy ?? "fail",
    ownerKind: overrides.ownerKind ?? "org",
    denialStyle: overrides.denialStyle ?? "fine_grained",
    requiredSections: overrides.requiredSections ?? [],
    onlySections: overrides.onlySections,
    liveKinds: overrides.liveKinds,
  };
}

describe("sectionGrade", () => {
  const cases: Array<[string, MaskKey, MaskGrade | undefined, MaskGrade]> = [
    ["unspecified resource defaults to write", "issues", undefined, "write"],
    ["explicit none", "issues", "none", "none"],
    ["explicit read", "issues", "read", "read"],
  ];
  for (const [name, key, grade, want] of cases) {
    test(`labels: ${name}`, () => {
      const mask = grade === undefined ? {} : { [key]: grade };
      expect(sectionGrade("labels", mask)).toBe(want);
    });
  }

  test("repository takes the max over its (single) repo resource", () => {
    expect(sectionGrade("repository", { administration: "read" })).toBe("read");
    expect(sectionGrade("repository", { administration: "none" })).toBe("none");
  });

  test("code_scanning is granted when EITHER admin or code_scanning_alerts is", () => {
    // repo resources are OR: the max grade wins.
    expect(sectionGrade("code_scanning_default_setup", { administration: "none" })).toBe("write");
    expect(
      sectionGrade("code_scanning_default_setup", {
        administration: "none",
        code_scanning_alerts: "none",
      }),
    ).toBe("none");
    expect(
      sectionGrade("code_scanning_default_setup", {
        administration: "none",
        code_scanning_alerts: "read",
      }),
    ).toBe("read");
  });

  test("teams: org_members is a read-gate, not a grade cap", () => {
    // org_members none denies the section (the org probe fails); read or write
    // both leave the repo (administration) grade intact - org_members write is
    // NOT required to write teams.
    expect(sectionGrade("teams", { administration: "write", org_members: "none" })).toBe("none");
    expect(sectionGrade("teams", { administration: "write", org_members: "read" })).toBe("write");
    expect(sectionGrade("teams", { administration: "read", org_members: "write" })).toBe("read");
    expect(sectionGrade("teams", { administration: "write", org_members: "write" })).toBe("write");
  });

  test("teams: the org gate reads org_members from orgMask, not the per-slug mask", () => {
    // Multi-repo regression (nightly seed 28401742): the mock grades teams'
    // org-scoped grant endpoint against the GLOBAL mask, so a per-slug
    // org_members:none must NOT gate teams when the global mask grants it. With
    // an empty orgMask (org_members defaults to write) teams stays write-graded
    // even though the per-slug mask says org_members:none.
    expect(sectionGrade("teams", { administration: "write", org_members: "none" }, {})).toBe(
      "write",
    );
    // And the orgMask's org_members:none DOES gate it (single-repo path: orgMask
    // === mask), matching the read-gate rule above.
    expect(sectionGrade("teams", { administration: "write" }, { org_members: "none" })).toBe(
      "none",
    );
  });
});

describe("read gating fold", () => {
  test("effectiveGrades folds only a read grant, and only through gated reads", () => {
    expect(effectiveGrades("write", "write-gated")).toEqual(["write"]);
    expect(effectiveGrades("none", "mixed")).toEqual(["none"]);
    expect(effectiveGrades("read", "plain")).toEqual(["read"]);
    expect(effectiveGrades("read", "write-gated")).toEqual(["none"]);
    expect(effectiveGrades("read", "mixed")).toEqual(["read", "none"]);
  });

  test("codespaces_secrets under a read-only grant runs at none: denied at the first read", () => {
    // Both GETs are gated, so a read grant reads nothing (the curated scenario pins it).
    const readOnly = meta({
      sections: ["codespaces_secrets"],
      mask: { codespaces_secrets: "read" },
      mode: "check",
      policy: "fail",
    });
    const p = predictSection("codespaces_secrets", readOnly);
    expect(p.grades).toEqual(["none"]);
    expect([...p.allowed]).toEqual(["failed"]);
    const apply = predictOutcomes({ ...readOnly, mode: "apply" });
    expect(apply.preflightAborts).toBe("yes");
    expect(apply.fullyGranted).toBe(false);
    expect(apply.writeDeniedSections).toEqual(["codespaces_secrets"]);
  });

  test("a mixed-gating section under a read-only grant unions the read and denied arms", () => {
    // Reaching the gated read depends on content the oracle never models, and the
    // denied read's own 404 posture may be either, so both arms' outcomes are allowed.
    const readOnly = meta({ mask: { issues: "read" }, mode: "check", policy: "fail" });
    const check = predictSectionAt("labels", readOnly, "mixed");
    expect(check.grades).toEqual(["read", "none"]);
    expect([...check.allowed].sort()).toEqual(["clean", "drift", "failed"]);
    const warn = predictSectionAt("labels", { ...readOnly, policy: "warn" }, "mixed");
    expect([...warn.allowed].sort()).toEqual(["clean", "drift", "skipped"]);
    // The same section declared plain stays the exact read prediction.
    expect([...predictSectionAt("labels", readOnly, "plain").allowed].sort()).toEqual([
      "clean",
      "drift",
    ]);
  });

  test("a mixed-gating section with NO grant is denied at its primary read like any other", () => {
    // With no grant the primary read is denied first, under the section's own posture.
    const noGrant = meta({ mask: { issues: "none" }, mode: "check", policy: "fail" });
    const mixed = predictSectionAt("labels", noGrant, "mixed");
    expect(mixed.grades).toEqual(["none"]);
    expect(mixed).toEqual(predictSectionAt("labels", noGrant, "plain"));
    const apply = predictSectionAt("labels", { ...noGrant, mode: "apply" }, "mixed");
    expect([...apply.allowed]).toEqual(["failed"]);
    expect(apply.mayWrite).toBe(false);
  });

  test("the preflight barrier is certain for a write-gated section and only possible for a mixed one", () => {
    const applyFail = meta({ mask: { issues: "read" }, mode: "apply", policy: "fail" });
    expect(preflightDeniable(predictSectionAt("labels", applyFail, "plain"), applyFail)).toBe("no");
    expect(preflightDeniable(predictSectionAt("labels", applyFail, "write-gated"), applyFail)).toBe(
      "yes",
    );
    expect(preflightDeniable(predictSectionAt("labels", applyFail, "mixed"), applyFail)).toBe(
      "possible",
    );
    // A mixed section may still land applied (gated read never reached, no write needed).
    const mixed = predictSectionAt("labels", applyFail, "mixed");
    expect([...mixed.allowed].sort()).toEqual(["applied", "failed"]);
  });
});

describe("judgePreflightAbort", () => {
  const head = "## github-settings-as-code (apply)\n\n| Section | Status | Detail |\n|---|---|---|";
  const rows = `${head}\n| labels | :x: failed | - |`;
  const barrier = "::error::preflight failed: the token cannot access 1 section(s)";
  const other = "::error::settings.yml: unknown section";
  // A barrier abort renders the headed summary (note, header, separator) and no body rows.
  const aborted = {
    summary: `## github-settings-as-code (apply)\n\n:x: failed - preflight denied 1 section(s)\n\n| Section | Status | Detail |\n|---|---|---|`,
    result: "failed",
    stdout: barrier,
  };
  const ran = { summary: rows, result: "applied", stdout: other };
  const cases: Array<
    [string, PreflightAbort, Parameters<typeof judgePreflightAbort>[1], AbortVerdict["kind"]]
  > = [
    ["no: a run without the barrier annotation ran", "no", ran, "ran"],
    ["no: but the barrier fired", "no", aborted, "contradiction"],
    ["yes with every witness aborted", "yes", aborted, "aborted"],
    ["yes but the run never annotated the barrier", "yes", ran, "contradiction"],
    ["yes but another error failed the run", "yes", { ...aborted, stdout: other }, "contradiction"],
    ["possible without the annotation ran", "possible", ran, "ran"],
    ["possible with every witness aborted", "possible", aborted, "aborted"],
    [
      "possible, no rows and failed, but no barrier annotation: ran, so the section checks report the absences",
      "possible",
      { ...aborted, stdout: other },
      "ran",
    ],
    [
      "possible with an unparsable summary and no annotation still ran",
      "possible",
      { ...ran, summary: "garbage" },
      "ran",
    ],
    ["annotated but sections rendered", "possible", { ...aborted, summary: rows }, "contradiction"],
    [
      "annotated but a malformed row rendered: still a rendered row, not an abort",
      "possible",
      { ...aborted, summary: `${head}\n| labels | failed |` },
      "contradiction",
    ],
    [
      "annotated with the multi-repo overview rendered: its rows count too",
      "possible",
      {
        ...aborted,
        summary: "| Repository | Source | Result |\n|---|---|---|\n| o/r | remote | :x: failed |",
      },
      "contradiction",
    ],
    [
      "annotated but the result is not failed",
      "yes",
      { ...aborted, result: "applied" },
      "contradiction",
    ],
    [
      "annotated but no result at all",
      "possible",
      { ...aborted, result: undefined },
      "contradiction",
    ],
    [
      "the phrase in a plain log line is not the annotation",
      "yes",
      { ...aborted, stdout: "preflight failed: retrying" },
      "contradiction",
    ],
  ];
  test.each(cases)("%s", (_name, predicted, observed, kind) => {
    expect(judgePreflightAbort(predicted, observed).kind).toBe(kind);
  });
});

describe("predictSection rules", () => {
  test("write granted: check => {clean, drift}", () => {
    const p = predictSection("labels", meta({ mode: "check", mask: { issues: "write" } }));
    expect([...p.allowed].sort()).toEqual(["clean", "drift"]);
  });

  test("write granted: apply => {applied}", () => {
    const p = predictSection("labels", meta({ mode: "apply", mask: { issues: "write" } }));
    expect([...p.allowed]).toEqual(["applied"]);
    expect(p.mayWrite).toBe(true);
  });

  test("none + 403 style: skipped under warn, failed under fail", () => {
    const denied = { mask: { issues: "none" as MaskGrade }, denialStyle: 403 as const };
    expect([
      ...predictSection("labels", meta({ ...denied, mode: "apply", policy: "warn" })).allowed,
    ]).toEqual(["skipped"]);
    expect([
      ...predictSection("labels", meta({ ...denied, mode: "apply", policy: "fail" })).allowed,
    ]).toEqual(["failed"]);
  });

  test("none + fine_grained on a denied-semantics section behaves like 403", () => {
    // labels is "denied" semantics, so a fine_grained 404 read classifies as denial.
    const p = predictSection(
      "labels",
      meta({
        mask: { issues: "none" },
        denialStyle: "fine_grained",
        mode: "apply",
        policy: "warn",
      }),
    );
    expect([...p.allowed]).toEqual(["skipped"]);
  });

  test("none + fine_grained on an absent-semantics section: check => {clean, drift}", () => {
    // pages is "absent" semantics: the 404 read looks like a missing resource.
    const p = predictSection(
      "pages",
      meta({
        sections: ["pages"],
        mask: { pages: "none" },
        denialStyle: "fine_grained",
        mode: "check",
      }),
    );
    expect([...p.allowed].sort()).toEqual(["clean", "drift"]);
  });

  test("none + fine_grained absent-semantics apply: {applied, failed} fail, {applied, skipped} warn", () => {
    const base = {
      sections: ["pages"] as ScenarioMeta["sections"],
      mask: { pages: "none" as MaskGrade },
      denialStyle: "fine_grained" as const,
      mode: "apply" as const,
    };
    expect([...predictSection("pages", meta({ ...base, policy: "fail" })).allowed].sort()).toEqual([
      "applied",
      "failed",
    ]);
    expect([...predictSection("pages", meta({ ...base, policy: "warn" })).allowed].sort()).toEqual([
      "applied",
      "skipped",
    ]);
  });

  test("read grade apply: {applied, failed} fail, {applied, skipped} warn", () => {
    const base = { mask: { issues: "read" as MaskGrade }, mode: "apply" as const };
    expect([...predictSection("labels", meta({ ...base, policy: "fail" })).allowed].sort()).toEqual(
      ["applied", "failed"],
    );
    expect([...predictSection("labels", meta({ ...base, policy: "warn" })).allowed].sort()).toEqual(
      ["applied", "skipped"],
    );
  });

  test("a no-read section is exactly clean in check mode, whatever the mask", () => {
    // check_suite_preferences declares no read endpoint, so check mode makes
    // ZERO requests: even a full 403-style denial has nothing to deny.
    for (const grade of ["none", "read", "write"] as const) {
      const p = predictSection(
        "check_suite_preferences",
        meta({
          sections: ["check_suite_preferences"],
          mask: { checks: grade },
          denialStyle: 403,
          mode: "check",
          policy: "fail",
        }),
      );
      expect([...p.allowed]).toEqual(["clean"]);
      expect(p.mayWrite).toBe(false);
    }
  });

  test("a no-read section never arms the preflight barrier", () => {
    // Preflight probes reads only; with no reads the run proceeds and the
    // denial surfaces mid-apply, so the summary is still rendered.
    const p = predictOutcomes(
      meta({
        sections: ["check_suite_preferences"],
        mask: { checks: "none" },
        denialStyle: 403,
        mode: "apply",
        policy: "fail",
      }),
    );
    expect(p.preflightAborts).toBe("no");
  });

  test("a denied no-read section can never land applied: its write is unconditional", () => {
    // Every apply issues the PATCH, so with the write grant missing there is
    // no "nothing to write" path - {failed} under fail, {skipped} under warn.
    for (const grade of ["none", "read"] as const) {
      const base = {
        sections: ["check_suite_preferences"] as ScenarioMeta["sections"],
        mask: { checks: grade as MaskGrade },
        mode: "apply" as const,
      };
      expect([
        ...predictSection("check_suite_preferences", meta({ ...base, policy: "fail" })).allowed,
      ]).toEqual(["failed"]);
      expect([
        ...predictSection("check_suite_preferences", meta({ ...base, policy: "warn" })).allowed,
      ]).toEqual(["skipped"]);
    }
  });

  test("a required denied section fails even under warn (apply)", () => {
    const p = predictSection(
      "labels",
      meta({
        mask: { issues: "read" },
        mode: "apply",
        policy: "warn",
        requiredSections: ["labels"],
      }),
    );
    expect([...p.allowed].sort()).toEqual(["applied", "failed"]);
  });

  test("a matching witness pins check to exactly clean and apply to exactly applied", () => {
    const check = predictSection(
      "labels",
      meta({ mode: "check", liveKinds: { labels: "matching" } }),
    );
    expect([...check.allowed]).toEqual(["clean"]);
    const apply = predictSection(
      "labels",
      meta({ mode: "apply", liveKinds: { labels: "matching" } }),
    );
    expect([...apply.allowed]).toEqual(["applied"]);
    // No write is attempted against a matching live state.
    expect(apply.mayWrite).toBe(false);
  });

  test("a drift witness pins check to exactly drift (a clean is a false negative)", () => {
    for (const kind of ["drift-update", "extra-undeclared"] as const) {
      const p = predictSection("labels", meta({ mode: "check", liveKinds: { labels: kind } }));
      expect([...p.allowed]).toEqual(["drift"]);
    }
  });

  test("permission folding beats the witness: a denied section stays skipped", () => {
    // labels is denied outright (issues none + 403 style); the matching witness
    // must NOT tighten the outcome to clean - the section never ran.
    const p = predictSection(
      "labels",
      meta({
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "check",
        policy: "warn",
        liveKinds: { labels: "matching" },
      }),
    );
    expect([...p.allowed]).toEqual(["skipped"]);
  });

  test("read grade + drift witness in apply: the forced write is denied", () => {
    // The witness guarantees a write is needed, so the loose {applied, ...}
    // tightens: the section can never be a no-op applied.
    const base = {
      mask: { issues: "read" as MaskGrade },
      mode: "apply" as const,
      liveKinds: { labels: "drift-update" as const },
    };
    expect([...predictSection("labels", meta({ ...base, policy: "warn" })).allowed]).toEqual([
      "skipped",
    ]);
    expect([...predictSection("labels", meta({ ...base, policy: "fail" })).allowed]).toEqual([
      "failed",
    ]);
  });

  test("read grade + matching witness in apply: applied despite the missing write grant", () => {
    const p = predictSection(
      "labels",
      meta({ mask: { issues: "read" }, mode: "apply", liveKinds: { labels: "matching" } }),
    );
    expect([...p.allowed]).toEqual(["applied"]);
    expect(p.mayWrite).toBe(false);
  });

  test("exclusion folds before grades and witnesses: the section predicts at NO grade", () => {
    // A declared section outside the `sections` allowlist never runs: the
    // engine reports it "excluded" before any read, so neither the denied
    // grade nor the seeded witness may tighten the prediction, and the grades
    // are empty - the section runs at no grade, so preflight and the
    // write-granted fold are vacuous over it without recognizing "excluded".
    const p = predictSection(
      "labels",
      meta({
        sections: ["labels", "pages"],
        onlySections: ["pages"],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "check",
        liveKinds: { labels: "drift-update" },
      }),
    );
    expect(p).toEqual({
      key: "labels",
      grades: [],
      allowed: new Set(["excluded"]),
      mayWrite: false,
    });
    // An undefined allowlist keeps today's behavior: every section runs, and
    // the denied grade with its 403 style reads as a check-mode failure.
    const unrestricted = predictSection(
      "labels",
      meta({ mask: { issues: "none" }, denialStyle: 403, mode: "check" }),
    );
    expect(unrestricted).toEqual({
      key: "labels",
      grades: ["none"],
      allowed: new Set(["failed"]),
      mayWrite: false,
    });
  });

  test("an excluded NO_READ section in check mode is excluded, not the read-free clean", () => {
    // check_suite_preferences makes no request in check mode and is otherwise
    // exactly clean; exclusion folds before that rule too, and the read-free
    // preflight exemption does not need to see the section since it has no grade.
    const p = predictSection(
      "check_suite_preferences",
      meta({
        sections: ["check_suite_preferences", "labels"],
        onlySections: ["labels"],
        mask: { checks: "none" },
        mode: "check",
      }),
    );
    expect(p).toEqual({
      key: "check_suite_preferences",
      grades: [],
      allowed: new Set(["excluded"]),
      mayWrite: false,
    });
  });

  test("an excluded denied section beside an active one: the run follows the active one alone", () => {
    // apply + fail + 403 with the excluded section's read denied: preflight
    // probes only the active section, so the barrier never arms, the excluded
    // section is not write-denied (it writes nothing), and the fixpoint gate
    // (fullyGranted) quantifies over the section that WILL run.
    const excludedDenied = meta({
      sections: ["labels", "pages"],
      onlySections: ["pages"],
      mask: { issues: "none" },
      denialStyle: 403,
      mode: "apply",
      policy: "fail",
    });
    expect(predictOutcomes(excludedDenied)).toEqual({
      sections: [
        { key: "labels", grades: [], allowed: new Set(["excluded"]), mayWrite: false },
        { key: "pages", grades: ["write"], allowed: new Set(["applied"]), mayWrite: true },
      ],
      allowedExitCodes: new Set([0]),
      noWritesInCheck: false,
      writeDeniedSections: [],
      fullyGranted: true,
      preflightAborts: "no",
    });

    // The control: the same meta with labels ACTIVE reaches the denied read,
    // and the barrier aborts the run.
    expect(predictOutcomes({ ...excludedDenied, onlySections: undefined })).toEqual({
      sections: [
        { key: "labels", grades: ["none"], allowed: new Set(["failed"]), mayWrite: false },
        { key: "pages", grades: ["write"], allowed: new Set(["applied"]), mayWrite: true },
      ],
      allowedExitCodes: new Set([1]),
      noWritesInCheck: false,
      writeDeniedSections: ["labels"],
      fullyGranted: false,
      preflightAborts: "yes",
    });
  });

  test("an EMPTY allowlist is unrestricted, mirroring the engine's size > 0 gate", () => {
    // inputs.ts builds onlySections from a comma-split with filter(Boolean),
    // and orchestrate.ts only excludes when the set is non-empty - so `[]`
    // must predict exactly like an undefined allowlist: the denied section
    // stays active and arms the preflight barrier.
    const p = predictOutcomes(
      meta({
        sections: ["labels"],
        onlySections: [],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "apply",
        policy: "fail",
      }),
    );
    expect(p.preflightAborts).toBe("yes");
  });

  test("teams + owner_kind user no-ops: applied in apply, clean in check, at grade write", () => {
    // The handler stops at its ungated org probe, so the mask's administration
    // "none" is never reached: the section runs write-granted with nothing to
    // write, and its grades must not carry the denial the run never met.
    const applyP = predictSection(
      "teams",
      meta({
        sections: ["teams"],
        ownerKind: "user",
        mask: { administration: "none" },
        mode: "apply",
      }),
    );
    expect(applyP).toEqual({
      key: "teams",
      grades: ["write"],
      allowed: new Set(["applied"]),
      mayWrite: false,
    });

    const checkP = predictSection(
      "teams",
      meta({
        sections: ["teams"],
        ownerKind: "user",
        mask: { administration: "none" },
        mode: "check",
      }),
    );
    expect(checkP).toEqual({
      key: "teams",
      grades: ["write"],
      allowed: new Set(["clean"]),
      mayWrite: false,
    });
  });

  test("exclusion folds before the personal-account no-op", () => {
    // Both folds precede the grades; an excluded org-only section on a user
    // owner is excluded, not applied, and like every other excluded section
    // runs at no grade - neither the mask's denial nor the no-op's write grade.
    const p = predictSection(
      "teams",
      meta({
        sections: ["teams", "labels"],
        onlySections: ["labels"],
        ownerKind: "user",
        mask: { org_members: "none" },
        mode: "apply",
      }),
    );
    expect(p).toEqual({
      key: "teams",
      grades: [],
      allowed: new Set(["excluded"]),
      mayWrite: false,
    });
  });
});

describe("predictOutcomes run level", () => {
  test("teams on a personal account never arms the preflight barrier, whatever org_members says", () => {
    // Seed 3388244810 of the fuzz stream: apply + fail + 403 with org_members
    // denied, on a personal account. The action's teams handler stops at the
    // ungated org probe, so preflight meets no denial and the run proceeds.
    const personal = meta({
      sections: ["teams", "labels"],
      mode: "apply",
      policy: "fail",
      denialStyle: 403,
      ownerKind: "user",
      mask: { org_members: "none" },
    });
    expect(predictOutcomes(personal)).toEqual({
      sections: [
        { key: "teams", grades: ["write"], allowed: new Set(["applied"]), mayWrite: false },
        { key: "labels", grades: ["write"], allowed: new Set(["applied"]), mayWrite: true },
      ],
      allowedExitCodes: new Set([0]),
      noWritesInCheck: false,
      writeDeniedSections: [],
      fullyGranted: true,
      preflightAborts: "no",
    });

    // The control: under an organization owner the same token reaches the
    // org_members-gated team probe, and the barrier aborts the run.
    expect(predictOutcomes({ ...personal, ownerKind: "org" })).toEqual({
      sections: [
        { key: "teams", grades: ["none"], allowed: new Set(["failed"]), mayWrite: false },
        { key: "labels", grades: ["write"], allowed: new Set(["applied"]), mayWrite: true },
      ],
      allowedExitCodes: new Set([1]),
      noWritesInCheck: false,
      writeDeniedSections: ["teams"],
      fullyGranted: false,
      preflightAborts: "yes",
    });
  });
  test("fully granted apply predicts exit 0 and flags convergence", () => {
    const p = predictOutcomes(meta({ sections: ["labels", "pages"], mode: "apply", mask: {} }));
    expect(p.allowedExitCodes.has(0)).toBe(true);
    expect(p.fullyGranted).toBe(true);
    expect(p.noWritesInCheck).toBe(false);
  });

  test("check mode never writes", () => {
    const p = predictOutcomes(meta({ mode: "check", mask: {} }));
    expect(p.noWritesInCheck).toBe(true);
  });

  test("a denied required section under apply+fail forces exit 1", () => {
    const p = predictOutcomes(
      meta({
        sections: ["labels"],
        mask: { issues: "none" },
        denialStyle: 403,
        mode: "apply",
        policy: "fail",
        requiredSections: ["labels"],
      }),
    );
    expect([...p.allowedExitCodes]).toEqual([1]);
  });

  test("check mode with a write-granted section may exit 0 or 1 (clean vs drift)", () => {
    const p = predictOutcomes(meta({ mode: "check", mask: { issues: "write" } }));
    expect([...p.allowedExitCodes].sort()).toEqual([0, 1]);
  });

  test("apply + fail + a permission-denied section aborts at preflight", () => {
    // The barrier only runs under apply + fail; a denied section makes it abort
    // before rendering any section, so preflightAborts is set.
    const p = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "none" }, mode: "apply", policy: "fail" }),
    );
    expect(p.preflightAborts).toBe("yes");
  });

  test("preflightAborts is no under warn, under check, and when fully granted", () => {
    const warn = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "none" }, mode: "apply", policy: "warn" }),
    );
    expect(warn.preflightAborts).toBe("no");
    const check = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "none" }, mode: "check", policy: "fail" }),
    );
    expect(check.preflightAborts).toBe("no");
    const granted = predictOutcomes(
      meta({ sections: ["labels"], mask: {}, mode: "apply", policy: "fail" }),
    );
    expect(granted.preflightAborts).toBe("no");
  });

  test("a read grant on plain reads never aborts preflight: preflight is reads-only", () => {
    // Preflight plans every section over its read-only port, so a read-graded section passes it;
    // the write denial surfaces during apply, after the summary rows exist.
    const p = predictOutcomes(
      meta({ sections: ["labels"], mask: { issues: "read" }, mode: "apply", policy: "fail" }),
    );
    expect(p.preflightAborts).toBe("no");
  });

  test("a fine_grained absent-tolerant denial does not abort preflight", () => {
    // branches is "absent" semantics: a fine_grained 404 reads as resource
    // absent, not a permission denial, so the barrier does not fire.
    const p = predictOutcomes(
      meta({
        sections: ["branches"],
        mask: { administration: "none", contents: "none" },
        denialStyle: "fine_grained",
        mode: "apply",
        policy: "fail",
      }),
    );
    expect(p.preflightAborts).toBe("no");
  });
});

describe("predictMulti rollup", () => {
  // Explicit target builders: the tests state the target kind directly instead
  // of inferring "missing" from a null, matching the discriminated union.
  const normal = (m: ScenarioMeta): MultiRepoTarget => ({ kind: "normal", meta: m });
  const missing = (): MultiRepoTarget => ({ kind: "missing" });
  function multiMeta(targets: MultiRepoTarget[]): MultiScenarioMeta {
    return {
      repos: targets.map((target, i) => ({
        slug: `e2e-owner/repo-${i}`,
        target,
        visibility: "public" as const,
        probeDenied: false,
        redaction: { kind: "shown" as const },
      })),
      mode: "apply",
      policy: "fail",
      privateRepos: "show",
      privateReport: "none",
      selfSlug: ADMIN_SLUG,
      globalMask: {},
    };
  }

  test("a missing-settings target is skipped (null run)", () => {
    const p = predictMulti(multiMeta([missing()]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["skipped"]);
  });

  test("a raw-settings target predicts exactly failed and raises exit 1", () => {
    // Both raw kinds fail before any section runs: unparseable at the parse
    // gate, non-mapping at the top-level validator. Never skipped.
    for (const raw of ["unparseable", "non-mapping"] as const) {
      const base = multiMeta([missing(), normal(meta({ mode: "apply", mask: {} }))]);
      const rawRepo = base.repos[0];
      if (rawRepo === undefined) {
        throw new Error("multiMeta built no repos");
      }
      rawRepo.target = { kind: "raw-invalid", raw };
      const p = predictMulti(base);
      expect(p.repos[0]?.run).toBeNull();
      expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
      expect(p.allowedExitCodes.has(1)).toBe(true);
    }
  });

  test("a fatal contentsGet fault fails the FIRST target whatever its kind", () => {
    // The fault hook precedes both the missing-file 404 and the permission
    // gate, and the whole budget (1 + MAX_RETRIES) burns on the first target's
    // fetch - so even a missing-settings victim flips from skipped to failed,
    // a raw-invalid one fails at the transport gate instead of its parse gate,
    // and later targets keep their normal predictions.
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const victims: MultiRepoTarget[] = [
      missing(),
      normal(granted),
      { kind: "raw-invalid", raw: "unparseable" },
    ];
    for (const victim of victims) {
      const base = multiMeta([victim, normal(granted)]);
      base.coreFault = { key: "core.contentsGet", fatal: true };
      const p = predictMulti(base);
      expect(p.repos[0]?.run).toBeNull();
      expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
      expect([...(p.repos[1]?.allowedResults ?? [])]).toEqual(["applied"]);
      expect(p.allowedExitCodes.has(1)).toBe(true);
    }
  });

  test("a non-fatal contentsGet fault changes no prediction", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const base = multiMeta([missing(), normal(granted)]);
    base.coreFault = { key: "core.contentsGet", fatal: false };
    const p = predictMulti(base);
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["skipped"]);
    expect([...(p.repos[1]?.allowedResults ?? [])]).toEqual(["applied"]);
    expect([...p.allowedExitCodes]).toEqual([0]);
  });

  test("repo result is the mechanical worst-of fold, not a loose union", () => {
    // A fully-granted apply target: every section is "applied", so the ONLY
    // reachable repo result is "applied" - a union over section outcomes would
    // also be {applied}, but the fold proves no stray clean/partial leaks in.
    const granted = meta({ sections: ["labels", "pages"], mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted)]));
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["applied"]);
  });

  test("apply target mixing an applied and a skipped section rolls up to partial", () => {
    // labels write-granted (applied), collaborators denied under warn (skipped):
    // the fold yields "partial", never a bare {applied, skipped} union.
    const mixed = meta({
      sections: ["labels", "collaborators"],
      mask: { administration: "none" },
      denialStyle: 403,
      mode: "apply",
      policy: "warn",
    });
    const p = predictMulti({
      repos: [
        {
          slug: "e2e-owner/repo-0",
          target: { kind: "normal", meta: mixed },
          visibility: "public",
          probeDenied: false,
          redaction: { kind: "shown" },
        },
      ],
      mode: "apply",
      policy: "warn",
      privateRepos: "show",
      privateReport: "none",
      selfSlug: ADMIN_SLUG,
      globalMask: {},
    });
    expect(p.repos[0]?.allowedResults.has("partial")).toBe(true);
    expect(p.repos[0]?.allowedResults.has("skipped")).toBe(false);
  });

  test("contents:none under fine_grained fails the target even with administration granted", () => {
    // The settings file is read through the contents endpoint before any
    // section runs; a denied contents read 404s (fine_grained), the repo probe
    // succeeds, and the default branch's ref read - the Contents-gated proof
    // of a missing file - is denied too, so the target FAILS instead of
    // reading as fileless. Mirrors repo-file.ts.
    const gated = meta({
      sections: ["labels", "collaborators"],
      mask: { contents: "none" },
      denialStyle: "fine_grained",
    });
    const p = predictMulti(multiMeta([normal(gated)]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
    expect([...p.allowedExitCodes]).toEqual([1]);
  });

  test("contents:none AND administration:none under fine_grained fails the target", () => {
    // With administration also denied, the repo probe ALSO 404s, so the read
    // is "visible but unreadable" and the target FAILS before any ref read.
    const gated = meta({
      sections: ["labels"],
      mask: { contents: "none", administration: "none" },
      denialStyle: "fine_grained",
    });
    const p = predictMulti(multiMeta([normal(gated)]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("contents:none under the 403 style fails the target and raises exit 1", () => {
    const gated = meta({
      sections: ["labels"],
      mask: { contents: "none" },
      denialStyle: 403,
    });
    const p = predictMulti(multiMeta([normal(gated)]));
    expect(p.repos[0]?.run).toBeNull();
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["failed"]);
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("contents:read lets the settings read through to per-section prediction", () => {
    // A non-none contents grade does not gate the target: it gets a real run.
    const readable = meta({ sections: ["labels"], mask: { contents: "read" } });
    const p = predictMulti(multiMeta([normal(readable)]));
    expect(p.repos[0]?.run).toEqual(predictOutcomes(readable));
    expect(p.allowedExitCodes).toEqual(predictOutcomes(readable).allowedExitCodes);
  });

  test("all granted targets => exit 0 only", () => {
    const granted = meta({ mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted), normal(granted)]));
    expect([...p.allowedExitCodes]).toEqual([0]);
  });

  test("one target that can fail raises the multi exit to include 1", () => {
    const granted = meta({ mode: "apply", mask: {} });
    const denied = meta({
      sections: ["labels"],
      mask: { issues: "none" },
      denialStyle: 403,
      mode: "apply",
      policy: "fail",
      requiredSections: ["labels"],
    });
    const p = predictMulti(multiMeta([normal(granted), normal(denied)]));
    expect(p.allowedExitCodes.has(1)).toBe(true);
  });

  test("a redacted target keys its result by the placeholder, not the slug", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const p = predictMulti({
      repos: [
        {
          slug: "e2e-owner/repo-0",
          target: { kind: "normal", meta: granted },
          visibility: "private",
          probeDenied: false,
          redaction: {
            kind: "redacted",
            placeholder: "private repository #1",
            canaries: ["CANARY-1-0-name"],
          },
        },
      ],
      mode: "apply",
      policy: "fail",
      privateRepos: "redact",
      privateReport: "none",
      selfSlug: ADMIN_SLUG,
      globalMask: {},
    });
    // The result prediction keys on the placeholder; the real slug never appears.
    expect(p.repos[0]?.displayKey).toBe("private repository #1");
    expect(p.repos[0]?.redacted).toBe(true);
    // The forbidden set folds the redacted target's real slug plus its canaries.
    expect(p.forbidden).toContain("e2e-owner/repo-0");
    expect(p.forbidden).toContain("CANARY-1-0-name");
  });

  test("under show nothing is redacted, so the forbidden set is empty", () => {
    const granted = meta({ sections: ["labels"], mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted)]));
    expect(p.forbidden).toEqual([]);
    expect(p.repos[0]?.displayKey).toBe("e2e-owner/repo-0");
  });
});

describe("predictDiscovery filter rules", () => {
  const pool = [
    { slug: "e2e-owner/pub", visibility: "public" },
    { slug: "e2e-owner/priv", visibility: "private" },
    { slug: "e2e-owner/intern", visibility: "internal" },
    { slug: "e2e-owner/arch", visibility: "public", archived: true },
    { slug: "e2e-owner/fork", visibility: "public", fork: true },
    { slug: "e2e-owner/tagged", visibility: "public", topics: ["infra"] },
  ];

  test("no filters keeps everything except archived (default skip)", () => {
    const kept = predictDiscovery(pool, {});
    expect(kept).not.toContain("e2e-owner/arch");
    expect(kept).toContain("e2e-owner/pub");
    expect(kept).toContain("e2e-owner/fork");
  });

  test("visibility public keeps only public", () => {
    const kept = predictDiscovery(pool, { visibility: "public", archived: "include" });
    expect(kept).not.toContain("e2e-owner/priv");
    expect(kept).not.toContain("e2e-owner/intern");
  });

  test("visibility private keeps only private (drops internal and public)", () => {
    const kept = predictDiscovery(pool, { visibility: "private", archived: "include" });
    expect(kept).toEqual(["e2e-owner/priv"]);
  });

  test("forks exclude drops forks; only keeps only forks", () => {
    expect(predictDiscovery(pool, { forks: "exclude", archived: "include" })).not.toContain(
      "e2e-owner/fork",
    );
    expect(predictDiscovery(pool, { forks: "only", archived: "include" })).toEqual([
      "e2e-owner/fork",
    ]);
  });

  test("topics keeps only repos with a matching topic", () => {
    expect(predictDiscovery(pool, { topics: "infra", archived: "include" })).toEqual([
      "e2e-owner/tagged",
    ]);
  });

  test("exclude patterns drop matching slugs", () => {
    const kept = predictDiscovery(pool, { exclude: "pub", archived: "include" });
    expect(kept).not.toContain("e2e-owner/pub");
  });

  test("exclude globs: wildcards, name-vs-slug, backtracking, case-insensitivity", () => {
    const globPool = [
      { slug: "e2e-owner/svc-a" },
      { slug: "e2e-owner/svc-b" },
      { slug: "e2e-owner/legacy-x" },
      { slug: "e2e-owner/UPPER" },
    ];
    // A trailing-star name glob keeps only non-svc repos.
    expect(predictDiscovery(globPool, { exclude: "svc-*" })).toEqual([
      "e2e-owner/legacy-x",
      "e2e-owner/UPPER",
    ]);
    // A slash-bearing pattern matches the full slug.
    expect(predictDiscovery(globPool, { exclude: "e2e-owner/legacy-*" })).not.toContain(
      "e2e-owner/legacy-x",
    );
    // Middle-wildcard backtracking: "*-*" matches svc-a, svc-b, legacy-x.
    expect(predictDiscovery(globPool, { exclude: "*-*" })).toEqual(["e2e-owner/UPPER"]);
    // Case-insensitive: "upper" excludes "UPPER".
    expect(predictDiscovery(globPool, { exclude: "upper" })).not.toContain("e2e-owner/UPPER");
  });
});

describe("result folds (self-consistency mirrors)", () => {
  test("foldSectionOutcomes mirrors the engine's section rollup", () => {
    expect(foldSectionOutcomes(["applied", "applied"], false)).toBe("applied");
    expect(foldSectionOutcomes(["applied", "skipped"], false)).toBe("partial");
    expect(foldSectionOutcomes(["clean", "drift"], true)).toBe("drift");
    expect(foldSectionOutcomes(["clean", "skipped"], true)).toBe("partial");
    // excluded sets no flag, matching orchestrate's fold.
    expect(foldSectionOutcomes(["clean", "excluded"], true)).toBe("clean");
    expect(foldSectionOutcomes(["applied", "failed", "drift"], false)).toBe("failed");
  });

  test("foldRepoResults mirrors worstOf's REPO_RESULTS order", () => {
    expect(foldRepoResults(["applied", "skipped", "partial"], false)).toBe("partial");
    expect(foldRepoResults(["clean", "drift"], true)).toBe("drift");
    expect(foldRepoResults(["skipped", "failed"], false)).toBe("failed");
    expect(foldRepoResults(["applied"], false)).toBe("applied");
    // Adjacent-rank pairs, pinning the full precedence one step at a time.
    expect(foldRepoResults(["failed", "drift"], true)).toBe("failed");
    expect(foldRepoResults(["drift", "partial"], true)).toBe("drift");
    expect(foldRepoResults(["partial", "skipped"], false)).toBe("partial");
    expect(foldRepoResults(["skipped", "applied"], false)).toBe("skipped");
    expect(foldRepoResults(["applied", "clean"], false)).toBe("applied");
    // worstOf's empty-list defaults.
    expect(foldRepoResults([], true)).toBe("clean");
    expect(foldRepoResults([], false)).toBe("applied");
  });
});

/** A layer stack for the merge fold tests: docs low to high, named the way the runner names them. */
function stack(...docs: Record<string, unknown>[]): MergeLayer[] {
  return docs.map((doc, i) => ({
    name: i === docs.length - 1 ? "settings.yml" : `layer-${i}.yml`,
    doc,
  }));
}

/** The notices the ENGINE's fold reports for a stack, to pin the oracle's paths against. */
function engineNotices(layers: readonly MergeLayer[]): OptOutNotice[] {
  return mergeLayers(layers, { layering: "merge" }).match(
    (folded) => folded.notices,
    (problem) => {
      throw new Error(`the engine refused a stack the oracle folded: ${describeProblem(problem)}`);
    },
  );
}

describe("foldMergeLayers (the oracle's own dialect)", () => {
  test("a null removes a lower declaration with a notice, and stays when nothing below declares the key", () => {
    const { merged, notices } = foldMergeLayers(
      stack(
        { pages: { build_type: "workflow" }, repository: { description: "x", homepage: "h" } },
        { pages: null, repository: { homepage: null }, interaction_limits: null },
      ),
      "merge",
    );
    expect(merged).toEqual({ repository: { description: "x" }, interaction_limits: null });
    expect(notices.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { layer: "settings.yml", path: "pages" },
      { layer: "settings.yml", path: "repository.homepage" },
    ]);
  });

  test("a lower null is not a declaration: nulling it again earns no notice, declaring over it replaces", () => {
    const twice = foldMergeLayers(stack({ pages: null }, { pages: null }), "merge");
    expect(twice.merged).toEqual({ pages: null });
    expect(twice.notices).toEqual([]);
    const over = foldMergeLayers(
      stack({ pages: null }, { pages: { build_type: "legacy" } }),
      "merge",
    );
    expect(over.merged).toEqual({ pages: { build_type: "legacy" } });
  });

  test("mappings merge key by key at any depth; lists and scalars replace", () => {
    const { merged } = foldMergeLayers(
      stack(
        {
          repository: { description: "low", topics: ["a", "b"], has_issues: true },
          branches: [{ name: "main", protection: null }],
        },
        {
          repository: { description: "high", topics: ["c"] },
          branches: [{ name: "dev", protection: null }],
        },
      ),
      "merge",
    );
    expect(merged).toEqual({
      repository: { description: "high", topics: ["c"], has_issues: true },
      branches: [{ name: "dev", protection: null }],
    });
  });

  test("labels union by case-folded name: a matched entry is replaced wholesale, lower order kept, new ones appended", () => {
    const { merged } = foldMergeLayers(
      stack(
        { labels: [{ name: "Bug", color: "111111", description: "kept?" }, { name: "docs" }] },
        { labels: [{ name: "infra" }, { name: "bug", color: "222222" }] },
      ),
      "merge",
    );
    expect(merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [{ name: "bug", color: "222222" }, { name: "docs" }, { name: "infra" }],
      },
    });
  });

  test("a label renaming into a name a higher entry declares is one resource: the higher entry stands in its slot", () => {
    const { merged } = foldMergeLayers(
      stack(
        { labels: [{ name: "bug", new_name: "defect", color: "111111" }, { name: "docs" }] },
        { labels: [{ name: "Defect", color: "222222" }] },
      ),
      "merge",
    );
    expect(merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [{ name: "Defect", color: "222222" }, { name: "docs" }],
      },
    });
  });

  test("a higher rename claiming two lower labels supersedes both at the first one's slot", () => {
    const { merged } = foldMergeLayers(
      stack(
        { labels: [{ name: "a" }, { name: "docs" }, { name: "b" }] },
        { labels: [{ name: "B", new_name: "A" }] },
      ),
      "merge",
    );
    expect(merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [{ name: "B", new_name: "A" }, { name: "docs" }],
      },
    });
  });

  test("two higher labels claiming one lower rename between them both take its slot, in their order", () => {
    const { merged } = foldMergeLayers(
      stack(
        { labels: [{ name: "x" }, { name: "a", new_name: "b" }, { name: "y" }] },
        {
          labels: [
            { name: "b", color: "222222" },
            { name: "a", color: "111111" },
          ],
        },
      ),
      "merge",
    );
    expect(merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [
          { name: "x" },
          { name: "b", color: "222222" },
          { name: "a", color: "111111" },
          { name: "y" },
        ],
      },
    });
  });

  test("rulesets union by name merge key by key, their rules pairing by type and replacing", () => {
    const { merged, notices } = foldMergeLayers(
      stack(
        {
          rulesets: [
            {
              name: "main",
              target: "branch",
              enforcement: "active",
              rules: [{ type: "deletion" }, { type: "non_fast_forward", parameters: { a: 1 } }],
            },
          ],
        },
        {
          rulesets: [
            {
              name: "main",
              enforcement: null,
              rules: [{ type: "non_fast_forward" }, { type: "x" }],
            },
            { name: "tags", target: "tag" },
          ],
        },
      ),
      "merge",
    );
    expect(merged).toEqual({
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [
          {
            name: "main",
            target: "branch",
            rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "x" }],
          },
          { name: "tags", target: "tag" },
        ],
      },
    });
    expect(notices).toEqual([{ layer: "settings.yml", path: "rulesets[0].enforcement" }]);
  });

  test("a notice names a merged entry by its index in the higher layer's list, not its key or lower slot", () => {
    // The higher entry sits at index 0 of its own list but pairs with the
    // lower list's index 1: the notice carries the higher index.
    const layers = stack(
      {
        rulesets: [
          { name: "a", target: "branch" },
          { name: "lock-1", target: "branch", conditions: { ref_name: { include: ["~ALL"] } } },
        ],
      },
      { rulesets: [{ name: "lock-1", conditions: null }] },
    );
    const { merged, notices } = foldMergeLayers(layers, "merge");
    expect(merged).toEqual({
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [
          { name: "a", target: "branch" },
          { name: "lock-1", target: "branch" },
        ],
      },
    });
    expect(notices).toEqual([{ layer: "settings.yml", path: "rulesets[0].conditions" }]);
    expect(notices.map(describeOptOut)).toEqual([
      "settings.yml: null removed rulesets[0].conditions declared by a lower layer",
    ]);
    // The engine's fold names the same site: the oracle's path is the one the
    // action prints, not merely a consistent spelling of its own.
    expect(engineNotices(layers)).toEqual(notices);
  });

  test("a nested null inside a merged entry is named under the higher index, rules included", () => {
    // `main` is the lower list's first entry and the higher list's second; a
    // null on its rules and on a key inside a conditions mapping both hang off
    // rulesets[1]. Rules pair by type and replace, so a rule's own keys are
    // never merged into and no notice path reaches below `.rules`.
    const layers = stack(
      {
        rulesets: [
          {
            name: "main",
            target: "branch",
            rules: [{ type: "deletion" }],
            conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
          },
        ],
      },
      {
        rulesets: [
          { name: "tags", target: "tag" },
          { name: "main", rules: null, conditions: { ref_name: { exclude: null } } },
        ],
      },
    );
    const { merged, notices } = foldMergeLayers(layers, "merge");
    expect(merged).toEqual({
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [
          { name: "main", target: "branch", conditions: { ref_name: { include: ["~ALL"] } } },
          { name: "tags", target: "tag" },
        ],
      },
    });
    expect(notices).toEqual([
      { layer: "settings.yml", path: "rulesets[1].rules" },
      { layer: "settings.yml", path: "rulesets[1].conditions.ref_name.exclude" },
    ]);
    expect(notices.map(describeOptOut)).toEqual([
      "settings.yml: null removed rulesets[1].rules declared by a lower layer",
      "settings.yml: null removed rulesets[1].conditions.ref_name.exclude declared by a lower layer",
    ]);
    expect(engineNotices(layers)).toEqual(notices);
  });

  test("a replaced entry (labels) earns no notice for the nulls inside it", () => {
    const layers = stack(
      {
        labels: [
          { name: "a", color: "111111" },
          { name: "b", description: "x" },
        ],
      },
      { labels: [{ name: "b", description: null }] },
    );
    const { merged, notices } = foldMergeLayers(layers, "merge");
    expect(merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [
          { name: "a", color: "111111" },
          { name: "b", description: null },
        ],
      },
    });
    expect(notices).toEqual([]);
    expect(engineNotices(layers)).toEqual([]);
  });

  test("an unkeyed knobbed section replaces under the run's merge default", () => {
    const { merged } = foldMergeLayers(
      stack({ milestones: [{ title: "v1" }] }, { milestones: [{ title: "v2" }] }),
      "merge",
    );
    expect(merged).toEqual({
      milestones: { [UNDECLARED_KEY]: "keep", entries: [{ title: "v2" }] },
    });
  });

  test("an omitted policy inherits the lower one, an explicit one wins, and the default resolves after the fold", () => {
    const { merged } = foldMergeLayers(
      stack(
        {
          labels: { [UNDECLARED_KEY]: "keep", entries: [{ name: "a" }] },
          rulesets: { [UNDECLARED_KEY]: "delete", entries: [{ name: "r" }] },
          autolinks: [{ key_prefix: "J-", url_template: "https://j/<num>" }],
        },
        { labels: [{ name: "b" }], rulesets: { [UNDECLARED_KEY]: "keep", entries: [] } },
      ),
      "merge",
    );
    expect(merged).toEqual({
      labels: { [UNDECLARED_KEY]: "keep", entries: [{ name: "a" }, { name: "b" }] },
      rulesets: { [UNDECLARED_KEY]: "keep", entries: [{ name: "r" }] },
      autolinks: {
        [UNDECLARED_KEY]: "delete",
        entries: [{ key_prefix: "J-", url_template: "https://j/<num>" }],
      },
    });
  });

  test("the wrapper directive wins over the file directive, which wins over the run; none reaches the document", () => {
    const low = { labels: [{ name: "a" }], rulesets: [{ name: "r", target: "branch" }] };
    const fileReplaceWrapperMerge = foldMergeLayers(
      stack(low, {
        _layering: "replace",
        labels: [{ name: "b" }],
        rulesets: { _layering: "merge", entries: [{ name: "s" }] },
      }),
      "merge",
    );
    expect(fileReplaceWrapperMerge.merged).toEqual({
      labels: { [UNDECLARED_KEY]: "delete", entries: [{ name: "b" }] },
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [{ name: "r", target: "branch" }, { name: "s" }],
      },
    });
    const runReplaceFileMerge = foldMergeLayers(
      stack(low, { _layering: "merge", labels: [{ name: "b" }] }),
      "replace",
    );
    expect(runReplaceFileMerge.merged).toEqual({
      labels: { [UNDECLARED_KEY]: "delete", entries: [{ name: "a" }, { name: "b" }] },
      rulesets: { [UNDECLARED_KEY]: "keep", entries: [{ name: "r", target: "branch" }] },
    });
    const runReplace = foldMergeLayers(stack(low, { labels: [{ name: "b" }] }), "replace");
    expect(runReplace.merged.labels).toEqual({
      [UNDECLARED_KEY]: "delete",
      entries: [{ name: "b" }],
    });
  });

  test("a deleted keyed section declared again replaces: the lower entries are gone", () => {
    const { merged, notices } = foldMergeLayers(
      stack({ labels: [{ name: "a" }] }, { labels: null }, { labels: [{ name: "b" }] }),
      "merge",
    );
    expect(merged).toEqual({ labels: { [UNDECLARED_KEY]: "delete", entries: [{ name: "b" }] } });
    expect(notices).toEqual([{ layer: "layer-1.yml", path: "labels" }]);
  });

  test("only section keys survive: private underscore keys are not part of the written document", () => {
    const { merged } = foldMergeLayers(stack({ _note: "private", pages: null }), "merge");
    expect(merged).toEqual({ pages: null });
  });
});

describe("refusedMergeLayer (the oracle's read of the layer boundary)", () => {
  const admitted = { labels: [{ name: "a" }], rulesets: [{ name: "r", rules: [{ type: "t" }] }] };

  test("admits a stack of well-formed layers, run-level merge on an unkeyed section included", () => {
    expect(
      refusedMergeLayer(stack(admitted, { milestones: [{ title: "v1" }], _layering: "replace" })),
    ).toBeUndefined();
  });

  const refusals: Array<[string, Record<string, unknown>]> = [
    [
      "two rules of one type in a ruleset",
      { rulesets: [{ name: "r", rules: [{ type: "t" }, { type: "t" }] }] },
    ],
    ["two labels under one case-folded name", { labels: [{ name: "Bug" }, { name: "bug" }] }],
    ["two rulesets under one name", { rulesets: [{ name: "r" }, { name: "r" }] }],
    ["a keyless label", { labels: [{ color: "abcdef" }] }],
    [
      "a label renaming into a sibling's name",
      { labels: [{ name: "a", new_name: "b" }, { name: "B" }] },
    ],
    [
      "two labels renaming into one name",
      {
        labels: [
          { name: "a", new_name: "x" },
          { name: "b", new_name: "X" },
        ],
      },
    ],
    ["a label whose rename target is not a string", { labels: [{ name: "a", new_name: 7 }] }],
    ["merge on an unkeyed wrapper", { milestones: { _layering: "merge", entries: [] } }],
    ["file-level merge over a plain unkeyed list", { _layering: "merge", milestones: [] }],
    ["a wrapper directive outside merge|replace", { labels: { _layering: "union", entries: [] } }],
    ["a file directive outside merge|replace", { _layering: "MERGE" }],
    ["a wrapper without an entries list", { labels: { [UNDECLARED_KEY]: "keep" } }],
    ["a non-mapping entry", { labels: ["bug"] }],
  ];
  test.each(refusals)("refuses %s, naming the layer", (_name, doc) => {
    expect(refusedMergeLayer(stack(admitted, doc, admitted))).toBe("layer-1.yml");
  });

  test("a file-level merge is admitted when the unkeyed wrapper says replace", () => {
    expect(
      refusedMergeLayer(
        stack({ _layering: "merge", milestones: { _layering: "replace", entries: [] } }),
      ),
    ).toBeUndefined();
  });
});

describe("KEYED_MERGE_SECTIONS lockstep with the section declarations", () => {
  // The oracle spells the keyed sections in its own words; this pins that
  // spelling against the modules' layering declarations as DATA, so a module
  // gaining or changing a layering key fails here instead of quietly making
  // the fuzz predict a fold the engine no longer performs.
  test("exactly the modules declaring a layering are keyed, with the same key field and combine", () => {
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      const declared = sectionModule(key).layering;
      const oracle = KEYED_MERGE_SECTIONS[key];
      expect(oracle === undefined, `${key}`).toBe(declared === undefined);
      if (declared === undefined || oracle === undefined) {
        continue;
      }
      expect(oracle.keyField).toBe(declared.keyField);
      expect(oracle.combine).toBe(declared.combine);
      expect(Object.keys(oracle.nested ?? {}).sort()).toEqual(
        Object.keys(declared.nested ?? {}).sort(),
      );
      for (const [field, nested] of Object.entries(oracle.nested ?? {})) {
        const declaredNested = declared.nested?.[field];
        if (declaredNested === undefined) {
          throw new Error(`${key}.${field}: the module declares no nested layering`);
        }
        expect(nested.keyField).toBe(declaredNested.keyField);
        expect(nested.combine).toBe(declaredNested.combine);
      }
    }
  });

  test("the key functions agree over the spellings the generators draw, renames included", () => {
    const samples = [
      { name: "Bug", type: "Deletion" },
      { name: "with|pipe", type: "non_fast_forward" },
      { name: "unicode-éñ中", type: "x" },
      { name: "Bug", new_name: "Defect", type: "x" },
      { name: "bug", new_name: "BUG", type: "x" },
      { name: "bug", new_name: 7, type: "x" },
      { name: 7, new_name: "x", type: "x" },
      { name: 7, type: 7 },
      {},
    ];
    for (const key of ["labels", "rulesets"] as const) {
      const declared = sectionModule(key).layering;
      const oracle = KEYED_MERGE_SECTIONS[key];
      if (declared === undefined || oracle === undefined) {
        throw new Error(`${key} lost its layering`);
      }
      for (const sample of samples) {
        expect(oracle.keysOf(sample), `${key} ${JSON.stringify(sample)}`).toEqual(
          declared.keys(sample),
        );
        const rules = declared.nested?.rules;
        const oracleRules = oracle.nested?.rules;
        if (rules !== undefined && oracleRules !== undefined) {
          expect(oracleRules.keysOf(sample)).toEqual(rules.keys(sample));
        }
      }
    }
    // The alias union rests on these exact claims, spelled here so the
    // lockstep above cannot pass on two functions that agree on returning null.
    const labels = KEYED_MERGE_SECTIONS.labels;
    if (labels === undefined) {
      throw new Error("labels lost its layering");
    }
    expect(labels.keysOf({ name: "Bug", new_name: "Defect" })).toEqual(["defect", "bug"]);
    expect(labels.keysOf({ name: "bug", new_name: "BUG" })).toEqual(["bug"]);
    expect(labels.keysOf({ name: "bug", new_name: 7 })).toBeNull();
  });
});

describe("predictMerge", () => {
  test("a fold the validator rejects is predicted invalid, not merged", () => {
    const prediction = predictMerge({
      layers: stack(
        {
          actions: {
            allowed_actions: "selected",
            selected_actions: { github_owned_allowed: true },
          },
        },
        { actions: { allowed_actions: "all" } },
      ),
      layering: "merge",
      features: [],
    });
    expect(prediction.kind).toBe("invalid");
  });

  test("a refused layer is reported before any fold", () => {
    expect(
      predictMerge({
        layers: stack({ labels: [{ name: "a" }, { name: "A" }] }, { pages: null }),
        layering: "merge",
        features: [],
      }),
    ).toEqual({ kind: "refused", layer: "layer-0.yml" });
  });
});
