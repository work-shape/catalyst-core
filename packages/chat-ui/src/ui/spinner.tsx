import { Loader, type LucideProps } from "lucide-react";
import { cn } from "./cn";

const spinnerSizes = {
  xs: "size-3",
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5"
} as const;

export function Spinner({
  className,
  size = "md",
  ...props
}: Omit<LucideProps, "size"> & {
  size?: keyof typeof spinnerSizes;
}) {
  return (
    <Loader
      aria-hidden="true"
      className={cn("shrink-0 animate-spin text-current motion-reduce:animate-none", spinnerSizes[size], className)}
      {...props}
    />
  );
}
