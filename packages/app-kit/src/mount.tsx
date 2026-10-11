import { RouterProvider, type AnyRoute } from "@tanstack/react-router";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@vivd-catalyst/ui";
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { getContext, navigate, onThemeChange } from "./client";
import type { AppContext, AppThemeChange } from "./protocol";
import { createAppRouter } from "./router";

/**
 * The root of a Page: the theme of the interface, its mode and the library's own texts in the
 * interface language. It follows the interface when the theme or the mode changes.
 */
function AppRoot({ context, children }: { context: AppContext; children: ReactNode }) {
  const [look, setLook] = useState<AppThemeChange>({ theme: context.theme, mode: context.mode });
  useEffect(() => onThemeChange(setLook), []);

  return (
    <UiRoot
      theme={look.theme}
      mode={look.mode}
      labels={context.locale.startsWith("de") ? uiLabelsDe : uiLabelsEn}
      className="min-h-dvh bg-background font-sans text-body text-foreground antialiased"
    >
      {children}
    </UiRoot>
  );
}

/**
 * Starts a React Page: asks the interface for the context, creates the router on the Page's
 * route tree and renders it under the theme. The build writes the call of this function; a
 * Page's own code holds routes and components only.
 */
export async function mountApp(input: { routeTree: AnyRoute; element?: Element }): Promise<void> {
  const element = input.element ?? document.getElementById("root");
  if (!element) {
    throw new Error("The Page has no element to render into.");
  }
  let context: AppContext;
  try {
    context = await getContext();
  } catch (error) {
    element.textContent = error instanceof Error ? error.message : "The Page could not start.";
    return;
  }
  const router = createAppRouter({
    routeTree: input.routeTree,
    initialRoute: context.initialRoute,
    onNavigate: navigate
  });
  createRoot(element).render(
    <AppRoot context={context}>
      <RouterProvider router={router} />
    </AppRoot>
  );
}
