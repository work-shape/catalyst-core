import type { HttpRuntime } from "@vivd-catalyst/core";
import type { FastifyInstance } from "fastify";
import type { Route } from "./route";

interface Framework {
  app: FastifyInstance;
  route: Route;
}

const frameworks = new WeakMap<HttpRuntime["fetch"], Framework>();

export function rememberFramework(runtime: HttpRuntime, framework: Framework): void {
  frameworks.set(runtime.fetch, framework);
}

/**
 * The web framework behind a chat server, for this repository's test support: a test sets the
 * peer address of a call, lists the registered routes and registers fixture operations. Keyed
 * by the `fetch` function, which an assembly passes on unchanged. Not exported by the package.
 */
export function frameworkBehind(runtime: Pick<HttpRuntime, "fetch">): Framework | undefined {
  return frameworks.get(runtime.fetch);
}
