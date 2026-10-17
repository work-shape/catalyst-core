import { Badge, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { formatDataStoreSize } from "../build-area/data-store-model";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import type { StepDataset } from "./step-output";
import type { WorkflowDatasetColumnKind, WorkflowDatasetView } from "./workflow-views";

const COLUMN_KINDS: Readonly<Record<WorkflowDatasetColumnKind, TranslationKey>> = {
  text: "workflows.dataset.kind.text",
  number: "workflows.dataset.kind.number",
  wholeNumber: "workflows.dataset.kind.wholeNumber",
  yesNo: "workflows.dataset.kind.yesNo",
  record: "workflows.dataset.kind.record",
  list: "workflows.dataset.kind.list",
  value: "workflows.dataset.kind.value"
};

/** A dataset that is not complete says so; a complete one says nothing. */
const STATES: Readonly<Partial<Record<WorkflowDatasetView["state"], TranslationKey>>> = {
  writing: "workflows.dataset.writing",
  deleted: "workflows.dataset.deleted"
};

/**
 * The datasets a step's output names: how many rows each holds, how large it is and what its
 * columns are. Its rows stay with the run; the panel shows none of them.
 */
export function StepDatasets({ datasets }: { datasets: readonly StepDataset[] }) {
  const { t } = useTranslation();
  return (
    <section data-step-datasets="" className="grid min-w-0 gap-3">
      <h3 className="text-caption font-medium text-muted-foreground">
        {t("workflows.dataset.heading")}
      </h3>
      {datasets.map((dataset) => (
        <StepDatasetEntry key={dataset.id} dataset={dataset} />
      ))}
    </section>
  );
}

function StepDatasetEntry({ dataset }: { dataset: StepDataset }) {
  const { locale, t } = useTranslation();
  const state = dataset.record === undefined ? undefined : STATES[dataset.record.state];
  const columns = dataset.record?.columns ?? [];
  return (
    <div data-step-dataset={dataset.record?.state ?? ""} className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-body font-medium">
          {dataset.name ?? t("workflows.dataset.unnamed")}
        </span>
        {state === undefined ? null : (
          <Badge tone="neutral" size="sm">
            {t(state)}
          </Badge>
        )}
      </div>
      <p className="text-body text-muted-foreground">
        {t("workflows.dataset.size", {
          rows: dataset.rowCount.toLocaleString(locale),
          size: formatDataStoreSize(dataset.bytes, locale)
        })}
      </p>
      {columns.length === 0 ? null : (
        <KeyValueList aria-label={t("workflows.dataset.columns")}>
          {columns.map((column) => (
            <KeyValue key={column.field} label={column.field}>
              {t(COLUMN_KINDS[column.kind])}
            </KeyValue>
          ))}
        </KeyValueList>
      )}
    </div>
  );
}
