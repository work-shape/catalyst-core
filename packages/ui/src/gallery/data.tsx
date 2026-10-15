import { Ellipsis, FileText, Search, SearchX } from "lucide-react";
import { useState } from "react";
import { Button } from "../actions/button";
import { IconButton } from "../actions/icon-button";
import { CodeBlock, type CodeToken } from "../data/code-block";
import { CommandLine } from "../data/command-line";
import { CodeFile } from "../data/code-file";
import { FilterBar } from "../data/filter-bar";
import { FoldedText } from "../data/folded-text";
import { KeyValue, KeyValueList, type KeyValueLayout } from "../data/key-value";
import { List, ListRow, type ListRowSize } from "../data/list-row";
import { Pagination } from "../data/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableCellDetail,
  TableHead,
  TableHeader,
  TableRow
} from "../data/table";
import { Input } from "../forms/input";
import { Select } from "../forms/select";
import { Badge } from "../status/badge";
import { Samples, type GalleryGroup } from "./entry";
import { EmptyState } from "../feedback/empty-state";
import { Avatar } from "../status/avatar";
import { chartGalleryEntry } from "./chart";
import { levelMeterGalleryEntry } from "./level-meter";
import { stepsGalleryEntry } from "./steps";
import type { GalleryText } from "./text";

/** A file as an agent writes it: long enough to scroll, with a line wider than the box. */
const codeSample = [
  'import { Chart, Table } from "@work-shape/catalyst-app-kit";',
  "",
  "export function Offers({ rows }: { rows: Offer[] }) {",
  "  const total = rows.reduce((sum, row) => sum + row.price, 0);",
  "  return (",
  "    <section>",
  '      <Chart type="bar" data={{ rows, category: "supplier", series: [{ field: "price", label: "Price" }] }} />',
  "      <Table>{rows.map(renderRow)}</Table>",
  "      <p>{total}</p>",
  "    </section>",
  "  );",
  "}",
  ""
].join("\n");

/** The keys of a small YAML text in a token colour, the way a highlighter hands them in. */
function sampleTokens(code: string): CodeToken[][] {
  return code.split("\n").map((line) => {
    const colon = line.indexOf(":");
    return colon < 0
      ? [{ text: line }]
      : [{ text: line.slice(0, colon), color: "var(--info)" }, { text: line.slice(colon) }];
  });
}

function CodeFileSample({ name, code }: { name: string; code: string }) {
  const [wrap, setWrap] = useState(false);
  return (
    <CodeFile
      className="h-40 w-full rounded-md border"
      name={name}
      code={code}
      tokens={sampleTokens(code)}
      wrap={wrap}
      onWrapChange={setWrap}
    />
  );
}

/** A result as a run keeps it: more lines than a preview shows. */
const jsonSample = JSON.stringify(
  {
    checked: 598,
    findings: [
      { client: "10432", rule: "duplicate-receipt", amount: 1240, account: "4400" },
      { client: "10432", rule: "allowance", amount: 812.5, account: "4400" },
      { client: "10977", rule: "rounding", amount: 0.03, account: "1200" }
    ]
  },
  null,
  2
);

/** Rows of data as a store holds them: many, with a number to compare and one long value. */
const dataRowRules = ["tableRuleDuplicate", "tableRuleAllowance", "tableRuleRounding"] as const;
const dataRows = Array.from({ length: 24 }, (_, index) => ({
  customer: String(10432 + index * 37),
  rule: dataRowRules[index % dataRowRules.length] ?? "tableRuleDuplicate",
  amount: 1240 / (index + 1) + index * 0.03,
  details: JSON.stringify({ account: String(4400 - index * 100), receipt: `R-${2031 + index}` })
}));

function DataTable({ text }: { text: GalleryText }) {
  const amount = new Intl.NumberFormat(text.chartLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return (
    <Table density="compact" stickyHeader data-gallery-sample="table-data">
      <TableHeader>
        <TableRow>
          <TableHead>{text.tableCustomer}</TableHead>
          <TableHead>{text.tableRule}</TableHead>
          <TableHead align="end">{text.tableAmount}</TableHead>
          <TableHead>{text.tableDetails}</TableHead>
          <TableHead>{text.tableNote}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {dataRows.map((row) => (
          <TableRow key={row.customer}>
            <TableCell>{row.customer}</TableCell>
            <TableCell truncate={24}>{text[row.rule]}</TableCell>
            <TableCell align="end">{amount.format(row.amount)}</TableCell>
            <TableCell truncate={18} title={row.details}>
              <code className="font-mono">{row.details}</code>
            </TableCell>
            <TableCell truncate={32}>{text.tableNoteValue}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

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
      <Samples label={text.rowModeRequest}>
        <List className="w-full" aria-label={text.rowListLabel}>
          <ListRow
            selected
            leading={<FileText aria-hidden="true" className="size-4 text-muted-foreground" />}
            title={text.rowRequest}
            description={text.rowRequestBy}
            descriptionLeading={<Avatar kind="person" size="xs" name={text.rowPerson} />}
            chips={<Badge size="sm">{text.rowRequestState}</Badge>}
            time={text.today}
            onClick={() => undefined}
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
          <TableCell>
            {text.today}
            <TableCellDetail>{text.tableUpdatedTime}</TableCellDetail>
          </TableCell>
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
          <TableCell>
            {text.today}
            <TableCellDetail>{text.tableUpdatedTime}</TableCellDetail>
          </TableCell>
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
          <TableCell>
            {text.yesterday}
            <TableCellDetail>{text.tableUpdatedTime}</TableCellDetail>
          </TableCell>
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

const PAGINATION_SAMPLE_TOTAL = 42;

function PaginationSample({ text }: { text: GalleryText }) {
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const pageCount = Math.ceil(PAGINATION_SAMPLE_TOTAL / rowsPerPage);
  const current = Math.min(page, pageCount);
  const from = (current - 1) * rowsPerPage + 1;
  const to = Math.min(current * rowsPerPage, PAGINATION_SAMPLE_TOTAL);
  return (
    <Pagination
      data-gallery-sample="pagination"
      page={current}
      pageCount={pageCount}
      onPageChange={setPage}
      range={text.paginationRange.replace("{from}", String(from)).replace("{to}", String(to))}
      rowsPerPage={rowsPerPage}
      onRowsPerPageChange={(next) => {
        setRowsPerPage(next);
        setPage(1);
      }}
      labels={{
        rows: text.paginationRows,
        rowsPerPage: text.paginationRowsPerPage,
        previous: text.paginationPrevious,
        next: text.paginationNext
      }}
    />
  );
}

export const dataGallery: GalleryGroup = {
  id: "data",
  entries: [
    {
      name: "Table",
      components: [
        "Table",
        "TableHeader",
        "TableBody",
        "TableRow",
        "TableHead",
        "TableCell",
        "TableCellDetail"
      ],
      render: (text) => (
        <>
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
          <Samples label={text.tableData}>
            <DataTable text={text} />
          </Samples>
          {/* The same rows in narrow room: each row a block, the name on a line of its own. */}
          <div className="max-w-xs">
            <Table narrow="stack">
              <TableHeader>
                <TableRow>
                  <TableHead>{text.tableName}</TableHead>
                  <TableHead>{text.tableState}</TableHead>
                  <TableHead>{text.tableUpdated}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell stacked="full">{text.rowAgent}</TableCell>
                  <TableCell>
                    <Badge tone="success">{text.statePublished}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{text.today}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell stacked="full">{text.rowWorkflow}</TableCell>
                  <TableCell>
                    <Badge tone="info">{text.stateRunning}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{text.today}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </>
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
      name: "Pagination",
      components: ["Pagination"],
      render: (text) => <PaginationSample text={text} />
    },
    {
      name: "KeyValue",
      components: ["KeyValueList", "KeyValue", "FoldedText"],
      render: (text) => (
        <div className="grid items-start gap-6 sm:grid-cols-2">
          <Samples label={text.keyPrompt}>
            <p className="max-w-80 text-caption text-muted-foreground">
              <FoldedText>{text.keyPromptValue}</FoldedText>
            </p>
          </Samples>
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
    },
    {
      name: "CodeBlock",
      components: ["CodeBlock", "CodeFile", "CommandLine"],
      render: (text) => (
        <div className="grid items-start gap-6 sm:grid-cols-2">
          <Samples label={text.codeWhole}>
            <CodeBlock className="w-full" label={text.codeFileName} code={codeSample} />
          </Samples>
          <Samples label={text.codeScrolling}>
            <CodeBlock className="max-h-32 w-full" label={text.codeFileName} code={codeSample} />
          </Samples>
          <Samples label={text.codeCut}>
            <CodeBlock
              label={text.codeOutputName}
              code={jsonSample}
              lineNumbers={false}
              maxLines={6}
              footer={text.codeCutFooter}
            />
          </Samples>
          <Samples label={text.codeCutNumbered}>
            <CodeBlock label={text.codeFileName} code={codeSample} maxLines={4} />
          </Samples>
          <Samples label={text.codeWrapped}>
            <CodeBlock className="w-full" label={text.codeFileName} code={codeSample} wrap />
          </Samples>
          <Samples label={text.codeAsFile}>
            <CodeFileSample name={text.codeConfigName} code={text.codeSample} />
          </Samples>
          <Samples label={text.codeCommand}>
            <CommandLine
              className="w-full"
              label={text.codeCommandLabel}
              command="npm install --global @work-shape/catalyst-cli@0.6.3 && catalyst setup codex --instance https://chat.catalyst.example"
            />
          </Samples>
        </div>
      )
    },
    stepsGalleryEntry,
    levelMeterGalleryEntry,
    chartGalleryEntry
  ]
};
