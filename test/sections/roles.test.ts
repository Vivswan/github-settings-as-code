import { describe, expect, test } from "bun:test";
import { permissionForRole, roleForPermission } from "../../src/sections/shared/roles.js";

describe("permissionForRole", () => {
  // One row per branch: the PUT-vocabulary map hit, the custom-role pass-through, the prototype-member guard
  // (a Map, not a record), and both roles no declaration plans as itself.
  test.each([
    ["write", "push"],
    ["admin", "admin"],
    ["constructor", "constructor"],
    // A custom org role passes through as spelled: GitHub matches the name exactly, so lowercasing it would plan a rename.
    ["Security-Team", "Security-Team"],
    // "push" and "pull" are the PUT vocabulary GitHub reads back as write and read, so a live role spelled that way maps nowhere.
    ["push", undefined],
    ["pull", undefined],
  ])("%s reads back as the declared permission %s", (role, permission) => {
    expect(permissionForRole(role)).toBe(permission);
    if (permission !== undefined) {
      expect(roleForPermission(permission)).toBe(role);
    }
  });
});
