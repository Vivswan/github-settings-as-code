/**
 * `labels:` section - Probot parity: upsert declared labels by
 * case-insensitive name (with `new_name` rename support) and DELETE
 * undeclared labels, loudly. The wrapped `undeclared: keep` form softens
 * the deletion to notes.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  beginRun,
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  type SectionResult,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, listAll } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { LabelConfig } from "./schema.js";

/**
 * The case-insensitive matching key of a label name, branded so only
 * nameKey() can mint one: matching case-insensitively is this section's
 * whole contract, and the brand makes a map or set keyed by a raw (unfolded)
 * name a compile error instead of a silent case-sensitive lookup.
 */
declare const labelNameKey: unique symbol;
export type NameKey = string & { readonly [labelNameKey]: true };

/** Case-insensitive key for name-matched resources (labels). */
export function nameKey(name: string): NameKey {
  return name.toLowerCase() as NameKey;
}

/**
 * A label color in GitHub's stored form (no leading '#', lowercase),
 * branded so only normalizeColor() can mint one - a color compared or
 * written unfolded would drift forever against the stored form.
 */
declare const labelHexColor: unique symbol;
export type HexColor = string & { readonly [labelHexColor]: true };

/** Label colors: GitHub stores them without the leading '#', lowercase. */
export function normalizeColor(color: unknown): HexColor {
  return String(color ?? "")
    .replace(/^#/, "")
    .toLowerCase() as HexColor;
}

/** The fields of a live label this section reads; extra fields ride along. */
const LiveLabel = z.looseObject({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
});
type LiveLabel = z.infer<typeof LiveLabel>;

const permission: SectionPermission = { repo: ["issues"] };

const ENDPOINTS = {
  list: { route: "GET /repos/{owner}/{repo}/labels", statuses: { 200: "the label list" } },
  create: {
    route: "POST /repos/{owner}/{repo}/labels",
    statuses: { 201: "label created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/labels/{name}",
    statuses: { 200: "label updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/labels/{name}",
    statuses: { 204: "label deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const labelsSection = {
  key: "labels",
  undeclaredDefault: "delete",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(LabelConfig)),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    // Duplicate detection covers both identities of every entry: its name
    // and its rename target. Two entries resolving to the same label would
    // fight each other on every run (or fail mid-rename). Every collision is
    // collected before the one throw, so N duplicate pairs cost one run to
    // discover, not N.
    const claimed = new Map<NameKey, string>();
    const collisions: Array<{ first: string; second: string; key: NameKey }> = [];
    for (const label of desired) {
      const identities = new Set<NameKey>([
        nameKey(label.name),
        nameKey(label.new_name ?? label.name),
      ]);
      for (const key of identities) {
        const first = claimed.get(key);
        if (first !== undefined) {
          collisions.push({ first, second: label.name, key });
        }
      }
      for (const key of identities) {
        if (!claimed.has(key)) {
          claimed.set(key, label.name);
        }
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `labels: ${collisions.length} pair(s) of entries resolve to the same label (via name or new_name), so they cannot converge: ${collisions
          .map((c) => `"${c.first}" and "${c.second}" -> "${c.key}"`)
          .join("; ")}. Keep exactly one entry per label`,
      );
    }
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveLabel),
      await listAll(ctx, this, ENDPOINTS.list),
    );
    const liveByKey = new Map<NameKey, LiveLabel>();
    for (const label of live) {
      liveByKey.set(nameKey(label.name), label);
    }

    const declaredKeys = new Set<NameKey>();
    for (const label of desired) {
      const finalName = label.new_name ?? label.name;
      declaredKeys.add(nameKey(finalName));
      declaredKeys.add(nameKey(label.name));
      const bySource = liveByKey.get(nameKey(label.name));
      const byTarget = liveByKey.get(nameKey(finalName));
      if (label.new_name && bySource && byTarget && bySource !== byTarget) {
        throw new Error(
          `labels: cannot rename "${label.name}" to "${finalName}" - both already exist as separate labels on the repo; delete one of them on GitHub, or remove new_name from "${label.name}" in the settings file`,
        );
      }
      const existing = bySource ?? byTarget;
      const wantColor = label.color === undefined ? undefined : normalizeColor(label.color);
      // The declared description, tagged instead of folded to "": an absent
      // declaration leaves the live description alone, which a bare "" (the
      // same value an explicit empty declaration produces) cannot express.
      const description: { declared: true; value: string } | { declared: false } =
        label.description === undefined
          ? { declared: false }
          : { declared: true, value: label.description };

      const {
        new_name: _newName,
        name: _name,
        color: _color,
        description: _description,
        ...extraKeys
      } = label;
      if (!existing) {
        if (run.check) {
          run.result.drift.push(
            `labels[${finalName}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.create, {
            payload: {
              name: finalName,
              ...(wantColor === undefined ? {} : { color: wantColor }),
              // The create POST always carries the field; undeclared means
              // the empty default, which is also GitHub's.
              description: description.declared ? description.value : "",
              ...extraKeys, // future label fields pass through verbatim
            },
          });
          run.result.changes.push(`created label "${finalName}"`);
        }
        continue;
      }

      const colorDrift = wantColor !== undefined && normalizeColor(existing.color) !== wantColor;
      const renameDrift = existing.name !== finalName;
      const extraDrift = subsetDiff(extraKeys, existing, `labels[${finalName}]`);
      const descriptionDrift =
        description.declared && (existing.description ?? "") !== description.value;
      if (!colorDrift && !descriptionDrift && !renameDrift && extraDrift.length === 0) {
        continue;
      }
      if (run.check) {
        if (renameDrift) {
          run.result.drift.push(
            `labels[${existing.name}]: should be named "${finalName}" per the settings file; apply will rename it`,
          );
        }
        if (colorDrift) {
          run.result.drift.push(
            `labels[${finalName}].color: declared "${wantColor}" != live "${normalizeColor(existing.color)}"; apply will set the declared value`,
          );
        }
        if (description.declared && descriptionDrift) {
          run.result.drift.push(
            `labels[${finalName}].description: declared ${JSON.stringify(description.value)} != live ${JSON.stringify(existing.description ?? "")}; apply will set the declared value`,
          );
        }
        run.result.drift.push(...extraDrift);
      } else {
        const phantom = phantomKeys(extraKeys, existing);
        if (phantom.length > 0) {
          run.result.notes.push(
            phantomNote(`labels[${finalName}]`, phantom, "label", "this update will re-run"),
          );
        }
        await call(ctx, this, ENDPOINTS.update, {
          params: { name: existing.name },
          payload: {
            new_name: finalName,
            ...(wantColor === undefined ? {} : { color: wantColor }),
            ...(description.declared ? { description: description.value } : {}),
            ...extraKeys, // future label fields pass through verbatim
          },
        });
        run.result.changes.push(`updated label "${finalName}"`);
      }
    }

    // Probot parity: undeclared labels are deleted by default, loudly on
    // purpose; the wrapped `undeclared: keep` form downgrades each to a note.
    for (const label of liveByKey.values()) {
      if (declaredKeys.has(nameKey(label.name))) {
        continue;
      }
      if (policy === "keep") {
        run.result.notes.push(
          undeclaredNote({ subject: `label "${label.name}"`, action: "DELETE it" }),
        );
      } else if (run.check) {
        run.result.drift.push(
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `labels[${label.name}]`,
            action: "DELETE it",
          }),
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, { params: { name: label.name } });
        run.result.changes.push(`DELETED undeclared label "${label.name}"`);
      }
    }
    return run.result;
  },
} satisfies SectionModule<"labels">;
