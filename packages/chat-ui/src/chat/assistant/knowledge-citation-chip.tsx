import {
  KNOWLEDGE_SOURCE_UNREACHABLE,
  knowledgeDocumentFormatOf,
  resolveFilePreviewCapability
} from "@work-shape/catalyst-core";
import { ChevronDown, FileText } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  Chip,
  ChipAction,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner
} from "@work-shape/catalyst-ui";
import { useOptionalWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useTranslation } from "../../shared/i18n";
import { safeOriginLink } from "../../shared/origin-link";
import { apiErrorCode, apiErrorReason, apiErrorStatus } from "../../shared/workspace-utils";
import { saveBlobAsFile } from "../files/conversation-file-content";
import { rasterImageType, viewerObjectUrl, type FileViewer } from "../files/viewer-object-url";

/** How long an opened source's address stays valid, for its tab to load it. */
const OPENED_SOURCE_URL_MS = 60_000;

/** The documents a row of sources shows before "+n more"; one more than this shows them all. */
const SHOWN_DOCUMENTS = 4;

type Translate = ReturnType<typeof useTranslation>["t"];

/** The document and page a passage or a value cites, by the Knowledge Base's name. */
export interface KnowledgeCitation {
  knowledgeBase: string;
  documentId: string;
  fileName: string;
  page?: number;
  /** The name of the sheet a spreadsheet's passage is on. */
  sheet?: string;
  /** The date the document states of its version, such as the "Stand" of a web page (KB-WEB). */
  statedAt?: string;
  /** When the platform fetched the synced document. */
  retrievedAt?: string;
  /** Where the document lives outside the platform, such as its folder in a file store. */
  originLink?: string;
}

/** A place in a cited document: its page, slide or sheet. */
type KnowledgeCitedPlace = Pick<KnowledgeCitation, "page" | "sheet">;

/** One cited document with every place an answer cites in it, in page order. */
interface KnowledgeCitedDocument extends Omit<KnowledgeCitation, "page" | "sheet"> {
  places: KnowledgeCitedPlace[];
}

/**
 * The cited documents of an answer, each once, in the order the answer first cites them; the
 * places of one document are merged and ordered by page.
 */
function groupKnowledgeCitations(
  citations: readonly KnowledgeCitation[]
): KnowledgeCitedDocument[] {
  const documents = new Map<string, KnowledgeCitedDocument>();
  for (const { page, sheet, ...citation } of citations) {
    const key = `${citation.knowledgeBase}/${citation.documentId}`;
    const document = documents.get(key) ?? { ...citation, places: [] };
    documents.set(key, document);
    document.originLink ??= citation.originLink;
    document.statedAt ??= citation.statedAt;
    document.retrievedAt ??= citation.retrievedAt;
    if (!document.places.some((place) => place.page === page && place.sheet === sheet)) {
      document.places.push({
        ...(page === undefined ? {} : { page }),
        ...(sheet === undefined ? {} : { sheet })
      });
    }
  }
  for (const document of documents.values()) {
    document.places.sort(
      (left, right) =>
        (left.page ?? Number.MAX_SAFE_INTEGER) - (right.page ?? Number.MAX_SAFE_INTEGER)
    );
    // A citation of the whole document says nothing beside one of its pages.
    if (document.places.some((place) => place.page !== undefined || place.sheet !== undefined)) {
      document.places = document.places.filter(
        (place) => place.page !== undefined || place.sheet !== undefined
      );
    }
  }
  return [...documents.values()];
}

/**
 * "Stand 01.11.2026" for the date the document states of itself, else "abgerufen 10.11.2026"
 * for when it was fetched, in the reader's language. Any other date of the source is never
 * shown as its "Stand".
 */
function knowledgeCitationDate(
  t: Translate,
  locale: string,
  citation: Pick<KnowledgeCitation, "statedAt" | "retrievedAt">
): string | undefined {
  const day = (value: string | undefined) => {
    const at = value === undefined ? undefined : new Date(value);
    if (at === undefined || Number.isNaN(at.getTime())) return undefined;
    return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC"
    }).format(at);
  };
  const stated = day(citation.statedAt);
  if (stated !== undefined) return t("knowledge.citationAsOf", { date: stated });
  const retrieved = day(citation.retrievedAt);
  return retrieved === undefined
    ? undefined
    : t("knowledge.citationRetrieved", { date: retrieved });
}

/**
 * Where in an office file a passage is, as the file counts it: a spreadsheet's sheet, by its name
 * where the passage knows it, or a slide. Nothing for a file of pages, which the caller says its
 * own way.
 */
export function knowledgeOfficePlace(
  t: Translate,
  citation: Pick<KnowledgeCitation, "fileName" | "page" | "sheet">
): string | undefined {
  const format = knowledgeDocumentFormatOf({ filename: citation.fileName });
  if (format === "xlsx" && citation.sheet) return citation.sheet;
  if ((format !== "xlsx" && format !== "pptx") || citation.page === undefined) return undefined;
  const page = String(citation.page);
  return t(format === "xlsx" ? "knowledge.citationSheet" : "knowledge.citationSlide", { page });
}

/** One place of a document as the reader counts it: "S. 4", "Folie 4", a sheet's name. */
function knowledgePlace(t: Translate, fileName: string, place: KnowledgeCitedPlace) {
  return (
    knowledgeOfficePlace(t, { fileName, ...place }) ??
    (place.page === undefined
      ? undefined
      : t("knowledge.citationPage", { page: String(place.page) }))
  );
}

/**
 * Every place of a document in one: "S. 7, 79", "Folie 3, 4", or a spreadsheet's sheet names.
 */
function knowledgePlaces(
  t: Translate,
  fileName: string,
  places: readonly KnowledgeCitedPlace[]
): string | undefined {
  if (places.some((place) => place.sheet !== undefined)) {
    const names = places.flatMap((place) => knowledgePlace(t, fileName, place) ?? []);
    return names.length === 0 ? undefined : names.join(", ");
  }
  const pages = places.flatMap((place) => (place.page === undefined ? [] : [place.page]));
  if (pages.length === 0) return undefined;
  const format = knowledgeDocumentFormatOf({ filename: fileName });
  return t(
    format === "xlsx"
      ? "knowledge.citationSheet"
      : format === "pptx"
        ? "knowledge.citationSlide"
        : "knowledge.citationPage",
    { page: pages.join(", ") }
  );
}

/**
 * A file's name as the reader knows it: without its extension, its underscores as spaces. A
 * hyphen stays, as in a date it is no gap between words.
 */
function readableFileName(fileName: string): string {
  const name = fileName
    .replace(/\.[a-z0-9]{2,5}$/iu, "")
    .replace(/_+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return name || fileName;
}

/** The start and the end of a long name the chip keeps, in characters. */
const NAME_HEAD = 12;
const NAME_TAIL = 24;
/** How far the start and the end reach on to keep a word whole. */
const NAME_WORD_REACH = 8;

/**
 * A long name shortened in its middle: files of one project often share a long start, and the
 * end tells them apart ("… Geschossplan 1-OG 2025-10-14"). The start and the end keep a word
 * whole where it ends or starts close by. A name that fits stays whole.
 */
function shortFileName(name: string): string {
  const characters = [...name];
  let headEnd = NAME_HEAD;
  let tailStart = characters.length - NAME_TAIL;
  if (tailStart - headEnd <= 3) return name;
  const space = (index: number) => characters[index] === " ";
  // The start runs on to the end of its word, or stops at the space before it.
  const wordEnd = characters.findIndex((_, index) => index >= headEnd && space(index));
  if (wordEnd !== -1 && wordEnd - headEnd <= NAME_WORD_REACH) headEnd = wordEnd;
  else {
    const before = characters.slice(0, headEnd).lastIndexOf(" ");
    if (before > 0) headEnd = before;
  }
  // The end reaches back to the start of its word, or starts at the next word.
  const wordStart = characters.slice(0, tailStart).lastIndexOf(" ") + 1;
  if (wordStart > 0 && tailStart - wordStart <= NAME_WORD_REACH) tailStart = wordStart;
  else if (!space(tailStart - 1)) {
    const next = characters.findIndex((_, index) => index >= tailStart && space(index));
    if (next !== -1 && next < characters.length - 1) tailStart = next + 1;
  }
  if (tailStart - headEnd <= 3) return name;
  const head = characters.slice(0, headEnd).join("").trimEnd();
  const tail = characters.slice(tailStart).join("").trimStart();
  return `${head} … ${tail}`;
}

/** The file stores whose name the reader knows better than their address. */
const KNOWN_FILE_STORES: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)dropbox\.com$/u, "Dropbox"],
  [/(^|\.)sharepoint\.com$/u, "SharePoint"],
  [/(^|\.)(onedrive\.live\.com|1drv\.ms)$/u, "OneDrive"],
  [/^(drive|docs)\.google\.com$/u, "Google Drive"],
  [/(^|\.)box\.com$/u, "Box"]
];

/** "In Dropbox öffnen" for a file store the reader knows by name, else the original's host. */
function originLabel(t: Translate, host: string): string {
  const store = KNOWN_FILE_STORES.find(([pattern]) => pattern.test(host))?.[1];
  return store === undefined
    ? t("knowledge.citationOpenOriginal", { host: host.replace(/^www\./u, "") })
    : t("knowledge.citationOpenIn", { store });
}

type OpenState = "idle" | "opening" | "removed" | "unreachable" | "failed";

/**
 * The chip of a cited Knowledge Base document: its name without the extension, shortened where
 * it is long, and the places the answer cites, "S. 7, 79". A click opens the first of them; its
 * menu names the file whole with its date, opens each place, and opens the original where the
 * document has one. A click reads the file through the API, with the reader's own session or
 * token, and opens it at the page in a new tab; a blocked tab, or a file no viewer of ours
 * shows, saves it instead. A removed source says so and opens nothing. A synced document whose
 * source cannot be reached says so ("Quelle nicht erreichbar") and can be tried again (KB-13).
 * An answer in a conversation names it, as its workspace is where the reader may use the
 * Knowledge Base.
 */
function KnowledgeDocumentChip({
  document,
  conversationId,
  className
}: {
  document: KnowledgeCitedDocument;
  conversationId?: string;
  className?: string;
}) {
  const { locale, t } = useTranslation();
  const api = useOptionalWorkspaceApiClient();
  const [state, setState] = useState<OpenState>("idle");
  const places = knowledgePlaces(t, document.fileName, document.places);
  const asOf = knowledgeCitationDate(t, locale, document);
  const origin = safeOriginLink(document.originLink);
  const readable = readableFileName(document.fileName);
  const name = shortFileName(readable);
  const stateWords =
    state === "removed"
      ? t("knowledge.citationRemoved")
      : state === "unreachable"
        ? t("knowledge.citationUnreachable")
        : state === "failed"
          ? t("knowledge.citationFailed")
          : undefined;
  const detail = [places, stateWords].filter((part) => part !== undefined).join(" · ");
  const canOpen = api !== undefined && state !== "removed";
  const open = async (place: KnowledgeCitedPlace | undefined) => {
    if (!api) return;
    setState("opening");
    try {
      const blob = await api.client.knowledge_bases.open_document({
        params: { knowledgeBase: document.knowledgeBase, documentId: document.documentId },
        ...(conversationId ? { query: { conversationId } } : {})
      });
      const viewer = citationViewer(document.fileName, blob.type);
      if (!viewer) {
        saveBlobAsFile(blob, document.fileName);
        setState("idle");
        return;
      }
      const url = viewerObjectUrl(blob, viewer);
      const tab = window.open(
        place?.page === undefined ? url : `${url}#page=${place.page}`,
        "_blank"
      );
      if (tab) {
        tab.opener = null;
        window.setTimeout(() => URL.revokeObjectURL(url), OPENED_SOURCE_URL_MS);
      } else {
        URL.revokeObjectURL(url);
        saveBlobAsFile(blob, document.fileName);
      }
      setState("idle");
    } catch (error) {
      // The instance answers 404 for a removed or withdrawn document, and names the source of a
      // synced one that it cannot reach.
      setState(
        apiErrorReason(error) === KNOWLEDGE_SOURCE_UNREACHABLE
          ? "unreachable"
          : apiErrorCode(error) === "NOT_FOUND" || apiErrorStatus(error) === 404
            ? "removed"
            : "failed"
      );
    }
  };
  const openPlace = (place: KnowledgeCitedPlace | undefined) => {
    open(place).catch(() => undefined);
  };
  return (
    <span
      className="contents"
      data-knowledge-source={document.documentId}
      data-knowledge-source-state={state}
    >
      <Chip
        className={className}
        leading={state === "opening" ? <Spinner size="sm" /> : <FileText aria-hidden="true" />}
        detail={detail === "" ? undefined : detail}
        {...(canOpen && state !== "opening"
          ? { onClick: () => openPlace(document.places[0]) }
          : {})}
        trailing={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ChipAction
                label={t("knowledge.citationDetails", { name: document.fileName })}
                data-knowledge-source-details=""
              >
                <ChevronDown aria-hidden="true" />
              </ChipAction>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-w-80">
              <DropdownMenuGroup
                label={
                  <>
                    <span className="block break-words text-foreground">{document.fileName}</span>
                    {asOf === undefined ? null : <span className="block font-normal">{asOf}</span>}
                  </>
                }
              >
                {(document.places.length === 0 ? [undefined] : document.places).map((place) => {
                  const where =
                    place === undefined ? undefined : knowledgePlace(t, document.fileName, place);
                  return (
                    <DropdownMenuItem
                      key={`${place?.page ?? ""}/${place?.sheet ?? ""}`}
                      icon={<FileText aria-hidden="true" />}
                      disabled={!canOpen || state === "opening"}
                      onSelect={() => openPlace(place)}
                    >
                      {where === undefined
                        ? t("knowledge.citationOpen")
                        : t("knowledge.citationOpenPlace", { place: where })}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              {origin ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    href={origin.href}
                    accessibleName={t("knowledge.citationOpensNewTab", {
                      label: originLabel(t, origin.host)
                    })}
                  >
                    {originLabel(t, origin.host)}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        {name === readable ? (
          name
        ) : (
          // A screen reader reads the name whole, not its shortened form.
          <>
            <span aria-hidden="true">{name}</span>
            <span className="sr-only">{readable}</span>
          </>
        )}
      </Chip>
    </span>
  );
}

/** The chip of one cited passage or value, as a cited document with that one place. */
export function KnowledgeCitationChip({
  citation,
  conversationId,
  className
}: {
  citation: KnowledgeCitation;
  conversationId?: string;
  className?: string;
}) {
  const [document] = groupKnowledgeCitations([citation]);
  return document ? (
    <KnowledgeDocumentChip
      document={document}
      {...(conversationId ? { conversationId } : {})}
      {...(className ? { className } : {})}
    />
  ) : null;
}

/**
 * The row of sources under an answer: "Quellen", then one chip per cited document side by side.
 * Past a handful of documents it shows the first four and "+n more", which shows the rest.
 */
export function KnowledgeSources({
  citations,
  conversationId,
  className
}: {
  citations: readonly KnowledgeCitation[];
  conversationId?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const documents = groupKnowledgeCitations(citations);
  const folds = documents.length > SHOWN_DOCUMENTS + 1;
  const shown = folds && !expanded ? documents.slice(0, SHOWN_DOCUMENTS) : documents;
  // The first chip "+n more" showed takes the focus the button had.
  const focusRevealed = useRef(false);
  useEffect(() => {
    if (!expanded || !focusRevealed.current) return;
    focusRevealed.current = false;
    const chips = rowRef.current?.querySelectorAll<HTMLElement>("[data-knowledge-source]");
    chips?.[SHOWN_DOCUMENTS]?.querySelector<HTMLElement>("button")?.focus();
  }, [expanded]);
  if (documents.length === 0) return null;
  return (
    <div
      ref={rowRef}
      role="group"
      aria-labelledby={labelId}
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
      data-knowledge-citations=""
    >
      <span id={labelId} className="mr-0.5 text-caption text-muted-foreground">
        {t("knowledge.citationSources")}
      </span>
      {shown.map((document) => (
        <KnowledgeDocumentChip
          key={`${document.knowledgeBase}/${document.documentId}`}
          className="max-w-[min(100%,22rem)]"
          document={document}
          {...(conversationId ? { conversationId } : {})}
        />
      ))}
      {folds && !expanded ? (
        <Chip
          onClick={() => {
            focusRevealed.current = true;
            setExpanded(true);
          }}
        >
          {t("knowledge.citationMoreSources", {
            count: String(documents.length - SHOWN_DOCUMENTS)
          })}
        </Chip>
      ) : null}
    </div>
  );
}

/** The viewer a cited file opens in, by its name and the type it was fetched with; an SVG has none. */
function citationViewer(fileName: string, mimeType: string): FileViewer | undefined {
  const capability = resolveFilePreviewCapability({ filename: fileName, mimeType });
  return capability === "native_pdf"
    ? "pdf"
    : capability === "native_image" && rasterImageType(mimeType)
      ? "image"
      : capability === "markdown" || capability === "text"
        ? "text"
        : undefined;
}
