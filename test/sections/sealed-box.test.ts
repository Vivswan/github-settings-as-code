import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import { err, ok, Result } from "neverthrow";
import {
  boxSharedKey,
  decodeBase64,
  openSealedBox,
  SEALED_BOX_PUBLIC_KEY_BYTES,
  sealBox,
  sealForGithub,
} from "../../src/sections/shared/sealed-box.js";

await sodium.ready;

const encode = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

// The empty message (a tag-only box), a message spanning several cipher blocks, and multi-byte UTF-8.
const MESSAGES: [string, string][] = [
  ["empty", ""],
  ["one KiB", "x".repeat(1024)],
  ["non-ASCII", 'p@ss"word\\with\nnewline\tand éñ中\u{1F600}'],
];

/** Tag (16) + ciphertext follow the ephemeral key; the length leaks nothing beyond the message's. */
const OVERHEAD = SEALED_BOX_PUBLIC_KEY_BYTES + 16;

describe("sealBox against libsodium", () => {
  const recipient = sodium.crypto_box_keypair();

  test.each(MESSAGES)("each side opens what the other sealed: %s", (_what, message) => {
    const sealed = sealBox(encode(message), recipient.publicKey);
    expect(sealed.length).toBe(OVERHEAD + encode(message).length);
    const opened = sodium.crypto_box_seal_open(sealed, recipient.publicKey, recipient.privateKey);
    expect(sodium.to_string(opened)).toBe(message);
    const sealedByLibsodium = sodium.crypto_box_seal(
      sodium.from_string(message),
      recipient.publicKey,
    );
    const openedByNoble = openSealedBox(
      sealedByLibsodium,
      recipient.privateKey,
      recipient.publicKey,
    );
    expect(new TextDecoder().decode(openedByNoble)).toBe(message);
  });

  test("sealForGithub emits canonical base64 of the sealed box that libsodium opens", () => {
    const sealed = sealForGithub(recipient.publicKey, "hunter2");
    const bytes = decodeBase64(sealed)._unsafeUnwrap();
    expect(bytes.length).toBe(OVERHEAD + 7);
    expect(sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)).toBe(sealed);
    const opened = sodium.crypto_box_seal_open(bytes, recipient.publicKey, recipient.privateKey);
    expect(sodium.to_string(opened)).toBe("hunter2");
  });

  test("two seals of one message differ (fresh ephemeral key) and a tampered box does not open", () => {
    const a = sealBox(encode("same"), recipient.publicKey);
    const b = sealBox(encode("same"), recipient.publicKey);
    expect(hex(a)).not.toBe(hex(b));
    const tampered = Uint8Array.from(a, (byte, i) => (i === a.length - 1 ? byte ^ 1 : byte));
    expect(() => openSealedBox(tampered, recipient.privateKey, recipient.publicKey)).toThrow();
    expect(() =>
      sodium.crypto_box_seal_open(tampered, recipient.publicKey, recipient.privateKey),
    ).toThrow();
  });

  test("a low-order recipient key (all zero) is refused, as libsodium refuses it", () => {
    const zero = new Uint8Array(SEALED_BOX_PUBLIC_KEY_BYTES);
    expect(() => sealBox(encode(""), zero)).toThrow();
    expect(() => sodium.crypto_box_seal(new Uint8Array(0), zero)).toThrow();
  });

  test("boxSharedKey derives libsodium's crypto_box_beforenm key from either side", () => {
    const sender = sodium.crypto_box_keypair();
    const expected = hex(sodium.crypto_box_beforenm(recipient.publicKey, sender.privateKey));
    expect(hex(boxSharedKey(sender.privateKey, recipient.publicKey))).toBe(expected);
    expect(hex(boxSharedKey(recipient.privateKey, sender.publicKey))).toBe(expected);
  });
});

describe("fixed vectors (no libsodium in the loop)", () => {
  // Recipient secret key 01..20, ephemeral secret key a0..bf; the expected bytes came from libsodium's crypto_scalarmult_base,
  // crypto_generichash(24), and crypto_box_easy run by hand.
  const recipientSecretKey = fromHex(
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  );
  const recipientPublicKey = fromHex(
    "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c",
  );
  const ephemeralSecretKey = fromHex(
    "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf",
  );
  const EPHEMERAL_PUBLIC_KEY = "605a725d2a4adfeeb1a29e17edd621c1b7593ee8cdbc44ac6c4ab6e2f805d23c";

  test.each([
    ["", `${EPHEMERAL_PUBLIC_KEY}d3710cec3c028bcdb9d363bde2440f59`],
    ["éñ中", `${EPHEMERAL_PUBLIC_KEY}e12ec41d09e0bd59918b97687c282a70d07bf78a52e32c`],
  ])(
    "sealing %j with the pinned ephemeral key reproduces the libsodium bytes",
    (message, expected) => {
      const sealed = sealBox(encode(message), recipientPublicKey, ephemeralSecretKey);
      expect(hex(sealed)).toBe(expected);
      const opened = openSealedBox(sealed, recipientSecretKey, recipientPublicKey);
      expect(new TextDecoder().decode(opened)).toBe(message);
    },
  );
});

describe("decodeBase64", () => {
  const NOT_CANONICAL = err("not canonical base64");
  // What libsodium decodes (or refuses) is the control: Buffer would silently accept every rejected row.
  test.each<[what: string, text: string, expected: ReturnType<typeof decodeBase64>]>([
    ["missing padding", "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw", NOT_CANONICAL],
    ["an invalid character", "not base64!", NOT_CANONICAL],
    ["a url-safe alphabet", "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw=", NOT_CANONICAL],
    ["nonzero padding bits", "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHx=", NOT_CANONICAL],
    ["a stray quantum", "AAAAA", NOT_CANONICAL],
    ["whitespace", "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=\n", NOT_CANONICAL],
    [
      "canonical padded base64",
      "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=",
      ok(fromHex("07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c")),
    ],
    ["the empty string", "", ok(new Uint8Array(0))],
  ])("%s decodes as libsodium does", (_what, text, expected) => {
    const libsodium = Result.fromThrowable(() =>
      sodium.from_base64(text, sodium.base64_variants.ORIGINAL),
    )();
    expect(libsodium.isOk()).toBe(expected.isOk());
    if (libsodium.isOk()) {
      expect(hex(libsodium.value)).toBe(hex(expected._unsafeUnwrap()));
    }
    expect(decodeBase64(text)).toEqual(expected);
  });
});
