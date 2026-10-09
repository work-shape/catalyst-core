import { Ellipsis, Inbox, Search, SearchX } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { FilterBar } from "../data/filter-bar";
import { KeyValue, KeyValueList, type KeyValueLayout } from "../data/key-value";
import { List, ListRow, type ListRowSize } from "../data/list-row";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../data/table";
import { Input } from "../forms/input";
import { Select } from "../forms/select";
import { Badge } from "../status/badge";
import { CountBadge, type CountBadgeTone } from "../status/count-badge";
import { Samples, type GalleryGroup } from "./entry";
import { AvatarPlaceholder, EmptyStatePlaceholder } from "./placeholders";
import type { GalleryText } from "./text";

const rowSizes: readonly ListRowSize[] = ["default", "compact"];
const keyValueLayouts: readonly KeyValueLayout[] = ["inline", "stacked"];
const countTones: readonly CountBadgeTone[] = ["primary", "muted"];

function rowSizeLabel(size: ListRowSize, text: GalleryText): string {
  return size === "default" ? text.rowModeDefault : text.rowModeCompact;
}

function RowMenu({ text }: { text: GalleryText }) {
  return (
    <IconButton size="sm" label={text.moreActions}>
      <Ellipsis aria-hidden="true" />
    </IconButton>
  );
}

function ListRowSamples({ text }: { text: GalleryText }) {
  const [selected, setSelected] = useState("agent");
  return (
    <>
      <p className="text-caption text-muted-foreground">{text.placeholderNote}</p>
      {rowSizes.map((size) => (
        <Samples key={size} label={rowSizeLabel(size, text)}>
          <List className="w-full" aria-label={text.rowListLabel}>
            <ListRow
              size={size}
              leading={<AvatarPlaceholder kind="thing">{text.rowAgentInitials}</AvatarPlaceholder>}
              title={text.rowAgent}
              description={size === "default" ? text.rowAgentStatus : undefined}
              chips={<Badge size="sm">{text.rowScopeInstance}</Badge>}
              time={text.today}
              actions={<RowMenu text={text} />}
            />
            <ListRow
              size={size}
              leading={
                <AvatarPlaceholder kind="person">{text.rowPersonInitials}</AvatarPlaceholder>
              }
              title={text.rowPerson}
              description={size === "default" ? text.rowPersonStatus : undefined}
              time={text.yesterday}
              actions={<RowMenu text={text} />}
              actionsVisible
            />
          </List>
        </Samples>
      ))}
      <Samples label={text.rowModeLink}>
        <List className="w-full" aria-label={text.rowListLabel}>
          <ListRow
            link={<a href="#" onClick={(event) => event.preventDefault()} />}
            leading={
              <AvatarPlaceholder kind="thing">{text.rowKnowledgeInitials}</AvatarPlaceholder>
            }
            title={text.rowKnowledge}
            description={text.rowKnowledgeStatus}
            time={text.yesterday}
            actions={<RowMenu text={text} />}
          />
        </List>
      </Samples>
      <Samples label={text.rowModeButton}>
        <List className="w-full" aria-label={text.rowListLabel}>
          <ListRow
            selected={selected === "agent"}
            leading={<AvatarPlaceholder kind="thing">{text.rowAgentInitials}</AvatarPlaceholder>}
            title={text.rowAgent}
            description={text.rowAgentStatus}
            onClick={() => setSelected("agent")}
          />
          <ListRow
            selected={selected === "workflow"}
            leading={<AvatarPlaceholder kind="thing">{text.rowWorkflowInitials}</AvatarPlaceholder>}
            title={text.rowWorkflow}
            description={text.rowWorkflowStatus}
            onClick={() => setSelected("workflow")}
          />
          <ListRow
            disabled
            leading={
              <AvatarPlaceholder kind="thing">{text.rowKnowledgeInitials}</AvatarPlaceholder>
            }
            title={text.rowKnowledge}
            description={text.disabled}
            onClick={() => setSelected("knowledge")}
          />
        </List>
      </Samples>
      <Samples label={text.rowModeExpandable}>
        <List className="w-full" aria-label={text.rowListLabel}>
          <ListRow
            expandable
            title={text.rowWorkflow}
            description={text.rowWorkflowStatus}
            time={text.today}
          >
            <p className="text-muted-foreground">{text.rowExpandedBody}</p>
          </ListRow>
          <ListRow expandable defaultExpanded size="compact" title={text.rowAgent}>
            <p className="text-muted-foreground">{text.rowAgentStatus}</p>
          </ListRow>
        </List>
      </Samples>
    </>
  );
}

function AssetTable({ text }: { text: GalleryText }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{text.tableName}</TableHead>
          <TableHead>{text.tableOwner}</TableHead>
          <TableHead>{text.tableState}</TableHead>
          <TableHead>{text.tableUpdated}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>
            <span className="flex items-center gap-2">
              <AvatarPlaceholder kind="thing">{text.rowAgentInitials}</AvatarPlaceholder>
              {text.rowAgent}
            </span>
          </TableCell>
          <TableCell>
            <span className="flex items-center gap-2">
              <AvatarPlaceholder kind="person">{text.rowPersonInitials}</AvatarPlaceholder>
              {text.rowPerson}
            </span>
          </TableCell>
          <TableCell>
            <Badge tone="success">{text.statePublished}</Badge>
          </TableCell>
          <TableCell className="text-muted-foreground">{text.today}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>
            <span className="flex items-center gap-2">
              <AvatarPlaceholder kind="thing">{text.rowWorkflowInitials}</AvatarPlaceholder>
              {text.rowWorkflow}
            </span>
          </TableCell>
          <TableCell>
            <span className="flex items-center gap-2">
              <AvatarPlaceholder kind="person">{text.rowPersonInitials}</AvatarPlaceholder>
              {text.rowPerson}
            </span>
          </TableCell>
          <TableCell>
            <Badge tone="info">{text.stateRunning}</Badge>
          </TableCell>
          <TableCell className="text-muted-foreground">{text.today}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>
            <span className="flex items-center gap-2">
              <AvatarPlaceholder kind="thing">{text.rowKnowledgeInitials}</AvatarPlaceholder>
              {text.rowKnowledge}
            </span>
          </TableCell>
          <TableCell>
            <span className="flex items-center gap-2">
              <AvatarPlaceholder kind="person">{text.rowPersonInitials}</AvatarPlaceholder>
              {text.rowPerson}
            </span>
          </TableCell>
          <TableCell>
            <Badge>{text.stateDraft}</Badge>
          </TableCell>
          <TableCell className="text-muted-foreground">{text.yesterday}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function FilterBarSamples({ text }: { text: GalleryText }) {
  const filters = (
    <Select className="w-40" aria-label={text.filterStatus}>
      <option>{text.filterAllStatuses}</option>
      <option>{text.statePublished}</option>
      <option>{text.stateDraft}</option>
    </Select>
  );
  const search = (
    <Input
      type="search"
      aria-label={text.searchPlaceholder}
      placeholder={text.searchPlaceholder}
      leadingIcon={<Search aria-hidden="true" />}
    />
  );
  return (
    <>
      <p className="text-caption text-muted-foreground">{text.placeholderNote}</p>
      <div className="grid gap-4" data-gallery-sample="filter-table">
        <FilterBar
          search={search}
          filters={filters}
          count={text.filterResults}
          actions={<Button variant="outline">{text.addItem}</Button>}
        />
        <AssetTable text={text} />
      </div>
      <div className="grid gap-4" data-gallery-sample="filter-empty">
        <FilterBar search={search} filters={filters} count={text.filterNoResults} />
        <EmptyStatePlaceholder
          icon={<SearchX aria-hidden="true" />}
          sentence={text.filterEmpty}
          action={
            <Button variant="outline" size="sm">
              {text.filterClear}
            </Button>
          }
        />
      </div>
    </>
  );
}

export const dataGallery: GalleryGroup = {
  id: "data",
  entries: [
    {
      name: "Table",
      components: ["Table", "TableHeader", "TableBody", "TableRow", "TableHead", "TableCell"],
      render: (text) => (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{text.tableName}</TableHead>
              <TableHead>{text.tableState}</TableHead>
              <TableHead>{text.tableUpdated}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>{text.rowAgent}</TableCell>
              <TableCell>
                <Badge tone="success">{text.statePublished}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{text.today}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{text.rowWorkflow}</TableCell>
              <TableCell>
                <Badge tone="info">{text.stateRunning}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{text.today}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>{text.rowKnowledge}</TableCell>
              <TableCell>
                <Badge>{text.stateDraft}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{text.yesterday}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      )
    },
    {
      name: "ListRow",
      components: ["List", "ListRow"],
      render: (text) => <ListRowSamples text={text} />
    },
    {
      name: "FilterBar",
      components: ["FilterBar"],
      render: (text) => <FilterBarSamples text={text} />
    },
    {
      name: "KeyValue",
      components: ["KeyValueList", "KeyValue"],
      render: (text) => (
        <div className="grid items-start gap-6 sm:grid-cols-2">
          {keyValueLayouts.map((layout) => (
            <Samples key={layout} label={layout === "inline" ? text.keyInline : text.keyStacked}>
              <KeyValueList layout={layout} className="w-full">
                <KeyValue label={text.keyUserId} copyValue={text.keyUserIdValue}>
                  <code className="font-mono text-code">{text.keyUserIdValue}</code>
                </KeyValue>
                <KeyValue label={text.keyCreated}>{text.keyCreatedValue}</KeyValue>
                <KeyValue label={text.keyLastActive}>{text.today}</KeyValue>
                <KeyValue label={text.keyPrompt} copyValue={text.keyPromptValue} foldable>
                  {text.keyPromptValue}
                </KeyValue>
              </KeyValueList>
            </Samples>
          ))}
        </div>
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
    }
  ]
};
