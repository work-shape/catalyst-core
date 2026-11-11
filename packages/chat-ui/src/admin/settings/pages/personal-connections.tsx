import type { PersonalConnections } from "@work-shape/catalyst-api-client";
import {
  Button,
  Card,
  EmptyState,
  InlineError,
  PageHeader,
  Section,
  ServiceMark,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { usePersonalConnectionsQuery } from "../../../shared/api/personal-connections";
import { useTranslation } from "../../../shared/i18n";
import { useSettingsPage } from "../../../shared/settings-page-context";
import {
  PersonalStateBadge,
  useOwnConnectionControls,
  usePersonalSignInFacts
} from "../../../studio/build-area/connection-people";
import { splitOwnServers } from "../../../studio/build-area/own-server-model";
import { OwnServersSection } from "../../../studio/build-area/own-servers";

/**
 * You > Connections: the MCP servers the person added for themselves, with the button that adds
 * one (PMCP-5), and one card per personal Connection an administrator set up that the person
 * may use, with their own account's state, since when it is connected, and Connect or
 * Disconnect. Nobody else sees or uses the person's account or their own servers.
 */
export function PersonalConnectionsPage() {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { t } = useTranslation();
  const query = usePersonalConnectionsQuery({ apiBaseUrl, authScope, client });
  const rows = splitOwnServers(query.data?.connections ?? []);
  return (
    <>
      <PageHeader
        title={t("settings.personalConnections")}
        description={t("personalConnections.description")}
      />
      {query.data ? (
        <OwnServersSection
          rows={rows.own}
          mayAdd={query.data.ownServers?.mayAdd === true}
          entries={query.data.ownServers?.entries ?? []}
        />
      ) : null}
      <Section layout="stacked" title={t("personalConnections.yourAccounts")}>
        {query.isPending ? (
          <SkeletonList rows={3} />
        ) : query.isError ? (
          <InlineError className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("personalConnections.loadFailed")}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                query.refetch().catch(() => undefined);
              }}
            >
              {t("tryAgain")}
            </Button>
          </InlineError>
        ) : rows.personal.length === 0 ? (
          <EmptyState layout="inline" data-personal-connections-empty="">
            {t("personalConnections.empty")}
          </EmptyState>
        ) : (
          <ul className="grid min-w-0 gap-3" aria-label={t("settings.personalConnections")}>
            {rows.personal.map((connection) => (
              <li key={connection.name} className="min-w-0">
                <OwnConnectionCard connection={connection} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function OwnConnectionCard({
  connection
}: {
  connection: PersonalConnections["connections"][number];
}) {
  const title = connection.title.trim() || connection.name;
  const facts = usePersonalSignInFacts()(connection);
  const controls = useOwnConnectionControls({ ...connection, title });
  return (
    <Card
      padding="md"
      className="grid min-w-0 gap-3 p-3"
      data-personal-connection={connection.name}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <ServiceMark name={title} size="lg" showName={false} />
        <div className="grid min-w-0 flex-1 gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-label wrap-anywhere">{title}</span>
            <PersonalStateBadge signIn={connection} token={connection.token !== undefined} />
          </span>
          {facts ? <span className="text-caption text-muted-foreground">{facts}</span> : null}
        </div>
        {controls.buttons}
      </div>
      {controls.below}
    </Card>
  );
}
