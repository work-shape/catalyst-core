// The build itself. It loads the bundler and the route generator and is run by the build
// command in the sandbox. The worker does not import it.
export { buildPage } from "./bundle";
export { rewriteHtml, type ExtractedInlineFile, type RewrittenHtml } from "./html";
export {
  PAGE_MANIFEST_MAX_BYTES,
  builtPageManifestSchema,
  pageManifestSchema,
  parsePageManifest,
  type ParsedPageManifest
} from "./manifest";
export {
  generateRouteTree,
  isVirtualRouteConfig,
  PAGE_ROUTES_DIRECTORY,
  PAGE_ROUTE_TREE_FILE,
  ROUTE_GENERATOR_EXECUTED_FILE,
  type GeneratedRoutes
} from "./routes";
