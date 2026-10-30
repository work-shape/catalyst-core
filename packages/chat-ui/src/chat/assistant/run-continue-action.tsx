import { useEffect, useState } from "react";
import { Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import {
  RATE_LIMIT_CONTINUE_WAIT_MS,
  type RunContinueOffer
} from "../workspace/workspace-chat-state";

/** The offer beside the notice, with the way to send the word the notice asks for. */
export interface RunContinue extends RunContinueOffer {
  /** False while the composer could not send either, such as while another run goes. */
  canSend: boolean;
  /** Sends the word the notice tells the person to write, as if they had written it. */
  send(): void;
}

/** The whole seconds left of the wait, never more than the wait itself where clocks differ. */
export function secondsUntil(readyAt: number, now: number): number {
  const left = Math.min(readyAt - now, RATE_LIMIT_CONTINUE_WAIT_MS);
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}

/**
 * The button on the notice of a rate-limited run (T6): it counts down the wait the notice names,
 * then sends "continue" once, the same message the person would write. Its key is the run, so a
 * later stop offers it again.
 */
export function RunContinueAction({ offer }: { offer: RunContinue }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [sent, setSent] = useState(false);
  const seconds = secondsUntil(offer.readyAt, now);
  const waiting = seconds > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid="run-continue"
      disabled={waiting || sent || !offer.canSend}
      onClick={() => {
        setSent(true);
        offer.send();
      }}
    >
      {waiting ? (
        // The notice is announced at once; the count changes every second and is not read out.
        <>
          <span className="sr-only">{t("runContinue")}</span>
          <span aria-hidden="true">{t("runContinueIn", { seconds })}</span>
        </>
      ) : (
        t("runContinue")
      )}
    </Button>
  );
}
