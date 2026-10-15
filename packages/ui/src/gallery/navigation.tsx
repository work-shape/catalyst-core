import {
  AppWindow,
  Clock,
  Ellipsis,
  Hammer,
  Inbox,
  List as ListIcon,
  MessageSquare,
  PanelLeft,
  Plus,
  Settings,
  ShieldCheck,
  SquarePen,
  Timer,
  Workflow
} from "lucide-react";
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { Select } from "../forms/select";
import { Breadcrumb } from "../navigation/breadcrumb";
import { NavGroup, NavItem } from "../navigation/nav-item";
import { useSidebarCollapsed } from "../navigation/sidebar-collapsed";
import {
  SegmentedControl,
  SegmentedControlItem,
  type SegmentedControlSize
} from "../navigation/segmented-control";
import { Sidebar } from "../navigation/sidebar";
import { DocsAddressProvider, DocsLink } from "../navigation/docs-link";
import { SkipLink } from "../navigation/skip-link";
import { PageOutline, type PageOutlineItem } from "../navigation/page-outline";
import { SubRail, type SubRailGroup } from "../navigation/sub-rail";
import {
  Tabs,
  TabsContent,
  TabsDisclosure,
  TabsLink,
  TabsList,
  TabsNav,
  TabsTrigger
} from "../navigation/tabs";
import { Page } from "../structure/page";
import { PageHeader } from "../structure/page-header";
import { Section } from "../structure/section";
import { Samples, type GalleryGroup } from "./entry";
import { Avatar } from "../status/avatar";
import type { GalleryText } from "./text";

/** A link of the gallery: it changes what a sample shows and leaves the address alone. */
function sampleLink(onFollow: () => void, label?: string) {
  return (
    <a
      href="#"
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        onFollow();
      }}
    >
      {label}
    </a>
  );
}

type SidebarSection = "chat" | "apps" | "workflows" | "scheduled" | "inbox" | "build";

function SidebarSample({ text }: { text: GalleryText }) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [section, setSection] = useState<SidebarSection>("chat");
  const open = (next: SidebarSection) => {
    setSection(next);
    setDrawerOpen(false);
  };
  const sections: { id: SidebarSection; label: string; icon: ReactNode }[] = [
    { id: "chat", label: text.navChat, icon: <MessageSquare aria-hidden="true" /> },
    { id: "apps", label: text.navApps, icon: <AppWindow aria-hidden="true" /> },
    { id: "workflows", label: text.navWorkflows, icon: <Workflow aria-hidden="true" /> },
    { id: "scheduled", label: text.navScheduled, icon: <Timer aria-hidden="true" /> }
  ];

  return (
    <div className="flex h-112 overflow-hidden rounded-lg border">
      <Sidebar
        label={text.navMain}
        collapsed={collapsed}
        drawerOpen={drawerOpen}
        onDrawerClose={() => setDrawerOpen(false)}
        header={
          <SidebarSampleHeader
            text={text}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
          />
        }
        footer={<SidebarSampleFooter text={text} />}
      >
        <NavGroup>
          <NavItem icon={<SquarePen aria-hidden="true" />} onClick={() => open("chat")}>
            {text.navNewChat}
          </NavItem>
        </NavGroup>
        <NavGroup>
          {sections.map((item) => (
            <NavItem key={item.id} icon={item.icon} selected={section === item.id} asChild>
              {sampleLink(() => open(item.id), item.label)}
            </NavItem>
          ))}
          <NavItem
            icon={<Inbox aria-hidden="true" />}
            count={3}
            selected={section === "inbox"}
            asChild
          >
            {sampleLink(() => open("inbox"), text.navInbox)}
          </NavItem>
        </NavGroup>
        <NavGroup>
          <NavItem icon={<Hammer aria-hidden="true" />} selected={section === "build"} asChild>
            {sampleLink(() => open("build"), text.navBuild)}
          </NavItem>
        </NavGroup>
        <NavGroup label={text.navRecent} collapsible>
          <NavItem onClick={() => open("chat")}>{text.navConversationLease}</NavItem>
          <NavItem onClick={() => open("chat")}>{text.navConversationTax}</NavItem>
          <NavItem onClick={() => open("chat")}>{text.navConversationOffer}</NavItem>
        </NavGroup>
      </Sidebar>
      <div className="grid min-w-0 flex-1 content-start justify-items-start gap-3 p-4">
        <Button className="md:hidden" variant="outline" onClick={() => setDrawerOpen(true)}>
          <PanelLeft aria-hidden="true" />
          {text.navOpenDrawer}
        </Button>
        <p className="text-body text-muted-foreground">{text.navDrawerHint}</p>
      </div>
    </div>
  );
}

function SidebarSampleHeader({
  text,
  collapsed,
  onToggle
}: {
  text: GalleryText;
  collapsed: boolean;
  onToggle(): void;
}) {
  // A drawer is never collapsed, so the sidebar says what it shows, not the caller's state.
  const iconsOnly = useSidebarCollapsed();
  const toggle = (
    <IconButton
      className="max-md:hidden"
      label={collapsed ? text.navExpand : text.navCollapse}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <PanelLeft aria-hidden="true" />
    </IconButton>
  );
  if (iconsOnly) {
    return <div className="grid h-(--layout-header) place-items-center">{toggle}</div>;
  }
  return (
    <div className="flex h-(--layout-header) min-w-0 items-center gap-2 pl-2">
      <Avatar kind="workspace" size="sm" name={text.navWorkspace} />
      <span className="min-w-0 flex-1 truncate text-label">{text.navWorkspace}</span>
      {toggle}
    </div>
  );
}

function SidebarSampleFooter({ text }: { text: GalleryText }) {
  const iconsOnly = useSidebarCollapsed();
  const settings = (
    <IconButton label={text.settings}>
      <Settings aria-hidden="true" />
    </IconButton>
  );
  if (iconsOnly) {
    return (
      <div className="grid justify-items-center gap-1">
        {settings}
        <span className="grid size-8 place-items-center">
          <Avatar kind="person" size="sm" name={text.navAccount} />
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 pl-2">
      <Avatar kind="person" size="sm" name={text.navAccount} />
      <span className="min-w-0 flex-1 truncate text-body">{text.navAccount}</span>
      {settings}
    </div>
  );
}

function NavItemSamples({ text }: { text: GalleryText }) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="grid w-full max-w-(--layout-sidebar) content-start gap-4">
        <NavGroup label={text.navItemStates}>
          <NavItem icon={<MessageSquare aria-hidden="true" />}>{text.navChat}</NavItem>
          <NavItem icon={<AppWindow aria-hidden="true" />} selected>
            {text.navApps}
          </NavItem>
          <NavItem icon={<Inbox aria-hidden="true" />} count={3}>
            {text.navInbox}
          </NavItem>
          <NavItem icon={<Workflow aria-hidden="true" />} count={12} countTone="muted">
            {text.navWorkflows}
          </NavItem>
          <NavItem icon={<Timer aria-hidden="true" />} disabled>
            {text.navScheduled}
          </NavItem>
          <NavItem>{text.navConversationTax}</NavItem>
        </NavGroup>
        <NavGroup label={text.navItemLink}>
          <NavItem icon={<Hammer aria-hidden="true" />} asChild>
            {sampleLink(() => undefined, text.navBuild)}
          </NavItem>
        </NavGroup>
        <NavGroup
          label={text.navRecent}
          labelAction={
            <IconButton size="sm" label={text.navNewChat}>
              <Plus aria-hidden="true" />
            </IconButton>
          }
        >
          <NavItem>{text.navConversationOffer}</NavItem>
        </NavGroup>
        <NavGroup label={text.navRowActions}>
          {[text.navConversationTax, text.navConversationLease].map((title, index) => (
            <NavItem
              key={title}
              selected={index === 1}
              trailing={
                <>
                  <Clock aria-hidden="true" className="size-3.5 text-warning" />
                  <IconButton size="sm" label={text.navRowMore}>
                    <Ellipsis aria-hidden="true" />
                  </IconButton>
                </>
              }
            >
              {title}
            </NavItem>
          ))}
          <NavItem
            trailingKeepsRoom
            trailing={
              <IconButton size="sm" label={text.navRowMore}>
                <Ellipsis aria-hidden="true" />
              </IconButton>
            }
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{text.navConversationOffer}</span>
              <Clock aria-hidden="true" className="size-3.5 text-warning" />
            </span>
          </NavItem>
        </NavGroup>
      </div>
      <div className="grid w-full max-w-(--layout-sidebar) content-start gap-4">
        <NavGroup label={text.navGroupPlain}>
          <NavItem>{text.navConversationLease}</NavItem>
        </NavGroup>
        <NavGroup label={text.navGroupFolding} collapsible>
          <NavItem>{text.navConversationLease}</NavItem>
          <NavItem>{text.navConversationOffer}</NavItem>
        </NavGroup>
        <NavGroup label={text.navGroupFolding} collapsible defaultOpen={false}>
          <NavItem>{text.navConversationLease}</NavItem>
        </NavGroup>
      </div>
      {/* In the scrolling body of a sidebar the label of a group stays at the top. */}
      <div
        className="flex h-64 overflow-hidden rounded-lg border max-md:hidden"
        data-gallery-sample="nav-group-pinned-label"
      >
        <Sidebar
          label={text.navGroupPinned}
          header={
            <div className="flex h-(--layout-header) items-center px-2 text-label">
              {text.navMain}
            </div>
          }
        >
          <NavGroup label={text.navGroupPinned}>
            {Array.from({ length: 12 }, (_, index) => (
              <NavItem key={index}>
                {index % 2 === 0 ? text.navConversationLease : text.navConversationOffer}
              </NavItem>
            ))}
          </NavGroup>
        </Sidebar>
      </div>
    </div>
  );
}

function DocsLinkSamples({ text }: { text: GalleryText }) {
  const sentence = (
    <p className="max-w-prose text-body text-muted-foreground">
      {text.docsLinkSentence}{" "}
      <DocsLink
        path="/operate/how-rights-work/#namespaces"
        accessibleName={text.docsLinkLearnMoreName}
      >
        {text.docsLinkLearnMore}
      </DocsLink>
    </p>
  );
  return (
    <>
      <DocsAddressProvider address="https://docs.example/catalyst">
        <Samples label={text.docsLinkAfterSentence}>{sentence}</Samples>
        <Samples label={text.docsLinkAlone}>
          <p className="text-caption text-muted-foreground">
            <DocsLink
              path="/operate/how-rights-work/#the-short-version"
              accessibleName={text.docsLinkNamedName}
            >
              {text.docsLinkNamed}
            </DocsLink>
          </p>
        </Samples>
      </DocsAddressProvider>
      <DocsAddressProvider address={undefined}>
        <Samples label={text.docsLinkNoAddress}>{sentence}</Samples>
      </DocsAddressProvider>
    </>
  );
}

function SkipLinkSample({ text }: { text: GalleryText }) {
  const targetId = useId();
  return (
    <div className="grid gap-2">
      <p className="text-body text-muted-foreground">{text.skipLinkHint}</p>
      <div className="flex flex-wrap items-center gap-3">
        <SkipLink target={targetId}>{text.skipLinkLabel}</SkipLink>
        <Button variant="outline">{text.navMain}</Button>
        <span
          id={targetId}
          tabIndex={-1}
          className="rounded-md px-2 py-1 text-body focus-visible:focus-ring"
        >
          {text.skipLinkTarget}
        </span>
      </div>
    </div>
  );
}

type SettingsRoute = "profile" | "security" | "general" | "members" | "defaults";

function SubRailSample({ text }: { text: GalleryText }) {
  const [route, setRoute] = useState<SettingsRoute>("general");
  const item = (id: SettingsRoute, label: string, count?: number) => ({
    id,
    label,
    count,
    link: sampleLink(() => setRoute(id))
  });
  const groups: SubRailGroup[] = [
    {
      id: "you",
      label: text.subRailYou,
      items: [item("profile", text.subRailProfile), item("security", text.subRailSecurity)]
    },
    {
      id: "workspace",
      label: text.subRailWorkspace,
      // The scope of one group: the workspace its pages change.
      scope: (
        <Select size="sm" aria-label={text.subRailScope}>
          <option>{text.navWorkspace}</option>
        </Select>
      ),
      items: [
        item("general", text.subRailGeneral),
        { ...item("members", text.subRailMembers, 3), countTone: "primary" },
        item("defaults", text.subRailDefaults)
      ]
    }
  ];
  const labels: Record<SettingsRoute, string> = {
    profile: text.subRailProfile,
    security: text.subRailSecurity,
    general: text.subRailGeneral,
    members: text.subRailMembers,
    defaults: text.subRailDefaults
  };

  return (
    <div className="rounded-lg border" data-gallery-sample="subrail-routes">
      <Page
        subRail={
          <SubRail
            title={text.settings}
            label={text.subRailSettings}
            groups={groups}
            value={route}
            onValueChange={(id) => setRoute(toSettingsRoute(id, route))}
          />
        }
      >
        <p className="text-caption text-muted-foreground">{text.subRailOpenPage}</p>
        <p className="text-title" data-gallery-sample="subrail-route">
          {labels[route]}
        </p>
      </Page>
    </div>
  );
}

const settingsRoutes: readonly SettingsRoute[] = [
  "profile",
  "security",
  "general",
  "members",
  "defaults"
];

function toSettingsRoute(id: string, fallback: SettingsRoute): SettingsRoute {
  return settingsRoutes.find((candidate) => candidate === id) ?? fallback;
}

function PageOutlineSample({
  text,
  underHeader = false
}: {
  text: GalleryText;
  /** The page has a detail head across its width: the outline and the content start under it. */
  underHeader?: boolean;
}) {
  // The gallery can show the same sample twice, side by side, so the anchors are made unique.
  const prefix = useId();
  const sections = [
    { id: `${prefix}overview`, title: text.sectionOverview, body: text.sectionOverviewDescription },
    {
      id: `${prefix}instructions`,
      title: text.sectionInstructions,
      body: text.sectionInstructionsDescription
    },
    { id: `${prefix}skills`, title: text.sectionSkills, body: text.sectionSkillsDescription },
    { id: `${prefix}history`, title: text.sectionHistory, body: text.sectionHistoryDescription }
  ];
  // Every state: the section in view, one with a count and one with an error.
  const items: PageOutlineItem[] = sections.map((section, index) => ({
    id: section.id,
    label: section.title,
    count: index === 2 ? 4 : undefined,
    invalid: index === 1
  }));

  return (
    <div
      className="h-80 overflow-y-auto rounded-lg border"
      data-gallery-sample={underHeader ? "page-outline-header" : "page-outline"}
    >
      <Page
        header={
          underHeader ? (
            <PageHeader
              variant="detail"
              headingLevel={2}
              title={text.pageOutlineHeaderTitle}
              secondaryActions={
                <Button variant="outline" size="sm">
                  {text.sectionHistory}
                </Button>
              }
            />
          ) : undefined
        }
        outline={<PageOutline belowHeader={underHeader} items={items} />}
      >
        {sections.map((section) => (
          <Section key={section.id} id={section.id} layout="stacked" title={section.title}>
            <p className="min-h-40 text-body text-muted-foreground">{section.body}</p>
          </Section>
        ))}
      </Page>
    </div>
  );
}

type WorkspaceTab = "general" | "members" | "requests";

function TabsSamples({ text }: { text: GalleryText }) {
  const [route, setRoute] = useState<WorkspaceTab>("members");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [view, setView] = useState("preview");
  const routes: { id: WorkspaceTab; label: string; count?: number }[] = [
    { id: "general", label: text.tabsGeneral },
    { id: "members", label: text.tabsMembers, count: 12 },
    { id: "requests", label: text.tabsRequests, count: 3 }
  ];
  return (
    <>
      <div className="grid gap-2">
        <span className="text-caption font-medium text-muted-foreground">{text.tabsViews}</span>
        <Tabs defaultValue="general">
          <TabsList label={text.tabsLabel}>
            <TabsTrigger value="general">{text.tabsGeneral}</TabsTrigger>
            <TabsTrigger value="members" count={12}>
              {text.tabsMembers}
            </TabsTrigger>
            <TabsTrigger value="requests" count={3} countTone="primary">
              {text.tabsRequests}
            </TabsTrigger>
            <TabsTrigger value="audit" disabled>
              {text.tabsAudit}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="py-4 text-body">
            {text.tabsGeneralBody}
          </TabsContent>
          <TabsContent value="members" className="py-4 text-body">
            {text.tabsMembersBody}
          </TabsContent>
          <TabsContent value="requests" className="py-4 text-body">
            {text.tabsRequestsBody}
          </TabsContent>
        </Tabs>
      </div>
      <div className="grid gap-2" data-gallery-sample="tabs-folded">
        <span className="text-caption font-medium text-muted-foreground">{text.tabsFolded}</span>
        <Tabs value={view} onValueChange={setView}>
          <TabsList
            label={text.tabsLabel}
            end={
              <TabsDisclosure
                open={detailsOpen}
                onOpenChange={(open) => {
                  setDetailsOpen(open);
                  if (!open) {
                    setView("preview");
                  }
                }}
              >
                {text.tabsDetails}
              </TabsDisclosure>
            }
          >
            <TabsTrigger value="preview">{text.tabsPreview}</TabsTrigger>
            {detailsOpen ? <TabsTrigger value="files">{text.tabsFiles}</TabsTrigger> : null}
          </TabsList>
        </Tabs>
      </div>
      <div className="grid gap-2" data-gallery-sample="tabs-routes">
        <span className="text-caption font-medium text-muted-foreground">{text.tabsRoutes}</span>
        <TabsNav label={text.tabsLabel}>
          {routes.map((tab) => (
            <TabsLink key={tab.id} selected={tab.id === route} count={tab.count} asChild>
              {sampleLink(() => setRoute(tab.id), tab.label)}
            </TabsLink>
          ))}
        </TabsNav>
      </div>
    </>
  );
}

const segmentSizes: readonly SegmentedControlSize[] = ["md", "sm"];

function SegmentedControlSamples({ text }: { text: GalleryText }) {
  return (
    <>
      {segmentSizes.map((size) => (
        <Samples key={size} label={size}>
          <SegmentedControl label={text.segmentLabel} size={size} defaultValue="users">
            <SegmentedControlItem value="users">{text.segmentUsers}</SegmentedControlItem>
            <SegmentedControlItem value="permissions">
              {text.segmentPermissions}
            </SegmentedControlItem>
          </SegmentedControl>
          <SegmentedControl label={text.segmentPreviewLabel} size={size} defaultValue="preview">
            <SegmentedControlItem value="preview">
              <AppWindow aria-hidden="true" />
              {text.segmentPreview}
            </SegmentedControlItem>
            <SegmentedControlItem value="files">
              <ListIcon aria-hidden="true" />
              {text.segmentFiles}
            </SegmentedControlItem>
          </SegmentedControl>
          <SegmentedControl label={text.segmentPolicyLabel} size={size} defaultValue="ask">
            <SegmentedControlItem value="allow">
              <ShieldCheck aria-hidden="true" />
              {text.segmentAllow}
            </SegmentedControlItem>
            <SegmentedControlItem value="ask">{text.segmentAsk}</SegmentedControlItem>
            <SegmentedControlItem value="never" disabled>
              {text.segmentNever}
            </SegmentedControlItem>
          </SegmentedControl>
          <SegmentedControl label={text.tabsLabel} size={size} defaultValue="members">
            <SegmentedControlItem value="members" count={12}>
              {text.tabsMembers}
            </SegmentedControlItem>
            <SegmentedControlItem value="requests" count={3}>
              {text.tabsRequests}
            </SegmentedControlItem>
          </SegmentedControl>
          <SegmentedControl label={text.tabsLabel} size={size} defaultValue="requests">
            <SegmentedControlItem value="members" count={600} exactCount>
              {text.tabsMembers}
            </SegmentedControlItem>
            <SegmentedControlItem value="requests" count={3} exactCount>
              {text.tabsRequests}
            </SegmentedControlItem>
          </SegmentedControl>
          <SegmentedControl label={text.segmentLabel} size={size} defaultValue="users" disabled>
            <SegmentedControlItem value="users">{text.segmentUsers}</SegmentedControlItem>
            <SegmentedControlItem value="permissions">
              {text.segmentPermissions}
            </SegmentedControlItem>
          </SegmentedControl>
        </Samples>
      ))}
    </>
  );
}

export const navigationGallery: GalleryGroup = {
  id: "navigation",
  entries: [
    {
      name: "Sidebar",
      components: ["Sidebar"],
      render: (text) => <SidebarSample text={text} />
    },
    {
      name: "NavItem",
      components: ["NavItem", "NavGroup"],
      render: (text) => <NavItemSamples text={text} />
    },
    {
      name: "DocsLink",
      components: ["DocsLink", "DocsAddressProvider"],
      render: (text) => <DocsLinkSamples text={text} />
    },
    {
      name: "SkipLink",
      components: ["SkipLink"],
      render: (text) => <SkipLinkSample text={text} />
    },
    {
      name: "SubRail",
      components: ["SubRail"],
      render: (text) => (
        <>
          <Samples>
            <div className="w-full">
              <SubRailSample text={text} />
            </div>
          </Samples>
        </>
      )
    },
    {
      name: "PageOutline",
      components: ["PageOutline"],
      render: (text) => (
        <>
          <Samples label={text.pageOutlinePlain}>
            <div className="w-full">
              <PageOutlineSample text={text} />
            </div>
          </Samples>
          <Samples label={text.pageOutlineHeader}>
            <div className="w-full">
              <PageOutlineSample text={text} underHeader />
            </div>
          </Samples>
        </>
      )
    },
    {
      name: "Tabs",
      components: [
        "Tabs",
        "TabsList",
        "TabsTrigger",
        "TabsContent",
        "TabsDisclosure",
        "TabsNav",
        "TabsLink"
      ],
      render: (text) => <TabsSamples text={text} />
    },
    {
      name: "Breadcrumb",
      components: ["Breadcrumb"],
      render: (text) => (
        <Samples label={text.tabsRoutes}>
          <Breadcrumb
            label={text.tabsLabel}
            items={[
              { id: "general", label: text.tabsGeneral, href: "#" },
              { id: "members", label: text.tabsMembers, onSelect: () => undefined },
              { id: "requests", label: text.tabsRequests }
            ]}
          />
        </Samples>
      )
    },
    {
      name: "SegmentedControl",
      components: ["SegmentedControl", "SegmentedControlItem"],
      render: (text) => <SegmentedControlSamples text={text} />
    }
  ]
};
