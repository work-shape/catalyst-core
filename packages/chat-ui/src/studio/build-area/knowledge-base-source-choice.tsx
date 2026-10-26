import { Table2, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, RadioGroup, ServiceMark } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { offerText } from "./connection-typed-model";
import type { KnowledgeBaseForm } from "./knowledge-base-model";
import type { KnowledgeBaseSource } from "./knowledge-base-source";
import { NewSourceConnection } from "./knowledge-base-sources";
import { newKnowledgeSource } from "./knowledge-sources-model";

// Where a new Knowledge Base's knowledge comes from, as its first question (KB-FOLDERS-1): files
// added by hand, a Connection that syncs folders, or the tables of a Data Store. Choosing a
// Connection makes it the Knowledge Base's synced source, whose folders are chosen next. A
// Connector type the instance can sync from but has no Connection of yet is named under the
// choice, with New connection for who may make one.

const UPLOAD = "upload";
const TABLES = "tables";
const CONNECTION = "connection:";

export function KnowledgeSourceChoice({
  source,
  owner,
  form,
  canWrite,
  uploadDescription,
  update
}: {
  source: KnowledgeBaseSource;
  /** The workspace that will own the Knowledge Base, absent for one of the instance. */
  owner: string | undefined;
  form: KnowledgeBaseForm;
  canWrite: boolean;
  /** What files can be added, as the instance reads them. */
  uploadDescription: string;
  update(patch: Partial<KnowledgeBaseForm>): void;
}) {
  const { locale, t } = useTranslation();
  const read = source.useSourceConnections?.("", owner);
  const types = source.useSourceTypes?.();
  const connections = read?.status === "ready" ? read.data.items : [];
  const typeTitle = (type: string | undefined) => {
    const offer = types?.find((candidate) => candidate.type === type);
    return offer === undefined ? undefined : offerText(offer.title, locale);
  };
  const unconnected = (types ?? []).filter(
    (type) => !connections.some((connection) => connection.connectorType === type.type)
  );
  const first = form.sources[0];
  const value =
    form.holds === "tables" ? TABLES : first ? `${CONNECTION}${first.connection}` : UPLOAD;

  const choose = (next: string) => {
    if (next === TABLES) return update({ holds: "tables", sources: [] });
    if (next === UPLOAD) return update({ holds: "documents", sources: [] });
    const connection = next.slice(CONNECTION.length);
    const kept = form.sources.find((entry) => entry.connection === connection);
    update({ holds: "documents", sources: [kept ?? newKnowledgeSource(connection, [])] });
  };

  return (
    <div className="grid min-w-0 gap-2" data-knowledge-source-choice="">
      <RadioGroup
        label={t("knowledge.fromLabel")}
        value={value}
        disabled={!canWrite}
        onValueChange={choose}
        options={[
          {
            value: UPLOAD,
            label: (
              <OptionLabel mark={<Upload aria-hidden="true" />}>
                {t("knowledge.fromUpload")}
              </OptionLabel>
            ),
            description: uploadDescription
          },
          ...connections.map((connection) => {
            const title = connection.title || connection.name;
            const type = typeTitle(connection.connectorType) ?? title;
            return {
              value: `${CONNECTION}${connection.name}`,
              label: (
                <OptionLabel mark={<ServiceMark name={type} size="sm" showName={false} />}>
                  {title}
                  <Badge tone="success" size="sm" dot>
                    {t("knowledge.fromConnected")}
                  </Badge>
                </OptionLabel>
              ),
              description: t("knowledge.fromConnectionDescription", { type })
            };
          }),
          {
            value: TABLES,
            label: (
              <OptionLabel mark={<Table2 aria-hidden="true" />}>
                {t("knowledge.holdsTables")}
              </OptionLabel>
            ),
            description: t("knowledge.holdsTablesDescription")
          }
        ]}
      />
      {canWrite && unconnected.length > 0 ? (
        <div
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3"
          data-knowledge-source-unconnected=""
        >
          <p className="min-w-0 text-caption text-muted-foreground">
            {t("knowledge.fromNotConnected", {
              types: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                unconnected.map((type) => offerText(type.title, locale))
              )
            })}
          </p>
          <NewSourceConnection />
        </div>
      ) : null}
    </div>
  );
}

/** An option's name with the mark that leads it. */
function OptionLabel({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2 [&>svg]:size-4 [&>svg]:shrink-0">
      {mark}
      {children}
    </span>
  );
}
