import { Section, Tabs, TabsContent, TabsList, TabsTrigger } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useOptionalSettingsPage } from "../../shared/settings-page-context";
import type { BuildListLayoutProps } from "./build-asset-kind";
import { CatalogueServices } from "./connection-catalogue-services";
import { serviceCards } from "./connection-services-model";
import { useConnectionSource } from "./connection-source";
import { MyConnectionsSection } from "./my-connections";
import { hiddenFromConnectionList } from "./my-connections-model";

/** The two views of the page for who manages Connections. */
const TABS = ["mine", "manage"] as const;
type ConnectionsTab = (typeof TABS)[number];

/**
 * Studio > Connections (CONN-IA). Everyone gets "Meine Verbindungen": what they connect with
 * their own account, each with their own state. Below it, a person who manages no Connection
 * reads the shared ones the organisation set up, which ask nothing of them. Who may manage
 * Connections gets a second tab, "Verwalten", with the instance's Connections, each saying whose
 * account it uses, the services that can be installed, and the servers other people added.
 * Studio shown alone, as in a rendering of its frame, reads no instance and shows the list.
 */
export function ConnectionsListLayout(props: BuildListLayoutProps) {
  return useOptionalSettingsPage() ? (
    <InstanceConnections {...props} />
  ) : (
    <>
      {props.list}
      {props.aside}
    </>
  );
}

function InstanceConnections({
  rows,
  canCreate,
  hrefOf,
  open,
  create,
  list,
  aside,
  tab,
  onTabChange
}: BuildListLayoutProps) {
  const { t } = useTranslation();
  if (!canCreate) {
    // Nothing to read here where every Connection of the list is the reader's own card.
    const shared = rows?.some((row) => !hiddenFromConnectionList(row, false)) === true;
    return (
      <>
        <MyConnectionsSection />
        {shared ? (
          <Section
            layout="stacked"
            title={t("connections.sharedTitle")}
            description={t("connections.sharedText")}
            data-build-list-section=""
          >
            {list}
          </Section>
        ) : null}
      </>
    );
  }
  const chosen: ConnectionsTab = tab === "manage" ? "manage" : "mine";
  return (
    <Tabs value={chosen} onValueChange={onTabChange} className="grid min-w-0 gap-6">
      <TabsList label={t("connections.tabs")}>
        <TabsTrigger value="mine" data-connections-tab="mine">
          {t("myConnections.title")}
        </TabsTrigger>
        <TabsTrigger value="manage" data-connections-tab="manage">
          {t("connections.manageTab")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="mine" className="min-w-0">
        <MyConnectionsSection />
      </TabsContent>
      <TabsContent value="manage" className="min-w-0">
        <Section
          layout="stacked"
          title={t("connections.instanceTitle")}
          description={t("connections.instanceText")}
          data-build-list-section=""
        >
          {list}
        </Section>
        <InstallableServices rows={rows} hrefOf={hrefOf} open={open} create={create} />
        {aside}
      </TabsContent>
    </Tabs>
  );
}

/** The catalogue's entries, for who may make a Connection. Nothing while they are read. */
function InstallableServices({
  rows,
  hrefOf,
  open,
  create
}: Pick<BuildListLayoutProps, "rows" | "hrefOf" | "open" | "create">) {
  const entries = useConnectionSource().useCatalogueEntries?.(true);
  if (rows === undefined || entries === undefined) return null;
  const cards = serviceCards({ entries, connections: rows });
  if (cards.length === 0) return null;
  return (
    <CatalogueServices
      cards={cards}
      hrefOf={(action) => (action.kind === "open" ? hrefOf(action.name) : undefined)}
      onAct={(action) => {
        if (action.kind === "open") open(action.name);
        else create(action.entry);
      }}
    />
  );
}
