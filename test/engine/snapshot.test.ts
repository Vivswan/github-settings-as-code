/**
 * The snapshot pipeline over the e2e mock's merged handlers: which sections it reads back and
 * which it reports unsupported, how a denial classifies under each policy, the guard against a
 * section producing a value its own schema rejects, and the file rendering.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { SectionSelection } from "../../src/engine/section-selection.js";
import {
  type RenderableSnapshot,
  renderSnapshotYaml,
  snapshotRepository,
} from "../../src/engine/snapshot.js";
import type { GithubClient } from "../../src/github/api.js";
import type { Io } from "../../src/io.js";
import { maskRegistry } from "../../src/io.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { pagesSection } from "../../src/sections/pages/index.js";
import { SECTIONS } from "../../src/sections/registry.js";
import type { LiveState } from "../e2e/mock/state.js";
import { registryFake } from "../sections/fragment-fake.js";
import { REPO } from "../sections/section-run.js";

function captureIo(): { io: Io; annotations: string[] } {
  const annotations: string[] = [];
  return {
    io: {
      annotate: (level, message) => annotations.push(`${level}: ${message}`),
      log: () => {},
      debug: () => {},
      summary: () => {},
      output: () => {},
      ...maskRegistry(() => {}),
    },
    annotations,
  };
}

/** A client that answers the fine-grained denial (404) to GETs whose path matches `denied`. */
function denying(api: GithubClient, denied: RegExp): GithubClient {
  return {
    tryRequest: (method, path, payload, options) =>
      method === "GET" && denied.test(path)
        ? Promise.resolve({ error: { status: 404, message: "Not Found", body: "" } })
        : api.tryRequest(method, path, payload, options),
    tryGraphql: (op, variables, slug) => api.tryGraphql(op, variables, slug),
  };
}

const LIVE: LiveState = {
  labels: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
  actions_secrets: [
    {
      name: "DEPLOY_TOKEN",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  actions_variables: [
    {
      name: "REGION",
      value: "eu-west-1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
};

const opts = (policy: "fail" | "warn" = "fail") => ({
  repo: REPO,
  sections: SectionSelection.ALL,
  onMissingPermission: policy,
});

const NOTHING = "nothing exists on the repository, so the section is omitted";

/** The sections without a snapshot handler, read off the registry so the test cannot go stale. */
const UNSUPPORTED = SECTIONS.filter((section) => section.snapshot === undefined).map((s) => s.key);

describe("snapshotRepository", () => {
  test("an all-grades token reads every supported section back and lists the rest unsupported", async () => {
    const api = registryFake(LIVE);
    const { io, annotations } = captureIo();
    const result = await snapshotRepository(api, opts(), io);
    expect(result.result).toBe("snapshot");
    expect(api.writes).toEqual([]);
    // The document holds exactly the sections with live state, in registry order.
    expect(Object.keys(result.settings ?? {})).toEqual([
      "labels",
      "actions_secrets",
      "workflows",
      "code_scanning_default_setup",
      "code_quality_setup",
      "actions_variables",
    ]);
    expect(result.settings?.labels).toEqual({
      _undeclared: "delete",
      entries: [{ name: "bug", color: "d73a4a", description: "Something is broken" }],
    });
    expect(result.settings?.actions_secrets).toEqual({
      _undeclared: "keep",
      entries: [{ name: "DEPLOY_TOKEN", value: "$SECRET_ACTIONS_DEPLOY_TOKEN" }],
    });
    // Every registered section has exactly one outcome, unsupported ones with their reason.
    expect(result.outcomes.map((o) => o.key)).toEqual(SECTIONS.map((s) => s.key));
    expect(UNSUPPORTED).toEqual([
      "repository",
      "rulesets",
      "environments",
      "branches",
      "actions",
      "check_suite_preferences",
    ]);
    expect(
      result.outcomes.filter((o) => o.status === "unsupported").map((o) => [o.key, o.detail]),
    ).toEqual(
      UNSUPPORTED.map((key) => [
        key,
        [
          key === "check_suite_preferences"
            ? "check_suite_preferences: GitHub exposes no read endpoint for this section, so there is nothing to snapshot; apply re-asserts the declared value on every run"
            : `${key}: snapshot is not implemented for this section yet`,
        ],
      ]),
    );
    expect(result.outcomes.find((o) => o.key === "actions_secrets")).toEqual({
      key: "actions_secrets",
      status: "snapshot",
      detail: [
        "actions_secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN before apply",
      ],
    });
    expect(result.outcomes.find((o) => o.key === "milestones")).toEqual({
      key: "milestones",
      status: "snapshot",
      detail: [NOTHING],
    });
    expect(annotations).toContain(
      "notice: actions_secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN before apply",
    );
  });

  test("a 404 on a gated absent-posture read keeps its empty reading and notes the denial it could be; an empty read without a 404, a public probe, and a present resource get no note", async () => {
    const denied = denying(registryFake(LIVE), /\/repos\/o\/r\/pages$|\/orgs\/o$/);
    const { io, annotations } = captureIo();
    const result = await snapshotRepository(
      denied,
      {
        ...opts(),
        sections: SectionSelection.of({ only: ["pages", "custom_properties"] })._unsafeUnwrap(),
      },
      io,
    );
    const note =
      "pages: GitHub answered GET /repos/{owner}/{repo}/pages with 404, read here as nothing to " +
      "snapshot. A fine-grained token missing the grant gets the same answer; if the repository " +
      'does have this resource, grant "Pages" (read and write) under the PAT\'s Repository ' +
      "permissions, then snapshot again";
    expect(result.result).toBe("snapshot");
    // The org probe is public and DID answer 404: a 404 there has one reading, so no such note.
    const personal =
      'custom_properties: owner "o" is a personal account, and custom properties require an organization-owned repository; nothing to snapshot';
    expect(result.outcomes).toEqual([
      { key: "pages", status: "snapshot", detail: [note, NOTHING] },
      { key: "custom_properties", status: "snapshot", detail: [personal, NOTHING] },
    ]);
    expect(annotations).toEqual([`notice: ${note}`, `notice: ${personal}`]);
    // The controls: a present site reads back and carries no note, and a section that read
    // nothing WITHOUT a 404 (an empty 200 listing) carries none either.
    const live = registryFake({
      pages: { build_type: "workflow", source: { branch: "main", path: "/" } },
    });
    const present = await snapshotRepository(
      live,
      { ...opts(), sections: SectionSelection.of({ only: ["pages"] })._unsafeUnwrap() },
      captureIo().io,
    );
    expect(present.outcomes).toEqual([{ key: "pages", status: "snapshot", detail: [] }]);
    const empty = spyOn(pagesSection, "snapshot").mockImplementation(async (ctx) => {
      await ctx.read.get.probeAbsent();
      return { value: undefined, notes: [] };
    });
    try {
      const quiet = captureIo();
      const nothing = await snapshotRepository(
        live,
        { ...opts(), sections: SectionSelection.of({ only: ["pages"] })._unsafeUnwrap() },
        quiet.io,
      );
      expect(nothing.outcomes).toEqual([{ key: "pages", status: "snapshot", detail: [NOTHING] }]);
      expect(quiet.annotations).toEqual([]);
    } finally {
      empty.mockRestore();
    }
  });

  test("the sections allowlist limits the run to the named sections", async () => {
    const api = registryFake(LIVE);
    const result = await snapshotRepository(
      api,
      {
        ...opts(),
        sections: SectionSelection.of({ only: ["labels", "repository"] })._unsafeUnwrap(),
      },
      captureIo().io,
    );
    expect(result.result).toBe("snapshot");
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["repository", "unsupported"],
      ["labels", "snapshot"],
    ]);
    expect(Object.keys(result.settings ?? {})).toEqual(["labels"]);
  });

  test("a denied section is skipped under warn (partial) and fails the run under fail (no document)", async () => {
    const denied = denying(registryFake(LIVE), /\/repos\/o\/r\/labels(\?|$)/);
    const warn = captureIo();
    const partial = await snapshotRepository(denied, opts("warn"), warn.io);
    expect(partial.result).toBe("partial");
    expect(partial.outcomes.find((o) => o.key === "labels")).toEqual({
      key: "labels",
      status: "skipped",
      detail: [expect.stringContaining("the token was denied GET /repos/o/r/labels")],
    });
    expect(Object.keys(partial.settings ?? {})).not.toContain("labels");
    expect(partial.settings?.actions_variables).toBeDefined();
    expect(warn.annotations.filter((a) => a.startsWith("warning: labels: skipped"))).toHaveLength(
      1,
    );

    const fail = captureIo();
    const failed = await snapshotRepository(denied, opts("fail"), fail.io);
    expect(failed.result).toBe("failed");
    expect(failed.settings).toBeUndefined();
    expect(failed.outcomes.find((o) => o.key === "labels")?.status).toBe("failed");
    expect(
      fail.annotations.filter((a) => a.startsWith("error: labels: not snapshotted")),
    ).toHaveLength(1);
  });

  test("a section whose snapshot throws fails alone; the document still carries the rest", async () => {
    const stubbed = spyOn(labelsSection, "snapshot").mockRejectedValue(new Error("boom"));
    try {
      const result = await snapshotRepository(registryFake(LIVE), opts(), captureIo().io);
      expect(result.result).toBe("partial");
      expect(result.outcomes.find((o) => o.key === "labels")).toEqual({
        key: "labels",
        status: "failed",
        detail: ["labels: boom"],
      });
      expect(result.settings?.actions_variables).toBeDefined();
    } finally {
      stubbed.mockRestore();
    }
  });

  test("a section returning a value its own schema rejects fails the run with the validation error, never a document", async () => {
    const stubbed = spyOn(labelsSection, "snapshot").mockResolvedValue({
      value: { _undeclared: "sometimes", entries: [{ name: "bug" }] } as never,
      notes: ["a note the section still reported"],
    });
    try {
      const { io, annotations } = captureIo();
      const result = await snapshotRepository(registryFake(LIVE), opts(), io);
      expect(result.result).toBe("failed");
      expect(result.settings).toBeUndefined();
      expect(result.outcomes.find((o) => o.key === "labels")).toEqual({
        key: "labels",
        status: "failed",
        detail: [
          "a note the section still reported",
          expect.stringMatching(
            /^BUG: labels produced a snapshot its own schema rejects - the labels snapshot of o\/r has malformed section entries: labels\._undeclared: /,
          ),
        ],
      });
      expect(annotations.some((a) => a.startsWith("error: BUG: labels produced"))).toBe(true);
    } finally {
      stubbed.mockRestore();
    }
  });
});

describe("snapshotRepository shape guard", () => {
  test("a null 200 body on a whole-section read fails the section as a body outside the shape, never an omitted section", async () => {
    const fake = registryFake(LIVE);
    const nulling: GithubClient = {
      tryRequest: (method, path, payload, options) =>
        method === "GET" && path === "/repos/o/r/code-scanning/default-setup"
          ? Promise.resolve({ data: null })
          : fake.tryRequest(method, path, payload, options),
      tryGraphql: (op, variables, slug) => fake.tryGraphql(op, variables, slug),
    };
    const result = await snapshotRepository(
      nulling,
      {
        ...opts(),
        sections: SectionSelection.of({
          only: ["code_scanning_default_setup", "labels"],
        })._unsafeUnwrap(),
      },
      captureIo().io,
    );
    expect(result.result).toBe("failed");
    expect(result.settings).toBeUndefined();
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["labels", "snapshot"],
      ["code_scanning_default_setup", "failed"],
    ]);
    expect(result.outcomes[1]?.detail).toEqual([
      expect.stringMatching(
        /^BUG: code_scanning_default_setup produced a snapshot its own schema rejects - .*code_scanning_default_setup: Invalid input: expected object, received null/,
      ),
    ]);
  });
});

describe("pages null body", () => {
  test("a null 200 on the Pages GET fails the section as a body outside the shape, never `pages: null`", async () => {
    const fake = registryFake(LIVE);
    const nulling: GithubClient = {
      tryRequest: (method, path, payload, options) =>
        method === "GET" && path === "/repos/o/r/pages"
          ? Promise.resolve({ data: null })
          : fake.tryRequest(method, path, payload, options),
      tryGraphql: (op, variables, slug) => fake.tryGraphql(op, variables, slug),
    };
    const result = await snapshotRepository(
      nulling,
      { ...opts(), sections: SectionSelection.of({ only: ["pages"] })._unsafeUnwrap() },
      captureIo().io,
    );
    expect(result.result).toBe("partial");
    expect(Object.keys(result.settings ?? {})).toEqual([]);
    expect(result.outcomes).toEqual([
      {
        key: "pages",
        status: "failed",
        detail: [
          expect.stringMatching(
            /^pages: GET \/repos\/\{owner\}\/\{repo\}\/pages returned a body outside the documented shape - \(body\): Invalid input: expected object, received null/,
          ),
        ],
      },
    ]);
  });
});

describe("renderSnapshotYaml", () => {
  test("a message spanning several lines is commented line by line, so the file still parses", async () => {
    const stubbed = spyOn(labelsSection, "snapshot").mockRejectedValue(
      new Error("502 Bad Gateway\nupstream unavailable"),
    );
    try {
      const result = await snapshotRepository(
        registryFake(LIVE),
        {
          ...opts(),
          sections: SectionSelection.of({ only: ["labels", "actions_variables"] })._unsafeUnwrap(),
        },
        captureIo().io,
      );
      expect(result.result).toBe("partial");
      const rendered = renderSnapshotYaml(result as RenderableSnapshot, {
        schemaUrl: "https://example.test/settings.schema.json",
        timestamp: "2026-09-11T00:00:00Z",
      });
      expect(rendered.split("\n").slice(2, 4)).toEqual([
        "# labels: 502 Bad Gateway",
        "# labels: upstream unavailable",
      ]);
      expect(parseYaml(rendered)).toEqual({
        actions_variables: {
          _undeclared: "delete",
          entries: [{ name: "REGION", value: "eu-west-1" }],
        },
      });
    } finally {
      stubbed.mockRestore();
    }
  });

  test("pins the schema, dates the header, comments every outcome line, and writes the document", async () => {
    const result = await snapshotRepository(
      registryFake(LIVE),
      {
        ...opts(),
        sections: SectionSelection.of({
          only: ["labels", "actions_secrets", "check_suite_preferences"],
        })._unsafeUnwrap(),
      },
      captureIo().io,
    );
    expect(result.result).toBe("snapshot");
    const rendered = renderSnapshotYaml(result as RenderableSnapshot, {
      schemaUrl: "https://example.test/settings.schema.json",
      timestamp: "2026-09-11T00:00:00Z",
    });
    expect(rendered).toBe(
      [
        "# yaml-language-server: $schema=https://example.test/settings.schema.json",
        "# Snapshot of o/r taken 2026-09-11T00:00:00Z",
        "# actions_secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN before apply",
        "# check_suite_preferences: GitHub exposes no read endpoint for this section, so there is nothing to snapshot; apply re-asserts the declared value on every run",
        "labels:",
        "  _undeclared: delete",
        "  entries:",
        "    - name: bug",
        "      color: d73a4a",
        "      description: Something is broken",
        "actions_secrets:",
        "  _undeclared: keep",
        "  entries:",
        "    - name: DEPLOY_TOKEN",
        "      value: $SECRET_ACTIONS_DEPLOY_TOKEN",
        "",
      ].join("\n"),
    );
  });
});
