import qrcode from "qrcode-generator";
import { useMemo, type SVGProps } from "react";
import { cn } from "../cn";

/** The empty border a scanner needs around the code, in modules. */
const QUIET_ZONE = 4;

export interface QrCodeProps extends Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> {
  /** What the code holds, such as an `otpauth://` address. It never leaves the browser. */
  value: string;
  /** What the code is for, read by a screen reader in place of the picture. */
  label: string;
  /** The width and height in pixels. */
  size?: number;
}

/**
 * A QR code drawn in the browser as SVG, never by an outside service, so a value such as an
 * authenticator secret stays on the page. It is black on white in light and dark mode, because
 * many scanners do not read an inverted code. Show the value as text beside it for anyone who
 * cannot scan.
 */
export function QrCode({ value, label, size = 192, className, ...props }: QrCodeProps) {
  const { path, extent } = useMemo(() => modulesOf(value), [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={cn("shrink-0 rounded-md bg-code-paper", className)}
      {...props}
    >
      <path d={path} className="fill-code-ink" />
    </svg>
  );
}

/** One square per dark module, as a single path, inside the quiet zone. */
function modulesOf(value: string): { path: string; extent: number } {
  const code = qrcode(0, "M");
  // The library reads one byte per character: hand it the UTF-8 bytes of the value.
  code.addData(String.fromCharCode(...new TextEncoder().encode(value)), "Byte");
  code.make();
  const count = code.getModuleCount();
  const squares: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (code.isDark(row, column)) {
        squares.push(`M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return { path: squares.join(""), extent: count + QUIET_ZONE * 2 };
}
