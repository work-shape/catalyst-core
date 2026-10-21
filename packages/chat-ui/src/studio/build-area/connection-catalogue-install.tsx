import { useState } from "react";
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
import { ConnectionApprovalList, approveLabel, useApprovalChoice } from "./connection-approval";
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
import { withApprovedOperations } from "./connection-form-model";
import { ConnectionApprovedBody, useGiveToAgent } from "./connection-give-step";
import { approvalRefusals, type ApprovalRefused } from "./connection-refusals";
import { ApprovalRefusals } from "./connection-rest-tools";
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

/** The exposure that lets agents call an approved operation. */
const AGENT_SURFACE = "agent";

type Stage =
  | { step: "prepare" }
  | { step: "review"; connected: TypedConnected; candidates: ApprovalCandidate[] }
  | { step: "approved"; name: string; title: string; count: number }
  | { step: "give"; name: string; title: string; count: number };

export function CatalogueInstall({
  entry,
  source,
  checkName,
  put,
  onBack,
  onClose,
  onCreated
}: Pick<BuildCreateDialogProps, "checkName" | "put" | "onClose" | "onCreated"> & {
  entry: CatalogueEntryOffer;
  source: ConnectionSource;
  onBack(): void;
}) {
  const { locale, t } = useTranslation();
  const [partName, setPartName] = useState<CataloguePartName | undefined>(entry.parts[0]?.part);
  const [stage, setStage] = useState<Stage>({ step: "prepare" });
  const [busy, setBusy] = useState(false);
  const [refusals, setRefusals] = useState<ApprovalRefused>();
  const approval = useApprovalChoice([]);
  const part = entry.parts.find((candidate) => candidate.part === partName);
  const title = offerText(entry.title, locale);
  const given = stage.step === "approved" || stage.step === "give" ? stage : undefined;
  const give = useGiveToAgent({
    host: source.give,
    enabled: stage.step === "give",
    connection: given?.name ?? "",
    connectionTitle: given?.title ?? "",
    onBack: () => given && setStage({ ...given, step: "approved" }),
    onClose: () => onCreated(given?.name ?? "")
  });
  if (part === undefined) return null;

  const enterReview = (connected: TypedConnected) => {
    const candidates = partCandidates(part);
    approval.reset(candidates);
    setRefusals(undefined);
    setStage({ step: "review", connected, candidates });
  };

  /** One write of the definition with the operations the admin approved. */
  const approve = async (review: Extract<Stage, { step: "review" }>) => {
    const { connected, candidates } = review;
    const chosen = selectedCandidates(
      candidates,
      approval.choice.selected,
      approval.choice.effects
    );
    const surfaces = [...approval.choice.surfaces];
    const config = withApprovedOperations(connected.config, chosen, surfaces);
    setBusy(true);
    setRefusals(undefined);
    try {
      await put({ name: connected.name, config, expectedRevision: connected.revision });
      setBusy(false);
      if (source.give && surfaces.includes(AGENT_SURFACE)) {
        setStage({
          step: "approved",
          name: connected.name,
          title: connected.title,
          count: chosen.length
        });
      } else {
        onCreated(connected.name);
      }
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
            <CatalogueIntro entry={entry} part={part} onPartChange={(next) => setPartName(next)} />
          ),
          note: (
            <Banner layout="line" data-catalogue-shared-note="">
              {offerText(part.sharedAccountNote, locale)}
            </Banner>
          )
        }}
        onConnected={(connected) => {
          if (part.operations.length === 0) {
            onCreated(connected.name);
            return;
          }
          enterReview(connected);
        }}
      />
    );
  }

  const name = stage.step === "review" ? stage.connected.name : stage.name;
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
      case "prepare":
        return null;
      case "review":
        return (
          <div className="grid min-w-0 gap-4" data-catalogue-review="">
            <Banner layout="line" tone="success" data-connection-connected="">
              {t("connectionCatalogue.connected", { name: stage.connected.title })}
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
            />
            {refusals ? <ApprovalRefusals refusals={refusals.refusals} /> : null}
            <RefusalDetail detail={refusals?.detail} />
          </div>
        );
      case "approved":
        return (
          <ConnectionApprovedBody
            count={stage.count}
            onGive={() => setStage({ ...stage, step: "give" })}
          />
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

/** Above the fields: the mark, what the part does, the part to install, prompts, checklist. */
function CatalogueIntro({
  entry,
  part,
  onPartChange
}: {
  entry: CatalogueEntryOffer;
  part: CataloguePartOffer;
  onPartChange(part: CataloguePartName): void;
}) {
  const { locale, t } = useTranslation();
  const title = offerText(entry.title, locale);
  const hosts = new Intl.ListFormat(locale, { type: "conjunction" }).format(part.hosts);
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
      <div className="grid min-w-0 gap-1" data-catalogue-examples="">
        <span className="text-label">{t("connectionCatalogue.examples")}</span>
        <ul className="grid min-w-0 gap-1 text-body text-muted-foreground">
          {entry.examplePrompts.map((prompt) => {
            const text = offerText(prompt, locale);
            return <li key={text}>{text}</li>;
          })}
        </ul>
      </div>
      {part.prerequisites.length > 0 ? (
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
          </ol>
        </div>
      ) : null}
    </div>
  );
}
