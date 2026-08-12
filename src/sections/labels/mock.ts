/**
 * The labels section's e2e mock fragment: one handler per "labels.<role>"
 * key in the section's ENDPOINTS, registered in test/e2e/mock/sections.ts.
 * Imports only the leaf seam (mock/support.ts) - never
 * routes.ts or sections.ts; the bundle entry is src/main.ts, so this
 * fragment never reaches lib/index.js.
 */

import {
  asObject,
  findLabel,
  type Json,
  LABEL_CANONICAL_KEYS,
  labelName,
  noContent,
  ok,
  type SectionRestHandlers,
  slicePage,
} from "../../../test/e2e/mock/support.js";

export const labelsMockHandlers: SectionRestHandlers<"labels"> = {
  "labels.list": ({ state, query }) => ok(slicePage(state.labels, query)),
  "labels.create": ({ state, body }) => {
    const payload = asObject(body);
    // A duplicate name answers 422, matching GitHub. The labels SECTION never
    // POSTs a duplicate (it PATCHes an existing label), so this only fires for
    // the private-report marker-label ensure-create, which tolerates the 422.
    if (findLabel(state, String(payload.name))) {
      return { status: 422, body: { message: "Validation Failed" } };
    }
    // One id feeds both identity fields (the generateLabels pattern in
    // state.ts): the node_id encodes the label's OWN id, and the url names
    // the state's slug, so a multi-repo target's created label reads back as
    // its own repository's resource.
    const id = state.nextId++;
    // Spread the payload FIRST so passthrough fields the labels section sends
    // (and later subsetDiffs) are stored and read back; the known fields are
    // then normalized over them.
    const label: Json = {
      ...payload,
      id,
      node_id: `MDU6TGFiZWw${id}`,
      url: `https://api.github.com/repos/${state.slug}/labels/${String(payload.name)}`,
      name: payload.name,
      color: payload.color ?? "ededed",
      default: false,
      description: payload.description ?? null,
    };
    state.labels.push(label);
    return { status: 201, body: label };
  },
  "labels.update": ({ state, param, body }) => {
    const name = param("name");
    const label = findLabel(state, name);
    if (!label) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    if (typeof payload.new_name === "string") {
      label.name = payload.new_name;
    }
    if (payload.color !== undefined) {
      label.color = payload.color;
    }
    if (payload.description !== undefined) {
      label.description = payload.description;
    }
    // Passthrough fields update verbatim, mirroring the create path, so a
    // second apply's subsetDiff over them reads back what was written. The
    // canonical server-owned fields stay canonical, exactly like create.
    for (const [key, value] of Object.entries(payload)) {
      if (LABEL_CANONICAL_KEYS.has(key)) {
        continue;
      }
      label[key] = value;
    }
    return ok(label);
  },
  "labels.remove": ({ state, param }) => {
    const name = param("name");
    const index = state.labels.findIndex((l) => labelName(l) === name.toLowerCase());
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.labels.splice(index, 1);
    return noContent();
  },
};
