import type { SafeConfig } from "@vivd-catalyst/api-client";
import { cn } from "../ui/cn";

/**
 * The client identity the rail shows: logo when one is configured, otherwise
 * the client name and its initial. Shared so the rail's branding row and the
 * workspace selector popover header cannot drift apart.
 */
export function clientBrandingFrom(config: SafeConfig) {
  const clientLabel = config.ui.clientName ?? config.ui.title;
  return {
    clientLabel,
    clientInitial: clientLabel.trim().charAt(0).toLocaleUpperCase(),
    logoUrl: config.ui.logoUrl,
    logoUrlDark: config.ui.logoUrlDark,
    invertLogoOnDark: Boolean(config.ui.logoInvertOnDark && !config.ui.logoUrlDark)
  };
}

export type ClientBranding = ReturnType<typeof clientBrandingFrom>;

/** Light/dark logo pair. Only rendered once `branding.logoUrl` is configured. */
export function ClientBrandingLogo({
  branding,
  className
}: {
  branding: ClientBranding;
  className?: string;
}) {
  if (!branding.logoUrl) {
    return null;
  }
  return (
    <>
      <img
        className={cn(
          className,
          branding.logoUrlDark && "dark:hidden",
          branding.invertLogoOnDark && "dark:invert"
        )}
        src={branding.logoUrl}
        alt={branding.clientLabel}
      />
      {branding.logoUrlDark ? (
        <img
          className={cn(className, "hidden dark:block")}
          src={branding.logoUrlDark}
          alt={branding.clientLabel}
        />
      ) : null}
    </>
  );
}

/**
 * Compact client identity for the top of the workspace selector popover. With
 * workspace chrome visible the selector takes over the rail's top row, so this
 * is where the branding the rail used to show lives.
 */
export function ClientBrandingHeader({ config }: { config: SafeConfig }) {
  const branding = clientBrandingFrom(config);

  return (
    <div
      data-testid="client-branding-header"
      className="flex min-w-0 items-center border-b px-2 pb-2 pt-1"
    >
      {branding.logoUrl ? (
        <ClientBrandingLogo
          branding={branding}
          className="max-h-6 w-full max-w-[9rem] object-contain object-left"
        />
      ) : (
        <span className="truncate text-xs font-semibold text-muted-foreground">
          {branding.clientLabel}
        </span>
      )}
    </div>
  );
}
