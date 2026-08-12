/**
 * Shared section-handler contract and error classification, re-exported from
 * the layered modules under ./contract/ (permissions -> endpoints/graphql ->
 * module -> errors -> requests; imports between them flow one way).
 */

export * from "./contract/endpoints.js";
export * from "./contract/errors.js";
export * from "./contract/graphql.js";
export * from "./contract/module.js";
export * from "./contract/permissions.js";
export * from "./contract/requests.js";
