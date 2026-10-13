import { Bot, Check, Inbox, LayoutGrid, Shield, Users, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { Spinner } from "../feedback/spinner";
import { Avatar, type AvatarKind, type AvatarSize } from "../status/avatar";
import { Badge, type BadgeAppearance, type BadgeTone } from "../status/badge";
import { Chip, ScopeChip, type ChipSize } from "../status/chip";
import { CountBadge, type CountBadgeTone } from "../status/count-badge";
import { fileTypeIcons } from "../status/file-type-icons";
import {
  genericIcons,
  IconRegistryProvider,
  RegistryIcon,
  type IconFamily
} from "../status/registry-icon";
import { KnowsHowTo, SkillIcon, type SkillIconSize } from "../status/skill-icon";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const skillIconSizes: readonly SkillIconSize[] = ["sm", "md", "lg"];
const shippedSkillIcons = ["spreadsheet", "document", "presentation", "pdf"] as const;

const iconFamilies: readonly IconFamily[] = ["file", "service", "skill", "tool"];
const fileTypeKeys = Object.keys(fileTypeIcons);
const fileIconSizes = ["size-4", "size-5", "size-7"] as const;
const iconSample =
  "flex items-center gap-2 text-caption text-muted-foreground [&_svg]:size-4 [&_svg]:text-foreground";
const badgeTones: readonly BadgeTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "accent"
];
const badgeAppearances: readonly BadgeAppearance[] = ["soft", "outline"];

function toneLabel(tone: BadgeTone, text: GalleryText): string {
  const labels: Record<BadgeTone, string> = {
    neutral: text.stateDraft,
    info: text.stateRunning,
    success: text.statePublished,
    warning: text.stateNeedsReconnect,
    danger: text.stateFailed,
    accent: text.stateNew
  };
  return labels[tone];
}

const avatarSizes: readonly AvatarSize[] = ["xs", "sm", "md", "lg"];
const avatarKinds: readonly AvatarKind[] = ["person", "workspace", "agent", "app"];
const chipSizes: readonly ChipSize[] = ["sm", "md"];
const countTones: readonly CountBadgeTone[] = ["primary", "muted"];

// A workspace's own colour pair, as a user picks one. Chart colours stand in for it here.
const sampleAccent = { background: "var(--chart-4)", foreground: "var(--background)" };

function avatarName(kind: AvatarKind, text: GalleryText): string {
  const names: Record<AvatarKind, string> = {
    person: text.personName,
    workspace: text.workspaceMarketing,
    agent: text.rowAgent,
    app: text.rowWorkflow
  };
  return names[kind];
}

function kindLabel(kind: AvatarKind, text: GalleryText): string {
  const labels: Record<AvatarKind, string> = {
    person: text.avatarPerson,
    workspace: text.avatarWorkspace,
    agent: text.avatarAgent,
    app: text.avatarApp
  };
  return labels[kind];
}

function RemovableChips({ text }: { text: GalleryText }) {
  const all = [text.workspaceMarketing, text.workspaceFinance, text.workspaceLegal];
  const [removed, setRemoved] = useState<readonly string[]>([]);
  return (
    <Samples>
      {all
        .filter((name) => !removed.includes(name))
        .map((name) => (
          <Chip
            key={name}
            leading={<Users aria-hidden="true" />}
            onRemove={() => setRemoved([...removed, name])}
          >
            {name}
          </Chip>
        ))}
      {removed.length === 0 ? null : (
        <Button variant="ghost" size="sm" onClick={() => setRemoved([])}>
          {text.showAgain}
        </Button>
      )}
    </Samples>
  );
}

export const statusGallery: GalleryGroup = {
  id: "status",
  entries: [
    {
      name: "Badge",
      components: ["Badge"],
      render: (text) => (
        <>
          {badgeAppearances.map((appearance) => (
            <Samples key={appearance} label={appearance}>
              {badgeTones.map((tone) => (
                <Badge key={tone} tone={tone} appearance={appearance}>
                  {toneLabel(tone, text)}
                </Badge>
              ))}
            </Samples>
          ))}
          <Samples>
            {badgeTones.map((tone) => (
              <Badge key={tone} tone={tone} size="sm" dot>
                {toneLabel(tone, text)}
              </Badge>
            ))}
            <Badge tone="success">
              <Check aria-hidden="true" />
              {text.statePublished}
            </Badge>
          </Samples>
          <Samples label="leading">
            <Badge tone="info" leading={<Spinner size="xs" />}>
              {text.stateRunning}
            </Badge>
            <Badge tone="neutral" appearance="outline" leading={<Spinner size="xs" />}>
              {text.stateRunning}
            </Badge>
            <Badge tone="success" size="sm" leading={<Check />}>
              {text.statePublished}
            </Badge>
            <Badge tone="danger" leading={<X />} dot>
              {text.stateFailed}
            </Badge>
          </Samples>
        </>
      )
    },
    {
      name: "Avatar",
      components: ["Avatar"],
      render: (text) => (
        <>
          {avatarKinds.map((kind) => (
            <Samples key={kind} label={kindLabel(kind, text)}>
              {avatarSizes.map((size) => (
                <Avatar key={size} kind={kind} size={size} name={avatarName(kind, text)} />
              ))}
              <Avatar kind={kind} name={avatarName(kind, text)} accent={sampleAccent} />
              {kind === "workspace" ? (
                <Avatar
                  kind={kind}
                  name={avatarName(kind, text)}
                  emoji="📣"
                  accent={sampleAccent}
                />
              ) : null}
              {kind === "agent" ? (
                <Avatar
                  kind={kind}
                  name={avatarName(kind, text)}
                  icon={<Bot aria-hidden="true" />}
                />
              ) : null}
              {kind === "app" ? (
                <Avatar
                  kind={kind}
                  size="lg"
                  name={avatarName(kind, text)}
                  icon={<LayoutGrid aria-hidden="true" />}
                />
              ) : null}
            </Samples>
          ))}
        </>
      )
    },
    {
      name: "Chip",
      components: ["Chip", "ScopeChip"],
      render: (text) => (
        <>
          {chipSizes.map((size) => (
            <Samples key={size} label={size}>
              <Chip size={size}>{text.roleMember}</Chip>
              <Chip size={size} leading={<Shield aria-hidden="true" />}>
                {text.roleAdmin}
              </Chip>
              <Chip size={size} leading={<Avatar kind="person" size="xs" name={text.personName} />}>
                {text.personName}
              </Chip>
              <Chip size={size} leading={<Users aria-hidden="true" />} lockLabel={text.readOnly}>
                {text.groupEditors}
              </Chip>
              <Chip size={size} href="#chip">
                {text.learnMore}
              </Chip>
              <Chip size={size} onClick={() => undefined}>
                {text.emptyPresetBriefing}
              </Chip>
            </Samples>
          ))}
          <RemovableChips text={text} />
          <Samples label="ScopeChip">
            <ScopeChip scope="instance" name={text.instanceName} />
            <ScopeChip scope="instance" name={text.instanceName} readOnlyLabel={text.readOnly} />
            <ScopeChip scope="workspace" name={text.workspaceMarketing} />
            <ScopeChip
              scope="workspace"
              name={text.workspaceFinance}
              emoji="💶"
              accent={sampleAccent}
            />
            <ScopeChip
              scope="workspace"
              size="sm"
              name={text.workspaceLegal}
              accent={sampleAccent}
              readOnlyLabel={text.readOnly}
            />
            <ScopeChip scope="workspace" name={text.workspaceMarketing} href="#scope" />
          </Samples>
        </>
      )
    },
    {
      name: "CountBadge",
      components: ["CountBadge"],
      render: (text) => (
        <>
          {countTones.map((tone) => (
            <Samples key={tone} label={tone === "primary" ? text.countPrimary : text.countMuted}>
              <CountBadge tone={tone} count={3} />
              <CountBadge tone={tone} count={42} />
              <CountBadge tone={tone} count={99} />
              <CountBadge tone={tone} count={100} />
            </Samples>
          ))}
          <Samples label={text.countDot}>
            <CountBadge dot role="img" aria-label={text.countPending} />
            <CountBadge dot tone="muted" role="img" aria-label={text.countPending} />
            <span className="relative inline-flex">
              <Button variant="outline" size="icon" aria-label={text.navInbox}>
                <Inbox aria-hidden="true" />
              </Button>
              <CountBadge count={3} className="absolute -top-1 -right-1" />
            </span>
          </Samples>
        </>
      )
    },
    {
      name: "RegistryIcon",
      components: ["RegistryIcon", "IconRegistryProvider"],
      render: (text) => (
        <>
          <Samples label={text.iconsFileTypes}>
            {fileTypeKeys.map((name) => (
              <span
                key={name}
                data-gallery-sample={`icon-file-${name}`}
                className="flex items-center gap-2 text-caption text-muted-foreground"
              >
                <RegistryIcon name={name} family="file" className="size-7" />
                {name}
              </span>
            ))}
          </Samples>
          <Samples label={text.iconsFileSizes}>
            {fileIconSizes.map((size) => (
              <span key={size} className="flex items-center gap-1">
                {fileTypeKeys.map((name) => (
                  <RegistryIcon key={name} name={name} family="file" className={size} />
                ))}
              </span>
            ))}
          </Samples>
          <Samples label={text.iconsGeneric}>
            {Object.keys(genericIcons)
              .filter((name) => !fileTypeKeys.includes(name))
              .map((name) => (
                <span key={name} data-gallery-sample={`icon-${name}`} className={iconSample}>
                  <RegistryIcon name={name} />
                  {name}
                </span>
              ))}
          </Samples>
          <Samples label={text.iconsFamilies}>
            {iconFamilies.map((family) => (
              <span
                key={family}
                data-gallery-sample={`icon-family-${family}`}
                className={iconSample}
              >
                <RegistryIcon name="unknown" family={family} />
                {family}
              </span>
            ))}
          </Samples>
          <Samples label={text.iconsFallback}>
            <IconRegistryProvider icons={{ ledger: genericIcons.files }}>
              {[
                ["outlook", "mail"],
                ["ledger", "database"],
                ["unknown", undefined]
              ].map(([name, fallback]) => (
                <span key={name} className={iconSample}>
                  <RegistryIcon name={name} fallback={fallback} />
                  {name}
                </span>
              ))}
            </IconRegistryProvider>
          </Samples>
        </>
      )
    },
    {
      name: "SkillIcon",
      components: ["SkillIcon", "KnowsHowTo"],
      render: (text) => (
        <>
          <Samples label={text.skillIconSizes}>
            {skillIconSizes.map((size) => (
              <span
                key={size}
                data-gallery-sample={`skill-icon-${size}`}
                className="flex items-center gap-2"
              >
                {shippedSkillIcons.map((icon) => (
                  <SkillIcon key={icon} icon={icon} size={size} />
                ))}
                <SkillIcon size={size} />
              </span>
            ))}
          </Samples>
          <Samples label={text.skillIconInChip}>
            <Chip leading={<SkillIcon icon="spreadsheet" size="sm" />} onRemove={() => undefined}>
              {text.skillSpreadsheets}
            </Chip>
            <Chip leading={<SkillIcon icon="pdf" size="sm" />} onRemove={() => undefined}>
              {text.skillPdf}
            </Chip>
            <Chip leading={<SkillIcon size="sm" />} onRemove={() => undefined}>
              {text.skillPlainLanguage}
            </Chip>
            <Chip size="sm" leading={<SkillIcon icon="document" size="sm" />}>
              {text.skillDocuments}
            </Chip>
          </Samples>
          <Samples label={text.skillKnowsHowTo}>
            <KnowsHowTo
              label={text.skillKnowsHowToLabel}
              skills={[
                { title: text.skillSpreadsheets, icon: "spreadsheet" },
                { title: text.skillDocuments, icon: "document" },
                { title: text.skillPlainLanguage }
              ]}
            />
          </Samples>
        </>
      )
    }
  ]
};
