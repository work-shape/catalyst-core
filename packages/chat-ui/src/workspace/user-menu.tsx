import { Languages, LogOut, Moon, Sun, UserRound } from "lucide-react";
import type { ApiUser } from "@vivd-catalyst/api-client";
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
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { ResolvedThemeMode } from "../theme";

/**
 * The account menu in the rail's footer: who is signed in, the ways to the user's own Settings
 * pages, the theme switch and sign out. It opens upward, and to the side of the collapsed rail.
 */
export function UserMenu({
  user,
  signingOut,
  themeMode,
  onOpenProfile,
  onOpenLanguageAppearance,
  onToggleTheme,
  onSignOut
}: {
  user: ApiUser | undefined;
  signingOut: boolean;
  themeMode: ResolvedThemeMode;
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
        <DropdownMenuItem
          icon={<LogOut aria-hidden="true" />}
          disabled={signingOut}
          onSelect={onSignOut}
        >
          {t(signingOut ? "signingOut" : "signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
