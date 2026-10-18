import { ArrowLeft, Code, Plug } from "lucide-react";
import { useRef, useState } from "react";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { CONNECTION_ASSET_KIND, assetAddressFromName } from "@work-shape/catalyst-core";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Step,
  Steps
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildCreateDialogProps } from "./build-asset-kind";
import { readBuildRefusal } from "./build-refusals";
import {
  approvalRefusals,
  connectionWriteErrors,
  egressRefusal,
  type ApprovalRefused
} from "./connection-refusals";
import { RefusalDetail } from "./refusal-notice";
import { addressBlocksCreate, useAddressCheck } from "./name-check";
import { ConnectionApprovalList, approveLabel, useApprovalChoice } from "./connection-approval";
import {
  discoveredCandidates,
  selectedCandidates,
  type ApprovalCandidate
} from "./connection-approval-model";
import {
  connectConnection,
  type ConnectMemory,
  type ConnectOutcome,
  type ConnectStep,
  type ConnectStepState
} from "./connection-connect";
import {
  ConnectionCreateForm,
  NO_NAMESPACE,
  type CreateFieldErrors,
  type CreateFields
} from "./connection-create-form";
import { useDraftForNewConnection, type ConnectionDraft } from "./connection-draft";
import {
  DISCOVERY_WAIT_MS,
  emptyConnectionForm,
  newConnectionConfig,
  withApprovedOperations,
  type ConnectionFormType
} from "./connection-form-model";
import {
  SignInActions,
  SignInBody,
  signInHeading,
  useConnectionSignIn,
  type SignInBrowser
} from "./connection-sign-in";
import { withOAuthSettings } from "./connection-sign-in-model";
import {
  AddToolsChoices,
  ApprovalRefusals,
  ChoiceCard,
  PasteToolsField,
  readPaste
} from "./connection-rest-tools";
import { useConnectionSource, type ConnectionSource } from "./connection-source";

// The New connection dialog (CS-5a 2/2): pick what to connect, give it a name, its address and
// its key, press Verbinden, and choose which of its tools agents, Apps and Workflows may use.

/** Where the dialog stands. */
type Stage =
  | { step: "pick" }
  | { step: "form" }
  /** A call waits for somebody's approval in the Inbox. */
  | { step: "held" }
  /** The server asks for an OAuth sign-in: the provider's host, the permissions, the button. */
  | { step: "sign-in" }
  /** Signed in: the tools of the server are read. */
  | { step: "signed-in" }
  /** An MCP server is connected: its tools, as the discovery read them. */
  | { step: "tools"; candidates: ApprovalCandidate[]; waiting: boolean }
  /** A REST API is connected: how its tools come in. */
  | { step: "add" }
  | { step: "paste"; error?: string }
  /** Declared operations to approve: pasted, or `drafted` by the agent in the chat. */
  | { step: "review"; candidates: ApprovalCandidate[]; drafted?: true };

export function ConnectionCreateDialog(props: BuildCreateDialogProps) {
  return <ConnectionCreateFlow {...props} source={useConnectionSource()} />;
}

/** How often the dialog reads the Connection while the tools of a signed-in server are read. */
const SIGNED_IN_READ_MS = 1_000;

/**
 * The same dialog on a source it is handed, so a test hands it answers of its own, and the
 * browser of its sign-in.
 */
export function ConnectionCreateFlow({
  source,
  browser,
  namespaces,
  mayNameFreely,
  checkName,
  put,
  remove,
  mayDelete,
  onClose,
  onCreated
}: BuildCreateDialogProps & { source: ConnectionSource; browser?: SignInBrowser }) {
  const { t } = useTranslation();
  // The agent's draft opened from its card: the dialog starts at the REST API's form, filled
  // with it, and after Verbinden its tools wait in the approval list.
  const drafted = useDraftForNewConnection();
  const [stage, setStage] = useState<Stage>({ step: drafted ? "form" : "pick" });
  const [fields, setFields] = useState<CreateFields>(() =>
    drafted
      ? draftedFields(drafted, namespaces, mayNameFreely)
      : {
          title: "",
          prefix: mayNameFreely ? NO_NAMESPACE : (namespaces[0]?.prefix ?? NO_NAMESPACE),
          form: emptyConnectionForm(),
          key: "",
          sendAs: "bearer"
        }
  );
  // A drafted id or header names show under "Technical details", open from the start.
  const [detailsOpen] = useState(
    () => fields.typedId !== undefined || fields.form.headers.length > 0
  );
  const [errors, setErrors] = useState<CreateFieldErrors>({});
  const [steps, setSteps] = useState<{ step: ConnectStep; state: ConnectStepState }[]>([]);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [refusals, setRefusals] = useState<ApprovalRefused>();
  const [pasted, setPasted] = useState("");
  const approval = useApprovalChoice([]);
  // What the dialog wrote and sent so far: a later Verbinden picks up from here.
  const memory = useRef<ConnectMemory>({});
  const written = useRef<Record<string, unknown>>({});
  /** When the tools were read before the sign-in: a later reading is the signed-in one. */
  const discoveredBefore = useRef<string | undefined>(undefined);

  const choices = [
    ...(mayNameFreely
      ? [{ prefix: NO_NAMESPACE, displayName: t("connectionCreate.noNamespace") }]
      : []),
    ...namespaces
  ];
  const id = (fields.typedId ?? assetAddressFromName(fields.title, CONNECTION_ASSET_KIND)).trim();
  const name = `${fields.prefix}${id}`;
  const title = fields.title.trim();
  const created = memory.current.revision !== undefined;
  const rest = fields.form.connectorType === "http_api";

  /** One write of the definition over the revision the dialog wrote last. */
  const rewrite = async (config: Record<string, unknown>) => {
    const revision = (
      await put({ name, config, expectedRevision: memory.current.revision ?? null })
    ).revision;
    memory.current = { ...memory.current, revision };
    written.current = config;
  };
  const signIn = useConnectionSignIn(
    {
      connection: name,
      start: () => source.oauthStart(name),
      readDetail: () => source.readDetail(name),
      writeOAuth: (oauth) => rewrite(withOAuthSettings(written.current, oauth)),
      setSecret: (value, expectedVersion) => source.setSecret(name, value, expectedVersion)
    },
    {
      enabled: stage.step === "sign-in",
      onConnected: () => {
        readSignedInTools().catch(() => enterTools(undefined));
      },
      ...(browser ? { browser } : {})
    }
  );

  const pick = (connectorType: ConnectionFormType) => {
    setFields({ ...fields, form: { ...fields.form, connectorType } });
    setStage({ step: "form" });
  };

  // Once the dialog wrote the Connection, its id is its own: nothing is checked any more.
  const check = useAddressCheck(created ? undefined : checkName, id === "" ? "" : name);
  const complete =
    title !== "" && id !== "" && fields.form.url.trim() !== "" && !addressBlocksCreate(check);

  const connect = async () => {
    const key = fields.key;
    const config = newConnectionConfig(
      { name, title },
      { ...fields.form, authScheme: key === "" ? "none" : fields.sendAs }
    );
    written.current = config;
    setBusy(true);
    setErrors({});
    const order: ConnectStep[] = [
      "server",
      ...(key === "" ? [] : (["key"] as const)),
      ...(rest ? [] : (["tools"] as const))
    ];
    setSteps(order.map((step) => ({ step, state: step === "server" ? "running" : "queued" })));
    const outcome = await connectConnection(
      {
        put: async (definition, expectedRevision) => {
          try {
            return (await put({ name, config: definition, expectedRevision })).revision;
          } catch (error) {
            // The id is held by a deleted asset: the Connection is made again after that delete.
            const met = readBuildRefusal(error, t);
            if (
              expectedRevision !== null ||
              met.ok ||
              !met.conflict ||
              !met.deleted ||
              met.currentRevision === undefined
            ) {
              throw error;
            }
            return (await put({ name, config: definition, expectedRevision: met.currentRevision }))
              .revision;
          }
        },
        setSecret: (value, expectedVersion) => source.setSecret(name, value, expectedVersion),
        readDetail: () => source.readDetail(name),
        test: () => source.test(name),
        discover: () => source.discover(name),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now()
      },
      { config, url: fields.form.url, key, discovers: !rest },
      memory.current,
      (step, state) =>
        setSteps((current) =>
          current.map((entry) => (entry.step === step ? { step, state } : entry))
        )
    );
    memory.current = outcome.memory;
    setBusy(false);
    answer(outcome, key);
  };

  /** What the dialog shows after a connect. */
  const answer = (outcome: ConnectOutcome, key: string) => {
    switch (outcome.status) {
      case "connected":
        setSteps([]);
        if (rest) {
          if (drafted && drafted.operations.length > 0) {
            approval.reset(drafted.operations);
            setRefusals(undefined);
            setStage({ step: "review", candidates: drafted.operations, drafted: true });
          } else {
            setStage({ step: "add" });
          }
          return;
        }
        enterTools(outcome.detail);
        return;
      case "held":
        setStage({ step: "held" });
        return;
      case "refused":
        setSteps([]);
        if (outcome.reason === "oauth_required") {
          enterSignIn().catch(() => setBusy(false));
          return;
        }
        if (outcome.reason === "unauthorized") {
          // A refused key is never shown again: the field is empty and waits for a new one.
          setFields((current) => ({ ...current, key: "" }));
          setErrors({
            key: t(key === "" ? "connectionCreate.errorKeyMissing" : "connectionCreate.errorKey")
          });
        } else {
          setErrors({
            url:
              outcome.reason === "network_denied"
                ? egressRefusal(fields.form.url, t)
                : t("connectionCreate.errorUrl")
          });
        }
        return;
      case "secret_failed":
        setSteps([]);
        setErrors({ key: sentenceOf(outcome.error) });
        return;
      case "write_failed":
        setSteps([]);
        setErrors(writeErrors(outcome.error));
        return;
    }
  };

  /** The fields a refused definition is about, in the reader's words. */
  const writeErrors = (error: unknown): CreateFieldErrors => {
    const { errors: found, detail } = connectionWriteErrors(error, name, t, fields.form.url);
    return detail === undefined ? found : { ...found, detail };
  };

  const sentenceOf = (error: unknown): string => {
    const outcome = readBuildRefusal(error, t);
    return outcome.ok || outcome.conflict
      ? t("connectionCreate.errorFailed")
      : outcome.refusals.map((refusal) => refusal.message).join(" ");
  };

  /**
   * The server asks for a sign-in: the key field leaves, the Connection signs in with OAuth
   * from its next write on, and the step of the sign-in starts.
   */
  const enterSignIn = async () => {
    setFields((current) => ({ ...current, key: "" }));
    setBusy(true);
    try {
      await rewrite({ ...written.current, authScheme: "oauth" });
      discoveredBefore.current = (await source.readDetail(name).catch(() => undefined))
        ?.discoveredAt;
    } catch (error) {
      setBusy(false);
      setErrors(writeErrors(error));
      return;
    }
    setBusy(false);
    setStage({ step: "sign-in" });
  };

  /** After the sign-in: the test, then the tools the instance reads with the new account. */
  const readSignedInTools = async () => {
    setStage({ step: "signed-in" });
    // The test writes the health; what it answers changes nothing here.
    await source.test(name).catch(() => undefined);
    const since = Date.now();
    for (;;) {
      const detail = await source.readDetail(name).catch(() => undefined);
      if (detail?.discoveredAt !== undefined && detail.discoveredAt !== discoveredBefore.current) {
        enterTools(detail);
        return;
      }
      if (Date.now() - since >= DISCOVERY_WAIT_MS) {
        enterTools(detail);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SIGNED_IN_READ_MS));
    }
  };

  const enterTools = (detail: ConnectionDetail | undefined) => {
    const candidates = discoveredCandidates(detail?.discovered ?? []);
    approval.reset(candidates);
    setStage({ step: "tools", candidates, waiting: detail?.discoveredAt === undefined });
  };

  /** One write of the definition with the approved tools, then the Connection's page. */
  const approve = async (candidates: ApprovalCandidate[]) => {
    const revision = memory.current.revision;
    if (revision === undefined) return;
    const chosen = selectedCandidates(
      candidates,
      approval.choice.selected,
      approval.choice.effects
    );
    const config = withApprovedOperations(written.current, chosen, [...approval.choice.surfaces]);
    setBusy(true);
    setRefusals(undefined);
    try {
      await put({ name, config, expectedRevision: revision });
      onCreated(name);
    } catch (error) {
      setBusy(false);
      setRefusals(approvalRefusals(error, config, t));
    }
  };

  /** Closes the dialog: before a Connection exists, after it connected, or asking to discard it. */
  const close = () => {
    if (busy) return;
    if (!created) {
      onClose();
      return;
    }
    if (stage.step === "form") {
      if (mayDelete(fields.prefix === NO_NAMESPACE ? undefined : fields.prefix)) setAsking(true);
      else onClose();
      return;
    }
    if (stage.step === "held") {
      onClose();
      return;
    }
    // Signing in: the Connection stays, and its page offers the sign-in again.
    // Connected: "Later" leaves it with no tool accepted, on its page.
    onCreated(name);
  };

  const discard = () => {
    const revision = memory.current.revision;
    if (revision === undefined) return;
    setDiscarding(true);
    remove({ name, expectedRevision: revision }).then(onClose, () => {
      setDiscarding(false);
      setAsking(false);
      setErrors({ general: t("connectionCreate.errorFailed") });
    });
  };

  const draft = source.draftInChat
    ? () => {
        const request = t("connectionCreate.draftRequest", {
          title,
          name,
          url: fields.form.url.trim()
        });
        const startChat = source.draftInChat;
        onCreated(name, () => startChat?.(request));
      }
    : undefined;

  const heading = (() => {
    switch (stage.step) {
      case "pick":
        return t("connectionCreate.title");
      case "form":
        return t(rest ? "connectionCreate.restHeading" : "connectionCreate.mcpHeading");
      case "held":
        return t("connectionCreate.heldTitle");
      case "sign-in":
      case "signed-in":
        return signInHeading(signIn, t);
      case "add":
        return t("connectionCreate.addHeading");
      case "paste":
        return t("connectionCreate.pasteHeading");
      case "tools":
      case "review":
        return t("connectionCreate.approveHeading");
    }
  })();
  const connectedLine = t(
    memory.current.sent ? "connectionCreate.connectedRest" : "connectionCreate.connectedRestNoKey",
    { name: title }
  );

  return (
    <>
      <Dialog
        open
        title={
          stage.step === "form" && !created ? (
            <span className="flex min-w-0 items-center gap-1">
              <IconButton
                label={t("connectionCreate.back")}
                size="sm"
                disabled={busy}
                onClick={() => setStage({ step: "pick" })}
              >
                <ArrowLeft aria-hidden="true" />
              </IconButton>
              <span className="min-w-0">{heading}</span>
            </span>
          ) : (
            heading
          )
        }
        onClose={close}
        footer={footer()}
      >
        {body()}
      </Dialog>
      <ConfirmDialog
        open={asking}
        tone="danger"
        title={t("connectionCreate.discardTitle")}
        confirmLabel={t("connectionCreate.discardConfirm")}
        loading={discarding}
        onConfirm={discard}
        onClose={() => setAsking(false)}
      >
        {t("connectionCreate.discardText")}
      </ConfirmDialog>
    </>
  );

  function body() {
    switch (stage.step) {
      case "pick":
        return (
          <div
            className="grid min-w-0 gap-2"
            role="group"
            aria-label={t("connectionCreate.typesLabel")}
          >
            <ChoiceCard
              icon={<Plug aria-hidden="true" />}
              title={t("connectionCreate.mcpTitle")}
              text={t("connectionCreate.mcpText")}
              onChoose={() => pick("mcp")}
              data-connection-type="mcp"
            />
            <ChoiceCard
              icon={<Code aria-hidden="true" />}
              title={t("connectionCreate.restTitle")}
              text={t("connectionCreate.restText")}
              onChoose={() => pick("http_api")}
              data-connection-type="http_api"
            />
          </div>
        );
      case "form":
        return (
          <ConnectionCreateForm
            fields={fields}
            check={check}
            namespaces={choices}
            errors={errors}
            busy={busy}
            steps={steps}
            detailsOpen={detailsOpen}
            onChange={setFields}
          />
        );
      case "held":
        return (
          <Banner layout="line" data-connection-create-held="">
            {t("connectionCreate.held")}
          </Banner>
        );
      case "sign-in":
        return <SignInBody signIn={signIn} />;
      case "signed-in":
        return (
          <Steps label={t("connectionCreate.steps")} data-connection-steps="">
            <Step state="done" title={t("connectionSignIn.signedIn")} data-connect-step="sign-in" />
            <Step
              state="running"
              title={t("connectionSignIn.readTools")}
              data-connect-step="tools"
            />
          </Steps>
        );
      case "add":
        return (
          <div className="grid min-w-0 gap-4">
            <ConnectedLine text={connectedLine} />
            <p className="text-body text-muted-foreground">{t("connectionCreate.addText")}</p>
            <AddToolsChoices onPaste={() => setStage({ step: "paste" })} onDraft={draft} />
          </div>
        );
      case "paste":
        return <PasteToolsField value={pasted} error={stage.error} onChange={setPasted} />;
      case "tools":
        return (
          <div className="grid min-w-0 gap-4">
            <ConnectedLine
              text={
                stage.waiting
                  ? t("connectionCreate.connectedMcpWaiting", { name: title })
                  : stage.candidates.length === 0
                    ? t("connectionCreate.connectedMcpNone", { name: title })
                    : stage.candidates.length === 1
                      ? t("connectionCreate.connectedMcpOne", { name: title })
                      : t("connectionCreate.connectedMcp", {
                          name: title,
                          count: stage.candidates.length
                        })
              }
            />
            {stage.candidates.length > 0 ? (
              <ConnectionApprovalList
                candidates={stage.candidates}
                choice={approval.choice}
                onSelectedChange={approval.setSelected}
                onSurfacesChange={approval.setSurfaces}
                onEffectsChange={approval.setEffects}
                disabled={busy}
              />
            ) : null}
            {refusals ? <ApprovalRefusals refusals={refusals.refusals} /> : null}
            <RefusalDetail detail={refusals?.detail} />
          </div>
        );
      case "review":
        return (
          <div className="grid min-w-0 gap-4">
            {stage.drafted ? (
              <>
                <ConnectedLine text={connectedLine} />
                <p className="text-body text-muted-foreground" data-connection-drafted="">
                  {t("connectionCreate.draftedIntro", { title })}
                </p>
              </>
            ) : null}
            <ConnectionApprovalList
              candidates={stage.candidates}
              choice={approval.choice}
              onSelectedChange={approval.setSelected}
              onSurfacesChange={approval.setSurfaces}
              declared
              {...(stage.drafted ? {} : { source: pasted })}
              disabled={busy}
            />
            {refusals ? <ApprovalRefusals refusals={refusals.refusals} /> : null}
            <RefusalDetail detail={refusals?.detail} />
          </div>
        );
    }
  }

  function footer() {
    switch (stage.step) {
      case "pick":
        return undefined;
      case "form":
        return (
          <>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("connectionCreate.cancel")}
            </Button>
            <Button
              loading={busy}
              disabled={!complete}
              data-connection-connect=""
              onClick={() => {
                connect().catch(() => setBusy(false));
              }}
            >
              {t(busy ? "connectionCreate.connecting" : "connectionCreate.connect")}
            </Button>
          </>
        );
      case "held":
        return (
          <Button variant="outline" onClick={onClose}>
            {t("connectionCreate.close")}
          </Button>
        );
      case "sign-in":
        return (
          <>
            {signIn.state.phase === "waiting" ? null : (
              <Button variant="outline" onClick={() => onCreated(name)}>
                {t("connectionCreate.later")}
              </Button>
            )}
            <SignInActions signIn={signIn} />
          </>
        );
      case "signed-in":
        return undefined;
      case "add":
        return (
          <Button variant="outline" onClick={() => onCreated(name)}>
            {t("connectionCreate.later")}
          </Button>
        );
      case "paste":
        return (
          <>
            <Button variant="outline" onClick={() => setStage({ step: "add" })}>
              {t("connectionCreate.back")}
            </Button>
            <Button
              disabled={pasted.trim() === ""}
              data-connection-paste-check=""
              onClick={() => {
                const read = readPaste(pasted, t);
                if ("error" in read) {
                  setStage({ step: "paste", error: read.error });
                  return;
                }
                approval.reset(read.candidates);
                setRefusals(undefined);
                setStage({ step: "review", candidates: read.candidates });
              }}
            >
              {t("connectionCreate.pasteCheck")}
            </Button>
          </>
        );
      case "tools":
      case "review": {
        const { candidates } = stage;
        const count = selectedCandidates(
          candidates,
          approval.choice.selected,
          approval.choice.effects
        ).length;
        return (
          <>
            <Button
              variant="outline"
              disabled={busy}
              {...(stage.step === "review" ? { "data-connection-discard": "" } : {})}
              onClick={() =>
                stage.step === "review"
                  ? setStage({ step: stage.drafted ? "add" : "paste" })
                  : onCreated(name)
              }
            >
              {t(stage.step === "review" ? "connectionCreate.discard" : "connectionCreate.later")}
            </Button>
            {candidates.length > 0 ? (
              <Button
                loading={busy}
                disabled={count === 0}
                data-connection-approve=""
                onClick={() => {
                  approve(candidates).catch(() => setBusy(false));
                }}
              >
                {approveLabel(count, t)}
              </Button>
            ) : null}
          </>
        );
      }
    }
  }
}

/**
 * The fields of a new REST API filled with the agent's draft: its name, address and the names
 * of its fixed headers, whose values the person types, as the key. The draft's id keeps the
 * Namespace it starts with where the reader may create in that one.
 */
function draftedFields(
  draft: ConnectionDraft,
  namespaces: BuildCreateDialogProps["namespaces"],
  mayNameFreely: boolean
): CreateFields {
  const { name, title, baseUrl, headerNames } = draft.connection;
  const namespace = namespaces
    .filter((entry) => entry.prefix !== NO_NAMESPACE && name.startsWith(entry.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length)[0];
  const prefix =
    namespace?.prefix ?? (mayNameFreely ? NO_NAMESPACE : (namespaces[0]?.prefix ?? NO_NAMESPACE));
  const id = namespace ? name.slice(namespace.prefix.length) : name;
  return {
    title,
    ...(id === assetAddressFromName(title, CONNECTION_ASSET_KIND) ? {} : { typedId: id }),
    prefix,
    form: {
      ...emptyConnectionForm(),
      connectorType: "http_api",
      url: baseUrl,
      headers: headerNames.map((header) => ({ name: header, value: "" }))
    },
    key: "",
    sendAs: "bearer"
  };
}

/** The line that says what was connected. */
function ConnectedLine({ text }: { text: string }) {
  return (
    <Banner layout="line" tone="success" data-connection-connected="">
      {text}
    </Banner>
  );
}
