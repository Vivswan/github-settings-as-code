/**
 * libsodium's crypto_box_seal on the noble primitives: no WASM, no async init.
 * Wire format: ephemeral X25519 public key (32) || Poly1305 tag (16) || XSalsa20 ciphertext.
 * test/sections/sealed-box.test.ts holds the libsodium cross-check and the fixed vectors.
 */

import { hsalsa, xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

/** An X25519 public key's length; parseSealingKey names it in a wrong-length rejection. */
export const SEALED_BOX_PUBLIC_KEY_BYTES = 32;

const EPHEMERAL_KEY_BYTES = SEALED_BOX_PUBLIC_KEY_BYTES;

/** XSalsa20's extended nonce, which crypto_box_seal derives instead of transmitting. */
const NONCE_BYTES = 24;

/** hsalsa20's "expand 32-byte k" constant as the word view hsalsa reads. */
const HSALSA_SIGMA = new Uint32Array(new TextEncoder().encode("expand 32-byte k").buffer);

/** crypto_box_beforenm runs hsalsa20 with an all-zero 16-byte input. */
const ZERO_INPUT = new Uint32Array(4);

/**
 * Decode canonical padded base64 (RFC 4648 section 4) or throw, as libsodium's
 * from_base64 did. Buffer's decoder skips bad characters and tolerates missing
 * padding and nonzero padding bits, so only a re-encode round trip is exact.
 */
export function decodeBase64(text: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(text, "base64"));
  if (Buffer.from(bytes).toString("base64") !== text) {
    throw new Error("not canonical base64");
  }
  return bytes;
}

/**
 * libsodium's crypto_box_beforenm: the X25519 shared point through hsalsa20.
 * getSharedSecret throws on a low-order public key (an all-zero shared point),
 * like crypto_scalarmult's -1 that makes libsodium refuse the seal.
 */
function boxSharedKey(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  const key = new Uint32Array(8);
  hsalsa(HSALSA_SIGMA, new Uint32Array(shared.slice().buffer), ZERO_INPUT, key);
  return new Uint8Array(key.buffer);
}

/** crypto_box_seal's nonce: blake2b-192 over the ephemeral then the recipient public key. */
function sealNonce(ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  return blake2b
    .create({ dkLen: NONCE_BYTES })
    .update(ephemeralPublicKey)
    .update(recipientPublicKey)
    .digest();
}

/**
 * Seal `message` so only the holder of `recipientPublicKey`'s secret half can
 * open it. The ephemeral secret key is a parameter only so the tests can pin
 * fixed vectors; production callers let it default to fresh randomness.
 */
export function sealBox(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array = x25519.utils.randomSecretKey(),
): Uint8Array {
  const ephemeralPublicKey = x25519.getPublicKey(ephemeralSecretKey);
  const key = boxSharedKey(ephemeralSecretKey, recipientPublicKey);
  const nonce = sealNonce(ephemeralPublicKey, recipientPublicKey);
  const boxed = xsalsa20poly1305(key, nonce).encrypt(message);
  const sealed = new Uint8Array(EPHEMERAL_KEY_BYTES + boxed.length);
  sealed.set(ephemeralPublicKey, 0);
  sealed.set(boxed, EPHEMERAL_KEY_BYTES);
  return sealed;
}

/**
 * Open a sealed box with the recipient keypair, or throw on a forged or
 * mismatched one. The inverse of sealBox, so a libsodium-sealed box opening
 * here proves the key and nonce derivations match libsodium's.
 */
export function openSealedBox(
  sealed: Uint8Array,
  recipientSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const ephemeralPublicKey = sealed.subarray(0, EPHEMERAL_KEY_BYTES);
  const key = boxSharedKey(recipientSecretKey, ephemeralPublicKey);
  const nonce = sealNonce(ephemeralPublicKey, recipientPublicKey);
  return xsalsa20poly1305(key, nonce).decrypt(sealed.subarray(EPHEMERAL_KEY_BYTES));
}

/** Seal a secret's UTF-8 value against the decoded sealing key into the base64 encrypted_value. */
export function sealForGithub(recipientPublicKey: Uint8Array, value: string): string {
  const sealed = sealBox(new TextEncoder().encode(value), recipientPublicKey);
  return Buffer.from(sealed).toString("base64");
}
