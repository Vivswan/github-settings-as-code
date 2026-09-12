/**
 * Which sections a run processes and which of them must fully apply. The
 * pair is validated ONCE here: a required section outside a non-empty
 * allowlist would let the run pass green having proven nothing about it,
 * because the engine reports excluded sections without attempting them. The
 * constructor is private and the fields are too, so neither a literal nor a
 * spread of an existing selection typechecks as one (a spread drops private
 * members): every selection the engine sees passed `of`, whether it came from
 * the action's inputs or a library caller.
 */

import { err, ok, type Result } from "neverthrow";
import type { ProblemOf } from "../problem.js";
import type { SectionKey } from "../schema.js";

export class SectionSelection {
  /** The selection that processes every declared section and requires none. */
  static readonly ALL = new SectionSelection(new Set(), new Set());

  private constructor(
    private readonly onlyKeys: ReadonlySet<SectionKey>,
    private readonly requiredKeys: ReadonlySet<SectionKey>,
  ) {}

  /** The only public way in; a refusal names the required sections the allowlist excludes. */
  static of(input: {
    only?: Iterable<SectionKey>;
    required?: Iterable<SectionKey>;
  }): Result<SectionSelection, ProblemOf<"required-sections-excluded">> {
    const only = new Set(input.only ?? []);
    const required = new Set(input.required ?? []);
    if (only.size > 0) {
      const excluded = [...required].filter((key) => !only.has(key));
      if (excluded.length > 0) {
        return err({ code: "required-sections-excluded", excluded });
      }
    }
    return ok(new SectionSelection(only, required));
  }

  /** The allowlist; empty means every declared section is processed. */
  get only(): ReadonlySet<SectionKey> {
    return this.onlyKeys;
  }

  /** The sections that must fully apply even under on-missing-permission: warn. */
  get required(): ReadonlySet<SectionKey> {
    return this.requiredKeys;
  }
}
