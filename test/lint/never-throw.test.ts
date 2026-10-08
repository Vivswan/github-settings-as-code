/**
 * The plugin's verdict on every throw class, and its biome.json wiring, pinned by linting a fixture tree with the
 * repository's own configuration; a pattern that silently stops matching would otherwise let a throw pass unseen.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import { lint } from "./fixture-lint.js";

const MESSAGE =
  "throw outside the never-throw rule: not a BUG: invariant (an Error whose message starts with BUG:) and not a bare rethrow of the catch binding; return a Result instead";

/** A line ending in `// outside` is one the plugin must flag; every other throw here is inside the rule. */
const OUTSIDE = /\/\/ outside$/;

const THROWS = `
export function bug(x: unknown): never {
  if (x === null) throw new Error("BUG: bug() was handed null");
  if (x === undefined) throw new Error("BUG: bug() was handed undefined", { cause: x });
  throw new RangeError(\`BUG: bug() was handed \${String(x)}\`);
}
export function rethrow(run: () => void, keep: boolean): void {
  try {
    run();
  } catch (error) {
    if (keep) {
      throw error;
    }
    run();
    throw error;
  }
}
export function rethrowBeforeFinally(run: () => void): void {
  try {
    run();
  } catch (error) {
    run();
    throw error;
  } finally {
    run();
  }
}
export const rethrowInArrow = (run: () => void): void => {
  try {
    run();
  } catch (error) {
    run();
    throw error;
  }
};
export function wrapped(run: () => void): void {
  try {
    run();
  } catch (error) {
    const failure = new Error("y", { cause: error });
    throw failure; // outside
  }
}
export function shadowed(run: (cause?: unknown) => void): void {
  try {
    run();
  } catch (error) {
    run(error);
    {
      const error = new Error("x");
      throw error; // outside
    }
  }
}
export function shadowedByLoop(run: (cause?: unknown) => void): void {
  try {
    run();
  } catch (error) {
    run(error);
    for (const error of [new Error("y")]) {
      throw error; // outside
    }
  }
}
export function fromCallbacks(run: () => void, items: number[]): void {
  try {
    run();
  } catch (error) {
    items.map((x) => {
      if (x) throw error; // outside
      return x;
    });
    items.forEach(function (x) {
      if (x > this.floor) throw error; // outside
    }, { floor: 1 });
    items.map(async () => {
      throw error; // outside
    });
  }
}
export function afterTheCatch(run: () => void): void {
  try {
    run();
  } catch (error) {
    run();
    throw error;
  }
  const error = new Error("x");
  throw error; // outside
}
export function unbound(run: () => void): never {
  try {
    run();
  } catch {
    throw run; // outside
  }
  throw new Error("x"); // outside
}
export function notBug(): never {
  throw new Error(\`not BUG: \${1}\`); // outside
}
export function bare(): never {
  throw "x"; // outside
}
export function fromTheTryBody(error: unknown, run: () => void): unknown {
  try {
    throw error; // outside
  } catch (error) {
    run();
    return error;
  }
}
export function bugByExpression(x: string): never {
  if (x) throw new Error("BUG: sentinel".slice(5)); // outside
  throw new Error("BUG: " + x); // outside
}
export function bugWithMoreArguments(x: string): never {
  throw new Error("BUG: x", { cause: x }, 3);
}
export function shadowedByDestructuring(run: (cause?: unknown) => void): void {
  try {
    run();
  } catch (error) {
    run(error);
    {
      const { error } = { error: new Error("x") };
      throw error; // outside
    }
  }
}
export function shadowedByAParameter(run: (cause?: unknown) => void, items: unknown[]): void {
  try {
    run();
  } catch (error) {
    items.map((error) => {
      throw error; // outside
    });
    run(error);
    throw error; // outside
  }
}
export function shadowedByANamespace(run: (cause?: unknown) => void, mode: number): void {
  try {
    run();
  } catch (error) {
    run(error);
    switch (mode) {
      default: {
        namespace error {
          export const other = 1;
        }
        throw error; // outside
      }
    }
  }
}
export function shadowedByATypeAlias(run: (code?: unknown) => void, mode: number): void {
  try {
    run();
  } catch (error) {
    switch (mode) {
      default: {
        type error = number;
        const code: error = 0;
        run(code);
        throw error;
      }
    }
  }
}
export function shadowedByATypeSignature(run: (code?: unknown) => void, mode: number): void {
  try {
    run();
  } catch (error) {
    switch (mode) {
      default: {
        type Handler = (error: unknown) => void;
        const handle: Handler = run;
        handle(error);
        throw error;
      }
    }
  }
}
export function shadowedByAnAnnotation(run: (code?: unknown) => void): void {
  try {
    run();
  } catch (error) {
    const handle: (error: unknown) => void = run;
    handle(error);
    throw error;
  }
}
export function fromAMethod(run: () => void): { fail(): never } {
  try {
    run();
  } catch (error) {
    return {
      fail() {
        throw error; // outside
      },
    };
  }
  return {
    fail: () => {
      throw new Error("BUG: unreachable");
    },
  };
}
export function rethrowTwiceOnceFromACallback(run: () => void, fail: boolean): (() => never) | undefined {
  try {
    run();
  } catch (error) {
    if (fail) throw error;
    return () => {
      throw error; // outside
    };
  }
  return undefined;
}
export function rethrowFromANestedCatch(run: () => void, cleanup: () => void): void {
  try {
    run();
  } catch (outer) {
    try {
      cleanup();
    } catch {
      throw outer; // outside
    }
    try {
      cleanup();
    } catch (inner) {
      run();
      throw inner;
    }
  }
}
export function fromANestedTry(run: () => void): void {
  try {
    run();
  } catch (error) {
    try {
      throw error; // outside
    } catch {
      run();
    }
    try {
      run();
    } finally {
      throw error; // outside
    }
  }
}
export function destructuredBinding(run: () => void, fail: boolean): void {
  try {
    run();
  } catch ({ message }) {
    if (fail) throw { message }; // outside
    throw message; // outside
  }
}
export function rethrowInsideACallbackCatch(run: (cause?: unknown) => void): () => void {
  try {
    run();
  } catch (error) {
    run(error);
    return () => {
      try {
        run();
      } catch (error) {
        run();
        throw error;
      }
    };
  }
  return run;
}
export function hidden(): never {
  throw new Error('prefix "BUG: hidden'); // outside
}
`.trimStart();

const OUTSIDE_THE_RULE = 'export function outside(): never {\n  throw new Error("x");\n}\n';
const CONTRACT_FILE = "src/cli/inputs.ts";

describe("the never-throw plugin", () => {
  test("flags exactly the throws outside the rule, and nothing outside src/ or in the contract file", () =>
    withTempDir("never-throw-", (dir) => {
      const expected = Object.fromEntries(
        THROWS.split("\n").flatMap((line, index) =>
          OUTSIDE.test(line) ? [[`src/throws.ts:${index + 1}`, `plugin: ${MESSAGE}`]] : [],
        ),
      );
      expect(
        lint(dir, {
          "src/throws.ts": THROWS,
          [CONTRACT_FILE]: OUTSIDE_THE_RULE,
          "src/cli/beside-the-contract.ts": OUTSIDE_THE_RULE,
          // The generated index is exempt from the formatter only, so the rule still reaches it.
          "src/generated/upstream-gaps.ts": OUTSIDE_THE_RULE,
          "test/src/fixture.ts": OUTSIDE_THE_RULE,
          ".github/scripts/beside-the-tree.ts": OUTSIDE_THE_RULE,
        }),
      ).toEqual({
        ...expected,
        "src/cli/beside-the-contract.ts:2": `plugin: ${MESSAGE}`,
        "src/generated/upstream-gaps.ts:2": `plugin: ${MESSAGE}`,
      });
    }));

  test("the contract file still throws outside the rule, so its exemption is not stale", () =>
    withTempDir("never-throw-", (dir) => {
      const flagged = lint(dir, {
        "src/cli/under-the-rule.ts": readFileSync(join(ROOT, CONTRACT_FILE), "utf8"),
      });
      expect(Object.keys(flagged)).not.toEqual([]);
      expect(new Set(Object.values(flagged))).toEqual(new Set([`plugin: ${MESSAGE}`]));
    }));
});
