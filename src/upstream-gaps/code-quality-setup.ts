import type { Endpoints } from "@octokit/types";
import type { MustBeNever } from "../schema.js";
import { defineGap } from "./gap.js";

/** GitHub shipped the repository code quality setup; @octokit/types does not carry these routes yet. */
export const GAP = defineGap({
  routes: [
    "GET /repos/{owner}/{repo}/code-quality/setup",
    "PATCH /repos/{owner}/{repo}/code-quality/setup",
  ],
  documentedInSpec: true,
});

/** Fires when @octokit/types gains any of these routes: DELETE THIS FILE and its two lines in index.ts. */
type _DeleteThisFileOnceOctokitShipsIt = MustBeNever<
  Extract<(typeof GAP.routes)[number], keyof Endpoints>
>;
