import type { Endpoints } from "@octokit/types";
import type { MustBeNever } from "../schema.js";
import { defineGap } from "./gap.js";

/** GitHub shipped the Git LFS repository toggle; @octokit/types does not carry these routes yet, nor does the published OpenAPI description. */
export const GAP = defineGap({
  routes: ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"],
  documentedInSpec: false,
});

/** Fires when @octokit/types gains any of these routes: DELETE THIS FILE and its two lines in index.ts. */
type _DeleteThisFileOnceOctokitShipsIt = MustBeNever<
  Extract<(typeof GAP.routes)[number], keyof Endpoints>
>;
