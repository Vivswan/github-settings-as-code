/**
 * Fetch one file's raw content from a repository's default branch.
 * A contents 404 is ambiguous (missing file, missing Contents permission, or
 * a token that cannot see the repo at all), so `missing` means PROVEN ABSENT:
 * the repo probe (Metadata, which every fine-grained PAT can read) names the
 * default branch, and reading that branch's git ref - a call that needs
 * Contents: read and succeeds whether or not the file exists - proves the
 * token could have read the file. A ref read that fails leaves the proof
 * inconclusive (a denied grant, or an empty repository whose default branch
 * has no commit): `unproven` carries a message naming both, distinct from
 * `error` (a failure of the reads themselves) and never a missing file.
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
  // A branch name may carry any URL-significant character but "/", which
  // GitHub routes as a segment separator, so each segment is encoded on its own.
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
    unproven: `cannot prove ${filePath} is absent: reading the default branch ref ${ref} returned ${refProbe.error.status}. Grant the token Contents: read on this repository, or initialize its default branch; a repository whose file cannot be read never receives the defaults`,
  };
}
