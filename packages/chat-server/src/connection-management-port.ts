import type {
  ConnectionDetail,
  ConnectionTestResult,
  ConnectionTools
} from "@vivd-catalyst/api-contract";
import type { AccessResource, OperationResource } from "@vivd-catalyst/core";

/**
 * What the server asks of the instance's Connections. The assembly brings it where the module
 * `connections` is on. It answers no secret, no handle and no data of an outside system.
 */
export interface ConnectionManagementPort {
  /** What a right on the Connection is decided on. Nothing where no such Connection exists. */
  resource(name: string): Promise<OperationResource | undefined>;
  /** `agents` are the agents the caller may read: the answer names no other. */
  get(
    name: string,
    agents: readonly { name: string; title: string; toolNames: readonly string[] }[]
  ): Promise<ConnectionDetail>;
  /** The type's bounded test, through the one connector context. Writes the health. */
  test(name: string, signal?: AbortSignal): Promise<ConnectionTestResult>;
  /** The tools an agent can carry, of the Connections `readable` admits. */
  listTools(readable: (resource: AccessResource) => boolean): Promise<ConnectionTools>;
}
