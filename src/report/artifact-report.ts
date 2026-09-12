/**
 * The `artifact` private-report channel: the concatenated report document,
 * age-encrypted to an operator-held recipient and uploaded as a workflow
 * artifact on the (public) run. Access control is key possession - for
 * readers who hold the private key but have no GitHub access to the
 * targets. Crypto comes from the `age-encryption` package (typage, by
 * age's author); nothing here rolls its own primitives. The upload is a
 * port the caller supplies (the action's is src/action/artifact.ts), so
 * composition and encryption never touch the artifact service here.
 */

import { Encrypter } from "age-encryption";
import { err, ok, type Result } from "neverthrow";
import type { ProblemOf } from "../problem.js";

export const ARTIFACT_NAME = "settings-as-code-private-report";
export const ARTIFACT_FILE = "private-report.md.age";

/**
 * Validate an age recipient string without encrypting anything, for reuse
 * at config parse: a malformed `report-public-key` must be rejected before
 * any API work. Accepts exactly what the age library accepts (`age1...`).
 */
export function parseRecipient(
  recipient: string,
): Result<void, ProblemOf<"age-recipient-invalid">> {
  try {
    new Encrypter().addRecipient(recipient);
    return ok();
  } catch (error) {
    return err({
      code: "age-recipient-invalid",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Encrypt the report document to the operator's age recipient. Decrypt
 * locally with `age -d -i key.txt private-report.md.age`.
 */
export async function encryptReport(recipient: string, content: string): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(content);
}

/** The upload port: the action implements it over @actions/artifact, tests capture. */
export interface ArtifactUploader {
  upload(name: string, file: { name: string; data: Uint8Array }): Promise<void>;
}

export type ArtifactDelivery = { uploaded: true } | { warning: string };

/**
 * Encrypt the document and upload it as the report artifact. Never throws:
 * report delivery is auxiliary, so a missing runtime token, an artifact
 * service failure, or a bad recipient comes back as a warning and the
 * run's result stays untouched. The thrown messages describe the artifact
 * service or the recipient - never the report content, which only ever
 * leaves this module as ciphertext.
 */
export async function deliverArtifactReport(
  uploader: ArtifactUploader,
  document: string,
  recipient: string,
): Promise<ArtifactDelivery> {
  try {
    const ciphertext = await encryptReport(recipient, document);
    await uploader.upload(ARTIFACT_NAME, { name: ARTIFACT_FILE, data: ciphertext });
    return { uploaded: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      warning: `could not upload the private report artifact: ${reason}. Re-run the workflow, or set private-report: none if it persists`,
    };
  }
}
