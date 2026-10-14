import { useCallback, useState } from "react";

/**
 * What a surface slot reports of itself: what it takes of the main area beside the conversation
 * or page, 0 when it does not, and whether it covers it.
 */
export function useSurfaceReport() {
  const [report, setReport] = useState({ besideWidth: 0, covering: false });
  const reportBesideWidth = useCallback(
    (besideWidth: number) =>
      setReport((current) =>
        current.besideWidth === besideWidth ? current : { ...current, besideWidth }
      ),
    []
  );
  const reportCovering = useCallback(
    (covering: boolean) =>
      setReport((current) => (current.covering === covering ? current : { ...current, covering })),
    []
  );
  return { ...report, reportBesideWidth, reportCovering };
}
