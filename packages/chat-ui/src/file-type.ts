import type { GenericIconKey } from "@work-shape/catalyst-ui";
import type { TranslationKey } from "./i18n";

/** The key of a file-type icon in the icon registry of the UI library. */
type FileTypeIconKey = Extract<
  GenericIconKey,
  "spreadsheet" | "document" | "presentation" | "pdf" | "image" | "archive" | "text" | "file"
>;

/** What a file is, as far as the interface tells files apart. */
export interface FileType {
  id:
    | "pdf"
    | "presentation"
    | "document"
    | "csv"
    | "spreadsheet"
    | "image"
    | "archive"
    | "markdown"
    | "text"
    | "file";
  /** The icon that stands for the type. Several types share one. */
  icon: FileTypeIconKey;
  /** The type in words. */
  labelKey: TranslationKey;
  /** The English word that names a file which has no name of its own. */
  label: string;
  /** The extension a download gets when the file has no name of its own. */
  extension: string;
}

interface FileTypeRule extends FileType {
  /** The file name extensions of the type, in lower case. */
  extensions: readonly string[];
  /** Whether a media type, or another word that describes the file, says it is of the type. */
  describes(value: string): boolean;
}

const includesAny =
  (...words: string[]) =>
  (value: string) =>
    words.some((word) => value.includes(word));

const UNKNOWN_FILE_TYPE: FileType = {
  id: "file",
  icon: "file",
  labelKey: "fileTypeFile",
  label: "File",
  extension: "bin"
};

/**
 * The one mapping from a file's name and media type to its type and icon. The order decides
 * where a description fits two rules: a PDF is no document, a CSV is no plain text.
 */
const FILE_TYPE_RULES: readonly FileTypeRule[] = [
  {
    id: "pdf",
    icon: "pdf",
    labelKey: "fileTypePdf",
    label: "PDF",
    extension: "pdf",
    extensions: ["pdf"],
    describes: includesAny("pdf")
  },
  {
    id: "presentation",
    icon: "presentation",
    labelKey: "fileTypePresentation",
    label: "Presentation",
    extension: "pptx",
    extensions: ["pptx", "ppt", "odp"],
    describes: includesAny("presentation", "powerpoint")
  },
  {
    id: "document",
    icon: "document",
    labelKey: "fileTypeDocument",
    label: "Word document",
    extension: "docx",
    extensions: ["docx", "doc", "odt"],
    describes: includesAny("wordprocessingml", "msword", "word", "opendocument.text")
  },
  {
    id: "csv",
    icon: "spreadsheet",
    labelKey: "fileTypeCsv",
    label: "CSV",
    extension: "csv",
    extensions: ["csv"],
    describes: includesAny("csv")
  },
  {
    id: "spreadsheet",
    icon: "spreadsheet",
    labelKey: "fileTypeSpreadsheet",
    label: "Spreadsheet",
    extension: "xlsx",
    extensions: ["xlsx", "xls", "ods"],
    describes: includesAny("spreadsheet", "excel")
  },
  {
    id: "image",
    icon: "image",
    labelKey: "fileTypeImage",
    label: "Image",
    extension: "png",
    extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"],
    describes: includesAny("image")
  },
  {
    id: "archive",
    icon: "archive",
    labelKey: "fileTypeArchive",
    label: "Archive",
    extension: "zip",
    extensions: ["zip", "tar", "gz", "tgz", "rar", "7z"],
    describes: includesAny("zip", "compressed", "archive", "x-tar")
  },
  {
    id: "markdown",
    icon: "text",
    labelKey: "fileTypeMarkdown",
    label: "Markdown",
    extension: "md",
    extensions: ["md", "mdx"],
    describes: includesAny("markdown")
  },
  {
    id: "text",
    icon: "text",
    labelKey: "fileTypeText",
    label: "Document",
    extension: "txt",
    extensions: ["txt", "rtf", "html", "json"],
    describes: includesAny("text/", "json")
  }
];

/**
 * The type of a file. The name's extension decides first, because the icon repeats what the
 * name says. A file without a telling name is read from its media type, then from `kind`, the
 * word a tool gave what it made. Every other file is the unknown type with the generic icon.
 */
export function resolveFileType(file: {
  filename?: string;
  mimeType?: string;
  kind?: string;
}): FileType {
  const mimeType = file.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const kind = file.kind?.trim().toLowerCase();
  return (
    byExtension(file.filename) ??
    (mimeType ? FILE_TYPE_RULES.find((rule) => rule.describes(mimeType)) : undefined) ??
    byExtension(kind) ??
    (kind ? FILE_TYPE_RULES.find((rule) => rule.describes(kind)) : undefined) ??
    UNKNOWN_FILE_TYPE
  );
}

function byExtension(name: string | undefined): FileType | undefined {
  const match = /\.([a-z0-9]+)$/iu.exec(name?.trim() ?? "");
  const extension = match?.[1]?.toLowerCase();
  return extension === undefined
    ? undefined
    : FILE_TYPE_RULES.find((rule) => rule.extensions.includes(extension));
}
