import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { parse as parseYamlDoc, stringify as stringifyYaml } from "yaml";
import {
  type ApplyReport,
  applyRepository,
  checkRepository,
  collectingIo,
  describeProblem,
  type GitHubClient,
  mergeSettings,
  parseRepoSlug,
  SectionSelection,
  snapshotRepositories,
  snapshotRepository,
  type ValidatedSettings,
  validateSettings,
} from "../../src/index.js";
import {
  SECRET_RESPONSE_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
  SNAPSHOT_SCHEMA_URL,
} from "../../src/internal.js";
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
      ok({ settings, log: [] }),
    );
  });

  test.each<[what: string, unknown: Record<string, unknown>, line: string]>([
    [
      "one unknown key",
      { typo: 1 },
      'ignoring unknown top-level section outside the "sections" allowlist: typo. Upgrade the action to a version that knows it, or remove it from fleet.yml',
    ],
    [
      "two unknown keys",
      { typo: 1, bogus: 2 },
      'ignoring unknown top-level sections outside the "sections" allowlist: typo, bogus. Upgrade the action to a version that knows them, or remove them from fleet.yml',
    ],
  ])(
    "%s outside the sections allowlist is a returned warning, not a printed one",
    (_what, unknown, line) => {
      expect(
        validateSettings(
          { repository: { has_wiki: false }, ...unknown },
          {
            source: "fleet.yml",
            sections: SectionSelection.of({ only: ["repository"] })._unsafeUnwrap(),
          },
        ),
      ).toEqual(ok({ settings, log: [{ level: "warning", line }] }));
    },
  );

  test("an invalid document comes back as its problem, naming the default source", () => {
    expect(validateSettings([1])).toEqual(
      err({ code: "settings-not-mapping", source: "the settings document", shape: "list" }),
    );
  });
});

describe("checkRepository and applyRepository", () => {
  test("check diffs without writing and returns the lines it printed", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    const result = await checkRepository(api, repo, settings);
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
    const result = await applyRepository(api, repo, settings, { io: collected.io });
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

describe("a caller-supplied client that echoes a secret", () => {
  // JSON escaping turns the quote into \", so the collected log's exact-literal mask would miss the echo; outcomes[].detail
  // is never masked at all. The withholding must therefore happen before either sees the error.
  const plaintext = 'hook-"canary"-9f3a';
  const hooks = branded({
    webhooks: [
      { config: { url: "https://x.test/h", secret: "$WEBHOOK_SECRET" }, events: ["push"] },
    ],
  });
  const echoing = (
    create: () => Promise<
      { data: unknown } | { error: { status: number; message: string; body: string } }
    >,
  ) => {
    const reads = new MockApi({ "GET /repos/o/r/hooks?per_page=100&page=1": { data: [] } });
    const marks: Array<true | undefined> = [];
    const client: GitHubClient = {
      tryRequest: (method, path, payload, options) => {
        if (method !== "POST") {
          return reads.tryRequest(method, path, payload, options);
        }
        marks.push(options?.carriesSecret === true ? true : undefined);
        return create();
      },
      tryGraphql: (op, variables, slug, options) => reads.tryGraphql(op, variables, slug, options),
    };
    return { client, marks };
  };
  const failed = (detail: string): ApplyReport => ({
    repo: "o/r",
    result: "failed",
    outcomes: [{ key: "webhooks", status: "failed", detail: [detail] }],
    preflightDenied: [],
    log: [{ level: "error", line: detail }],
  });

  test.each([
    {
      answer:
        "returns a message-only rate limit, which must still fail the run rather than skip the section",
      create: async () => ({
        error: {
          status: 403,
          message: `API rate limit exceeded while storing ${plaintext}`,
          body: "",
        },
      }),
      detail: `webhooks: creating webhook "https://x.test/h" failed - POST /repos/o/r/hooks: 403 ${SECRET_RESPONSE_WITHHELD}. The API rate limit was hit; re-run the workflow after the limit resets, or use a token with a higher rate limit`,
    },
    {
      answer: "returns a 422 whose message quotes the value",
      create: async () => ({
        error: {
          status: 422,
          message: `Validation Failed: secret ${JSON.stringify(plaintext)} is too weak`,
          body: "",
        },
      }),
      detail: `webhooks: creating webhook "https://x.test/h" failed - POST /repos/o/r/hooks: 422 ${SECRET_RESPONSE_WITHHELD}. The API rejected the request; fix the "webhooks" values in the settings file to satisfy the message above`,
    },
    {
      answer: "throws a transport error quoting the request body",
      create: async (): Promise<{ data: unknown }> => {
        throw new Error(
          `fetch failed; body was ${JSON.stringify({ config: { secret: plaintext } })}`,
        );
      },
      detail: `webhooks: POST /repos/o/r/hooks failed: ${SECRET_TRANSPORT_WITHHELD}. Check network connectivity from the runner to the GitHub API, then re-run`,
    },
  ])("apply withholds the failure when the client $answer", async ({ create, detail }) => {
    const { client, marks } = echoing(create);
    // "warn" is the policy under which a misread denial would turn the failure into a skipped section.
    const result = await applyRepository(client, repo, hooks, {
      onMissingPermission: "warn",
      secretEnv: { WEBHOOK_SECRET: plaintext },
    });
    expect(marks).toEqual([true]);
    expect(result).toEqual(failed(detail));
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});

describe("the sections knob", () => {
  test("restricts the run to the allowlist: the excluded section is reported without a request", async () => {
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    const sections = SectionSelection.of({ only: ["labels"] })._unsafeUnwrap();
    const result = await checkRepository(api, repo, settings, { sections });
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([["repository", "excluded"]]);
    expect(api.calls).toEqual([]);
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
  /** An ISO-8601 UTC instant, the form `takenAt` and its notice spell the moment in. */
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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
      yaml: expect.any(String),
      takenAt: expect.stringMatching(ISO_INSTANT),
      log: [{ level: "notice", line: SECRET_NOTE }],
    });
    if (report.yaml === undefined) {
      throw new Error("a snapshot result carries its file");
    }
    // The header, line by line and by equality: the pin is a URL, never a pattern, and no line dates the file.
    const [pin, note, first] = report.yaml.split("\n");
    expect(pin).toBe(`# yaml-language-server: $schema=${SNAPSHOT_SCHEMA_URL}`);
    expect([note, first]).toEqual([`# ${SECRET_NOTE}`, "labels:"]);
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
      takenAt: expect.stringMatching(ISO_INSTANT),
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

describe("mergeSettings", () => {
  const fleet = {
    name: "fleet.yml",
    doc: { repository: { has_wiki: true }, labels: [{ name: "bug", color: "d73a4a" }] },
  };
  const team = {
    name: "team.yml",
    doc: { repository: { has_wiki: false, has_issues: true, enable_vulnerability_alerts: true } },
  };

  test("folds the layers as mode: render does and renders the file the rendered-file gets", () => {
    const report = mergeSettings([fleet, team])._unsafeUnwrap();
    expect(report.settings).toEqual(
      branded({
        repository: { has_wiki: false, has_issues: true, enable_vulnerability_alerts: true },
        labels: { _undeclared: "delete", entries: [{ name: "bug", color: "d73a4a" }] },
      }),
    );
    // The settings are the validated parse (declared keys in the schema's order, unknown keys as the layers
    // spelled them); the yaml is the fold in the canonical order, its unknown keys by code point.
    expect(Object.keys(report.settings.repository ?? {})).toEqual([
      "has_issues",
      "has_wiki",
      "enable_vulnerability_alerts",
    ]);
    expect(report.yaml).toBe(
      [
        "repository:",
        "  has_issues: true",
        "  has_wiki: false",
        "  enable_vulnerability_alerts: true",
        "labels:",
        "  _undeclared: delete",
        "  entries:",
        "    - name: bug",
        "      color: d73a4a",
        "",
      ].join("\n"),
    );
    expect(report.notices).toEqual([]);
    expect(report.log).toEqual([]);
  });

  test("a node the layer aliases is written per occurrence, never as a YAML anchor the reader would cap", () => {
    const protection = { enforce_admins: true };
    const branches = Array.from({ length: 101 }, (_, i) => ({ name: `b${i}`, protection }));
    const report = mergeSettings([{ name: "fleet.yml", doc: { branches } }])._unsafeUnwrap();
    expect(report.yaml).not.toMatch(/[&*]/);
    // Branches keep their written order (it is the rules' priority), so the round trip is exact.
    expect(parseYamlDoc(report.yaml)).toEqual({ branches });
  });

  test("a removal is a notice naming the layer and the entry, and the rendered file omits both the marker and the lower entry", () => {
    const removed = mergeSettings([
      fleet,
      { name: "repo.yml", doc: { labels: [{ name: "bug", _remove: true }] } },
    ])._unsafeUnwrap();
    expect(removed.notices).toEqual([{ layer: "repo.yml", path: "labels[0]" }]);
    expect(removed.yaml).toBe(
      "repository:\n  has_wiki: true\nlabels:\n  _undeclared: delete\n  entries: []\n",
    );
  });
});

describe("the io knob", () => {
  test("a caller-supplied Io receives the warnings and the report's log stays empty", () => {
    const collected = collectingIo();
    const report = validateSettings(
      { repository: { has_wiki: false }, typo: 1 },
      { sections: SectionSelection.of({ only: ["repository"] })._unsafeUnwrap(), io: collected.io },
    )._unsafeUnwrap();
    expect(report.log).toEqual([]);
    expect(collected.lines.map((entry) => entry.level)).toEqual(["warning"]);
  });
});
