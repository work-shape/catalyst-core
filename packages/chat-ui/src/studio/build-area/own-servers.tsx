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
  Spinner
} from "@work-shape/catalyst-ui";
import {
  useOwnOperationSettingsQuery,
  useSetOwnOperationSettingMutation
} from "../../shared/api/operation-settings";
import { useInvalidatePersonalConnections } from "../../shared/api/personal-connections";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { readRefusalDetails } from "./build-refusals";
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
import {
  ownServerAddressIssue,
  ownServerConfig,
  ownServerHostOf,
  ownServerName,
  ownServerProbeStep,
  ownServerSuffix,
  ownServerTitle,
  ownServerViewOf,
  withKeptOperations,
  type OwnServerAddressIssue,
  type OwnServerProbeStep,
  type OwnServerRow
} from "./own-server-model";

// A person's own MCP server (PMCP-5, connections-and-secrets.md, point 6): the section on You >
// Connections with one card per server, the add dialog and the tools dialog. The person adds
// it alone, in their own session; the instance decides every write, every contact of the
// server and every sign-in. The dialog never sees a token: the sign-in runs in another tab.

/** Only agents use a self-added server's tools, in the owner's private chats. */
const OWN_SERVER_EXPOSURE = ["agent"] as const;
/** How often the dialog reads the server again while its tools are read. */
const TOOLS_READ_MS = 1_000;

const ADDRESS_ISSUES: Record<OwnServerAddressIssue, TranslationKey> = {
  empty: "ownServers.addressEmpty",
  invalid: "ownServers.addressInvalid",
  credentials: "ownServers.addressCredentials",
  query: "ownServers.addressQuery"
};

const PROBE_REFUSALS: Record<Exclude<OwnServerProbeStep, "sign_in">, TranslationKey> = {
  no_sign_in: "ownServers.noSignIn",
  token: "ownServers.tokenRequired",
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
    if (detail?.discoveredAt !== undefined && detail.discoveredAt !== before) return detail;
    if (Date.now() - since >= DISCOVERY_WAIT_MS) return detail;
    await new Promise((resolve) => setTimeout(resolve, TOOLS_READ_MS));
  }
}

/**
 * "Your MCP servers": the person's own servers as cards and the button that adds one, which
 * shows while they may add one. Nothing while they have none and may add none.
 */
export function OwnServersSection({
  rows,
  mayAdd,
  browser
}: {
  rows: readonly OwnServerRow[];
  mayAdd: boolean;
  browser?: SignInBrowser;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  if (rows.length === 0 && !mayAdd) return null;
  return (
    <Section
      layout="stacked"
      title={t("ownServers.title")}
      description={t("ownServers.description")}
      action={
        mayAdd ? (
          <Button size="sm" data-own-server-add="" onClick={() => setAdding(true)}>
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
              <OwnServerCard row={row} {...(browser ? { browser } : {})} />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <OwnServerAddDialog onClose={() => setAdding(false)} {...(browser ? { browser } : {})} />
      ) : null}
    </Section>
  );
}

/** One own server: name, host, state, its tools, and what its owner does with it. */
function OwnServerCard({ row, browser }: { row: OwnServerRow; browser?: SignInBrowser }) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const [changing, setChanging] = useState(false);
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const title = row.title.trim() || row.ownServer.host || row.name;
  const view = ownServerViewOf(row);
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
        <ServiceMark name={title} size="lg" showName={false} />
        <div className="grid min-w-0 flex-1 basis-48 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-label wrap-anywhere">{title}</span>
            {view === "off" ? (
              <Badge tone="neutral" dot data-own-server-state="off">
                {t("ownServers.stateOff")}
              </Badge>
            ) : (
              <span data-own-server-state={view}>
                <PersonalStateBadge signIn={row} />
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
    </Card>
  );
}

type AddStage =
  | { step: "address" }
  | { step: "checking" }
  | { step: "sign-in" }
  | { step: "reading" }
  | { step: "tools"; candidates: ApprovalCandidate[]; late: boolean };

/**
 * Adds an MCP server: one address and Verbinden, the sign-in in another tab, the tools to
 * choose, and Fertig. It saves at Verbinden, runs the owner's probe and goes on by its answer.
 * A server the probe turns away is deleted again, so a second try starts afresh.
 */
export function OwnServerAddDialog({
  onClose,
  onAdded,
  initial,
  browser
}: {
  onClose(): void;
  /** Fertig: the server is added with the chosen tools. */
  onAdded?: (name: string) => void;
  /** What the dialog starts with, such as an agent's proposal in a chat. */
  initial?: { url?: string; title?: string };
  browser?: SignInBrowser;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const [stage, setStage] = useState<AddStage>({ step: "address" });
  const [address, setAddress] = useState(initial?.url ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [addressError, setAddressError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
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
    const config = ownServerConfig({ name: nextName, url: address, title: startTitle });
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
    if (step !== "sign_in") {
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
    setStage({ step: "sign-in" });
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
    if (open.current) enterTools(detail);
  };

  const enterTools = (detail: ConnectionDetail | undefined) => {
    const candidates = discoveredCandidates(detail?.discovered ?? []);
    approval.reset(candidates);
    setStage({ step: "tools", candidates, late: detail?.discoveredAt === undefined });
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
    onAdded?.(current.name);
    onClose();
  };

  /** Closing keeps a server already saved: its card offers the sign-in and the tools again. */
  const close = () => {
    if (busy) return;
    if (saved.current) invalidate().catch(() => undefined);
    onClose();
  };

  const heading = stage.step === "sign-in" ? signInHeading(signIn, t) : t("ownServers.add");

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
            <Field
              label={t("ownServers.addressLabel")}
              hint={t("ownServers.addressHint")}
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
                data-own-server-field="address"
                onChange={(event) => {
                  setAddress(event.target.value);
                  setAddressError(undefined);
                }}
              />
            </Field>
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
        return <SignInBody signIn={signIn} />;
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
  aside
}: {
  candidates: readonly ApprovalCandidate[];
  approval: ReturnType<typeof useApprovalChoice>;
  disabled: boolean;
  aside?: Parameters<typeof ConnectionApprovalList>[0]["aside"];
}) {
  const proposedReading = new Set(
    candidates
      .filter((candidate) => candidate.effect === "reading")
      .map((candidate) => candidate.name)
  );
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
