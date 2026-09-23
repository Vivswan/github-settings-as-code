/**
 * The deploy_keys section's parse refusals, each pinned as the problem line a user reads: the forms of key
 * material GitHub's create would reject (a private key, a PEM block, a broken one-liner, a retired algorithm), and
 * two entries declaring one key, which GitHub attaches to a repository once. The refusal never echoes the material:
 * it may be a pasted private key.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(entries: unknown[]): readonly string[] | null {
  return validateSectionShapes({ deploy_keys: entries }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

const BOT_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBotBotBotBotBotBotBotBotBotBotBotBotBotBotB";

/** Assembled at runtime so no source line holds the header a secret scanner flags. */
const PRIVATE_KEY_HEADER = ["-----BEGIN", "OPENSSH PRIVATE", "KEY-----"].join(" ");

describe("deploy key material GitHub's create would reject is refused at parse, naming the entry and the form to write", () => {
  test.each<[what: string, key: string, expected: string]>([
    [
      "a private key",
      `${PRIVATE_KEY_HEADER}\nb3BlbnNzaC1rZXktdjEAAAAA\n`,
      'deploy_keys[0].key: entry "ci": this is a private key; a deploy key takes the public half (the .pub file)',
    ],
    [
      "a PEM public key",
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAU3ludGhldGljRml4dHVyZUJvZHlQdWJsaWM=\n-----END PUBLIC KEY-----",
      'deploy_keys[0].key: entry "ci": this is a PEM block; a deploy key takes the OpenSSH one-line public form, "ssh-ed25519 AAAA... comment" (the .pub file; ssh-keygen -i converts a PEM public key)',
    ],
    [
      "a YAML block scalar's trailing newline",
      `${BOT_KEY}\n`,
      'deploy_keys[0].key: entry "ci": the key contains a line break (a YAML | block keeps its ' +
        'trailing newline; |- drops it); a public SSH key reads one line, "<algorithm> <base64> ' +
        '[comment]", with the algorithm one of ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ' +
        "ecdsa-sha2-nistp384, ecdsa-sha2-nistp521, sk-ssh-ed25519@openssh.com, " +
        "sk-ecdsa-sha2-nistp256@openssh.com",
    ],
    [
      "a non-breaking space between the fields",
      BOT_KEY.replace(" ", "\u00a0"),
      'deploy_keys[0].key: entry "ci": the key contains whitespace other than a space or tab (a ' +
        'non-breaking space, for one); a public SSH key reads one line, "<algorithm> <base64> ' +
        '[comment]", with the algorithm one of ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ' +
        "ecdsa-sha2-nistp384, ecdsa-sha2-nistp521, sk-ssh-ed25519@openssh.com, " +
        "sk-ecdsa-sha2-nistp256@openssh.com",
    ],
    [
      "the algorithm alone",
      "ssh-ed25519",
      'deploy_keys[0].key: entry "ci": the key has fewer than two fields separated by a space or ' +
        'tab; a public SSH key reads one line, "<algorithm> <base64> [comment]", with the algorithm ' +
        "one of ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, " +
        "ecdsa-sha2-nistp521, sk-ssh-ed25519@openssh.com, sk-ecdsa-sha2-nistp256@openssh.com",
    ],
    [
      "a DSA key, which GitHub retired",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP1/U4E=",
      'deploy_keys[0].key: entry "ci": the key is DSA, which GitHub no longer accepts (since ' +
        '2022-03-15); a public SSH key reads one line, "<algorithm> <base64> [comment]", with the ' +
        "algorithm one of ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, " +
        "ecdsa-sha2-nistp521, sk-ssh-ed25519@openssh.com, sk-ecdsa-sha2-nistp256@openssh.com",
    ],
    [
      "an algorithm GitHub does not take",
      "ssh-ed448 AAAAC3NzaC1lZDI1NTE5AAAAIBotBotBotBotBotBotBotBotBotBotBotBotBotBotB",
      'deploy_keys[0].key: entry "ci": the key\'s first field is not an algorithm GitHub accepts; ' +
        'a public SSH key reads one line, "<algorithm> <base64> [comment]", with the algorithm one ' +
        "of ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, ecdsa-sha2-nistp521, " +
        "sk-ssh-ed25519@openssh.com, sk-ecdsa-sha2-nistp256@openssh.com",
    ],
    [
      "a second field that is not base64",
      "ssh-ed25519 not*base64",
      'deploy_keys[0].key: entry "ci": the key\'s second field is not base64 (the alphabet A-Z a-z ' +
        "0-9 + / with = padding to a multiple of four); a public SSH key reads one line, " +
        '"<algorithm> <base64> [comment]", with the algorithm one of ssh-ed25519, ssh-rsa, ' +
        "ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, ecdsa-sha2-nistp521, sk-ssh-ed25519@openssh.com, " +
        "sk-ecdsa-sha2-nistp256@openssh.com",
    ],
  ])("%s", (_what, key, expected) => {
    expect(issues([{ title: "ci", key }])).toEqual([expected]);
  });

  test("an entry without a string title is named as this entry, beside the title's own type issue", () => {
    expect(issues([{ title: 7, key: "ssh-ed25519" }])).toEqual([
      expect.stringContaining("deploy_keys[0].title: "),
      "deploy_keys[0].key: this entry: the key has fewer than two fields separated by a space or " +
        'tab; a public SSH key reads one line, "<algorithm> <base64> [comment]", with the algorithm ' +
        "one of ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, " +
        "ecdsa-sha2-nistp521, sk-ssh-ed25519@openssh.com, sk-ecdsa-sha2-nistp256@openssh.com",
    ]);
  });

  test("two entries declaring one key are refused at the second, since GitHub attaches a key to a repository once", () => {
    expect(
      issues([
        { title: "ci", key: BOT_KEY },
        { title: "deploy", key: `${BOT_KEY} a comment GitHub may drop` },
      ]),
    ).toEqual([
      'deploy_keys[1].key: the entries "ci" and "deploy" declare the same key material, and GitHub attaches a public key to one repository once, so the second create would be rejected - keep one entry per key',
    ]);
  });

  test("a one-line public key with a comment parses", () => {
    expect(issues([{ title: "ci", key: `${BOT_KEY} ci@example`, read_only: true }])).toBeNull();
  });
});
