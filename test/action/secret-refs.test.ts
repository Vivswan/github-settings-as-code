import { describe, expect, test } from "bun:test";
import {
  RESERVED_REF_PREFIXES,
  resolveSecretRefs,
  type SourcedSecretValue,
  validateSecretRef,
} from "../../src/action/secret-refs.js";

/** The entry label validateSecretRef weaves into its error prose. */
const LABEL = 'the secret entry "TEST_ENTRY"';

describe("validateSecretRef (syntax phase, never reads the environment)", () => {
  test("a whole-value $NAME reference from an operator source is accepted", () => {
    // No environment is in scope at all: the function takes none, so accepting
    // here proves syntax validation cannot depend on a variable being set.
    const result = validateSecretRef("$WEBHOOK_SECRET", "operator", LABEL);
    expect(result.ok).toBe(true);
    expect(result.ok && result.ref.name).toBe("WEBHOOK_SECRET");
  });

  test("a value that embeds $NAME without being one is rejected, naming the fragment", () => {
    const result = validateSecretRef("prefix-$TOKEN", "operator", LABEL);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error).toContain("$TOKEN");
    expect(result.error).toContain("whole-value");
    // The surrounding text may itself be half a secret; it must not be echoed.
    expect(result.error).not.toContain("prefix-");
  });

  test("a literal value is rejected and never echoed", () => {
    const result = validateSecretRef("hunter2-plaintext", "operator", LABEL);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error).toContain("literal");
    expect(result.error).toContain("committed plaintext");
    expect(result.error).toContain("$NAME");
    expect(result.error).not.toContain("hunter2");
  });

  test("every reserved prefix is refused, naming the prefix", () => {
    for (const prefix of RESERVED_REF_PREFIXES) {
      const result = validateSecretRef(`$${prefix}SOMETHING`, "operator", LABEL);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected rejection");
      }
      expect(result.error).toContain(`${prefix}*`);
      expect(result.error).toContain("reserved");
    }
  });

  test("a name merely starting like a reserved word is not reserved", () => {
    // INPUTX does not match INPUT_ (the underscore is part of the prefix).
    expect(validateSecretRef("$INPUTX", "operator", LABEL).ok).toBe(true);
  });

  test("a reference in a target-fetched settings source is a hard error", () => {
    const result = validateSecretRef("$DEPLOY_KEY", "target", LABEL);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error).toContain("target-fetched");
    expect(result.error).toContain("operator");
  });

  test("the target boundary precedes the reserved check", () => {
    // A target-sourced reserved name must be refused for the routing reason,
    // so the error explains the boundary rather than the lesser rule.
    const result = validateSecretRef("$GITHUB_TOKEN", "target", LABEL);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error).toContain("target-fetched");
  });

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
  for (const [name, value] of Object.entries(NOT_WHOLE_VALUE)) {
    test(`${name} is not a whole-value reference`, () => {
      expect(validateSecretRef(value, "operator", LABEL).ok).toBe(false);
    });
  }

  test("an underscore-leading name is a valid reference", () => {
    expect(validateSecretRef("$_PRIVATE", "operator", LABEL).ok).toBe(true);
  });
});

const operator = (value: string): SourcedSecretValue => ({
  value,
  label: LABEL,
  source: "operator",
});

describe("resolveSecretRefs (resolution phase, injected environment)", () => {
  test("a valid reference resolves to the env value and lists it for masking", () => {
    const result = resolveSecretRefs([operator("$WEBHOOK_SECRET")], {
      WEBHOOK_SECRET: "s3cret-value",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
    expect(result.values.WEBHOOK_SECRET).toBe("s3cret-value");
    expect(result.mask).toEqual(["s3cret-value"]);
  });

  test("two references to one variable resolve once and mask once", () => {
    const result = resolveSecretRefs([operator("$SHARED"), operator("$SHARED")], {
      SHARED: "same",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }
    expect(result.values).toEqual({ SHARED: "same" });
    expect(result.mask).toEqual(["same"]);
  });

  test("two variables holding the same plaintext mask it once", () => {
    const result = resolveSecretRefs([operator("$FIRST_NAME"), operator("$SECOND_NAME")], {
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

  test("an unset variable fails, naming the reference and the rule", () => {
    const result = resolveSecretRefs([operator("$MISSING_SECRET")], {});
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("$MISSING_SECRET");
    expect(result.errors[0]).toContain("unset");
    expect(result.errors[0]).toContain("env block");
  });

  test("a set-but-empty variable fails: an empty lookup must not write an empty secret", () => {
    const result = resolveSecretRefs([operator("$EMPTY_SECRET")], { EMPTY_SECRET: "" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.errors[0]).toContain("$EMPTY_SECRET");
    expect(result.errors[0]).toContain("set but empty");
    expect(result.errors[0]).toContain("empty secret");
  });

  test("every broken reference is reported, not just the first", () => {
    const result = resolveSecretRefs(
      [operator("$UNSET_ONE"), operator("literal"), operator("$OK_SECRET"), operator("$EMPTY_ONE")],
      { OK_SECRET: "fine", EMPTY_ONE: "" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.errors).toHaveLength(3);
  });

  test("a target-sourced value fails resolution even when the variable is set", () => {
    const result = resolveSecretRefs(
      [{ value: "$WEBHOOK_SECRET", label: LABEL, source: "target" }],
      {
        WEBHOOK_SECRET: "would-leak",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.errors[0]).toContain("target-fetched");
    // The rejection is about routing, and it must not read or echo the value.
    expect(result.errors[0]).not.toContain("would-leak");
  });

  test("a mixed batch cannot launder a target reference behind operator ones", () => {
    // Every value carries its own provenance, so one resolution can span
    // documents: the operator's reference resolves while the target's is
    // refused, and the whole batch fails.
    const result = resolveSecretRefs(
      [operator("$FLEET_SECRET"), { value: "$FLEET_SECRET", label: LABEL, source: "target" }],
      { FLEET_SECRET: "fleet-value" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("target-fetched");
    expect(result.errors[0]).not.toContain("fleet-value");
  });
});
