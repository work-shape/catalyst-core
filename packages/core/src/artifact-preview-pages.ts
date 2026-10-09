import type { ManagedArtifactId } from "./ids";

export type ArtifactPreviewPageImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** One page, slide, sheet or range of a preview: the image a person is shown. */
export interface ArtifactPreviewImagePageRef {
  artifactId: ManagedArtifactId;
  mimeType: ArtifactPreviewPageImageMimeType;
  filename?: string;
  pageNumber?: number;
  slideNumber?: number;
  sheet?: string;
  range?: string;
  width?: number;
  height?: number;
  modelImage?: ArtifactPreviewModelImageRef;
}

/**
 * The same page encoded for a model to read: smaller than the image a person is shown. A page
 * rendered before this rendition existed has none, and the model is given the person's image.
 */
export interface ArtifactPreviewModelImageRef {
  artifactId: ManagedArtifactId;
  mimeType: ArtifactPreviewPageImageMimeType;
  width?: number;
  height?: number;
}

/** A rendered model image on its way into storage, kept as an artifact beside its page image. */
export interface ArtifactPreviewModelImageInput {
  objectKey: string;
  filename?: string;
  mimeType: ArtifactPreviewPageImageMimeType;
  byteSize: number;
  checksum: string;
  width?: number;
  height?: number;
}
