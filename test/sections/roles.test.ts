import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROLE,
  permissionForRole,
  roleForPermission,
} from "../../src/sections/shared/roles.js";

describe("roleForPermission", () => {
  test("maps the PUT vocabulary to the GET role_name vocabulary", () => {
    expect(roleForPermission("push")).toBe("write");
    expect(roleForPermission("pull")).toBe("read");
  });

  test("passes custom and already-GET-vocabulary roles through untouched", () => {
    expect(roleForPermission("admin")).toBe("admin");
    expect(roleForPermission("maintain")).toBe("maintain");
    expect(roleForPermission("triage")).toBe("triage");
    expect(roleForPermission("security-team")).toBe("security-team");
  });

  test("a permission named like a prototype member passes through instead of resolving Object.prototype", () => {
    expect(roleForPermission("constructor")).toBe("constructor");
    expect(roleForPermission("toString")).toBe("toString");
  });
});

describe("permissionForRole", () => {
  test.each([
    ["write", "push"],
    ["read", "pull"],
    ["admin", "admin"],
    ["maintain", "maintain"],
    ["security-team", "security-team"],
    ["constructor", "constructor"],
    // A role no declaration produces: "push" and "pull" are the PUT vocabulary GitHub reads
    // back as write and read, so a live role spelled that way maps nowhere.
    ["push", undefined],
    ["pull", undefined],
  ])("%s reads back as the declared permission %s", (role, permission) => {
    expect(permissionForRole(role)).toBe(permission);
    if (permission !== undefined) {
      expect(roleForPermission(permission)).toBe(role);
    }
  });
});

describe("DEFAULT_ROLE", () => {
  test("is push, the write default both collaborators and teams fall back to", () => {
    // collaborators.ts and teams.ts both read this symbol, so a change moves both sections at once rather than letting them diverge.
    expect(DEFAULT_ROLE).toBe("push");
    expect(roleForPermission(DEFAULT_ROLE)).toBe("write");
  });
});
