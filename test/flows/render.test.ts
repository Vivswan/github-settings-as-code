import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok } from "neverthrow";
import { collectingIo, concludeRender, type RenderConfig, runRender } from "../../src/index.js";
import { withTempDir } from "../temp-dir.js";

const FLEET = "repository:\n  has_wiki: false\n";
const REPO = "repository:\n  has_issues: true\n";

describe("runRender", () => {
  /** The two layers written into `dir`, and the config folding them into `renderedFile`. */
  const cfg = (dir: string, renderedFile: string): RenderConfig => {
    writeFileSync(join(dir, "fleet.yml"), FLEET);
    writeFileSync(join(dir, "repo.yml"), REPO);
    return {
      settingsFiles: [join(dir, "fleet.yml"), join(dir, "repo.yml")],
      renderedFile,
      layering: "deep",
    };
  };

  test("folds the layers into rendered-file, and the finished render concludes rendered", () =>
    withTempDir("run-merge-", (dir) => {
      const collected = collectingIo();
      const renderedFile = join(dir, "out", "merged.yml");
      const config = cfg(dir, renderedFile);
      const merged = runRender(config, collected.io);
      expect(merged).toEqual(ok({ layers: config.settingsFiles, renderedFile }));
      expect(readFileSync(renderedFile, "utf8")).toBe(
        "repository:\n  has_issues: true\n  has_wiki: false\n",
      );
      expect(concludeRender(collected.io, merged._unsafeUnwrap())).toBe(0);
      expect(collected.outputs).toEqual({
        result: "rendered",
        "skipped-sections": "",
        "repos-result": "{}",
      });
    }));

  test.each<[string, (dir: string) => string, number, string]>([
    ["a layer's own path", (d) => join(d, "repo.yml"), 1, "repo.yml"],
    ["a ./ spelling of a layer, compared resolved", (d) => `${d}/./fleet.yml`, 0, "fleet.yml"],
  ])(
    "a rendered-file naming %s fails before any write, naming the layer's position",
    (_case, renderedFile, index, layer) =>
      withTempDir("run-merge-", (dir) => {
        const collected = collectingIo();
        const target = renderedFile(dir);
        expect(runRender(cfg(dir, target), collected.io)).toEqual(
          err({
            code: "rendered-file-is-layer" as const,
            renderedFile: target,
            index,
            layer: join(dir, layer),
          }),
        );
        expect(collected.lines).toEqual([]);
        expect(readFileSync(join(dir, "fleet.yml"), "utf8")).toBe(FLEET);
        expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
      }),
  );

  test("a sibling file beside the merged file is never touched, whether a layer or the user's own", () =>
    withTempDir("run-merge-", (dir) => {
      // The write stages under a name unique to the run, so a `<rendered-file>.tmp` the user owns, or one that IS a
      // layer, survives the write untouched.
      writeFileSync(join(dir, "fleet.yml"), FLEET);
      const owned = join(dir, "merged.yml.tmp");
      writeFileSync(owned, REPO);
      const renderedFile = join(dir, "merged.yml");
      const collected = collectingIo();
      const merged = runRender(
        { settingsFiles: [join(dir, "fleet.yml"), owned], renderedFile, layering: "deep" },
        collected.io,
      );
      expect(merged).toEqual(ok({ layers: [join(dir, "fleet.yml"), owned], renderedFile }));
      expect(readFileSync(owned, "utf8")).toBe(REPO);
      expect(readFileSync(renderedFile, "utf8")).toBe(
        "repository:\n  has_issues: true\n  has_wiki: false\n",
      );
      expect(readdirSync(dir).sort()).toEqual(["fleet.yml", "merged.yml", "merged.yml.tmp"]);
    }));
});

describe("runRender writes through the shared writer", () => {
  const twoLayers = (dir: string): string[] => {
    writeFileSync(join(dir, "fleet.yml"), FLEET);
    writeFileSync(join(dir, "repo.yml"), REPO);
    return [join(dir, "fleet.yml"), join(dir, "repo.yml")];
  };
  const MERGED = "repository:\n  has_issues: true\n  has_wiki: false\n";
  const merge = (layers: string[], renderedFile: string) =>
    runRender({ settingsFiles: layers, renderedFile, layering: "deep" }, collectingIo().io);

  test("a rendered-file that is a link to a layer is admitted: the rename replaces the link and the layer stands", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const renderedFile = join(dir, "out.yml");
      symlinkSync("repo.yml", renderedFile);
      expect(merge(layers, renderedFile)).toEqual(ok({ layers, renderedFile }));
      expect(lstatSync(renderedFile).isSymbolicLink()).toBe(false);
      expect(readFileSync(renderedFile, "utf8")).toBe(MERGED);
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    }));

  test("a layer read through a link to the destination is refused: the write would change what the next run reads", () =>
    withTempDir("run-merge-", (dir) => {
      twoLayers(dir);
      const alias = join(dir, "alias.yml");
      symlinkSync("repo.yml", alias);
      const layers = [join(dir, "fleet.yml"), alias];
      const renderedFile = join(dir, "repo.yml");
      expect(merge(layers, renderedFile)).toEqual(
        err({ code: "rendered-file-is-layer" as const, renderedFile, index: 1, layer: alias }),
      );
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    }));

  test.each<[string, (dir: string) => { layer: string; renderedFile: string }]>([
    [
      "a chain: the destination is a link in the middle of the layer's read",
      (d) => {
        symlinkSync("repo.yml", join(d, "out.yml"));
        symlinkSync("out.yml", join(d, "alias.yml"));
        return { layer: join(d, "alias.yml"), renderedFile: join(d, "out.yml") };
      },
    ],
    [
      "a directory link the layer is read through",
      (d) => {
        symlinkSync(".", join(d, "folder"));
        return { layer: join(d, "folder", "repo.yml"), renderedFile: join(d, "folder") };
      },
    ],
  ])("%s is refused: the write would change what the next run reads", (_case, shape) =>
    withTempDir("run-merge-", (dir) => {
      twoLayers(dir);
      const { layer, renderedFile } = shape(dir);
      const layers = [join(dir, "fleet.yml"), layer];
      expect(merge(layers, renderedFile)).toEqual(
        err({ code: "rendered-file-is-layer" as const, renderedFile, index: 1, layer }),
      );
      expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
    }),
  );

  test("a rendered-file that spells a layer's link in another case is refused on a case-insensitive filesystem", () =>
    withTempDir("run-merge-", (dir) => {
      writeFileSync(join(dir, "Probe"), "");
      const caseInsensitive = existsSync(join(dir, "probe"));
      twoLayers(dir);
      const alias = join(dir, "alias.yml");
      symlinkSync("repo.yml", alias);
      const layers = [join(dir, "fleet.yml"), alias];
      const renderedFile = join(dir, "ALIAS.YML");
      const merged = merge(layers, renderedFile);
      if (caseInsensitive) {
        expect(merged).toEqual(
          err({ code: "rendered-file-is-layer" as const, renderedFile, index: 1, layer: alias }),
        );
        expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      } else {
        expect(merged).toEqual(ok({ layers, renderedFile }));
      }
    }));

  test("a layer that IS the link at the destination is refused: the rename would replace the layer's own entry", () =>
    withTempDir("run-merge-", (dir) => {
      twoLayers(dir);
      const link = join(dir, "out.yml");
      symlinkSync("repo.yml", link);
      const layers = [join(dir, "fleet.yml"), link];
      expect(merge(layers, link)).toEqual(
        err({ code: "rendered-file-is-layer" as const, renderedFile: link, index: 1, layer: link }),
      );
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    }));

  test("an existing merged file keeps its permission bits through the replace", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const renderedFile = join(dir, "merged.yml");
      writeFileSync(renderedFile, "stale\n");
      chmodSync(renderedFile, 0o600);
      // A permissive umask, so a writer that forgot the mode would land at 0644 and fail the pin.
      const previous = process.umask(0o022);
      try {
        expect(merge(layers, renderedFile)).toEqual(ok({ layers, renderedFile }));
      } finally {
        process.umask(previous);
      }
      expect(readFileSync(renderedFile, "utf8")).toBe(MERGED);
      expect(statSync(renderedFile).mode & 0o777).toBe(0o600);
    }));

  test("a rendered-file spelled through a link and .. stages beside the destination the OS resolves, not beside cwd", () =>
    withTempDir("run-merge-", (dir) => {
      // `link/../out.yml`: the OS follows the link and steps up, so the file lands beside `inner`; a staging name
      // built with join() would collapse `link/..` lexically and stage under `dir`. `dir` is made read-only for the
      // write, so a staging file placed there fails the run instead of quietly renaming across.
      mkdirSync(join(dir, "elsewhere", "inner"), { recursive: true });
      symlinkSync(join("elsewhere", "inner"), join(dir, "link"));
      const layers = twoLayers(dir);
      const renderedFile = `${dir}/link/../out.yml`;
      chmodSync(dir, 0o555);
      try {
        expect(merge(layers, renderedFile)).toEqual(ok({ layers, renderedFile }));
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(readFileSync(join(dir, "elsewhere", "out.yml"), "utf8")).toBe(MERGED);
      expect(readdirSync(join(dir, "elsewhere")).sort()).toEqual(["inner", "out.yml"]);
      expect(readdirSync(dir).filter((name) => name.startsWith(".gsac-"))).toEqual([]);
    }));

  test("a rendered-file that spells an existing layer in another case is refused on a case-insensitive filesystem", () =>
    withTempDir("run-merge-", (dir) => {
      writeFileSync(join(dir, "Probe"), "");
      const caseInsensitive = existsSync(join(dir, "probe"));
      const layers = twoLayers(dir);
      const renderedFile = join(dir, "REPO.YML");
      const merged = merge(layers, renderedFile);
      if (caseInsensitive) {
        expect(merged).toEqual(
          err({
            code: "rendered-file-is-layer" as const,
            renderedFile,
            index: 1,
            layer: join(dir, "repo.yml"),
          }),
        );
        expect(readFileSync(join(dir, "repo.yml"), "utf8")).toBe(REPO);
      } else {
        expect(merged).toEqual(ok({ layers, renderedFile }));
        expect(readFileSync(renderedFile, "utf8")).toBe(MERGED);
      }
    }));

  test("a rendered-file with a trailing slash fails on the rename, staged under the directory's own hidden name", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const renderedFile = `${dir}/out.yml/`;
      // The rename cannot land on `out.yml/`; the staging name in the OS's line is the one observable of where the write staged.
      expect(merge(layers, renderedFile)).toEqual(
        err({
          code: "rendered-file-unwritable" as const,
          path: renderedFile,
          reason: expect.stringContaining(`rename '${dir}/.gsac-`),
        }),
      );
      expect(readdirSync(dir).sort()).toEqual(["fleet.yml", "repo.yml"]);
    }));

  test("a rendered-file leaf at the filesystem's name limit is written: the staging name is short and its own", () =>
    withTempDir("run-merge-", (dir) => {
      const layers = twoLayers(dir);
      const renderedFile = join(dir, `${"m".repeat(251)}.yml`);
      expect(merge(layers, renderedFile)).toEqual(ok({ layers, renderedFile }));
      expect(readFileSync(renderedFile, "utf8")).toBe(MERGED);
      expect(readdirSync(dir).filter((name) => name.startsWith(".gsac-"))).toEqual([]);
    }));
});
