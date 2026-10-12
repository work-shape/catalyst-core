import type { ComponentType, ReactNode } from "react";
import { cn } from "../cn";

/**
 * The file-type icons: a page with a folded corner and a glyph on it. They are the library's own
 * drawings and no mark of a vendor. The four office types carry their familiar colour, the rest
 * are neutral. Each fills a square box like every other icon, so one size class fits them all.
 */
type FileTypeIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

type PageTone = "sheet" | "document" | "slides" | "pdf" | "neutral";

/** The page's fill and the colour of what is drawn on it. */
const pageTones: Record<PageTone, { page: string; glyph: string }> = {
  sheet: { page: "fill-file-sheet", glyph: "text-file-foreground" },
  document: { page: "fill-file-document", glyph: "text-file-foreground" },
  slides: { page: "fill-file-slides", glyph: "text-file-foreground" },
  pdf: { page: "fill-file-pdf", glyph: "text-file-foreground" },
  neutral: { page: "fill-muted-foreground", glyph: "text-background" }
};

function pageIcon(tone: PageTone, type: string, glyph?: ReactNode): FileTypeIcon {
  const { page, glyph: glyphColor } = pageTones[tone];
  return function FileTypeIconDrawing({ className, "aria-hidden": ariaHidden }) {
    return (
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden={ariaHidden}
        data-file-type={type}
        className={cn("shrink-0", className)}
      >
        <g transform="translate(2 0)" className={glyphColor}>
          <path className={page} d="M3 1h9l6 6v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" />
          <path fill="currentColor" opacity="0.35" d="M12 1l6 6h-4a2 2 0 0 1-2-2z" />
          {glyph === undefined ? null : (
            <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
              {glyph}
            </g>
          )}
        </g>
      </svg>
    );
  };
}

/** The file-type icons by their key in the registry. */
export const fileTypeIcons = {
  spreadsheet: pageIcon(
    "sheet",
    "spreadsheet",
    <path strokeWidth="1.2" strokeLinecap="butt" d="M5 11h10M5 15h10M5 19h10M8.5 11v8M12 11v8" />
  ),
  document: pageIcon(
    "document",
    "document",
    <path strokeWidth="1.4" d="M5 11h10M5 14.5h10M5 18h6" />
  ),
  presentation: pageIcon(
    "slides",
    "presentation",
    <>
      <rect x="5" y="11" width="10" height="7" rx="1" strokeWidth="1.3" />
      <path strokeWidth="1.1" d="M7.5 15.5l2-2 1.5 1.5 1.5-1.5" />
    </>
  ),
  // The three letters are drawn, so the icon needs no font and shows no text of its own.
  pdf: pageIcon(
    "pdf",
    "pdf",
    <path
      strokeWidth="1.1"
      d="M4.6 18.8v-5h1.3a1.45 1.45 0 0 1 0 2.9H4.6M9 13.8v5h.7a2.5 2.5 0 0 0 0-5zM13.9 18.8v-5h2.3M13.9 16.3h1.8"
    />
  ),
  image: pageIcon(
    "neutral",
    "image",
    <>
      <circle cx="7" cy="12" r="1.2" strokeWidth="1.2" />
      <path strokeWidth="1.3" d="M4.5 19l3.5-3.5 2.5 2.5 2-2 3 3" />
    </>
  ),
  archive: pageIcon(
    "neutral",
    "archive",
    <>
      <path strokeWidth="1.4" d="M8 9.5h1M8 12.5h1M8 15.5h1" />
      <rect x="6.9" y="17.6" width="3.2" height="2.4" rx="0.6" strokeWidth="1.2" />
    </>
  ),
  text: pageIcon("neutral", "text", <path strokeWidth="1.3" d="M5 11h10M5 14h6M5 17h10M5 20h4" />),
  /** A file of a type the library has no icon for. */
  file: pageIcon("neutral", "file")
};
