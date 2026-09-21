import { describe, expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import type { SectionInput } from "../contract/module.js";
import { deployKeysSection } from "./index.js";
import { deployKeysMockHandlers } from "./mock.js";
import {
  DeployKeyConfig,
  PUBLIC_KEY_ALGORITHMS,
  parsePublicKey,
  parseStoredKey,
} from "./schema.js";

const LIST = "GET /repos/o/r/keys?per_page=100&page=1";

/** A live GET-shape key body; stored material carries no comment, like GitHub. */
function liveKey(id: number, title: string, key: string, read_only = false) {
  return { id, title, key, read_only, verified: true, created_at: "2026-01-01T00:00:00Z" };
}

const BOT_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBotBotBotBotBotBotBotBotBotBotBotBotBotBotB";
const MIRROR_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMirrorMirrorMirrorMirrorMirrorMirrorMirrorM";
const STALE_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStaleStaleStaleStaleStaleStaleStaleStaleSta";
const RETIRED_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCRetiredRetiredRetiredRetiredRetiredRetir=";
// The REAL OpenSSH private-key framing, assembled at runtime so no source line carries the string a secret scanner flags.
const PRIVATE_KEY_HEADER = ["-----BEGIN", "OPENSSH PRIVATE", "KEY-----"].join(" ");
const PRIVATE_KEY_FOOTER = ["-----END", "OPENSSH PRIVATE", "KEY-----"].join(" ");
const PRIVATE_KEY = `${PRIVATE_KEY_HEADER}\nU3ludGhldGljRml4dHVyZUJvZHk=\n${PRIVATE_KEY_FOOTER}`;
// A PEM-framed PUBLIC key (ssh-keygen -e -m PKCS8): not a private key, and not the form GitHub takes either.
const PEM_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAU3ludGhldGljRml4dHVyZUJvZHlQdWJsaWM=\n-----END PUBLIC KEY-----";
// A key under an algorithm this list lacks, in the two-field shape GitHub stores.
const ED448_KEY =
  "ssh-ed448 AAAACXNzaC1lZDQ0OAAAADlFZDQ0OEZ1dHVyZUFsZ29yaXRobUZ1dHVyZUFsZ29yaXRobUZ1dHVyZUE=";
const plan = async (api: MockApi, desired: SectionInput<"deploy_keys">) =>
  unwrap(
    await deployKeysSection.plan(
      planContext(deployKeysSection, api, REPO),
      validatedInput("deploy_keys", desired),
    ),
  );

describe("parsePublicKey", () => {
  test("the comparable material is algorithm + blob: GitHub strips the comment on storage, so a raw compare would recreate on every apply", () => {
    const bot = { ok: true, algorithm: "ssh-ed25519", material: BOT_KEY } as const;
    expect(parsePublicKey(`${BOT_KEY} deploy@host`)).toEqual(bot);
    expect(parsePublicKey(`  ${RETIRED_KEY} a b c  `)).toEqual({
      ok: true,
      algorithm: "ssh-rsa",
      material: RETIRED_KEY,
    });
    expect(parsePublicKey(BOT_KEY)).toEqual(bot);
  });

  test.each<[label: string, raw: string]>([
    [
      "a hardware-backed key",
      "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIHw= host",
    ],
    ["an ecdsa key with = padding", "ecdsa-sha2-nistp521 AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE="],
    [
      "tab-separated fields, which authorized_keys tooling emits",
      `ssh-ed25519\tAAAAC3NzaC1lZDI1NTE5AAAAIBotBotBotBotBotBotBotBotBotBotBotBotBotBotB\tdeploy@host`,
    ],
  ])("%s is a public key GitHub accepts, so the parse keeps it", (_label, raw) => {
    expect(parsePublicKey(raw).ok).toBe(true);
  });

  // Every refusal is checked for the ABSENCE of the input: a pasted private key must not surface in a log.
  test.each<[label: string, raw: string, reason: RegExp]>([
    [
      "an OpenSSH private key with the header on its own line",
      PRIVATE_KEY,
      /^this is a private key; a deploy key takes the public half \(the \.pub file\)$/,
    ],
    [
      "a PEM private key folded onto one line, as a YAML >- scalar reads it",
      ["-----BEGIN RSA PRIVATE", "KEY----- MIIEowIBAAKCAQEA -----END RSA PRIVATE", "KEY-----"].join(
        " ",
      ),
      /^this is a private key/,
    ],
    [
      "a PEM-framed PUBLIC key, which is not a private key and not the one-line form either",
      PEM_PUBLIC_KEY,
      /^this is a PEM block; a deploy key takes the OpenSSH one-line public form, "ssh-ed25519 AAAA\.\.\. comment"/,
    ],
    ["a bare PEM opener", "-----BEGIN", /^this is a PEM block/],
    ["one field", "ssh-ed25519", /^the key has fewer than two fields separated by a space or tab/],
    ["nothing", "   ", /^the key has fewer than two fields separated by a space or tab/],
    [
      "a valid key with a second line after it, which line-break separators would keep and silently drop",
      "ssh-ed25519 QUFBQQ==\n-----BEGIN PUBLIC KEY-----",
      /^the key contains a line break \(a YAML \| block keeps its trailing newline; \|- drops it\); a public SSH key reads one line/,
    ],
    [
      "a trailing newline, as a YAML | block scalar reads it",
      `${BOT_KEY}\n`,
      /^the key contains a line break/,
    ],
    [
      "a line break between the two fields",
      "ssh-ed25519\nQUFBQQ==",
      /^the key contains a line break/,
    ],
    [
      "a non-breaking space between the two fields, which reads as a space and is not one",
      "ssh-ed25519\u00a0QUFBQQ==",
      /^the key contains whitespace other than a space or tab/,
    ],
    [
      "a DSA key whose comment holds a non-breaking space: the comment is free text, so the reason is DSA",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP== example\u00a0words",
      /^the key is DSA/,
    ],
    ["prose", "hello world", /^the key's first field is not an algorithm GitHub accepts/],
    [
      "a DSA key, which GitHub stopped accepting in 2022 and would 422 at the create",
      "ssh-dss AAAAB3NzaC1kc3MAAACBAP==",
      /^the key is DSA, which GitHub no longer accepts \(since 2022-03-15\); a public SSH key reads/,
    ],
    [
      "an unknown algorithm",
      ED448_KEY,
      /^the key's first field is not an algorithm GitHub accepts/,
    ],
    [
      "a blob outside the base64 alphabet",
      "ssh-ed25519 AAAAC3Nz*C1lZDI1NTE5",
      /^the key's second field is not base64/,
    ],
    [
      "a blob whose length is not a multiple of four",
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBo",
      /^the key's second field is not base64/,
    ],
    [
      "a blob with padding mid-way",
      "ssh-ed25519 AAAA=3NzaC1lZDI1NTE5AAAAIBot",
      /^the key's second field is not base64/,
    ],
  ])("%s is refused with a reason that never quotes the input", (_label, raw, reason) => {
    const parsed = parsePublicKey(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.reason).toMatch(reason);
    // The reason may name the accepted algorithms; every other field of the input stays out of it.
    const algorithms = new Set<string>(PUBLIC_KEY_ALGORITHMS);
    for (const field of raw
      .split(/\s+/)
      .filter((field) => field !== "" && !algorithms.has(field))) {
      expect(parsed.reason).not.toContain(field);
    }
  });
});

describe("parseStoredKey", () => {
  test("material GitHub stored is read as algorithm + blob under ANY algorithm: GitHub is the authority on what it accepted", () => {
    expect(parseStoredKey(ED448_KEY)).toEqual({
      ok: true,
      algorithm: "ssh-ed448",
      material: ED448_KEY,
    });
    expect(parseStoredKey(`${BOT_KEY} deploy@host`)).toEqual({
      ok: true,
      algorithm: "ssh-ed25519",
      material: BOT_KEY,
    });
    expect(parsePublicKey(ED448_KEY).ok).toBe(false);
  });

  test.each<[label: string, raw: string, reason: RegExp]>([
    ["one field", "ssh-ed25519", /^the key has fewer than two fields separated by a space or tab$/],
    ["nothing", "", /^the key has fewer than two fields separated by a space or tab$/],
    ["a trailing newline", `${ED448_KEY}\n`, /^the key contains a line break$/],
    [
      "a non-breaking space between the two fields",
      "ssh-ed448\u00a0QUFBQQ==",
      /^the key contains whitespace other than a space or tab/,
    ],
    [
      "a blob outside the base64 alphabet",
      "ssh-ed448 AAAAC3Nz*C1lZDI1NTE5",
      /^the key's second field is not base64/,
    ],
  ])("%s is refused as a shape violation, never over the algorithm", (_label, raw, reason) => {
    const parsed = parseStoredKey(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toMatch(reason);
      expect(parsed.reason).not.toContain("algorithm GitHub accepts");
    }
  });
});

describe("deploy_keys schema", () => {
  test("a private key is refused at the settings-file parse, naming the entry by title and never the material: without this it is SENT to GitHub before the 422 comes back", () => {
    const result = DeployKeyConfig.safeParse({ title: "deploy-bot", key: PRIVATE_KEY });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [
        ["key"],
        'entry "deploy-bot": this is a private key; a deploy key takes the public half (the .pub file)',
      ],
    ]);
    expect(JSON.stringify(result.error?.issues)).not.toContain("BEGIN");
    expect(JSON.stringify(result.error?.issues)).not.toContain("U3ludGhl");
  });
});

describe("deploy_keys validation before any read", () => {
  test.each<
    [label: string, declared: Parameters<typeof deployKeysSection.validate>[0], issue: RegExp]
  >([
    [
      "duplicate declared titles",
      [
        { title: "deploy-bot", key: BOT_KEY },
        { title: "deploy-bot", key: MIRROR_KEY },
      ],
      /^\[1\]\.title: "deploy-bot" names the same deploy key as "deploy-bot" declared earlier/,
    ],
    [
      "duplicate declared MATERIAL under different titles (comments ignored)",
      [
        { title: "deploy-bot", key: `${BOT_KEY} deploy@bot` },
        { title: "mirror-pull", key: `${BOT_KEY} mirror@other-comment` },
      ],
      /^\[1\]\.key: the entries "deploy-bot" and "mirror-pull" declare the same key material.*keep one entry per key$/s,
    ],
  ])(
    "%s is one validate issue at the offending field, so the document fails before any API call",
    (_label, declared, issue) => {
      expect(
        deployKeysSection.validate(declared).map((found) => `${found.path}: ${found.message}`),
      ).toEqual([expect.stringMatching(issue)]);
    },
  );
});

describe("deploy_keys conflicts", () => {
  const renamed = [{ title: "new-name", key: `${MIRROR_KEY} deploy@renamed` }];
  test.each<[form: string, desired: SectionInput<"deploy_keys">]>([
    ["a plain list", renamed],
    [
      "a wrapped _undeclared: delete, whose delete-first order does not excuse it",
      { _undeclared: "delete", entries: renamed },
    ],
  ])(
    "material a live key holds under ANOTHER title is named after the one read, before any write, under %s",
    async (_form, desired) => {
      const api = new MockApi({ [LIST]: { data: [liveKey(7, "old-name", MIRROR_KEY)] } });
      await expect(plan(api, desired)).rejects.toThrow(
        new RegExp(
          '^deploy_keys: the settings file conflicts with the live deploy keys: the entry "new-name" ' +
            String.raw`declares key material that live key "old-name" \(id 7\) already holds.*` +
            String.raw`declare the entry under its live title "old-name"\. Resolve each conflict on GitHub, then re-run$`,
          "s",
        ),
      );
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
    },
  );

  test("two live keys under one title fail loudly, declared or not: GitHub does not enforce title uniqueness", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [liveKey(11, "deploy-bot", BOT_KEY), liveKey(12, "deploy-bot", MIRROR_KEY)],
      },
    });
    await expect(plan(api, [{ title: "deploy-bot", key: BOT_KEY }])).rejects.toThrow(
      'deploy_keys: GitHub holds deploy keys that resolve to one identity: "deploy-bot (key id 11)" and "deploy-bot (key id 12)". ' +
        "This section manages one deploy key per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again",
    );
    await expect(plan(api, [])).rejects.toThrow(/resolve to one identity/);
    expect(api.mutations()).toEqual([]);
  });

  test("the guard runs before the section's live conflicts: a duplicated title wins over a colliding holder's material", async () => {
    const api = new MockApi({
      [LIST]: { data: [liveKey(7, "dup", BOT_KEY), liveKey(8, "dup", MIRROR_KEY)] },
    });
    await expect(plan(api, [{ title: "other", key: BOT_KEY }])).rejects.toThrow(
      'deploy_keys: GitHub holds deploy keys that resolve to one identity: "dup (key id 7)" and "dup (key id 8)". ' +
        "This section manages one deploy key per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again",
    );
    expect(api.mutations()).toEqual([]);
  });
});

describe("deploy_keys loud live extraction", () => {
  test.each<[label: string, entry: Record<string, unknown>]>([
    ["a non-string title", { id: 1, title: 7, key: BOT_KEY, read_only: false }],
    ["a non-string key", { id: 1, title: "deploy-bot", key: null, read_only: false }],
    ["a non-numeric id", { id: "1", title: "deploy-bot", key: BOT_KEY, read_only: false }],
    // The documented shape requires the flag; a silent default would seed a recreate with a guess.
    ["no read_only flag", { id: 1, title: "deploy-bot", key: BOT_KEY }],
  ])("a live entry with %s is a contract violation naming the endpoint", async (_label, entry) => {
    const api = new MockApi({ [LIST]: { data: [entry] } });
    await expect(plan(api, [])).rejects.toThrow(
      /GET \/repos\/\{owner\}\/\{repo\}\/keys returned a body outside the documented shape/,
    );
  });

  test("a live key whose material is not two fields is a contract violation naming id, title, and endpoint", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(9, "stub", "ssh-ed25519")] } });
    await expect(plan(api, [])).rejects.toThrow(
      /GET \/repos\/\{owner\}\/\{repo\}\/keys returned a body outside the documented shape - .*key: key id 9 \("stub"\) holds material that is not "<algorithm> <base64>": the key has fewer than two fields separated by a space or tab/,
    );
  });

  test("a live key under an algorithm the settings file cannot declare is outside the section: never an abort, a match, or a delete", async () => {
    const live = [liveKey(9, "future", ED448_KEY, true)];
    const untouched = await plan(new MockApi({ [LIST]: { data: live } }), {
      _undeclared: "delete",
      entries: [],
    });
    expect(untouched).toEqual({ ops: [], notes: [], drift: [] });
    // The same title declared under a declarable algorithm is a new key beside it, not a replacement.
    const beside = await plan(new MockApi({ [LIST]: { data: live } }), [
      { title: "future", key: BOT_KEY, read_only: true },
    ]);
    expect(beside.ops.map((op) => op.role)).toEqual(["create"]);
  });
});

describe("deploy_keys reconcile", () => {
  test("a matching key (declared comment vs stored comment-free) plans nothing, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(1, "deploy-bot", BOT_KEY, true)] } });
    const result = await plan(api, [
      { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a missing declared key is one create carrying the material as GitHub stores it (comment stripped)", async () => {
    const api = new MockApi({ [LIST]: { data: [] } });
    const result = await plan(api, [
      { title: "deploy-bot", key: `${BOT_KEY} deploy@host`, read_only: true },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "create",
          payload: { title: "deploy-bot", key: BOT_KEY, read_only: true },
          describe: 'creating deploy key "deploy-bot"',
          drift: [
            "deploy_keys[deploy-bot]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created deploy key "deploy-bot"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("a divergent key is DELETE then POST: the generic line on the delete, the differing fields on the recreate", async () => {
    const api = new MockApi({ [LIST]: { data: [liveKey(10, "mirror-pull", STALE_KEY, false)] } });
    const result = await plan(api, [
      { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new`, read_only: true },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "remove",
          params: { key_id: "10" },
          describe: 'deleting deploy key "mirror-pull" before recreating it',
          drift: [
            "deploy_keys[mirror-pull]: live settings differ from the settings file, and deploy keys cannot be edited; apply will delete and recreate it",
          ],
          change: 'deleted deploy key "mirror-pull" to recreate it with the declared settings',
        },
        {
          role: "create",
          payload: { title: "mirror-pull", key: MIRROR_KEY, read_only: true },
          describe: 'recreating deploy key "mirror-pull"',
          drift: [
            `deploy_keys[mirror-pull].key: declared "${MIRROR_KEY}" != live "${STALE_KEY}"`,
            "deploy_keys[mirror-pull].read_only: declared true != live false",
          ],
          change: 'recreated deploy key "mirror-pull"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test.each<
    [
      label: string,
      declaredReadOnly: boolean | undefined,
      live: ReturnType<typeof liveKey>[],
      roles: ("create" | "remove")[],
      createPayloads: Record<string, string | boolean>[],
    ]
  >([
    [
      "a fresh create carries the declared flag",
      true,
      [],
      ["create"],
      [{ title: "mirror-pull", key: MIRROR_KEY, read_only: true }],
    ],
    [
      "a fresh create OMITS an undeclared flag, leaving GitHub's read/write default",
      undefined,
      [],
      ["create"],
      [{ title: "mirror-pull", key: MIRROR_KEY }],
    ],
    [
      "a recreate re-sends the live true under an undeclared flag (no privilege widening)",
      undefined,
      [liveKey(10, "mirror-pull", STALE_KEY, true)],
      ["remove", "create"],
      [{ title: "mirror-pull", key: MIRROR_KEY, read_only: true }],
    ],
    [
      "a recreate re-sends the live false under an undeclared flag",
      undefined,
      [liveKey(10, "mirror-pull", STALE_KEY, false)],
      ["remove", "create"],
      [{ title: "mirror-pull", key: MIRROR_KEY, read_only: false }],
    ],
    [
      "a declared false beats the live true on a recreate",
      false,
      [liveKey(10, "mirror-pull", STALE_KEY, true)],
      ["remove", "create"],
      [{ title: "mirror-pull", key: MIRROR_KEY, read_only: false }],
    ],
    [
      "a divergent DECLARED read_only alone forces the replace",
      false,
      [liveKey(10, "mirror-pull", MIRROR_KEY, true)],
      ["remove", "create"],
      [{ title: "mirror-pull", key: MIRROR_KEY, read_only: false }],
    ],
    [
      "an undeclared read_only is never compared, so the same material converges",
      undefined,
      [liveKey(10, "mirror-pull", MIRROR_KEY, true)],
      [],
      [],
    ],
  ])("%s", async (_label, declaredReadOnly, live, roles, createPayloads) => {
    const api = new MockApi({ [LIST]: { data: live } });
    const result = await plan(api, [
      {
        title: "mirror-pull",
        key: `${MIRROR_KEY} mirror@new`,
        ...(declaredReadOnly === undefined ? {} : { read_only: declaredReadOnly }),
      },
    ]);
    expect(result.ops.map((op) => op.role)).toEqual(roles);
    expect(result.ops.filter((op) => op.role === "create").map((op) => op.payload)).toEqual(
      createPayloads,
    );
    expect([result.notes, result.drift]).toEqual([[], []]);
  });

  test('a declared passthrough field named "material" earns the phantom-key note, diffed against the RAW api body', async () => {
    // The normalized material replaces the live `key` in place and never lands under another name, so a user field called "material" reads as absent
    // live rather than matching a synthetic field.
    const api = new MockApi({ [LIST]: { data: [liveKey(10, "deploy-bot", BOT_KEY)] } });
    const result = await plan(api, [
      { title: "deploy-bot", key: BOT_KEY, material: "whatever" } as never,
    ]);
    expect(result.ops.map((op) => [op.role, op.drift])).toEqual([
      [
        "remove",
        [
          "deploy_keys[deploy-bot]: live settings differ from the settings file, and deploy keys cannot be edited; apply will delete and recreate it",
        ],
      ],
      [
        "create",
        [
          'deploy_keys[deploy-bot].material: declared "whatever" but the API response has no such field (new or write-only field?)',
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      'deploy_keys[deploy-bot]: declared key "material" does not exist on the live deploy key, so if GitHub ignores it this delete-and-recreate will repeat on every apply without converging. Fix the key name, or remove it from the settings file',
    ]);
  });
});

describe("deploy_keys undeclared policy", () => {
  const liveKeys = [liveKey(1, "deploy-bot", BOT_KEY), liveKey(2, "retired-service", MIRROR_KEY)];
  const KEEP_NOTE =
    'deploy key "retired-service" exists on the repo but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply DELETE it';

  test.each<
    [
      form: string,
      declared: SectionInput<"deploy_keys">,
      ops: Awaited<ReturnType<typeof plan>>["ops"],
      notes: string[],
    ]
  >([
    [
      "wrapped _undeclared:delete",
      { _undeclared: "delete", entries: [{ title: "deploy-bot", key: BOT_KEY }] },
      [
        {
          role: "remove",
          params: { key_id: "2" },
          describe: 'deleting undeclared deploy key "retired-service"',
          drift: [
            'deploy_keys[retired-service]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared deploy key "retired-service"',
        },
      ],
      [],
    ],
    [
      "the wrapper without a policy",
      { entries: [{ title: "deploy-bot", key: BOT_KEY }] },
      [],
      [KEEP_NOTE],
    ],
    ["the plain list", [{ title: "deploy-bot", key: BOT_KEY }], [], [KEEP_NOTE]],
  ])(
    "%s resolves the undeclared key against the keep default",
    async (_form, declared, ops, notes) => {
      const api = new MockApi({ [LIST]: { data: liveKeys } });
      expect(await plan(api, declared)).toEqual({ ops, notes, drift: [] });
    },
  );
});

describe("deploy_keys convergence", () => {
  test("executing the plan against the derived mock converges: undeclared delete, create, DELETE-then-POST replace, and an empty re-plan", async () => {
    const api = fragmentFake(deployKeysSection, deployKeysMockHandlers, {
      deploy_keys: [
        liveKey(10, "mirror-pull", STALE_KEY, false),
        liveKey(20, "retired-service", RETIRED_KEY, true),
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(deployKeysSection, api, {
      _undeclared: "delete",
      entries: [
        { title: "deploy-bot", key: `${BOT_KEY} deploy@bot`, read_only: true },
        { title: "mirror-pull", key: `${MIRROR_KEY} mirror@new` },
      ],
    });
    expect(changes).toEqual([
      'DELETED undeclared deploy key "retired-service"',
      'created deploy key "deploy-bot"',
      'deleted deploy key "mirror-pull" to recreate it with the declared settings',
      'recreated deploy key "mirror-pull"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/keys/20",
      "POST /repos/o/r/keys",
      "DELETE /repos/o/r/keys/10",
      "POST /repos/o/r/keys",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    // The mock stores comment-free material the way GitHub does; the rotated key kept its live read_only through the recreate.
    expect(api.state.deploy_keys.map((k) => [k.title, k.key, k.read_only])).toEqual([
      ["deploy-bot", BOT_KEY, true],
      ["mirror-pull", MIRROR_KEY, false],
    ]);
  });

  test("the derived mock holds MATERIAL unique like GitHub: a repeated title is accepted, a repeated blob is 422", async () => {
    const api = fragmentFake(deployKeysSection, deployKeysMockHandlers, {
      deploy_keys: [liveKey(1, "deploy-bot", BOT_KEY)],
    });
    const post = async (body: Record<string, unknown>) => {
      const result = await api.tryRequest("POST", "/repos/o/r/keys", body);
      return "error" in result ? result.error.status : 201;
    };
    expect(await post({ title: "deploy-bot", key: MIRROR_KEY })).toBe(201);
    expect(await post({ title: "other-title", key: `${BOT_KEY} some@comment` })).toBe(422);
    expect(api.state.deploy_keys.map((k) => k.title)).toEqual(["deploy-bot", "deploy-bot"]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(deployKeysSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });
});
