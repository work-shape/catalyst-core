import { Search } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FoldedText,
  InlineError,
  Input
} from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type {
  KnowledgeBaseSource,
  KnowledgeSearchAnswer,
  KnowledgeSearchPassage
} from "./knowledge-base-source";

/** How a ranked list a search fused is named in the line over the passages. */
const SIGNAL_NAMES: Record<KnowledgeSearchAnswer["signals"][number], TranslationKey> = {
  semantic: "knowledge.signalSemantic",
  keyword: "knowledge.signalKeyword",
  title: "knowledge.signalTitle"
};

/**
 * One search of the published revision of a Knowledge Base that keeps documents, with the
 * passages as the instance answered them, best first. It is the call an agent makes, with the
 * reader's own right to use the Knowledge Base, and it is recorded as one.
 */
export function KnowledgeTestSearch({
  source,
  knowledgeBase
}: {
  source: KnowledgeBaseSource;
  knowledgeBase: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [answer, setAnswer] = useState<KnowledgeSearchAnswer>();
  const [failure, setFailure] = useState<string>();
  const run = async () => {
    setRunning(true);
    const called = await source.search(knowledgeBase, query.trim());
    setRunning(false);
    if (called.ok) {
      setAnswer(called.data);
      setFailure(undefined);
    } else {
      setAnswer(undefined);
      setFailure(
        called.refused
          ? t("knowledge.searchRefused")
          : (called.message ?? t("knowledge.searchFailed"))
      );
    }
  };
  const search = () => {
    if (query.trim() !== "" && !running) run().catch(() => undefined);
  };
  // The page is one form, which saves the Knowledge Base: Enter here searches and saves nothing.
  const searchOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    search();
  };
  return (
    <div className="grid min-w-0 gap-3" data-knowledge-test-search="">
      <Field label={t("knowledge.searchQuery")}>
        <Input
          type="search"
          value={query}
          placeholder={t("knowledge.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={searchOnEnter}
        />
      </Field>
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={running}
          disabled={query.trim() === ""}
          onClick={search}
        >
          <Search aria-hidden="true" />
          {t("knowledge.searchRun")}
        </Button>
      </div>
      {failure ? <InlineError data-knowledge-search-failed="">{failure}</InlineError> : null}
      {answer ? <SearchPassages answer={answer} /> : null}
    </div>
  );
}

function SearchPassages({ answer }: { answer: KnowledgeSearchAnswer }) {
  const { locale, t } = useTranslation();
  const count = answer.passages.length;
  if (count === 0) {
    return <EmptyState layout="inline">{t("knowledge.searchNone")}</EmptyState>;
  }
  const signals = new Intl.ListFormat(locale, { type: "conjunction" }).format(
    answer.signals.map((signal) => t(SIGNAL_NAMES[signal]))
  );
  return (
    <div className="grid min-w-0 gap-3" data-knowledge-search-passages={count}>
      <p className="text-label text-muted-foreground">
        {t(count === 1 ? "knowledge.searchPassage" : "knowledge.searchPassages", {
          count: new Intl.NumberFormat(locale).format(count)
        })}{" "}
        {t("knowledge.searchSignals", { signals })}
      </p>
      <ol className="grid min-w-0 gap-4" aria-label={t("knowledge.searchTitle")}>
        {answer.passages.map((passage) => (
          <SearchPassage key={passage.ref} passage={passage} />
        ))}
      </ol>
    </div>
  );
}

/** One passage: its ref, the document and where in it, and its text. */
function SearchPassage({ passage }: { passage: KnowledgeSearchPassage }) {
  const { t } = useTranslation();
  const where = [
    passage.fileName,
    passage.page === undefined ? undefined : t("knowledge.searchPage", { page: passage.page }),
    passage.heading
  ].filter((part) => part !== undefined && part !== "");
  return (
    <li className="grid min-w-0 gap-1" data-knowledge-passage={passage.ref}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone="neutral">{passage.ref}</Badge>
        <span className="min-w-0 font-medium break-words">{passage.title}</span>
      </div>
      <p className="text-label text-muted-foreground break-words">{where.join(" · ")}</p>
      <FoldedText>{passage.text}</FoldedText>
    </li>
  );
}
