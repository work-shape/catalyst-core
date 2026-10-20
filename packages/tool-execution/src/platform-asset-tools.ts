import { AppError } from "@work-shape/catalyst-core";
import type { AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import type { AppSaveCalls } from "./app-save-tool";
import { createGetAssetTool, type PlatformAssetGetCalls } from "./platform-asset-tools/get";
import { createOpenAssetTool, type PlatformAssetOpenCalls } from "./platform-asset-tools/open";
import {
  createOperationsTool,
  type PlatformOperationsCalls
} from "./platform-asset-tools/operations";
import { createPutAssetTool, type PlatformAssetPutCalls } from "./platform-asset-tools/put";
import type { SkillSaveApprovalCalls } from "./platform-asset-tools/skill-save-approval";
import {
  createValidateAssetTool,
  type PlatformAssetValidateCalls
} from "./platform-asset-tools/validate";
import type { PlatformDiscoveryCalls } from "./platform-discovery-tools";

// The tools an agent opens, reads and saves the draft of an asset with. Each is a projection of
// an operation of the API under the name the agent calls it by: the same implementation
// carries both, with the rights, the checks and the audit of the person the agent acts for.
// Opening an asset is the one thing that makes it the subject of the conversation and takes
// the person to its page; a read that names another asset only reads it. The check and the save
// reach the subject and the drafts the conversation created (BUILD-ALL-1), and no other asset,
// whatever a model sends. A further tool is one more row of `PLATFORM_ASSET_TOOLS`, a file of
// its own under `platform-asset-tools/` with its part of the port, and one line in each list
// below.

export { PLATFORM_ASSET_TOOLS, PLATFORM_ASSET_TOOL_NAMES } from "./platform-asset-tools/names";
export type {
  PlatformCallableOperation,
  PlatformOperationsAudience,
  PlatformOperationsQuery
} from "./platform-asset-tools/operations";
export type { PlatformAssetPut } from "./platform-asset-tools/put";
export { platformAssetWriteRefusal } from "./platform-asset-tools/refusal";

/**
 * What carries the tools out: the asset operations of the instance, on the subject of the
 * conversation the call came from, and those that find what is on the platform. Every method
 * asks the right of the person of `context` as the operation of the API does, and throws its
 * refusal. A conversation without a subject is refused by each method on the subject, except
 * by a read that names an asset and by the call that opens one.
 */
export interface PlatformAssetCalls
  extends
    AppSaveCalls,
    PlatformAssetGetCalls,
    PlatformAssetOpenCalls,
    PlatformAssetPutCalls,
    PlatformAssetValidateCalls,
    PlatformDiscoveryCalls,
    PlatformOperationsCalls,
    SkillSaveApprovalCalls {}

/**
 * The port as the tools hold it. The tools are built before the process has the workflow of
 * its assets, which is bound once it exists. A process that never binds one, such as a worker
 * without the API's asset operations, answers each call as not available there.
 */
export interface PlatformAssetBinding {
  bind(calls: PlatformAssetCalls): void;
  readonly calls: PlatformAssetCalls;
}

export function createPlatformAssetBinding(): PlatformAssetBinding {
  let bound: PlatformAssetCalls | undefined;
  const required = (): PlatformAssetCalls => {
    if (!bound) {
      throw new AppError(
        "CONFLICT",
        "The assets of this platform cannot be read or saved from this process",
        { reason: "asset_tools_unbound" },
        { exposeMessage: true }
      );
    }
    return bound;
  };
  return {
    bind(calls) {
      bound = calls;
    },
    calls: lateBound(required)
  };
}

/**
 * An object whose every method is looked up on `target()` when it is called, so that a method
 * added to the port needs no line here. `then` is none, so the object is never taken for a
 * promise.
 */
function lateBound<T extends object>(target: () => T): T {
  const methods: T = Object.create(null);
  return new Proxy(methods, {
    get: (_methods, key) =>
      typeof key === "string" && key !== "then"
        ? (...args: unknown[]): unknown => {
            const calls = target();
            const method: unknown = Reflect.get(calls, key);
            if (typeof method !== "function") {
              throw new TypeError(`The asset calls have no method '${key}'`);
            }
            return Reflect.apply(method, calls, args);
          }
        : undefined
  });
}

/**
 * The tools that open, read and save an asset. The server offers them to the agent of every
 * conversation, whatever the agent's definition lists.
 */
export function createPlatformAssetTools(calls: PlatformAssetCalls): AnyToolDefinition[] {
  return [
    createOpenAssetTool(calls),
    createGetAssetTool(calls),
    createValidateAssetTool(calls),
    createPutAssetTool(calls),
    createOperationsTool(calls)
  ];
}
