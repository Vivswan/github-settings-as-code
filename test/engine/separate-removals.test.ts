import { describe, expect, test } from "bun:test";
import { separateRemovals } from "../../src/engine/separate-removals.js";

/** A plain mapping that counts each time a walk lists its keys; a Proxy over one still reads as plain YAML data. */
function counted<T extends object>(target: T, visits: { count: number }): T {
  return new Proxy(target, {
    ownKeys: (inner) => {
      visits.count += 1;
      return Reflect.ownKeys(inner);
    },
  });
}

describe("separateRemovals: the markers no list keys", () => {
  // One YAML anchor aliased under two keys, 24 levels deep, is 25 mappings and 2^25 - 1 paths: walked per path,
  // a library caller's document that holds no marker at all took seconds to say so.
  test("a mapping shared by many paths is walked once when it holds no marker", () => {
    const visits = { count: 0 };
    let shared: object = counted({}, visits);
    for (let depth = 0; depth < 24; depth += 1) {
      shared = counted({ left: shared, right: shared }, visits);
    }
    expect(separateRemovals({ repository: { custom: shared } }).unkeyed).toEqual([]);
    expect(visits.count).toBe(25);
  });

  // A walk a cycle cut short does not know what the cut hid. Remembered as marker-free all the same, the mapping
  // was skipped on its second path, and a document whose cycle the shapes drop (an own `__proto__` key) lost a line.
  test("a mapping whose walk a cycle cut short is not remembered as marker-free, so a second path through it still finds the marker", () => {
    const first: Record<string, unknown> = { custom_list: [{ _remove: true }] };
    const second = { back: first };
    first.next = second;
    expect(separateRemovals({ repository: first, actions: second }).unkeyed).toEqual([
      "repository.custom_list[0]._remove",
      "actions.back.custom_list[0]._remove",
    ]);
  });

  test("control: a shared list that holds a marker is still walked per path, so every path keeps its own line", () => {
    const marked = [{ _remove: true }];
    const quiet = { nested: [{ a: 1 }] };
    const doc = {
      repository: { first: marked, calm: quiet, second: { again: marked, calm: quiet } },
    };
    expect(separateRemovals(doc).unkeyed).toEqual([
      "repository.first[0]._remove",
      "repository.second.again[0]._remove",
    ]);
  });
});
