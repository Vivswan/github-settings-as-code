import type { Endpoints } from "@octokit/types";
import type { MustBeNever } from "../types.js";
import { defineGap } from "./gap.js";

/** GitHub shipped repository agents variables; @octokit/types does not carry these routes yet. */
export const GAP = defineGap({
  routes: [
    "GET /repos/{owner}/{repo}/agents/variables",
    "POST /repos/{owner}/{repo}/agents/variables",
    "PATCH /repos/{owner}/{repo}/agents/variables/{name}",
    "DELETE /repos/{owner}/{repo}/agents/variables/{name}",
  ],
  documentedInSpec: true,
});

/** Fires when @octokit/types gains any of these routes: the graduate script retires this file per its documentedInSpec lifecycle. */
type _GraduateThisFileOnceOctokitShipsIt = MustBeNever<
  Extract<(typeof GAP.routes)[number], keyof Endpoints>
>;
