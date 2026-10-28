import { useEffect, useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  FormNotice,
  KeyValue,
  KeyValueList,
  RadioGroup,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationContextValue } from "../../shared/i18n";
import { instanceSentence } from "./build-refusals";
import {
  shareSubmitHeld,
  shareSubmitLabel,
  shareTargetValue,
  shareUsedTitle,
  type AssetShareCheck,
  type AssetShareCheckState,
  type AssetShareResult,
  type AssetShareSource,
  type AssetShareSubject,
  type AssetShareTarget
} from "./asset-share-model";

type Translate = TranslationContextValue["t"];

/**
 * What a move does, as the instance planned it: what goes along, what data and who reads it,
 * who uses and changes it afterwards, the rights that end, and what stops working. The dialog
 * shows it before the click, and the Inbox shows it to whoever decides a request.
 * `forCaller` says whether the reader is the one who shares: only then does it say whether
 * they still change it afterwards.
 */
export function AssetShareSummary({
  check,
  forCaller,
  confirmBreaks
}: {
  check: AssetShareCheck;
  forCaller: boolean;
  /** Under what breaks, for the reader who shares: the box that confirms it. */
  confirmBreaks?: ReactNode;
}) {
  const { t } = useTranslation();
  const [root, ...along] = check.moves;
  const team = check.afterwards.owner.workspaceName ?? t("build.placeOtherWorkspace");
  const toTeam = check.afterwards.owner.kind === "workspace";
  const { onAssets, runAccounts } = check.afterwards.grantsDropped;
  return (
    <div className="grid min-w-0 gap-4" data-share-summary="">
      <KeyValueList layout="stacked">
        <KeyValue label={t("share.moves")}>
          {along.length === 0 ? (
            <span data-share-moves="">{root?.title || check.asset.name}</span>
          ) : (
            <div className="grid gap-1" data-share-moves="">
              <span>{t("share.movesUses", { title: root?.title || check.asset.name })}</span>
              <ul className="list-disc pl-5">
                {along.map((entry) => (
                  <li key={`${entry.kind}:${entry.name}`}>{entry.title || entry.name}</li>
                ))}
              </ul>
            </div>
          )}
        </KeyValue>
        {check.data.length > 0 ? (
          <KeyValue label={t("share.data")}>
            <div className="grid gap-1" data-share-data="">
              {check.data.map((entry) => (
                <p key={entry.name}>{entry.sentence}</p>
              ))}
            </div>
          </KeyValue>
        ) : null}
        <KeyValue label={t("share.usersAfter")}>
          <span data-share-users="">
            {toTeam ? t("share.usersTeam", { team }) : t("share.usersAll")}
          </span>
        </KeyValue>
        <KeyValue label={t("share.editorsAfter")}>
          <div className="grid gap-1" data-share-editors="">
            <span>{toTeam ? t("share.editorsTeam", { team }) : t("share.editorsAll")}</span>
            {forCaller ? (
              <span>{t(check.afterwards.callerEdits ? "share.youEdit" : "share.youNoLonger")}</span>
            ) : null}
          </div>
        </KeyValue>
        {onAssets + runAccounts > 0 ? (
          <KeyValue label={t("share.grantsDropped")}>
            <div className="grid gap-1" data-share-grants={onAssets + runAccounts}>
              {onAssets > 0 ? <p>{grantsLine(onAssets, "assets", t)}</p> : null}
              {runAccounts > 0 ? <p>{grantsLine(runAccounts, "runAccounts", t)}</p> : null}
            </div>
          </KeyValue>
        ) : null}
      </KeyValueList>
      {check.breaks.length > 0 ? (
        <Banner tone="warning" role="note" title={t("share.breaksTitle")} data-share-breaks="">
          <div className="grid gap-2">
            <ul className="list-disc pl-5">
              {check.breaks.map((entry) => (
                <li key={`${entry.kind}:${entry.name}`}>
                  {t("share.breaksLine", {
                    title: entry.title || entry.name,
                    uses: shareUsedTitle(check, entry.uses)
                  })}
                </li>
              ))}
            </ul>
            {confirmBreaks}
          </div>
        </Banner>
      ) : null}
    </div>
  );
}

function grantsLine(count: number, of: "assets" | "runAccounts", t: Translate): string {
  if (of === "assets") {
    return count === 1
      ? t("share.grantsOnAssetsOne")
      : t("share.grantsOnAssets", { count: String(count) });
  }
  return count === 1
    ? t("share.grantsRunAccountsOne")
    : t("share.grantsRunAccounts", { count: String(count) });
}

/**
 * "Teilen mit…": the reader picks a rung above the asset, reads what the move does, confirms
 * what breaks, and shares, or sends a request where they lack the right at the target. A move
 * the instance refuses shows its sentence and cannot be sent.
 */
export function AssetShareDialog({
  open,
  subject,
  targets,
  initialTarget,
  source,
  onClose,
  onMoved
}: {
  open: boolean;
  subject: AssetShareSubject;
  /** The rungs above the asset; the first is chosen unless `initialTarget` names another. */
  targets: readonly AssetShareTarget[];
  initialTarget?: AssetShareTarget;
  source: AssetShareSource;
  onClose(): void;
  /** The asset moved: the page shows its new place. */
  onMoved(result: AssetShareResult, target: AssetShareTarget): void;
}) {
  const { t } = useTranslation();
  const first = initialTarget ?? targets[0];
  const [chosen, setChosen] = useState(first === undefined ? "" : shareTargetValue(first));
  const target = targets.find((candidate) => shareTargetValue(candidate) === chosen);
  const [state, setState] = useState<AssetShareCheckState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [breaksAccepted, setBreaksAccepted] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendFailure, setSendFailure] = useState<string>();
  const [requested, setRequested] = useState(false);

  // Each target is checked again when it is chosen: what moves and who decides depend on it.
  useEffect(() => {
    if (!open || target === undefined) return undefined;
    let current = true;
    setState({ status: "checking" });
    setBreaksAccepted(false);
    setSendFailure(undefined);
    source.check(subject, target).then(
      (check) => {
        if (current) setState({ status: "ready", check });
      },
      (error: unknown) => {
        if (!current) return;
        const message = instanceSentence(error, t);
        setState(message === undefined ? { status: "failed" } : { status: "refused", message });
      }
    );
    return () => {
      current = false;
    };
    // The subject and the source are the page's; a new target or a retry asks again.
  }, [open, chosen, attempt]);

  const send = async () => {
    if (target === undefined || state.status !== "ready") return;
    setSending(true);
    setSendFailure(undefined);
    try {
      const result = await source.move(subject, target, breaksAccepted);
      if (result.status === "moved") {
        onMoved(result, target);
        return;
      }
      setRequested(true);
    } catch (error) {
      setSendFailure(instanceSentence(error, t) ?? t("share.checkFailed"));
    } finally {
      setSending(false);
    }
  };

  const options = targets.map((candidate) => ({
    value: shareTargetValue(candidate),
    label: candidate.kind === "instance" ? t("build.placeAll") : candidate.name,
    description:
      candidate.kind === "instance"
        ? t("share.targetAllHint")
        : t("share.targetTeamHint", { team: candidate.name })
  }));

  return (
    <Dialog
      open={open}
      title={t("share.title", { title: subject.title })}
      description={requested ? undefined : t("share.description")}
      onClose={onClose}
      footer={
        requested ? (
          <Button type="button" onClick={onClose}>
            {t("share.close")}
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              loading={sending}
              disabled={shareSubmitHeld(state, breaksAccepted)}
              data-share-submit={state.status === "ready" ? state.check.path : ""}
              onClick={() => {
                send().catch(() => undefined);
              }}
            >
              {t(state.status === "ready" ? shareSubmitLabel(state.check) : "share.submitDirect")}
            </Button>
          </>
        )
      }
    >
      {requested ? (
        <Banner tone="success" data-share-requested="">
          {t("share.requested")}
        </Banner>
      ) : (
        <div className="grid min-w-0 gap-5" data-share-dialog="">
          {options.length > 1 ? (
            <RadioGroup
              label={t("share.target")}
              options={options}
              value={chosen}
              onValueChange={setChosen}
            />
          ) : (
            <KeyValueList layout="stacked">
              <KeyValue label={t("share.target")}>
                <span data-share-target="">{options[0]?.label}</span>
              </KeyValue>
            </KeyValueList>
          )}
          {state.status === "checking" ? (
            <div aria-busy="true" aria-label={t("share.checking")}>
              <SkeletonList rows={3} />
            </div>
          ) : state.status === "refused" ? (
            <FormNotice tone="error" data-share-refused="">
              {state.message}
            </FormNotice>
          ) : state.status === "failed" ? (
            <FormNotice tone="error" data-share-failed="">
              {t("share.checkFailed")}{" "}
              <Button
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => setAttempt((count) => count + 1)}
              >
                {t("tryAgain")}
              </Button>
            </FormNotice>
          ) : (
            <>
              <AssetShareSummary
                check={state.check}
                forCaller
                confirmBreaks={
                  <Checkbox
                    label={t("share.breaksConfirm")}
                    checked={breaksAccepted}
                    onCheckedChange={setBreaksAccepted}
                    data-share-accept-breaks=""
                  />
                }
              />
              {state.check.path === "request" ? (
                <Banner layout="line" data-share-request="">
                  {t("share.request")}
                </Banner>
              ) : null}
            </>
          )}
          {sendFailure === undefined ? null : (
            <FormNotice tone="error" data-share-send-failed="">
              {sendFailure}
            </FormNotice>
          )}
        </div>
      )}
    </Dialog>
  );
}
