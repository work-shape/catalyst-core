import { ArrowLeft, Code, FileText, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import { CONNECTION_ASSET_KIND, assetAddressFromName } from "@work-shape/catalyst-core";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  IconButton,
  Step,
  Steps,
  type AddressCheck
} from "@work-shape/catalyst-ui";
import type { CheckName } from "../../shared/api/asset-writes";
import { useTranslation } from "../../shared/i18n";
import type { BuildCreateDialogProps, BuildExistingAsset } from "./build-asset-kind";
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
  createsPersonal,
  draftedFields,
  type CreateFieldErrors,
  type CreateFields
} from "./connection-create-form";
import { connectionDraftEntry, useDraftForNewConnection } from "./connection-draft";
import { connectionReadyMessage, type ConnectionReadyOutcome } from "./connection-ready";
import {
  DISCOVERY_WAIT_MS,
  connectionFormFieldsOf,
  credentialOriginKey,
  emptyConnectionForm,
  isIncompleteConnection,
  isOAuthChoice,
  newConnectionConfig,
  oauthFormComplete,
  withApprovedOperations,
  type ConnectionFormState,
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
import { ConnectionApprovedBody, useGiveToAgent } from "./connection-give-step";
import { TypedConnectionCreate } from "./connection-typed-create";
import { CatalogueInstall } from "./connection-catalogue-install";
import { CatalogueServices } from "./connection-catalogue-services";
import {
  entriesToShow,
  typesWithEntries,
  type CatalogueEntryOffer
} from "./connection-catalogue-model";
import { offerText, type ConnectorTypeOffer } from "./connection-typed-model";

// The New connection dialog (CS-5a 2/2): pick what to connect, give it a name, its address and
// its key, press Verbinden, and choose which of its tools agents, Apps and Workflows may use.

/** Where the dialog stands. */
type Stage =
  | { step: "pick" }
  /** A type of the build with a form of its own, such as a document source. */
  | { step: "typed"; offer: ConnectorTypeOffer }
  /** A catalogue entry: one of its parts, installed through its type's form (CAT-1). */
  | { step: "entry"; entry: CatalogueEntryOffer }
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
  | { step: "review"; candidates: ApprovalCandidate[]; drafted?: true }
  /**
   * Approved (CS-5d): how many, and where agents may use them, the line that gives them to an
   * agent.
   */
  | { step: "approved"; count: number; forAgents: boolean }
  /** The tools go to an agent: the steps of the give. */
  | { step: "give"; count: number };

export function ConnectionCreateDialog(props: BuildCreateDialogProps) {
  return <ConnectionCreateFlow {...props} source={useConnectionSource()} />;
}

/** The exposure that lets agents call an approved operation. */
const AGENT_SURFACE = "agent";

/** How often the dialog reads the Connection while the tools of a signed-in server are read. */
const SIGNED_IN_READ_MS = 1_000;

/**
 * The same dialog on a source it is handed, so a test hands it answers of its own, and the
 * browser of its sign-in.
 */
export function ConnectionCreateFlow({
  source,
  browser,
  checkName,
  put,
  remove,
  mayDelete,
  existing,
  onClose,
  onCreated
}: BuildCreateDialogProps & { source: ConnectionSource; browser?: SignInBrowser }) {
  const { locale, t } = useTranslation();
  const allOffers = source.useConnectorTypes?.() ?? [];
  const entries = entriesToShow(source.useCatalogueEntries?.() ?? []);
  // An entry's card stands in for the card of a type it names.
  const replaced = typesWithEntries(entries);
  const offers = allOffers.filter((offer) => !replaced.has(offer.type));
  // The agent's draft opened from its card: the dialog starts at the REST API's form, filled
  // with it, and after Verbinden its tools wait in the approval list. Its proposal of a new
  // Connection starts at the form of its type, filled with it (CHAT-CONN-1).
  const drafted = useDraftForNewConnection();
  const draftedType = drafted?.connection.connectorType;
  const typedDraft =
    draftedType !== undefined && draftedType !== "mcp" && draftedType !== "http_api";
  const [stage, setStage] = useState<Stage>({
    step: drafted && !drafted.entry && !typedDraft ? "form" : "pick"
  });
  // A proposal of a type with a form of its own opens that form once the types are read.
  const typedOpened = useRef(false);
  useEffect(() => {
    if (typedOpened.current) return;
    if (drafted?.entry) {
      const entry = connectionDraftEntry(drafted, entries);
      if (!entry) return;
      typedOpened.current = true;
      setStage({ step: "entry", entry });
      return;
    }
    if (!typedDraft) return;
    const offer = allOffers.find((entry) => entry.type === draftedType);
    if (offer === undefined) return;
    typedOpened.current = true;
    setStage({ step: "typed", offer });
  }, [draftedType, allOffers, typedDraft, drafted, entries]);
  // The conversation whose agent proposed the Connection hears once that it is connected.
  const told = useRef(false);
  const tellReady = (outcome: ConnectionReadyOutcome, connection = { name, title }) => {
    const from = drafted?.from;
    const tell = source.tellConversation;
    if (from === undefined || tell === undefined || told.current) return;
    told.current = true;
    tell(from, connectionReadyMessage(connection, outcome, t)).catch(() => undefined);
  };
  const [fields, setFields] = useState<CreateFields>(() =>
    drafted
      ? draftedFields(drafted)
      : {
          title: "",
          description: "",
          form: emptyConnectionForm(),
          key: "",
          sendAs: "bearer",
          auth: "key",
          credentialMode: "shared"
        }
  );
  // A drafted id, key header, header names or test path show under "Technical details", open
  // from the start.
  const [detailsOpen] = useState(
    () =>
      fields.typedId !== undefined ||
      fields.sendAs === "header" ||
      fields.form.headers.length > 0 ||
      fields.form.testPath.trim() !== ""
  );
  const [errors, setErrors] = useState<CreateFieldErrors>({});
  const [steps, setSteps] = useState<{ step: ConnectStep; state: ConnectStepState }[]>([]);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [refusals, setRefusals] = useState<ApprovalRefused>();
  /** The Connection that holds the id asked last, where the reader may read it. */
  const [taken, setTaken] = useState<{ name: string; holder?: BuildExistingAsset }>();
  /** The id whose Connection "Replace" deleted: it is free for this one. */
  const [freed, setFreed] = useState<string>();
  const [replacing, setReplacing] = useState<BuildExistingAsset>();
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [pasted, setPasted] = useState("");
  const approval = useApprovalChoice([]);
  // What the dialog wrote and sent so far: a later Verbinden picks up from here.
  const memory = useRef<ConnectMemory>({});
  const written = useRef<Record<string, unknown>>({});
  /** When the tools were read before the sign-in: a later reading is the signed-in one. */
  const discoveredBefore = useRef<string | undefined>(undefined);

  const name = (fields.typedId ?? assetAddressFromName(fields.title, CONNECTION_ASSET_KIND)).trim();
  const title = fields.title.trim();
  const created = memory.current.revision !== undefined;
  const mayDiscard = mayDelete();
  const rest = fields.form.connectorType === "http_api";
  /** A REST API's OAuth choice, or nothing where the Connection sends a key. */
  const oauthChoice = rest && fields.auth !== "key" ? fields.auth : undefined;
  /** Each person signs in with their own account: the sign-in waits on the person's own. */
  const personal = createsPersonal(fields);

  /** One write of the definition over the revision the dialog wrote last. Answers the new one. */
  const rewrite = async (config: Record<string, unknown>) => {
    const revision = (
      await put({ name, config, expectedRevision: memory.current.revision ?? null })
    ).revision;
    memory.current = { ...memory.current, revision };
    written.current = config;
    return revision;
  };
  const signIn = useConnectionSignIn(
    {
      connection: name,
      start: () => source.oauthStart(name),
      readDetail: () =>
        personal && source.readOwnSignIn ? source.readOwnSignIn(name) : source.readDetail(name),
      writeOAuth: (oauth) => rewrite(withOAuthSettings(written.current, oauth)),
      setSecret: (value, expectedVersion, expectedRevision) =>
        source.setSecret(name, value, expectedVersion, expectedRevision)
    },
    {
      enabled: stage.step === "sign-in",
      personal,
      onConnected: () => {
        if (rest) {
          // A REST API names no tools: after the sign-in its tools are added or drafted.
          source
            .test(name)
            .catch(() => undefined)
            .then(enterRestTools, enterRestTools);
          return;
        }
        readSignedInTools().catch(() => enterTools(undefined));
      },
      ...(browser ? { browser } : {})
    }
  );

  const pick = (connectorType: ConnectionFormType) => {
    setFields({ ...fields, form: { ...fields.form, connectorType } });
    setStage({ step: "form" });
  };

  /**
   * The check of the id, which reads the Connection that holds a taken one, so the dialog
   * names it and offers what the reader may do with it. An id only a deleted Connection held
   * is free: the connect writes over that delete.
   */
  const askName: CheckName = async (asked) => {
    const answer = await checkName(asked);
    if (answer.available || answer.reason !== "name_taken") return answer;
    const holder = await existing?.(asked).catch(() => undefined);
    if (holder === undefined) {
      const deleted = await source.deletedRevision?.(asked).catch(() => undefined);
      if (deleted !== undefined) return { available: true };
    }
    setTaken({ name: asked, ...(holder ? { holder } : {}) });
    return answer;
  };
  // Once the dialog wrote the Connection, its id is its own: nothing is checked any more.
  const asked = useAddressCheck(created ? undefined : askName, name, (id) =>
    t("connectionCreate.idTaken", { name: id })
  );
  const holder = asked.state === "refused" && taken?.name === name ? taken.holder : undefined;
  const holderTitle = holder ? connectionFormFieldsOf(holder.config).title : "";
  const replacingTitle = replacing ? connectionFormFieldsOf(replacing.config).title : "";
  const check: AddressCheck =
    freed !== undefined && freed === name
      ? { state: "free" }
      : holder
        ? {
            state: "refused",
            reason: t("connectionCreate.idTakenBy", { name, title: holderTitle })
          }
        : asked;
  const formWithChoice = {
    ...fields.form,
    ...(oauthChoice === undefined ? {} : { authScheme: oauthChoice })
  };
  const complete =
    title !== "" &&
    name !== "" &&
    fields.form.url.trim() !== "" &&
    !addressBlocksCreate(check) &&
    oauthFormComplete(formWithChoice) &&
    // The client credentials grant has no client without its secret.
    (oauthChoice !== "oauth_client" || fields.key !== "");

  /**
   * Verbinden with the fields given. With `stored`, the definition of a Connection that held
   * the id already is written as it is and connected again ("Connect again").
   */
  const connect = async (current: CreateFields = fields, stored?: Record<string, unknown>) => {
    const target = (
      current.typedId ?? assetAddressFromName(current.title, CONNECTION_ASSET_KIND)
    ).trim();
    const currentRest = current.form.connectorType === "http_api";
    const currentOAuth = currentRest && current.auth !== "key" ? current.auth : undefined;
    // A personal MCP server takes no key: each person signs in.
    const key = createsPersonal(current) && !currentRest ? "" : current.key;
    const form: ConnectionFormState = {
      ...current.form,
      authScheme: currentOAuth ?? (key === "" ? "none" : current.sendAs)
    };
    const config =
      stored ??
      newConnectionConfig(
        {
          name: target,
          title: current.title.trim(),
          description: current.description,
          ...(createsPersonal(current) ? { credentialMode: "user" as const } : {})
        },
        form
      );
    written.current = config;
    setBusy(true);
    setErrors({});
    const order: ConnectStep[] = [
      "server",
      ...(key === "" ? [] : (["key"] as const)),
      ...(currentRest ? [] : (["tools"] as const))
    ];
    setSteps(order.map((step) => ({ step, state: step === "server" ? "running" : "queued" })));
    const outcome = await connectConnection(
      {
        put: async (definition, expectedRevision) => {
          try {
            return (await put({ name: target, config: definition, expectedRevision })).revision;
          } catch (error) {
            // The id is held by a deleted asset: the Connection is made again after that delete.
            const met = readBuildRefusal(error, t, locale);
            if (
              expectedRevision !== null ||
              met.ok ||
              !met.conflict ||
              !met.deleted ||
              met.currentRevision === undefined
            ) {
              throw error;
            }
            return (
              await put({
                name: target,
                config: definition,
                expectedRevision: met.currentRevision
              })
            ).revision;
          }
        },
        setSecret: (value, expectedVersion, expectedRevision) =>
          source.setSecret(target, value, expectedVersion, expectedRevision),
        readDetail: () => source.readDetail(target),
        test: () => source.test(target),
        discover: () => source.discover(target),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now()
      },
      {
        config,
        url: current.form.url,
        key,
        discovers: !currentRest,
        ...(currentOAuth === undefined ? {} : { origin: credentialOriginKey(form) ?? "" })
      },
      memory.current,
      (step, state) =>
        setSteps((current) =>
          current.map((entry) => (entry.step === step ? { step, state } : entry))
        )
    );
    memory.current = outcome.memory;
    setBusy(false);
    answer(outcome, key, current, target);
  };

  /** What the dialog shows after a connect with the fields given. */
  const answer = (outcome: ConnectOutcome, key: string, current: CreateFields, target: string) => {
    const currentRest = current.form.connectorType === "http_api";
    switch (outcome.status) {
      case "connected":
        setSteps([]);
        if (currentRest) {
          enterRestTools();
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
          setFields((now) => ({ ...now, key: "" }));
          setErrors({
            key: t(
              currentRest && current.auth !== "key"
                ? "connectionCreate.errorClient"
                : key === ""
                  ? "connectionCreate.errorKeyMissing"
                  : "connectionCreate.errorKey"
            )
          });
        } else {
          setErrors({
            url:
              outcome.reason === "network_denied"
                ? egressRefusal(current.form.url, t)
                : t(
                    // A test path that answers without success may be refusing the key.
                    currentRest && current.form.testPath.trim() !== ""
                      ? "connectionCreate.errorTestPath"
                      : "connectionCreate.errorUrl"
                  )
          });
        }
        return;
      case "secret_failed":
        setSteps([]);
        setErrors({ key: sentenceOf(outcome.error) });
        return;
      case "write_failed":
        setSteps([]);
        setErrors(writeErrors(outcome.error, target, current.form.url));
        return;
    }
  };

  /** The fields a refused definition is about, in the reader's words. */
  const writeErrors = (error: unknown, id = name, url = fields.form.url): CreateFieldErrors => {
    const { errors: found, detail } = connectionWriteErrors(error, id, t, locale, url);
    return detail === undefined ? found : { ...found, detail };
  };

  /**
   * "Connect again" on the Connection that holds the id: the dialog takes it over as the one it
   * saved, fills its fields from its definition and connects it as it is. The key it holds
   * stays: none is sent unless one is typed afterwards.
   */
  const reconnect = (stored: BuildExistingAsset) => {
    const read = connectionFormFieldsOf(stored.config);
    const restStored = read.form.connectorType === "http_api";
    const next: CreateFields = {
      title: read.title,
      description: read.description,
      typedId: stored.name,
      form: read.form,
      key: "",
      sendAs: read.form.authScheme === "header" ? "header" : "bearer",
      auth:
        restStored && isOAuthChoice(read.form.authScheme) ? read.form.authScheme : ("key" as const),
      credentialMode: read.credentialMode
    };
    setFields(next);
    setTaken(undefined);
    memory.current = { revision: stored.revision };
    written.current = stored.config;
    connect(next, stored.config).catch(() => setBusy(false));
  };

  /** "Replace": the Connection that holds the id is deleted, then this one is connected. */
  const replace = async (stored: BuildExistingAsset) => {
    setReplaceBusy(true);
    try {
      await remove({ name: stored.name, expectedRevision: stored.revision });
    } catch {
      setReplaceBusy(false);
      setReplacing(undefined);
      setErrors({
        general: t("connectionCreate.replaceFailed", {
          title: connectionFormFieldsOf(stored.config).title
        })
      });
      return;
    }
    setReplaceBusy(false);
    setReplacing(undefined);
    setTaken(undefined);
    setFreed(stored.name);
    await connect();
  };

  const sentenceOf = (error: unknown): string => {
    const outcome = readBuildRefusal(error, t, locale);
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
      // A REST API's sign-in was written with the definition already.
      if (written.current.authScheme !== "oauth") {
        await rewrite({ ...written.current, authScheme: "oauth" });
      }
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
    // A personal sign-in starts no discovery by itself: the dialog asks for one.
    if (personal) await source.discover(name).catch(() => undefined);
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

  /** A REST API is connected: the agent's drafted tools to review, or how its tools come in. */
  const enterRestTools = () => {
    if (drafted && drafted.operations.length > 0) {
      approval.reset(drafted.operations);
      setRefusals(undefined);
      setStage({ step: "review", candidates: drafted.operations, drafted: true });
    } else {
      setStage({ step: "add" });
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
    const surfaces = [...approval.choice.surfaces];
    const config = withApprovedOperations(written.current, chosen, surfaces);
    setBusy(true);
    setRefusals(undefined);
    try {
      memory.current = {
        ...memory.current,
        revision: (await put({ name, config, expectedRevision: revision })).revision
      };
      written.current = config;
      setBusy(false);
      tellReady({ kind: "approved", tools: chosen.map((operation) => operation.name), surfaces });
      // Where agents may use them, the done state offers them to one; else the page opens.
      if (source.give && surfaces.includes(AGENT_SURFACE)) {
        setStage({ step: "approved", count: chosen.length, forAgents: true });
      } else {
        onCreated(name);
      }
    } catch (error) {
      setBusy(false);
      setRefusals(approvalRefusals(error, config, t, locale));
    }
  };

  const give = useGiveToAgent({
    host: source.give,
    enabled: stage.step === "give",
    connection: name,
    connectionTitle: title,
    onBack: () =>
      setStage({
        step: "approved",
        count: stage.step === "give" ? stage.count : 0,
        forAgents: true
      }),
    onClose: () => onCreated(name)
  });

  /** Closes the dialog: before a Connection exists, after it connected, or asking to discard it. */
  const close = () => {
    if (busy || give.busy) return;
    if (!created) {
      onClose();
      return;
    }
    if (stage.step === "form") {
      if (mayDiscard) setAsking(true);
      else onClose();
      return;
    }
    if (stage.step === "held") {
      onClose();
      return;
    }
    // Signing in: the Connection stays, and its page offers the sign-in again.
    // Connected: "Later" leaves it with no tool accepted, on its page.
    if (stage.step !== "sign-in") tellReady({ kind: "none" });
    onCreated(name);
  };

  /** "Later" after a connect: the Connection stays with no tool accepted, on its page. */
  const later = () => {
    tellReady({ kind: "none" });
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

  // A proposal's REST API: its tools are drafted in the conversation it came from.
  const draft =
    drafted?.from !== undefined && source.tellConversation !== undefined
      ? () => {
          tellReady({ kind: "draft" });
          onCreated(name);
        }
      : source.draftInChat
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
      case "typed":
      case "entry":
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
      case "approved":
        return t("connectionCreate.approveHeading");
      case "give":
        return give.title;
    }
  })();
  const connectedLine = t(
    oauthChoice === "oauth"
      ? "connectionCreate.connectedRestOAuth"
      : oauthChoice === "oauth_client"
        ? "connectionCreate.connectedRestClient"
        : memory.current.sent
          ? "connectionCreate.connectedRest"
          : "connectionCreate.connectedRestNoKey",
    { name: title }
  );

  if (stage.step === "entry") {
    return (
      <CatalogueInstall
        entry={stage.entry}
        source={source}
        {...(browser ? { browser } : {})}
        checkName={checkName}
        put={put}
        onBack={() => setStage({ step: "pick" })}
        onClose={onClose}
        onCreated={onCreated}
      />
    );
  }

  if (stage.step === "typed") {
    return (
      <TypedConnectionCreate
        offer={stage.offer}
        source={source}
        checkName={checkName}
        put={put}
        onBack={() => setStage({ step: "pick" })}
        onClose={onClose}
        onCreated={(created, after) => {
          tellReady(
            { kind: "none" },
            { name: created, title: drafted?.connection.title ?? created }
          );
          onCreated(created, after);
        }}
        {...(drafted && stage.offer.type === draftedType
          ? { initial: { title: drafted.connection.title, name: drafted.connection.name } }
          : {})}
      />
    );
  }

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
      <ConfirmDialog
        open={replacing !== undefined}
        tone="danger"
        title={t("connectionCreate.replaceTitle", { title: replacingTitle })}
        confirmLabel={t("connectionCreate.takenReplace")}
        loading={replaceBusy}
        onConfirm={() => {
          if (replacing) replace(replacing).catch(() => setBusy(false));
        }}
        onClose={() => setReplacing(undefined)}
      >
        {t("connectionCreate.replaceText", { title: replacingTitle, name })}
      </ConfirmDialog>
    </>
  );

  /**
   * The Connection that holds the id: its name, whether it is incomplete, and what the reader
   * may do with it: open it, connect it again, or replace it with this one.
   */
  function takenNotice(stored: BuildExistingAsset) {
    return (
      <Banner
        tone="warning"
        title={t("connectionCreate.takenTitle", { title: holderTitle })}
        data-connection-id-taken={stored.name}
        action={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-connection-taken-open=""
              onClick={() => onCreated(stored.name)}
            >
              {t("connectionCreate.takenOpen")}
            </Button>
            {stored.mayWrite ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                data-connection-taken-reconnect=""
                onClick={() => reconnect(stored)}
              >
                {t("connectionCreate.takenReconnect")}
              </Button>
            ) : null}
            {stored.mayDelete ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                data-connection-taken-replace=""
                onClick={() => setReplacing(stored)}
              >
                {t("connectionCreate.takenReplace")}
              </Button>
            ) : null}
          </>
        }
      >
        {t(
          isIncompleteConnection(stored.config)
            ? "connectionCreate.takenIncomplete"
            : "connectionCreate.takenOther"
        )}
      </Banner>
    );
  }

  function body() {
    switch (stage.step) {
      case "typed":
      case "entry":
        return null;
      case "pick": {
        const own = (
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
            {offers.map((offer) => (
              <ChoiceCard
                key={offer.type}
                icon={
                  offer.documentSource ? (
                    <FileText aria-hidden="true" />
                  ) : (
                    <Plug aria-hidden="true" />
                  )
                }
                title={offerText(offer.title, locale)}
                text={offerText(offer.description, locale)}
                onChoose={() => setStage({ step: "typed", offer })}
                data-connection-type={offer.type}
              />
            ))}
          </div>
        );
        if (entries.length === 0) return own;
        return (
          <div className="grid min-w-0 gap-5">
            <CatalogueServices
              entries={entries}
              onChoose={(entry) => setStage({ step: "entry", entry })}
            />
            <section className="grid min-w-0 gap-2" data-connection-own="">
              <h3 className="text-label text-muted-foreground">{t("connectionCatalogue.own")}</h3>
              {own}
            </section>
          </div>
        );
      }
      case "form":
        return (
          <ConnectionCreateForm
            fields={fields}
            check={check}
            errors={errors}
            busy={busy}
            steps={steps}
            detailsOpen={detailsOpen}
            {...(created
              ? { saved: { discardable: mayDiscard, onOpen: () => onCreated(name) } }
              : {})}
            idNotice={holder && !created ? takenNotice(holder) : undefined}
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
            <RefusalDetail detail={refusals?.detail} untold={refusals?.untold ?? false} />
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
            <RefusalDetail detail={refusals?.detail} untold={refusals?.untold ?? false} />
          </div>
        );
      case "approved": {
        const { count } = stage;
        return (
          <ConnectionApprovedBody
            count={count}
            {...(stage.forAgents ? { onGive: () => setStage({ step: "give", count }) } : {})}
          />
        );
      }
      case "give":
        return give.body;
    }
  }

  function footer() {
    switch (stage.step) {
      case "pick":
      case "typed":
      case "entry":
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
          <Button variant="outline" onClick={later}>
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
      case "approved":
        return (
          <Button data-connection-approved-done="" onClick={() => onCreated(name)}>
            {t("connectionGive.done")}
          </Button>
        );
      case "give":
        return give.footer;
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
                  : later()
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

/** The line that says what was connected. */
function ConnectedLine({ text }: { text: string }) {
  return (
    <Banner layout="line" tone="success" data-connection-connected="">
      {text}
    </Banner>
  );
}
