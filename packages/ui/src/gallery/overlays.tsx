import {
  Archive,
  Bot,
  ChevronDown,
  Copy,
  Ellipsis,
  Link,
  Pencil,
  Play,
  Search,
  SquarePen,
  Trash2
} from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { Field } from "../forms/field";
import { Select } from "../forms/select";
import { CommandPalette, type CommandPaletteGroup } from "../overlays/command-palette";
import { ConfirmDialog, type ConfirmDialogTone } from "../overlays/confirm-dialog";
import { Dialog, type DialogSize } from "../overlays/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../overlays/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../overlays/hover-card";
import { Picker, type PickerOption, type PickerOptionGroup } from "../overlays/picker";
import { Popover, PopoverContent, PopoverTrigger, type PopoverSize } from "../overlays/popover";
import { Avatar } from "../status/avatar";
import { Badge } from "../status/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { Samples, type GalleryGroup } from "./entry";
import type { GalleryText } from "./text";

const dialogSizes: readonly DialogSize[] = ["sm", "md", "lg"];

function DialogSamples({ text }: { text: GalleryText }) {
  const [openSize, setOpenSize] = useState<DialogSize | undefined>(undefined);
  const close = () => setOpenSize(undefined);
  return (
    <Samples>
      {dialogSizes.map((size) => (
        <Button key={size} variant="outline" onClick={() => setOpenSize(size)}>
          {text.openDialog} {size}
        </Button>
      ))}
      <Dialog
        open={openSize !== undefined}
        size={openSize}
        title={text.dialogTitle}
        description={text.dialogDescription}
        footer={
          <>
            <Button variant="outline" onClick={close}>
              {text.cancel}
            </Button>
            <Button variant="danger" onClick={close}>
              {text.delete}
            </Button>
          </>
        }
        onClose={close}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-body">{text.dialogBody}</p>
          <IconButton variant="outline" label={text.tooltipText}>
            <Copy aria-hidden="true" />
          </IconButton>
        </div>
      </Dialog>
    </Samples>
  );
}

interface ConfirmSample {
  tone: ConfirmDialogTone;
  loading: boolean;
}

function ConfirmDialogSamples({ text }: { text: GalleryText }) {
  const [sample, setSample] = useState<ConfirmSample | undefined>(undefined);
  const close = () => setSample(undefined);
  const danger = sample?.tone !== "primary";
  return (
    <Samples>
      <Button variant="outline" onClick={() => setSample({ tone: "danger", loading: false })}>
        {text.confirmDelete}
      </Button>
      <Button variant="outline" onClick={() => setSample({ tone: "primary", loading: false })}>
        {text.confirmPublish}
      </Button>
      <Button variant="outline" onClick={() => setSample({ tone: "danger", loading: true })}>
        {text.confirmWhileRunning}
      </Button>
      <ConfirmDialog
        open={sample !== undefined}
        tone={sample?.tone}
        loading={sample?.loading}
        title={danger ? text.confirmDeleteTitle : text.confirmPublishTitle}
        confirmLabel={danger ? text.delete : text.publish}
        onConfirm={close}
        onClose={close}
      >
        {danger ? text.confirmDeleteBody : text.confirmPublishBody}
      </ConfirmDialog>
    </Samples>
  );
}

const popoverSizes: readonly PopoverSize[] = ["sm", "md", "fit"];

function PopoverSamples({ text }: { text: GalleryText }) {
  return (
    <Samples>
      {popoverSizes.map((size) => (
        <Popover key={size}>
          <PopoverTrigger asChild>
            <Button variant="outline">
              {text.openPopover} {size}
            </Button>
          </PopoverTrigger>
          <PopoverContent size={size}>
            <div className="grid gap-3">
              <p className="text-body text-muted-foreground">{text.popoverBody}</p>
              <Field label={text.popoverTitle}>
                <Select>
                  <option>{text.stateDraft}</option>
                  <option>{text.statePublished}</option>
                </Select>
              </Field>
            </div>
          </PopoverContent>
        </Popover>
      ))}
    </Samples>
  );
}

function CommandPaletteSample({ text }: { text: GalleryText }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const conversations = [
    text.navConversationLease,
    text.navConversationTax,
    text.navConversationOffer
  ];
  const needle = query.trim().toLocaleLowerCase();
  const matches = conversations.filter((title) => title.toLocaleLowerCase().includes(needle));
  const groups: CommandPaletteGroup[] =
    needle === ""
      ? [
          {
            items: [
              {
                value: "new",
                label: text.navNewChat,
                leading: <SquarePen aria-hidden="true" />,
                shortcut: "⌘⇧O"
              }
            ]
          },
          {
            heading: text.navRecent,
            items: conversations.map((title) => ({ value: title, label: title }))
          }
        ]
      : [
          {
            heading: text.paletteConversations,
            items: matches.map((title) => ({ value: title, label: title }))
          }
        ];
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <Samples>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Search aria-hidden="true" />
        {text.paletteOpen}
      </Button>
      {chosen === undefined ? null : (
        <span className="text-body text-muted-foreground" data-gallery-sample="palette-chosen">
          {chosen}
        </span>
      )}
      <CommandPalette
        open={open}
        label={text.paletteLabel}
        query={query}
        groups={groups}
        message={needle !== "" && matches.length === 0 ? text.paletteNoMatch : undefined}
        onQueryChange={setQuery}
        onSelect={(value) => {
          setChosen(value === "new" ? text.navNewChat : value);
          close();
        }}
        onClose={close}
      />
    </Samples>
  );
}

function DropdownMenuSamples({ text }: { text: GalleryText }) {
  const [showDrafts, setShowDrafts] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  return (
    <Samples>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton variant="outline" label={text.moreActions}>
            <Ellipsis aria-hidden="true" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem icon={<Pencil aria-hidden="true" />} shortcut="E">
            {text.menuEdit}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Copy aria-hidden="true" />}>
            {text.menuDuplicate}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Link aria-hidden="true" />} shortcut="⌘C">
            {text.menuCopyLink}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Play aria-hidden="true" />}
            disabledReason={text.menuRunNowReason}
          >
            {text.menuRunNow}
          </DropdownMenuItem>
          <DropdownMenuItem icon={<Archive aria-hidden="true" />} disabled>
            {text.menuArchive}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Trash2 aria-hidden="true" />} tone="danger">
            {text.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {text.menuView}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup label={text.tableState}>
            <DropdownMenuCheckboxItem checked={showDrafts} onCheckedChange={setShowDrafts}>
              {text.menuShowDrafts}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={showArchived} onCheckedChange={setShowArchived}>
              {text.menuShowArchived}
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Samples>
  );
}

function agentOptions(text: GalleryText): (PickerOption | PickerOptionGroup)[] {
  const agent = (value: string, label: string, description?: string): PickerOption => ({
    value,
    label,
    description,
    leading: <Avatar kind="agent" size="sm" name={label} icon={<Bot aria-hidden="true" />} />
  });
  return [
    {
      heading: text.pickerGroupWorkspace,
      options: [
        {
          ...agent("support", text.rowAgent, text.agentSupportHint),
          trailing: (
            <Badge tone="accent" size="sm">
              {text.stateNew}
            </Badge>
          )
        },
        agent("research", text.agentResearch, text.agentResearchHint)
      ]
    },
    {
      heading: text.pickerGroupInstance,
      options: [
        agent("contracts", text.agentContracts, text.agentContractsHint),
        { ...agent("payroll", text.agentPayroll), disabledReason: text.agentPayrollReason }
      ]
    }
  ];
}

function workspaceOptions(text: GalleryText): PickerOption[] {
  return [text.workspaceMarketing, text.workspaceFinance, text.workspaceLegal].map((name) => ({
    value: name,
    label: name,
    leading: <Avatar kind="workspace" size="sm" name={name} />
  }));
}

function AgentPicker({ text }: { text: GalleryText }) {
  const [agent, setAgent] = useState<string | undefined>("support");
  const [created, setCreated] = useState<readonly string[]>([]);
  const options = [...agentOptions(text), ...created.map((name) => ({ value: name, label: name }))];
  const chosen = options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .find((option) => option.value === agent);
  return (
    <Picker
      search
      options={options}
      value={agent}
      create={{
        label: text.createAgent,
        onSelect: (search) => {
          const name = search === "" ? text.emptyAgentsAction : search;
          setCreated((names) => (names.includes(name) ? names : [...names, name]));
          setAgent(name);
        }
      }}
      onValueChange={setAgent}
    >
      <Button variant="outline">
        {chosen?.label ?? text.pickAgent}
        <ChevronDown aria-hidden="true" />
      </Button>
    </Picker>
  );
}

/** An icon that opens its list under the pointer, with descriptions in full and no search. */
function PointedAgentPicker({ text }: { text: GalleryText }) {
  const options: PickerOption[] = [
    { value: "support", label: text.rowAgent, description: text.agentSupportLongHint },
    { value: "research", label: text.agentResearch, description: text.agentResearchHint },
    { value: "contracts", label: text.agentContracts, description: text.agentContractsHint }
  ];
  const [agent, setAgent] = useState("support");
  const chosen = options.find((option) => option.value === agent);
  return (
    <Picker
      openOnHover
      wrapDescriptions
      label={text.pickAgent}
      options={options}
      value={agent}
      onValueChange={setAgent}
    >
      <Button variant="outline" size="icon" aria-label={`${text.pickAgent}: ${chosen?.label}`}>
        <Bot aria-hidden="true" />
      </Button>
    </Picker>
  );
}

/** So many agents that the list scrolls: the active row has to stay in view. */
function ManyAgentsPicker({ text }: { text: GalleryText }) {
  const options: PickerOption[] = text.manyAgents.map((label) => ({ value: label, label }));
  const [agent, setAgent] = useState(text.manyAgents[0]);
  return (
    <Picker label={text.pickAgent} options={options} value={agent} onValueChange={setAgent}>
      <Button variant="outline">
        {agent}
        <ChevronDown aria-hidden="true" />
      </Button>
    </Picker>
  );
}

function PickerSamples({ text }: { text: GalleryText }) {
  const [workspaces, setWorkspaces] = useState<readonly string[]>([text.workspaceMarketing]);
  const [role, setRole] = useState<string | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <Samples>
      <AgentPicker text={text} />
      <PointedAgentPicker text={text} />
      <ManyAgentsPicker text={text} />
      <Picker
        multiple
        options={workspaceOptions(text)}
        value={workspaces}
        onValueChange={setWorkspaces}
      >
        <Button variant="outline">
          {text.pickWorkspaces}
          <Badge size="sm">{workspaces.length}</Badge>
          <ChevronDown aria-hidden="true" />
        </Button>
      </Picker>
      <Picker
        options={[
          { value: "member", label: text.roleMember },
          { value: "admin", label: text.roleAdmin }
        ]}
        value={role}
        onValueChange={setRole}
      >
        <Button variant="outline">
          {role === undefined ? text.pickRole : role === "admin" ? text.roleAdmin : text.roleMember}
          <ChevronDown aria-hidden="true" />
        </Button>
      </Picker>
      <Button variant="outline" onClick={() => setDialogOpen(true)}>
        {text.pickerInDialog}
      </Button>
      <Dialog
        open={dialogOpen}
        size="sm"
        title={text.pickerInDialog}
        onClose={() => setDialogOpen(false)}
      >
        <AgentPicker text={text} />
      </Dialog>
    </Samples>
  );
}

/**
 * A tooltip that shows from the start, so its look is judged in every panel without hovering.
 * Escape lets go of it before anything else hears the key: held on, it would be the topmost
 * layer of the page and take the Escape meant for a dialog opened later. After that it opens
 * and closes as every tooltip does.
 */
function HeldTooltipSample({ text }: { text: GalleryText }) {
  const [held, setHeld] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!held) {
      return;
    }
    const release = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // At once, so the tooltip's layer is gone when the key reaches the document.
        flushSync(() => setHeld(false));
      }
    };
    window.addEventListener("keydown", release, { capture: true });
    return () => window.removeEventListener("keydown", release, { capture: true });
  }, [held]);

  return (
    <Tooltip open={held || open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Button variant="ghost">{text.learnMore}</Button>
      </TooltipTrigger>
      <TooltipContent side="right">{text.tooltipText}</TooltipContent>
    </Tooltip>
  );
}

export const overlaysGallery: GalleryGroup = {
  id: "overlays",
  entries: [
    {
      name: "Dialog",
      components: ["Dialog"],
      render: (text) => <DialogSamples text={text} />
    },
    {
      name: "ConfirmDialog",
      components: ["ConfirmDialog"],
      render: (text) => <ConfirmDialogSamples text={text} />
    },
    {
      name: "Popover",
      components: ["Popover", "PopoverTrigger", "PopoverContent"],
      render: (text) => <PopoverSamples text={text} />
    },
    {
      name: "DropdownMenu",
      components: [
        "DropdownMenu",
        "DropdownMenuTrigger",
        "DropdownMenuContent",
        "DropdownMenuGroup",
        "DropdownMenuItem",
        "DropdownMenuCheckboxItem",
        "DropdownMenuSeparator"
      ],
      render: (text) => <DropdownMenuSamples text={text} />
    },
    {
      name: "CommandPalette",
      components: ["CommandPalette"],
      render: (text) => <CommandPaletteSample text={text} />
    },
    {
      name: "Picker",
      components: ["Picker"],
      render: (text) => <PickerSamples text={text} />
    },
    {
      name: "Tooltip",
      components: ["Tooltip", "TooltipTrigger", "TooltipContent"],
      render: (text) => (
        <Samples>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">{text.tooltipText}</Button>
            </TooltipTrigger>
            <TooltipContent shortcut="⌘C">{text.tooltipText}</TooltipContent>
          </Tooltip>
          <HeldTooltipSample text={text} />
        </Samples>
      )
    },
    {
      name: "HoverCard",
      components: ["HoverCard", "HoverCardTrigger", "HoverCardContent"],
      render: (text) => (
        <Samples>
          <HoverCard openDelay={100}>
            <HoverCardTrigger asChild>
              <Button variant="outline">{text.hoverCardTrigger}</Button>
            </HoverCardTrigger>
            <HoverCardContent align="start">
              <p className="text-body">{text.hoverCardBody}</p>
            </HoverCardContent>
          </HoverCard>
        </Samples>
      )
    }
  ]
};
