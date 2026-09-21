import { describe, expect, test } from "bun:test";
import {
  type CentralTarget,
  dedupeTargets,
  type RemoteTarget,
} from "../../src/discovery/targets.js";

describe("dedupeTargets", () => {
  const central: CentralTarget[] = [
    { slug: "o/x", source: "central", origin: "repos/x.yml", filePath: "repos/x.yml" },
  ];
  const remote: RemoteTarget[] = [
    { slug: "O/X", source: "remote", origin: 'the "repos" input' },
    { slug: "o/z", source: "remote", origin: 'the "repos" input' },
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
    expect(merged).toEqual([
      { slug: "o/x", source: "central", origin: "repos/x.yml", filePath: "repos/x.yml" },
      { slug: "o/z", source: "remote", origin: 'the "repos" input' },
    ]);
    expect(notices).toEqual([expected]);
  });
});
