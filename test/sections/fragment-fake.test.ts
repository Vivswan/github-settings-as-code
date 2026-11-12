/**
 * The fake answers GraphQL through the stages the wire pipeline runs ahead of its handlers. The section suites send
 * only requests GitHub accepts, so the refusal path is pinned here: without it a section proof could converge on
 * variables GitHub would refuse.
 */

import { expect, test } from "bun:test";
import { allGraphqlOps } from "../../src/sections/registry.js";
import { mintNodeId } from "../e2e/mock/node-id.js";
import { registryFake } from "./fragment-fake.js";
import { REPO } from "./section-run.js";

test("control: pinned: null through the fake is refused as GitHub refuses it and stores nothing, while pinned: false unpins", async () => {
  const fake = registryFake({
    environments: { prod: { name: "prod", protection_rules: [] } },
    pinned_environments: ["prod"],
  });
  const op = allGraphqlOps()["environments.pin"];
  const environmentId = mintNodeId("environment", REPO.slug, "prod");
  const pinned = () => fake.state.pinned_environments.map((pin) => pin.name);

  const refused = await fake.tryGraphql(op, { environmentId, pinned: null }, REPO.slug);
  expect(refused).toEqual({
    error: expect.objectContaining({
      status: 422,
      message: expect.stringContaining('Variable "$pinned" has invalid value'),
    }),
  });
  expect(fake.writes).toEqual([]);
  expect(pinned()).toEqual(["prod"]);

  // The same request with a boolean: the refusal above came from the null, not from the fake.
  const accepted = await fake.tryGraphql(op, { environmentId, pinned: false }, REPO.slug);
  expect(accepted).toEqual({
    data: { pinEnvironment: { environment: { name: "prod", isPinned: false } } },
  });
  expect(fake.writes).toEqual(["GRAPHQL PinEnvironment"]);
  expect(pinned()).toEqual([]);
});
