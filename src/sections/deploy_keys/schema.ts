/**
 * The `deploy_keys:` section's schema slice; root src/schema.ts composes the SettingsFile property from it.
 * PUBLIC_KEY_ALGORITHMS is listed by hand in the docs field note and leaves out DSA (ssh-dss): GitHub stopped
 * accepting it on 2022-03-15, so a DSA key passing the parse would only fail at the create.
 *
 * PUBLIC_KEY_PATTERN is the published JSON Schema twin of parsePublicKey, which judges the blob with zod's base64
 * check; test/sections/deploy_keys/published-pattern.test.ts holds the two to one verdict. Its base64 grammar is
 * spelled by hand because zod's own published pattern opens with `^$|`, which no larger pattern can embed.
 * PRIVATE_KEY_FRAMING is assembled at runtime so no source line holds the string a secret scanner flags.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { open, rule } from "../shared/schema-helpers.js";

export const PUBLIC_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;
const ALGORITHMS = new Set<string>(PUBLIC_KEY_ALGORITHMS);
const ALGORITHM_ALTERNATION = PUBLIC_KEY_ALGORITHMS.map((algorithm) =>
  algorithm.replaceAll(".", "\\."),
).join("|");

const FIELD_SEPARATOR = String.raw`[ \t]`;
const FIELDS = new RegExp(`${FIELD_SEPARATOR}+`);
const LINE_BREAK = /[\r\n]/;
const ODD_WHITESPACE = /[^\S \t\r\n]/;

const BASE64_QUARTET = "[A-Za-z0-9+/]{4}";
const BASE64_PATTERN = `(?:${BASE64_QUARTET})*(?:${BASE64_QUARTET}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)`;
const PUBLIC_KEY_PATTERN = new RegExp(
  `^${FIELD_SEPARATOR}*(?:${ALGORITHM_ALTERNATION})${FIELD_SEPARATOR}+${BASE64_PATTERN}(?:${FIELD_SEPARATOR}[^\\r\\n]*)?$`,
);
const base64Blob = z.base64();

const PRIVATE_KEY_FRAMING = ["PRIVATE", "KEY-----"].join(" ");

const PUBLIC_KEY_FORM = `one line, "<algorithm> <base64> [comment]", with the algorithm one of ${PUBLIC_KEY_ALGORITHMS.join(", ")}`;
const FEWER_THAN_TWO_FIELDS = "the key has fewer than two fields separated by a space or tab";
const HAS_LINE_BREAK = "the key contains a line break";
const HAS_ODD_WHITESPACE =
  "the key contains whitespace other than a space or tab (a non-breaking space, for one)";
const BLOB_NOT_BASE64 =
  "the key's second field is not base64 (the alphabet A-Z a-z 0-9 + / with = padding to a multiple of four)";

/** `material` is the comparable form, algorithm + blob: GitHub may strip or rewrite the comment on storage. */
export interface PublicKeyMaterial {
  readonly algorithm: string;
  readonly material: string;
}

/** Splits on FIELD_SEPARATOR, the separator the published pattern spells, so the parse and an editor see the same fields. */
function fieldsOf(raw: string): string[] {
  return raw.split(FIELDS).filter((field) => field !== "");
}

/** Whether the settings file can declare a key under this algorithm; a live key under any other is outside the section. */
export function declaresAlgorithm(algorithm: string): boolean {
  return ALGORITHMS.has(algorithm);
}

/**
 * The shape rules both readings share, in the order a reader fixes them; undefined once the value is two or more
 * fields on one line, so that only the algorithm or the blob can still be refused. Only those two fields are
 * tested for odd whitespace (a non-breaking space, for one), since a comment may hold it.
 */
function formRejection(
  raw: string,
  [algorithm = "", blob = ""]: readonly string[],
): string | undefined {
  if (LINE_BREAK.test(raw)) {
    return HAS_LINE_BREAK;
  }
  if (ODD_WHITESPACE.test(algorithm) || ODD_WHITESPACE.test(blob)) {
    return HAS_ODD_WHITESPACE;
  }
  return blob === "" ? FEWER_THAN_TWO_FIELDS : undefined;
}

/** Why the settings file cannot declare a key under `algorithm`, or undefined when it can. */
function declaredAlgorithmRejection(algorithm: string): string | undefined {
  if (algorithm === "ssh-dss") {
    return "the key is DSA, which GitHub no longer accepts (since 2022-03-15)";
  }
  return ALGORITHMS.has(algorithm)
    ? undefined
    : "the key's first field is not an algorithm GitHub accepts";
}

/**
 * The reading both sides share: the form, the algorithm under the side's rule, then the blob under zod's base64
 * check, which takes the empty string too; the form check ahead of it is what makes an empty blob a missing field.
 * A reason never quotes the input: it may be a pasted PRIVATE key, and a refusal that echoed it would put it in
 * the log and the step summary.
 */
function parseMaterial(
  raw: string,
  algorithmRejection: (algorithm: string) => string | undefined,
): Result<PublicKeyMaterial, string> {
  const fields = fieldsOf(raw);
  const [algorithm = "", blob = ""] = fields;

  const form = formRejection(raw, fields);
  if (form !== undefined) {
    return err(form);
  }

  const refusedAlgorithm = algorithmRejection(algorithm);
  if (refusedAlgorithm !== undefined) {
    return err(refusedAlgorithm);
  }

  if (!base64Blob.safeParse(blob).success) {
    return err(BLOB_NOT_BASE64);
  }

  return ok({ algorithm, material: `${algorithm} ${blob}` });
}

/**
 * The one reading of DECLARED deploy key material, shared by the schema and the planner so the two cannot disagree.
 * A second line is refused rather than dropped, so nothing pasted after a valid key is silently normalized away.
 */
export function parsePublicKey(raw: string): Result<PublicKeyMaterial, string> {
  if (raw.trimStart().startsWith("-----BEGIN")) {
    return err(
      raw.includes(PRIVATE_KEY_FRAMING)
        ? "this is a private key; a deploy key takes the public half (the .pub file)"
        : 'this is a PEM block; a deploy key takes the OpenSSH one-line public form, "ssh-ed25519 AAAA... comment" (the .pub file; ssh-keygen -i converts a PEM public key)',
    );
  }
  if (LINE_BREAK.test(raw)) {
    return err(
      `${HAS_LINE_BREAK} (a YAML | block keeps its trailing newline; |- drops it); a public SSH key reads ${PUBLIC_KEY_FORM}`,
    );
  }
  return parseMaterial(raw, declaredAlgorithmRejection).mapErr(
    (reason) => `${reason}; a public SSH key reads ${PUBLIC_KEY_FORM}`,
  );
}

/** The reading of material GitHub returned: the same comparable form, with GitHub the authority on the algorithm. */
export function parseStoredKey(raw: string): Result<PublicKeyMaterial, string> {
  return parseMaterial(raw, () => undefined);
}

/** The check is entry-level so the refusal can name the entry by title; a field-level one would know only the index. */
export const DeployKeyConfig = open({
  title: z.string(),
  key: z.string().meta({ pattern: PUBLIC_KEY_PATTERN.source }),
  read_only: z.boolean().optional(),
})
  .check(
    rule((entry, refineCtx) => {
      // The key or the title may be raw beside its own shape issue (see ../shared/raw-values.ts): a non-string key is
      // no material to read, and a bare rendering of the title can throw on a mapping.
      const key: unknown = entry.key;
      if (typeof key !== "string") {
        return;
      }
      const parsed = parsePublicKey(key);
      if (parsed.isErr()) {
        const who = typeof entry.title === "string" ? `entry "${entry.title}"` : "this entry";
        refineCtx.addIssue({
          code: "custom",
          path: ["key"],
          message: `${who}: ${parsed.error}`,
        });
      }
    }),
  )
  .meta({ id: "DeployKeyConfig" });

export type DeployKeyConfig = z.infer<typeof DeployKeyConfig>;
