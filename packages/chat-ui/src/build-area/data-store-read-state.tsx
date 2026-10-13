import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Button, EmptyState, InlineError, SkeletonList } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { DataStoreRead } from "./data-store-source";

/** One read of the page before and after its answer: the rows of a skeleton, the error, the content. */
export function ReadState<Answer>({
  read,
  failedText,
  refusedText,
  failedAction,
  rows,
  children
}: {
  read: DataStoreRead<Answer>;
  /** What the page says of a read that failed without a sentence of the instance. */
  failedText: string;
  /** What the page says where the reader may not read this. The store's own sentence without it. */
  refusedText?: string;
  /** One more way out of a failed read, beside reading again. */
  failedAction?: ReactNode;
  rows: number;
  /** `renewing`: the answer is the one before, shown while the one asked for is read. */
  children(answer: Answer, renewing: boolean): ReactNode;
}) {
  const { t } = useTranslation();
  if (read.status === "loading") {
    return <SkeletonList rows={rows} />;
  }
  if (read.status === "refused") {
    return (
      <EmptyState layout="inline" icon={<Lock aria-hidden="true" />} data-data-store-refused="">
        {refusedText ?? t("dataStores.refused")}
      </EmptyState>
    );
  }
  if (read.status === "failed") {
    return (
      <InlineError className="flex flex-wrap items-center justify-between gap-2">
        <span>{read.message ?? failedText}</span>
        <span className="flex items-center gap-2">
          {failedAction}
          <Button variant="outline" size="sm" onClick={read.retry}>
            {t("tryAgain")}
          </Button>
        </span>
      </InlineError>
    );
  }
  return children(read.data, read.renewing ?? false);
}
