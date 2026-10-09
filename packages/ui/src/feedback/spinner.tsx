import { Loader } from "lucide-react";
import type { SVGAttributes } from "react";
import { cn } from "../cn";

export type SpinnerSize = "xs" | "sm" | "md" | "lg";

const spinnerSizes: Record<SpinnerSize, string> = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5"
};

export interface SpinnerProps extends SVGAttributes<SVGSVGElement> {
  size?: SpinnerSize;
}

export function Spinner({ className, size = "md", ...props }: SpinnerProps) {
  return (
    <Loader
      aria-hidden="true"
      className={cn(
        "shrink-0 animate-spin text-current motion-reduce:animate-none",
        spinnerSizes[size],
        className
      )}
      {...props}
    />
  );
}
