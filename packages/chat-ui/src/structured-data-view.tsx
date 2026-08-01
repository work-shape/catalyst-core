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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
          <span className="flex shrink-0 items-center gap-0.5">
            {field.sources?.map((source) => {
              const sourceLabel = source.page
                ? t("resourcesSourceWithPage", {
                    filename: source.filename,
                    page: source.page
                  })
                : source.filename;
              const key = `${source.attachmentId}:${source.page ?? ""}`;
              if (!onSourceOpen) {
                return (
                  <Tooltip key={key} delayDuration={100}>
                    <TooltipTrigger asChild>
                      <span
                        role="img"
                        tabIndex={0}
                        aria-label={sourceLabel}
                        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/55 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 [&_svg]:size-3.5"
                      >
                        <FileSearch aria-hidden="true" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{sourceLabel}</TooltipContent>
                  </Tooltip>
                );
              }
              return (
                <TooltipIconButton
                  key={key}
                  className="size-6 text-muted-foreground/55 hover:bg-muted/50 hover:text-muted-foreground [&_svg]:size-3.5"
                  tooltip={sourceLabel}
                  onClick={() => onSourceOpen(source)}
                >
                  <FileSearch aria-hidden="true" />
                </TooltipIconButton>
              );
            })}
          </span>
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
