/**
 * The parse-time rules the two setup slices (code scanning default setup, code quality setup) share:
 * what the settings file alone shows to be wrong is refused here, naming the key and the fix, instead
 * of surfacing as a 422 at apply or as drift that never converges. Imports only zod, the text leaf, and
 * the raw-value readers, like schema-helpers.ts, so the slices src/schema.ts composes stay free of import cycles.
 */

import { z } from "zod";
import { agree } from "../../text.js";
import { siblingText } from "./raw-values.js";

type Names = readonly [string, ...string[]];

/**
 * A setup's `languages` vocabulary: what its PATCH accepts, and what only its GET reports. Declared
 * `as const satisfies SetupLanguages`, so the slice's inferred type keeps the literal names.
 */
export interface SetupLanguages<Declarable extends Names = Names> {
  /** The PATCH body's enum; the slice's `languages` items and the published schema come from it. */
  readonly declarable: Declarable;
  /**
   * The GET's names the PATCH does not take, each with the declarable name it folds onto, or null
   * when it has none and is left out with a note wherever it is read.
   *
   *   javascript, typescript -> "javascript-typescript"   (code scanning)
   *   rust                   -> null                      (code quality)
   */
  readonly getOnly: Readonly<Record<string, string | null>>;
}

/** A vendored setup body's `languages` items. */
type LanguagesOf<Body extends { languages?: readonly string[] | null }> = NonNullable<
  Body["languages"]
>[number];

/**
 * The names on which a hand-written vocabulary and the vendored spec disagree, in either direction:
 * `declarable` must be exactly the PATCH's enum, and `getOnly`'s keys exactly the GET's names the
 * PATCH lacks. Never while they agree; each slice pins its constant under MustBeNever, so a name the
 * spec adds or drops fails the typecheck by that name instead of becoming a silent false refusal.
 */
export type VocabularyDrift<
  Vocabulary extends SetupLanguages,
  Get extends { languages?: readonly string[] | null },
  Patch extends { languages?: readonly string[] | null },
> =
  | Exclude<Vocabulary["declarable"][number], LanguagesOf<Patch>>
  | Exclude<LanguagesOf<Patch>, Vocabulary["declarable"][number]>
  | Exclude<keyof Vocabulary["getOnly"], Exclude<LanguagesOf<Get>, LanguagesOf<Patch>>>
  | Exclude<Exclude<LanguagesOf<Get>, LanguagesOf<Patch>>, keyof Vocabulary["getOnly"]>;

/** The `languages` items: the PATCH enum, with the GET's own spellings refused by name and fix. */
export function languagesSchema<const Declarable extends Names>(
  vocabulary: SetupLanguages<Declarable>,
) {
  return z.array(
    z.enum(vocabulary.declarable, {
      error: (issue) => {
        const input = issue.input;
        if (typeof input !== "string") {
          return undefined;
        }
        if (!Object.hasOwn(vocabulary.getOnly, input)) {
          return undefined;
        }
        const folded = vocabulary.getOnly[input];
        return folded === null
          ? `${JSON.stringify(input)} is reported by GitHub but the PATCH cannot set it; remove it from the settings file (it stays as GitHub detected it)`
          : `${JSON.stringify(input)} is the spelling GitHub reports, not one the PATCH accepts; write ${JSON.stringify(folded)}`;
      },
    }),
  );
}

/** Both GETs report these and neither PATCH accepts them, so a declared value could only drift. */
const GET_ONLY_KEYS = ["schedule", "updated_at"] as const;

interface RunnerFields {
  readonly runner_type?: "standard" | "labeled";
  readonly runner_label?: string | null;
}

/**
 * For the setup slice's `.superRefine`. Only the loosen()ed clone, which keeps unknown keys, parses
 * documents, so the GET-only keys are read off the parsed record.
 *
 *   schedule / updated_at declared        -> refused: the PATCH has no such field
 *   runner_type: labeled, no runner_label -> refused: GitHub needs the label to pick the runner
 *   runner_label, runner_type not labeled -> refused: GitHub ignores the label, so it would drift
 */
export function refineSetup(declared: RunnerFields, refineCtx: z.RefinementCtx): void {
  const record = declared as Record<string, unknown>;
  for (const key of GET_ONLY_KEYS) {
    if (record[key] !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: [key],
        message: `${JSON.stringify(key)} is reported by GitHub but the PATCH does not accept it, so declaring it could only drift; remove it from the settings file`,
      });
    }
  }
  const { runner_type, runner_label } = declared;
  if (runner_type === "labeled" && typeof runner_label !== "string") {
    refineCtx.addIssue({
      code: "custom",
      path: ["runner_label"],
      message:
        'runner_type: "labeled" needs a runner_label naming the self-hosted runner label; declare runner_label, or set runner_type: "standard"',
    });
  }
  if (runner_type !== "labeled" && typeof runner_label === "string") {
    const under =
      runner_type === undefined
        ? "without runner_type"
        : `under runner_type: ${siblingText(runner_type)}`;
    refineCtx.addIssue({
      code: "custom",
      path: ["runner_label"],
      message: `runner_label ${JSON.stringify(runner_label)} is declared ${under}, where GitHub ignores it; set runner_type: "labeled", or remove runner_label`,
    });
  }
}

/** The ONE wording for live languages the PATCH cannot declare, for the plan's compare note and the snapshot's. */
export function undeclarableLanguages(names: readonly string[]): string {
  const list = names.map((name) => JSON.stringify(name)).join(", ");
  return `GitHub reports ${list}, which the PATCH's languages vocabulary has no value for, so ${agree(names.length, "it stays", "they stay")} as GitHub detected ${agree(names.length, "it", "them")}`;
}
