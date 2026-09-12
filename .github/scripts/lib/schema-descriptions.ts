/**
 * Every definition and property must end up with exactly one description and every key must describe something, so
 * a renamed field, a forgotten sentence, and a double entry all fail the build. The one exception is an
 * additionalProperties schema (`.*`): it stands for "any other key", which the parent's own description covers.
 *
 *   LabelConfig.color                                                -> a property
 *   EnvironmentConfig.deployment_branch_policy|0.protected_branches  -> arm 0 of an anyOf/oneOf
 *   RepositoryConfig.*                                               -> the additionalProperties schema; `[]` is array items
 *   UndeclaredPolicyList<*>.entries                                  -> every generic instance
 *   {ActionsSecretConfig,AgentsSecretConfig}.name                    -> each listed alternative
 */

export interface JsonSchemaNode {
  [key: string]: unknown;
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  additionalProperties?: JsonSchemaNode | boolean;
}

/** `source` is the file it came from, for the failure report. */
export interface SchemaDescription {
  readonly key: string;
  readonly text: string;
  readonly source: string;
}

export interface Site {
  readonly node: JsonSchemaNode;
  readonly required: boolean;
}

export function describableSites(
  definitions: Readonly<Record<string, JsonSchemaNode>>,
): Map<string, Site> {
  const sites = new Map<string, Site>();
  const visit = (node: JsonSchemaNode, key: string): void => {
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      sites.set(`${key}.${name}`, { node: property, required: true });
      visit(property, `${key}.${name}`);
    }
    for (const [i, arm] of (node.anyOf ?? node.oneOf ?? []).entries()) {
      visit(arm, `${key}|${i}`);
    }
    if (node.items !== undefined) {
      visit(node.items, `${key}[]`);
    }
    if (typeof node.additionalProperties === "object") {
      sites.set(`${key}.*`, { node: node.additionalProperties, required: false });
      visit(node.additionalProperties, `${key}.*`);
    }
  };
  for (const [name, definition] of Object.entries(definitions)) {
    sites.set(name, { node: definition, required: true });
    visit(definition, name);
  }
  return sites;
}

function expandBraces(key: string): string[] {
  const match = /^\{([^}]*)\}(.*)$/.exec(key);
  if (match === null) {
    return [key];
  }
  const [, list = "", rest = ""] = match;
  return list.split(",").map((name) => `${name.trim()}${rest}`);
}

function keyMatches(pattern: string, site: string): boolean {
  const generic = pattern.indexOf("<*>");
  if (generic === -1) {
    return pattern === site;
  }
  const head = pattern.slice(0, generic);
  const tail = pattern.slice(generic + "<*>".length);
  if (!site.startsWith(head) || !site.endsWith(tail) || site.length <= head.length + tail.length) {
    return false;
  }
  const instance = site.slice(head.length, site.length - tail.length);
  return /^<[^<>]+>$/.test(instance);
}

/** In place. Throws one error listing every problem, so a docs sweep fixes them in one pass. */
export function attachDescriptions(
  definitions: Record<string, JsonSchemaNode>,
  descriptions: readonly SchemaDescription[],
): void {
  const sites = describableSites(definitions);
  const claims = new Map<string, SchemaDescription[]>();
  const problems: string[] = [];
  for (const description of descriptions) {
    // Each brace alternative must name a site of its own, so a removed factory member cannot
    // hide behind its siblings; overlapping alternatives still claim a site once.
    const claimedHere = new Set<string>();
    for (const pattern of expandBraces(description.key)) {
      let matched = 0;
      for (const site of sites.keys()) {
        if (keyMatches(pattern, site)) {
          matched++;
          if (!claimedHere.has(site)) {
            claimedHere.add(site);
            claims.set(site, [...(claims.get(site) ?? []), description]);
          }
        }
      }
      if (matched === 0) {
        const spelled =
          pattern === description.key ? `"${pattern}"` : `"${pattern}" (from "${description.key}")`;
        problems.push(`${description.source}: ${spelled} describes nothing in the schema`);
      }
    }
  }
  for (const [site, { node, required }] of sites) {
    const claimed = claims.get(site) ?? [];
    if (claimed.length === 0) {
      if (required) {
        problems.push(`${site} has no description in any docs file`);
      }
    } else if (claimed.length > 1) {
      const sources = claimed.map((d) => `${d.source} ("${d.key}")`).join(", ");
      problems.push(`${site} is described more than once: ${sources}`);
    } else {
      // Description first, whatever order the generator emitted: one convention, stable diffs. A bare $ref takes no
      // siblings in draft-7, so it moves under allOf, as zod itself emits a described reference.
      const rest = Object.fromEntries(Object.entries(node).filter(([k]) => k !== "description"));
      for (const key of Object.keys(node)) {
        delete node[key];
      }
      node.description = claimed[0]?.text;
      if (typeof rest.$ref === "string") {
        node.allOf = [rest];
      } else {
        Object.assign(node, rest);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`schema descriptions:\n- ${problems.join("\n- ")}`);
  }
}
