import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConnectionDetail, ConnectionTestResult } from "@vivd-catalyst/api-client";
import { usePlatformContextQuery } from "../api/workspace-queries";
import { useSettingsPage } from "../settings/settings-page-context";
import { apiErrorCode } from "../workspace-utils";
import { instanceSentence, PendingApprovalError } from "./build-refusals";

/** The action that lets a person test a Connection. */
const CONNECTION_WRITE_ACTION = "connection.write";

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

/**
 * Everything the Connection page reads and does beyond the asset the frame hands it. The page
 * is handed this and reads nothing else, so a test hands it answers of its own. Nothing here
 * holds a credential.
 */
export interface ConnectionSource {
  /** The reader may test the Connection: the page offers the button. The instance decides the call. */
  mayTest(connection: { namespace?: string }): boolean;
  /** A hook: the Connection's state, read when the page opens and again after a test. */
  useDetail(name: string): ConnectionDetailRead;
  /** A hook: the test of this page. */
  useTest(name: string): { run: ConnectionTestRun; start(): void };
}

/**
 * The Connection page on the instance: `connections.get` answers the state and
 * `connections.test` runs the test.
 */
export function useConnectionSource(): ConnectionSource {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const calls = client.connections;
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
    useDetail(name) {
      const query = useQuery({
        queryKey: detailKey(name),
        queryFn: ({ signal }) => calls.get({ params: { name }, signal }),
        retry: false
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
