/**
 * The milestones e2e mock fragment (registered in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  asObject,
  type Json,
  nextNumber,
  noContent,
  ok,
  type SectionRestHandlers,
  slicePage,
} from "../../../test/e2e/mock/support.js";

export const milestonesMockHandlers: SectionRestHandlers<"milestones"> = {
  "milestones.list": ({ state, query }) => ok(slicePage(state.milestones, query)),
  "milestones.create": ({ state, body }) => {
    const payload = asObject(body);
    const number = nextNumber(state.milestones);
    const milestone: Json = {
      id: state.nextId++,
      number,
      state: "open",
      description: null,
      ...payload,
    };
    state.milestones.push(milestone);
    return { status: 201, body: milestone };
  },
  "milestones.update": ({ state, param, body }) => {
    const number = param("milestone_number");
    const milestone = state.milestones.find((m) => String(m.number) === number);
    if (!milestone) {
      return { status: 404, body: { message: "Not Found" } };
    }
    Object.assign(milestone, asObject(body));
    return ok(milestone);
  },
  "milestones.remove": ({ state, param }) => {
    const number = param("milestone_number");
    const index = state.milestones.findIndex((m) => String(m.number) === number);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.milestones.splice(index, 1);
    return noContent();
  },
};
