import {
  AppWindow,
  Hammer,
  Inbox,
  List as ListIcon,
  MessageSquare,
  PanelLeft,
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
import { NavGroup, NavItem, useSidebarCollapsed } from "../navigation/nav-item";
import {
  SegmentedControl,
  SegmentedControlItem,
  type SegmentedControlSize
} from "../navigation/segmented-control";
import { Sidebar } from "../navigation/sidebar";
import { SubRail, type SubRailGroup } from "../navigation/sub-rail";
import { Tabs, TabsContent, TabsLink, TabsList, TabsNav, TabsTrigger } from "../navigation/tabs";
import { Page } from "../structure/page";
import { Section } from "../structure/section";
import { Samples, type GalleryGroup } from "./entry";
import { AvatarPlaceholder } from "./placeholders";
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
    return toggle;
  }
  return (
    <div className="flex min-w-0 items-center gap-2 pl-2">
      <AvatarPlaceholder kind="thing">{text.navWorkspaceInitials}</AvatarPlaceholder>
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
          <AvatarPlaceholder kind="person">{text.navAccountInitials}</AvatarPlaceholder>
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 pl-2">
      <AvatarPlaceholder kind="person">{text.navAccountInitials}</AvatarPlaceholder>
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
    </div>
  );
}

type SettingsRoute = "profile" | "security" | "general" | "members" | "defaults";

function SubRailRoutesSample({ text }: { text: GalleryText }) {
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
            mode="routes"
            label={text.subRailSettings}
            groups={groups}
            value={route}
            onValueChange={(id) => setRoute(toSettingsRoute(id, route))}
            scope={
              <Select size="sm" aria-label={text.subRailScope}>
                <option>{text.navWorkspace}</option>
              </Select>
            }
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

function SubRailAnchorsSample({ text }: { text: GalleryText }) {
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
  const groups: SubRailGroup[] = [
    {
      id: "sections",
      items: sections.map((section, index) => ({
        id: section.id,
        label: section.title,
        count: index === 2 ? 4 : undefined
      }))
    }
  ];

  return (
    <div
      className="h-80 overflow-y-auto rounded-lg border [scrollbar-width:thin]"
      data-gallery-sample="subrail-anchors"
    >
      <Page subRail={<SubRail mode="anchors" label={text.subRailSections} groups={groups} />}>
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
            <TabsTrigger value="requests" count={3}>
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
      name: "SubRail",
      components: ["SubRail"],
      render: (text) => (
        <>
          <Samples label={text.subRailRoutes}>
            <div className="w-full">
              <SubRailRoutesSample text={text} />
            </div>
          </Samples>
          <Samples label={text.subRailAnchors}>
            <div className="w-full">
              <SubRailAnchorsSample text={text} />
            </div>
          </Samples>
        </>
      )
    },
    {
      name: "Tabs",
      components: ["Tabs", "TabsList", "TabsTrigger", "TabsContent", "TabsNav", "TabsLink"],
      render: (text) => <TabsSamples text={text} />
    },
    {
      name: "SegmentedControl",
      components: ["SegmentedControl", "SegmentedControlItem"],
      render: (text) => <SegmentedControlSamples text={text} />
    }
  ]
};
