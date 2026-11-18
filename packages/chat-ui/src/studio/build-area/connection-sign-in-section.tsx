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
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
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
// state of its shared sign-in with who signed in and since when, the account where the provider
// names one, and whose account everyone uses. A person who may change the Connection signs it
// in, or again, here. The provider's host, the permissions granted, the app registration, a
// client's id, the redirect URI and the approval link for IT are folded under Technical details.

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
  const since = signedIn
    ? connectedBy
      ? t("connectionSignIn.connectedBy", {
          time: formatDateTime(binding.connectedAt, locale),
          name: connectedBy
        })
      : t("connectionSignIn.connectedSince", {
          time: formatDateTime(binding.connectedAt, locale)
        })
    : undefined;
  // What only whoever sets the sign-in up reads: folded under Technical details.
  const technical = [
    oauth?.providerHost ? (
      <KeyValue key="provider" label={t("connectionSignIn.provider")}>
        <code className="font-mono text-code">{oauth.providerHost}</code>
      </KeyValue>
    ) : null,
    signedIn ? (
      <KeyValue key="scopes" label={t("connectionSignIn.scopesGranted")}>
        {binding.scopes.length === 0 ? (
          <span className="text-muted-foreground">{t("connectionSignIn.scopesGrantedNone")}</span>
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
    ) : null,
    oauth?.registration === "managed" ? (
      <KeyValue key="registration" label={t("connectionSignIn.appRegistration")}>
        <span data-sign-in-managed="">{t("connectionSignIn.appManaged")}</span>
      </KeyValue>
    ) : null,
    preregistered && typeof clientId === "string" ? (
      <KeyValue key="client" label={t("connectionSignIn.clientId")} copyValue={clientId}>
        <code className="font-mono text-code break-all">{clientId}</code>
      </KeyValue>
    ) : null,
    preregistered && oauth.redirectUri ? (
      <KeyValue
        key="redirect"
        label={t("connectionSignIn.redirectUri")}
        copyValue={oauth.redirectUri}
      >
        <code className="font-mono text-code break-all">{oauth.redirectUri}</code>
      </KeyValue>
    ) : null
  ].filter((row) => row !== null);
  const adminConsent = mayWrite && oauth?.adminConsentUrl ? oauth.adminConsentUrl : undefined;
  return (
    <div className="grid min-w-0 gap-4" data-connection-sign-in="">
      <KeyValueList>
        <KeyValue label={t("connectionSignIn.state")}>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <SignInStateBadge binding={binding} />
            {since ? (
              <span className="text-caption text-muted-foreground" data-sign-in-since="">
                {since}
              </span>
            ) : null}
          </span>
        </KeyValue>
        {/* An account the provider does not name is left out, not said to be missing. */}
        {signedIn && binding.account ? (
          <KeyValue label={t("connectionSignIn.account")}>{binding.account}</KeyValue>
        ) : null}
      </KeyValueList>
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
      {technical.length > 0 || adminConsent ? (
        <Disclosure data-sign-in-technical="">
          <DisclosureTrigger>{t("connectionCreate.details")}</DisclosureTrigger>
          <DisclosureContent>
            <div className="grid min-w-0 gap-3">
              {technical.length > 0 ? <KeyValueList>{technical}</KeyValueList> : null}
              {adminConsent ? (
                <AdminConsentLink
                  url={adminConsent}
                  hint={t("connectionSignIn.adminConsentHint")}
                />
              ) : null}
            </div>
          </DisclosureContent>
        </Disclosure>
      ) : null}
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
