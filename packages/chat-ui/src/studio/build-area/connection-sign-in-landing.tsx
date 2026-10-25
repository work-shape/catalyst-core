import { useEffect, useState } from "react";
import {
  CONNECTION_OAUTH_ADMIN_CONSENTED,
  CONNECTION_OAUTH_CONNECTED
} from "@work-shape/catalyst-core";
import { Banner, Button } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { SIGN_IN_CHANNEL, readSignInLanding, type SignInLanding } from "./connection-sign-in-model";
import { useSignInFailureText } from "./connection-sign-in";

// The page a sign-in lands on in the tab the provider sent back (CS-4b4). The instance's
// callback has kept the code and the state and sends the tab here with the outcome and the
// Connection's name alone. The page takes even those out of the address, tells the tab that
// waits on the channel of the origin, and closes itself after a sign-in where the browser
// allows it. It shows no text of the address: the outcome picks one of the instance's own
// sentences, and anything it does not know is "did not work". An administrator back from the
// admin-consent link (MS-APP-2) reads that people can connect now, signed in or not.

/** The landing the address of this tab holds, read once when the app starts. */
export function useSignInLanding(): [SignInLanding | undefined, () => void] {
  const [landing, setLanding] = useState(() =>
    typeof window === "undefined" ? undefined : readSignInLanding(window.location)
  );
  return [landing, () => setLanding(undefined)];
}

export function ConnectionSignInLanding({
  landing,
  onOpen
}: {
  landing: SignInLanding;
  /** Leaves the landing for the Connection's page, or the list where no name came with it. */
  onOpen(connection: string | undefined): void;
}) {
  const { t } = useTranslation();
  const failureText = useSignInFailureText();
  const connected = landing.outcome === CONNECTION_OAUTH_CONNECTED;
  const approved = landing.outcome === CONNECTION_OAUTH_ADMIN_CONSENTED;

  useEffect(() => {
    // The address keeps the path and loses the outcome: a reload shows the list.
    window.history.replaceState(window.history.state, "", window.location.pathname);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
      channel.postMessage(landing);
      channel.close();
    }
    // A tab the instance opened for the sign-in closes; another stays and says it.
    if (connected) window.close();
  }, [connected, landing]);

  return (
    <div
      className="grid min-h-dvh w-full place-items-center bg-background p-4 text-foreground"
      data-sign-in-landing={landing.outcome}
    >
      <div className="grid w-full max-w-md gap-4">
        {landing.outcome === CONNECTION_OAUTH_CONNECTED ? (
          <Banner tone="success">{t("connectionSignIn.landingConnected")}</Banner>
        ) : landing.outcome === CONNECTION_OAUTH_ADMIN_CONSENTED ? (
          <Banner tone="success" title={t("connectionSignIn.landingApprovedTitle")}>
            {t("connectionSignIn.landingApproved")}
          </Banner>
        ) : (
          <Banner tone="danger" title={t("connectionSignIn.landingFailedTitle")}>
            {failureText({ failure: landing.outcome })}
          </Banner>
        )}
        {/* The administrator who approved is often nobody of the instance: nothing to open. */}
        {approved ? null : (
          <Button
            variant="outline"
            className="justify-self-start"
            onClick={() => onOpen(landing.connection)}
          >
            {t(
              landing.connection === undefined
                ? "connectionSignIn.landingList"
                : "connectionSignIn.landingOpen"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
