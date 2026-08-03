/**
 * The mock's secrets crypto: a FIXED test X25519 keypair (so scenarios and
 * unit tests can seal against a known public key), the synchronous unseal the
 * PUT handlers verify each upload with, and the deterministic digest the mock
 * stores in place of a plaintext. The keypair is test-only material with no
 * secret to protect - its whole point is being pinned.
 *
 * The mock Handler contract is synchronous, so nothing here may await at
 * request time: the transport shell (server.ts) awaits `mockSodiumReady()`
 * once at construction, and every libsodium call after that is synchronous.
 */

import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers";

/** The base64 public key the mock's public-key routes serve. */
export const MOCK_SECRETS_PUBLIC_KEY = "G68uvmju1lvQh0Pd06U8yh3vlO0JsWLMQR7v3mIpSWc=";

/** The matching private half, used ONLY to unseal-verify uploads. */
const MOCK_SECRETS_PRIVATE_KEY = "RoPFQaBuTO6VMxNqrLqb3QyW2FOWCmRBwDpyziVyXHs="; // gitleaks:allow

/** The key_id paired with the public key, GitHub-shaped (a numeric string). */
export const MOCK_SECRETS_KEY_ID = "568250167242549743";

/** Await libsodium's WASM init; the server calls this once at construction. */
export function mockSodiumReady(): Promise<void> {
  return sodium.ready;
}

/**
 * Unseal one uploaded encrypted_value with the fixed keypair, verifying the
 * client's whole sealing path at once: the public-key base64 decode, the
 * sealed-box construction, and the ciphertext's base64 round-trip. Returns
 * the plaintext, or null when the ciphertext does not open against the fixed
 * keypair (a client-side sealing bug). Synchronous by design - see the module
 * doc; callers must be behind mockSodiumReady().
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
 * The deterministic digest the mock stores for an unsealed value - NEVER the
 * plaintext. Determinism is load-bearing: a second apply re-seals the same
 * source value into a DIFFERENT ciphertext (sealed boxes use a fresh
 * ephemeral key), so state stability across applies can only be judged on
 * something derived from the plaintext.
 */
export function secretDigest(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}
