import type { Endpoints } from "@octokit/types";
import type { MustBeNever } from "../schema.js";
import { defineGap } from "./gap.js";

/** GitHub shipped the pull-request interaction caps (creation cap and bypass list); @octokit/types does not carry these routes yet. */
export const GAP = defineGap({
  routes: [
    "GET /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    "PATCH /repos/{owner}/{repo}/interaction-limits/pulls/creation-cap",
    "GET /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
    "PUT /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
    "DELETE /repos/{owner}/{repo}/interaction-limits/pulls/bypass-list",
  ],
  documentedInSpec: true,
});

/** Fires when @octokit/types gains any of these routes: DELETE THIS FILE and its two lines in index.ts. */
type _DeleteThisFileOnceOctokitShipsIt = MustBeNever<
  Extract<(typeof GAP.routes)[number], keyof Endpoints>
>;
