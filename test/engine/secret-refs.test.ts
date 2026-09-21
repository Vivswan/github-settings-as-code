import { describe, expect, test } from "bun:test";
import {
  RESERVED_REF_PREFIXES,
  resolveSecretRefs,
  type SettingsSource,
  validateSecretRef,
} from "../../src/engine/secret-refs.js";

/** The entry label validateSecretRef weaves into its error prose. */
const LABEL = 'the secret entry "TEST_ENTRY"';

/** An accepted reference by its name, or a refusal by the words its error says and the ones it withholds. */
type Verdict = { name: string } | { says: string[]; never?: string[] };

describe("validateSecretRef (syntax phase, never reads the environment)", () => {
  const NOT_WHOLE_VALUE: Record<string, string> = {
    "an empty string": "",
    "a bare dollar": "$",
    "a lowercase name": "$token",
    "a digit-leading name": "$1ABC",
    "an inner space": "$A B",
    "a trailing newline": "$TOKEN\n",
    "a leading newline": "\n$TOKEN",
    "a leading space": " $TOKEN",
    "a trailing space": "$TOKEN ",
    "a unicode letter": "$TÖKEN",
    "a suffixed reference": "$TOKEN-suffix",
    "two references": "$A$B",
  };

  test.each<[what: string, value: string, source: SettingsSource, verdict: Verdict]>([
    // The function takes no environment, so accepting here proves syntax validation cannot depend on a variable being set.
    [
      "a whole-value $NAME reference from an operator source is accepted",
      "$WEBHOOK_SECRET",
      "operator",
      { name: "WEBHOOK_SECRET" },
    ],
    [
      "an underscore-leading name is a valid reference",
      "$_PRIVATE",
      "operator",
      { name: "_PRIVATE" },
    ],
    // INPUTX does not match INPUT_ (the underscore is part of the prefix).
    [
      "a name merely starting like a reserved word is not reserved",
      "$INPUTX",
      "operator",
      { name: "INPUTX" },
    ],
    // The surrounding text may itself be half a secret; it must not be echoed.
    [
      "a value that embeds $NAME without being one is rejected, naming the fragment",
      "prefix-$TOKEN",
      "operator",
      { says: ["$TOKEN"], never: ["prefix-"] },
    ],
    [
      "a literal value is rejected and never echoed",
      "hunter2-plaintext",
      "operator",
      { says: ["literal"], never: ["hunter2"] },
    ],
    [
      "a reference in a target-fetched settings source is a hard error",
      "$DEPLOY_KEY",
      "target",
      { says: ["target-fetched"] },
    ],
    // A target-sourced reserved name is refused for the routing reason, so the error explains the boundary rather than the lesser rule.
    [
      "the target boundary precedes the reserved check",
      "$GITHUB_TOKEN",
      "target",
      { says: ["target-fetched"] },
    ],
    ...Object.entries(NOT_WHOLE_VALUE).map(
      ([what, value]): [string, string, SettingsSource, Verdict] => [
        `${what} is not a whole-value reference`,
        value,
        "operator",
        { says: [] },
      ],
    ),
  ])("%s", (_what, value, source, verdict) => {
    const result = validateSecretRef(value, source, LABEL);
    if ("name" in verdict) {
      expect(result).toEqual({ ok: true, ref: { name: verdict.name } });
      return;
    }
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    for (const word of verdict.says) {
      expect(result.error).toContain(word);
    }
    for (const word of verdict.never ?? []) {
      expect(result.error).not.toContain(word);
    }
  });

  test("every reserved prefix is refused, naming the prefix", () => {
    for (const prefix of RESERVED_REF_PREFIXES) {
      const result = validateSecretRef(`$${prefix}SOMETHING`, "operator", LABEL);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected rejection");
      }
      expect(result.error).toContain(`${prefix}*`);
    }
  });
});

describe("resolveSecretRefs (resolution phase over validated names, injected environment)", () => {
  test("a valid reference resolves to the env value and lists it for masking", () => {
    const result = resolveSecretRefs(["WEBHOOK_SECRET"], {
      WEBHOOK_SECRET: "s3cret-value",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
    expect(result.values.WEBHOOK_SECRET).toBe("s3cret-value");
    expect(result.mask).toEqual(["s3cret-value"]);
  });

  test("two variables holding the same plaintext mask it once", () => {
    const result = resolveSecretRefs(["FIRST_NAME", "SECOND_NAME"], {
      FIRST_NAME: "identical",
      SECOND_NAME: "identical",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
    expect(result.values).toEqual({ FIRST_NAME: "identical", SECOND_NAME: "identical" });
    expect(result.mask).toEqual(["identical"]);
  });

  // Each row: the names to resolve, the environment, and per failed reference the words its error must say.
  test.each<[what: string, names: string[], env: Record<string, string>, errors: string[][]]>([
    [
      "an unset variable fails, naming the reference and the rule",
      ["MISSING_SECRET"],
      {},
      [["$MISSING_SECRET", "unset"]],
    ],
    [
      "a set-but-empty variable fails: an empty lookup must not write an empty secret",
      ["EMPTY_SECRET"],
      { EMPTY_SECRET: "" },
      [["$EMPTY_SECRET", "set but empty"]],
    ],
    [
      "every unresolved reference is reported, not just the first",
      ["UNSET_ONE", "OK_SECRET", "EMPTY_ONE"],
      { OK_SECRET: "fine", EMPTY_ONE: "" },
      [
        ["$UNSET_ONE", "unset"],
        ["$EMPTY_ONE", "set but empty"],
      ],
    ],
  ])("%s", (_what, names, env, errors) => {
    const result = resolveSecretRefs(names, env);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.errors).toHaveLength(errors.length);
    errors.forEach((words, index) => {
      for (const word of words) {
        expect(result.errors[index]).toContain(word);
      }
    });
  });
});
