/**
 * bottleneck publishes types only for its main entry, not for the light build (the same class minus the Redis
 * backends, and what @octokit/plugin-throttling itself imports). api.ts imports the light build to override the
 * plugin's write limiter without bundling the Redis code, so the main types are re-exported for it.
 */
declare module "bottleneck/light.js" {
  import Bottleneck from "bottleneck";
  export default Bottleneck;
}
