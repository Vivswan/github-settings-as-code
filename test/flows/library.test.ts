import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { parse as parseYamlDoc, stringify as stringifyYaml } from "yaml";
import {
  applyRepository,
  checkRepository,
  collectingIo,
  describeProblem,
  parseRepoSlug,
  renderMergedYaml,
  SectionSelection,
  SNAPSHOT_SCHEMA_URL,
  snapshotRepositories,
  snapshotRepository,
  type ValidatedSettings,
  validateSettings,
} from "../../src/index.js";
import { MockApi } from "../mock-api.js";

const repo = parseRepoSlug("o/r")._unsafeUnwrap();

/** The brand is minted only by validation, so the tests' documents pass through it. */
function branded(doc: unknown): ValidatedSettings {
  return validateSettings(doc).match(
    (validated) => validated.settings,
    (problem) => {
      throw new Error(describeProblem(problem));
    },
  );
}
const settings = branded({ repository: { has_wiki: false } });

describe("validateSettings", () => {
  test("a valid document comes back branded with no warnings", () => {
    expect(validateSettings({ repository: { has_wiki: false } })).toEqual(
      ok({ settings, warnings: [] }),
    );
  });

  test("an unknown key outside the sections allowlist is a returned warning, not a printed one", () => {
    expect(
      validateSettings(
        { repository: { has_wiki: false }, typo: 1 },
        { source: "fleet.yml", sections: new Set(["repository"]) },
      ),
    ).toEqual(
      ok({
        settings,
        warnings: [
          'ignoring unknown top-level section(s) outside the "sections" allowlist: typo. Upgrade the action to a version that knows them, or remove them from fleet.yml',
        ],
      }),
    );
  });

  test("an invalid document comes back as its problem, naming the default source", () => {
    expect(validateSettings([1])).toEqual(
      err({ code: "settings-not-mapping", source: "the settings document", shape: "list" }),
    );
  });
});

describe("checkRepository and applyRepository", () => {
  test("check diffs without writing and returns the lines it printed", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    const result = await checkRepository(api, {
      repo,
      settings,
      onMissingPermission: "fail",
      sections: SectionSelection.ALL,
    });
    expect(api.mutations()).toEqual([]);
    expect(result).toEqual({
      repo: "o/r",
      result: "drift",
      outcomes: [
        { key: "repository", status: "drift", detail: ["repository.has_wiki: false != true"] },
      ],
      preflightDenied: [],
      log: [{ line: "drift: repository.has_wiki: false != true" }],
    });
  });

  test("apply writes the declared keys; a caller-supplied Io receives the lines and the log stays empty", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }).allowMutations(
      "PATCH /repos/o/r",
    );
    const collected = collectingIo();
    const result = await applyRepository(
      api,
      {
        repo,
        settings,
        onMissingPermission: "fail",
        sections: SectionSelection.ALL,
      },
      collected.io,
    );
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r", payload: { has_wiki: false } },
    ]);
    expect(result).toEqual({
      repo: "o/r",
      result: "applied",
      outcomes: [
        { key: "repository", status: "applied", detail: ["patched repository fields: has_wiki"] },
      ],
      preflightDenied: [],
      log: [],
    });
    expect(collected.lines).toEqual([{ line: "repository: patched repository fields: has_wiki" }]);
  });
});

describe("the section selection a library call runs under", () => {
  test("a required section outside the allowlist is the problem, and no check runs", async () => {
    // The engine reports an excluded section without attempting it, so this
    // pair would pass green having proven nothing; the selection refuses it
    // before checkRepository can be given one.
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    const outcome = await SectionSelection.of({
      only: ["repository"],
      required: ["labels"],
    }).match(
      (sections) => checkRepository(api, { repo, settings, onMissingPermission: "fail", sections }),
      (problem) => problem,
    );
    expect(outcome).toEqual({ code: "required-sections-excluded", excluded: ["labels"] });
    expect(api.calls).toEqual([]);
  });
});

describe("renderMergedYaml", () => {
  test("is the document's YAML serialization, byte for byte", () => {
    expect(renderMergedYaml(settings)).toBe(stringifyYaml(settings));
    expect(renderMergedYaml(settings)).toBe("repository:\n  has_wiki: false\n");
  });
});

describe("snapshotRepository and snapshotRepositories", () => {
  const STAMPS = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  const routes = (slug: string) => ({
    [`GET /repos/${slug}/labels?per_page=100&page=1`]: {
      data: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
    },
    [`GET /repos/${slug}/actions/secrets?per_page=100&page=1`]: {
      data: { total_count: 1, secrets: [{ name: "DEPLOY_TOKEN", ...STAMPS }] },
    },
  });
  const sections = SectionSelection.of({ only: ["labels", "actions_secrets"] })._unsafeUnwrap();
  const SECRET_NOTE =
    "actions_secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN before apply";

  test("reads the allowed sections back, renders the file, and returns the lines when no Io is given", async () => {
    const api = new MockApi(routes("o/r"));
    const report = await snapshotRepository(api, repo, { sections });
    expect(api.mutations()).toEqual([]);
    expect(report).toEqual({
      repo: "o/r",
      result: "snapshot",
      settings: branded({
        labels: {
          _undeclared: "delete",
          entries: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
        },
        actions_secrets: {
          _undeclared: "keep",
          entries: [{ name: "DEPLOY_TOKEN", value: "$SECRET_ACTIONS_DEPLOY_TOKEN" }],
        },
      }),
      outcomes: [
        { key: "labels", status: "snapshot", detail: [] },
        { key: "actions_secrets", status: "snapshot", detail: [SECRET_NOTE] },
      ],
      yaml: expect.stringMatching(
        new RegExp(
          `^# yaml-language-server: \\$schema=${SNAPSHOT_SCHEMA_URL.replaceAll(".", "\\.")}\n# Snapshot of o/r taken \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\n# actions_secrets: ${SECRET_NOTE.replaceAll("[", "\\[").replaceAll("]", "\\]")}\nlabels:\n`,
        ),
      ),
      log: [{ level: "notice", line: `actions_secrets: ${SECRET_NOTE}` }],
    });
    if (report.yaml === undefined) {
      throw new Error("a snapshot result carries its file");
    }
    expect(stringifyYaml(parseYamlDoc(report.yaml))).toBe(stringifyYaml(report.settings));
  });

  test("a denial under fail is a failed report with no yaml; a caller-supplied Io receives the lines and the log stays empty", async () => {
    const api = new MockApi({});
    const collected = collectingIo();
    const report = await snapshotRepository(api, repo, {
      sections: SectionSelection.of({ only: ["labels"] })._unsafeUnwrap(),
      io: collected.io,
    });
    expect(report).toEqual({
      repo: "o/r",
      result: "failed",
      outcomes: [
        {
          key: "labels",
          status: "failed",
          detail: [expect.stringMatching(/^the token was denied GET \/repos\/o\/r\/labels/)],
        },
      ],
      log: [],
    });
    expect(collected.lines).toEqual([
      {
        level: "error",
        line: expect.stringMatching(/^labels: not snapshotted - the token was denied GET/),
      },
    ]);
  });

  test("snapshotRepositories reports each target in order; a failed target never stops the next", async () => {
    const api = new MockApi(routes("o/b"));
    const reports = await snapshotRepositories(
      api,
      [parseRepoSlug("o/a")._unsafeUnwrap(), parseRepoSlug("o/b")._unsafeUnwrap()],
      { sections: SectionSelection.of({ only: ["labels"] })._unsafeUnwrap() },
    );
    expect(
      reports.map((report) => [report.repo, report.result, report.yaml === undefined]),
    ).toEqual([
      ["o/a", "failed", true],
      ["o/b", "snapshot", false],
    ]);
  });
});
