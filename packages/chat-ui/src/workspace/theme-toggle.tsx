import { Moon, Sun } from "lucide-react";
import { Button } from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import type { ResolvedThemeMode } from "../theme";

export function ThemeToggle({ mode, onToggle }: { mode: ResolvedThemeMode; onToggle: () => void }) {
  const { t } = useTranslation();
  const nextMode = mode === "dark" ? "light" : "dark";
  const label = nextMode === "dark" ? t("switchToDarkTheme") : t("switchToLightTheme");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-10 text-muted-foreground"
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {mode === "dark" ? (
        <Sun size={16} aria-hidden="true" />
      ) : (
        <Moon size={16} aria-hidden="true" />
      )}
    </Button>
  );
}
