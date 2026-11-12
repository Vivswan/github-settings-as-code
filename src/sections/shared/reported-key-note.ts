/**
 * The note for declared keys GitHub only reports: its GET returns them and no write takes them. An open shape still
 * parses one, so its planner names it here, from the declaration alone, whatever the live side holds.
 */

import { agree } from "../../text.js";

/** One holder's reported keys and the words its note puts around them. */
interface ReportedKeys {
  /** The keys the holder's GET reports and its write does not take. */
  readonly keys: readonly string[];

  /** The clause each key completes: "the PUT does not take", "neither the POST nor the PATCH takes". */
  readonly write: string;

  /** What follows for a declared one, from "so" on. */
  readonly outcome: string;
}

/** The reported keys `declared` holds, and the one note naming them; no note when it holds none. */
export function reportedKeyNote(
  label: string,
  declared: object,
  reported: ReportedKeys,
): { keys: readonly string[]; notes: string[] } {
  const keys = reported.keys.filter((key) => Object.hasOwn(declared, key));
  if (keys.length === 0) {
    return { keys, notes: [] };
  }

  const list = keys.map((key) => `"${key}"`).join(", ");
  const count = keys.length;
  const them = agree(count, "it", "them");
  const note =
    `${label}: ${list} ${agree(count, "is a value", "are values")} GitHub reports, not ${agree(count, "a setting", "settings")} it accepts ` +
    `(the GET returns ${them}, ${reported.write} ${them}), ${reported.outcome}; remove ${them} from the settings file`;
  return { keys, notes: [note] };
}
