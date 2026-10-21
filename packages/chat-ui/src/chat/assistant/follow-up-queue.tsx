import { useComposerRuntime } from "@assistant-ui/react";
import type { FollowUpMode } from "@work-shape/catalyst-api-client";
import { Pencil, X } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Button,
  ComposerFrame,
  ConfirmDialog,
  IconButton,
  InlineError,
  List,
  ListRow,
  Spinner
} from "@work-shape/catalyst-ui";
import {
  composerTextAfterEdit,
  type FollowUpQueueItem,
  type FollowUpQueuePhase
} from "../conversation/follow-up-queue-state";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";

/** The open conversation's queue of follow-up messages and what the reader may do with it. */
export interface FollowUpQueueModel {
  /** Pending messages, oldest first. */
  items: readonly FollowUpQueueItem[];
  /** What Enter does with the reader's message during a run; the modifier does the other. */
  mode: FollowUpMode;
  /** A run goes and the reader started it: only then does a steer reach it. */
  ownRun: boolean;
  phase: FollowUpQueuePhase;
  /** Messages whose withdrawal or steer is on its way. */
  withdrawingIds: ReadonlySet<string>;
  /** A message is on its way into the queue. */
  queueing: boolean;
  /** Send now is on its way. */
  dispatching: boolean;
  /** What went wrong with the reader's last action on the queue. */
  error: string | undefined;
  /**
   * Puts a message into the queue, or steers the reader's own run with it; `onQueued` runs once
   * the server holds it. The server queues a steer it cannot deliver.
   */
  queue(text: string, onQueued: () => void, mode?: FollowUpMode): void;
  /**
   * Hands the reader's queued message to their own running turn, which reads it after its
   * current step. Where the server refuses, it stays queued and the error says why.
   */
  steer(id: string): void;
  /** Takes the reader's own message out of the queue; `onWithdrawn` gets its text back. */
  withdraw(id: string, onWithdrawn?: (text: string) => void): void;
  /** Takes all of the reader's messages out of the queue; `onDone` runs once each is answered. */
  discardOwn(onDone: () => void): void;
  /** Starts the oldest message now, while no run goes. Only its author may. */
  sendNow(): void;
}

const FollowUpQueueContext = createContext<FollowUpQueueModel | undefined>(undefined);

export function FollowUpQueueProvider({
  value,
  children
}: {
  value: FollowUpQueueModel | undefined;
  children: ReactNode;
}) {
  return <FollowUpQueueContext.Provider value={value}>{children}</FollowUpQueueContext.Provider>;
}

/** The queue of the open conversation; undefined where no conversation is open yet. */
export function useFollowUpQueue(): FollowUpQueueModel | undefined {
  return useContext(FollowUpQueueContext);
}

/** The queued messages above the composer. Renders nothing while the queue is empty. */
export function FollowUpQueue() {
  const queue = useFollowUpQueue();
  const composer = useComposerRuntime();
  const { t } = useTranslation();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  if (!queue || (queue.items.length === 0 && queue.error === undefined)) {
    return null;
  }
  const ownItems = queue.items.filter((item) => item.own);
  const paused = queue.phase === "paused";
  // Only the author of the oldest message may start it.
  const nextIsOwn = queue.items[0]?.own === true;
  // Where every message steers, none waits for the end of the answer.
  const allSteer = queue.items.length > 0 && queue.items.every((item) => item.steering);
  // A queued message of the reader's may still steer the run they started (FU-2).
  const canSteer = (item: FollowUpQueueItem) =>
    item.own && !item.steering && queue.ownRun && queue.phase === "waiting";

  const edit = (item: FollowUpQueueItem) =>
    queue.withdraw(item.id, (text) =>
      composer.setText(composerTextAfterEdit(composer.getState().text, text))
    );
  const discard = () => {
    setDiscarding(true);
    queue.discardOwn(() => {
      setDiscarding(false);
      setConfirmDiscard(false);
    });
  };

  return (
    <ComposerFrame variant="tray" asChild className="grid gap-1">
      <section aria-label={t("followUpQueueLabel")} data-follow-up-queue={queue.phase}>
        {queue.items.length > 0 ? (
          <>
            {/* The title keeps its line. The hint wraps beside it, or goes below it where the two
              do not fit, and so do the actions. */}
            <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-2">
              <span className="shrink-0 text-label whitespace-nowrap text-foreground">
                {paused ? t("followUpPaused") : t(allSteer ? "followUpSteering" : "followUpQueued")}
              </span>
              <QueueHint phase={queue.phase} allSteer={allSteer} t={t} />
              {paused && ownItems.length > 0 ? (
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={queue.dispatching}
                    onClick={() => setConfirmDiscard(true)}
                  >
                    {t("followUpDiscard")}
                  </Button>
                  {nextIsOwn ? (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={queue.dispatching}
                      onClick={queue.sendNow}
                    >
                      {t("followUpSendNow")}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </div>
            <List>
              {queue.items.map((item, index) => (
                <ListRow
                  key={item.id}
                  size="compact"
                  title={item.text}
                  description={itemDescription(item, t, {
                    // Where Send now is missing, the oldest row says why.
                    sendsNowOnlyByAuthor: paused && index === 0,
                    // Beside queued messages, a steer says it is read sooner.
                    mixed: !allSteer
                  })}
                  descriptionWraps
                  actionsVisible
                  actions={
                    item.own ? (
                      <>
                        {canSteer(item) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={t("followUpSteerNowTitle")}
                            disabled={queue.withdrawingIds.has(item.id)}
                            onClick={() => queue.steer(item.id)}
                          >
                            {t("followUpSteerNow")}
                          </Button>
                        ) : null}
                        <IconButton
                          label={t("followUpEdit")}
                          size="sm"
                          disabled={queue.withdrawingIds.has(item.id)}
                          onClick={() => edit(item)}
                        >
                          <Pencil aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          label={t("followUpRemove")}
                          size="sm"
                          disabled={queue.withdrawingIds.has(item.id)}
                          onClick={() => queue.withdraw(item.id)}
                        >
                          <X aria-hidden="true" />
                        </IconButton>
                      </>
                    ) : undefined
                  }
                />
              ))}
            </List>
          </>
        ) : null}
        {queue.error === undefined ? null : <InlineError>{queue.error}</InlineError>}
        {ownItems.length > 0 ? (
          <ConfirmDialog
            open={confirmDiscard}
            title={t("followUpDiscardTitle")}
            confirmLabel={t("followUpDiscard")}
            loading={discarding}
            onConfirm={discard}
            onClose={() => setConfirmDiscard(false)}
          >
            {ownItems.length === 1
              ? t("followUpDiscardBodyOne")
              : t("followUpDiscardBody", { count: ownItems.length })}
          </ConfirmDialog>
        ) : null}
      </section>
    </ComposerFrame>
  );
}

/** What the queue waits for. Why it paused is the run's own notice, right above it. */
function QueueHint({
  phase,
  allSteer,
  t
}: {
  phase: FollowUpQueuePhase;
  allSteer: boolean;
  t: TranslationContextValue["t"];
}) {
  return (
    <span className="flex min-w-0 flex-1 basis-48 items-center gap-1.5 text-caption text-muted-foreground">
      {phase === "sending" ? <Spinner size="xs" className="shrink-0" /> : null}
      <span className="min-w-0">
        {t(phase === "waiting" && allSteer ? "followUpSteeringHint" : QUEUE_HINTS[phase])}
      </span>
    </span>
  );
}

const QUEUE_HINTS = {
  waiting: "followUpWaitingHint",
  sending: "followUpSending",
  // A message sent meanwhile starts at once, and the queue goes on after its answer.
  paused: "followUpPausedHint"
} as const;

function itemDescription(
  item: FollowUpQueueItem,
  t: TranslationContextValue["t"],
  { sendsNowOnlyByAuthor, mixed }: { sendsNowOnlyByAuthor: boolean; mixed: boolean }
): string | undefined {
  if (item.steering) {
    return mixed ? t("followUpSteerPending") : undefined;
  }
  if (item.own) {
    return undefined;
  }
  const author =
    item.authorLabel === undefined
      ? t("followUpFromMember")
      : t("followUpFrom", { name: item.authorLabel });
  return sendsNowOnlyByAuthor ? `${author} · ${t("followUpOnlyAuthorSends")}` : author;
}
