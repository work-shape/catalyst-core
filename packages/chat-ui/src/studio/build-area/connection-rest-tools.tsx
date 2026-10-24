import { ChevronRight, ClipboardPaste, Sparkles } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import {
  Button,
  Card,
  CardTarget,
  Dialog,
  Field,
  FormNotice,
  IconButton,
  IconTile,
  Textarea
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import type { BuildAsset, BuildAssetEditorProps } from "./build-asset-kind";
import { ConnectionApprovalList, approveLabel, useApprovalChoice } from "./connection-approval";
import {
  pastedCandidates,
  selectedCandidates,
  type ApprovalCandidate,
  type PasteIssue
} from "./connection-approval-model";
import { useOpenedConnectionDraft, type ConnectionDraft } from "./connection-draft";
import { connectionConfigToForm, withApprovedOperations } from "./connection-form-model";
import type { ConnectionSource } from "./connection-source";
import { connectionReadyMessage } from "./connection-ready";
import {
  ConnectionApprovedBody,
  useGiveToAgent,
  type ConnectionGiveHost
} from "./connection-give-step";

// How the operations of a REST API come in: it names none itself, so a person pastes them as
// YAML, or asks the agent beside the page to draft them from the API's description. Either way
// they reach the approval list, and the person's confirmation is the save.

/** One way to add tools, as a card that opens as a whole. */
export function ChoiceCard({
  icon,
  title,
  text,
  onChoose,
  ...data
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onChoose(): void;
  [data: `data-${string}`]: string;
}) {
  return (
    <Card padding="md" className="flex min-w-0 items-center gap-3 p-3" {...data}>
      <IconTile size="lg">{icon}</IconTile>
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-label">{title}</span>
        <span className="text-caption text-muted-foreground">{text}</span>
      </div>
      <CardTarget label={title}>
        <IconButton label={title} onClick={onChoose}>
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </CardTarget>
    </Card>
  );
}

/** The two ways to add the tools of a REST API. Without a chat beside the page only pasting. */
export function AddToolsChoices({
  onPaste,
  onDraft
}: {
  onPaste(): void;
  /** Absent where the page has no chat to draft in. */
  onDraft?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-2" data-connection-add-tools="">
      {onDraft ? (
        <ChoiceCard
          icon={<Sparkles aria-hidden="true" />}
          title={t("connectionCreate.draftTitle")}
          text={t("connectionCreate.draftText")}
          onChoose={onDraft}
          data-connection-draft=""
        />
      ) : null}
      <ChoiceCard
        icon={<ClipboardPaste aria-hidden="true" />}
        title={t("connectionCreate.pasteTitle")}
        text={t("connectionCreate.pasteText")}
        onChoose={onPaste}
        data-connection-paste=""
      />
    </div>
  );
}

/** What is wrong with a pasted text, in the reader's language. */
function pasteIssueText(issue: PasteIssue, t: TranslationContextValue["t"]): string {
  switch (issue.kind) {
    case "yaml":
      return issue.line === undefined
        ? t("connectionCreate.pasteYaml", { message: issue.message })
        : t("connectionCreate.pasteYamlLine", { line: issue.line, message: issue.message });
    case "shape":
      return t("connectionCreate.pasteShape");
    case "unnamed":
      return t("connectionCreate.pasteUnnamed", { index: issue.index });
    case "duplicate":
      return t("connectionCreate.pasteDuplicate", { name: issue.name });
    case "empty":
      return t("connectionCreate.pasteEmpty");
  }
}

/** The field the YAML is pasted into, with what is wrong with it. */
export function PasteToolsField({
  value,
  error,
  onChange
}: {
  value: string;
  error: string | undefined;
  onChange(value: string): void;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t("connectionCreate.pasteField")}
      hint={t("connectionCreate.pasteHint")}
      error={error}
    >
      <Textarea
        variant="code"
        rows={12}
        autoFocus
        spellCheck={false}
        value={value}
        data-connection-paste-field=""
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** Reads the pasted text: the rows of the list, or what is wrong, in the reader's language. */
export function readPaste(
  text: string,
  t: TranslationContextValue["t"]
): { candidates: ApprovalCandidate[] } | { error: string } {
  const read = pastedCandidates(text);
  return read.ok ? { candidates: read.candidates } : { error: pasteIssueText(read.issue, t) };
}

/**
 * The page's way to add the tools of a REST API: pasted, the YAML, then the approval list, then
 * one save of the definition through the page. With `drafted`, the agent's draft from its card,
 * it opens at the list, and discarding the draft closes it.
 */
function AddToolsDialog({
  name,
  title,
  drafted,
  give: giveHost,
  tell,
  onClose,
  approve
}: {
  /** The Connection's id. */
  name: string;
  /** The Connection's own title: a draft's intro names it, never the agent's title. */
  title: string;
  drafted?: ConnectionDraft;
  /** Gives the approved tools to an agent from the done state (CS-5d). */
  give?: ConnectionGiveHost;
  /**
   * Tells the conversation whose card opened the draft, as the person, once the tools are
   * approved (CHAT-CONN-1), so its agent goes on. Absent for a draft opened from elsewhere.
   */
  tell?: (text: string) => Promise<void>;
  onClose(): void;
  /** Saves the approved operations with the surfaces. Answers what refused them, or nothing. */
  approve(
    approved: ApprovalCandidate[],
    surfaces: readonly string[]
  ): Promise<string[] | undefined>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [pasteError, setPasteError] = useState<string>();
  const [candidates, setCandidates] = useState<ApprovalCandidate[] | undefined>(
    drafted?.operations
  );
  const [saving, setSaving] = useState(false);
  const [refusals, setRefusals] = useState<string[]>();
  /** Approved: how many, and whether the steps of the give are open. */
  const [approved, setApproved] = useState<{ count: number; giving: boolean }>();
  const approval = useApprovalChoice(drafted?.operations ?? []);
  const chosen = candidates ? selectedCandidates(candidates, approval.choice.selected) : [];
  // The conversation hears once, and only of tools that were saved.
  const told = useRef(false);
  const give = useGiveToAgent({
    host: giveHost,
    enabled: approved?.giving === true,
    connection: name,
    connectionTitle: title,
    onBack: () => setApproved((current) => current && { ...current, giving: false }),
    onClose
  });

  const review = () => {
    const read = readPaste(text, t);
    if ("error" in read) {
      setPasteError(read.error);
      return;
    }
    setPasteError(undefined);
    setCandidates(read.candidates);
    approval.reset(read.candidates);
  };
  const save = () => {
    setSaving(true);
    setRefusals(undefined);
    const surfaces = [...approval.choice.surfaces];
    approve(chosen, surfaces)
      .then((refused) => {
        if (refused !== undefined) {
          setRefusals(refused);
          return;
        }
        if (tell && !told.current) {
          told.current = true;
          const tools = chosen.map((operation) => operation.name);
          tell(
            connectionReadyMessage({ name, title }, { kind: "approved", tools, surfaces }, t)
          ).catch(() => undefined);
        }
        // Where agents may use them, the done state offers them to one.
        if (giveHost && surfaces.includes("agent"))
          setApproved({ count: chosen.length, giving: false });
        else onClose();
      })
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };

  if (approved) {
    return (
      <Dialog
        open
        title={approved.giving ? give.title : t("connectionCreate.approveHeading")}
        onClose={() => {
          if (!give.busy) onClose();
        }}
        footer={
          approved.giving ? (
            give.footer
          ) : (
            <Button data-connection-approved-done="" onClick={onClose}>
              {t("connectionGive.done")}
            </Button>
          )
        }
      >
        {approved.giving ? (
          give.body
        ) : (
          <ConnectionApprovedBody
            count={approved.count}
            onGive={() => setApproved({ ...approved, giving: true })}
          />
        )}
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={t(candidates ? "connectionCreate.approveHeading" : "connectionCreate.pasteHeading")}
      onClose={onClose}
      footer={
        candidates ? (
          <>
            <Button
              variant="outline"
              disabled={saving}
              data-connection-discard=""
              onClick={() => (drafted ? onClose() : setCandidates(undefined))}
            >
              {t("connectionCreate.discard")}
            </Button>
            <Button
              loading={saving}
              disabled={chosen.length === 0}
              data-connection-approve=""
              onClick={save}
            >
              {approveLabel(chosen.length, t)}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t("connectionCreate.cancel")}
            </Button>
            <Button disabled={text.trim() === ""} data-connection-paste-check="" onClick={review}>
              {t("connectionCreate.pasteCheck")}
            </Button>
          </>
        )
      }
    >
      {candidates ? (
        <div className="grid min-w-0 gap-4">
          {drafted ? (
            <p className="text-body text-muted-foreground" data-connection-drafted="">
              {t("connectionCreate.draftedIntro", { title })}
            </p>
          ) : null}
          <ConnectionApprovalList
            candidates={candidates}
            choice={approval.choice}
            onSelectedChange={approval.setSelected}
            onSurfacesChange={approval.setSurfaces}
            declared
            {...(drafted ? {} : { source: text })}
            disabled={saving}
          />
          {refusals ? <ApprovalRefusals refusals={refusals} /> : null}
        </div>
      ) : (
        <PasteToolsField value={text} error={pasteError} onChange={setText} />
      )}
    </Dialog>
  );
}

/** Why the instance did not take the approved tools: each sentence as it said it. */
export function ApprovalRefusals({ refusals }: { refusals: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <FormNotice tone="error" data-connection-approve-refused="">
      <span className="grid gap-1">
        <span>{t("connectionCreate.approveRefused")}</span>
        {refusals.map((refusal, index) => (
          <span key={index} className="break-words">
            {refusal}
          </span>
        ))}
      </span>
    </FormNotice>
  );
}

/**
 * The tools of a REST API on its page: pasted as YAML into the approval list, or drafted by the
 * agent in the chat beside the page, whose card opens the list here with its draft. Nothing is
 * saved before the person approves.
 */
export function RestToolsSection({
  asset,
  frame,
  source,
  written
}: {
  asset: BuildAsset;
  frame: BuildAssetEditorProps;
  source: ConnectionSource;
  written(): void;
}) {
  const { t } = useTranslation();
  const [pasting, setPasting] = useState(false);
  const opened = useOpenedConnectionDraft(asset.name);
  const { config } = asset;
  const title =
    typeof config.displayName === "string" && config.displayName !== ""
      ? config.displayName
      : asset.name;
  const baseUrl = connectionConfigToForm(config).url;
  const startChat = source.draftInChat;
  // Only a draft opened from a card in this tab names the conversation it came from.
  const from = opened.draft?.from;
  const tellConversation = source.tellConversation;
  return (
    <>
      <AddToolsChoices
        onPaste={() => setPasting(true)}
        {...(startChat
          ? {
              onDraft: () =>
                startChat(
                  t("connectionCreate.draftRequest", { title, name: asset.name, url: baseUrl })
                )
            }
          : {})}
      />
      {pasting || opened.draft ? (
        <AddToolsDialog
          // A draft opened over a paste in progress, or over an earlier draft, starts its own
          // dialog.
          key={opened.draft ? `drafted:${opened.arrival}` : "pasted"}
          name={asset.name}
          title={title}
          {...(opened.draft ? { drafted: opened.draft } : {})}
          {...(source.give ? { give: source.give } : {})}
          {...(from && tellConversation
            ? { tell: (text: string) => tellConversation(from, text) }
            : {})}
          onClose={() => {
            setPasting(false);
            opened.close();
          }}
          approve={async (approved, surfaces) => {
            const outcome = await frame.save(
              withApprovedOperations(asset.config, approved, surfaces)
            );
            if (outcome.ok) {
              written();
              return undefined;
            }
            // A conflict is told by the frame's notice above the page.
            return outcome.conflict
              ? [t("connections.writeFailed")]
              : outcome.refusals.map((refusal) => refusal.message);
          }}
        />
      ) : null}
    </>
  );
}
