import type { Endpoints } from "@octokit/types";
import type { MustBeNever } from "../schema.js";
import { defineGap } from "./gap.js";

/** GitHub shipped repository-level secret scanning custom patterns; @octokit/types does not carry these routes yet. */
export const GAP = defineGap({
  routes: [
    "GET /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    "POST /repos/{owner}/{repo}/secret-scanning/custom-patterns",
    "PATCH /repos/{owner}/{repo}/secret-scanning/custom-patterns/{pattern_id}",
    "DELETE /repos/{owner}/{repo}/secret-scanning/custom-patterns",
  ],
  documentedInSpec: true,
});

/** Fires when @octokit/types gains any of these routes: DELETE THIS FILE and its two lines in index.ts. */
type _DeleteThisFileOnceOctokitShipsIt = MustBeNever<
  Extract<(typeof GAP.routes)[number], keyof Endpoints>
>;
