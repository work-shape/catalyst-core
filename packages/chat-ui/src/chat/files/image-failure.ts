import { useState } from "react";

/**
 * Whether the image at `src` failed to load, and the `onError` that says so. A file that is no
 * raster image (an SVG, say) is served under a raster type on purpose and never decodes; its
 * place then shows the file instead. The failure belongs to the address it was seen for: a new
 * address is tried afresh, and the fallback renders no image, so it cannot fail again.
 */
export function useImageFailed(src: string | undefined): {
  failed: boolean;
  onError: () => void;
} {
  const [failedSrc, setFailedSrc] = useState<string>();
  return {
    failed: src !== undefined && failedSrc === src,
    onError: () => setFailedSrc(src)
  };
}
