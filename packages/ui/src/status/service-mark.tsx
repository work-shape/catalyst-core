import { cn } from "../cn";
import { SERVICE_MARK_INK } from "../theme/service-mark";

/** `sm` is 20 px and sits in a line of text, `md` is 28 px, `lg` is 36 px and leads a card. */
export type ServiceMarkSize = "sm" | "md" | "lg";

const tileSizes: Record<ServiceMarkSize, string> = {
  sm: "size-5 rounded-sm text-caption",
  md: "size-7 rounded-md text-body",
  lg: "size-9 rounded-md text-title"
};

/** What a service is shown with: its official logo, or its initial on its colour. */
export type ServiceMarkArt =
  /**
   * The vendor's own logo, drawn unchanged from the address it is supplied at, for a service
   * whose guideline permits showing it. The library holds no logo of any vendor.
   */
  | { logo: string; color?: undefined }
  /** A white initial on the service's colour. Without a colour, the neutral tile. */
  | { logo?: undefined; color?: string };

export type ServiceMarkProps = ServiceMarkArt & {
  /** The service's name, as people read it. Its first letter is the initial. */
  name: string;
  size?: ServiceMarkSize;
  /** The name beside the mark. Off where the name stands elsewhere, such as a card's title. */
  showName?: boolean;
  className?: string;
};

/** The first letter of a name, in capitals, or nothing for a name without a letter. */
export function serviceInitial(name: string): string {
  const letter = [...name.trim()].find((character) => /[\p{L}\p{N}]/u.test(character));
  return letter === undefined ? "" : letter.toLocaleUpperCase();
}

/**
 * The mark of an outside service, such as one of a catalogue entry: its official logo, drawn
 * unchanged, where its owner permits it, and otherwise a tile of the service's colour with the
 * white initial of its name. It is never a drawing that resembles a vendor's logo. The name
 * stands beside it, so the tile is hidden from assistive technology.
 */
export function ServiceMark({
  name,
  logo,
  color,
  size = "md",
  showName = true,
  className
}: ServiceMarkProps) {
  const tile = (
    <span
      aria-hidden="true"
      data-service-mark-tile={
        logo !== undefined ? "logo" : color !== undefined ? "initial" : "neutral"
      }
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden font-semibold leading-none",
        tileSizes[size],
        logo === undefined && color === undefined && "bg-secondary text-muted-foreground"
      )}
      style={
        logo === undefined && color !== undefined
          ? { backgroundColor: color, color: SERVICE_MARK_INK }
          : undefined
      }
    >
      {logo !== undefined ? (
        <img src={logo} alt="" draggable={false} className="size-full object-contain" />
      ) : (
        serviceInitial(name)
      )}
    </span>
  );
  if (!showName) {
    return (
      <span data-service-mark="" className={cn("inline-flex shrink-0", className)}>
        {tile}
      </span>
    );
  }
  return (
    <span
      data-service-mark=""
      className={cn("inline-flex min-w-0 items-center gap-2 text-body font-medium", className)}
    >
      {tile}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
