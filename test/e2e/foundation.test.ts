import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { escapeRe } from "../../.github/scripts/lib/generated-regions.js";
import { MARKER_LABEL, MARKER_LABEL_CONFIG } from "../../src/report/issue-report.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import {
  ADMIN_OWNER,
  ADMIN_REPO,
  ADMIN_SLUG,
  E2E_TOKEN,
  layerFile,
  RUNNER_ROOT_FILES,
  TOKEN_USER_LOGIN,
  VIOLATION_PREFIX,
} from "./constants.js";
import { mulberry32, Rng } from "./prng.js";
import {
  collectYmlFiles,
  loadScenarios,
  markerLabelFixtureMismatches,
  parseScenario,
  type Scenario,
  scenarioRoots,
} from "./schema.js";

describe("prng", () => {
  test("mulberry32 is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("Rng.int(maxExclusive) stays in [0, max) and is deterministic", () => {
    const a = new Rng(1);
    const b = new Rng(1);
    for (let i = 0; i < 100; i++) {
      const x = a.int(7);
      expect(x).toBe(b.int(7));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(7);
    }
  });

  test.each<[label: string, draw: () => unknown]>([
    ["Rng.int rejects a non-positive bound", () => new Rng(1).int(0)],
    ["Rng.pick throws on an empty array", () => new Rng(1).pick([])],
  ])("%s", (_label, draw) => {
    expect(draw).toThrow();
  });

  test("Rng.bool honors its probability at the extremes", () => {
    expect(new Rng(1).bool(1)).toBe(true);
    expect(new Rng(1).bool(0)).toBe(false);
  });

  test("fork(label) is stable regardless of parent draws and varies by label", () => {
    const drained = new Rng(7);
    drained.int(10);
    drained.int(10);
    const fresh = new Rng(7);
    expect(drained.fork("labels").int(1_000_000)).toBe(fresh.fork("labels").int(1_000_000));
    expect(new Rng(7).fork("labels").float()).not.toBe(new Rng(7).fork("teams").float());
  });
});

describe("scenario schema", () => {
  // Load-time refusals, none a silent preference: both spellings define settings.yml, a multi-repo run never reads
  // the single-repo file, and an empty allowed exit set would fail every exit code.
  test.each<[label: string, raw: Record<string, unknown>, refusal: RegExp]>([
    [
      "an unknown top-level key, naming the file",
      { name: "x", settings: {}, expect: { exit_code: 0 }, bogus: 1 },
      /refused\.yml/,
    ],
    [
      "an unsupported denial_style, naming the field",
      { name: "x", settings: {}, denial_style: 500, expect: { exit_code: 0 } },
      /denial_style/,
    ],
    [
      "an empty allowed-set exit_code",
      { name: "e", settings: {}, expect: { exit_code: [] } },
      /exit_code/,
    ],
    [
      "neither settings nor settings_raw",
      { name: "x", expect: { exit_code: 0 } },
      /one of `settings` or `settings_raw` is required/,
    ],
    [
      "a repo that sets both settings and settings_raw",
      {
        name: "x",
        settings: {},
        expect: { exit_code: 0 },
        repos: { "e2e-owner/svc-a": { settings: { labels: [] }, settings_raw: "labels: [oops" } },
      },
      /only one of `settings` or `settings_raw`/,
    ],
    [
      "a top-level scenario that sets both settings and settings_raw",
      { name: "x", settings: {}, settings_raw: "labels: [oops", expect: { exit_code: 0 } },
      /only one of `settings` or `settings_raw`/,
    ],
    [
      "a top-level settings_raw on a multi-repo scenario",
      {
        name: "x",
        settings_raw: "labels: [oops",
        repos: { "e2e-owner/svc-a": { settings: {} } },
        expect: { exit_code: 0 },
      },
      /single-repo only/,
    ],
    [
      "snapshot_converges outside mode: snapshot",
      { name: "x", settings: {}, expect: { exit_code: 0, snapshot_converges: true } },
      /snapshot_converges only applies with inputs.mode: snapshot/,
    ],
    [
      "an expect.fixpoint outside the two proofs",
      { name: "x", settings: {}, expect: { exit_code: 0, fixpoint: "idempotent" } },
      /expect\.fixpoint/,
    ],
    [
      "an unknown expect key, as a bare unrecognized-key issue",
      { name: "x", settings: {}, expect: { exit_code: 0, bogus: true } },
      /expect: Unrecognized key: "bogus"$/m,
    ],
  ])("rejects %s", (_label, raw, refusal) => {
    expect(() => parseScenario(raw, "refused.yml")).toThrow(refusal);
  });

  test.each<[label: string, raw: Record<string, unknown>, parsed: Partial<Scenario>]>([
    [
      "an allowed-set exit_code (the fuzz oracle's allowed exit set)",
      { name: "e", settings: {}, expect: { exit_code: [0, 1] } },
      { expect: { exit_code: [0, 1] } },
    ],
    [
      "the numeric denial styles",
      { name: "x", settings: {}, denial_style: 403, expect: { exit_code: 0 } },
      { denial_style: 403 },
    ],
    [
      "a nested snapshot destination and the dir form's snapshot_converges",
      {
        name: "x",
        settings: {},
        inputs: { mode: "snapshot", snapshot_dir: "out/snapshots" },
        repos: { "e2e-owner/svc-a": {} },
        expect: { exit_code: 0, snapshot_converges: true },
      },
      {
        inputs: { snapshot_dir: "out/snapshots" },
        expect: { exit_code: 0, snapshot_converges: true },
      },
    ],
    ...(["converges", "apply_idempotent"] as const).map(
      (proof): [string, Record<string, unknown>, Partial<Scenario>] => [
        `expect.fixpoint: ${proof}`,
        { name: "x", settings: {}, expect: { exit_code: 0, fixpoint: proof } },
        { expect: { exit_code: 0, fixpoint: proof } },
      ],
    ),
  ])("accepts %s", (_label, raw, parsed) => {
    expect(parseScenario(raw, "accepted.yml")).toMatchObject(parsed);
  });

  test("accepts a single-repo scenario with only settings_raw, kept verbatim", () => {
    const s = parseScenario(
      { name: "x", settings_raw: "labels: [oops, unclosed", expect: { exit_code: 0 } },
      "raw.yml",
    );
    expect(s.settings_raw).toBe("labels: [oops, unclosed");
    expect(s.settings).toBeUndefined();
  });

  // The runner keeps its own files at the root of the child's working directory, so a destination
  // that resolves to that root (or above it) would let the dir form's walk collect them as snapshots;
  // the child trims surrounding whitespace, so a padded spelling would name a different path than the runner reads.
  test.each<[label: string, inputs: Record<string, string>]>([
    ["the working directory itself", { snapshot_dir: "." }],
    ["a parent segment", { snapshot_dir: "../snapshots" }],
    ["an absolute path", { snapshot_file: "/tmp/snapshot.yml" }],
    ["an empty segment", { snapshot_file: "out//snapshot.yml" }],
    ["surrounding whitespace", { snapshot_dir: "snapshots " }],
  ])("rejects a snapshot destination that is not a plain subpath: %s", (_label, inputs) => {
    expect(() =>
      parseScenario(
        {
          name: "x",
          settings: {},
          inputs: { mode: "snapshot", ...inputs },
          expect: { exit_code: 0 },
        },
        "dest.yml",
      ),
    ).toThrow(/relative path below the working directory/);
  });

  // The runner writes these at the root before the child runs; a destination starting with one
  // would overwrite it, or hand it to the dir form's walk. Derived from the runner's own list; both
  // destination inputs share the one schema, so the file form carries the names and one dir row the wiring.
  test.each<[name: string, inputs: Record<string, string>]>([
    ...Object.values(RUNNER_ROOT_FILES).map((name): [string, Record<string, string>] => [
      `snapshot_file: ${name}`,
      { snapshot_file: name },
    ]),
    [
      `a nested snapshot_dir under ${RUNNER_ROOT_FILES.settings}`,
      { snapshot_dir: `${RUNNER_ROOT_FILES.settings}/out` },
    ],
    [`a merge layer, ${layerFile(0)}`, { snapshot_file: layerFile(0) }],
  ])(
    "rejects a snapshot destination starting with a runner-owned root file: %s",
    (_name, inputs) => {
      expect(() =>
        parseScenario(
          {
            name: "x",
            settings: {},
            inputs: { mode: "snapshot", ...inputs },
            expect: { exit_code: 0 },
          },
          "reserved.yml",
        ),
      ).toThrow(/may not start with a file the runner keeps/);
    },
  );
});

describe("scenario corpus loader (collectYmlFiles)", () => {
  test("every scenario file name is dashed lowercase and names its scenario, so a section key's underscore never leaks into the corpus and --scenario <file stem> selects the file", () => {
    const files = scenarioRoots().flatMap((root) => collectYmlFiles(root));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter(
      (path) => !/^[a-z0-9]+(?:-[a-z0-9]+)*\.yml$/.test(basename(path)),
    );
    expect(offenders).toEqual([]);
    const misnamed = files.filter(
      (path) =>
        (parseYaml(readFileSync(path, "utf8")) as { name?: unknown }).name !==
        basename(path, ".yml"),
    );
    expect(misnamed).toEqual([]);
  });

  function withTempRoot(body: (root: string) => void): Promise<void> {
    return withTempDir("e2e-corpus-", (root) => {
      try {
        body(root);
      } finally {
        // The unreadable-root test leaves the directory at 000; restore it so
        // the removal can descend into it.
        chmodSync(root, 0o700);
      }
    });
  }

  test.each<[label: string, at: (root: string) => string]>([
    [
      "a root that does not exist (a section may have no scenarios/ yet)",
      (root) => join(root, "absent"),
    ],
    ["a readable empty root", (root) => root],
  ])("%s yields []", (_label, at) =>
    withTempRoot((root) => {
      expect(collectYmlFiles(at(root))).toEqual([]);
    }),
  );

  // chmod 000 does not bar root from reading a directory, so as root there is
  // no unreadable root to test against; the skip names that rather than
  // asserting on a read that would succeed.
  const runningAsRoot = process.getuid?.() === 0;
  test.skipIf(runningAsRoot)(
    "an unreadable root fails naming it and the error, never passing as an empty corpus",
    () =>
      withTempRoot((root) => {
        // A real file inside: were the permission bits ignored, the walk would
        // return this file rather than [], so the assertion cannot pass by
        // the read silently succeeding.
        writeFileSync(join(root, "one.yml"), "name: one\n");
        chmodSync(root, 0o000);
        const named = new RegExp(`^cannot read the scenario directory ${escapeRe(root)}: .*EACCES`);
        expect(() => collectYmlFiles(root)).toThrow(named);
        // loadScenarios is what run.ts and the coverage tripwire call, so the
        // failure must reach them through it.
        expect(() => loadScenarios([root])).toThrow(named);
      }),
  );

  test.skipIf(runningAsRoot)(
    "an unreadable section directory fails the whole corpus, naming its scenarios/ root",
    () =>
      // The roots are never filtered by existence: existsSync cannot tell an absent scenarios/ from one
      // under a mode-000 <key>/, so scenarioRoots lists it and the loader is what tells absent from unreadable.
      withTempRoot((sections) => {
        const key = SECTION_KEYS[0];
        const section = join(sections, key);
        const unreadable = join(section, "scenarios");
        mkdirSync(unreadable, { recursive: true });
        writeFileSync(join(unreadable, "one.yml"), "name: one\n");
        chmodSync(section, 0o000);
        try {
          const roots = scenarioRoots(sections);
          expect(roots[0]).toBe(join(import.meta.dir, "scenarios"));
          expect(roots).toContain(unreadable);
          expect(() => loadScenarios(roots.slice(1))).toThrow(
            new RegExp(`^cannot read the scenario directory ${escapeRe(unreadable)}: .*EACCES`),
          );
        } finally {
          // withTempRoot restores only the top of the tree; this nested
          // directory needs its own restore before the recursive removal.
          chmodSync(section, 0o700);
        }
      }),
  );
});

describe("marker-label fixture pin (markerLabelFixtureMismatches)", () => {
  const driftedMarker = {
    name: MARKER_LABEL,
    color: "ffffff",
    description: MARKER_LABEL_CONFIG.description,
  };
  const canonicalMarker = { ...MARKER_LABEL_CONFIG };
  const multiRepoWith = (marker: Record<string, unknown>): Record<string, unknown> => ({
    name: "m",
    settings: {},
    repos: { "e2e-owner/svc-a": { settings: { labels: [marker] } } },
    expect: { exit_code: 0 },
  });

  test.each<[label: string, raw: Record<string, unknown>, field: RegExp]>([
    [
      "in DECLARED settings",
      { name: "m", settings: { labels: [driftedMarker] }, expect: { exit_code: 0 } },
      /settings\.labels\[0\]\.color/,
    ],
    [
      "in a multi-repo target's settings, with its slug path",
      multiRepoWith(driftedMarker),
      /repos\.e2e-owner\/svc-a\.settings\.labels\[0\]\.color/,
    ],
  ])("a drifted marker %s fails scenario load, naming the field", (_label, raw, field) => {
    expect(() => parseScenario(raw, "m.yml")).toThrow(field);
  });

  // The pin covers declared fixtures only: a future scenario testing that the report path repairs a mangled live
  // marker must stay expressible.
  test.each<[label: string, raw: Record<string, unknown>]>([
    ["the canonical marker in a multi-repo target's settings", multiRepoWith(canonicalMarker)],
    [
      "a drifted marker in live_state (seeding stale marker state is legitimate)",
      {
        name: "m",
        settings: {},
        live_state: { labels: [driftedMarker] },
        expect: { exit_code: 0 },
      },
    ],
    [
      "non-marker labels and field-less marker references",
      {
        name: "m",
        settings: { labels: [{ name: "bug", color: "ffffff" }, { name: MARKER_LABEL }] },
        expect: { exit_code: 0 },
      },
    ],
  ])("%s LOADS with no mismatch", (_label, raw) => {
    expect(markerLabelFixtureMismatches(parseScenario(raw, "m.yml"))).toEqual([]);
  });
});

describe("harness identity constants", () => {
  test("no identity constant contains the inert token (leak-sweep disjointness)", () => {
    // An identity constant containing E2E_TOKEN (TOKEN_USER_LOGIN nearly did) turns a legitimate rendering into a phantom leak.
    const rendered = { ADMIN_OWNER, ADMIN_REPO, ADMIN_SLUG, TOKEN_USER_LOGIN, VIOLATION_PREFIX };
    for (const [name, value] of Object.entries(rendered)) {
      expect(`${name}="${value}"`.includes(E2E_TOKEN)).toBe(false);
    }
  });

  test("section mock fragments mint identity from state.slug, never the harness constants", async () => {
    // Urls minted from ADMIN_SLUG were served verbatim for multi-repo targets in five fragments, so the
    // class is banned at the import boundary: a fragment always has the owning state in scope.
    const offenders: string[] = [];
    let fragments = 0;
    for await (const file of new Bun.Glob("src/sections/*/mock.ts").scan(ROOT)) {
      fragments++;
      const text = await Bun.file(join(ROOT, file)).text();
      if (/from "[^"]*\/test\/e2e\/constants\.js"/.test(text)) {
        offenders.push(file);
      }
    }
    expect(fragments).toBeGreaterThan(0);
    expect(offenders.sort()).toEqual([]);
  });
});
