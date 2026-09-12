/**
 * The `artifact` private-report channel: the concatenated report document, age-encrypted to an operator-held
 * recipient and uploaded on the (public) run, so access control is key possession.
 *
 * crypto      -> the `age-encryption` package (typage, by age's author); nothing here rolls its own
 * the upload  -> a port the caller supplies (src/action/artifact.ts), so this module never touches the artifact service
 */

import { Encrypter } from "age-encryption";
import { err, ok, type Result } from "neverthrow";
import type { ProblemOf } from "../problem.js";

export const ARTIFACT_NAME = "settings-as-code-private-report";
export const ARTIFACT_FILE = "private-report.md.age";

/** For config parse: a malformed `report-public-key` is rejected before any API work. Accepts exactly what the age library accepts. */
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

/** Decrypt locally with `age -d -i key.txt private-report.md.age`. */
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
 * Never throws: report delivery is auxiliary, so every failure is a warning and the run's result stays untouched. The
 * messages describe the artifact service or the recipient, never the report content, which leaves this module only as ciphertext.
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
