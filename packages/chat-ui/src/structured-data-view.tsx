import { Check, ClipboardCopy, FileSearch } from "lucide-react";
import { useState } from "react";
import type { StructuredDataResourceResponse } from "@vivd-catalyst/api-client";
import { useTranslation } from "./i18n";
import {
  formatStructuredDataValue,
  structuredDataToTsv
} from "./resources-panel-model";
import { Button } from "./ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableRow
} from "./ui/table";
import { TooltipIconButton } from "./tooltip-icon-button";

type StructuredDataSource =
  StructuredDataResourceResponse["sections"][number]["fields"][number]["sources"] extends
    | Array<infer Source>
    | undefined
    ? Source
    : never;

export function StructuredDataView({
  resource,
  onSourceOpen
}: {
  resource: StructuredDataResourceResponse;
  onSourceOpen?: (source: StructuredDataSource) => void;
}) {
  const { locale } = useTranslation();

  return (
    <div className="grid gap-6">
      {resource.sections.map((section) => (
        <section key={section.key} className="overflow-hidden rounded-md border bg-card">
          <h3 className="border-b bg-muted/30 px-4 py-2.5 text-sm font-semibold">
            {section.label}
          </h3>
          <Table>
            <TableBody>
              {section.fields.map((field) => (
                <StructuredDataFieldRow
                  key={field.key}
                  field={field}
                  locale={locale}
                  onSourceOpen={onSourceOpen}
                />
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
    </div>
  );
}

export function StructuredDataCopyAllButton({
  resource
}: {
  resource: StructuredDataResourceResponse;
}) {
  const { locale, t } = useTranslation();
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-xs"
      onClick={() => {
        void navigator.clipboard
          .writeText(structuredDataToTsv(resource, locale))
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          });
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
      <span>{copied ? t("copied") : t("resourcesCopyAll")}</span>
    </Button>
  );
}

function StructuredDataFieldRow({
  field,
  locale,
  onSourceOpen
}: {
  field: StructuredDataResourceResponse["sections"][number]["fields"][number];
  locale: "en" | "de";
  onSourceOpen?: (source: StructuredDataSource) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const value = formatStructuredDataValue(field.value, locale);

  return (
    <TableRow className="group">
      <TableCell className="w-[38%] align-top text-sm font-medium text-muted-foreground">
        {field.label}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{value}</span>
          {field.sources?.map((source) => {
            const sourceLabel = source.page
              ? t("resourcesSourceWithPage", {
                  filename: source.filename,
                  page: source.page
                })
              : source.filename;
            if (!onSourceOpen) {
              return (
                <span
                  key={`${source.attachmentId}:${source.page ?? ""}`}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  title={sourceLabel}
                >
                  <FileSearch size={14} aria-hidden="true" />
                </span>
              );
            }
            return (
              <button
                key={`${source.attachmentId}:${source.page ?? ""}`}
                type="button"
                className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
                title={sourceLabel}
                aria-label={sourceLabel}
                onClick={() => onSourceOpen(source)}
              >
                <FileSearch size={14} aria-hidden="true" />
              </button>
            );
          })}
          <TooltipIconButton
            className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
            tooltip={copied ? t("copied") : t("resourcesCopyValue")}
            onClick={() => {
              const rawValue = field.value === null ? "" : String(field.value);
              void navigator.clipboard.writeText(rawValue).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <ClipboardCopy size={13} aria-hidden="true" />}
          </TooltipIconButton>
        </div>
      </TableCell>
    </TableRow>
  );
}
