import { Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormNotice,
  InlineError,
  KeyValue,
  KeyValueList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea
} from "@work-shape/catalyst-ui";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { ReadState } from "./data-store-read-state";
import { KNOWLEDGE_STATUS_VIEWS } from "./knowledge-base-model";
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
  canCheck
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
  publishedRevision: number;
  canCheck: boolean;
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
      {state.problem ? <InlineError>{state.problem}</InlineError> : null}
      <KeyValueList>
        {state.checkedAt ? (
          <KeyValue label={t("knowledge.checkedAt")}>
            {formatDateTime(state.checkedAt, locale)}
          </KeyValue>
        ) : null}
        {state.tables.map((table) => (
          <KeyValue
            key={table.name}
            label={<code className="font-mono text-code">{table.name}</code>}
          >
            <Badge tone={table.readable ? "success" : "warning"}>
              {t(table.readable ? "knowledge.tableReadable" : "knowledge.tableUnreadable")}
            </Badge>
          </KeyValue>
        ))}
      </KeyValueList>
    </>
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
