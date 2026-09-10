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

  test("central wins over remote for the same repo, with a notice", () => {
    const notices: string[] = [];
    const merged = dedupeTargets(
      central,
      remote,
      (m) => notices.push(m),
      (slug) => slug,
    );
    expect(merged).toEqual([
      { slug: "o/x", source: "central", origin: "repos/x.yml", filePath: "repos/x.yml" },
      { slug: "o/z", source: "remote", origin: 'the "repos" input' },
    ]);
    expect(notices).toEqual([
      'O/X: using the central file repos/x.yml; the entry for the same repository from the "repos" input is ignored',
    ]);
  });

  test("the notice renders the slug through display; a non-redacted origin stays verbatim", () => {
    const notices: string[] = [];
    dedupeTargets(
      central,
      remote,
      (m) => notices.push(m),
      () => "private repository #1",
    );
    // The whole notice: the placeholder replaces the slug everywhere, the
    // origin noun phrase is wrapped without a doubled article.
    expect(notices).toEqual([
      'private repository #1: using the central file repos/x.yml; the entry for the same repository from the "repos" input is ignored',
    ]);
  });

  test("a redacted target's central origin is rendered generically, never the file path", () => {
    // The central file path (repos/secret.yml) can embed the real repo name, so for
    // a redacted target it must not appear next to the placeholder.
    const notices: string[] = [];
    dedupeTargets(
      [
        {
          slug: "o/secret",
          source: "central",
          origin: "repos/secret.yml",
          filePath: "repos/secret.yml",
        },
      ],
      [{ slug: "o/secret", source: "remote", origin: 'the "repos" input' }],
      (m) => notices.push(m),
      () => "private repository #1",
      () => true,
    );
    expect(notices).toEqual([
      'private repository #1: using the central file a repos-dir file; the entry for the same repository from the "repos" input is ignored',
    ]);
  });
});
