import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  CommandLine,
  Dialog,
  RadioGroup,
  ServiceMark
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildCreateDialogProps } from "./build-asset-kind";
import {
  ConnectionApprovalList,
  approveLabel,
  useApprovalChoice,
  type ApprovalGroup
} from "./connection-approval";
import { selectedCandidates, type ApprovalCandidate } from "./connection-approval-model";
import {
  catalogueLink,
  partCandidates,
  partDefaults,
  partOffer,
  type CatalogueEntryOffer,
  type CataloguePartName,
  type CataloguePartOffer
} from "./connection-catalogue-model";
import {
  afterApprove,
  afterConnect,
  afterSignIn,
  partModes,
  reviewGroups,
  scopesFor,
  signsIn,
  withPartScopes,
  type InstallStep
} from "./connection-catalogue-oauth";
import { CredentialModeField } from "./connection-form";
import { withApprovedOperations, type ConnectionCredentialMode } from "./connection-form-model";
import { ConnectionApprovedBody, useGiveToAgent } from "./connection-give-step";
import { approvalRefusals, type ApprovalRefused } from "./connection-refusals";
import { ApprovalRefusals } from "./connection-rest-tools";
import {
  SignInActions,
  SignInBody,
  popupSignInBrowser,
  signInHeading,
  useConnectionSignIn,
  type SignInBrowser
} from "./connection-sign-in";
import type { ConnectionSource } from "./connection-source";
import { TypedConnectionCreate, type TypedConnected } from "./connection-typed-create";
import { offerText } from "./connection-typed-model";
import { RefusalDetail } from "./refusal-notice";

// Installs one part of a catalogue entry (CAT-1) through the form of its Connector type: the
// part, what it does, example prompts and the checklist; the fields, with the shared-account
// sentence before the secret; Verbinden. A tools part then shows its operations to review: the
// reading ones the entry recommends are ticked, the rest are not, and nothing is enabled before
// the admin approves. Who may use the Connection is decided after, on its page or by giving
// its tools to an agent; the install grants nothing.
//
// A part that signs in with OAuth (CAT-OAUTH-UI) adds whose account, the redirect URI in the
// checklist and the client id and secret. Verbinden saves without a test; the review groups the
// operations by the access they ask for; after Freigeben the shared account signs in with
// exactly that access, or for a personal part the admin may connect their own account and
// each person connects theirs under Settings. The order is the model's (`afterConnect`).

/** The section of the Connection's page that names who may use it. */
const ACCESS_SECTION = "access";

/** The exposure that lets agents call an approved operation. */
const AGENT_SURFACE = "agent";

interface Done {
  name: string;
  title: string;
  /** Approved operations; nothing where the part had none to review. */
  count?: number;
  /** The tools may be given to an agent. */
  gives: boolean;
}

type Stage =
  | { step: "prepare" }
  | { step: "review"; connected: TypedConnected; candidates: ApprovalCandidate[] }
  | ({ step: "sign-in" } & Done)
  /** Approved; for a personal part with the admin's own connect. */
  | ({ step: "approved"; personal: boolean } & Done)
  | ({ step: "give"; personal: boolean } & Done);

export function CatalogueInstall({
  entry,
  source,
  browser,
  checkName,
  put,
  onBack,
  onClose,
  onCreated
}: Pick<BuildCreateDialogProps, "checkName" | "put" | "onClose" | "onCreated"> & {
  entry: CatalogueEntryOffer;
  source: ConnectionSource;
  /** The browser the sign-in opens the provider's page in. A test hands its own. */
  browser?: SignInBrowser;
  onBack(): void;
}) {
  const { locale, t } = useTranslation();
  const [partName, setPartName] = useState<CataloguePartName | undefined>(entry.parts[0]?.part);
  const [mode, setMode] = useState<ConnectionCredentialMode>(() =>
    entry.parts[0] ? partModes(entry.parts[0]).initial : "shared"
  );
  const [stage, setStage] = useState<Stage>({ step: "prepare" });
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<ApprovalRefused>();
  const [ownConnected, setOwnConnected] = useState(false);
  /** The installer holds `connection.use`: undefined until the instance answered. */
  const [mayConnectOwn, setMayConnectOwn] = useState<boolean>();
  const approval = useApprovalChoice([]);
  const part = entry.parts.find((candidate) => candidate.part === partName);
  const title = offerText(entry.title, locale);
  const given = stage.step === "approved" || stage.step === "give" ? stage : undefined;
  const after = stage.step === "prepare" || stage.step === "review" ? undefined : stage;
  const name = stage.step === "review" ? stage.connected.name : (after?.name ?? "");
  const give = useGiveToAgent({
    host: source.give,
    enabled: stage.step === "give",
    connection: given?.name ?? "",
    connectionTitle: given?.title ?? "",
    onBack: () => given && setStage({ ...given, step: "approved" }),
    onClose: () => onCreated(given?.name ?? "")
  });
  // The shared account signs in once its tools are approved, with exactly their access.
  const sharedSignIn = useConnectionSignIn(
    {
      connection: name,
      start: () => source.oauthStart(name),
      // No `writeOAuth`: the entry's groups decide the scopes, never a tick here.
      readDetail: () => source.readDetail(name)
    },
    {
      enabled: stage.step === "sign-in",
      onConnected: () => {
        if (stage.step !== "sign-in") return;
        // The test writes the health; what it answers changes nothing here.
        source.test(name).catch(() => undefined);
        move(afterSignIn(stage), stage);
      },
      ...(browser ? { browser } : {})
    }
  );
  // The admin's own account on a personal part: one click, as under Settings > You.
  const ownSignIn = useConnectionSignIn(
    {
      connection: name,
      start: () => source.oauthStart(name),
      readDetail: () =>
        source.readOwnSignIn ? source.readOwnSignIn(name) : source.readDetail(name)
    },
    {
      personal: true,
      enabled: false,
      browser: browser ?? popupSignInBrowser,
      onConnected: () => setOwnConnected(true)
    }
  );
  const personalStep = stage.step === "approved" && stage.personal;
  useEffect(() => {
    if (!personalStep || name === "") return;
    const ask = source.mayConnectOwn;
    if (ask === undefined) {
      setMayConnectOwn(true);
      return;
    }
    let current = true;
    // Unanswered, the button stays: the instance decides at the connect.
    ask(name)
      .then((may) => current && setMayConnectOwn(may))
      .catch(() => current && setMayConnectOwn(true));
    return () => {
      current = false;
    };
  }, [personalStep, name, source]);
  if (part === undefined) return null;
  // The part, for the steps below: it stays the one chosen.
  const installed = part;
  const oauth = signsIn(part);
  const scopes = scopesFor(part, approval.choice.selected);

  /** Goes on to the step the model names. */
  function move(next: InstallStep, done: Done) {
    switch (next) {
      case "review":
        return;
      case "sign-in":
        setStage({ ...doneOf(done), step: "sign-in" });
        return;
      case "personal":
        setStage({ ...doneOf(done), step: "approved", personal: true });
        return;
      case "approved":
        setStage({ ...doneOf(done), step: "approved", personal: false });
        return;
      case "done":
        onCreated(done.name);
        return;
    }
  }

  const choosePart = (next: CataloguePartName) => {
    setPartName(next);
    const chosen = entry.parts.find((candidate) => candidate.part === next);
    if (chosen) setMode(partModes(chosen).initial);
  };

  const enterReview = (connected: TypedConnected) => {
    const candidates = partCandidates(part);
    approval.reset(candidates);
    setRefusals(undefined);
    setStage({ step: "review", connected, candidates });
  };

  /** One write of the definition with the operations the admin approved, and their scopes. */
  const approve = async (review: Extract<Stage, { step: "review" }>) => {
    const { connected, candidates } = review;
    const chosen = selectedCandidates(
      candidates,
      approval.choice.selected,
      approval.choice.effects
    );
    const surfaces = [...approval.choice.surfaces];
    const config = withPartScopes(withApprovedOperations(connected.config, chosen, surfaces), part);
    setBusy(true);
    setRefusals(undefined);
    try {
      await put({ name: connected.name, config, expectedRevision: connected.revision });
      setBusy(false);
      const gives = source.give !== undefined && surfaces.includes(AGENT_SURFACE);
      move(afterApprove({ part, mode, gives }), {
        name: connected.name,
        title: connected.title,
        count: chosen.length,
        gives
      });
    } catch (error) {
      setBusy(false);
      setRefusals(approvalRefusals(error, config, t));
    }
  };

  if (stage.step === "prepare") {
    return (
      <TypedConnectionCreate
        // Another part is another form: nothing typed for one goes to the other.
        key={part.part}
        offer={partOffer(entry, part)}
        source={source}
        checkName={checkName}
        put={put}
        onBack={onBack}
        onClose={onClose}
        onCreated={onCreated}
        initial={{ title: offerText(part.title ?? entry.title, locale), name: part.name }}
        defaults={partDefaults(part)}
        install={{
          link: catalogueLink(entry, part.part),
          intro: (
            <CatalogueIntro
              entry={entry}
              part={part}
              mode={mode}
              onPartChange={choosePart}
              onModeChange={setMode}
            />
          ),
          // Whose account everyone reads: only where it is one account for everyone.
          note:
            mode === "shared" ? (
              <Banner layout="line" data-catalogue-shared-note="">
                {offerText(part.sharedAccountNote, locale)}
              </Banner>
            ) : null,
          ...(oauth ? { credentialMode: mode, signsIn: true, addressFixed: true } : {})
        }}
        onConnected={(connected) => {
          const next = afterConnect({ part, mode });
          if (next === "review") enterReview(connected);
          else move(next, { name: connected.name, title: connected.title, gives: false });
        }}
      />
    );
  }

  return (
    <Dialog
      open
      title={heading()}
      onClose={() => {
        if (!busy && !give.busy && !sharedSignIn.busy) onCreated(name);
      }}
      footer={footer()}
    >
      {body()}
    </Dialog>
  );

  function heading() {
    switch (stage.step) {
      case "give":
        return give.title;
      case "sign-in":
        return signInHeading(sharedSignIn, t);
      default:
        return t("connectionCreate.approveHeading");
    }
  }

  function body() {
    switch (stage.step) {
      case "prepare":
        return null;
      case "review":
        return (
          <div className="grid min-w-0 gap-4" data-catalogue-review="">
            <Banner layout="line" tone="success" data-connection-connected="">
              {oauth
                ? t(
                    mode === "user"
                      ? "connectionCatalogue.savedPersonal"
                      : "connectionCatalogue.saved",
                    {
                      name: stage.connected.title
                    }
                  )
                : t("connectionCatalogue.connected", { name: stage.connected.title })}
            </Banner>
            <p className="text-body text-muted-foreground">
              {t("connectionCatalogue.reviewIntro", { title })}
            </p>
            <ConnectionApprovalList
              candidates={stage.candidates}
              choice={approval.choice}
              onSelectedChange={approval.setSelected}
              onSurfacesChange={approval.setSurfaces}
              declared={stage.candidates.some((candidate) => candidate.request !== undefined)}
              disabled={busy}
              {...(installed.groups === undefined
                ? {}
                : {
                    groups: approvalGroups(installed, stage.candidates, approval.choice.selected)
                  })}
            />
            {installed.groups === undefined ? null : (
              <p
                className="text-caption text-muted-foreground"
                data-catalogue-scopes={scopes.join(" ")}
              >
                {t("connectionCatalogue.signInScopes", { scopes: scopes.join(", ") })}
              </p>
            )}
            {refusals ? <ApprovalRefusals refusals={refusals.refusals} /> : null}
            <RefusalDetail detail={refusals?.detail} />
          </div>
        );
      case "sign-in":
        return (
          <div className="grid min-w-0 gap-4" data-catalogue-sign-in="">
            {stage.count === undefined ? null : <ApprovedLine count={stage.count} />}
            <SignInBody signIn={sharedSignIn} />
          </div>
        );
      case "approved":
        return (
          <div className="grid min-w-0 gap-4">
            {stage.count === undefined ? null : (
              <ConnectionApprovedBody
                count={stage.count}
                {...(stage.gives ? { onGive: () => setStage({ ...stage, step: "give" }) } : {})}
              />
            )}
            {stage.personal ? personalConnect() : null}
          </div>
        );
      case "give":
        return give.body;
    }
  }

  function footer() {
    switch (stage.step) {
      case "prepare":
        return undefined;
      case "review": {
        const count = selectedCandidates(
          stage.candidates,
          approval.choice.selected,
          approval.choice.effects
        ).length;
        return (
          <>
            <Button variant="outline" disabled={busy} onClick={() => onCreated(name)}>
              {t("connectionCreate.later")}
            </Button>
            <Button
              loading={busy}
              disabled={count === 0}
              data-connection-approve=""
              onClick={() => {
                approve(stage).catch(() => setBusy(false));
              }}
            >
              {approveLabel(count, t)}
            </Button>
          </>
        );
      }
      case "sign-in":
        return (
          <>
            <Button
              variant="outline"
              disabled={sharedSignIn.busy}
              data-catalogue-sign-in-later=""
              onClick={() => onCreated(name)}
            >
              {t("connectionCreate.later")}
            </Button>
            <SignInActions signIn={sharedSignIn} />
          </>
        );
      case "approved":
        return (
          <Button
            data-connection-approved-done=""
            disabled={ownSignIn.busy}
            onClick={() => onCreated(name)}
          >
            {t("connectionGive.done")}
          </Button>
        );
      case "give":
        return give.footer;
    }
  }

  /** Each person connects under Settings; the admin may connect their own account now. */
  function personalConnect() {
    const phase = ownSignIn.state.phase;
    return (
      <div className="grid min-w-0 gap-3" data-catalogue-personal="">
        <p className="text-body">{t("connectionCatalogue.personalText")}</p>
        {ownConnected ? (
          <Banner layout="line" tone="success" data-catalogue-own-connected="">
            {t("connectionCatalogue.ownConnected")}
          </Banner>
        ) : mayConnectOwn === false ? (
          // Installing grants nobody the use right, the installer neither.
          <p className="text-body text-muted-foreground" data-catalogue-own-needs-use="">
            {t("connectionCatalogue.ownNeedsUse")}{" "}
            <Button
              variant="link"
              size="sm"
              data-catalogue-own-access=""
              onClick={() =>
                onCreated(name, () =>
                  document.getElementById(ACCESS_SECTION)?.scrollIntoView({ block: "start" })
                )
              }
            >
              {t("connectionCatalogue.ownAccessLink")}
            </Button>
          </p>
        ) : mayConnectOwn === undefined ? null : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 text-body text-muted-foreground">
              {t("connectionCatalogue.ownOptional")}
            </span>
            {phase === "waiting" ? (
              <Button size="sm" variant="outline" data-sign-in-cancel="" onClick={ownSignIn.cancel}>
                {t("connectionSignIn.cancel")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                loading={ownSignIn.busy}
                data-catalogue-connect-own=""
                onClick={ownSignIn.connect}
              >
                {t("connectionCatalogue.connectOwn")}
              </Button>
            )}
          </div>
        )}
        {phase === "waiting" || phase === "failed" ? <SignInBody signIn={ownSignIn} /> : null}
      </div>
    );
  }

  /** The review's groups: the title, the access each asks for, and a word where it widens. */
  function approvalGroups(
    offer: CataloguePartOffer,
    candidates: readonly ApprovalCandidate[],
    selected: ReadonlySet<string>
  ): ApprovalGroup[] {
    return reviewGroups(offer, candidates, selected).map((group) => ({
      id: group.id,
      title:
        group.title === undefined
          ? t("connectionCatalogue.otherTools")
          : offerText(group.title, locale),
      names: group.candidates.map((candidate) => candidate.name),
      note: (
        <>
          {group.scopes.length > 0 ? (
            <span className="text-caption break-words text-muted-foreground">
              {t("connectionCatalogue.groupScopes", { scopes: group.scopes.join(", ") })}
            </span>
          ) : null}
          {group.widens ? (
            <span className="text-caption text-warning" data-catalogue-widens={group.id}>
              {t("connectionCatalogue.widens")}
            </span>
          ) : null}
        </>
      )
    }));
  }
}

/** What a finished step hands on: never the step it came from. */
function doneOf(done: Done): Done {
  return {
    name: done.name,
    title: done.title,
    gives: done.gives,
    ...(done.count === undefined ? {} : { count: done.count })
  };
}

/** "N tools approved", above the sign-in that follows. */
function ApprovedLine({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <Banner layout="line" tone="success" data-connection-approved="">
      {count === 1 ? t("connectionGive.approvedOne") : t("connectionGive.approved", { count })}
    </Banner>
  );
}

/**
 * Above the fields: the mark, what the part does, the part to install, whose account, prompts,
 * the checklist and, for a part that signs in, the redirect URI to register.
 */
function CatalogueIntro({
  entry,
  part,
  mode,
  onPartChange,
  onModeChange
}: {
  entry: CatalogueEntryOffer;
  part: CataloguePartOffer;
  mode: ConnectionCredentialMode;
  onPartChange(part: CataloguePartName): void;
  onModeChange(mode: ConnectionCredentialMode): void;
}) {
  const { locale, t } = useTranslation();
  const title = offerText(entry.title, locale);
  const hosts = new Intl.ListFormat(locale, { type: "conjunction" }).format(part.hosts);
  const { modes } = partModes(part);
  const oauth = signsIn(part);
  return (
    <div className="grid min-w-0 gap-4" data-catalogue-intro={entry.id}>
      <div className="flex min-w-0 items-start gap-3">
        <ServiceMark
          name={title}
          size="lg"
          showName={false}
          {...(entry.mark.logo === undefined
            ? entry.mark.color === undefined
              ? {}
              : { color: entry.mark.color }
            : { logo: entry.mark.logo })}
        />
        <div className="grid min-w-0 gap-0.5">
          <p className="text-body">{offerText(part.description, locale)}</p>
          <p className="text-caption text-muted-foreground">
            {t("connectionCatalogue.hosts", { hosts })}
          </p>
        </div>
      </div>
      {entry.parts.length > 1 ? (
        <RadioGroup<CataloguePartName>
          label={t("connectionCatalogue.partChoice")}
          variant="plain"
          value={part.part}
          onValueChange={onPartChange}
          options={entry.parts.map((candidate) => ({
            value: candidate.part,
            label: t(
              candidate.part === "tools"
                ? "connectionCatalogue.partTools"
                : "connectionCatalogue.partSource"
            )
          }))}
        />
      ) : null}
      {modes.length > 1 ? (
        <CredentialModeField value={mode} onChange={onModeChange} />
      ) : mode === "user" ? (
        <p className="text-caption text-muted-foreground" data-credential-mode="user">
          {t("personalConnections.modePersonalText")}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-1" data-catalogue-examples="">
        <span className="text-label">{t("connectionCatalogue.examples")}</span>
        <ul className="grid min-w-0 gap-1 text-body text-muted-foreground">
          {entry.examplePrompts.map((prompt) => {
            const text = offerText(prompt, locale);
            return <li key={text}>{text}</li>;
          })}
        </ul>
      </div>
      {part.prerequisites.length > 0 || oauth ? (
        <div className="grid min-w-0 gap-2" data-catalogue-checklist="">
          <span className="text-label">{t("connectionCatalogue.checklist")}</span>
          <ol className="grid min-w-0 list-decimal gap-2 pl-5 text-body">
            {part.prerequisites.map((line) => {
              const text = offerText(line.text, locale);
              return (
                <li key={text} className="min-w-0">
                  <span>{text}</span>
                  {line.value === undefined ? null : (
                    <CommandLine className="mt-1" command={line.value} label={text} />
                  )}
                </li>
              );
            })}
            {oauth ? (
              <li className="min-w-0" data-catalogue-redirect-uri={part.redirectUri ?? ""}>
                <span>{t("connectionCatalogue.redirectUri")}</span>
                {part.redirectUri === undefined ? (
                  <span className="block text-caption text-muted-foreground">
                    {t("connectionCatalogue.redirectUriMissing")}
                  </span>
                ) : (
                  <CommandLine
                    className="mt-1"
                    command={part.redirectUri}
                    label={t("connectionCatalogue.redirectUri")}
                  />
                )}
              </li>
            ) : null}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
