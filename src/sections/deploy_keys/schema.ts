/** The `deploy_keys:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";

/**
 * The key types GitHub accepts for a deploy key; the docs field note lists them for the reader. DSA (ssh-dss) is
 * absent on purpose: GitHub stopped accepting DSA keys on 2022-03-15, so a DSA key passing here would only fail at the
 * create request.
 */
export const PUBLIC_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;

const BASE64_QUARTET = "[A-Za-z0-9+/]{4}";
const BASE64_BLOB = `(?:${BASE64_QUARTET})*(?:${BASE64_QUARTET}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)`;

/** The one field separator; the rejection helpers split on it so they see the fields the pattern saw. */
const FIELD_SEPARATOR = String.raw`[ \t]`;

/** A second line is refused rather than dropped, so nothing pasted after a valid key is silently normalized away. */
function materialPattern(algorithms: string): RegExp {
  return new RegExp(
    `^${FIELD_SEPARATOR}*(${algorithms})${FIELD_SEPARATOR}+(${BASE64_BLOB})(?:${FIELD_SEPARATOR}[^\\r\\n]*)?$`,
  );
}

const FIELDS = new RegExp(`${FIELD_SEPARATOR}+`);
const LINE_BREAK = /[\r\n]/;
/** Whitespace the pattern never accepts as a separator, a non-breaking space for one; a comment may hold it. */
const ODD_WHITESPACE = /[^\S \t\r\n]/;

function fieldsOf(raw: string): string[] {
  return raw.split(FIELDS).filter((field) => field !== "");
}

/**
 * The ONE acceptance rule for DECLARED deploy key material: the runtime parses through it and the published JSON
 * schema carries its source as the field's `pattern`, so an editor and the run agree.
 */
const PUBLIC_KEY_PATTERN = materialPattern(
  PUBLIC_KEY_ALGORITHMS.map((algorithm) => algorithm.replaceAll(".", "\\.")).join("|"),
);

/**
 * The rule for material GitHub STORED: any algorithm token. GitHub validated the key when it accepted it and is
 * the authority on what it takes, so a live key under an algorithm this list lacks must not abort the section.
 */
const STORED_KEY_PATTERN = materialPattern(String.raw`\S+`);

const ALGORITHMS = new Set<string>(PUBLIC_KEY_ALGORITHMS);

/** Whether the settings file can declare a key under this algorithm; a live key under any other is outside the section. */
export function declaresAlgorithm(algorithm: string): boolean {
  return ALGORITHMS.has(algorithm);
}
const PUBLIC_KEY_FORM = `one line, "<algorithm> <base64> [comment]", with the algorithm one of ${PUBLIC_KEY_ALGORITHMS.join(", ")}`;
const FEWER_THAN_TWO_FIELDS = "the key has fewer than two fields separated by a space or tab";
const HAS_LINE_BREAK = "the key contains a line break";
const HAS_ODD_WHITESPACE =
  "the key contains whitespace other than a space or tab (a non-breaking space, for one)";
const BLOB_NOT_BASE64 =
  "the key's second field is not base64 (the alphabet A-Z a-z 0-9 + / with = padding to a multiple of four)";

/**
 * The framing every PEM and OpenSSH private key carries in its header and footer, assembled at runtime so no
 * source line holds the string a secret scanner flags as a private key.
 */
const PRIVATE_KEY_FRAMING = ["PRIVATE", "KEY-----"].join(" ");

export type PublicKeyParse =
  /** `material` is the comparable form, algorithm + blob: GitHub may strip or rewrite the comment on storage. */
  | { readonly ok: true; readonly algorithm: string; readonly material: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Names what PUBLIC_KEY_PATTERN refused. The reason never quotes the input: it may be a pasted PRIVATE key, and a
 * refusal that echoed it would put it in the log and the step summary.
 */
function declaredRejection(raw: string): string {
  if (raw.trimStart().startsWith("-----BEGIN")) {
    return raw.includes(PRIVATE_KEY_FRAMING)
      ? "this is a private key; a deploy key takes the public half (the .pub file)"
      : 'this is a PEM block; a deploy key takes the OpenSSH one-line public form, "ssh-ed25519 AAAA... comment" (the .pub file; ssh-keygen -i converts a PEM public key)';
  }
  if (LINE_BREAK.test(raw)) {
    return `${HAS_LINE_BREAK} (a YAML | block keeps its trailing newline; |- drops it); a public SSH key reads ${PUBLIC_KEY_FORM}`;
  }
  const fields = fieldsOf(raw);
  const form = formRejection(raw, fields);
  if (form !== undefined) {
    return `${form}; a public SSH key reads ${PUBLIC_KEY_FORM}`;
  }
  const [algorithm = ""] = fields;
  if (algorithm === "ssh-dss") {
    return `the key is DSA, which GitHub no longer accepts (since 2022-03-15); a public SSH key reads ${PUBLIC_KEY_FORM}`;
  }
  if (!ALGORITHMS.has(algorithm)) {
    return `the key's first field is not an algorithm GitHub accepts; a public SSH key reads ${PUBLIC_KEY_FORM}`;
  }
  // A known algorithm with two fields on one line fails the pattern on its blob alone.
  return `${BLOB_NOT_BASE64}; a public SSH key reads ${PUBLIC_KEY_FORM}`;
}

/**
 * The shape rules both readings share, in the order a reader fixes them; undefined once the value is two or more
 * fields on one line, so that only the algorithm or the blob can have failed the pattern.
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

/** Names what STORED_KEY_PATTERN refused; the algorithm is never the reason on the live side. */
function storedRejection(raw: string): string {
  return formRejection(raw, fieldsOf(raw)) ?? BLOB_NOT_BASE64;
}

function parseMaterial(
  pattern: RegExp,
  raw: string,
  rejection: (raw: string) => string,
): PublicKeyParse {
  const match = pattern.exec(raw);
  return match === null
    ? { ok: false, reason: rejection(raw) }
    : { ok: true, algorithm: match[1] ?? "", material: `${match[1]} ${match[2]}` };
}

/** The one reading of DECLARED deploy key material, shared by the schema and the planner so the two cannot disagree. */
export function parsePublicKey(raw: string): PublicKeyParse {
  return parseMaterial(PUBLIC_KEY_PATTERN, raw, declaredRejection);
}

/** The reading of material GitHub returned: the same comparable form, with GitHub the authority on the algorithm. */
export function parseStoredKey(raw: string): PublicKeyParse {
  return parseMaterial(STORED_KEY_PATTERN, raw, storedRejection);
}

export const DeployKeyConfig = z
  .object({
    title: z.string(),
    key: z.string().meta({ pattern: PUBLIC_KEY_PATTERN.source }),
    read_only: z.boolean().optional(),
  })
  // Entry-level so the refusal can name the entry by title; the field-level form would know only the index.
  .superRefine((entry, refineCtx) => {
    const parsed = parsePublicKey(entry.key);
    if (!parsed.ok) {
      refineCtx.addIssue({
        code: "custom",
        path: ["key"],
        message: `entry "${entry.title}": ${parsed.reason}`,
      });
    }
  })
  .meta({ id: "DeployKeyConfig" });
export type DeployKeyConfig = z.infer<typeof DeployKeyConfig>;
