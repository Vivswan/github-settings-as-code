/**
 * The mock's secrets crypto over a FIXED test X25519 keypair: test-only material with no secret to
 * protect, pinned so scenarios and unit tests can seal against a known public key.
 *
 * The mock Handler contract is synchronous, so nothing here may await at request time: server.ts awaits
 * `mockSodiumReady()` once at construction, and every libsodium call after that is synchronous.
 */

import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";

export const MOCK_SECRETS_PUBLIC_KEY = "G68uvmju1lvQh0Pd06U8yh3vlO0JsWLMQR7v3mIpSWc=";

const MOCK_SECRETS_PRIVATE_KEY = "RoPFQaBuTO6VMxNqrLqb3QyW2FOWCmRBwDpyziVyXHs="; // gitleaks:allow

export const MOCK_SECRETS_KEY_ID = "568250167242549743";

export function mockSodiumReady(): Promise<void> {
  return sodium.ready;
}

/**
 * Null when the ciphertext does not open against the fixed keypair: a client-side sealing bug. One call
 * verifies the client's whole path: the public-key base64 decode, the sealed-box construction, and the
 * ciphertext's base64 round-trip.
 */
export function unsealSecretValue(encryptedValueB64: string): string | null {
  try {
    const sealed = sodium.from_base64(encryptedValueB64, sodium.base64_variants.ORIGINAL);
    const opened = sodium.crypto_box_seal_open(
      sealed,
      sodium.from_base64(MOCK_SECRETS_PUBLIC_KEY, sodium.base64_variants.ORIGINAL),
      sodium.from_base64(MOCK_SECRETS_PRIVATE_KEY, sodium.base64_variants.ORIGINAL),
    );
    return sodium.to_string(opened);
  } catch {
    return null;
  }
}

/**
 * Stored in place of the plaintext, NEVER the plaintext. A second apply re-seals the same value into a
 * DIFFERENT ciphertext (sealed boxes use a fresh ephemeral key), so state stability across applies can
 * only be judged on something derived from the plaintext.
 */
export function secretDigest(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
