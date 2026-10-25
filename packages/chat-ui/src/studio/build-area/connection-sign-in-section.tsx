import { useState } from "react";
import type { ConnectionDetail } from "@work-shape/catalyst-api-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Chip,
  KeyValue,
  KeyValueList,
  type BadgeTone
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { BuildAsset } from "./build-asset-kind";
import type { ConnectionSource } from "./connection-source";
import {
  AdminConsentLink,
  SignInActions,
  SignInBody,
  signInHeading,
  useConnectionSignIn,
  type SignInBrowser,
  type SignInCalls
} from "./connection-sign-in";
import { oauthSettingsOf } from "./connection-sign-in-model";

// The section "Sign-in" of the page of a Connection that signs in with OAuth (CS-4b4): the
// state of its shared sign-in, the provider, the account, who signed in and since when, the
// permissions granted, and for a client the provider issued its id and the redirect URI to
// copy. A person who may change the Connection signs it in, or again, here.

type BindingView = "connected" | "needs_reconnect" | "revoked" | "none";

const BINDING_VIEWS: Record<BindingView, { tone: BadgeTone; label: TranslationKey }> = {
  connected: { tone: "success", label: "connectionSignIn.stateConnected" },
  needs_reconnect: { tone: "warning", label: "connectionSignIn.stateNeedsReconnect" },
  revoked: { tone: "neutral", label: "connectionSignIn.stateRevoked" },
  none: { tone: "neutral", label: "connectionSignIn.stateNone" }
};

/** The state of the shared sign-in, as its badge says it. */
export function SignInStateBadge({ binding }: { binding: ConnectionDetail["binding"] }) {
  const { t } = useTranslation();
  const view = BINDING_VIEWS[binding?.state ?? "none"];
  return (
    <Badge tone={view.tone} dot data-sign-in-state={binding?.state ?? "none"}>
      {t(view.label)}
    </Badge>
  );
}

export function ConnectionSignInSection({
  asset,
  detail,
  source,
  mayWrite,
  writeOAuth,
  browser,
  onSignedIn
}: {
  asset: BuildAsset;
  detail: ConnectionDetail;
  source: ConnectionSource;
  /** The reader may change the Connection: the section offers the sign-in. */
  mayWrite: boolean;
  /** Writes `settings.oauth`. Absent where the definition is not changed on this page. */
  writeOAuth?: SignInCalls["writeOAuth"];
  browser?: SignInBrowser;
  /** Hears of a sign-in that landed: the page reads the Connection again. */
  onSignedIn(): void;
}) {
  const { locale, t } = useTranslation();
  const [signingIn, setSigningIn] = useState(false);
  const { binding, oauth } = detail;
  const connectedBy = source.usePersonName?.(binding?.connectedBy);
  const clientId = oauthSettingsOf(asset.config).clientId;
  const preregistered = oauth?.registration === "preregistered";
  const signedIn = binding !== undefined && binding.state !== "revoked";
  return (
    <div className="grid min-w-0 gap-4" data-connection-sign-in="">
      <KeyValueList>
        <KeyValue label={t("connectionSignIn.state")}>
          <SignInStateBadge binding={binding} />
        </KeyValue>
        {oauth?.providerHost ? (
          <KeyValue label={t("connectionSignIn.provider")}>
            <code className="font-mono text-code">{oauth.providerHost}</code>
          </KeyValue>
        ) : null}
        {signedIn ? (
          <>
            <KeyValue label={t("connectionSignIn.account")}>
              {binding.account ?? (
                <span className="text-muted-foreground">
                  {t("connectionSignIn.accountUnnamed")}
                </span>
              )}
            </KeyValue>
            <KeyValue label={t("connectionSignIn.connected")}>
              {connectedBy
                ? t("connectionSignIn.connectedBy", {
                    time: formatDateTime(binding.connectedAt, locale),
                    name: connectedBy
                  })
                : t("connectionSignIn.connectedSince", {
                    time: formatDateTime(binding.connectedAt, locale)
                  })}
            </KeyValue>
            <KeyValue label={t("connectionSignIn.scopesGranted")}>
              {binding.scopes.length === 0 ? (
                <span className="text-muted-foreground">
                  {t("connectionSignIn.scopesGrantedNone")}
                </span>
              ) : (
                <span className="flex min-w-0 flex-wrap gap-1.5" data-sign-in-granted="">
                  {binding.scopes.map((scope) => (
                    <Chip key={scope} size="sm">
                      <code className="font-mono">{scope}</code>
                    </Chip>
                  ))}
                </span>
              )}
            </KeyValue>
          </>
        ) : null}
        {oauth?.registration === "managed" ? (
          <KeyValue label={t("connectionSignIn.appRegistration")}>
            <span data-sign-in-managed="">{t("connectionSignIn.appManaged")}</span>
          </KeyValue>
        ) : null}
        {preregistered && typeof clientId === "string" ? (
          <KeyValue label={t("connectionSignIn.clientId")} copyValue={clientId}>
            <code className="font-mono text-code break-all">{clientId}</code>
          </KeyValue>
        ) : null}
        {preregistered && oauth.redirectUri ? (
          <KeyValue label={t("connectionSignIn.redirectUri")} copyValue={oauth.redirectUri}>
            <code className="font-mono text-code break-all">{oauth.redirectUri}</code>
          </KeyValue>
        ) : null}
      </KeyValueList>
      {mayWrite && oauth?.adminConsentUrl ? (
        <AdminConsentLink
          url={oauth.adminConsentUrl}
          hint={t("connectionSignIn.adminConsentHint")}
        />
      ) : null}
      {binding?.state === "connected" ? (
        <Banner layout="line" data-sign-in-shared="">
          {t("connectionSignIn.sharedConnected")}
        </Banner>
      ) : null}
      {!mayWrite ? (
        binding?.state === "connected" ? null : (
          <p className="text-body text-muted-foreground">{t("connectionSignIn.memberText")}</p>
        )
      ) : signingIn ? (
        <PageSignIn
          calls={{
            connection: asset.name,
            start: () => source.oauthStart(asset.name),
            readDetail: () => source.readDetail(asset.name),
            ...(writeOAuth
              ? {
                  writeOAuth,
                  setSecret: (value, expectedVersion, expectedRevision) =>
                    source.setSecret(asset.name, value, expectedVersion, expectedRevision)
                }
              : {})
          }}
          browser={browser}
          onConnected={() => {
            setSigningIn(false);
            onSignedIn();
          }}
          onDone={() => setSigningIn(false)}
        />
      ) : (
        <Button
          variant={signedIn ? "outline" : "primary"}
          className="justify-self-start"
          data-sign-in-begin=""
          onClick={() => setSigningIn(true)}
        >
          {t(signedIn ? "connectionSignIn.restart" : "connectionSignIn.start")}
        </Button>
      )}
    </div>
  );
}

/** The sign-in as the page runs it, under the section's facts. */
function PageSignIn({
  calls,
  browser,
  onConnected,
  onDone
}: {
  calls: SignInCalls;
  browser: SignInBrowser | undefined;
  onConnected(): void;
  /** Closes the sign-in without one. */
  onDone(): void;
}) {
  const { t } = useTranslation();
  const signIn = useConnectionSignIn(calls, {
    onConnected,
    ...(browser ? { browser } : {})
  });
  const waiting = signIn.state.phase === "waiting";
  return (
    <Card data-sign-in-panel="">
      <CardHeader>
        <CardTitle>{signInHeading(signIn, t)}</CardTitle>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        <SignInBody signIn={signIn} />
        <div className="flex flex-wrap gap-2">
          <SignInActions signIn={signIn} />
          {waiting ? null : (
            <Button variant="ghost" onClick={onDone}>
              {t("connectionSignIn.cancel")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
