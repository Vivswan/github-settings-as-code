/**
 * The custom_properties e2e mock fragment (registered in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { CUSTOM_PROPERTY_DEFINITIONS } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  type Json,
  noContent,
  ok,
  orgProbeHandler,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const customPropertiesMockHandlers: SectionRestHandlers<"custom_properties"> = {
  "custom_properties.org": orgProbeHandler,
  // Not paginated upstream: the single GET returns every value.
  "custom_properties.list": ({ state }) => ok(state.custom_property_values),
  "custom_properties.update": ({ state, body }) => {
    const properties = asObject(body).properties;
    if (!Array.isArray(properties)) {
      return {
        status: 422,
        body: { message: 'Invalid request.\n\n"properties" wasn\'t supplied.' },
      };
    }
    // GitHub rejects the whole PATCH when any named property is not DEFINED at the organization
    // level; the fixture is the single source of defined names (the fuzz generator draws from it too).
    for (const entry of properties) {
      const name = asObject(entry).property_name;
      const defined = CUSTOM_PROPERTY_DEFINITIONS.some((d) => d.property_name === name);
      if (!defined) {
        return {
          status: 422,
          body: {
            message: `Custom property '${String(name)}' is not defined for this organization`,
            documentation_url:
              "https://docs.github.com/rest/repos/custom-properties#create-or-update-custom-property-values-for-a-repository",
          },
        };
      }
    }
    for (const entry of properties) {
      const { property_name, value } = asObject(entry);
      const index = state.custom_property_values.findIndex(
        (p) => p.property_name === property_name,
      );
      if (value === null || value === undefined) {
        if (index >= 0) {
          state.custom_property_values.splice(index, 1);
        }
        continue;
      }
      if (index >= 0) {
        (state.custom_property_values[index] as Json).value = value;
      } else {
        state.custom_property_values.push({ property_name, value });
      }
    }
    return noContent();
  },
};
