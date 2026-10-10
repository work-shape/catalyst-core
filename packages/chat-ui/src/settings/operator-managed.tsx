import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Banner } from "@vivd-catalyst/ui";

/**
 * Says that the operator sets what a page shows and that nothing on it can be changed. Every
 * page of release config marks it with this one line; its sentence is the page's own.
 */
export function OperatorManaged({ children }: { children: ReactNode }) {
  return (
    <Banner layout="line" icon={<Lock aria-hidden="true" />} data-operator-managed="">
      {children}
    </Banner>
  );
}
