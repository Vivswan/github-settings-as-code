import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import {
  type CentralTarget,
  dedupeTargets,
  parseRepoSlug,
  type RemoteTarget,
} from "../../src/discovery/targets.js";

describe("parseRepoSlug", () => {
  // GitHub names no owner or repository "." or "..", and as path segments they resolve a request elsewhere:
  // /repos/../x/labels is /x/labels once the URL is normalized. Nothing but this boundary keeps them out.
  test.each<[string, ReturnType<typeof parseRepoSlug>]>([
    ["a.b/c.d", ok({ owner: "a.b", name: "c.d", slug: "a.b/c.d" })],
    [".a/b.", ok({ owner: ".a", name: "b.", slug: ".a/b." })],
    ["../x", err({ code: "repo-slug-invalid", value: "../x" })],
    ["./x", err({ code: "repo-slug-invalid", value: "./x" })],
    ["x/..", err({ code: "repo-slug-invalid", value: "x/.." })],
    ["x/.", err({ code: "repo-slug-invalid", value: "x/." })],
  ])("%s -> %p", (raw, result) => {
    expect(parseRepoSlug(raw)).toEqual(result);
  });
});

describe("dedupeTargets", () => {
  const ref = (slug: string) => parseRepoSlug(slug)._unsafeUnwrap();
  const centralX: CentralTarget = {
    repo: ref("o/x"),
    source: "central",
    origin: "repos/x.yml",
    filePath: "repos/x.yml",
  };
  const remoteZ: RemoteTarget = { repo: ref("o/z"), source: "remote", origin: 'the "repos" input' };
  const central = [centralX];
  const remote: RemoteTarget[] = [
    { repo: ref("O/X"), source: "remote", origin: 'the "repos" input' },
    remoteZ,
  ];
  const IGNORED = 'the entry for the same repository from the "repos" input is ignored';

  test.each<[string, (slug: string) => string, ((slug: string) => boolean) | undefined, string]>([
    [
      "central wins over remote for the same repo, with a notice",
      (slug) => slug,
      undefined,
      `O/X: using the central file repos/x.yml; ${IGNORED}`,
    ],
    // Wrapping the origin noun phrase must not double its article.
    [
      "the notice renders the slug through display; a non-redacted origin stays verbatim",
      () => "private repository #1",
      undefined,
      `private repository #1: using the central file repos/x.yml; ${IGNORED}`,
    ],
    // The central file path can embed the real repo name, so it must not appear next to the placeholder.
    [
      "a redacted target's central origin is rendered generically, never the file path",
      () => "private repository #1",
      () => true,
      `private repository #1: using the central file a repos-dir file; ${IGNORED}`,
    ],
  ])("%s", (_case, display, isRedacted, expected) => {
    const notices: string[] = [];
    const merged = dedupeTargets(central, remote, (m) => notices.push(m), display, isRedacted);
    expect(merged).toEqual([centralX, remoteZ]);
    expect(notices).toEqual([expected]);
  });
});
