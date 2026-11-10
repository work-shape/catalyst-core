import { useState } from "react";
import { Banner, Button, Dialog } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import type { BuildCreateDialogProps } from "./build-asset-kind";
import { ConnectionApprovalList, approveLabel, useApprovalChoice } from "./connection-approval";
import { selectedCandidates, type ApprovalCandidate } from "./connection-approval-model";
import { withApprovedOperations } from "./connection-form-model";
import { ConnectionApprovedBody, useGiveToAgent } from "./connection-give-step";
import type { ConnectionReadyOutcome } from "./connection-ready";
import { approvalRefusals, type ApprovalRefused } from "./connection-refusals";
import { ApprovalRefusals } from "./connection-rest-tools";
import type { ConnectionSource } from "./connection-source";
import { TypedConnectionCreate, type TypedConnected } from "./connection-typed-create";
import {
  offerText,
  typedCandidates,
  typedSurfaces,
  type ConnectorTypeOffer,
  type TypedValues
} from "./connection-typed-model";
import { RefusalDetail } from "./refusal-notice";

// A Connector type with a form and a catalog of its own, such as a mailbox: the form, then
// its operations to approve, then the give to an agent. Its reading operations start ticked
// and the "may use" row offers only where the type allows, such as agents alone for a type
// whose results only its caller may read. Who may use the Connection is chosen on its page,
// under the type's sentence of what everyone who may reads. A type without a catalog, such as
// a document source, opens the Connection's page once it connected.

/** The section of the Connection's page that names who may use it. */
const ACCESS_SECTION = "access";

/** The exposure that lets agents call an approved operation. */
const AGENT_SURFACE = "agent";

type Stage =
  | { step: "prepare" }
  | { step: "review"; connected: TypedConnected; candidates: ApprovalCandidate[] }
  | { step: "approved"; connected: TypedConnected; count: number; gives: boolean }
  | { step: "give"; connected: TypedConnected; count: number; gives: boolean };

export function TypedConnectionSetup({
  offer,
  source,
  checkName,
  put,
  onBack,
  onClose,
  onCreated,
  initial,
  defaults,
  onApproved
}: Pick<BuildCreateDialogProps, "checkName" | "put" | "onClose" | "onCreated"> & {
  offer: ConnectorTypeOffer;
  source: ConnectionSource;
  onBack(): void;
  /** The name and id an agent proposed (CHAT-CONN-1): the form starts with them. */
  initial?: { title: string; name: string };
  /** What the fields start with, by position, such as the settings a proposal named. */
  defaults?: TypedValues;
  /** The tools were approved, for the conversation whose agent proposed the Connection. */
  onApproved?(
    connection: { name: string; title: string },
    outcome: Extract<ConnectionReadyOutcome, { kind: "approved" }>
  ): void;
}) {
  const { locale, t } = useTranslation();
  const [stage, setStage] = useState<Stage>({ step: "prepare" });
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<ApprovalRefused>();
  const approval = useApprovalChoice([]);
  const surfaces = typedSurfaces(offer);
  const connected = stage.step === "prepare" ? undefined : stage.connected;
  const done = stage.step === "approved" || stage.step === "give" ? stage : undefined;
  const give = useGiveToAgent({
    host: source.give,
    enabled: stage.step === "give",
    connection: connected?.name ?? "",
    connectionTitle: connected?.title ?? "",
    onBack: () => done && setStage({ ...done, step: "approved" }),
    onClose: () => onCreated(connected?.name ?? "")
  });

  if (stage.step === "prepare") {
    return (
      <TypedConnectionCreate
        offer={offer}
        source={source}
        checkName={checkName}
        put={put}
        onBack={onBack}
        onClose={onClose}
        onCreated={onCreated}
        {...(initial === undefined ? {} : { initial })}
        {...(defaults === undefined ? {} : { defaults })}
        {...(offer.operations.length === 0
          ? {}
          : {
              onConnected: (made: TypedConnected) => {
                const candidates = typedCandidates(offer);
                approval.reset(candidates);
                approval.setSurfaces(
                  new Set(surfaces.filter((surface) => surface === AGENT_SURFACE))
                );
                setRefusals(undefined);
                setStage({ step: "review", connected: made, candidates });
              }
            })}
      />
    );
  }

  const name = stage.connected.name;

  /** One write of the definition with the approved operations. */
  const approve = async (review: Extract<Stage, { step: "review" }>) => {
    const chosen = selectedCandidates(
      review.candidates,
      approval.choice.selected,
      approval.choice.effects
    );
    const chosenSurfaces = [...approval.choice.surfaces].filter((surface) =>
      surfaces.includes(surface)
    );
    const config = withApprovedOperations(review.connected.config, chosen, chosenSurfaces);
    setBusy(true);
    setRefusals(undefined);
    try {
      const { revision } = await put({
        name,
        config,
        expectedRevision: review.connected.revision
      });
      setBusy(false);
      onApproved?.(
        { name, title: review.connected.title },
        {
          kind: "approved",
          tools: chosen.map((operation) => operation.name),
          surfaces: chosenSurfaces
        }
      );
      setStage({
        step: "approved",
        connected: { ...review.connected, config, revision },
        count: chosen.length,
        gives: source.give !== undefined && chosenSurfaces.includes(AGENT_SURFACE)
      });
    } catch (error) {
      setBusy(false);
      setRefusals(approvalRefusals(error, config, t, locale));
    }
  };

  const openAccess = () =>
    onCreated(name, () =>
      document.getElementById(ACCESS_SECTION)?.scrollIntoView({ block: "start" })
    );

  return (
    <Dialog
      open
      title={stage.step === "give" ? give.title : t("connectionCreate.approveHeading")}
      onClose={() => {
        if (!busy && !give.busy) onCreated(name);
      }}
      footer={footer()}
    >
      {body()}
    </Dialog>
  );

  function body() {
    switch (stage.step) {
      case "review":
        return (
          <div className="grid min-w-0 gap-4" data-connection-typed-review={offer.type}>
            <Banner layout="line" tone="success" data-connection-connected="">
              {t("connectionTyped.connected", { name: stage.connected.title })}
            </Banner>
            <p className="text-body text-muted-foreground">{t("connectionTyped.reviewIntro")}</p>
            <ConnectionApprovalList
              candidates={stage.candidates}
              choice={approval.choice}
              onSelectedChange={approval.setSelected}
              onSurfacesChange={approval.setSurfaces}
              surfaces={surfaces}
              disabled={busy}
            />
            {refusals ? <ApprovalRefusals refusals={refusals.refusals} /> : null}
            <RefusalDetail detail={refusals?.detail} untold={refusals?.untold ?? false} />
          </div>
        );
      case "approved":
        return (
          <div className="grid min-w-0 gap-4">
            <ConnectionApprovedBody
              count={stage.count}
              {...(stage.gives ? { onGive: () => setStage({ ...stage, step: "give" }) } : {})}
            />
            <div className="grid min-w-0 gap-1" data-connection-who-uses="">
              {offer.sharedAccountNote === undefined ? null : (
                <p className="text-body" data-connection-shared-note="">
                  {offerText(offer.sharedAccountNote, locale)}
                </p>
              )}
              <p className="text-body text-muted-foreground">
                {t("connectionTyped.whoUses")}{" "}
                <Button
                  variant="link"
                  size="sm"
                  data-connection-who-uses-open=""
                  onClick={openAccess}
                >
                  {t("connectionTyped.whoUsesLink")}
                </Button>
              </p>
            </div>
          </div>
        );
      case "give":
        return give.body;
    }
  }

  function footer() {
    switch (stage.step) {
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
      case "approved":
        return (
          <Button data-connection-approved-done="" onClick={() => onCreated(name)}>
            {t("connectionGive.done")}
          </Button>
        );
      case "give":
        return give.footer;
    }
  }
}
