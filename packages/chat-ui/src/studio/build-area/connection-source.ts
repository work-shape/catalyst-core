import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type {
  ConnectionDetail,
  ConnectionOAuthStart,
  ConnectionPersonContext,
  ConnectionTestResult
} from "@work-shape/catalyst-api-client";
import { loadFailure } from "../../admin/access/access-model";
import { useAssetGrantsQuery } from "../../admin/access/access-queries";
import {
  principalHref,
  resourceHolders,
  type ResourceHolder
} from "../../admin/access/principal-grants-model";
import {
  usePlatformContextQuery,
  useServicePrincipalsQuery,
  useWorkspaceUsersQuery
} from "../../shared/api/workspace-queries";
import { invalidateOfferedAgents } from "../../shared/api/agent-placement-mutations";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { AGENTS_BUILD_PATH, useOptionalBuildNavigation } from "../../shared/build-route";
import { canManageServicePrincipals, canManageUsers } from "../../shared/governance";
import { workspaceRoutePath } from "../../shared/routes";
import { useSettingsPage } from "../../shared/settings-page-context";
import { apiErrorCode } from "../../shared/workspace-utils";
import { instanceSentence, PendingApprovalError } from "./build-refusals";
import { waitsForDiscovery, type DiscoveryWait } from "./connection-form-model";
import { useAvailabilityChoice, type AvailabilityFrame } from "./asset-availability";
import type { CatalogueEntryOffer } from "./connection-catalogue-model";
import type { AvailabilityChoice } from "./asset-availability-fields";
import { connectionGiveSource } from "./connection-give";
import type { ConnectionGiveHost } from "./connection-give-step";
import type { ConnectorTypeOffer } from "./connection-typed-model";

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

/** Whom a person context mapping is for: a person or a service principal, by id. */
export interface PersonContextSubject {
  kind: ConnectionPersonContext["subjectKind"];
  id: string;
}

/** One person context mapping, as the page asked for it. */
export type PersonContextRead =
  | { status: "loading" }
  /** The read failed. The sentence is the instance's own, where it sent one. */
  | { status: "failed"; message: string | undefined; retry(): void }
  /** Without `value` nobody mapped the subject: calls for them are refused. */
  | { status: "ready"; value: string | undefined; rowVersion: number | null };

/** A person or service principal the page offers for a mapping, by name. */
interface PersonContextSubjectOption {
  id: string;
  label: string;
  /** One line under the name: a person's email, a principal's description. */
  description?: string;
}

/** The people or service principals a mapping can be chosen for. */
type PersonContextSubjectsRead =
  /** The reader may not list them: the page says so and offers the id behind a disclosure. */
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "failed"; retry(): void }
  | { status: "ready"; subjects: PersonContextSubjectOption[] };

/** The instance refused a mapping write: somebody changed the mapping since the page read it. */
export class PersonContextConflictError extends Error {
  constructor() {
    super("The person context mapping changed since it was read");
    this.name = "PersonContextConflictError";
  }
}

/** How often the page asks again for the tools of a discovery it waits for. */
const DISCOVERY_POLL_MS = 2_000;

/**
 * Everything the Connection page reads and does beyond the asset the frame hands it. The page
 * is handed this and reads nothing else, so a test hands it answers of its own. Nothing here
 * holds a credential.
 */
export interface ConnectionSource {
  /** The reader may test the Connection: the page offers the button. The instance decides the call. */
  mayTest(connection: { allowed?: readonly string[] }): boolean;
  /**
   * A hook: the Connection's state, read when the page opens and again after a test. While the
   * page waits for a discovery it is read again every few seconds, until the discovery is in.
   */
  useDetail(name: string, wait?: DiscoveryWait): ConnectionDetailRead;
  /**
   * Enters the Connection's secret, as the next version after `expectedVersion`, for the
   * Connection at `expectedRevision`: one changed since is refused. The value goes to the
   * instance and is kept nowhere here. The page reads the Connection again afterwards.
   */
  setSecret(
    name: string,
    value: string,
    expectedVersion: number | null,
    expectedRevision: number
  ): Promise<void>;
  /** Asks the instance to read the Connection's tools again. Throws `PendingApprovalError` when held. */
  discover(name: string): Promise<void>;
  /**
   * A hook: the Connector types the build offers with a form of their own, for the New
   * connection dialog. Nothing until they are read; a failed read offers none.
   */
  useConnectorTypes?(): readonly ConnectorTypeOffer[] | undefined;
  /**
   * A hook: the catalogue's entries, for the "Dienste" group of the New connection dialog,
   * read with the Connector types. Nothing until they are read; a failed read offers none.
   */
  useCatalogueEntries?(): readonly CatalogueEntryOffer[] | undefined;
  /** Reads the Connection's state now, beside the hook, as the New connection dialog waits. */
  readDetail(name: string): Promise<ConnectionDetail>;
  /** Tests the Connection. Throws `PendingApprovalError` when somebody approves the test first. */
  test(name: string): Promise<ConnectionTestResult>;
  /**
   * Starts the shared OAuth sign-in of the Connection: the address of the provider's page, its
   * host and the permissions asked for. The address is opened and kept nowhere here.
   */
  oauthStart(name: string): Promise<ConnectionOAuthStart>;
  /** A hook: the name of a person by id, where the reader is shown people. */
  usePersonName?(userId: string | undefined): string | undefined;
  /**
   * A hook: where agents can use it, for a reader who may change what belongs to the whole
   * instance. Absent where the page offers no availability.
   */
  useAvailability?(frame: AvailabilityFrame): AvailabilityChoice | undefined;
  /**
   * Opens the chat dock beside the page with a new conversation and this request in its
   * composer, to send or change. Absent where the page has no dock.
   */
  draftInChat?: (request: string) => void;
  /**
   * Sends `text` to a conversation as the person's own message, queued behind a run that goes
   * (CHAT-CONN-1): how the dialog a proposal opened says the Connection is connected. Absent
   * where the page has no chat.
   */
  tellConversation?: (
    to: { conversationId: string; agentName?: string },
    text: string
  ) => Promise<void>;
  /** A hook: the test of this page. */
  useTest(name: string): { run: ConnectionTestRun; start(): void };
  /**
   * Gives the approved tools to an agent after "Freigeben" (CS-5d). Absent where the place
   * offers no give: the done state then has no line for it.
   */
  give?: ConnectionGiveHost;
  /**
   * A hook: the people and service principals with a right to use this one Connection. A
   * service principal is among them for a reader who is shown service principals.
   */
  useHolders(assetId: string): ConnectionHoldersRead;
  /** Where a service principal is read. */
  principalHref(principalId: string): string;
  /**
   * The person context mappings of a Connection that sends one, for a reader who may change the
   * Connection. Absent where the page offers no mappings.
   */
  personContext?: {
    /** A hook: every person or every service principal the reader may list, by name. */
    useSubjects(kind: PersonContextSubject["kind"]): PersonContextSubjectsRead;
    /** A hook: the mapping of one subject, read when the subject is chosen and after each write. */
    useMapping(name: string, subject: PersonContextSubject): PersonContextRead;
    /**
     * Maps the subject to `value`, or removes the mapping with `null`, against the row version
     * the page read. Throws `PersonContextConflictError` when the mapping changed meanwhile. The
     * page reads the mapping again afterwards.
     */
    setMapping(
      name: string,
      subject: PersonContextSubject,
      value: string | null,
      expectedRowVersion: number | null
    ): Promise<void>;
  };
}

/**
 * The Connection page on the instance: `connections.get` answers the state and
 * `connections.test` runs the test.
 */
export function useConnectionSource(): ConnectionSource {
  const { apiBaseUrl, authScope, client, user, startDockedChat, tellConversation } =
    useSettingsPage();
  const api = { apiBaseUrl, authScope, client };
  const calls = client.connections;
  // The rows are read by who manages users; the names of principals by who manages them.
  const seesHolders = canManageUsers(user);
  const queryClient = useQueryClient();
  const context = usePlatformContextQuery({ apiBaseUrl, authScope, client, enabled: true });
  const seesPrincipals = seesHolders && canManageServicePrincipals(context.data);
  const detailKey = (name: string) => ["connection-detail", apiBaseUrl, authScope, name];
  const navigation = useOptionalBuildNavigation();
  const giveSource = useMemo(() => connectionGiveSource(client), [client]);
  const give: ConnectionGiveHost = {
    source: giveSource,
    viewerId: user.id,
    ...(navigation
      ? { openAgent: (name: string) => navigation.open({ kindPath: AGENTS_BUILD_PATH, name }) }
      : {}),
    given: () => {
      // The agent's page, its draft and the lists of offered agents read what was published.
      queryClient
        .invalidateQueries({ queryKey: workspaceQueryKeys.assets(apiBaseUrl, authScope) })
        .catch(() => undefined);
      invalidateOfferedAgents(queryClient, apiBaseUrl, authScope).catch(() => undefined);
    }
  };
  // One read of the Connector types and the catalogue's entries. Offered to whoever may make a
  // Connection; nobody else asks.
  const useConnectorTypeOffers = () =>
    useQuery({
      queryKey: ["connector-types", apiBaseUrl, authScope],
      queryFn: ({ signal }) => calls.connector_types({ signal }),
      enabled: context.data?.actions.includes(CONNECTION_WRITE_ACTION) ?? false,
      retry: false,
      staleTime: Infinity
    });
  const personContextKey = (name: string, subject: PersonContextSubject) => [
    "connection-person-context",
    apiBaseUrl,
    authScope,
    name,
    subject.kind,
    subject.id
  ];
  return {
    give,
    useAvailability: (frame) => useAvailabilityChoice(frame, "connection"),
    // The right is held on every Connection of the instance, or on this one as the instance
    // says with its record.
    mayTest: ({ allowed }) =>
      (context.data?.actions.includes(CONNECTION_WRITE_ACTION) ?? false) ||
      (allowed?.includes("write") ?? false),
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
      // A write starts a new wait: the Connection is read again at once, so what the write
      // changed shows before the next poll.
      const since = wait?.since;
      const waited = useRef(since);
      const { refetch } = query;
      useEffect(() => {
        if (since === waited.current) return;
        waited.current = since;
        refetch().catch(() => undefined);
      }, [since, refetch]);
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
    async setSecret(name, value, expectedVersion, expectedRevision) {
      try {
        await calls.set_secret({
          params: { name },
          body: { value, expectedVersion, expectedRevision }
        });
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
    useConnectorTypes() {
      const query = useConnectorTypeOffers();
      return query.isError ? [] : query.data?.types;
    },
    useCatalogueEntries() {
      const query = useConnectorTypeOffers();
      return query.isError ? [] : query.data?.entries;
    },
    async oauthStart(name) {
      try {
        return await calls.oauth_start({ params: { name } });
      } finally {
        // A start may write the registered client: the page reads the Connection again.
        await queryClient.invalidateQueries({ queryKey: detailKey(name) });
      }
    },
    usePersonName(userId) {
      const users = useWorkspaceUsersQuery({
        ...api,
        enabled: seesHolders && userId !== undefined
      });
      return userId === undefined
        ? undefined
        : users.data?.find((user) => user.id === userId)?.displayLabel;
    },
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
    personContext: {
      useSubjects(kind) {
        // Both lists read every page: an instance has as many people as it has.
        const users = useWorkspaceUsersQuery({ ...api, enabled: seesHolders && kind === "user" });
        const principals = useServicePrincipalsQuery({
          ...api,
          enabled: seesPrincipals && kind === "service_principal"
        });
        const query = kind === "user" ? users : principals;
        const failure = loadFailure(query.error);
        if (!(kind === "user" ? seesHolders : seesPrincipals) || failure === "forbidden") {
          return { status: "hidden" };
        }
        if (kind === "user" && users.data) {
          return {
            status: "ready",
            subjects: users.data.map((user) => ({
              id: user.id,
              label: user.displayLabel,
              description: user.email
            }))
          };
        }
        if (kind === "service_principal" && principals.data) {
          return {
            status: "ready",
            subjects: principals.data.map(({ principal }) => ({
              id: principal.id,
              label: principal.displayLabel,
              ...(principal.description ? { description: principal.description } : {})
            }))
          };
        }
        return failure === "failed" && !query.isFetching
          ? { status: "failed", retry: () => void query.refetch().catch(() => undefined) }
          : { status: "loading" };
      },
      useMapping(name, subject) {
        const query = useQuery({
          queryKey: personContextKey(name, subject),
          queryFn: ({ signal }) =>
            calls.person_context({
              params: { name },
              query: { subjectKind: subject.kind, subjectId: subject.id },
              signal
            }),
          retry: false
        });
        if (query.data) {
          return { status: "ready", value: query.data.value, rowVersion: query.data.rowVersion };
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
      async setMapping(name, subject, value, expectedRowVersion) {
        try {
          await calls.set_person_context({
            params: { name },
            body: { subjectKind: subject.kind, subjectId: subject.id, value, expectedRowVersion }
          });
        } catch (error) {
          throw apiErrorCode(error) === "CONFLICT" ? new PersonContextConflictError() : error;
        } finally {
          await queryClient.invalidateQueries({ queryKey: personContextKey(name, subject) });
        }
      }
    },
    ...(startDockedChat ? { draftInChat: startDockedChat } : {}),
    ...(tellConversation ? { tellConversation } : {}),
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
