import { Ellipsis, Search, SearchX } from "lucide-react";
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
import { Samples, type GalleryGroup } from "./entry";
import { EmptyState } from "../feedback/empty-state";
import { Avatar } from "../status/avatar";
import type { GalleryText } from "./text";

const rowSizes: readonly ListRowSize[] = ["default", "compact"];
const keyValueLayouts: readonly KeyValueLayout[] = ["inline", "stacked"];

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
      {rowSizes.map((size) => (
        <Samples key={size} label={rowSizeLabel(size, text)}>
          <List className="w-full" aria-label={text.rowListLabel}>
            <ListRow
              size={size}
              leading={<Avatar kind="agent" size="sm" name={text.rowAgent} />}
              title={text.rowAgent}
              description={size === "default" ? text.rowAgentStatus : undefined}
              chips={<Badge size="sm">{text.rowScopeInstance}</Badge>}
              time={text.today}
              actions={<RowMenu text={text} />}
            />
            <ListRow
              size={size}
              leading={<Avatar kind="person" size="sm" name={text.rowPerson} />}
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
            leading={<Avatar kind="app" size="sm" name={text.rowKnowledge} />}
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
            leading={<Avatar kind="agent" size="sm" name={text.rowAgent} />}
            title={text.rowAgent}
            description={text.rowAgentStatus}
            onClick={() => setSelected("agent")}
          />
          <ListRow
            selected={selected === "workflow"}
            leading={<Avatar kind="agent" size="sm" name={text.rowWorkflow} />}
            title={text.rowWorkflow}
            description={text.rowWorkflowStatus}
            onClick={() => setSelected("workflow")}
          />
          <ListRow
            disabled
            leading={<Avatar kind="app" size="sm" name={text.rowKnowledge} />}
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
              <Avatar kind="agent" size="sm" name={text.rowAgent} />
              {text.rowAgent}
            </span>
          </TableCell>
          <TableCell>
            <span className="flex items-center gap-2">
              <Avatar kind="person" size="sm" name={text.rowPerson} />
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
              <Avatar kind="agent" size="sm" name={text.rowWorkflow} />
              {text.rowWorkflow}
            </span>
          </TableCell>
          <TableCell>
            <span className="flex items-center gap-2">
              <Avatar kind="person" size="sm" name={text.rowPerson} />
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
              <Avatar kind="app" size="sm" name={text.rowKnowledge} />
              {text.rowKnowledge}
            </span>
          </TableCell>
          <TableCell>
            <span className="flex items-center gap-2">
              <Avatar kind="person" size="sm" name={text.rowPerson} />
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
        <EmptyState
          icon={<SearchX aria-hidden="true" />}
          action={
            <Button variant="outline" size="sm">
              {text.filterClear}
            </Button>
          }
        >
          {text.filterEmpty}
        </EmptyState>
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
                  <code className="font-mono">{text.keyUserIdValue}</code>
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
    }
  ]
};
