import { SUPPORTED_IMAGE_MIME_TYPES } from "@work-shape/catalyst-core";

/** The viewers a fetched file is framed or opened in on the interface origin. */
export type FileViewer = "pdf" | "image" | "text";

/**
 * A `blob:` address for a fetched file in one of our viewers. A `blob:` address runs on the
 * interface origin, so the blob is rebuilt with the type the viewer expects and never keeps an
 * active type it was fetched with: an HTML file named *.pdf is framed as a PDF, not run as a page.
 * An image keeps its type when that is a raster type and is a PNG otherwise; a browser decodes
 * any raster format under a raster type and never an SVG or a page.
 */
export function viewerObjectUrl(blob: Blob, viewer: FileViewer): string {
  const type =
    viewer === "pdf"
      ? "application/pdf"
      : viewer === "text"
        ? "text/plain;charset=utf-8"
        : (rasterImageType(blob.type) ?? "image/png");
  return URL.createObjectURL(new Blob([blob], { type }));
}

/** The raster image type a content type names, or undefined (SVG, a list, any other type). */
export function rasterImageType(
  type: string | undefined
): (typeof SUPPORTED_IMAGE_MIME_TYPES)[number] | undefined {
  const essence = /^\s*([^\s;,]+)\s*(?:;[^,]*)?$/u.exec(type ?? "")?.[1]?.toLowerCase();
  return SUPPORTED_IMAGE_MIME_TYPES.find((imageType) => imageType === essence);
}
