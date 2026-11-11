import { useEffect, useState } from "react";
import { completedOutput, type ApiClient } from "@work-shape/catalyst-api-client";
import {
  Button,
  Dialog,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  FormNotice,
  Input
} from "@work-shape/catalyst-ui";
import { useInvalidatePersonalConnections } from "../../shared/api/personal-connections";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";
import { ownTokenHeaderOf, ownTokenSchemeOf, withOwnTokenScheme } from "./own-server-model";

// A person's own token for an MCP server that takes one instead of a sign-in (PMCP-6). The token
// is typed into a password field, held in this browser's memory until it is sent once through
// `connections.set_own_secret`, and never read back: the instance answers only that it is set.

/** What the person typed: the token, and the header it goes in where they choose one. */
export interface OwnTokenDraft {
  token: string;
  header: string;
}

/** Why a draft cannot be sent yet, at its field. */
export interface OwnTokenIssues {
  token?: string;
  header?: string;
}

/** The token field and, where the person chooses how it is sent, the header under details. */
export function OwnTokenFields({
  host,
  draft,
  onChange,
  chooseHeader,
  issues,
  disabled
}: {
  host: string;
  draft: OwnTokenDraft;
  onChange(draft: OwnTokenDraft): void;
  /** Whether the header is the person's to choose: on their own server, not an admin's. */
  chooseHeader: boolean;
  issues: OwnTokenIssues;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid min-w-0 gap-4" data-own-token="">
      <Field
        label={t("ownServers.tokenLabel")}
        hint={t("ownServers.tokenHint", { host })}
        error={issues.token}
        required
      >
        <Input
          className="font-mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.token}
          disabled={disabled}
          data-own-token-field="token"
          onChange={(event) => onChange({ ...draft, token: event.target.value })}
        />
      </Field>
      {chooseHeader ? (
        <Disclosure defaultOpen={draft.header !== ""} data-own-token-details="">
          <DisclosureTrigger data-own-token-details-open="">
            {t("ownServers.tokenDetails")}
          </DisclosureTrigger>
          <DisclosureContent>
            <Field
              label={t("ownServers.headerLabel")}
              hint={t("ownServers.headerHint")}
              error={issues.header}
            >
              <Input
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="Authorization"
                value={draft.header}
                disabled={disabled}
                data-own-token-field="header"
                onChange={(event) => onChange({ ...draft, header: event.target.value })}
              />
            </Field>
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** The draft's issues, read before anything is sent. Nothing where it can be sent. */
export function ownTokenIssuesOf(
  draft: OwnTokenDraft,
  chooseHeader: boolean,
  t: ReturnType<typeof useTranslation>["t"]
): OwnTokenIssues | undefined {
  const issues: OwnTokenIssues = {
    ...(draft.token.trim() === "" ? { token: t("ownServers.tokenEmpty") } : {}),
    ...(chooseHeader && ownTokenSchemeOf(draft.header) === undefined
      ? { header: t("ownServers.headerInvalid") }
      : {})
  };
  return Object.keys(issues).length === 0 ? undefined : issues;
}

/**
 * Sends the person's own token: first how it is sent, where they chose another way than the
 * server's definition has, then the token through `connections.set_own_secret` alone. A change
 * of how it is sent ends every token stored for the server, so the token is then a first one.
 * Answers the version the instance stored.
 */
export async function saveOwnToken(
  client: ApiClient,
  input: { name: string; token: string; header?: string; version: number | null }
): Promise<number> {
  let version = input.version;
  const scheme = input.header === undefined ? undefined : ownTokenSchemeOf(input.header);
  if (scheme !== undefined) {
    const stored = await client.assets.get({ params: { kind: "connection", name: input.name } });
    const next = withOwnTokenScheme(stored.config, scheme);
    if (next !== undefined) {
      completedOutput(
        await client.assets.put({
          params: { kind: "connection", name: input.name },
          body: { config: next, expectedRevision: stored.revision }
        })
      );
      version = null;
    }
  }
  const saved = await client.connections.set_own_secret({
    params: { name: input.name },
    body: { value: input.token, expectedVersion: version }
  });
  return saved.version;
}

/** The header a stored server sends its token in, for the field. Empty where it is unread. */
export async function ownTokenHeader(client: ApiClient, name: string): Promise<string> {
  const stored = await client.assets
    .get({ params: { kind: "connection", name } })
    .catch(() => undefined);
  return stored === undefined ? "" : ownTokenHeaderOf(stored.config);
}

/**
 * Sets or replaces the person's own token on one server, from its card or its row. On their own
 * server they choose the header too; on one an admin set up, the admin did.
 */
export function OwnTokenDialog({
  name,
  title,
  host,
  version,
  chooseHeader,
  initialHeader = "",
  onClose,
  onSaved
}: {
  name: string;
  title: string;
  host: string;
  /** The version of the token the person has, `undefined` where they have none. */
  version: number | undefined;
  chooseHeader: boolean;
  initialHeader?: string;
  onClose(): void;
  onSaved?(): void;
}) {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const invalidate = useInvalidatePersonalConnections({ apiBaseUrl, authScope, client });
  const [draft, setDraft] = useState<OwnTokenDraft>({ token: "", header: initialHeader });
  const [issues, setIssues] = useState<OwnTokenIssues>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  // On the person's own server the header field shows how the token is sent now.
  useEffect(() => {
    if (!chooseHeader || initialHeader !== "") return;
    let current = true;
    ownTokenHeader(client, name)
      .then((header) => {
        if (current) setDraft((draft) => (draft.header === "" ? { ...draft, header } : draft));
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [chooseHeader, client, initialHeader, name]);

  const save = async () => {
    const found = ownTokenIssuesOf(draft, chooseHeader, t);
    setProblem(undefined);
    if (found) {
      setIssues(found);
      return;
    }
    setIssues({});
    setBusy(true);
    const token = draft.token;
    // Out of the field at once: the browser keeps it no longer than this call.
    setDraft({ ...draft, token: "" });
    try {
      await saveOwnToken(client, {
        name,
        token,
        ...(chooseHeader ? { header: draft.header } : {}),
        version: version ?? null
      });
    } catch {
      setBusy(false);
      setProblem(t("ownServers.tokenFailed"));
      return;
    }
    // The tools are read with the new token, where the person may ask for that.
    await client.connections.discover({ params: { name } }).catch(() => undefined);
    setBusy(false);
    await invalidate();
    onSaved?.();
    onClose();
  };

  return (
    <Dialog
      open
      title={t("ownServers.tokenTitle", { host: title || host })}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <Button type="submit" form="own-token-form" loading={busy} data-own-token-save="">
          {t(version === undefined ? "ownServers.setToken" : "ownServers.replaceToken")}
        </Button>
      }
    >
      <form
        id="own-token-form"
        className="grid min-w-0 gap-4"
        data-own-token-dialog={name}
        onSubmit={(event) => {
          event.preventDefault();
          save().catch(() => setBusy(false));
        }}
      >
        <p className="text-body text-muted-foreground">{t("ownServers.tokenText", { host })}</p>
        <OwnTokenFields
          host={host}
          draft={draft}
          onChange={setDraft}
          chooseHeader={chooseHeader}
          issues={issues}
          disabled={busy}
        />
        {problem ? (
          <FormNotice tone="error" data-own-token-problem="">
            {problem}
          </FormNotice>
        ) : null}
      </form>
    </Dialog>
  );
}
