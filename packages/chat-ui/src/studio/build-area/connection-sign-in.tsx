import { useEffect, useRef, useState } from "react";
import type { ConnectionOAuthStart } from "@work-shape/catalyst-api-client";
import {
  Banner,
  Button,
  Checkbox,
  Field,
  FormNotice,
  Input,
  KeyValue,
  KeyValueList,
  Spinner
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import {
  SIGN_IN_CHANNEL,
  readSignInMessage,
  scopesToWrite,
  signInErrorOf,
  startStillOpens,
  waitForSignIn,
  type SignInError,
  type SignInFailure,
  type SignInLanding,
  type SignInRead
} from "./connection-sign-in-model";

// The step that signs a Connection in at its provider (CS-4b4), in the New connection dialog
// and in the section "Sign-in" of the Connection page. It names the provider's host and the
// permissions asked for, says whose account everyone then uses, opens the provider's page in a
// new tab and waits there until the Connection is signed in. Where the provider registers no
// client by itself it asks for the client ID and secret, with the redirect URI to copy.

/** The calls of one sign-in, on the Connection it is for. */
export interface SignInCalls {
  connection: string;
  /** `connections.oauth_start`. */
  start(): Promise<ConnectionOAuthStart>;
  /** The Connection's detail, or for a personal sign-in the person's own sign-in. */
  readDetail(): Promise<SignInRead>;
  /**
   * Writes `settings.oauth` of the definition and answers the revision it wrote. Absent where
   * the definition is not changed here, as for a Connection of the release config: the
   * permissions then stand as they are.
   */
  writeOAuth?(oauth: { clientId?: string; scopes?: string[] }): Promise<number>;
  /**
   * Enters the client secret, the Connection's own secret, for the Connection at the revision
   * given. Present with `writeOAuth`.
   */
  setSecret?(
    value: string,
    expectedVersion: number | null,
    expectedRevision: number
  ): Promise<void>;
}

/** A tab opened for the provider's page. */
export interface SignInTab {
  go(url: string): void;
  close(): void;
}

/** What the step needs of the browser. A test hands it one of its own. */
export interface SignInBrowser {
  /** Opens an empty tab now, while the click still allows one. Nothing where it is blocked. */
  openTab(): SignInTab | undefined;
  listen(onLanding: (landing: SignInLanding) => void): () => void;
  pause(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}

/** Opens an empty window: a tab, or with `features` a small window of its own. */
function openWindow(features?: string): SignInTab | undefined {
  const opened = window.open("about:blank", "_blank", features);
  if (!opened) return undefined;
  return {
    go(url) {
      // The provider's page gets no hold of this window.
      opened.opener = null;
      opened.location.replace(url);
    },
    close: () => opened.close()
  };
}

/** The browser the product runs in. */
const windowSignInBrowser: SignInBrowser = {
  openTab: () => openWindow(),
  listen(onLanding) {
    if (typeof BroadcastChannel === "undefined") return () => undefined;
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const landing = readSignInMessage(event.data);
      if (landing) onLanding(landing);
    };
    return () => channel.close();
  },
  pause: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    }),
  now: () => Date.now()
};

/**
 * The browser of a person's own sign-in: the provider's page in a small window beside the page,
 * or in a new tab where the browser opens no such window. Never in a frame.
 */
export const popupSignInBrowser: SignInBrowser = {
  ...windowSignInBrowser,
  openTab: () => openWindow("popup,width=520,height=720") ?? openWindow()
};

/** Where the step stands. */
export type SignInPhase =
  | { phase: "starting" }
  /** A one-click sign-in that was cancelled: nothing runs. */
  | { phase: "idle" }
  /** The start was refused before anything could be shown. */
  | { phase: "failed"; error: SignInError }
  /** The provider registers no client: the person enters the one it issued. */
  | { phase: "client"; redirectUri?: string; error?: SignInError; saving: boolean }
  /** The provider's host and the permissions, and the button that opens its page. */
  | { phase: "ready"; start: ConnectionOAuthStart; error?: SignInError; opening: boolean }
  | { phase: "waiting"; start: ConnectionOAuthStart }
  | { phase: "connected"; detail: SignInRead };

export interface ConnectionSignIn {
  state: SignInPhase;
  /** Every permission offered so far, in its order. Unticked ones stay offered. */
  offered: readonly string[];
  ticked: ReadonlySet<string>;
  /** The permissions may be changed here. */
  choosesScopes: boolean;
  /** The client may be entered here. */
  entersClient: boolean;
  /** The person connects their own account, which nobody else uses. */
  personal: boolean;
  /** A sign-in started here is starting or waiting for the provider. */
  busy: boolean;
  /**
   * The redirect URI of a client the provider issued, to copy into its app: the instance names
   * it once the Connection is saved. Nothing for a client registered by DCR.
   */
  redirectUri?: string;
  client: { id: string; secret: string };
  setTicked(scope: string, ticked: boolean): void;
  setClient(client: { id: string; secret: string }): void;
  /** Opens the provider's page. Called in the click, so the browser opens its tab. */
  open(): void;
  /**
   * Signs in with one click, without the step: opens the window in the click, starts the
   * sign-in and sends the window to the provider, whose own page shows the permissions. For a
   * person's own account, where there is nothing to choose before.
   */
  connect(): void;
  cancel(): void;
  retry(): void;
  saveClient(): void;
}

/** One sign-in, started when the step first shows, or once `enabled` turns true. */
export function useConnectionSignIn(
  calls: SignInCalls,
  options: {
    onConnected(detail: SignInRead): void;
    browser?: SignInBrowser;
    /** The person connects their own account: the step says so instead of the shared sentence. */
    personal?: boolean;
    /** Off, nothing starts: for a dialog that shows the step later. */
    enabled?: boolean;
  }
): ConnectionSignIn {
  const enabled = options.enabled ?? true;
  const browser = options.browser ?? windowSignInBrowser;
  const [state, setState] = useState<SignInPhase>({ phase: "starting" });
  const [offered, setOffered] = useState<readonly string[]>([]);
  const [ticked, setTickedSet] = useState<ReadonlySet<string>>(new Set());
  const [client, setClient] = useState({ id: "", secret: "" });
  const [redirectUri, setRedirectUri] = useState<string>();
  // The latest calls and callback, read by work that outlives a render.
  const latest = useRef({ calls, onConnected: options.onConnected });
  latest.current = { calls, onConnected: options.onConnected };
  /** What the Connection was before this sign-in: a later sign-in is told apart from it. */
  const before = useRef<SignInRead | undefined>(undefined);
  /** The start shown is spent: the next open starts again. */
  const spent = useRef(false);
  const waiting = useRef<AbortController | undefined>(undefined);
  const begun = useRef(false);

  /** Runs work of the step; what nobody caught on the way says the sign-in did not work. */
  const run = (work: Promise<void>) => {
    work.catch(() => setState({ phase: "failed", error: { failure: "failed" } }));
  };

  const offer = (scopes: readonly string[]) => {
    setOffered((current) => [...current, ...scopes.filter((scope) => !current.includes(scope))]);
  };

  async function begin() {
    setState({ phase: "starting" });
    const detail = await latest.current.calls.readDetail().catch(() => undefined);
    before.current = detail;
    setRedirectUri(
      detail?.oauth?.registration === "preregistered" ? detail.oauth.redirectUri : undefined
    );
    try {
      const start = await latest.current.calls.start();
      spent.current = false;
      offer(start.scopes);
      setTickedSet(new Set(start.scopes));
      setState({ phase: "ready", start, opening: false });
    } catch (error) {
      const refused = signInErrorOf(error);
      if (refused.failure === "oauth_client_required") {
        const redirectUri = detail?.oauth?.redirectUri;
        setState({ phase: "client", saving: false, ...(redirectUri ? { redirectUri } : {}) });
        return;
      }
      setState({ phase: "failed", error: refused });
    }
  }

  useEffect(() => {
    if (enabled && !begun.current) {
      begun.current = true;
      run(begin());
    }
    // The sign-in starts once, when the step first shows.
  }, [enabled]);
  useEffect(() => () => waiting.current?.abort(), []);

  async function openStarted(start: ConnectionOAuthStart, tab: SignInTab) {
    const { calls: current } = latest.current;
    let opened = start;
    try {
      const scopes = current.writeOAuth ? scopesToWrite(offered, ticked, start.scopes) : undefined;
      if (scopes !== undefined && current.writeOAuth) {
        await current.writeOAuth({ scopes });
        opened = await current.start();
      } else if (spent.current || !startStillOpens(start, browser.now())) {
        opened = await current.start();
      }
    } catch (error) {
      tab.close();
      spent.current = true;
      setState({ phase: "ready", start, opening: false, error: signInErrorOf(error) });
      return;
    }
    spent.current = true;
    tab.go(opened.authorizationUrl);
    await waitOn(opened, (error) =>
      setState({ phase: "ready", start: opened, opening: false, ...(error ? { error } : {}) })
    );
  }

  /** Signs in in one click: the window is open, the step is skipped. */
  async function connectNow(tab: SignInTab) {
    const { calls: current } = latest.current;
    let start: ConnectionOAuthStart;
    try {
      before.current = await current.readDetail().catch(() => undefined);
      start = await current.start();
    } catch (error) {
      tab.close();
      setState({ phase: "failed", error: signInErrorOf(error) });
      return;
    }
    spent.current = true;
    tab.go(start.authorizationUrl);
    await waitOn(start, (error) =>
      setState(error ? { phase: "failed", error } : { phase: "idle" })
    );
  }

  /** Waits for the sign-in the provider's page was opened for; `back` hears a miss. */
  async function waitOn(opened: ConnectionOAuthStart, back: (error?: SignInError) => void) {
    const { calls: current } = latest.current;
    const controller = new AbortController();
    waiting.current = controller;
    setState({ phase: "waiting", start: opened });
    const outcome = await waitForSignIn(
      {
        readDetail: () => latest.current.calls.readDetail(),
        pause: browser.pause,
        now: browser.now,
        listen: browser.listen
      },
      {
        connection: current.connection,
        start: opened,
        before: before.current,
        signal: controller.signal
      }
    );
    if (waiting.current === controller) waiting.current = undefined;
    switch (outcome.status) {
      case "connected":
        setState({ phase: "connected", detail: outcome.detail });
        latest.current.onConnected(outcome.detail);
        return;
      case "failed":
        back(outcome.error);
        return;
      case "cancelled":
        back();
        return;
    }
  }

  async function saveClientNow() {
    const { calls: current } = latest.current;
    if (!current.writeOAuth || state.phase !== "client") return;
    const id = client.id.trim();
    setState({ ...state, saving: true, error: undefined });
    try {
      const revision = await current.writeOAuth({ clientId: id });
      if (client.secret !== "" && current.setSecret) {
        const version = (await current.readDetail()).secret?.version;
        // For the client just written: a write of the addresses since refuses the secret.
        await current.setSecret(client.secret, version ?? null, revision);
      }
    } catch (error) {
      setState({ ...state, saving: false, error: signInErrorOf(error) });
      return;
    }
    setClient({ id, secret: "" });
    await begin();
  }

  // "starting" before anything began is the rest state of a step that is not shown yet.
  const busy = state.phase === "waiting" || (begun.current && state.phase === "starting");
  return {
    state,
    busy,
    offered,
    ticked,
    choosesScopes: calls.writeOAuth !== undefined,
    entersClient: calls.writeOAuth !== undefined,
    personal: options.personal ?? false,
    ...(redirectUri === undefined ? {} : { redirectUri }),
    client,
    setTicked(scope, on) {
      setTickedSet((current) => {
        const next = new Set(current);
        if (on) next.add(scope);
        else next.delete(scope);
        return next;
      });
    },
    setClient,
    open() {
      if (state.phase !== "ready" || state.opening) return;
      const { start } = state;
      const tab = browser.openTab();
      if (!tab) {
        setState({ phase: "ready", start, opening: false, error: { failure: "tab_blocked" } });
        return;
      }
      setState({ phase: "ready", start, opening: true });
      run(openStarted(start, tab));
    },
    connect() {
      if (busy) return;
      const tab = browser.openTab();
      if (!tab) {
        setState({ phase: "failed", error: { failure: "tab_blocked" } });
        return;
      }
      begun.current = true;
      setState({ phase: "starting" });
      run(connectNow(tab));
    },
    cancel: () => waiting.current?.abort(),
    retry: () => run(begin()),
    saveClient: () => run(saveClientNow())
  };
}

const FAILURE_TEXTS: Record<SignInFailure, TranslationKey> = {
  oauth_denied: "connectionSignIn.errorDenied",
  oauth_session_expired: "connectionSignIn.errorExpired",
  egress_denied: "connectionSignIn.errorEgress",
  oauth_pkce_unsupported: "connectionSignIn.errorPkce",
  oauth_redirect_unconfigured: "connectionSignIn.errorRedirect",
  oauth_discovery_failed: "connectionSignIn.errorDiscovery",
  oauth_registration_refused: "connectionSignIn.errorRegistration",
  oauth_issuer_mismatch: "connectionSignIn.errorIssuer",
  oauth_state_invalid: "connectionSignIn.errorState",
  oauth_connection_changed: "connectionSignIn.errorChanged",
  oauth_requires_person: "connectionSignIn.errorPerson",
  oauth_client_required: "connectionSignIn.errorClient",
  forbidden: "connectionSignIn.errorForbidden",
  tab_blocked: "connectionSignIn.errorTab",
  failed: "connectionSignIn.errorFailed"
};

/** The sentences that name the provider's host, said without it where nobody knows it. */
const UNNAMED_TEXTS: Partial<Record<SignInFailure, TranslationKey>> = {
  egress_denied: "connectionSignIn.errorEgressUnnamed",
  oauth_denied: "connectionSignIn.errorDeniedUnnamed",
  oauth_pkce_unsupported: "connectionSignIn.errorPkceUnnamed"
};

/** What a failure says. `host` is the provider's, where the step knows it. */
export function useSignInFailureText(): (error: SignInError, host?: string) => string {
  const { t } = useTranslation();
  return (error, host) => {
    const named = error.host ?? host;
    const unnamed = UNNAMED_TEXTS[error.failure];
    if (named === undefined && unnamed !== undefined) return t(unnamed);
    return t(FAILURE_TEXTS[error.failure], { host: named ?? "" });
  };
}

/** The heading of the step: the provider's host once the instance named it. */
export function signInHeading(signIn: ConnectionSignIn, t: ReturnType<typeof useTranslation>["t"]) {
  const { state } = signIn;
  return state.phase === "ready" || state.phase === "waiting"
    ? t("connectionSignIn.heading", { host: state.start.providerHost })
    : state.phase === "client"
      ? t("connectionSignIn.clientHeading")
      : t("connectionSignIn.headingPending");
}

/** What the step shows above its buttons. */
export function SignInBody({ signIn }: { signIn: ConnectionSignIn }) {
  const { t } = useTranslation();
  const failureText = useSignInFailureText();
  const { state } = signIn;
  switch (state.phase) {
    case "idle":
      return null;
    case "starting":
      return (
        <p
          className="flex items-center gap-2 text-body text-muted-foreground"
          role="status"
          data-sign-in-step="starting"
        >
          <Spinner size="sm" />
          {t("connectionSignIn.starting")}
        </p>
      );
    case "failed":
      return (
        <FormNotice tone="error" data-sign-in-error={state.error.failure}>
          {failureText(state.error)}
        </FormNotice>
      );
    case "client":
      return (
        <div className="grid min-w-0 gap-4" data-sign-in-step="client">
          <p className="text-body">
            {t(
              signIn.entersClient
                ? "connectionSignIn.clientText"
                : "connectionSignIn.clientTextFixed"
            )}
          </p>
          <KeyValueList>
            <KeyValue
              label={t("connectionSignIn.redirectUri")}
              {...(state.redirectUri ? { copyValue: state.redirectUri } : {})}
            >
              {state.redirectUri ? (
                <code className="font-mono text-code break-all" data-sign-in-redirect-uri="">
                  {state.redirectUri}
                </code>
              ) : (
                t("connectionSignIn.redirectUriMissing")
              )}
            </KeyValue>
          </KeyValueList>
          {signIn.entersClient ? (
            <>
              <Field label={t("connectionSignIn.clientId")} required>
                <Input
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={signIn.client.id}
                  disabled={state.saving}
                  data-sign-in-field="clientId"
                  onChange={(event) =>
                    signIn.setClient({ ...signIn.client, id: event.target.value })
                  }
                />
              </Field>
              <Field
                label={t("connectionSignIn.clientSecret")}
                hint={t("connectionSignIn.clientSecretHint")}
                optional
              >
                <Input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={signIn.client.secret}
                  disabled={state.saving}
                  data-sign-in-field="clientSecret"
                  onChange={(event) =>
                    signIn.setClient({ ...signIn.client, secret: event.target.value })
                  }
                />
              </Field>
            </>
          ) : null}
          {state.error ? (
            <FormNotice tone="error" data-sign-in-error={state.error.failure}>
              {failureText(state.error)}
            </FormNotice>
          ) : null}
        </div>
      );
    case "ready":
      return (
        <div className="grid min-w-0 gap-4" data-sign-in-step="ready">
          {signIn.personal ? (
            <Banner layout="line" data-sign-in-personal="">
              {t("personalConnections.signInText")}
            </Banner>
          ) : (
            <Banner layout="line" data-sign-in-shared="">
              {t("connectionSignIn.shared")}
            </Banner>
          )}
          {signIn.redirectUri ? (
            <KeyValueList>
              <KeyValue label={t("connectionSignIn.redirectUri")} copyValue={signIn.redirectUri}>
                <span className="grid gap-1">
                  <code className="font-mono text-code break-all" data-sign-in-redirect-uri="">
                    {signIn.redirectUri}
                  </code>
                  <span className="text-caption text-muted-foreground">
                    {t("connectionSignIn.redirectUriHint")}
                  </span>
                </span>
              </KeyValue>
            </KeyValueList>
          ) : null}
          <SignInScopes signIn={signIn} disabled={state.opening} />
          {state.error ? (
            <FormNotice tone="error" data-sign-in-error={state.error.failure}>
              {failureText(state.error, state.start.providerHost)}
            </FormNotice>
          ) : null}
        </div>
      );
    case "waiting":
      return (
        <Banner layout="line" tone="info" data-sign-in-step="waiting">
          <span className="grid gap-1" role="status">
            <span className="flex items-center gap-2 font-medium">
              <Spinner size="sm" />
              {t("connectionSignIn.waiting")}
            </span>
            <span>{t("connectionSignIn.waitingText", { host: state.start.providerHost })}</span>
          </span>
        </Banner>
      );
    case "connected":
      return null;
  }
}

/** The permissions the sign-in asks for, ticked; unticked ones are not asked for. */
function SignInScopes({ signIn, disabled }: { signIn: ConnectionSignIn; disabled: boolean }) {
  const { t } = useTranslation();
  if (signIn.offered.length === 0) {
    return <p className="text-body text-muted-foreground">{t("connectionSignIn.scopesNone")}</p>;
  }
  return (
    <div
      role="group"
      aria-label={t("connectionSignIn.scopes")}
      className="grid min-w-0 gap-2"
      data-sign-in-scopes=""
    >
      <p className="text-caption text-muted-foreground">
        {t("connectionSignIn.scopes")} ·{" "}
        {t(signIn.choosesScopes ? "connectionSignIn.scopesHint" : "connectionSignIn.scopesFixed")}
      </p>
      {signIn.offered.map((scope) => (
        <Checkbox
          key={scope}
          checked={signIn.ticked.has(scope)}
          disabled={disabled || !signIn.choosesScopes}
          data-sign-in-scope={scope}
          label={<code className="font-mono text-code break-all">{scope}</code>}
          onCheckedChange={(checked) => signIn.setTicked(scope, checked)}
        />
      ))}
    </div>
  );
}

/** The buttons of the step. */
export function SignInActions({ signIn }: { signIn: ConnectionSignIn }) {
  const { t } = useTranslation();
  const { state } = signIn;
  switch (state.phase) {
    case "idle":
    case "starting":
    case "connected":
      return null;
    case "failed":
      return (
        <Button variant="outline" onClick={signIn.retry} data-sign-in-retry="">
          {t("connectionSignIn.tryAgain")}
        </Button>
      );
    case "client":
      return signIn.entersClient ? (
        <Button
          loading={state.saving}
          disabled={signIn.client.id.trim() === ""}
          data-sign-in-save-client=""
          onClick={signIn.saveClient}
        >
          {t("connectionSignIn.clientSave")}
        </Button>
      ) : null;
    case "ready":
      return (
        <Button loading={state.opening} data-sign-in-open="" onClick={signIn.open}>
          {t("connectionSignIn.open", { host: state.start.providerHost })}
        </Button>
      );
    case "waiting":
      return (
        <Button variant="outline" data-sign-in-cancel="" onClick={signIn.cancel}>
          {t("connectionSignIn.cancel")}
        </Button>
      );
  }
}
