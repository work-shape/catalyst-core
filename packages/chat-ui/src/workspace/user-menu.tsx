import { CircleHelp, Languages, LogOut, Moon, Sun, UserRound } from "lucide-react";
import type { ApiUser } from "@work-shape/catalyst-api-client";
import {
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  useSidebarCollapsed
} from "@work-shape/catalyst-ui";
import type { PlatformIdentity } from "../control-plane/control-plane-model";
import { useTranslation } from "../i18n";
import type { ResolvedThemeMode } from "../theme";

/**
 * The account menu in the rail's footer: who is signed in, the ways to the user's own Settings
 * pages, the theme switch, the way to the documentation and sign out. It opens upward, and to
 * the side of the collapsed rail.
 */
export function UserMenu({
  user,
  signingOut,
  themeMode,
  platform,
  docsUrl,
  onOpenProfile,
  onOpenLanguageAppearance,
  onToggleTheme,
  onSignOut
}: {
  user: ApiUser | undefined;
  signingOut: boolean;
  themeMode: ResolvedThemeMode;
  /** The instance and its release, named at the foot of the menu once the instance answered. */
  platform?: PlatformIdentity;
  /** Where the instance's documentation is read. Without it the menu has no such item. */
  docsUrl?: string;
  onOpenProfile: () => void;
  onOpenLanguageAppearance: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const collapsed = useSidebarCollapsed();
  const label = user?.displayLabel || user?.email || t("userFallback");
  const triggerLabel = t("accountMenuLabel", { label });
  const avatar = <Avatar kind="person" size="sm" name={label} />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {collapsed ? (
          <IconButton label={triggerLabel}>{avatar}</IconButton>
        ) : (
          <Button
            variant="ghost"
            className="min-w-0 flex-1 justify-start rounded-md px-2 text-body font-normal"
            aria-label={triggerLabel}
          >
            {avatar}
            <span className="min-w-0 truncate">{label}</span>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={collapsed ? "right" : "top"}
        align={collapsed ? "end" : "start"}
        className="w-64"
      >
        <DropdownMenuGroup
          label={
            <span className="grid min-w-0">
              <span className="truncate text-label text-foreground">{label}</span>
              {user?.email ? <span className="truncate font-normal">{user.email}</span> : null}
            </span>
          }
        >
          <DropdownMenuItem icon={<UserRound aria-hidden="true" />} onSelect={onOpenProfile}>
            {t("settings.profile")}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={<Languages aria-hidden="true" />}
            onSelect={onOpenLanguageAppearance}
          >
            {t("settings.languageAppearance")}
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={themeMode === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            onSelect={onToggleTheme}
          >
            {t(themeMode === "dark" ? "switchToLightTheme" : "switchToDarkTheme")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {docsUrl ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem
                icon={<CircleHelp aria-hidden="true" />}
                href={docsUrl}
                accessibleName={t("documentationOpensNewTab")}
              >
                {t("documentation")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          icon={<LogOut aria-hidden="true" />}
          disabled={signingOut}
          onSelect={onSignOut}
        >
          {t(signingOut ? "signingOut" : "signOut")}
        </DropdownMenuItem>
        {platform ? (
          <>
            <DropdownMenuSeparator />
            <p
              className="flex min-w-0 items-baseline justify-between gap-3 px-2 py-1 text-caption text-muted-foreground"
              data-platform-identity=""
            >
              <span className="min-w-0 truncate">{platform.instanceName}</span>
              <span className="shrink-0">
                {t("releaseVersion", { version: platform.releaseVersion })}
              </span>
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
