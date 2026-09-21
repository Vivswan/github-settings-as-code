import { describe, expect, test } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { GitHubClient } from "../../src/github/api.js";
import type { SettingsFile } from "../../src/schema.js";
import { codeQualitySetupSection } from "../../src/sections/code_quality_setup/index.js";
import { codeScanningDefaultSetupSection } from "../../src/sections/code_scanning_default_setup/index.js";
import type { SectionFailure } from "../../src/sections/contract/errors.js";
import type { SectionInput, SectionModule } from "../../src/sections/contract/module.js";
import { type PlanContext, planContext } from "../../src/sections/contract/plan.js";
import type { SetupKey, SetupSectionModule } from "../../src/sections/shared/setup-section.js";
import type { MustBeNever } from "../../src/types.js";
import type { LiveState } from "../e2e/mock/state.js";
import { MockApi } from "../mock-api.js";
import { registryFake } from "./fragment-fake.js";
import { provePlanIdempotent } from "./plan-idempotence.js";
import { REPO, unwrap } from "./section-run.js";
import { proveSnapshotRoundTrip, type SnapshotSection } from "./snapshot-roundtrip.js";
import { validatedInput } from "./validated-input.js";

/** One section's declared setup document. */
type Declared<K extends SetupKey = SetupKey> = Exclude<SettingsFile[K], undefined>;

type Languages<K extends SetupKey> = NonNullable<Declared<K>["languages"]>;

/** The names reversed, still typed as their vocabulary: array methods on the union of the two erase to string[]. */
function reversed<T extends readonly string[]>(names: T): T {
  return names.slice().reverse() as unknown as T;
}

/** The lockstep tuple on which the minted sections differ, typed by the same key throughout. */
interface SetupFacts<K extends SetupKey> {
  section: SetupSectionModule<K>;
  /** The expanded endpoint path ("/repos/o/r/code-quality/setup"). */
  path: string;
  /** A live GET body; must carry a `languages` list for the set compare, and lack the key `knownAbsent` declares. */
  live: Record<string, unknown> & { languages: Languages<K> };
  /** A declared document that drifts from `live`, and the exact drift line. */
  driftDeclared: Declared<K>;
  driftLine: string;
  /** A slice key `live` lacks: drift the PATCH resolves, never a phantom. */
  knownAbsent: Declared<K>;
  /** A language only the GET reports, and the exact refusal it earns in a settings file. */
  getOnlyLanguage: [string, string];
  /** The mock's seeded setup whose `languages` carry the GET's spellings, and what they read back as. */
  seeded: LiveState;
  languagesRead: Languages<K>;
  /** The GET-only names with no declarable form, left out of the compare and the snapshot with a note. */
  undeclarable: string[];
  /** A declared document for the verbatim-PATCH case. */
  applyPayload: Declared<K>;
  changeLine: string;
  /** The whole failure messages a 409 and a 403 on the PATCH produce. */
  conflict409: string;
  denied403: string;
}

/** Exhaustive by type: a setup key without a row fails to compile. */
const SETUP_FACTS: { readonly [K in SetupKey]: SetupFacts<K> } = {
  code_scanning_default_setup: {
    section: codeScanningDefaultSetupSection,
    path: "/repos/o/r/code-scanning/default-setup",
    live: {
      state: "configured",
      query_suite: "default",
      languages: ["javascript-typescript", "python"],
    },
    driftDeclared: { state: "configured", query_suite: "extended" },
    driftLine: 'code_scanning_default_setup.query_suite: "extended" != "default"',
    knownAbsent: { threat_model: "remote" },
    getOnlyLanguage: [
      "javascript",
      '"javascript" is the spelling GitHub reports, not one the PATCH accepts; write "javascript-typescript"',
    ],
    seeded: {
      code_scanning: { state: "configured", languages: ["javascript", "typescript", "python"] },
    },
    languagesRead: ["javascript-typescript", "python"],
    undeclarable: [],
    applyPayload: { state: "configured", query_suite: "extended" },
    changeLine: "applied code scanning default setup",
    conflict409:
      "code_scanning_default_setup: PATCH /repos/o/r/code-scanning/default-setup: 409 Conflict. A code scanning default setup configuration run is already in progress on the repository; re-run the workflow after it finishes",
    denied403:
      "code_scanning_default_setup: the token was denied PATCH " +
      '/repos/o/r/code-scanning/default-setup: 403 Forbidden. To fix, grant "Administration" ' +
      'or "Code scanning alerts" (read and write) under the PAT\'s Repository permissions; a ' +
      "403 on this endpoint can also mean GitHub Advanced Security (code security) is not " +
      "enabled on the repository, or the repository is archived",
  },
  code_quality_setup: {
    section: codeQualitySetupSection,
    path: "/repos/o/r/code-quality/setup",
    live: {
      state: "configured",
      languages: ["javascript-typescript", "python"],
      runner_type: "standard",
    },
    driftDeclared: { state: "configured", ai_findings_option: "on_push" },
    driftLine:
      'code_quality_setup.ai_findings_option: declared "on_push" but the API response has no such field (new or write-only field?)',
    knownAbsent: { ai_findings_option: "on_push" },
    getOnlyLanguage: [
      "rust",
      '"rust" is reported by GitHub but the PATCH cannot set it; remove it from the settings file (it stays as GitHub detected it)',
    ],
    seeded: { code_quality: { state: "configured", languages: ["python", "rust"] } },
    languagesRead: ["python"],
    undeclarable: ["rust"],
    applyPayload: { state: "configured", ai_findings_option: "disabled" },
    changeLine: "applied code quality setup",
    conflict409:
      "code_quality_setup: PATCH /repos/o/r/code-quality/setup: 409 Conflict. A code quality setup configuration run is already in progress on the repository; re-run the workflow after it finishes",
    denied403:
      "code_quality_setup: the token was denied PATCH /repos/o/r/code-quality/setup: 403 " +
      'Forbidden. To fix, grant "Administration" (read and write) under the PAT\'s Repository ' +
      "permissions; a 403 on this endpoint can also mean code quality is unavailable on the " +
      "repository, or the repository is archived",
  },
};

type ReadPort<K extends SetupKey> = PlanContext<SetupSectionModule<K>["endpoints"]>["read"];
type _ReadPortIsTheGetAlone = MustBeNever<
  Exclude<{ [K in SetupKey]: keyof ReadPort<K> }[SetupKey], "get">
>;
/** The helpers the GET binds; deferred through `infer` so the mapped type resolves per concrete key. */
type GetHelpers<K extends SetupKey> =
  ReadPort<K> extends { readonly get: infer G } ? keyof G : never;
type _DeniedReadHasNoProbe = MustBeNever<
  Extract<{ [K in SetupKey]: GetHelpers<K> }[SetupKey], "probeAbsent" | "tryCall">
>;

type DeclaredOf<K extends SetupKey> = SectionInput<K>;
({ query_suite: "extended" }) satisfies DeclaredOf<"code_scanning_default_setup">;
// @ts-expect-error ai_findings_option belongs to code_quality_setup alone
({ ai_findings_option: "disabled" }) satisfies DeclaredOf<"code_scanning_default_setup">;
({ ai_findings_option: "disabled" }) satisfies DeclaredOf<"code_quality_setup">;
// @ts-expect-error query_suite belongs to code_scanning_default_setup alone
({ query_suite: "extended" }) satisfies DeclaredOf<"code_quality_setup">;

/**
 * A stateful fake: the GET serves what the PATCH last merged over the seeded body, and the PATCH answers the spec's plain 200, an EMPTY object, so
 * the change thunk sees the real wire shape.
 */
function liveSetup(
  path: string,
  seed: Record<string, unknown>,
): GitHubClient & { writes: string[] } {
  let live = seed;
  return {
    writes: [],
    async tryRequest(method, requestPath, payload) {
      if (requestPath !== path) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      if (method === "PATCH") {
        this.writes.push(`${method} ${requestPath}`);
        live = { ...live, ...(payload as Record<string, unknown>) };
        return { data: {} };
      }
      return { data: live };
    },
    async tryGraphql() {
      throw new Error("the setup sections issue no GraphQL");
    },
  };
}

const tools = { resolveSecret: () => "" };

describe.each(Object.values(SETUP_FACTS).map((facts) => [facts.section.key, facts] as const))(
  "%s",
  (_key, facts) => {
    // The erased view: one plan() signature over either section's declared value.
    const section: SectionModule<SetupKey> = facts.section;
    const snapshotting: SnapshotSection = facts.section;
    const {
      path,
      live,
      driftDeclared,
      driftLine,
      knownAbsent,
      getOnlyLanguage,
      seeded,
      languagesRead,
      undeclarable,
      applyPayload,
      changeLine,
      conflict409,
      denied403,
    } = facts;
    const plan = async (api: GitHubClient, declared: Declared) =>
      unwrap(
        await section.plan(planContext(section, api, REPO), validatedInput(section.key, declared)),
      );

    /** Every issue of a parse, as [path, message], so a refusal is pinned whole. */
    const issuesOf = (document: unknown): [string, string][] | "accepted" => {
      const parsed = section.shape.safeParse(document);
      return parsed.success
        ? "accepted"
        : parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]);
    };

    const getOnlyKey = (key: string) =>
      `${JSON.stringify(key)} is reported by GitHub but the PATCH does not accept it, so declaring it could only drift; remove it from the settings file`;

    test("what the settings file alone shows to be wrong is refused at parse, naming the key and the fix, instead of a 422 or drift that never converges", () => {
      const [language, languageIssue] = getOnlyLanguage;
      const refused: [string, unknown, [string, string][]][] = [
        [
          "the GET's schedule and updated_at, which no PATCH takes",
          { state: "configured", schedule: "weekly", updated_at: "2026-07-01T10:00:00Z" },
          [
            ["schedule", getOnlyKey("schedule")],
            ["updated_at", getOnlyKey("updated_at")],
          ],
        ],
        [
          "a language only the GET reports",
          { languages: ["python", language] },
          [["languages.1", languageIssue]],
        ],
        [
          "a labeled runner without its label",
          { runner_type: "labeled", runner_label: null },
          [
            [
              "runner_label",
              'runner_type: "labeled" needs a runner_label naming the self-hosted runner label; declare runner_label, or set runner_type: "standard"',
            ],
          ],
        ],
        [
          "a label under the standard runner",
          { runner_type: "standard", runner_label: "gpu" },
          [
            [
              "runner_label",
              'runner_label "gpu" is declared under runner_type: "standard", where GitHub ignores it; set runner_type: "labeled", or remove runner_label',
            ],
          ],
        ],
        [
          "a label without a runner type",
          { runner_label: "gpu" },
          [
            [
              "runner_label",
              'runner_label "gpu" is declared without runner_type, where GitHub ignores it; set runner_type: "labeled", or remove runner_label',
            ],
          ],
        ],
      ];
      for (const [why, document, issues] of refused) {
        expect(issuesOf(document), why).toEqual(issues);
      }
      // A name off both vocabularies that is a prototype property: zod's own enum refusal (whose
      // wording is zod's to change), never the getOnly fold wording, since the fold table is read as
      // own properties only. Both fold messages name GitHub; zod's does not.
      const prototypeName = section.shape.safeParse({ languages: ["toString"] });
      const [issue, ...more] = prototypeName.error?.issues ?? [];
      expect(more).toEqual([]);
      expect([issue?.code, issue?.path.join(".")]).toEqual(["invalid_value", "languages.0"]);
      expect(issue?.message).not.toMatch(/GitHub/);
      // The pairs GitHub takes, and a clearing null label under the standard runner, still parse.
      for (const accepted of [
        { state: "configured", runner_type: "labeled", runner_label: "gpu" },
        { runner_type: "standard", runner_label: null },
        { languages: languagesRead },
      ]) {
        expect(issuesOf(accepted)).toBe("accepted");
      }
    });

    test("a key outside the slice that the GET never echoes is noted as never converging; a slice key the GET lacks is plain drift", async () => {
      const api = new MockApi({ [`GET ${path}`]: { data: live } });
      // A prototype property's name is a phantom like any other typo, not a slice key.
      const typo = { ...knownAbsent, runer_type: "standard", toString: "standard" };
      const phantom = await plan(api, typo);
      const noun = changeLine.slice("applied ".length);
      expect(phantom.notes).toEqual([
        `${section.key}: declared keys "runer_type", "toString" do not exist on the live ${noun}, ` +
          "so if GitHub ignores them this PATCH will re-run on every apply without converging. " +
          "Fix the key name, or remove it from the settings file",
      ]);
      expect(phantom.ops.map((op) => [op.role, op.payload])).toEqual([["update", typo]]);
      const known = await plan(api, knownAbsent);
      expect(known.notes).toEqual([]);
      expect(known.ops.map((op) => [op.role, op.payload])).toEqual([["update", knownAbsent]]);
    });

    test("languages the GET spells its own way fold onto the PATCH's names for compare and snapshot; a name with no declarable form is left out with a note, and the snapshot round-trips", async () => {
      const api = registryFake(seeded);
      const { snapshot, plan: replanned } = await proveSnapshotRoundTrip(snapshotting, api);
      const reason = (left: string) =>
        undeclarable.length === 0
          ? []
          : [
              `${section.key}.languages: left out of the ${left} - GitHub reports "rust", which the PATCH's languages vocabulary has no value for, so it stays as GitHub detected it`,
            ];
      expect(snapshot).toEqual({
        value: { state: "configured", languages: languagesRead },
        notes: reason("snapshot"),
      });
      expect(replanned.ops).toEqual([]);
      expect(replanned.notes).toEqual(reason("compare"));
      // Declared in the PATCH's spelling, reordered: still converged against the GET's.
      const reordered = await plan(api, { languages: reversed(languagesRead) });
      expect(reordered.ops).toEqual([]);
      expect(api.writes).toEqual([]);
    });

    test("plans the verbatim PATCH on declared-keys-only drift, languages as a set", async () => {
      const api = new MockApi({ [`GET ${path}`]: { data: live } });
      expect(Object.keys(planContext(section, api, REPO).read)).toEqual(["get"]);
      const drifted = await plan(api, driftDeclared);
      expect(drifted.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
        ["update", driftDeclared, [driftLine]],
      ]);
      expect(drifted.notes).toEqual([]);
      expect(drifted.drift).toEqual([]);
      const reordered = await plan(api, { languages: reversed(live.languages) });
      expect(reordered.ops).toEqual([]);
      expect(api.mutations()).toEqual([]);
    });

    test("executing the plan converges: one PATCH, then nothing", async () => {
      const api = liveSetup(path, live);
      const { changes, second } = await provePlanIdempotent(section, api, applyPayload);
      expect(changes).toEqual([changeLine]);
      expect(api.writes).toEqual([`PATCH ${path}`]);
      expect(second).toEqual({ ops: [], notes: [], drift: [] });
    });

    test("a 202 configuration run is named in the change line, URL included", async () => {
      const api = new MockApi({
        [`GET ${path}`]: { data: live },
        [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
      });
      const planned = await plan(api, driftDeclared);
      const execution = await executePlan(planned, section, api, REPO, tools);
      expect(execution).toEqual({
        status: "applied",
        changes: [
          `${changeLine}; GitHub started configuration run 42 (https://example.test/runs/42) to roll it out, and the settings take effect when it finishes`,
        ],
        notes: [],
        landed: 1,
      });
    });

    test.each([
      ["409", 409, "Conflict", conflict409],
      ["403", 403, "Forbidden", denied403],
    ])(
      "a %s on the PATCH fails with the section's own advice",
      async (_status, status, message, advice) => {
        const api = new MockApi({
          [`GET ${path}`]: { data: live },
          [`PATCH ${path}`]: { error: { status, message, body: "" } },
        });
        const execution = await executePlan(
          await plan(api, driftDeclared),
          section,
          api,
          REPO,
          tools,
        );
        expect(execution.status).toBe("failed");
        expect((execution as { failure: SectionFailure }).failure.message).toBe(advice);
      },
    );
  },
);
