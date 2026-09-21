import { describe, expect, test } from "bun:test";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { err, ok } from "neverthrow";
import {
  ARTIFACT_FILE,
  ARTIFACT_NAME,
  type ArtifactUploader,
  deliverArtifactReport,
  encryptReport,
  parseRecipient,
} from "../../src/report/artifact-report.js";

async function testKeypair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

function captureUploader(): {
  uploader: ArtifactUploader;
  uploads: Array<{ name: string; file: { name: string; data: Uint8Array } }>;
} {
  const uploads: Array<{ name: string; file: { name: string; data: Uint8Array } }> = [];
  return {
    uploader: {
      async upload(name, file) {
        uploads.push({ name, file });
        return { uploaded: true as const };
      },
    },
    uploads,
  };
}

describe("encryptReport", () => {
  test("round-trips through the age library's own decrypter", async () => {
    const { identity, recipient } = await testKeypair();
    const ciphertext = await encryptReport(recipient, "the private report body");
    // Buffer.includes is a subsequence search; Uint8Array toContain compares elements and would pass with the plaintext bytes present.
    expect(Buffer.from(ciphertext).includes(Buffer.from("private"))).toBe(false);
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(await decrypter.decrypt(ciphertext, "text")).toBe("the private report body");
  });
});

describe("parseRecipient", () => {
  const REJECTED = err({ code: "age-recipient-invalid", reason: expect.any(String) });
  test.each<[name: string, recipient: string | (() => Promise<string>), verdict: unknown]>([
    ["a generated age recipient", async () => (await testKeypair()).recipient, ok()],
    ["an empty string", "", REJECTED],
    ["a truncated recipient", "age1shortandinvalid", REJECTED], // gitleaks:allow
    ["a secret key", "AGE-SECRET-KEY-1NOTPUBLIC", REJECTED],
  ])("%s: accepted, or rejected with the library's reason", async (_name, recipient, verdict) => {
    const input = typeof recipient === "string" ? recipient : await recipient();
    expect<unknown>(parseRecipient(input)).toEqual(verdict);
  });
});

describe("deliverArtifactReport", () => {
  test("hands the uploader port ciphertext under the fixed artifact names", async () => {
    const { identity, recipient } = await testKeypair();
    const { uploader, uploads } = captureUploader();
    const result = await deliverArtifactReport(uploader, "secret document", recipient);
    expect(result).toEqual({ uploaded: true });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.name).toBe(ARTIFACT_NAME);
    expect(uploads[0]?.file.name).toBe(ARTIFACT_FILE);
    // The port only ever sees ciphertext, and it decrypts back to the document.
    const data = uploads[0]?.file.data as Uint8Array;
    expect(new TextDecoder().decode(data)).not.toContain("secret document");
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    expect(await decrypter.decrypt(data, "text")).toBe("secret document");
  });

  test.each<[string, ArtifactUploader]>([
    [
      "answers failed",
      {
        async upload() {
          return { failed: "Unable to get the ACTIONS_RUNTIME_TOKEN env variable" };
        },
      },
    ],
    [
      "throws instead of answering",
      {
        async upload() {
          throw new Error("Unable to get the ACTIONS_RUNTIME_TOKEN env variable");
        },
      },
    ],
  ])(
    "an uploader that %s is one warning carrying its reason, never a throw",
    async (_how, uploader) => {
      const { recipient } = await testKeypair();
      expect(await deliverArtifactReport(uploader, "doc", recipient)).toEqual({
        warning:
          "could not upload the private report artifact: Unable to get the ACTIONS_RUNTIME_TOKEN " +
          "env variable. Re-run, or set private-report: none if it persists",
      });
    },
  );

  test("a malformed recipient is a warning and the uploader is never called", async () => {
    const { uploader, uploads } = captureUploader();
    const result = await deliverArtifactReport(uploader, "doc", "not-a-key");
    // The middle of the warning is the age library's own wording, so only our prefix and advice are pinned.
    expect(result).toEqual({
      warning: expect.stringMatching(
        /^could not upload the private report artifact: .+\. Re-run, or set private-report: none if it persists$/,
      ),
    });
    expect(uploads).toEqual([]);
  });
});
