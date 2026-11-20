import { MessageSquare, Play, RefreshCw } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  Input,
  KeyValue,
  KeyValueList,
  List,
  ListRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { ReadState } from "./data-store-read-state";
import { KNOWLEDGE_STATUS_VIEWS, knowledgeTableLabel } from "./knowledge-base-model";
import { KnowledgeEmbedding } from "./knowledge-base-reindex";
import type {
  KnowledgeBaseSource,
  KnowledgeBaseState,
  KnowledgeQueryAnswer
} from "./knowledge-base-source";

/** How many rows the statement the test query starts with asks for. */
const FIRST_STATEMENT_ROWS = 20;

/**
 * Whether the published revision can read every table it describes, as its last check found
 * it, and the way to check again. The check reads the catalog of the store and no row.
 */
export function KnowledgeStatus({
  source,
  knowledgeBase,
  publishedRevision,
  canCheck,
  canReindex = false
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  publishedRevision: number;
  canCheck: boolean;
  /** Whether the reader may publish it, which a re-index asks as a changed model does. */
  canReindex?: boolean;
}) {
  const { t } = useTranslation();
  const read = source.useState(knowledgeBase, publishedRevision);
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<string>();
  const check = async () => {
    setChecking(true);
    const answer = await source.check(knowledgeBase);
    setChecking(false);
    setFailure(answer.ok ? undefined : (answer.message ?? t("knowledge.checkFailed")));
  };
  return (
    <ReadState read={read} failedText={t("knowledge.stateFailed")} rows={3}>
      {(state) => (
        <>
          <StatusFacts state={state} />
          {state.embedding ? (
            <KnowledgeEmbedding
              embedding={state.embedding}
              source={source}
              knowledgeBase={knowledgeBase}
              canReindex={canReindex}
            />
          ) : null}
          {failure ? <FormNotice tone="error">{failure}</FormNotice> : null}
          {canCheck ? (
            <div>
              <Button
                variant="outline"
                size="sm"
                loading={checking}
                onClick={() => {
                  check().catch(() => undefined);
                }}
              >
                <RefreshCw aria-hidden="true" />
                {t("knowledge.checkNow")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ReadState>
  );
}

function StatusFacts({ state }: { state: KnowledgeBaseState }) {
  const { locale, t } = useTranslation();
  const view = KNOWLEDGE_STATUS_VIEWS[state.status];
  return (
    <>
      <div role="status" data-knowledge-state={state.status}>
        <Badge tone={view.tone} dot>
          {t(view.label)}
        </Badge>
      </div>
      {state.status === "preparing" ? (
        <p className="text-label text-muted-foreground" data-knowledge-preparing="">
          {t("knowledge.statusPreparingDescription")}
        </p>
      ) : state.problem ? (
        <InlineError>{state.problem}</InlineError>
      ) : null}
      {state.checkedAt ? (
        <KeyValueList>
          <KeyValue label={t("knowledge.checkedAt")}>
            {formatDateTime(state.checkedAt, locale)}
          </KeyValue>
        </KeyValueList>
      ) : null}
      {state.tables.length === 0 ? null : (
        // A row per table: its name as a person reads it, the name itself small under it, and
        // whether it could be read after both, on a line of its own where they do not fit.
        <List aria-label={t("knowledge.tables")} className="-mx-2" data-knowledge-table-states="">
          {state.tables.map((table) => (
            <ListRow
              key={table.name}
              data-knowledge-table-state={table.name}
              title={knowledgeTableLabel(table.name)}
              description={<code className="font-mono">{table.name}</code>}
              descriptionWraps="always"
              chips={
                <Badge tone={table.readable ? "success" : "warning"} size="sm">
                  {t(table.readable ? "knowledge.tableReadable" : "knowledge.tableUnreadable")}
                </Badge>
              }
            />
          ))}
        </List>
      )}
    </>
  );
}

/**
 * What needs a person, at the top of the page of a Knowledge Base of tables: the last check
 * could not read every table, so agents do not answer from them. It says how many and leads
 * to the status, which waits folded. Nothing while the check found no problem.
 */
export function KnowledgeTablesAttention({
  source,
  knowledgeBase,
  publishedRevision,
  onShow
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  publishedRevision: number;
  /** Unfolds the status and goes to it. */
  onShow(): void;
}) {
  const { locale, t } = useTranslation();
  const read = source.useState(knowledgeBase, publishedRevision);
  if (read.status !== "ready" || read.data.status !== "needs_attention") {
    return null;
  }
  const unreadable = read.data.tables.filter((table) => !table.readable).length;
  return (
    <Banner
      tone="warning"
      className="mb-3"
      data-knowledge-attention=""
      action={
        <Button type="button" variant="outline" size="sm" onClick={onShow}>
          {t("knowledge.attentionShow")}
        </Button>
      }
    >
      {unreadable === 0
        ? t("knowledge.attentionGeneral")
        : t(unreadable === 1 ? "knowledge.attentionOne" : "knowledge.attentionMany", {
            count: new Intl.NumberFormat(locale).format(unreadable)
          })}
    </Banner>
  );
}

/**
 * A question in plain words about what the tables hold. It goes to the chat beside the page,
 * where an agent that has the Knowledge Base answers it: the page itself asks nothing, and the
 * person sends the question there.
 */
export function KnowledgeAsk({
  ask,
  agents
}: {
  ask(question: string): void;
  /** The published agents that have it, as far as the reader may see them. */
  agents: readonly { name: string; title: string }[] | undefined;
}) {
  const { locale, t } = useTranslation();
  const [question, setQuestion] = useState("");
  const send = () => {
    if (question.trim() !== "") ask(question.trim());
  };
  // The page is one form, which saves the Knowledge Base: Enter here asks and saves nothing.
  const askOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    send();
  };
  const names = (agents ?? []).map((agent) => agent.title || agent.name);
  return (
    <div className="grid min-w-0 gap-2" data-knowledge-ask="">
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <Field label={t("knowledge.askLabel")} className="min-w-56 flex-1">
          <Input
            value={question}
            placeholder={t("knowledge.askPlaceholder")}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={askOnEnter}
          />
        </Field>
        <Button type="button" variant="outline" disabled={question.trim() === ""} onClick={send}>
          <MessageSquare aria-hidden="true" />
          {t("knowledge.askRun")}
        </Button>
      </div>
      <p className="text-caption text-muted-foreground" data-knowledge-ask-hint="">
        {agents === undefined
          ? t("knowledge.askHint")
          : names.length === 0
            ? t("knowledge.askHintNoAgents")
            : t("knowledge.askHintAgents", {
                agents: new Intl.ListFormat(locale, { type: "disjunction" }).format(names)
              })}
      </p>
    </div>
  );
}

/**
 * One read-only statement on the published revision, with its rows as the instance answered
 * them. It is the call an agent makes, with the reader's own right to use the Knowledge Base.
 */
export function KnowledgeTestQuery({
  source,
  knowledgeBase,
  firstTable
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  /** The table the first statement reads. */
  firstTable: string | undefined;
}) {
  const { t } = useTranslation();
  const [sql, setSql] = useState(
    firstTable ? `select * from ${firstTable} limit ${FIRST_STATEMENT_ROWS}` : ""
  );
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<KnowledgeQueryAnswer>();
  const [failure, setFailure] = useState<string>();
  const run = async () => {
    setRunning(true);
    const called = await source.query(knowledgeBase, sql);
    setRunning(false);
    if (called.ok) {
      setAnswer(called.data);
      setFailure(undefined);
    } else {
      setAnswer(undefined);
      setFailure(
        called.refused ? t("knowledge.testRefused") : (called.message ?? t("knowledge.testFailed"))
      );
    }
  };
  return (
    <>
      <Field label={t("knowledge.testSql")}>
        <Textarea
          variant="code"
          rows={4}
          value={sql}
          onChange={(event) => setSql(event.target.value)}
        />
      </Field>
      <div>
        <Button
          variant="outline"
          size="sm"
          loading={running}
          disabled={sql.trim() === ""}
          onClick={() => {
            run().catch(() => undefined);
          }}
        >
          <Play aria-hidden="true" />
          {t("knowledge.testRun")}
        </Button>
      </div>
      {failure ? <InlineError data-knowledge-test-failed="">{failure}</InlineError> : null}
      {answer ? <QueryRows answer={answer} /> : null}
    </>
  );
}

function QueryRows({ answer }: { answer: KnowledgeQueryAnswer }) {
  const { locale, t } = useTranslation();
  const count = answer.rows.length;
  if (count === 0) {
    return <EmptyState layout="inline">{t("knowledge.testNoRows")}</EmptyState>;
  }
  return (
    <div className="grid min-w-0 gap-2" data-knowledge-test-rows={count}>
      <p className="text-label text-muted-foreground">
        {t(count === 1 ? "knowledge.testRow" : "knowledge.testRows", {
          count: new Intl.NumberFormat(locale).format(count)
        })}
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            {answer.columns.map((column) => (
              <TableHead key={column.name}>{column.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {answer.rows.map((row, index) => (
            <TableRow key={index}>
              {answer.columns.map((column) => (
                <TableCell key={column.name}>{cellText(row[column.name])}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {answer.truncated ? (
        <p className="text-label text-muted-foreground">{t("knowledge.testTruncated")}</p>
      ) : null}
    </div>
  );
}

/** A value as one cell shows it: text as it is, everything else as JSON. */
function cellText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
