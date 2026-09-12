/**
 * A contents 404 is ambiguous (missing file, missing Contents grant, or a repo the token cannot see), so `missing` means
 * PROVEN ABSENT, and `unproven` is distinct from both it and `error`.
 *
 *   contents 404 -> GET /repos (Metadata, readable by every fine-grained PAT) names the default branch
 *                -> that branch's git ref is read, which needs Contents: read and succeeds whether or not the file exists
 *                -> the token could have read the file, so it is missing
 *
 * A failed ref read leaves the proof inconclusive: a denied grant, or an empty repository whose branch has no commit.
 */

import { type ApiError, type GithubClient, isRateLimitError } from "./api.js";

export async function getRepoFile(
  api: GithubClient,
  slug: string,
  filePath: string,
): Promise<{ content: string } | { missing: true } | { unproven: string } | { error: ApiError }> {
  const result = await api.tryRequest("GET", `/repos/${slug}/contents/${filePath}`, undefined, {
    accept: "application/vnd.github.raw+json",
    raw: true,
  });
  if (!("error" in result)) {
    return { content: String(result.data ?? "") };
  }
  if (result.error.status !== 404) {
    return { error: result.error };
  }
  const repoProbe = await api.tryRequest("GET", `/repos/${slug}`);
  if ("error" in repoProbe) {
    return { error: repoProbe.error };
  }
  const defaultBranch = (repoProbe.data as { default_branch?: unknown } | null)?.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch === "") {
    return {
      error: {
        status: 500,
        message: `the repository object names no default branch, so Contents access cannot be proven and ${filePath} cannot be fetched`,
        body: "",
      },
    };
  }
  const ref = `heads/${defaultBranch}`;
  // Each segment is encoded on its own: a branch name may contain "/", which GitHub routes as a segment separator and
  // must stay unencoded, while any other URL-significant character must be encoded.
  const refPath = defaultBranch.split("/").map(encodeURIComponent).join("/");
  const refProbe = await api.tryRequest("GET", `/repos/${slug}/git/ref/heads/${refPath}`);
  if (!("error" in refProbe)) {
    return { missing: true };
  }
  const denied = refProbe.error.status === 404 || refProbe.error.status === 403;
  if (!denied || isRateLimitError(refProbe.error)) {
    return { error: refProbe.error };
  }
  return {
    unproven:
      `cannot prove ${filePath} is absent: reading the default branch ref ${ref} returned ` +
      `${refProbe.error.status}. Grant the token Contents: read on this repository, or ` +
      `initialize its default branch; a repository whose file cannot be read never receives the ` +
      `defaults`,
  };
}
