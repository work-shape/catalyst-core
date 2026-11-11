import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  completedOutput,
  type ApiClient,
  type ConnectionDetail
} from "@work-shape/catalyst-api-client";
import { EGRESS_DENIED, OWN_SERVER_REFUSALS } from "@work-shape/catalyst-core";
import {
  Badge,
  Button,
  Card,
  Choice,
  ChoiceList,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  Input,
  Section,
  ServiceMark,
  SkeletonList,
  Spinner,
  TextLink
} from "@work-shape/catalyst-ui";
import {
  useOwnOperationSettingsQuery,
  useSetOwnOperationSettingMutation
} from "../../shared/api/operation-settings";
import { useInvalidatePersonalConnections } from "../../shared/api/personal-connections";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { readRefusalDetails } from "./build-refusals";
import {
  takeOwnServerAdd,
  useRequestedOwnServerAdd,
  type OwnServerAddRequest
} from "./own-server-request";
import { ConnectionApprovalList, useApprovalChoice } from "./connection-approval";
import {
  discoveredCandidates,
  operationTitle,
  selectedCandidates,
  type ApprovalCandidate
} from "./connection-approval-model";
import {
  DISCOVERY_WAIT_MS,
  withApprovedOperations,
  withReviewedOperation
} from "./connection-form-model";
import { ownActions, ownSignInOf } from "./connection-people-model";
import { PersonalStateBadge } from "./connection-people";
import {
  SignInActions,
  SignInBody,
  signInHeading,
  useConnectionSignIn,
  type SignInBrowser
} from "./connection-sign-in";
import { offerText } from "./connection-typed-model";
import {
  entryToolStart,
  ownServerAddedMessage,
  ownServerAddressIssue,
  ownServerEntryOf,
  ownServerConfig,
  ownServerHostOf,
  ownServerName,
  ownServerProbeStep,
  ownServerSuffix,
  ownServerTitle,
  ownServerViewOf,
  withKeptOperations,
  type OwnServerAddressIssue,
  type OwnServerEntry,
  type OwnServerProbeStep,
  type OwnServerRow
} from "./own-server-model";
import {
  OwnTokenDialog,
  OwnTokenFields,
  ownTokenIssuesOf,
  saveOwnToken,
  type OwnTokenDraft,
  type OwnTokenIssues
} from "./own-token";

// A person's own MCP server (PMCP-5, connections-and-secrets.md, point 6): the section on You >
// Connections with one card per server, the add dialog and the tools dialog. The person adds
// it alone, in their own session; the instance decides every write, every contact of the
// server and every sign-in. The dialog never sees a sign-in's token: the sign-in runs in another
// tab. A server that takes a pasted token instead (PMCP-6) gets it once, through
// `connections.set_own_secret`; nothing reads it back.

/** Only agents use a self-added server's tools, in the owner's private chats. */
const OWN_SERVER_EXPOSURE = ["agent"] as const;
/** The start's refusal where the server names no sign-in the instance can read. */
const NO_SIGN_IN_FOUND = "oauth_discovery_failed";
/** How often the dialog reads the server again while its tools are read. */
const TOOLS_READ_MS = 1_000;

const ADDRESS_ISSUES: Record<OwnServerAddressIssue, TranslationKey> = {
  empty: "ownServers.addressEmpty",
  invalid: "ownServers.addressInvalid",
  credentials: "ownServers.addressCredentials",
  query: "ownServers.addressQuery"
};

const PROBE_REFUSALS: Record<Exclude<OwnServerProbeStep, "sign_in" | "token">, TranslationKey> = {
  no_sign_in: "ownServers.noSignIn",
  egress: "ownServers.egress",
  unreachable: "ownServers.unreachable"
};

/** The Connection's stored definition and revision, as the owner may read it. */
async function readStored(client: ApiClient, name: string) {
  const asset = await client.assets.get({ params: { kind: "connection", name } });
  return { config: asset.config, revision: asset.revision };
}

/** Waits until the server's tools were read after `before`, or the wait is over. */
async function readToolsSince(
  client: ApiClient,
  name: string,
  before: string | undefined,
  cancelled: () => boolean
): Promise<ConnectionDetail | undefined> {
  const since = Date.now();
  for (;;) {
    const detail = await client.connections.get({ params: { name } }).catch(() => undefined);
    if (cancelled()) return undefined;
    // The server refused the person's token: no tools come, and the token is to be pasted again.
    if (detail?.ownToken?.state === "needs_reconnect") return detail;
    if (detail?.discoveredAt !== undefined && detail.discoveredAt !== before) return detail;
    if (Date.now() - since >= DISCOVERY_WAIT_MS) return detail;
    await new Promise((resolve) => setTimeout(resolve, TOOLS_READ_MS));
  }
}

/** What Fertig added: the server's id and name, and the names of the tools accepted. */
export interface OwnServerAdded {
  name: string;
  title: string;
  tools: string[];
}

/**
 * "Your MCP servers": the person's own servers as cards and the button that adds one, which
 * shows while they may add one. Nothing while they have none and may add none.
 */
export function OwnServersSection({
  rows,
  mayAdd,
  entries = [],
  browser
}: {
  rows: readonly OwnServerRow[];
  mayAdd: boolean;
  /** The catalogue entries the person may add as their own server (PMCP-CAT). */
  entries?: readonly OwnServerEntry[];
  browser?: SignInBrowser;
}) {
  const { t } = useTranslation();
  const { tellConversation } = useSettingsPage();
  const [adding, setAdding] = useState<{ proposed?: OwnServerAddRequest; key: number }>();
  // An agent's proposal from a chat (PMCP-CHAT) opens the add screen filled, once, where the
  // person may add a server; nothing is saved before they press Connect.
  const requested = useRequestedOwnServerAdd();
  useEffect(() => {
    if (requested === undefined) return;
    takeOwnServerAdd(requested);
    if (mayAdd) setAdding((current) => ({ proposed: requested, key: (current?.key ?? 0) + 1 }));
  }, [requested, mayAdd]);
  const proposed = adding?.proposed;
  const from = proposed?.from;
  if (rows.length === 0 && !mayAdd) return null;
  return (
    <Section
      layout="stacked"
      title={t("ownServers.title")}
      description={t("ownServers.description")}
      action={
        mayAdd ? (
          <Button
            size="sm"
            data-own-server-add=""
            onClick={() => setAdding((current) => ({ key: (current?.key ?? 0) + 1 }))}
          >
            {t("ownServers.add")}
          </Button>
        ) : undefined
      }
      data-own-servers=""
    >
      {rows.length === 0 ? (
        <EmptyState layout="inline" data-own-servers-empty="">
          {t("ownServers.empty")}
        </EmptyState>
      ) : (
        <ul className="grid min-w-0 gap-3" aria-label={t("ownServers.title")}>
          {rows.map((row) => (
            <li key={row.name} className="min-w-0">
              <OwnServerCard
                row={row}
                entry={ownServerEntryOf(row, entries)}
                {...(browser ? { browser } : {})}
              />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <OwnServerAddDialog
          key={adding.key}
          onClose={() => setAdding(undefined)}
          entries={entries}
          {...(proposed
            ? {
                initial: {
                  url: proposed.url,
                  title: proposed.title,
                  ...(proposed.entry === undefined ? {} : { entry: proposed.entry })
                }
              }
            : {})}
          {...(from && tellConversation
            ? {
                // The conversation whose agent proposed the server hears once that it is added.
                onAdded: (added: OwnServerAdded) => {
                  tellConversation(from, ownServerAddedMessage(added, t)).catch(() => undefined);
                }
              }
            : {})}
          {...(browser ? { browser } : {})}
        />
      ) : null}
    </Section>
  );
}

/** One own server: name, host, state, its tools, and what its owner does with it. */
function OwnServerCard({
  row,
  entry,
  browser
}: {
  row: OwnServerRow;
  /** The catalogue entry it was added from, while it is still at the entry's host. */
  entry: OwnServerEntry | undefined;
  browser?: SignInBrowser;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const [changing, setChanging] = useState(false);
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [pasting, setPasting] = useState(false);
  const title = row.title.trim() || row.ownServer.host || row.name;
  const view = ownServerViewOf(row);
  const token = row.token;
  const { name } = row;
  const signIn = useConnectionSignIn(
    {
      connection: name,
      start: () => client.connections.oauth_start({ params: { name } }),
      readDetail: async () => ownSignInOf(await client.connections.mine(), name)
    },
    {
      personal: true,
      enabled: false,
      ...(browser ? { browser } : {}),
      onConnected: () => {
        invalidate().catch(() => undefined);
      }
    }
  );
  const connect = view === "off" ? undefined : ownActions(row).connect;
  const tools = row.ownServer.tools;

  /** Ends the person's sign-in, then deletes the server: one confirmation for both. */
  const remove = async () => {
    setRemoving(true);
    setProblem(undefined);
    try {
      if (row.state !== "not_connected" && row.state !== "revoked") {
        // The delete ends what is stored here either way; the provider is told where it can be.
        await client.connections.disconnect({ params: { name } }).catch(() => undefined);
      }
      const { revision } = await readStored(client, name);
      completedOutput(
        await client.assets.delete({
          params: { kind: "connection", name },
          body: { expectedRevision: revision }
        }),
        t("ownServers.removeFailed")
      );
      setAsking(false);
    } catch {
      setProblem(t("ownServers.removeFailed"));
    } finally {
      setRemoving(false);
      await invalidate();
    }
  };

  return (
    <Card padding="md" className="grid min-w-0 gap-3 p-3" data-own-server-card={name}>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <ServiceMark name={title} size="lg" showName={false} {...markProps(entry)} />
        <div className="grid min-w-0 flex-1 basis-48 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-label wrap-anywhere">{title}</span>
            {view === "off" ? (
              <Badge tone="neutral" dot data-own-server-state="off">
                {t("ownServers.stateOff")}
              </Badge>
            ) : (
              <span data-own-server-state={view}>
                <PersonalStateBadge signIn={row} token={token !== undefined} />
              </span>
            )}
          </span>
          <span className="text-caption text-muted-foreground wrap-anywhere">
            {[
              row.ownServer.host,
              tools === 1
                ? t("ownServers.toolCountOne")
                : t("ownServers.toolCount", { count: tools })
            ]
              .filter((part) => part !== "")
              .join(" · ")}
          </span>
          {view === "off" ? (
            <span className="text-caption text-muted-foreground">{t("ownServers.offText")}</span>
          ) : null}
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {signIn.state.phase === "waiting" ? (
            <Button size="sm" variant="outline" data-sign-in-cancel="" onClick={signIn.cancel}>
              {t("connectionSignIn.cancel")}
            </Button>
          ) : token && view !== "off" ? (
            <Button
              size="sm"
              variant={connect === undefined ? "outline" : "primary"}
              data-own-server-replace-token={token.version === undefined ? "set" : "replace"}
              onClick={() => setPasting(true)}
            >
              {t(token.version === undefined ? "ownServers.setToken" : "ownServers.replaceToken")}
            </Button>
          ) : connect ? (
            <Button
              size="sm"
              variant={connect === "connect" ? "primary" : "outline"}
              loading={signIn.busy}
              data-own-server-connect={connect}
              onClick={signIn.connect}
            >
              {t(
                connect === "connect"
                  ? "personalConnections.connect"
                  : "personalConnections.reconnect"
              )}
            </Button>
          ) : null}
          {view === "off" ? null : (
            <Button
              size="sm"
              variant="outline"
              data-own-server-change-tools=""
              onClick={() => setChanging(true)}
            >
              {t("ownServers.changeTools")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            data-own-server-remove=""
            onClick={() => setAsking(true)}
          >
            {t("ownServers.remove")}
          </Button>
        </span>
      </div>
      {signIn.state.phase === "waiting" || signIn.state.phase === "failed" ? (
        <SignInBody signIn={signIn} />
      ) : null}
      {problem ? (
        <FormNotice tone="error" data-own-server-problem="">
          {problem}
        </FormNotice>
      ) : null}
      <ConfirmDialog
        open={asking}
        tone="danger"
        title={t("ownServers.removeTitle", { title })}
        confirmLabel={t("ownServers.remove")}
        loading={removing}
        onConfirm={() => {
          remove().catch(() => undefined);
        }}
        onClose={() => setAsking(false)}
      >
        {t("ownServers.removeText")}
      </ConfirmDialog>
      {changing ? (
        <OwnServerToolsDialog name={name} title={title} onClose={() => setChanging(false)} />
      ) : null}
      {pasting && token ? (
        <OwnTokenDialog
          name={name}
          title={title}
          host={row.ownServer.host || title}
          version={token.version}
          chooseHeader
          onClose={() => setPasting(false)}
        />
      ) : null}
    </Card>
  );
}

type AddStage =
  | { step: "address" }
  | { step: "checking" }
  | { step: "sign-in" }
  | { step: "token" }
  | { step: "reading" }
  | {
      step: "tools";
      candidates: ApprovalCandidate[];
      late: boolean;
      /** Tools the entry says only read that the server does not mark so. */
      entryReads: ReadonlySet<string>;
    };

/**
 * Adds an MCP server: one address and Verbinden, the sign-in in another tab, the tools to
 * choose, and Fertig. It saves at Verbinden, runs the owner's probe and goes on by its answer.
 * A server the probe turns away is deleted again, so a second try starts afresh.
 */
export function OwnServerAddDialog({
  onClose,
  onAdded,
  initial,
  entries = [],
  browser
}: {
  onClose(): void;
  /** Fertig: the server is added with the chosen tools. */
  onAdded?: (added: OwnServerAdded) => void;
  /**
   * What the dialog starts with, such as an agent's proposal in a chat. An `entry` the
   * instance offers starts at its tile, with the entry's address.
   */
  initial?: { url?: string; title?: string; entry?: string };
  /** The catalogue entries offered as tiles above the address (PMCP-CAT). */
  entries?: readonly OwnServerEntry[];
  browser?: SignInBrowser;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { locale, t } = useTranslation();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const [stage, setStage] = useState<AddStage>({ step: "address" });
  const initialEntry = entries.find((candidate) => candidate.id === initial?.entry);
  // A tile chosen: its address is the entry's and cannot be typed over.
  const [entry, setEntry] = useState<OwnServerEntry | undefined>(initialEntry);
  const [address, setAddress] = useState(initialEntry?.url ?? initial?.url ?? "");
  const [title, setTitle] = useState(
    initialEntry ? offerText(initialEntry.title, locale) : (initial?.title ?? "")
  );
  const entryTitle = entry ? offerText(entry.title, locale) : "";
  const entryToken = entry?.signIn === "token" ? entry.token : undefined;
  const [addressError, setAddressError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<OwnTokenDraft>({ token: "", header: "" });
  const [tokenIssues, setTokenIssues] = useState<OwnTokenIssues>({});
  const approval = useApprovalChoice([]);
  const saved = useRef<{ name: string; revision: number; config: Record<string, unknown> }>(
    undefined
  );
  const toolsBefore = useRef<string | undefined>(undefined);
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const host = ownServerHostOf(address);
  const name = saved.current?.name ?? "";

  const signIn = useConnectionSignIn(
    {
      connection: name,
      start: () => client.connections.oauth_start({ params: { name } }),
      readDetail: async () => ownSignInOf(await client.connections.mine(), name)
    },
    {
      personal: true,
      enabled: stage.step === "sign-in",
      ...(browser ? { browser } : {}),
      onConnected: () => {
        readTools().catch(() => enterTools(undefined));
      }
    }
  );

  // A server whose challenge names no sign-in that can be found takes a token: the dialog goes
  // on to it at once, as it does where the probe said so.
  const signInFailure = signIn.state.phase === "failed" ? signIn.state.error.failure : undefined;
  useEffect(() => {
    if (stage.step === "sign-in" && signInFailure === NO_SIGN_IN_FOUND) {
      setStage({ step: "token" });
    }
  }, [stage.step, signInFailure]);

  /** Deletes what Verbinden saved, after the probe turned the server away. */
  const discard = async () => {
    const current = saved.current;
    saved.current = undefined;
    if (!current) return;
    await client.assets
      .delete({
        params: { kind: "connection", name: current.name },
        body: { expectedRevision: current.revision }
      })
      .catch(() => undefined);
  };

  /** Why the save was refused, at the address or under it. */
  const refusalOf = (error: unknown) => {
    const details = readRefusalDetails(error);
    if (details.reason === OWN_SERVER_REFUSALS.limit) {
      return { problem: t("ownServers.limit", { limit: details.limit ?? 0 }) };
    }
    if (details.reason === OWN_SERVER_REFUSALS.off) return { problem: t("ownServers.off") };
    if (
      details.reason === EGRESS_DENIED ||
      details.issues.some((issue) => issue.code === EGRESS_DENIED)
    ) {
      return { address: t("ownServers.egress", { host }) };
    }
    const atAddress = details.issues.find((issue) => issue.path.includes("url"));
    if (atAddress) return { address: t("ownServers.addressInvalid") };
    return { problem: t("ownServers.failed") };
  };

  /** A tile: the entry's address and name, the address locked. */
  const chooseEntry = (chosen: OwnServerEntry) => {
    setEntry(chosen);
    setAddress(chosen.url);
    setTitle(offerText(chosen.title, locale));
    setAddressError(undefined);
    setProblem(undefined);
  };
  /** "Andere Adresse": the free field again, empty. */
  const otherAddress = () => {
    setEntry(undefined);
    setAddress("");
    setTitle("");
    setAddressError(undefined);
    setProblem(undefined);
  };

  const connect = async () => {
    const issue = ownServerAddressIssue(address);
    setProblem(undefined);
    if (issue) {
      setAddressError(t(ADDRESS_ISSUES[issue]));
      return;
    }
    setAddressError(undefined);
    setBusy(true);
    setStage({ step: "checking" });
    const startTitle = title.trim() || ownServerTitle(host);
    setTitle(startTitle);
    const nextName = ownServerName(host, ownServerSuffix());
    const config = ownServerConfig({
      name: nextName,
      url: address,
      title: startTitle,
      ...(entry ? { service: entry.service } : {})
    });
    try {
      const { revision } = completedOutput(
        await client.assets.put({
          params: { kind: "connection", name: nextName },
          body: { config, expectedRevision: null }
        }),
        t("ownServers.failed")
      );
      saved.current = { name: nextName, revision, config };
    } catch (error) {
      const refused = refusalOf(error);
      setAddressError(refused.address);
      setProblem(refused.problem);
      setBusy(false);
      setStage({ step: "address" });
      return;
    }
    // The owner's probe: no credential, only what the server asks for.
    let step: OwnServerProbeStep;
    try {
      const probed = completedOutput(
        await client.connections.test({ params: { name: nextName } }),
        t("ownServers.failed")
      );
      step = ownServerProbeStep(probed.status);
    } catch {
      step = "unreachable";
    }
    // An entry that takes a token goes to it once the host answered and is admitted.
    if (entryToken && (step === "sign_in" || step === "no_sign_in")) step = "token";
    if (step !== "sign_in" && step !== "token") {
      await discard();
      setAddressError(t(PROBE_REFUSALS[step], { host }));
      setBusy(false);
      setStage({ step: "address" });
      return;
    }
    toolsBefore.current = (
      await client.connections.get({ params: { name: nextName } }).catch(() => undefined)
    )?.discoveredAt;
    setBusy(false);
    setStage({ step: step === "token" ? "token" : "sign-in" });
  };

  /**
   * A pasted token instead of a sign-in: how it is sent, then the token once, then the tools
   * read with it. The field is emptied as it is sent; a token the server refuses is asked again.
   */
  const sendToken = async () => {
    const current = saved.current;
    if (!current) return;
    const found = ownTokenIssuesOf(token, entryToken === undefined, t);
    setProblem(undefined);
    if (found) {
      setTokenIssues(found);
      return;
    }
    setTokenIssues({});
    setBusy(true);
    const value = token.token;
    setToken((draft) => ({ ...draft, token: "" }));
    try {
      await saveOwnToken(client, {
        name: current.name,
        token: value,
        // An entry names the header itself; the person chooses it only on a pasted address.
        header: entryToken ? (entryToken.header ?? "") : token.header,
        version: null
      });
      const stored = await readStored(client, current.name);
      saved.current = { name: current.name, revision: stored.revision, config: stored.config };
    } catch {
      setBusy(false);
      setProblem(t("ownServers.tokenFailed"));
      return;
    }
    setBusy(false);
    await readTools();
  };

  /** After the sign-in: the owner's own sign-in reads the tools (CS-9b exception). */
  const readTools = async () => {
    const current = saved.current;
    if (!current) return;
    setStage({ step: "reading" });
    try {
      completedOutput(
        await client.connections.discover({ params: { name: current.name } }),
        t("ownServers.failed")
      );
    } catch {
      enterTools(undefined);
      return;
    }
    const detail = await readToolsSince(
      client,
      current.name,
      toolsBefore.current,
      () => !open.current
    );
    if (!open.current) return;
    if (detail?.ownToken?.state === "needs_reconnect") {
      setTokenIssues({ token: t("ownServers.tokenRefused", { host }) });
      setStage({ step: "token" });
      invalidate().catch(() => undefined);
      return;
    }
    enterTools(detail);
  };

  const enterTools = (detail: ConnectionDetail | undefined) => {
    const candidates = discoveredCandidates(detail?.discovered ?? []);
    // An entry's word on its tools starts the list; the person's choice decides.
    const start = entry ? entryToolStart(candidates, entry.tools) : undefined;
    approval.reset(candidates, start);
    setStage({
      step: "tools",
      candidates,
      late: detail?.discoveredAt === undefined,
      entryReads: start?.entryReads ?? new Set()
    });
    invalidate().catch(() => undefined);
  };

  /** Fertig: the name and the chosen tools in one write, then the tools are read again. */
  const finish = async (candidates: readonly ApprovalCandidate[]) => {
    const current = saved.current;
    if (!current) return;
    const chosen = selectedCandidates(
      candidates,
      approval.choice.selected,
      approval.choice.effects
    );
    const stored = await readStored(client, current.name).catch(() => undefined);
    const base = stored?.config ?? current.config;
    const config = {
      ...withApprovedOperations(base, chosen, OWN_SERVER_EXPOSURE),
      displayName: title.trim() || ownServerTitle(host)
    };
    setBusy(true);
    setProblem(undefined);
    try {
      completedOutput(
        await client.assets.put({
          params: { kind: "connection", name: current.name },
          body: { config, expectedRevision: stored?.revision ?? current.revision }
        }),
        t("ownServers.saveFailed")
      );
    } catch {
      setBusy(false);
      setProblem(t("ownServers.saveFailed"));
      return;
    }
    // Accepted tools are called once a discovery read them under the accepted list.
    if (chosen.length > 0) {
      await client.connections.discover({ params: { name: current.name } }).catch(() => undefined);
    }
    setBusy(false);
    await invalidate();
    onAdded?.({
      name: current.name,
      title: typeof config.displayName === "string" ? config.displayName : current.name,
      tools: chosen.map((candidate) => candidate.title || candidate.name)
    });
    onClose();
  };

  /** Closing keeps a server already saved: its card offers the sign-in and the tools again. */
  const close = () => {
    if (busy) return;
    if (saved.current) invalidate().catch(() => undefined);
    onClose();
  };

  const heading =
    stage.step === "sign-in"
      ? signInHeading(signIn, t)
      : stage.step === "token"
        ? t("ownServers.tokenTitle", { host })
        : t("ownServers.add");

  const body = (() => {
    switch (stage.step) {
      case "address":
      case "checking":
        return (
          <form
            id="own-server-address"
            className="grid min-w-0 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              connect().catch(() => setBusy(false));
            }}
          >
            {entries.length === 0 ? null : (
              <div className="grid min-w-0 gap-2" data-own-server-entries="">
                <ChoiceList label={t("ownServers.entriesLabel")}>
                  {entries.map((candidate) => (
                    <Choice
                      key={candidate.id}
                      title={offerText(candidate.title, locale)}
                      hint={offerText(candidate.description, locale)}
                      chosen={entry?.id === candidate.id}
                      disabled={busy}
                      leading={
                        <ServiceMark
                          name={offerText(candidate.title, locale)}
                          size="md"
                          showName={false}
                          {...markProps(candidate)}
                        />
                      }
                      data-own-server-entry={candidate.id}
                      onClick={() => chooseEntry(candidate)}
                    />
                  ))}
                </ChoiceList>
                {entry ? null : (
                  <p className="text-caption text-muted-foreground">
                    {t("ownServers.entriesHint")}
                  </p>
                )}
              </div>
            )}
            <Field
              label={t("ownServers.addressLabel")}
              hint={
                entry
                  ? t("ownServers.entryAddressHint", { title: entryTitle })
                  : t("ownServers.addressHint")
              }
              error={addressError}
              required
            >
              <Input
                className="font-mono"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("ownServers.addressPlaceholder")}
                value={address}
                disabled={busy}
                readOnly={entry !== undefined}
                data-own-server-field="address"
                onChange={(event) => {
                  if (entry) return;
                  setAddress(event.target.value);
                  setAddressError(undefined);
                }}
              />
            </Field>
            {entry ? (
              <Button
                className="justify-self-start"
                size="sm"
                variant="link"
                disabled={busy}
                data-own-server-other-address=""
                onClick={otherAddress}
              >
                {t("ownServers.otherAddress")}
              </Button>
            ) : null}
            {stage.step === "checking" ? (
              <p
                className="flex items-center gap-2 text-body text-muted-foreground"
                role="status"
                data-own-server-checking=""
              >
                <Spinner size="sm" />
                {t("ownServers.checking", { host })}
              </p>
            ) : null}
          </form>
        );
      case "sign-in":
        return (
          <div className="grid min-w-0 gap-3">
            <SignInBody signIn={signIn} />
            {signIn.state.phase === "waiting" ? null : (
              <Button
                className="justify-self-start"
                size="sm"
                variant="link"
                data-own-server-use-token=""
                onClick={() => {
                  setProblem(undefined);
                  setStage({ step: "token" });
                }}
              >
                {t("ownServers.useToken")}
              </Button>
            )}
          </div>
        );
      case "token":
        return (
          <form
            id="own-server-token"
            className="grid min-w-0 gap-4"
            data-own-server-token=""
            onSubmit={(event) => {
              event.preventDefault();
              sendToken().catch(() => setBusy(false));
            }}
          >
            {entryToken ? (
              <p className="text-body text-muted-foreground" data-own-server-entry-help="">
                {offerText(entryToken.help, locale)}
                {entryToken.link === undefined ? null : (
                  <>
                    {" "}
                    <TextLink
                      href={entryToken.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-own-server-entry-link=""
                    >
                      {t("ownServers.entryTokenLink")}
                    </TextLink>
                  </>
                )}
              </p>
            ) : (
              <p className="text-body text-muted-foreground">
                {t("ownServers.tokenText", { host })}
              </p>
            )}
            <OwnTokenFields
              host={host}
              draft={token}
              onChange={(draft) => {
                setToken(draft);
                setTokenIssues({});
              }}
              chooseHeader={entryToken === undefined}
              issues={tokenIssues}
              disabled={busy}
            />
          </form>
        );
      case "reading":
        return (
          <p
            className="flex items-center gap-2 text-body text-muted-foreground"
            role="status"
            data-own-server-reading=""
          >
            <Spinner size="sm" />
            {t("ownServers.reading")}
          </p>
        );
      case "tools":
        return (
          <div className="grid min-w-0 gap-4" data-own-server-tools="">
            <Field label={t("ownServers.nameLabel")} hint={t("ownServers.nameHint")} required>
              <Input
                value={title}
                disabled={busy}
                data-own-server-field="title"
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            {stage.candidates.length === 0 ? (
              <p className="text-body text-muted-foreground" data-own-server-no-tools="">
                {t(stage.late ? "ownServers.toolsLate" : "ownServers.noTools")}
              </p>
            ) : (
              <>
                <p className="text-body text-muted-foreground">{t("ownServers.toolsText")}</p>
                <OwnServerApprovalList
                  candidates={stage.candidates}
                  approval={approval}
                  disabled={busy}
                  alsoReadable={stage.entryReads}
                  {...(stage.entryReads.size === 0
                    ? {}
                    : {
                        aside: (candidate: ApprovalCandidate) =>
                          stage.entryReads.has(candidate.name) ? (
                            <p
                              className="text-caption text-muted-foreground"
                              data-own-server-entry-reads={candidate.name}
                            >
                              {t("ownServers.entryReads", { title: entryTitle })}
                            </p>
                          ) : null
                      })}
                />
              </>
            )}
          </div>
        );
    }
  })();

  const footer = (() => {
    switch (stage.step) {
      case "address":
      case "checking":
        return (
          <Button
            type="submit"
            form="own-server-address"
            loading={busy}
            disabled={address.trim() === ""}
            data-own-server-connect=""
          >
            {t("ownServers.connect")}
          </Button>
        );
      case "sign-in":
        return <SignInActions signIn={signIn} />;
      case "token":
        return (
          <Button
            type="submit"
            form="own-server-token"
            loading={busy}
            data-own-server-token-save=""
          >
            {t("ownServers.setToken")}
          </Button>
        );
      case "reading":
        return undefined;
      case "tools":
        return (
          <Button
            loading={busy}
            disabled={title.trim() === ""}
            data-own-server-done=""
            onClick={() => {
              finish(stage.candidates).catch(() => setBusy(false));
            }}
          >
            {t("ownServers.done")}
          </Button>
        );
    }
  })();

  return (
    <Dialog open title={heading} onClose={close} footer={footer}>
      <div className="grid min-w-0 gap-4" data-own-server-dialog="">
        {body}
        {problem ? (
          <FormNotice tone="error" data-own-server-problem="">
            {problem}
          </FormNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The approval list of a self-added server: agents alone use its tools, a tool the server does
 * not mark read-only stays `ändert`, and one it marks so may be marked `ändert` too.
 */
function OwnServerApprovalList({
  candidates,
  approval,
  disabled,
  aside,
  alsoReadable
}: {
  candidates: readonly ApprovalCandidate[];
  approval: ReturnType<typeof useApprovalChoice>;
  disabled: boolean;
  aside?: Parameters<typeof ConnectionApprovalList>[0]["aside"];
  /** Tools the person may also mark `liest`: those a catalogue entry says only read. */
  alsoReadable?: ReadonlySet<string>;
}) {
  const proposedReading = new Set([
    ...candidates
      .filter((candidate) => candidate.effect === "reading")
      .map((candidate) => candidate.name),
    ...(alsoReadable ?? [])
  ]);
  return (
    <ConnectionApprovalList
      candidates={candidates}
      choice={approval.choice}
      onSelectedChange={approval.setSelected}
      onSurfacesChange={approval.setSurfaces}
      onEffectsChange={approval.setEffects}
      mayRead={(name) => proposedReading.has(name)}
      surfaces={[]}
      disabled={disabled}
      {...(aside ? { aside } : {})}
    />
  );
}

/**
 * "Tools ändern": the server's tools to accept or leave, the new description of one the server
 * changed to accept, and at a changing tool the owner always allows, "Immer erlauben" with
 * "Wieder fragen". Saved in one write; the tools are then read again.
 */
function OwnServerToolsDialog({
  name,
  title,
  onClose
}: {
  name: string;
  title: string;
  onClose(): void;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const detailKey = ["own-server-detail", apiBaseUrl, authScope, name];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => client.connections.get({ params: { name }, signal }),
    retry: false
  });
  const settings = useOwnOperationSettingsQuery({ apiBaseUrl, authScope, client });
  const setSetting = useSetOwnOperationSettingMutation({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("ownServers.saveFailed")
  });
  const approval = useApprovalChoice([]);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string>();
  const started = useRef<string | undefined>(undefined);

  const accepted = detail.data?.operations ?? [];
  const candidates: ApprovalCandidate[] = [
    ...accepted.map((operation) => ({
      name: operation.name,
      title: operationTitle(operation.name),
      ...(operation.description === undefined ? {} : { description: operation.description }),
      effect: operation.effect
    })),
    ...discoveredCandidates(detail.data?.discovered ?? [])
  ];
  // The list starts with what is accepted, once per reading of the server.
  const readAt = detail.data ? `${detail.data.discoveredAt ?? ""}:${accepted.length}` : undefined;
  const acceptedNow = useRef(accepted);
  acceptedNow.current = accepted;
  const { setSelected, setEffects } = approval;
  useEffect(() => {
    if (readAt === undefined || started.current === readAt) return;
    started.current = readAt;
    setEffects(new Map());
    setSelected(new Set(acceptedNow.current.map((operation) => operation.name)));
  }, [readAt, setSelected, setEffects]);

  const alwaysAllowed = new Set(
    (settings.data?.items ?? [])
      .filter((item) => item.value === "always_allow")
      .map((item) => item.operation)
  );
  const toolNameOf = new Map(accepted.map((operation) => [operation.name, operation.toolName]));

  const readAgain = async () => {
    setReading(true);
    setProblem(undefined);
    try {
      const before = detail.data?.discoveredAt;
      completedOutput(await client.connections.discover({ params: { name } }));
      await readToolsSince(client, name, before, () => false);
      await queryClient.invalidateQueries({ queryKey: detailKey });
    } catch {
      setProblem(t("ownServers.loadFailed"));
    } finally {
      setReading(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const stored = await readStored(client, name);
      const kept = new Set(approval.choice.selected);
      const acceptedNames = new Set(accepted.map((operation) => operation.name));
      // What stays accepted keeps its stored entry with the effect chosen here; a changed one
      // takes its new description only where the owner accepted it here.
      let config = withKeptOperations(stored.config, kept, approval.choice.effects);
      for (const operation of accepted) {
        if (
          reviewed.has(operation.name) &&
          operation.discoveredFingerprint &&
          kept.has(operation.name)
        ) {
          config = withReviewedOperation(config, operation.name, operation.discoveredFingerprint);
        }
      }
      const added = selectedCandidates(
        candidates.filter((candidate) => !acceptedNames.has(candidate.name)),
        approval.choice.selected,
        approval.choice.effects
      );
      config = withApprovedOperations(config, added, OWN_SERVER_EXPOSURE);
      completedOutput(
        await client.assets.put({
          params: { kind: "connection", name },
          body: { config, expectedRevision: stored.revision }
        }),
        t("ownServers.saveFailed")
      );
      if (added.length > 0 || reviewed.size > 0) {
        await client.connections.discover({ params: { name } }).catch(() => undefined);
      }
      await invalidate();
      onClose();
    } catch {
      setProblem(t("ownServers.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  const aside = (candidate: ApprovalCandidate) => {
    const operation = accepted.find((entry) => entry.name === candidate.name);
    if (!operation) return null;
    const toolName = toolNameOf.get(operation.name) ?? "";
    return (
      <span className="mt-2 flex flex-wrap items-center gap-2">
        {operation.status === "needs_review" && operation.discoveredFingerprint ? (
          reviewed.has(operation.name) ? (
            <Badge tone="neutral">{t("connections.acceptNewDescription")}</Badge>
          ) : (
            <>
              <Badge tone="warning" data-own-server-changed={operation.name}>
                {t("connections.statusNeedsReview")}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-own-server-review={operation.name}
                onClick={() => setReviewed(new Set([...reviewed, operation.name]))}
              >
                {t("connections.acceptNewDescription")}
              </Button>
            </>
          )
        ) : null}
        {alwaysAllowed.has(toolName) ? (
          <>
            <Badge tone="info" data-own-server-always-allowed={operation.name}>
              {t("confirm.alwaysAllow")}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              loading={setSetting.isPending && setSetting.variables?.operation === toolName}
              data-own-server-ask-again={operation.name}
              onClick={() => {
                setProblem(undefined);
                setSetting
                  .mutateAsync({ operation: toolName, value: null })
                  .catch(() => setProblem(t("ownServers.saveFailed")));
              }}
            >
              {t("ownServers.askAgain")}
            </Button>
          </>
        ) : null}
      </span>
    );
  };

  return (
    <Dialog
      open
      size="lg"
      title={t("ownServers.toolsTitle", { title })}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button
            variant="outline"
            loading={reading}
            disabled={busy || detail.isPending}
            data-own-server-read-again=""
            onClick={() => {
              readAgain().catch(() => setReading(false));
            }}
          >
            {t("ownServers.readAgain")}
          </Button>
          <Button
            loading={busy}
            disabled={detail.data === undefined || reading}
            data-own-server-save=""
            onClick={() => {
              save().catch(() => setBusy(false));
            }}
          >
            {t("ownServers.save")}
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-4" data-own-server-tools-dialog="">
        {detail.isPending ? (
          <SkeletonList rows={3} />
        ) : detail.isError ? (
          <InlineError>{t("ownServers.loadFailed")}</InlineError>
        ) : candidates.length === 0 ? (
          <p className="text-body text-muted-foreground">{t("ownServers.noTools")}</p>
        ) : (
          <>
            <p className="text-body text-muted-foreground">{t("ownServers.toolsText")}</p>
            <OwnServerApprovalList
              candidates={candidates}
              approval={approval}
              disabled={busy || reading}
              aside={aside}
            />
          </>
        )}
        {problem ? (
          <FormNotice tone="error" data-own-server-problem="">
            {problem}
          </FormNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The mark of a catalogue entry for a service mark: its logo, or its colour. */
function markProps(
  entry: Pick<OwnServerEntry, "mark"> | undefined
): { logo: string } | { color: string } | Record<never, never> {
  if (entry?.mark.logo !== undefined) return { logo: entry.mark.logo };
  if (entry?.mark.color !== undefined) return { color: entry.mark.color };
  return {};
}
