import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { runMulti } from "../../src/flows/multi.js";
import type { TargetOutcome } from "../../src/flows/redact.js";
import { type Io, maskRegistry } from "../../src/io.js";
import { isPrivate } from "../../src/private.js";
import { describeProblem, type Problem } from "../../src/problem.js";
import {
  ARTIFACT_FILE,
  ARTIFACT_NAME,
  type ArtifactUploader,
} from "../../src/report/artifact-report.js";
import { MockApi } from "../mock-api.js";

function captureIo(): {
  io: Io;
  annotations: string[];
  logs: string[];
  masks: string[];
  events: string[];
} {
  const annotations: string[] = [];
  const logs: string[] = [];
  const masks: string[] = [];
  const events: string[] = [];
  return {
    io: {
      annotate: (level, message) => {
        annotations.push(`${level}: ${message}`);
        events.push(`annotate ${level}: ${message}`);
      },
      log: (line) => {
        logs.push(line);
        events.push(`log: ${line}`);
      },
      debug: () => {},
      summary: () => {},
      output: () => {},
      ...maskRegistry((value) => {
        masks.push(value);
        events.push(`mask: ${value}`);
      }),
    },
    annotations,
    logs,
    masks,
    events,
  };
}

/** True when the target closed sealed: the redaction decision, read from the brand. */
const redacted = (target: TargetOutcome | undefined): boolean =>
  target !== undefined && isPrivate(target.detail);

async function runTargets(...args: Parameters<typeof runMulti>): Promise<TargetOutcome[]> {
  return (await runMulti(...args)).match(
    (targets) => targets,
    (problem) => {
      throw new Error(describeProblem(problem));
    },
  );
}

async function runFatal(...args: Parameters<typeof runMulti>): Promise<Problem> {
  return (await runMulti(...args)).match(
    (targets) => {
      throw new Error(`expected a fatal problem, got ${targets.length} target(s)`);
    },
    (problem) => problem,
  );
}

function cfg(overrides: Partial<Parameters<typeof runMulti>[1]> = {}) {
  return {
    reposDir: "",
    reposInput: "",
    defaultsFile: "",
    adminOwner: "o",
    mode: "apply" as const,
    onMissingPermission: "fail" as const,
    sections: SectionSelection.ALL,
    discoveryFilters: DEFAULT_DISCOVERY_FILTERS,
    discoveryFiltersSet: [],
    // Default "show": the non-redaction scenarios assert on raw slugs.
    privateRepos: "show" as const,
    privateReport: "none" as const,
    reportPublicKey: "",
    selfSlug: "",
    runUrl: "",
    ...overrides,
  };
}

describe("runMulti", () => {
  // Secret provenance is decided where the document is chosen; check mode reads no environment, so the outcome is purely the provenance verdict.
  const HOOK_WITH_REF =
    "webhooks:\n  - config:\n      url: https://x.test/h\n      secret: $OPERATOR_SECRET\n";
  async function withScratch<T>(
    layout: Record<string, string>,
    body: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "sac-multi-"));
    try {
      for (const [rel, content] of Object.entries(layout)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      return await body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a remote target's own settings.yml is target-authored: its $NAME reference is refused", async () => {
    const api = new MockApi({
      "GET /repos/o/a": { data: {} },
      "GET /repos/o/a/contents/.github/settings.yml": { data: HOOK_WITH_REF },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(api, cfg({ reposInput: "o/a", mode: "check" }), io);
    expect(targets.map((t) => [t.display, t.result])).toEqual([["o/a", "failed"]]);
    expect(api.calls.filter((c) => c.path.includes("/hooks"))).toEqual([]);
    expect(annotations.some((a) => a.includes("target-fetched settings file"))).toBe(true);
  });

  test("the defaults document applied to a fileless target is operator-authored: its $NAME reference is admitted", async () => {
    await withScratch({ "defaults.yml": HOOK_WITH_REF }, async (dir) => {
      const api = new MockApi({
        "GET /repos/o/c": { data: { default_branch: "main" } },
        "GET /repos/o/c/git/ref/heads/main": { data: { ref: "refs/heads/main" } },
        "GET /repos/o/c/hooks?per_page=100&page=1": { data: [] },
      });
      const { io, annotations } = captureIo();
      const targets = await runTargets(
        api,
        cfg({ reposInput: "o/c", defaultsFile: join(dir, "defaults.yml"), mode: "check" }),
        io,
      );
      expect(targets.map((t) => [t.display, t.result])).toEqual([["o/c", "drift"]]);
      expect(annotations.filter((a) => a.includes("target-fetched"))).toEqual([]);
    });
  });

  test("a central per-repo file is operator-authored: its $NAME reference is admitted", async () => {
    await withScratch({ "repos/api.yml": HOOK_WITH_REF }, async (dir) => {
      const api = new MockApi({
        "GET /repos/o/api": { data: {} },
        "GET /repos/o/api/hooks?per_page=100&page=1": { data: [] },
      });
      const { io, annotations } = captureIo();
      const targets = await runTargets(
        api,
        cfg({ reposDir: join(dir, "repos"), adminOwner: "o", mode: "check" }),
        io,
      );
      expect(targets.map((t) => [t.display, t.result])).toEqual([["o/api", "drift"]]);
      expect(annotations.filter((a) => a.includes("target-fetched"))).toEqual([]);
    });
  });

  test("one failing repo never stops the others; worst-of is failed", async () => {
    const api = new MockApi({
      // o/a: healthy remote target
      "GET /repos/o/a": { data: { has_wiki: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      // o/b: settings fetch ok, apply blows up with a server error
      "GET /repos/o/b": { data: {} },
      "GET /repos/o/b/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      "PATCH /repos/o/b": { error: { status: 500, message: "boom", body: "" } },
      // o/c: no settings file (contents GET unrouted -> 404); the default branch ref read proves Contents access
      "GET /repos/o/c": { data: { default_branch: "main" } },
      "GET /repos/o/c/git/ref/heads/main": { data: { ref: "refs/heads/main" } },
    }).allowMutations("PATCH /repos/o/a");
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/a, o/b, o/c", onMissingPermission: "warn" }),
      io,
    );
    const bySlug = Object.fromEntries(targets.map((t) => [t.display, t.result]));
    expect(bySlug).toEqual({ "o/a": "applied", "o/b": "failed", "o/c": "skipped" });
    expect(annotations.some((a) => a.includes("o/c: skipped - the repository has no"))).toBe(true);
  });

  test("engine emissions carry the slug prefix; validation warnings stay unprefixed", async () => {
    const api = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: true } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\nfrobnicate: {}\n",
      },
      "PATCH /repos/o/a": { error: { status: 500, message: "boom", body: "" } },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/a",
        sections: SectionSelection.of({ only: ["repository"] })._unsafeUnwrap(),
      }),
      io,
    );
    expect(targets[0]?.result).toBe("failed");
    // validateSettingsDoc runs on the plain sink, before prefixedIo wraps it.
    const validation = annotations.find((a) => a.includes("unknown top-level section"));
    expect(validation).toStartWith("warning: ignoring unknown top-level section(s)");
    // The section failure is emitted by the engine through the wrapped sink.
    expect(annotations.some((a) => a.startsWith("error: o/a: repository:"))).toBe(true);
  });

  test("defaults-file applies whole to a remote target without a settings file", async () => {
    // o/c has no settings.yml (contents GET unrouted -> 404; the ref read proves Contents access), so the defaults document runs as its settings.
    const api = new MockApi({
      "GET /repos/o/c": { data: { default_branch: "main", has_projects: true } },
      "GET /repos/o/c/git/ref/heads/main": { data: { ref: "refs/heads/main" } },
    }).allowMutations("PATCH /repos/o/c");
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/c", defaultsFile: "test/fixtures/defaults.yml" }),
      io,
    );
    expect(targets.map((t) => [t.display, t.result])).toEqual([["o/c", "applied"]]);
    expect(api.mutations().map((m) => [m.method, m.path, m.payload])).toEqual([
      ["PATCH", "/repos/o/c", { has_projects: false }],
    ]);
    expect(annotations).toEqual([
      "notice: o/c: applying the defaults file: the repository has no .github/settings.yml on its default branch",
    ]);
  });

  test("a target with its own file ignores the defaults", async () => {
    // The live repo drifts on BOTH keys, so a PATCH carrying only has_wiki proves the defaults' has_projects never reached this target.
    const api = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: true, has_projects: true } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    }).allowMutations("PATCH /repos/o/a");
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/a", defaultsFile: "test/fixtures/defaults.yml" }),
      io,
    );
    expect(targets.map((t) => [t.display, t.result])).toEqual([["o/a", "applied"]]);
    expect(api.mutations().map((m) => [m.method, m.path, m.payload])).toEqual([
      ["PATCH", "/repos/o/a", { has_wiki: false }],
    ]);
    expect(annotations).toEqual([]);
  });

  test("without defaults-file a fileless target is still skipped", async () => {
    const api = new MockApi({
      "GET /repos/o/c": { data: { default_branch: "main", has_projects: true } },
      "GET /repos/o/c/git/ref/heads/main": { data: { ref: "refs/heads/main" } },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(api, cfg({ reposInput: "o/c" }), io);
    expect(targets.map((t) => [t.display, t.result])).toEqual([["o/c", "skipped"]]);
    expect(api.mutations()).toEqual([]);
    expect(annotations).toEqual([
      'notice: o/c: skipped - the repository has no .github/settings.yml on its default branch. Add the file to manage it, or remove o/c from the "repos" input',
    ]);
  });

  test("central per-repo files are applied as written; the defaults never reach them", async () => {
    // Both live repos drift on both keys, so each PATCH carrying exactly its own file's key proves the defaults never merged in.
    const api = new MockApi({
      "GET /repos/viv/api": { data: { has_wiki: true, has_projects: true } },
      "GET /repos/octo/web": { data: { has_wiki: true, has_projects: true } },
    }).allowMutations("PATCH /repos/viv/api", "PATCH /repos/octo/web");
    const { io } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposDir: "test/fixtures/repos",
        defaultsFile: "test/fixtures/defaults.yml",
        adminOwner: "viv",
        onMissingPermission: "warn",
      }),
      io,
    );
    expect(targets.map((t) => [t.display, t.result]).sort()).toEqual([
      ["octo/web", "applied"],
      ["viv/api", "applied"],
    ]);
    const patches = api
      .mutations()
      .map((m) => [m.method, m.path, m.payload])
      .sort();
    expect(patches).toEqual([
      ["PATCH", "/repos/octo/web", { has_projects: false }],
      ["PATCH", "/repos/viv/api", { has_wiki: false }],
    ]);
  });

  test("no targets at all is a fatal config error", async () => {
    const api = new MockApi({});
    const { io } = captureIo();
    expect(await runFatal(api, cfg({ reposInput: " ,  " }), io)).toEqual({
      code: "no-targets",
      filteredOut: 0,
    });
  });

  test("a token-invisible repo fails loudly instead of skipping", async () => {
    // No routes at all: the contents GET and the repo probe both 404, which is how a fine-grained token reports lost access.
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const targets = await runTargets(api, cfg({ reposInput: "o/x" }), io);
    expect(targets[0]?.result).toBe("failed");
    expect(annotations.some((a) => a.includes("the token was denied"))).toBe(true);
  });

  test("a Contents-denied repo fails naming the grant; it neither skips nor receives the defaults", async () => {
    // The contents GET and the ref read 404 (the fine-grained denial) while the repo probe succeeds: the file cannot be proven absent, so nothing is
    // applied even with a defaults file in hand.
    const api = new MockApi({
      "GET /repos/o/x": { data: { default_branch: "main", has_projects: true } },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/x", defaultsFile: "test/fixtures/defaults.yml" }),
      io,
    );
    expect(targets.map((t) => [t.display, t.result])).toEqual([["o/x", "failed"]]);
    expect(api.mutations()).toEqual([]);
    expect(annotations).toEqual([
      "error: o/x: cannot prove .github/settings.yml is absent: reading the default branch ref " +
        "heads/main returned 404. Grant the token Contents: read on this repository, or " +
        "initialize its default branch; a repository whose file cannot be read never receives " +
        'the defaults. To stop managing it instead, remove o/x from the "repos" input',
    ]);
  });

  test("discovery filters with repos-dir-only targets are fatal", async () => {
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const fatal = await runFatal(
      api,
      cfg({ reposDir: "test/fixtures/repos", adminOwner: "viv", discoveryFiltersSet: ["forks"] }),
      io,
    );
    expect(fatal).toEqual({
      code: "discovery-filters-without-wildcard",
      filters: ["forks"],
      targets: "repos-dir",
    });
    // Central-resolution warnings buffered before this fatal return must still be emitted; the fixture's README.md (non-yaml) and octo/deep/ (too
    // deep) each produce one.
    expect(annotations.some((a) => a.startsWith("warning: ignoring "))).toBe(true);
  });

  test("filters removing every discovered repo suggest relaxing them", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [
          { full_name: "o/a", fork: true },
          { full_name: "o/b", fork: true },
        ],
      },
    });
    const { io } = captureIo();
    const fatal = await runFatal(
      api,
      cfg({
        reposInput: "*",
        discoveryFilters: { ...DEFAULT_DISCOVERY_FILTERS, forks: "exclude" },
        discoveryFiltersSet: ["forks"],
      }),
      io,
    );
    expect(fatal).toEqual({ code: "no-targets", filteredOut: 2 });
  });

  test("skip notices list at most 20 slugs, then a count of the rest", async () => {
    const repos = Array.from({ length: 21 }, (_, i) => ({
      full_name: `o/fork-${String(i).padStart(2, "0")}`,
      fork: true,
    }));
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [{ full_name: "o/keep" }, ...repos],
      },
      "GET /repos/o/keep": { data: { has_wiki: false } },
      "GET /repos/o/keep/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    const { io, annotations } = captureIo();
    await runTargets(
      api,
      cfg({
        reposInput: "*",
        discoveryFilters: { ...DEFAULT_DISCOVERY_FILTERS, forks: "exclude" },
        discoveryFiltersSet: ["forks"],
      }),
      io,
    );
    const notice = annotations.find((a) => a.includes("forks=exclude"));
    expect(notice).toContain("skipped 21 repositories");
    expect(notice).toContain("o/fork-19");
    expect(notice).not.toContain("o/fork-20");
    expect(notice).toContain(", and 1 more");
  });
});

describe("runMulti under on-missing-permission: fail", () => {
  test("preflight denial fails that repo, applies nothing to it, others proceed", async () => {
    const api = new MockApi({
      // o/a: healthy
      "GET /repos/o/a": { data: { has_wiki: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      // o/d: settings fetch ok, but the labels probe is denied -> preflight
      "GET /repos/o/d": { data: {} },
      "GET /repos/o/d/contents/.github/settings.yml": {
        data: 'labels:\n  - name: bug\n    color: "d73a4a"\n',
      },
      "GET /repos/o/d/labels?per_page=100&page=1": {
        error: { status: 403, message: "Forbidden", body: "" },
      },
    }).allowMutations("PATCH /repos/o/a");
    const { io, annotations } = captureIo();
    const targets = await runTargets(api, cfg({ reposInput: "o/a, o/d" }), io);
    const bySlug = Object.fromEntries(targets.map((t) => [t.display, t.result]));
    expect(bySlug).toEqual({ "o/a": "applied", "o/d": "failed" });
    expect(api.mutations().every((m) => m.path.startsWith("/repos/o/a"))).toBe(true);
    expect(annotations.some((a) => a.includes("o/d: preflight failed"))).toBe(true);
  });
});

describe("runMulti redaction (private-repos: redact)", () => {
  /** A drifting private target plus a healthy public one, under redact. */
  function mixApi() {
    return new MockApi({
      // o/pub: public, drifts on has_wiki
      "GET /repos/o/pub": { data: { has_wiki: true, private: false } },
      "GET /repos/o/pub/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      // o/priv: private, its live description drifts (a private live value)
      "GET /repos/o/priv": { data: { description: "SECRET-live-desc", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "SECRET-want-desc"\n',
      },
    });
  }

  test("a private target is masked before the first emission, and never leaks its slug", async () => {
    const api = mixApi();
    const { io, annotations, logs, masks, events } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/pub, o/priv", mode: "check", privateRepos: "redact" }),
      io,
    );
    expect(masks).toContain("o/priv");
    const firstMask = events.indexOf("mask: o/priv");
    const firstEmit = events.findIndex((e) => e.startsWith("annotate") || e.startsWith("log"));
    expect(firstMask).toBeGreaterThanOrEqual(0);
    expect(firstMask).toBeLessThan(firstEmit);
    const all = [...annotations, ...logs].join("\n");
    expect(all).not.toContain("o/priv");
    expect(all).not.toContain("SECRET-live-desc");
    expect(all).not.toContain("SECRET-want-desc");
    expect(annotations.some((a) => a.includes("private repository #1"))).toBe(true);
    expect(all).toContain("o/pub");
    const priv = targets.find((t) => t.display === "private repository #1");
    expect(redacted(priv)).toBe(true);
    expect(priv?.result).toBe("drift");
    expect(JSON.stringify(targets)).not.toContain("o/priv");
  });

  test("show is byte-identical to today: no mask, raw slug and live values surface", async () => {
    const api = mixApi();
    const redactRun = captureIo();
    await runMulti(
      api,
      cfg({ reposInput: "o/pub, o/priv", mode: "check", privateRepos: "redact" }),
      redactRun.io,
    );
    const showApi = mixApi();
    const showRun = captureIo();
    await runMulti(
      showApi,
      cfg({ reposInput: "o/pub, o/priv", mode: "check", privateRepos: "show" }),
      showRun.io,
    );
    expect(showRun.masks).toEqual([]);
    const all = [...showRun.annotations, ...showRun.logs].join("\n");
    expect(all).toContain("o/priv");
    // No visibility probe under show: the one o/priv GET is the engine's.
    const privGets = showApi.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/priv");
    expect(privGets).toHaveLength(1);
  });

  test("the self slug is never redacted (carve-out), even when private", async () => {
    const api = new MockApi({
      "GET /repos/o/self": { data: { has_wiki: true, private: true } },
      "GET /repos/o/self/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    const { io, annotations, masks } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/self", mode: "check", privateRepos: "redact", selfSlug: "o/self" }),
      io,
    );
    expect(masks).toEqual([]);
    expect(redacted(targets[0])).toBe(false);
    expect(targets[0]?.display).toBe("o/self");
    expect(annotations.join("\n")).not.toContain("private repository");
    // no separate visibility probe for the self slug (only the engine's GET)
    const gets = api.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/self");
    expect(gets).toHaveLength(1);
  });

  test("discovery-supplied visibility skips the probe; a private discovered repo is redacted", async () => {
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [
          { full_name: "o/pub", private: false },
          { full_name: "o/priv", private: true },
        ],
      },
      "GET /repos/o/pub": { data: { has_wiki: false, private: false } },
      "GET /repos/o/pub/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      "GET /repos/o/priv": { data: { has_wiki: false, private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "*", mode: "check", privateRepos: "redact" }),
      io,
    );
    // No extra probe: o/priv's only GET is the engine's repository read.
    const privGets = api.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/priv");
    expect(privGets).toHaveLength(1);
    expect(targets.map((t) => [t.display, redacted(t)])).toEqual([
      ["o/pub", false],
      ["private repository #1", true],
    ]);
    expect(annotations.join("\n")).not.toContain("o/priv");
  });

  test("a probe error fails closed: an unknown-visibility target is redacted", async () => {
    // The repo probe 404s, so visibility is unknown and redacted; the contents read then 404s too, so the failure line must stay generic.
    const api = new MockApi({});
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/mystery", privateRepos: "redact" }),
      io,
    );
    expect(redacted(targets[0])).toBe(true);
    expect(targets[0]?.display).toBe("private repository #1");
    const all = annotations.join("\n");
    expect(all).not.toContain("o/mystery");
    expect(all).toContain("private repository #1: failed");
  });

  test("placeholders number private targets 1-based in target order", async () => {
    const api = new MockApi({
      "GET /repos/o/pub": { data: { private: false } },
      "GET /repos/o/pub/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
      "GET /repos/o/p1": { data: { private: true } },
      "GET /repos/o/p1/contents/.github/settings.yml": { data: "repository:\n  has_wiki: false\n" },
      "GET /repos/o/p2": { data: { private: true } },
      "GET /repos/o/p2/contents/.github/settings.yml": { data: "repository:\n  has_wiki: false\n" },
    });
    const { io } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/p1, o/pub, o/p2", mode: "check", privateRepos: "redact" }),
      io,
    );
    expect(targets.map((t) => t.display)).toEqual([
      "private repository #1",
      "o/pub",
      "private repository #2",
    ]);
  });
});

describe("runMulti private-report: issue wiring", () => {
  const MARKER = "settings-as-code-report";
  const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
  const listPath = (slug: string) =>
    `GET /repos/${slug}/issues?state=all&labels=${MARKER}&per_page=100`;

  /**
   * A private drifting target whose report issue already exists, so delivery is a single PATCH; the drift carries a CANARY the report body must
   * contain and the public surfaces must not.
   */
  function reportApi(
    overrides: Record<
      string,
      { data?: unknown; error?: { status: number; message: string; body: string } }
    > = {},
  ) {
    return new MockApi({
      "GET /repos/o/priv": { data: { description: "CANARY-live", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "CANARY-want"\n',
      },
      "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
      [listPath("o/priv")]: {
        data: [{ number: 7, title: ISSUE_TITLE, html_url: "https://github.com/o/priv/issues/7" }],
      },
      "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
      ...overrides,
    });
  }

  test("delivers the full report to the target issue; body has detail+transcript, public surfaces do not", async () => {
    const api = reportApi();
    const { io, annotations, logs } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue",
        selfSlug: "admin/repo",
        runUrl: "https://example.com/run/1",
      }),
      io,
    );
    expect(targets[0]?.result).toBe("drift");
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    const body = String(payload.body ?? "");
    expect(body).toContain("CANARY-live");
    expect(body).toContain("o/priv");
    expect(body).toContain("## Transcript");
    // A check-mode drift needs attention, so the issue is opened.
    expect(payload.state).toBe("open");
    const publicText = [...annotations, ...logs].join("\n");
    expect(publicText).not.toContain("CANARY-live");
    expect(publicText).not.toContain("o/priv");
  });

  test("marker label is injected when a labels section is declared, notice lands in the report only", async () => {
    const api = reportApi({
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'labels:\n  - name: bug\n    color: "d73a4a"\n',
      },
      "GET /repos/o/priv/labels?per_page=100&page=1": { data: [] },
    }).allowMutations("POST /repos/o/priv/labels", "PATCH /repos/o/priv/labels/bug");
    const { io, annotations } = captureIo();
    await runMulti(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "apply",
        privateRepos: "redact",
        privateReport: "issue",
        selfSlug: "admin/repo",
      }),
      io,
    );
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const body = String(((patch?.payload ?? {}) as { body?: unknown }).body ?? "");
    expect(body).toContain(`added the "${MARKER}" marker label`);
    expect(annotations.some((a) => a.includes(MARKER))).toBe(false);
  });

  test("delivery failure warns safely and never changes the target result", async () => {
    const api = reportApi({
      "PATCH /repos/o/priv/issues/7": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue",
        selfSlug: "admin/repo",
      }),
      io,
    );
    expect(targets[0]?.result).toBe("drift");
    const warning = annotations.find((a) => a.includes("could not deliver the private report"));
    expect(warning).toBeDefined();
    expect(warning).toContain("private repository #1");
    expect(warning).toContain("HTTP 403");
    expect(warning).not.toContain("o/priv");
    expect(warning).not.toContain("Resource not accessible");
  });

  test("no report is delivered under channel none, policy show, or for a non-redacted target", async () => {
    const none = reportApi();
    await runMulti(
      none,
      cfg({ reposInput: "o/priv", mode: "check", privateRepos: "redact", privateReport: "none" }),
      captureIo().io,
    );
    expect(none.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    expect(none.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(false);

    // Config rejects show + issue at parse; runMulti itself must also stay inert.
    const shown = reportApi();
    await runMulti(
      shown,
      cfg({ reposInput: "o/priv", mode: "check", privateRepos: "show", privateReport: "issue" }),
      captureIo().io,
    );
    expect(shown.calls.some((c) => c.path.includes("/issues"))).toBe(false);
  });

  test("an unparseable discovered slug on the issue channel warns instead of losing the report", async () => {
    // Discovery hands back API data, so a garbage full_name can reach the loop; the issue channel posts INTO the target, impossible without an
    // owner/name pair, so the loss must be a loud, safe warning.
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [
          {
            full_name: "justonename",
            archived: false,
            fork: false,
            topics: [],
            visibility: "private",
            private: true,
          },
        ],
      },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "*", mode: "check", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    expect(targets[0]?.result).toBe("failed");
    expect(redacted(targets[0])).toBe(true);
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    const warning = annotations.find((a) => a.includes("could not deliver the private report"));
    expect(warning).toBeDefined();
    expect(warning).toContain("private repository #1");
    expect(warning).toContain("not an owner/name repository slug");
    expect(annotations.join("\n")).not.toContain("justonename");
  });

  test("unknown visibility redacts publicly but does NOT deliver the report (fail closed)", async () => {
    // A probe body with neither `private` nor `visibility` resolves unknown: redaction still hides the target, but delivery must not post to a repo
    // that could be public.
    const api = new MockApi({
      "GET /repos/o/maybe": { data: { description: "SECRET" } },
      "GET /repos/o/maybe/contents/.github/settings.yml": {
        data: 'repository:\n  description: "SECRET-want"\n',
      },
      "POST /repos/o/maybe/labels": { error: { status: 422, message: "exists", body: "" } },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/maybe", mode: "check", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    expect(redacted(targets[0])).toBe(true);
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(false);
    const withheld = annotations.find((a) => a.includes("visibility could not be verified"));
    expect(withheld).toBeDefined();
    expect(withheld).toContain("private repository #1");
    expect(annotations.join("\n")).not.toContain("o/maybe");
  });

  test("an internal target IS deliverable (proven private/internal)", async () => {
    const api = reportApi({
      "GET /repos/o/priv": { data: { description: "CANARY-live", visibility: "internal" } },
    });
    const { io } = captureIo();
    await runMulti(
      api,
      cfg({ reposInput: "o/priv", mode: "check", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    expect(api.calls.some((c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7")).toBe(
      true,
    );
  });

  test("a settings-read failure still delivers a report (whole lifecycle covered)", async () => {
    // An unparseable settings.yml is a pre-engine failure; the report must still be delivered and opened, or a previously-created issue keeps a stale
    // body.
    const api = reportApi({
      "GET /repos/o/priv/contents/.github/settings.yml": { data: "repository: [oops\n" },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({ reposInput: "o/priv", mode: "apply", privateRepos: "redact", privateReport: "issue" }),
      io,
    );
    expect(targets[0]?.result).toBe("failed");
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    expect(patch).toBeDefined();
    expect(payload.state).toBe("open");
    expect(String(payload.body ?? "")).toContain("failed");
    expect(annotations.join("\n")).not.toContain("oops");
  });
});

describe("runMulti private-report: issue-on-failure wiring", () => {
  const MARKER = "settings-as-code-report";
  const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
  const allListPath = (slug: string) =>
    `GET /repos/${slug}/issues?state=all&labels=${MARKER}&per_page=100`;
  const openListPath = (slug: string) =>
    `GET /repos/${slug}/issues?state=open&labels=${MARKER}&per_page=100`;
  const issue7 = { number: 7, title: ISSUE_TITLE, html_url: "https://github.com/o/priv/issues/7" };

  test("a needs-attention target delivers exactly like the issue channel (opened)", async () => {
    const api = new MockApi({
      "GET /repos/o/priv": { data: { description: "CANARY-live", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "CANARY-want"\n',
      },
      "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
      [allListPath("o/priv")]: { data: [issue7] },
      "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
    });
    const { io, annotations, logs } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue-on-failure",
        selfSlug: "admin/repo",
      }),
      io,
    );
    expect(targets[0]?.result).toBe("drift");
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    expect(String(payload.body ?? "")).toContain("CANARY-live");
    expect(payload.state).toBe("open");
    const publicText = [...annotations, ...logs].join("\n");
    expect(publicText).not.toContain("CANARY-live");
    expect(publicText).not.toContain("o/priv");
  });

  test("a clean target performs zero issue/label writes and adds no note", async () => {
    const api = new MockApi({
      "GET /repos/o/priv": { data: { description: "same", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "same"\n',
      },
      [openListPath("o/priv")]: { data: [] },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue-on-failure",
        selfSlug: "admin/repo",
      }),
      io,
    );
    expect(targets[0]?.result).toBe("clean");
    expect(annotations.some((a) => a.includes("report"))).toBe(false);
    expect(api.mutations()).toEqual([]);
    const issueCalls = api.calls.filter((c) => c.path.includes("/issues"));
    expect(issueCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /repos/o/priv/issues?state=open&labels=${MARKER}&per_page=100`,
    ]);
  });

  test("a leftover open issue on a clean target is closed with the healthy report", async () => {
    const api = new MockApi({
      "GET /repos/o/priv": { data: { description: "same", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "same"\n',
      },
      [openListPath("o/priv")]: { data: [issue7] },
      "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
    });
    const { io } = captureIo();
    await runMulti(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "issue-on-failure",
        selfSlug: "admin/repo",
      }),
      io,
    );
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const payload = (patch?.payload ?? {}) as { body?: unknown; state?: unknown };
    expect(payload.state).toBe("closed");
    expect(String(payload.body ?? "")).toContain("o/priv");
  });

  test("marker injection still fires; its notice lands in the closing report only", async () => {
    const api = new MockApi({
      "GET /repos/o/priv": { data: { private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'labels:\n  - name: bug\n    color: "d73a4a"\n',
      },
      "GET /repos/o/priv/labels?per_page=100&page=1": { data: [] },
      [openListPath("o/priv")]: { data: [issue7] },
      "PATCH /repos/o/priv/issues/7": { data: { number: 7 } },
    }).allowMutations("POST /repos/o/priv/labels");
    const { io, annotations } = captureIo();
    await runMulti(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "apply",
        privateRepos: "redact",
        privateReport: "issue-on-failure",
        selfSlug: "admin/repo",
      }),
      io,
    );
    const created = api
      .mutations()
      .filter((c) => c.method === "POST" && c.path === "/repos/o/priv/labels")
      .map((c) => (c.payload as { name?: string }).name);
    expect(created).toContain(MARKER);
    const patch = api.calls.find(
      (c) => c.method === "PATCH" && c.path === "/repos/o/priv/issues/7",
    );
    const body = String(((patch?.payload ?? {}) as { body?: unknown }).body ?? "");
    expect(body).toContain(`added the "${MARKER}" marker label`);
    expect(annotations.some((a) => a.includes(MARKER))).toBe(false);
  });
});

describe("runMulti private-report: artifact wiring", () => {
  /** A capturing uploader plus the age keypair the ciphertext decrypts with. */
  async function artifactHarness() {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    const uploads: Array<{ name: string; file: { name: string; data: Uint8Array } }> = [];
    const uploader: ArtifactUploader = {
      async upload(name, file) {
        uploads.push({ name, file });
      },
    };
    const decrypt = async (data: Uint8Array): Promise<string> => {
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      return decrypter.decrypt(data, "text");
    };
    return { recipient, uploader, uploads, decrypt };
  }

  test("accumulates every deliverable target into ONE encrypted upload", async () => {
    const { recipient, uploader, uploads, decrypt } = await artifactHarness();
    const api = new MockApi({
      "GET /repos/o/a": { data: { description: "CANARY-A", private: true } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: 'repository:\n  description: "WANT-A"\n',
      },
      "GET /repos/o/b": { data: { description: "CANARY-B", private: true } },
      "GET /repos/o/b/contents/.github/settings.yml": {
        data: 'repository:\n  description: "WANT-B"\n',
      },
    });
    const { io, annotations, logs } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/a, o/b",
        mode: "check",
        privateRepos: "redact",
        privateReport: "artifact",
        reportPublicKey: recipient,
        selfSlug: "admin/repo",
      }),
      io,
      uploader,
    );
    expect(targets.map((t) => t.result)).toEqual(["drift", "drift"]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe(ARTIFACT_NAME);
    expect(uploads[0]?.file.name).toBe(ARTIFACT_FILE);
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    const document = await decrypt(uploads[0]?.file.data as Uint8Array);
    expect(document).toContain("CANARY-A");
    expect(document).toContain("CANARY-B");
    expect(document).toContain("o/a");
    expect(document).toContain("o/b");
    const publicText = [...annotations, ...logs].join("\n");
    expect(publicText).not.toContain("CANARY-A");
    expect(publicText).not.toContain("CANARY-B");
    expect(publicText).not.toContain("o/a");
    expect(publicText).not.toContain("o/b");
  });

  test("an unknown-visibility target is redacted but excluded from the upload", async () => {
    const { recipient, uploader, uploads, decrypt } = await artifactHarness();
    // o/known is proven private (included); o/maybe resolves unknown (excluded).
    const api = new MockApi({
      "GET /repos/o/known": { data: { description: "CANARY-KNOWN", private: true } },
      "GET /repos/o/known/contents/.github/settings.yml": {
        data: 'repository:\n  description: "WANT-KNOWN"\n',
      },
      "GET /repos/o/maybe": { data: { description: "CANARY-MAYBE" } },
      "GET /repos/o/maybe/contents/.github/settings.yml": {
        data: 'repository:\n  description: "WANT-MAYBE"\n',
      },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/known, o/maybe",
        mode: "check",
        privateRepos: "redact",
        privateReport: "artifact",
        reportPublicKey: recipient,
        selfSlug: "admin/repo",
      }),
      io,
      uploader,
    );
    expect(targets.every((t) => redacted(t))).toBe(true);
    expect(uploads).toHaveLength(1);
    const document = await decrypt(uploads[0]?.file.data as Uint8Array);
    expect(document).toContain("CANARY-KNOWN");
    expect(document).not.toContain("CANARY-MAYBE");
    const withheld = annotations.find((a) => a.includes("visibility could not be verified"));
    expect(withheld).toBeDefined();
    expect(annotations.join("\n")).not.toContain("o/maybe");
  });

  test("no deliverable target means no upload at all", async () => {
    const { recipient, uploader, uploads } = await artifactHarness();
    // Only an unknown-visibility target: redacted, but nothing is deliverable.
    const api = new MockApi({
      "GET /repos/o/maybe": { data: { description: "SECRET" } },
      "GET /repos/o/maybe/contents/.github/settings.yml": {
        data: 'repository:\n  description: "WANT"\n',
      },
    });
    await runMulti(
      api,
      cfg({
        reposInput: "o/maybe",
        mode: "check",
        privateRepos: "redact",
        privateReport: "artifact",
        reportPublicKey: recipient,
        selfSlug: "admin/repo",
      }),
      captureIo().io,
      uploader,
    );
    expect(uploads).toHaveLength(0);
  });

  test("an upload failure warns safely and never changes any target result", async () => {
    const { recipient } = await artifactHarness();
    const uploader: ArtifactUploader = {
      async upload() {
        throw new Error("Unable to get the ACTIONS_RUNTIME_TOKEN env variable");
      },
    };
    const api = new MockApi({
      "GET /repos/o/priv": { data: { description: "CANARY-live", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "CANARY-want"\n',
      },
    });
    const { io, annotations } = captureIo();
    const targets = await runTargets(
      api,
      cfg({
        reposInput: "o/priv",
        mode: "check",
        privateRepos: "redact",
        privateReport: "artifact",
        reportPublicKey: recipient,
        selfSlug: "admin/repo",
      }),
      io,
      uploader,
    );
    expect(targets[0]?.result).toBe("drift");
    const warning = annotations.find((a) => a.includes("could not upload the private report"));
    expect(warning).toBeDefined();
    expect(warning).toContain("ACTIONS_RUNTIME_TOKEN");
    expect(annotations.join("\n")).not.toContain("o/priv");
    expect(annotations.join("\n")).not.toContain("CANARY");
  });
});
