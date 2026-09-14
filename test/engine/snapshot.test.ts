/**
 * The snapshot pipeline over the e2e mock's merged handlers: which sections it reads back and
 * which it reports unsupported, how a denial classifies under each policy, the guard against a
 * section producing a value its own schema rejects, and the file rendering.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SectionSelection } from "../../src/engine/section-selection.js";
import {
  type RenderableSnapshot,
  renderSnapshotYaml,
  snapshotRepository,
} from "../../src/engine/snapshot.js";
import type { GitHubClient } from "../../src/github/api.js";
import {
  endpointPermission,
  type SectionMeta,
  sectionOperations,
} from "../../src/sections/contract/module.js";
import { labelsSection } from "../../src/sections/labels/index.js";
import { pagesSection } from "../../src/sections/pages/index.js";
import { allGraphqlOps, SECTIONS } from "../../src/sections/registry.js";
import { matchEndpoint } from "../e2e/mock/dispatch.js";
import type { LiveState } from "../e2e/mock/state.js";
import { captureIo } from "../io/capture.js";
import { registryFake } from "../sections/fragment-fake.js";
import { REPO } from "../sections/section-run.js";
import type { Row } from "../sections/snapshot-roundtrip.js";

/** A client that answers `status` (the fine-grained denial is 404) to GETs whose path matches `denied`. */
function denying(api: GitHubClient, denied: RegExp, status: 403 | 404 = 404): GitHubClient {
  return {
    tryRequest: (method, path, payload, options) =>
      method === "GET" && denied.test(path)
        ? Promise.resolve({
            error: { status, message: status === 404 ? "Not Found" : "Forbidden", body: "" },
          })
        : api.tryRequest(method, path, payload, options),
    tryGraphql: (op, variables, slug) => api.tryGraphql(op, variables, slug),
  };
}

/** A client that records every read it forwards, as "GET <path>" or "GRAPHQL <opName>". */
function recording(api: GitHubClient, reads: Set<string>): GitHubClient {
  return {
    tryRequest: (method, path, payload, options) => {
      if (method === "GET") {
        reads.add(`GET ${path}`);
      }
      return api.tryRequest(method, path, payload, options);
    },
    tryGraphql: (op, variables, slug) => {
      if (op.kind === "read") {
        reads.add(`GRAPHQL ${op.name}`);
      }
      return api.tryGraphql(op, variables, slug);
    },
  };
}

/** A client that answers one recorded read with the classic 403 (FORBIDDEN for a GraphQL read). */
function denyingRead(api: GitHubClient, read: string): GitHubClient {
  const forbidden = {
    status: 403,
    message: "Resource not accessible by personal access token",
    body: "",
  };
  return {
    tryRequest: (method, path, payload, options) =>
      `${method} ${path}` === read
        ? Promise.resolve({ error: forbidden })
        : api.tryRequest(method, path, payload, options),
    tryGraphql: (op, variables, slug) =>
      `GRAPHQL ${op.name}` === read
        ? Promise.resolve({ error: { ...forbidden, graphqlTypes: ["FORBIDDEN" as const] } })
        : api.tryGraphql(op, variables, slug),
  };
}

/**
 * Whether a 403 on the recorded read is a permission denial by the declarations: a REST read on an
 * operation whose permission is "none" (a public probe) is not, and a GraphQL read declaring a
 * FORBIDDEN outcome tolerates it.
 */
function countsAsDenial(read: string): boolean {
  if (read.startsWith("GRAPHQL ")) {
    const op = Object.values(allGraphqlOps()).find((candidate) => candidate.name === read.slice(8));
    if (op === undefined) {
      throw new Error(`BUG: recorded GraphQL read ${read} is not a registered operation`);
    }
    return op.outcomes.FORBIDDEN === undefined;
  }
  const matched = matchEndpoint("GET", new URL(read.slice(4), "https://api.github.com").pathname);
  if (matched === null) {
    throw new Error(`BUG: recorded read ${read} matches no registered endpoint`);
  }
  const section = SECTIONS.find((candidate) => candidate.key === matched.endpoint.section);
  if (section === undefined) {
    throw new Error(`BUG: endpoint ${matched.key} names an unregistered section`);
  }
  return endpointPermission(section, matched.endpoint) !== "none";
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
      "repository",
      "labels",
      "actions",
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
    // Every registered section has exactly one outcome; the one write-only section is unsupported with its reason.
    expect(result.outcomes.map((o) => o.key)).toEqual(SECTIONS.map((s) => s.key));
    expect(UNSUPPORTED).toEqual(["check_suite_preferences"]);
    expect(
      result.outcomes.filter((o) => o.status === "unsupported").map((o) => [o.key, o.detail]),
    ).toEqual([
      [
        "check_suite_preferences",
        [expect.stringMatching(/^check_suite_preferences: GitHub exposes no read endpoint/)],
      ],
    ]);
    const secretNote = expect.stringMatching(
      /^actions_secrets\[DEPLOY_TOKEN\]: .*export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN/,
    );
    expect(result.outcomes.find((o) => o.key === "actions_secrets")).toEqual({
      key: "actions_secrets",
      status: "snapshot",
      detail: [secretNote],
    });
    expect(result.outcomes.find((o) => o.key === "milestones")).toEqual({
      key: "milestones",
      status: "snapshot",
      detail: [NOTHING],
    });
    expect(annotations).toContainEqual(
      expect.stringMatching(
        /^notice: actions_secrets\[DEPLOY_TOKEN\]: .*SECRET_ACTIONS_DEPLOY_TOKEN/,
      ),
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
      /^pages: GitHub answered GET \/repos\/\{owner\}\/\{repo\}\/pages with 404, read here as nothing to snapshot\. .*grant "Pages"/;
    expect(result.result).toBe("snapshot");
    // The org probe is public and DID answer 404: a 404 there has one reading, so no such note.
    const personal = /^custom_properties: owner "o" is a personal account, not an organization/;
    expect(result.outcomes).toEqual([
      { key: "pages", status: "snapshot", detail: [expect.stringMatching(note), NOTHING] },
      {
        key: "custom_properties",
        status: "snapshot",
        detail: [expect.stringMatching(personal), NOTHING],
      },
    ]);
    expect(annotations).toEqual([
      expect.stringMatching(new RegExp(`^notice: ${note.source.slice(1)}`)),
      expect.stringMatching(new RegExp(`^notice: ${personal.source.slice(1)}`)),
    ]);
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
      await ctx.read.get.probeAbsent(z.unknown());
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
        sections: SectionSelection.of({
          only: ["labels", "check_suite_preferences"],
        })._unsafeUnwrap(),
      },
      captureIo().io,
    );
    expect(result.result).toBe("snapshot");
    expect(result.outcomes.map((o) => [o.key, o.status])).toEqual([
      ["labels", "snapshot"],
      ["check_suite_preferences", "unsupported"],
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

  /**
   * Every read a section's snapshot issues against its round-trip fixture, denied one at a time:
   * under fail the section and the run fail with the grant prose and no document, whatever the
   * read (primary or a readOrNote sub-read); under warn the run survives and the denial is
   * reported. Driven off the registry, so a section swallowing a denial in its own try/catch
   * fails here by name. A read on a public operation is not a denial and is left out.
   */
  const DENIABLE = SECTIONS.filter((section) => section.snapshot !== undefined).map((s) => s.key);

  test.each(DENIABLE)(
    "%s: a 403 on any of its reads fails it under fail and is reported under warn",
    async (key) => {
      const { row } = (await import(`../sections/snapshot-rows/${key}.ts`)) as { row: Row };
      const only = SectionSelection.of({ only: [key] })._unsafeUnwrap();
      const run = (api: GitHubClient, policy: "fail" | "warn") => {
        const { io, annotations } = captureIo();
        return snapshotRepository(api, { ...opts(policy), sections: only }, io).then((result) => ({
          result,
          annotations,
        }));
      };
      const reads = new Set<string>();
      const baseline = await run(recording(registryFake(row.live), reads), "fail");
      expect(
        baseline.result.outcomes.map((o) => o.status),
        `${key}: fixture did not read back`,
      ).toEqual(["snapshot"]);
      expect(baseline.result.settings?.[key]).toBeDefined();
      const deniable = [...reads].filter(countsAsDenial);
      // The control: a section declaring a gated planning read must have exercised one (custom_properties reads only public routes).
      const section = SECTIONS.find((candidate) => candidate.key === key);
      const gated = sectionOperations(section as SectionMeta).some(
        (op) => op.wire === "read" && op.phase === "plan" && op.permission !== "none",
      );
      expect(deniable.length > 0, `${key}: deniable reads vs declared gated reads`).toBe(gated);
      for (const read of deniable) {
        const denied = denyingRead(registryFake(row.live), read);
        const failed = await run(denied, "fail");
        expect(failed.result.result, `${key}: ${read} denied under fail`).toBe("failed");
        expect(failed.result.settings).toBeUndefined();
        expect(failed.result.outcomes.map((o) => o.status)).toEqual(["failed"]);
        expect(failed.result.outcomes[0]?.detail.at(-1)).toMatch(
          /the token was denied .*To fix, grant "/,
        );
        expect(failed.annotations).toContainEqual(
          expect.stringMatching(
            new RegExp(`^error: ${key}: not snapshotted - the token was denied `),
          ),
        );
        const noted = await run(denied, "warn");
        expect(noted.result.result, `${key}: ${read} denied under warn`).not.toBe("failed");
        const [outcome] = noted.result.outcomes;
        expect(outcome?.status).toMatch(/^(snapshot|skipped)$/);
        expect(outcome?.detail.some((line) => line.includes("the token was denied"))).toBe(true);
      }
    },
  );

  test("a section whose snapshot throws fails the run: its error is the outcome, and no document is handed out", async () => {
    const stubbed = spyOn(labelsSection, "snapshot").mockRejectedValue(new Error("boom"));
    try {
      const { io, annotations } = captureIo();
      const result = await snapshotRepository(registryFake(LIVE), opts(), io);
      expect(result.result).toBe("failed");
      expect(result.settings).toBeUndefined();
      expect(result.outcomes.find((o) => o.key === "labels")).toEqual({
        key: "labels",
        status: "failed",
        detail: ["labels: boom"],
      });
      expect(result.outcomes.find((o) => o.key === "actions_variables")?.status).toBe("snapshot");
      expect(annotations).toContain("error: labels: boom");
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

describe("pages null body", () => {
  test("a null 200 on the Pages GET fails the section as a body outside the shape, never `pages: null`", async () => {
    const fake = registryFake(LIVE);
    const nulling: GitHubClient = {
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
    expect(result.result).toBe("failed");
    expect(result.settings).toBeUndefined();
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
  test("pins the schema, comments every outcome line (a multi-line message line by line), dates nothing, and writes the document", async () => {
    // The labels note spans two physical lines (an API error body would) and a second note follows it: each line is
    // commented on its own, every message of an outcome is kept in code-point order, and the file still parses.
    const original = labelsSection.snapshot;
    const stubbed = spyOn(labelsSection, "snapshot").mockImplementation(async (ctx) => {
      const snapshot = await original.call(labelsSection, ctx);
      return {
        ...snapshot,
        notes: [...snapshot.notes, "retried once", "502 Bad Gateway\nupstream unavailable"],
      };
    });
    try {
      const result = await snapshotRepository(
        registryFake(LIVE),
        {
          ...opts(),
          sections: SectionSelection.of({
            only: ["labels", "actions_secrets", "check_suite_preferences", "milestones"],
          })._unsafeUnwrap(),
        },
        captureIo().io,
      );
      expect(result.result).toBe("snapshot");
      const rendered = renderSnapshotYaml(
        result as RenderableSnapshot,
        "https://example.test/settings.schema.json",
      );
      expect(rendered).toBe(
        [
          "# yaml-language-server: $schema=https://example.test/settings.schema.json",
          "# labels: 502 Bad Gateway",
          "# labels: upstream unavailable",
          "# labels: retried once",
          "# actions_secrets[DEPLOY_TOKEN]: value of DEPLOY_TOKEN is not readable; export it into the environment as SECRET_ACTIONS_DEPLOY_TOKEN before apply",
          "# check_suite_preferences: GitHub exposes no read endpoint for this section, so there is nothing to snapshot; apply re-asserts the declared value on every run",
          "# milestones: nothing exists on the repository, so the section is omitted",
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
      expect(parseYaml(rendered)).toEqual(result.settings);
    } finally {
      stubbed.mockRestore();
    }
  });
});

describe("the snapshot is canonical at its boundary", () => {
  /** GitHub listing labels and secrets in no order of ours: the document and its notes must not follow it. */
  const UNORDERED_LIVE: LiveState = {
    labels: [
      { name: "docs", color: "0075ca", description: "" },
      { name: "bug", color: "d73a4a", description: "Something is broken" },
    ],
    actions_secrets: [
      { name: "ZED", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { name: "ALPHA", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    ],
  };
  const selection = SectionSelection.of({ only: ["labels", "actions_secrets"] })._unsafeUnwrap();

  async function snapshotOnce(): Promise<{
    rendered: string;
    result: RenderableSnapshot;
    notices: string[];
  }> {
    const io = captureIo();
    const result = await snapshotRepository(
      registryFake(UNORDERED_LIVE),
      { ...opts(), sections: selection },
      io.io,
    );
    expect(result.result).toBe("snapshot");
    return {
      rendered: renderSnapshotYaml(
        result as RenderableSnapshot,
        "https://example.test/schema.json",
      ),
      result: result as RenderableSnapshot,
      notices: io.annotations,
    };
  }

  test("two snapshots over one state are the same bytes, with no line dating them", async () => {
    const first = await snapshotOnce();
    const second = await snapshotOnce();
    expect(second.rendered).toBe(first.rendered);
    expect(first.rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("the document's entries, its notes, and the annotations come out sorted whatever order GitHub listed", async () => {
    const { rendered, result, notices } = await snapshotOnce();
    const labels = result.settings.labels as { entries: Array<{ name: string }> };
    expect(labels.entries.map((label) => label.name)).toEqual(["bug", "docs"]);
    const secrets = result.settings.actions_secrets as { entries: Array<{ name: string }> };
    expect(secrets.entries.map((secret) => secret.name)).toEqual(["ALPHA", "ZED"]);
    const notes =
      result.outcomes.find((outcome) => outcome.key === "actions_secrets")?.detail ?? [];
    const entryOf = (line: string): string | undefined => /^(?:notice: )?(\S+):/.exec(line)?.[1];
    expect(notes.map(entryOf)).toEqual(["actions_secrets[ALPHA]", "actions_secrets[ZED]"]);
    expect(notices.map(entryOf)).toEqual(["actions_secrets[ALPHA]", "actions_secrets[ZED]"]);
    expect(rendered.indexOf("# actions_secrets[ALPHA]")).toBeLessThan(
      rendered.indexOf("# actions_secrets[ZED]"),
    );
  });
});
