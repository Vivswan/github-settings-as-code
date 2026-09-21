import { describe, expect, test } from "bun:test";
import { describeRemoval, mergeLayers, type RemovalNotice } from "../../src/engine/layers.js";
import { foldLayers } from "../../src/flows/layers.js";
import { silentIo } from "../../src/io.js";
import { describeProblem } from "../../src/problem.js";
import { LIST_SECTIONS } from "../../src/schema.js";
import { listLayering } from "../../src/sections/registry.js";
import { ADMIN_SLUG } from "./constants.js";
import {
  type Json,
  LAYERING_KEY,
  type LayeringDirective,
  REMOVE_KEY,
  UNDECLARED_KEY,
} from "./gen-support.js";
import type { MergeLayer, MultiRepoTarget, MultiScenarioMeta, ScenarioMeta } from "./generators.js";
import {
  type AbortVerdict,
  effectiveGrades,
  foldMergeLayers,
  foldRepoResults,
  foldSectionOutcomes,
  judgePreflightAbort,
  KEYED_MERGE_SECTIONS,
  NESTED_UNDECLARED_DEFAULTS,
  NO_READ_SECTIONS,
  orgGateDenied,
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
    // A section carrying only a GraphQL read (repository's features query would be that shape without
    // its REST GETs) must not be misread as read-free; a new member here is a conscious change, not drift.
    expect([...NO_READ_SECTIONS].sort()).toEqual(["check_suite_preferences"]);
  });
});

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

  test("teams: org_members shuts the org gate, never the repository grade", () => {
    expect(sectionGrade("teams", { administration: "write", org_members: "none" })).toBe("write");
    expect(sectionGrade("teams", { administration: "read", org_members: "write" })).toBe("read");
    expect(sectionGrade("teams", { administration: "none", org_members: "write" })).toBe("none");
    expect(orgGateDenied("teams", { org_members: "none" })).toBe(true);
    expect(orgGateDenied("teams", { org_members: "read" })).toBe(false);
    expect(orgGateDenied("teams", {})).toBe(false);
    // A section without an org permission has no org gate to shut.
    expect(orgGateDenied("labels", { org_members: "none" })).toBe(false);
  });

  test("teams: the org gate reads org_members from orgMask, not the per-slug mask", () => {
    // Nightly seed 28401742: the mock takes org_members for teams' org-scoped endpoints from the GLOBAL mask, so a
    // per-slug org_members:none must NOT shut the gate when the global mask (empty, so write) grants it.
    const teams = meta({
      sections: ["teams"],
      mask: { administration: "write", org_members: "none" },
      mode: "check",
    });
    expect(predictSection("teams", { ...teams, orgMask: {} }).grades).toEqual(["write"]);
    // The orgMask's own org_members:none does shut it, as on the single-repo path where orgMask === mask: the
    // repository reads pass and the probes answer 404, so the section runs at none under the absent posture.
    const shut = predictSection("teams", {
      ...meta({ sections: ["teams"], mask: { administration: "write" }, mode: "check" }),
      orgMask: { org_members: "none" },
    });
    expect(shut.grades).toEqual(["none"]);
    expect([...shut.allowed].sort()).toEqual(["clean", "drift"]);
    // With no repository grant the team list is denied first, under the section's own "denied" posture.
    const noAdmin = predictSection("teams", {
      ...meta({ sections: ["teams"], mask: { administration: "none" }, mode: "check" }),
      orgMask: { org_members: "none" },
    });
    expect([...noAdmin.allowed]).toEqual(["failed"]);
  });

  test("teams: a shut org gate never arms the preflight barrier; a missing repository grant does", () => {
    // The list read passes and the probes' 404 reads as no access, so preflight passes and the PUT is what fails:
    // the section row is failed with preflightDenied empty, never a preflight abort.
    const gateShut: ScenarioMeta = {
      ...meta({
        sections: ["teams"],
        mask: { administration: "write" },
        mode: "apply",
        policy: "fail",
      }),
      orgMask: { org_members: "none" },
    };
    const shut = predictSection("teams", gateShut);
    expect(shut.posture).toBe("absent");
    expect(preflightDeniable(shut, gateShut)).toBe("no");
    expect(predictOutcomes(gateShut).preflightAborts).toBe("no");
    // Under the 403 style the probe's denial is a plain denial the engine sees, so preflight does abort.
    expect(preflightDeniable(shut, { ...gateShut, denialStyle: 403 })).toBe("yes");
    const noAdmin: ScenarioMeta = {
      ...meta({
        sections: ["teams"],
        mask: { administration: "none" },
        mode: "apply",
        policy: "fail",
      }),
      orgMask: { org_members: "none" },
    };
    const denied = predictSection("teams", noAdmin);
    expect(denied.posture).toBe("denied");
    expect(preflightDeniable(denied, noAdmin)).toBe("yes");
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
    expect([...predictSectionAt("labels", readOnly, "plain").allowed].sort()).toEqual([
      "clean",
      "drift",
    ]);
  });

  test("a mixed-gating section with NO grant is denied at its primary read like any other", () => {
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
  const barrier = "::error::preflight failed: the token cannot access 1 section";
  const other = "::error::settings.yml: unknown section";
  const aborted = {
    summary: `## github-settings-as-code (apply)\n\n:x: failed - preflight denied 1 section\n\n| Section | Status | Detail |\n|---|---|---|`,
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
    ["possible without the annotation ran", "possible", ran, "ran"],
    ["possible with every witness aborted", "possible", aborted, "aborted"],
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
    // check_suite_preferences makes ZERO check-mode requests, so even a full 403-style denial has nothing to deny.
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
    // Preflight probes reads only; the denial surfaces mid-apply, so the summary is still rendered.
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
    // Every apply issues the PATCH, so with the write grant missing there is no "nothing to write" path.
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
    expect(apply.mayWrite).toBe(false);
  });

  test("a drift witness pins check to exactly drift (a clean is a false negative)", () => {
    for (const kind of ["drift-update", "extra-undeclared"] as const) {
      const p = predictSection("labels", meta({ mode: "check", liveKinds: { labels: kind } }));
      expect([...p.allowed]).toEqual(["drift"]);
    }
  });

  test("permission folding beats the witness: a denied section stays skipped", () => {
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
    // The witness guarantees a write is needed, so the section can never be a no-op applied.
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
    // The engine reports an excluded section before any read, so neither the denied grade nor the
    // seeded witness may tighten the prediction, and the empty grades leave preflight and the
    // write-granted fold vacuous over it without recognizing "excluded".
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
      posture: "denied",
      mayWrite: false,
    });
    const unrestricted = predictSection(
      "labels",
      meta({ mask: { issues: "none" }, denialStyle: 403, mode: "check" }),
    );
    expect(unrestricted).toEqual({
      key: "labels",
      grades: ["none"],
      allowed: new Set(["failed"]),
      posture: "denied",
      mayWrite: false,
    });
  });

  test("an excluded NO_READ section in check mode is excluded, not the read-free clean", () => {
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
      posture: "absent",
      mayWrite: false,
    });
  });

  test("an excluded denied section beside an active one: the run follows the active one alone", () => {
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
        {
          key: "labels",
          grades: [],
          allowed: new Set(["excluded"]),
          posture: "denied",
          mayWrite: false,
        },
        {
          key: "pages",
          grades: ["write"],
          allowed: new Set(["applied"]),
          posture: "absent",
          mayWrite: true,
        },
      ],
      allowedExitCodes: new Set([0]),
      noWritesInCheck: false,
      writeDeniedSections: [],
      fullyGranted: true,
      preflightAborts: "no",
    });

    // The control: the same meta with labels ACTIVE reaches the denied read, and the barrier aborts.
    expect(predictOutcomes({ ...excludedDenied, onlySections: undefined })).toEqual({
      sections: [
        {
          key: "labels",
          grades: ["none"],
          allowed: new Set(["failed"]),
          posture: "denied",
          mayWrite: false,
        },
        {
          key: "pages",
          grades: ["write"],
          allowed: new Set(["applied"]),
          posture: "absent",
          mayWrite: true,
        },
      ],
      allowedExitCodes: new Set([1]),
      noWritesInCheck: false,
      writeDeniedSections: ["labels"],
      fullyGranted: false,
      preflightAborts: "yes",
    });
  });

  test("an EMPTY allowlist is unrestricted, mirroring the engine's size > 0 gate", () => {
    // inputs.ts builds onlySections from a comma-split with filter(Boolean), and orchestrate.ts only
    // excludes when the set is non-empty, so `[]` must predict exactly like an undefined allowlist.
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
    // The handler stops at its ungated org probe, so the mask's administration "none" is never
    // reached and the grades must not carry the denial the run never met.
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
      posture: "denied",
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
      posture: "denied",
      mayWrite: false,
    });
  });

  test("exclusion folds before the personal-account no-op", () => {
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
      posture: "denied",
      mayWrite: false,
    });
  });
});

describe("predictOutcomes run level", () => {
  test("teams on a personal account never arms the preflight barrier, whatever org_members says", () => {
    // Fuzz seed 3388244810: the action's teams handler stops at the ungated org probe, so preflight
    // meets no denial and the run proceeds.
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
        {
          key: "teams",
          grades: ["write"],
          allowed: new Set(["applied"]),
          posture: "denied",
          mayWrite: false,
        },
        {
          key: "labels",
          grades: ["write"],
          allowed: new Set(["applied"]),
          posture: "denied",
          mayWrite: true,
        },
      ],
      allowedExitCodes: new Set([0]),
      noWritesInCheck: false,
      writeDeniedSections: [],
      fullyGranted: true,
      preflightAborts: "no",
    });

    // The control: under an organization owner the same token reaches the org_members-gated team
    // probe, and the barrier aborts the run.
    expect(predictOutcomes({ ...personal, ownerKind: "org" })).toEqual({
      sections: [
        {
          key: "teams",
          grades: ["none"],
          allowed: new Set(["failed"]),
          posture: "absent",
          mayWrite: false,
        },
        {
          key: "labels",
          grades: ["write"],
          allowed: new Set(["applied"]),
          posture: "denied",
          mayWrite: true,
        },
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
    // branches is "absent" semantics: a fine_grained 404 reads as resource absent, not a denial.
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
    // Both raw kinds fail before any section runs, never skipped: unparseable at the parse gate,
    // non-mapping at the top-level validator.
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
    // The fault hook precedes both the missing-file 404 and the permission gate, and the whole budget
    // (1 + MAX_RETRIES) burns on the first target's fetch: a missing-settings victim flips from skipped
    // to failed, a raw-invalid one fails at the transport gate, and later targets keep their predictions.
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
    const granted = meta({ sections: ["labels", "pages"], mode: "apply", mask: {} });
    const p = predictMulti(multiMeta([normal(granted)]));
    expect([...(p.repos[0]?.allowedResults ?? [])]).toEqual(["applied"]);
  });

  test("apply target mixing an applied and a skipped section rolls up to partial", () => {
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
    // The repo probe succeeds, but the default branch's ref read (the Contents-gated proof of a missing
    // file, repo-file.ts) is denied too, so the target FAILS instead of reading as fileless.
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
    // The repo probe ALSO 404s, so the read is "visible but unreadable" and the target fails before any ref read.
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
    expect(p.repos[0]?.displayKey).toBe("private repository #1");
    expect(p.repos[0]?.redacted).toBe(true);
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
    expect(predictDiscovery(globPool, { exclude: "svc-*" })).toEqual([
      "e2e-owner/legacy-x",
      "e2e-owner/UPPER",
    ]);
    expect(predictDiscovery(globPool, { exclude: "e2e-owner/legacy-*" })).not.toContain(
      "e2e-owner/legacy-x",
    );
    expect(predictDiscovery(globPool, { exclude: "*-*" })).toEqual(["e2e-owner/UPPER"]);
    expect(predictDiscovery(globPool, { exclude: "uPPer" })).not.toContain("e2e-owner/UPPER");
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

  test("foldRepoResults mirrors worstOf's RUN_RESULTS order over the repo words", () => {
    expect(foldRepoResults(["applied", "skipped", "partial"], false)).toBe("partial");
    expect(foldRepoResults(["clean", "drift"], true)).toBe("drift");
    expect(foldRepoResults(["skipped", "failed"], false)).toBe("failed");
    expect(foldRepoResults(["applied"], false)).toBe("applied");
    expect(foldRepoResults(["failed", "drift"], true)).toBe("failed");
    expect(foldRepoResults(["drift", "partial"], true)).toBe("drift");
    expect(foldRepoResults(["partial", "skipped"], false)).toBe("partial");
    expect(foldRepoResults(["skipped", "applied"], false)).toBe("skipped");
    expect(foldRepoResults(["applied", "clean"], false)).toBe("applied");
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
function engineNotices(
  layers: readonly MergeLayer[],
  layering: LayeringDirective = "deep",
): RemovalNotice[] {
  return mergeLayers(layers, { layering }).match(
    (folded) => folded.notices,
    (problem) => {
      throw new Error(`the engine refused a stack the oracle folded: ${describeProblem(problem)}`);
    },
  );
}

describe("foldMergeLayers (the oracle's own dialect)", () => {
  test("keys named after Object.prototype members are ordinary document keys, inside a nested list too, as the engine reads them", () => {
    // The oracle reads own properties only: an inherited `constructor` is not a lower declaration to delete, and an own
    // `__proto__` is a key to carry, so the two folds agree on documents the generators never draw but a file can spell.
    const proto = "__proto__";
    // `constructor` beside the nested lists too: as a field it is data to union, never Object.prototype.constructor read as a keyed list.
    const higher = JSON.parse(
      '{"repository": {"constructor": {"x": 1}, "__proto__": {"y": 2}}, "environments": [{"name": "prod", "constructor": [{"name": "B"}], "variables": [{"name": "A", "value": "y", "constructor": null}]}]}',
    ) as Json;
    const layers = stack(
      {
        repository: {},
        environments: [
          { name: "prod", constructor: [{ name: "A" }], variables: [{ name: "A", value: "x" }] },
        ],
      },
      higher,
    );
    const oracle = foldMergeLayers(layers, "deep");
    const engine = mergeLayers(layers, { layering: "deep" });
    expect(engine.isOk() ? engine.value : engine.error).toEqual({
      settings: oracle.merged,
      notices: oracle.notices,
    });
    expect(oracle).toEqual({
      merged: {
        repository: { constructor: { x: 1 }, [proto]: { y: 2 } },
        environments: [
          {
            name: "prod",
            constructor: [{ name: "B" }],
            variables: {
              [UNDECLARED_KEY]: "delete",
              entries: [{ name: "A", value: "y", constructor: null }],
            },
          },
        ],
      },
      notices: [],
    });
    const repository = oracle.merged.repository as object;
    expect([Object.hasOwn(repository, proto), Object.getPrototypeOf(repository)]).toEqual([
      true,
      Object.prototype,
    ]);
  });

  test("a higher null wins at every depth and is written as the value, with no notice; the engine agrees", () => {
    const layers = stack(
      {
        pages: { build_type: "workflow" },
        repository: { description: "x", homepage: "h" },
        actions: { enabled: true },
      },
      { pages: null, repository: { homepage: null }, interaction_limits: null, actions: null },
    );
    const expected = {
      repository: { description: "x", homepage: null },
      actions: null,
      interaction_limits: null,
      pages: null,
    };
    expect(foldMergeLayers(layers, "deep")).toEqual({ merged: expected, notices: [] });
    expect(mergeLayers(layers, { layering: "deep" })._unsafeUnwrap()).toEqual({
      settings: expected,
      notices: [],
    });
  });

  test("a null is a value below too: nulling it again changes nothing, declaring over it replaces", () => {
    const twice = foldMergeLayers(stack({ pages: null }, { pages: null }), "deep");
    expect(twice.merged).toEqual({ pages: null });
    expect(twice.notices).toEqual([]);
    const over = foldMergeLayers(
      stack({ pages: null }, { pages: { build_type: "legacy" } }),
      "deep",
    );
    expect(over.merged).toEqual({ pages: { build_type: "legacy" } });
  });

  test("mappings merge key by key at any depth; lists outside the list sections and scalars replace", () => {
    const { merged } = foldMergeLayers(
      stack(
        {
          repository: { description: "low", topics: ["a", "b"], has_issues: true },
          check_suite_preferences: { auto_trigger_checks: [{ app_id: 1, setting: true }] },
        },
        {
          repository: { description: "high", topics: ["c"] },
          check_suite_preferences: { auto_trigger_checks: [{ app_id: 2, setting: false }] },
        },
      ),
      "deep",
    );
    expect(merged).toEqual({
      repository: { description: "high", topics: ["c"], has_issues: true },
      check_suite_preferences: { auto_trigger_checks: [{ app_id: 2, setting: false }] },
    });
  });

  test("a plain-list section unions by key like a knobbed one and comes out as the bare list; an environment's nested lists union by their own keys", () => {
    const { merged, notices } = foldMergeLayers(
      stack(
        {
          branches: [
            { name: "main", protection: { enforce_admins: true } },
            { name: "release", protection: null },
          ],
          environments: [
            {
              name: "Prod",
              wait_timer: 5,
              variables: [{ name: "REGION", value: "eu" }],
              secrets: { [UNDECLARED_KEY]: "keep", entries: [{ name: "TOKEN", value: "$A" }] },
            },
          ],
          workflows: [{ path: "ci.yml", state: "active" }],
        },
        {
          branches: [{ name: "main", protection: null }],
          environments: {
            [LAYERING_KEY]: "deep",
            entries: [
              {
                name: "prod",
                variables: [
                  { name: "region", value: "us" },
                  { name: "TIMEOUT", value: "30" },
                ],
                secrets: [{ name: "token", value: "$B" }],
              },
            ],
          },
          workflows: [{ path: ".github/workflows/ci.yml", state: "disabled" }],
        },
      ),
      "shallow",
    );
    expect({ merged, notices }).toEqual({
      merged: {
        branches: [
          { name: "main", protection: null },
          { name: "release", protection: null },
        ],
        environments: [
          {
            name: "prod",
            wait_timer: 5,
            variables: {
              [UNDECLARED_KEY]: "delete",
              entries: [
                { name: "region", value: "us" },
                { name: "TIMEOUT", value: "30" },
              ],
            },
            secrets: { [UNDECLARED_KEY]: "keep", entries: [{ name: "token", value: "$B" }] },
          },
        ],
        workflows: [{ path: ".github/workflows/ci.yml", state: "disabled" }],
      },
      notices: [],
    });
  });

  test.each<[LayeringDirective, Record<string, unknown>]>([
    ["deep", { name: "bug", color: "222222", description: "kept" }],
    ["shallow", { name: "bug", color: "222222" }],
  ])(
    "labels union by case-folded name under %s: a matched entry merges or is swapped, lower order kept, new ones appended",
    (layering, bug) => {
      const { merged } = foldMergeLayers(
        stack(
          { labels: [{ name: "Bug", color: "111111", description: "kept" }, { name: "docs" }] },
          { labels: [{ name: "infra" }, { name: "bug", color: "222222" }] },
        ),
        layering,
      );
      expect(merged).toEqual({
        labels: {
          [UNDECLARED_KEY]: "delete",
          entries: [bug, { name: "docs" }, { name: "infra" }],
        },
      });
    },
  );

  test("a label renaming into a name a higher entry declares is one resource: the higher entry stands in its slot, merged under deep", () => {
    const { merged } = foldMergeLayers(
      stack(
        { labels: [{ name: "bug", new_name: "defect", color: "111111" }, { name: "docs" }] },
        { labels: [{ name: "Defect", color: "222222" }] },
      ),
      "deep",
    );
    expect(merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [{ name: "Defect", new_name: "defect", color: "222222" }, { name: "docs" }],
      },
    });
  });

  test("a higher rename claiming two lower labels supersedes both at the first one's slot", () => {
    const { merged } = foldMergeLayers(
      stack(
        { labels: [{ name: "a" }, { name: "docs" }, { name: "b" }] },
        { labels: [{ name: "B", new_name: "A" }] },
      ),
      "deep",
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
      "deep",
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

  test("rulesets union by name merge key by key under deep, their rules pairing by type and merging field by field", () => {
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
      "deep",
    );
    expect(merged).toEqual({
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [
          {
            name: "main",
            target: "branch",
            enforcement: null,
            rules: [
              { type: "deletion" },
              { type: "non_fast_forward", parameters: { a: 1 } },
              { type: "x" },
            ],
          },
          { name: "tags", target: "tag" },
        ],
      },
    });
    expect(notices).toEqual([]);
  });

  test("a removal notice names the entry by its index in the higher layer's list, not its key or lower slot; the engine agrees", () => {
    const layers = stack(
      {
        rulesets: [
          { name: "a", target: "branch" },
          { name: "lock-1", target: "branch", conditions: { ref_name: { include: ["~ALL"] } } },
        ],
      },
      { rulesets: [{ name: "lock-1", [REMOVE_KEY]: true }] },
    );
    const { merged, notices } = foldMergeLayers(layers, "deep");
    expect(merged).toEqual({
      rulesets: { [UNDECLARED_KEY]: "keep", entries: [{ name: "a", target: "branch" }] },
    });
    expect(notices).toEqual([{ layer: "settings.yml", path: "rulesets[0]" }]);
    expect(notices.map(describeRemoval)).toEqual([
      "settings.yml: rulesets[0] carries _remove: true and dropped the entry a lower layer declared under its key",
    ]);
    // The engine's fold names the same site: the oracle's path is the one the action prints, not
    // merely a consistent spelling of its own.
    expect(engineNotices(layers)).toEqual(notices);
  });

  test("a nested removal inside a merged entry is named under the higher index, in either nested form", () => {
    const layers = stack(
      {
        rulesets: [
          { name: "main", target: "branch", rules: [{ type: "deletion" }, { type: "x" }] },
        ],
        environments: [
          {
            name: "prod",
            variables: {
              [UNDECLARED_KEY]: "keep",
              entries: [
                { name: "A", value: "1" },
                { name: "B", value: "2" },
              ],
            },
          },
        ],
      },
      {
        rulesets: [
          { name: "tags", target: "tag" },
          { name: "main", rules: [{ type: "deletion", [REMOVE_KEY]: true }] },
        ],
        environments: [{ name: "Prod", variables: [{ name: "a", [REMOVE_KEY]: true }] }],
      },
    );
    const { merged, notices } = foldMergeLayers(layers, "deep");
    expect(merged).toEqual({
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [
          { name: "main", target: "branch", rules: [{ type: "x" }] },
          { name: "tags", target: "tag" },
        ],
      },
      environments: [
        {
          name: "Prod",
          variables: { [UNDECLARED_KEY]: "keep", entries: [{ name: "B", value: "2" }] },
        },
      ],
    });
    expect(notices).toEqual([
      { layer: "settings.yml", path: "rulesets[1].rules[0]" },
      { layer: "settings.yml", path: "environments[0].variables[0]" },
    ]);
    expect(engineNotices(layers)).toEqual(notices);
  });

  test("a null inside an entry is the field's value under shallow and deep alike, with no notice; the engine agrees", () => {
    const layers = stack(
      {
        labels: [
          { name: "a", color: "111111" },
          { name: "b", description: "x", color: "222222" },
        ],
      },
      { labels: [{ name: "b", description: null }] },
    );
    const shallow = foldMergeLayers(layers, "shallow");
    expect(shallow.merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [
          { name: "a", color: "111111" },
          { name: "b", description: null },
        ],
      },
    });
    expect(shallow.notices).toEqual([]);
    expect(engineNotices(layers, "shallow")).toEqual([]);
    const deep = foldMergeLayers(layers, "deep");
    expect(deep.merged).toEqual({
      labels: {
        [UNDECLARED_KEY]: "delete",
        entries: [
          { name: "a", color: "111111" },
          { name: "b", description: null, color: "222222" },
        ],
      },
    });
    expect(deep.notices).toEqual([]);
    expect(engineNotices(layers, "deep")).toEqual([]);
  });

  test.each<LayeringDirective>(["shallow", "deep"])(
    "a removal under %s drops a held label through its case fold or its rename target, and the next layer may declare the key anew; the engine agrees",
    (layering) => {
      const layers = stack(
        {
          labels: [
            { name: "Bug", color: "111111" },
            { name: "docs", new_name: "documentation" },
          ],
        },
        {
          labels: [
            { name: "bug", [REMOVE_KEY]: true },
            { name: "documentation", [REMOVE_KEY]: true },
          ],
        },
        { labels: [{ name: "bug", color: "333333" }] },
      );
      const oracle = foldMergeLayers(layers, layering);
      expect(oracle).toEqual({
        merged: {
          labels: { [UNDECLARED_KEY]: "delete", entries: [{ name: "bug", color: "333333" }] },
        },
        notices: [
          { layer: "layer-1.yml", path: "labels[0]" },
          { layer: "layer-1.yml", path: "labels[1]" },
        ],
      });
      expect(mergeLayers(layers, { layering })._unsafeUnwrap()).toEqual({
        settings: oracle.merged,
        notices: oracle.notices,
      });
    },
  );

  test.each<[string, LayeringDirective, Record<string, unknown>]>([
    ["a removal no lower layer matches", "deep", { labels: [{ name: "zz", [REMOVE_KEY]: true }] }],
    [
      "a nested removal in a new entry",
      "deep",
      { rulesets: [{ name: "new", rules: [{ type: "t", [REMOVE_KEY]: true }] }] },
    ],
    [
      "a nested removal under shallow",
      "shallow",
      { rulesets: [{ name: "r", rules: [{ type: "t", [REMOVE_KEY]: true }] }] },
    ],
    [
      "a removal in a section nothing below declares",
      "deep",
      { milestones: [{ title: "v1", [REMOVE_KEY]: true }] },
    ],
  ])("%s is the fold's refusal, naming the layer; the engine agrees", (_case, layering, doc) => {
    const layers = stack(
      { labels: [{ name: "a" }], rulesets: [{ name: "r", rules: [{ type: "t" }] }] },
      doc,
    );
    expect(predictMerge({ layers, layering, features: [] })).toEqual({
      kind: "refused",
      layer: "settings.yml",
    });
    expect(mergeLayers(layers, { layering }).isErr()).toBe(true);
  });

  test("two layers each carrying a refusal: the fold names the lower one, as the engine does, whatever the sections' order", () => {
    // The oracle folds layer by layer; a section-first fold would meet the higher layer's labels before the lower's environments.
    const layers = stack(
      { environments: [{ name: "prod", [REMOVE_KEY]: true }] },
      { labels: [{ name: "bug", [REMOVE_KEY]: true }] },
    );
    expect(predictMerge({ layers, layering: "deep", features: [] })).toEqual({
      kind: "refused",
      layer: "layer-0.yml",
    });
    expect(
      mergeLayers(layers, { layering: "deep" }).match(
        () => null,
        (problem) => problem.layer,
      ),
    ).toBe("layer-0.yml");
  });

  test.each<[LayeringDirective, Record<string, unknown>[]]>([
    ["deep", [{ title: "v1" }, { title: "v2" }]],
    ["shallow", [{ title: "v1" }, { title: "v2" }]],
    ["replace", [{ title: "v2" }]],
  ])(
    "a knobbed section without a case fold (milestones) unions by title under %s",
    (layering, entries) => {
      const { merged } = foldMergeLayers(
        stack({ milestones: [{ title: "v1" }] }, { milestones: [{ title: "v2" }] }),
        layering,
      );
      expect(merged).toEqual({ milestones: { [UNDECLARED_KEY]: "keep", entries } });
    },
  );

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
      "deep",
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
        rulesets: { _layering: "deep", entries: [{ name: "s" }] },
      }),
      "deep",
    );
    expect(fileReplaceWrapperMerge.merged).toEqual({
      labels: { [UNDECLARED_KEY]: "delete", entries: [{ name: "b" }] },
      rulesets: {
        [UNDECLARED_KEY]: "keep",
        entries: [{ name: "r", target: "branch" }, { name: "s" }],
      },
    });
    const runReplaceFileMerge = foldMergeLayers(
      stack(low, { _layering: "deep", labels: [{ name: "b" }] }),
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

  test("a keyed section nulled below and declared again folds to the higher list alone: the null won whole, then was replaced", () => {
    const { merged, notices } = foldMergeLayers(
      stack({ labels: [{ name: "a" }] }, { labels: null }, { labels: [{ name: "b" }] }),
      "deep",
    );
    expect(merged).toEqual({ labels: { [UNDECLARED_KEY]: "delete", entries: [{ name: "b" }] } });
    expect(notices).toEqual([]);
  });

  test("only section keys survive: private underscore keys are not part of the written document", () => {
    const { merged } = foldMergeLayers(stack({ _note: "private", pages: null }), "deep");
    expect(merged).toEqual({ pages: null });
  });
});

describe("refusedMergeLayer (the oracle's read of the layer boundary)", () => {
  const admitted = { labels: [{ name: "a" }], rulesets: [{ name: "r", rules: [{ type: "t" }] }] };

  test("admits a stack of well-formed layers, a file directive, a keyed milestone, a removal, and a null-valued section included", () => {
    expect(
      refusedMergeLayer(
        stack(admitted, {
          milestones: [{ title: "v1" }],
          labels: { _layering: "deep", entries: [{ name: "a", [REMOVE_KEY]: true }] },
          pages: null,
          _layering: "replace",
        }),
        "deep",
      ),
    ).toBeUndefined();
  });

  const refusals: Array<[string, Record<string, unknown>]> = [
    [
      "two rules of one type in a ruleset",
      { rulesets: [{ name: "r", rules: [{ type: "t" }, { type: "t" }] }] },
    ],
    ["two labels under one case-folded name", { labels: [{ name: "Bug" }, { name: "bug" }] }],
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
    ["a titleless milestone", { milestones: [{ description: "no title" }] }],
    [
      "two secrets under one uppercased name",
      {
        actions_secrets: [
          { name: "A", value: "$A" },
          { name: "a", value: "$B" },
        ],
      },
    ],
    ["the retired merge directive on a wrapper", { labels: { _layering: "merge", entries: [] } }],
    ["a file directive outside the set", { _layering: "DEEP" }],
    ["a wrapper without an entries list", { labels: { [UNDECLARED_KEY]: "keep" } }],
    ["a non-mapping entry", { labels: ["bug"] }],
    ["a removal marker that is not true", { labels: [{ name: "a", [REMOVE_KEY]: "yes" }] }],
    [
      "a removal beside another field",
      { labels: [{ name: "a", [REMOVE_KEY]: true, color: "ffffff" }] },
    ],
    ["a removal under the run's replace", { labels: [{ name: "a", [REMOVE_KEY]: true }] }],
    [
      "a removal under the wrapper's replace",
      { labels: { _layering: "replace", entries: [{ name: "a", [REMOVE_KEY]: true }] } },
    ],
    [
      "a nested removal beside another field",
      { rulesets: [{ name: "r", rules: [{ type: "t", [REMOVE_KEY]: true, parameters: {} }] }] },
    ],
    ["a whole-section null where null is not the section's value", { labels: null }],
  ];
  test.each(refusals)("refuses %s, naming the layer the run names", (_name, doc) => {
    const layers = stack(admitted, doc, admitted);
    expect(refusedMergeLayer(layers, "replace")).toBe("layer-1.yml");
    // The run's own verdict: per-layer validation or the fold's boundary, whichever fires, names the same layer.
    expect(
      foldLayers(layers, "merged", { layering: "replace" }, silentIo()).match(
        () => null,
        (problem) => ("layer" in problem ? problem.layer : problem.source),
      ),
    ).toBe("layer-1.yml");
  });

  test("a lower fold refusal comes before a higher boundary refusal, as the run admits and folds one layer at a time", () => {
    const layers = stack(
      { labels: [{ name: "gone", [REMOVE_KEY]: true }] },
      { _layering: "invalid", labels: [{ name: "a" }] },
    );
    expect(predictMerge({ layers, layering: "deep", features: [] })).toEqual({
      kind: "refused",
      layer: "layer-0.yml",
    });
    expect(
      foldLayers(layers, "merged", { layering: "deep" }, silentIo()).match(
        () => null,
        (problem) => ("layer" in problem ? problem.layer : problem.source),
      ),
    ).toBe("layer-0.yml");
  });

  test("nested removal notices come in the order the higher layer wrote its fields, as the action prints them", () => {
    const layers = stack(
      {
        environments: [
          {
            name: "prod",
            variables: [{ name: "A", value: "1" }],
            secrets: [{ name: "B", value: "$B" }],
          },
        ],
      },
      {
        environments: [
          {
            name: "prod",
            secrets: { entries: [{ name: "B", [REMOVE_KEY]: true }] },
            variables: { entries: [{ name: "A", [REMOVE_KEY]: true }] },
          },
        ],
      },
    );
    const oracle = foldMergeLayers(layers, "deep");
    expect(oracle.notices).toEqual([
      { layer: "settings.yml", path: "environments[0].secrets[0]" },
      { layer: "settings.yml", path: "environments[0].variables[0]" },
    ]);
    expect(engineNotices(layers)).toEqual(oracle.notices);
  });
});

describe("KEYED_MERGE_SECTIONS lockstep with the section declarations", () => {
  // The oracle spells every list section's key in its own words; pinning that spelling against the
  // modules' layering declarations as DATA makes a module changing its key fail here instead of quietly
  // making the fuzz predict a fold the engine no longer performs.
  test("every list module's key field and nested lists are the oracle's", () => {
    for (const key of LIST_SECTIONS) {
      const declared = listLayering(key);
      const oracle = KEYED_MERGE_SECTIONS[key];
      expect(oracle.keyField, key).toBe(declared.keyField);
      expect(oracle.removalPaths, key).toEqual(declared.removalPaths);
      expect(Object.keys(oracle.nested ?? {}).sort()).toEqual(
        Object.keys(declared.nested ?? {}).sort(),
      );
      for (const [field, nested] of Object.entries(oracle.nested ?? {})) {
        const declaredNested = declared.nested?.[field];
        if (declaredNested === undefined) {
          throw new Error(`${key}.${field}: the module declares no nested layering`);
        }
        expect(nested.keyField).toBe(declaredNested.keyField);
        expect(nested.removalPaths, `${key}.${field}`).toEqual(declaredNested.removalPaths);
      }
    }
  });

  /**
   * Spellings that fold differently per section: case (labels, collaborators, teams fold it; the secret and variable
   * families uppercase it; the rest keep it), a rename, a dotted key path, and the non-string shapes the boundary refuses.
   */
  const SAMPLES: Record<string, unknown>[] = [
    {
      name: "Bug",
      username: "Octocat",
      title: "V1",
      key_prefix: "J-",
      property_name: "Team",
      type: "Deletion",
    },
    { name: "with|pipe", username: "with|pipe", title: "with|pipe", type: "non_fast_forward" },
    { name: "unicode-éñ中", username: "unicode-éñ中", type: "x" },
    { name: "Bug", new_name: "Defect", type: "x" },
    { name: "bug", new_name: "BUG", type: "x" },
    { name: "bug", new_name: 7, type: "x" },
    { name: 7, new_name: "x", type: "x" },
    { name: 7, username: 7, title: 7, key_prefix: 7, property_name: 7, type: 7 },
    { config: { url: "https://hooks.example.com/A" } },
    { config: { url: 7 } },
    { config: "https://hooks.example.com/A" },
    { path: "ci.yml", app: "gate", type: "User", id: 7 },
    { path: ".github/workflows/ci.yml", app: 7, id: "7" },
    { path: 7, type: "Team", id: 7 },
    {},
  ];

  test.each([...LIST_SECTIONS])(
    "%s: the key functions agree over the spellings the generators draw, renames and case included",
    (key) => {
      const declared = listLayering(key);
      const oracle = KEYED_MERGE_SECTIONS[key];
      for (const sample of SAMPLES) {
        expect(oracle.keysOf(sample), JSON.stringify(sample)).toEqual(declared.keys(sample));
        for (const [field, nested] of Object.entries(oracle.nested ?? {})) {
          expect(nested.keysOf(sample), `${field} ${JSON.stringify(sample)}`).toEqual(
            declared.nested?.[field]?.keys(sample) ?? null,
          );
        }
      }
    },
  );

  test("the nested knob defaults the oracle spells match the environments module's, and only those lists take one", () => {
    const declared = listLayering("environments").nested ?? {};
    expect(
      Object.fromEntries(
        Object.entries(declared)
          .filter(([, nested]) => nested.undeclaredDefault !== undefined)
          .map(([field, nested]) => [field, nested.undeclaredDefault]),
      ),
    ).toEqual(NESTED_UNDECLARED_DEFAULTS);
  });

  test("the folds are spelled out, so the lockstep above cannot pass on two functions agreeing on null", () => {
    // The alias union rests on the label claims; the folds are what pair Bug/bug, Octocat/octocat, and my_secret/MY_SECRET.
    const keys = KEYED_MERGE_SECTIONS;
    expect(keys.labels.keysOf({ name: "Bug", new_name: "Defect" })).toEqual(["defect", "bug"]);
    expect(keys.labels.keysOf({ name: "bug", new_name: "BUG" })).toEqual(["bug"]);
    expect(keys.labels.keysOf({ name: "bug", new_name: 7 })).toBeNull();
    expect(keys.collaborators.keysOf({ username: "Octocat" })).toEqual(["octocat"]);
    expect(keys.teams.keysOf({ name: "Prod" })).toEqual(["prod"]);
    expect(keys.actions_secrets.keysOf({ name: "my_secret" })).toEqual(["MY_SECRET"]);
    expect(keys.agents_variables.keysOf({ name: "my_var" })).toEqual(["MY_VAR"]);
    expect(keys.milestones.keysOf({ title: "V1" })).toEqual(["V1"]);
    expect(keys.environments.keysOf({ name: "Prod" })).toEqual(["prod"]);
    expect(keys.environments.nested?.variables?.keysOf({ name: "log_level" })).toEqual([
      "LOG_LEVEL",
    ]);
    // A user and a team may share an id; the key tells them apart without either being keyless.
    const reviewers = keys.environments.nested?.reviewers;
    expect(reviewers?.keysOf({ type: "User", id: 7 })).not.toBeNull();
    expect(reviewers?.keysOf({ type: "User", id: 7 })).not.toEqual(
      reviewers?.keysOf({ type: "Team", id: 7 }),
    );
    expect(keys.workflows.keysOf({ path: "ci.yml" })).toEqual([".github/workflows/ci.yml"]);
    expect(keys.webhooks.keysOf({ config: { url: "https://hooks.example.com/A" } })).toEqual([
      "https://hooks.example.com/A",
    ]);
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
      layering: "deep",
      features: [],
    });
    expect(prediction.kind).toBe("invalid");
  });

  test("a refused layer is reported before any fold", () => {
    expect(
      predictMerge({
        layers: stack({ labels: [{ name: "a" }, { name: "A" }] }, { pages: null }),
        layering: "deep",
        features: [],
      }),
    ).toEqual({ kind: "refused", layer: "layer-0.yml" });
  });
});
