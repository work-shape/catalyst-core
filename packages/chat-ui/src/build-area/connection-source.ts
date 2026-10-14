import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionDetail, ConnectionTestResult } from "@vivd-catalyst/api-client";
import { loadFailure } from "../access/access-model";
import { useAssetGrantsQuery } from "../access/access-queries";
import {
  principalHref,
  resourceHolders,
  type ResourceHolder
} from "../access/principal-grants-model";
import {
  usePlatformContextQuery,
  useServicePrincipalsQuery,
  useWorkspaceUsersQuery
} from "../api/workspace-queries";
import { canManageApiAccess, canManageUsers } from "../control-plane/governance";
import { workspaceRoutePath } from "../routes";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorCode } from "../workspace-utils";
import { instanceSentence, PendingApprovalError } from "./build-refusals";
import { waitsForDiscovery, type DiscoveryWait } from "./connection-form-model";

/** The action that lets a person test a Connection. */
const CONNECTION_WRITE_ACTION = "connection.write";

/** The action that lets a person or a service principal call a Connection's operations. */
const CONNECTION_USE_ACTION = "connection.use";

/** Who was given one Connection by itself, as its page asked for it. */
export type ConnectionHoldersRead =
  /** The reader is not shown who holds rights: the page has no such section. */
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "failed"; retry(): void }
  | { status: "ready"; holders: ResourceHolder[] };

/** What the instance says of one Connection beyond its revision, as its page asked for it. */
export type ConnectionDetailRead =
  | { status: "loading" }
  /** The read failed. The sentence is the instance's own, where it sent one. */
  | { status: "failed"; message: string | undefined; retry(): void }
  | { status: "ready"; detail: ConnectionDetail };

/** One test of a Connection, from the click to its answer. */
export type ConnectionTestRun =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: ConnectionTestResult }
  /** The instance answered that this person may not test the Connection. */
  | { status: "refused" }
  /** The instance accepted the test and did not run it: somebody else approves it first. */
  | { status: "held" }
  | { status: "failed"; message: string | undefined };

/** How often the page asks again for the tools of a discovery it waits for. */
const DISCOVERY_POLL_MS = 2_000;

/**
 * Everything the Connection page reads and does beyond the asset the frame hands it. The page
 * is handed this and reads nothing else, so a test hands it answers of its own. Nothing here
 * holds a credential.
 */
export interface ConnectionSource {
  /** The reader may test the Connection: the page offers the button. The instance decides the call. */
  mayTest(connection: { namespace?: string }): boolean;
  /**
   * A hook: the Connection's state, read when the page opens and again after a test. While the
   * page waits for a discovery it is read again every few seconds, until the discovery is in.
   */
  useDetail(name: string, wait?: DiscoveryWait): ConnectionDetailRead;
  /**
   * Enters the Connection's secret, as the next version after `expectedVersion`. The value goes
   * to the instance and is kept nowhere here. The page reads the Connection again afterwards.
   */
  setSecret(name: string, value: string, expectedVersion: number | null): Promise<void>;
  /** Asks the instance to read the Connection's tools again. Throws `PendingApprovalError` when held. */
  discover(name: string): Promise<void>;
  /** Reads the Connection's state now, beside the hook, as the New connection dialog waits. */
  readDetail(name: string): Promise<ConnectionDetail>;
  /** Tests the Connection. Throws `PendingApprovalError` when somebody approves the test first. */
  test(name: string): Promise<ConnectionTestResult>;
  /**
   * Opens the chat dock beside the page with a new conversation and this request in its
   * composer, to send or change. Absent where the page has no dock.
   */
  draftInChat?: (request: string) => void;
  /** A hook: the test of this page. */
  useTest(name: string): { run: ConnectionTestRun; start(): void };
  /**
   * A hook: the people and service principals with a right to use this one Connection. A
   * service principal is among them for a reader who is shown service principals.
   */
  useHolders(assetId: string): ConnectionHoldersRead;
  /** Where a service principal is read. */
  principalHref(principalId: string): string;
}

/**
 * The Connection page on the instance: `connections.get` answers the state and
 * `connections.test` runs the test.
 */
export function useConnectionSource(): ConnectionSource {
  const { apiBaseUrl, authScope, client, user, startDockedChat } = useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const calls = client.connections;
  // The rows are read by who manages users; the names of principals by who manages API access.
  const seesHolders = canManageUsers(user);
  const seesPrincipals = seesHolders && canManageApiAccess(user);
  const queryClient = useQueryClient();
  const context = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const detailKey = (name: string) => ["connection-detail", apiBaseUrl, authScope, name];
  return {
    // The right is held on every Connection of the instance or in the Connection's Namespace.
    mayTest: ({ namespace }) =>
      (context.data?.actions.includes(CONNECTION_WRITE_ACTION) ?? false) ||
      (namespace !== undefined &&
        (context.data?.namespaces.some(
          (held) => held.prefix === namespace && held.actions.includes(CONNECTION_WRITE_ACTION)
        ) ??
          false)),
    useDetail(name, wait) {
      const query = useQuery({
        queryKey: detailKey(name),
        queryFn: ({ signal }) => calls.get({ params: { name }, signal }),
        retry: false,
        refetchInterval: ({ state }) =>
          wait && state.data && waitsForDiscovery(wait, state.data, Date.now())
            ? DISCOVERY_POLL_MS
            : false
      });
      // What was read stays while it is read again: the page does not blink after a test.
      if (query.data) {
        return { status: "ready", detail: query.data };
      }
      if (query.error && !query.isFetching) {
        return {
          status: "failed",
          message: instanceSentence(query.error),
          retry: () => void query.refetch().catch(() => undefined)
        };
      }
      return { status: "loading" };
    },
    useHolders(assetId) {
      const grants = useAssetGrantsQuery({
        ...api,
        assetId,
        action: CONNECTION_USE_ACTION,
        enabled: seesHolders
      });
      const users = useWorkspaceUsersQuery({ ...api, enabled: seesHolders });
      const principals = useServicePrincipalsQuery({ ...api, enabled: seesPrincipals });
      const failure = loadFailure(grants.error);
      if (!seesHolders || failure === "forbidden") {
        return { status: "hidden" };
      }
      if (grants.data) {
        return {
          status: "ready",
          holders: resourceHolders(grants.data, {
            action: CONNECTION_USE_ACTION,
            users: users.data ?? [],
            principals: principals.data ?? []
          })
        };
      }
      return failure === "failed" && !grants.isFetching
        ? { status: "failed", retry: () => void grants.refetch().catch(() => undefined) }
        : { status: "loading" };
    },
    async setSecret(name, value, expectedVersion) {
      try {
        await calls.set_secret({ params: { name }, body: { value, expectedVersion } });
      } finally {
        await queryClient.invalidateQueries({ queryKey: detailKey(name) });
      }
    },
    async discover(name) {
      const outcome = await calls.discover({ params: { name } });
      if (outcome.status !== "done") {
        throw new PendingApprovalError();
      }
      await queryClient.invalidateQueries({ queryKey: detailKey(name) });
    },
    readDetail: (name) => calls.get({ params: { name } }),
    async test(name) {
      try {
        const outcome = await calls.test({ params: { name } });
        if (outcome.status !== "done") {
          throw new PendingApprovalError();
        }
        return outcome.output;
      } finally {
        await queryClient.invalidateQueries({ queryKey: detailKey(name) });
      }
    },
    ...(startDockedChat ? { draftInChat: startDockedChat } : {}),
    principalHref: (principalId) =>
      principalHref(
        workspaceRoutePath({ kind: "settings", group: "instance", page: "api-access" }),
        principalId
      ),
    useTest(name) {
      const test = useMutation({
        mutationFn: async () => {
          const outcome = await calls.test({ params: { name } });
          if (outcome.status !== "done") {
            throw new PendingApprovalError();
          }
          return outcome.output;
        },
        // The test wrote the Connection's health: the page reads it again, also after a refusal.
        onSettled: () => queryClient.invalidateQueries({ queryKey: detailKey(name) })
      });
      const run: ConnectionTestRun = test.isPending
        ? { status: "running" }
        : test.data
          ? { status: "done", result: test.data }
          : test.error
            ? test.error instanceof PendingApprovalError
              ? { status: "held" }
              : apiErrorCode(test.error) === "FORBIDDEN"
                ? { status: "refused" }
                : { status: "failed", message: instanceSentence(test.error) }
            : { status: "idle" };
      return { run, start: () => test.mutate() };
    }
  };
}
