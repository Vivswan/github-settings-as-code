/**
 * The published schema's `pattern` for a deploy key line and parsePublicKey are two spellings of one acceptance
 * rule: the pattern is a hand-spelled grammar for editors, the parse judges the blob with zod's base64 check.
 * Nothing but this test ties them, so a zod release that moved its base64 semantics, or an edit to one spelling
 * alone, would otherwise split what an editor accepts from what the run accepts. The corpus is the keys the e2e
 * generators declare, a seeded sweep over every axis of the line, and the hand-made invalid set the pattern must
 * refuse the way the parse does: bad padding, a non-base64 character, an empty blob, a wrong length class.
 * The pattern is read from the built lib/settings.schema.json and compiled by ajv, the way an editor or CI linter judges it.
 */

import { describe, expect, test } from "bun:test";
import { Ajv } from "ajv";
import { PUBLIC_KEY_ALGORITHMS, parsePublicKey } from "../../../src/sections/deploy_keys/schema.js";
import { Rng } from "../../e2e/generators/prng.js";
import { readSettingsSchema } from "../../settings-schema.js";
import { genDeployKeys } from "./generators.js";

const SEED = 20261026;
const RANDOM_KEYS = 5000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LEADING = ["", "", " ", "\t", " \t", "\u00a0"];
const ALGORITHMS = [
  ...PUBLIC_KEY_ALGORITHMS,
  "ssh-dss",
  "ssh-ed448",
  "SSH-ED25519",
  "sk-ssh-ed25519@opensshXcom",
  "",
  "-----BEGIN",
];
const SEPARATORS = [" ", " ", "\t", "  ", " \t", "", "\u00a0", "\f", "\n"];
const COMMENTS = ["", "", " deploy@host", "\tc d", " c\u00a0d", " c\n", " AAAA", "  two  spaces "];
const TRAILING = ["", "", " ", "\t", "\n", "\r\n", "\u00a0"];
const BAD_CHARS = ["*", "-", "_", "=", ".", "\u00ff", " ", "\f", "\u00a0", "\n"];

const NOT_BASE64 = /^the key's second field is not base64/;
const FEWER_FIELDS = /^the key has fewer than two fields/;
const ODD_WHITESPACE = /^the key contains whitespace other than a space or tab/;

const INVALID: readonly [what: string, key: string, reason: RegExp][] = [
  ["bad padding, = after a full quartet", "ssh-ed25519 AAAAAAAA=", NOT_BASE64],
  ["bad padding, three =", "ssh-ed25519 AAAAA===", NOT_BASE64],
  ["bad padding, = mid-way", "ssh-ed25519 AAAA=AAA", NOT_BASE64],
  ["bad padding, padding alone", "ssh-ed25519 ====", NOT_BASE64],
  ["a non-base64 character", "ssh-ed25519 AAAA*AAA", NOT_BASE64],
  ["a base64url character", "ssh-ed25519 AAAA-AAA", NOT_BASE64],
  ["a non-ASCII character", "ssh-ed25519 AAAA\u00ffAAA", NOT_BASE64],
  ["an empty blob after a space", "ssh-ed25519 ", FEWER_FIELDS],
  ["an empty blob after a tab", "ssh-ed25519\t", FEWER_FIELDS],
  ["a wrong length class, one character", "ssh-ed25519 A", NOT_BASE64],
  ["a wrong length class, three", "ssh-ed25519 AAA", NOT_BASE64],
  ["a wrong length class, five", "ssh-ed25519 AAAAA", NOT_BASE64],
  ["a wrong length class, six unpadded", "ssh-ed25519 AAAAAA", NOT_BASE64],
  ["whitespace inside the blob", "ssh-ed25519 AAA\fAAAA", ODD_WHITESPACE],
];

const patternAccepts = (() => {
  const definition = readSettingsSchema().definitions.DeployKeyConfig as {
    properties: { key: { pattern: string } };
  };
  const ajv = new Ajv({ strict: false });
  return ajv.compile({ type: "string", pattern: definition.properties.key.pattern });
})();

/** A base64 run of `quartets` full groups, closed by the padding class. */
function validBlob(rng: Rng, quartets: number, padding: "" | "=" | "=="): string {
  const bodyLength = quartets * 4 + (padding === "" ? 0 : 4 - padding.length);
  const body = Array.from({ length: bodyLength }, () => ALPHABET[rng.int(ALPHABET.length)]);
  return body.join("") + padding;
}

/** The blob edited one way, its length class, a stray character, its padding, or emptied; an edit may land back on valid base64. */
function mutated(rng: Rng, blob: string): string {
  const at = blob.length === 0 ? 0 : rng.int(blob.length);
  switch (rng.int(8)) {
    case 0:
      return blob.slice(0, -1);
    case 1:
      return `${blob}A`;
    case 2:
      return blob.slice(0, at) + rng.pick(BAD_CHARS) + blob.slice(at + 1);
    case 3:
      return blob.slice(0, at) + rng.pick(BAD_CHARS) + blob.slice(at);
    case 4:
      return `${blob.replace(/=+$/, "")}===`;
    case 5:
      return `${blob.replace(/=+$/, "")}=`;
    case 6:
      return "";
    default:
      return `${blob.slice(0, at)}=${blob.slice(at)}`;
  }
}

/** One line drawn per axis; a value listed twice in an axis weights the draw toward the plain form, so most keys reach the blob. */
function randomKey(rng: Rng): string {
  const blob = validBlob(rng, rng.int(25), rng.pick(["", "", "=", "=="]));
  return [
    rng.pick(LEADING),
    rng.pick(ALGORITHMS),
    rng.pick(SEPARATORS),
    rng.bool(0.4) ? mutated(rng, blob) : blob,
    rng.pick(COMMENTS),
    rng.pick(TRAILING),
  ].join("");
}

/** The generators' keys, the invalid set, and the seeded sweep, distinct. */
function keyCorpus(): string[] {
  const rng = new Rng(SEED);
  const generated = Array.from({ length: 20 }, (_, seed) => genDeployKeys(new Rng(seed + 1)))
    .flat()
    .map((entry) => String((entry as { key: unknown }).key));
  const random = Array.from({ length: RANDOM_KEYS }, () => randomKey(rng));
  return [...new Set([...generated, ...INVALID.map(([, key]) => key), ...random])];
}

describe("the published key pattern and parsePublicKey are one acceptance rule", () => {
  test("every key of the corpus gets the same verdict from the published pattern and from the parse (control: both verdicts occur)", () => {
    const verdicts = keyCorpus().map(
      (key) => [key, patternAccepts(key), parsePublicKey(key).isOk()] as const,
    );
    expect(verdicts.filter(([, pattern, parse]) => pattern !== parse).map(([key]) => key)).toEqual(
      [],
    );
    expect(new Set(verdicts.map(([, , parse]) => parse))).toEqual(new Set([true, false]));
  });

  // zod's base64 check takes the empty string; the two-field check ahead of it is what makes the empty blob a missing field on both sides.
  test.each(INVALID)(
    "%s is refused by the published pattern and by the parse, which says why",
    (_what, key, reason) => {
      expect(patternAccepts(key)).toBe(false);
      expect(
        parsePublicKey(key).match(
          () => "accepted",
          (error) => error,
        ),
      ).toMatch(reason);
    },
  );
});
