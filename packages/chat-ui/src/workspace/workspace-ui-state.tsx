import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactNode
} from "react";
import type { LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { readBrowserLocale } from "../i18n";
import type { ThemeInputs } from "@vivd-catalyst/ui/theme";
import {
  readSystemThemeMode,
  resolveThemeModePreference,
  type ResolvedThemeMode,
  type ThemeModePreference
} from "../theme";
import {
  DEFAULT_LOCALES,
  readStoredLocale,
  readStoredContextIndicatorPreference,
  readStoredResourcesPanelPreference,
  readStoredThemeMode,
  writeStoredContextIndicatorPreference,
  writeStoredLocale,
  writeStoredResourcesPanelPreference,
  writeStoredThemeMode
} from "../workspace-utils";
import type { ResourcesPanelPreference } from "../workspace-utils";
import {
  collaborationWorkspaceHomeRoute,
  defaultWorkspaceRoute,
  routeConversationId,
  workspaceRouteView,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions,
  type WorkspaceRouteView
} from "./workspace-route";

interface WorkspaceRouteContextValue {
  route: WorkspaceRoute;
  view: WorkspaceRouteView;
  selectedConversationId: string | undefined;
  goToDefaultChat(
    collaborationWorkspaceId: string | undefined,
    options?: WorkspaceRouteChangeOptions
  ): void;
  showConversation(
    collaborationWorkspaceId: string,
    conversationId: string,
    options?: WorkspaceRouteChangeOptions
  ): void;
  /** Opens a page of the Settings area; without one, the person's own profile. */
  showSettings(group?: string, page?: string, options?: WorkspaceRouteChangeOptions): void;
  showRoute(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  selectWorkspaceView(view: WorkspaceRouteView): void;
  isConversationVisible(conversationId: string): boolean;
  resetRouteMemory(): void;
}

interface WorkspaceChromeContextValue {
  sidebarOpen: boolean;
  closeSidebar(): void;
  toggleSidebar(): void;
  composerFocusRequestId: number;
  requestComposerFocus(): void;
}

interface WorkspacePreferencesContextValue {
  browserLocale: LocaleCode | undefined;
  localePreference: LocaleCode | undefined;
  supportedFallbackLocales: LocaleCode[];
  selectLocale(locale: LocaleCode): void;
  showContextIndicator: boolean;
  setShowContextIndicator(visible: boolean): void;
  resourcesPanelPreference: ResourcesPanelPreference | undefined;
  setResourcesPanelPreference(preference: ResourcesPanelPreference): void;
  themeOverride: ThemeModePreference | undefined;
  systemThemeMode: ResolvedThemeMode;
  selectThemeMode(themeMode: ThemeModePreference): void;
}

interface ListedConversationActivity {
  id: string;
  activeRun?: unknown;
}

interface WorkspaceConversationActivityContextValue {
  locallyUnreadConversationIds: ReadonlySet<string>;
  syncConversationActivity(conversations: ReadonlyArray<ListedConversationActivity>): string[];
  clearUnreadConversation(conversationId: string): void;
  resetConversationActivity(): void;
}

const WorkspaceRouteContext = createContext<WorkspaceRouteContextValue | undefined>(undefined);
const WorkspaceChromeContext = createContext<WorkspaceChromeContextValue | undefined>(undefined);
const WorkspacePreferencesContext = createContext<WorkspacePreferencesContextValue | undefined>(
  undefined
);
const WorkspaceConversationActivityContext = createContext<
  WorkspaceConversationActivityContextValue | undefined
>(undefined);

export function WorkspaceUiStateProvider({
  route,
  onRouteChange,
  children
}: {
  route: WorkspaceRoute;
  onRouteChange(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  children: ReactNode;
}) {
  const selectedConversationId = routeConversationId(route);
  const selectedConversationIdRef = useRef<string | undefined>(undefined);
  const lastChatRouteRef = useRef<WorkspaceRoute>(defaultWorkspaceRoute());
  const backgroundActiveRunsRef = useRef<Set<string>>(new Set());
  const view = useMemo(() => workspaceRouteView(route), [route]);
  const [locallyUnreadConversationIds, setLocallyUnreadConversationIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const [browserLocale] = useState<LocaleCode | undefined>(() => readBrowserLocale());
  const [localePreference, setLocalePreference] = useState<LocaleCode | undefined>(() =>
    readStoredLocale()
  );
  const [showContextIndicator, setShowContextIndicatorState] = useState(() =>
    readStoredContextIndicatorPreference()
  );
  const [resourcesPanelPreference, setResourcesPanelPreferenceState] = useState<
    ResourcesPanelPreference | undefined
  >(() => readStoredResourcesPanelPreference());
  const [themeOverride, setThemeOverride] = useState<ThemeModePreference | undefined>(() =>
    readStoredThemeMode()
  );
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() =>
    readSystemThemeMode()
  );

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
    if (route.kind === "new-conversation" || route.kind === "conversation") {
      lastChatRouteRef.current = route;
    }
  }, [route, selectedConversationId]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }

    function onChange(event: MediaQueryListEvent) {
      setSystemThemeMode(event.matches ? "dark" : "light");
    }

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

  const goToDefaultChat = useCallback(
    (collaborationWorkspaceId: string | undefined, options?: WorkspaceRouteChangeOptions) => {
      onRouteChange(
        collaborationWorkspaceId
          ? collaborationWorkspaceHomeRoute(collaborationWorkspaceId)
          : defaultWorkspaceRoute(),
        options
      );
    },
    [onRouteChange]
  );

  const showConversation = useCallback(
    (
      collaborationWorkspaceId: string,
      conversationId: string,
      options?: WorkspaceRouteChangeOptions
    ) => {
      onRouteChange({ kind: "conversation", collaborationWorkspaceId, conversationId }, options);
    },
    [onRouteChange]
  );

  const showSettings = useCallback(
    (group = "you", page = "profile", options?: WorkspaceRouteChangeOptions) => {
      onRouteChange({ kind: "settings", group, page }, options);
    },
    [onRouteChange]
  );

  const selectWorkspaceView = useCallback(
    (nextView: WorkspaceRouteView) => {
      // The rail opens Settings on the first administration page the viewer may see.
      if (nextView === "settings") {
        onRouteChange({ kind: "administration" });
        return;
      }
      if (nextView === "build") {
        onRouteChange({ kind: "build" });
        return;
      }
      if (nextView === "approvals") {
        onRouteChange({ kind: "approvals" });
        return;
      }
      onRouteChange(lastChatRouteRef.current);
    },
    [onRouteChange]
  );

  const isConversationVisible = useCallback(
    (conversationId: string) => selectedConversationIdRef.current === conversationId,
    []
  );

  const resetRouteMemory = useCallback(() => {
    selectedConversationIdRef.current = undefined;
    lastChatRouteRef.current = defaultWorkspaceRoute();
  }, []);

  const syncConversationActivity = useCallback(
    (conversations: ReadonlyArray<ListedConversationActivity>) => {
      const activeRunConversationIds = new Set<string>();
      const listedConversationIds = new Set<string>();
      for (const conversation of conversations) {
        listedConversationIds.add(conversation.id);
        if (conversation.activeRun) {
          activeRunConversationIds.add(conversation.id);
        }
      }

      const completedBackgroundConversationIds: string[] = [];
      for (const conversationId of backgroundActiveRunsRef.current) {
        if (
          !listedConversationIds.has(conversationId) ||
          activeRunConversationIds.has(conversationId)
        ) {
          continue;
        }
        if (selectedConversationIdRef.current !== conversationId) {
          completedBackgroundConversationIds.push(conversationId);
        }
      }
      backgroundActiveRunsRef.current = activeRunConversationIds;

      if (completedBackgroundConversationIds.length > 0) {
        setLocallyUnreadConversationIds((currentIds) => {
          const nextIds = new Set(currentIds);
          let changed = false;
          for (const conversationId of completedBackgroundConversationIds) {
            if (!nextIds.has(conversationId)) {
              nextIds.add(conversationId);
              changed = true;
            }
          }
          return changed ? nextIds : currentIds;
        });
      }

      return completedBackgroundConversationIds;
    },
    []
  );

  const clearUnreadConversation = useCallback((conversationId: string) => {
    setLocallyUnreadConversationIds((currentIds) => {
      if (!currentIds.has(conversationId)) {
        return currentIds;
      }
      const nextIds = new Set(currentIds);
      nextIds.delete(conversationId);
      return nextIds;
    });
  }, []);

  const resetConversationActivity = useCallback(() => {
    backgroundActiveRunsRef.current = new Set();
    setLocallyUnreadConversationIds(new Set());
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((currentOpen) => !currentOpen);
  }, []);

  const requestComposerFocus = useCallback(() => {
    setComposerFocusRequestId((currentRequestId) => currentRequestId + 1);
  }, []);

  const selectLocale = useCallback((locale: LocaleCode) => {
    setLocalePreference(locale);
    writeStoredLocale(locale);
  }, []);

  const selectThemeMode = useCallback((themeMode: ThemeModePreference) => {
    setThemeOverride(themeMode);
    writeStoredThemeMode(themeMode);
  }, []);

  const setShowContextIndicator = useCallback((visible: boolean) => {
    setShowContextIndicatorState(visible);
    writeStoredContextIndicatorPreference(visible);
  }, []);

  const setResourcesPanelPreference = useCallback((preference: ResourcesPanelPreference) => {
    setResourcesPanelPreferenceState(preference);
    writeStoredResourcesPanelPreference(preference);
  }, []);

  const routeValue = useMemo<WorkspaceRouteContextValue>(
    () => ({
      route,
      view,
      selectedConversationId,
      goToDefaultChat,
      showConversation,
      showSettings,
      showRoute: onRouteChange,
      selectWorkspaceView,
      isConversationVisible,
      resetRouteMemory
    }),
    [
      goToDefaultChat,
      isConversationVisible,
      onRouteChange,
      resetRouteMemory,
      route,
      selectWorkspaceView,
      selectedConversationId,
      showConversation,
      showSettings,
      view
    ]
  );

  const chromeValue = useMemo<WorkspaceChromeContextValue>(
    () => ({
      sidebarOpen,
      closeSidebar,
      toggleSidebar,
      composerFocusRequestId,
      requestComposerFocus
    }),
    [closeSidebar, composerFocusRequestId, requestComposerFocus, sidebarOpen, toggleSidebar]
  );

  const preferencesValue = useMemo<WorkspacePreferencesContextValue>(
    () => ({
      browserLocale,
      localePreference,
      supportedFallbackLocales: DEFAULT_LOCALES,
      selectLocale,
      resourcesPanelPreference,
      setResourcesPanelPreference,
      showContextIndicator,
      setShowContextIndicator,
      themeOverride,
      systemThemeMode,
      selectThemeMode
    }),
    [
      browserLocale,
      localePreference,
      selectLocale,
      resourcesPanelPreference,
      setResourcesPanelPreference,
      selectThemeMode,
      setShowContextIndicator,
      showContextIndicator,
      systemThemeMode,
      themeOverride
    ]
  );

  const conversationActivityValue = useMemo<WorkspaceConversationActivityContextValue>(
    () => ({
      locallyUnreadConversationIds,
      syncConversationActivity,
      clearUnreadConversation,
      resetConversationActivity
    }),
    [
      clearUnreadConversation,
      locallyUnreadConversationIds,
      resetConversationActivity,
      syncConversationActivity
    ]
  );

  return (
    <WorkspaceRouteContext.Provider value={routeValue}>
      <WorkspaceChromeContext.Provider value={chromeValue}>
        <WorkspacePreferencesContext.Provider value={preferencesValue}>
          <WorkspaceConversationActivityContext.Provider value={conversationActivityValue}>
            {children}
          </WorkspaceConversationActivityContext.Provider>
        </WorkspacePreferencesContext.Provider>
      </WorkspaceChromeContext.Provider>
    </WorkspaceRouteContext.Provider>
  );
}

export function useWorkspaceRouteState(): WorkspaceRouteContextValue {
  return useStrictContext(
    WorkspaceRouteContext,
    "useWorkspaceRouteState",
    "WorkspaceUiStateProvider"
  );
}

export function useWorkspaceChromeState(): WorkspaceChromeContextValue {
  return useStrictContext(
    WorkspaceChromeContext,
    "useWorkspaceChromeState",
    "WorkspaceUiStateProvider"
  );
}

export function useWorkspacePreferences(): WorkspacePreferencesContextValue {
  return useStrictContext(
    WorkspacePreferencesContext,
    "useWorkspacePreferences",
    "WorkspaceUiStateProvider"
  );
}

export function useWorkspaceConversationActivityState(): WorkspaceConversationActivityContextValue {
  return useStrictContext(
    WorkspaceConversationActivityContext,
    "useWorkspaceConversationActivityState",
    "WorkspaceUiStateProvider"
  );
}

export function useWorkspaceLocale(configLocale: LocaleCode | undefined): LocaleCode {
  const { browserLocale, localePreference } = useWorkspacePreferences();
  return configLocale ?? localePreference ?? browserLocale ?? "en";
}

export function useWorkspaceTheme(ui: SafeConfig["ui"] | undefined): {
  resolvedThemeMode: ResolvedThemeMode;
  /** The instance's inputs for the resolved mode; undefined until the config has loaded. */
  theme: ThemeInputs | undefined;
  /** What the person chose, or the instance's default while they chose nothing. */
  themePreference: ThemeModePreference;
  selectThemePreference(preference: ThemeModePreference): void;
  toggleTheme(): void;
} {
  const { selectThemeMode, systemThemeMode, themeOverride } = useWorkspacePreferences();
  const themePreference = themeOverride ?? ui?.defaultThemeMode ?? "system";
  const resolvedThemeMode = resolveThemeModePreference(themePreference, systemThemeMode);
  const theme = resolvedThemeMode === "dark" ? ui?.darkTheme : ui?.theme;

  const toggleTheme = useCallback(() => {
    selectThemeMode(resolvedThemeMode === "dark" ? "light" : "dark");
  }, [resolvedThemeMode, selectThemeMode]);

  return useMemo(
    () => ({
      resolvedThemeMode,
      theme,
      themePreference,
      selectThemePreference: selectThemeMode,
      toggleTheme
    }),
    [resolvedThemeMode, selectThemeMode, theme, themePreference, toggleTheme]
  );
}

function useStrictContext<T>(
  context: Context<T | undefined>,
  hookName: string,
  providerName: string
): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${hookName} must be used within ${providerName}`);
  }
  return value;
}
