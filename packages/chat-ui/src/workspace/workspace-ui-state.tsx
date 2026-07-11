import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Context,
  type ReactNode
} from "react";
import type { LocaleCode, SafeConfig } from "@vivd-catalyst/api-client";
import { readBrowserLocale } from "../i18n";
import {
  applyDocumentThemeMode,
  createThemeStyle,
  readSystemThemeMode,
  resolveThemeModePreference,
  type ResolvedThemeMode
} from "../theme";
import {
  DEFAULT_LOCALES,
  readStoredLocale,
  readStoredThemeMode,
  writeStoredLocale,
  writeStoredThemeMode
} from "../workspace-utils";
import {
  defaultWorkspaceRoute,
  workspaceRouteView,
  type SuperadminRouteTab,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions,
  type WorkspaceRouteView
} from "../workspace-route";

interface WorkspaceRouteContextValue {
  route: WorkspaceRoute;
  view: WorkspaceRouteView;
  selectedConversationId: string | undefined;
  goToDefaultChat(options?: WorkspaceRouteChangeOptions): void;
  showConversation(conversationId: string, options?: WorkspaceRouteChangeOptions): void;
  showSettings(): void;
  showSuperadmin(tab?: SuperadminRouteTab, options?: WorkspaceRouteChangeOptions): void;
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
  themeOverride: ResolvedThemeMode | undefined;
  systemThemeMode: ResolvedThemeMode;
  selectThemeMode(themeMode: ResolvedThemeMode): void;
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
const WorkspacePreferencesContext = createContext<WorkspacePreferencesContextValue | undefined>(undefined);
const WorkspaceConversationActivityContext =
  createContext<WorkspaceConversationActivityContextValue | undefined>(undefined);

export function WorkspaceUiStateProvider({
  route,
  onRouteChange,
  children
}: {
  route: WorkspaceRoute;
  onRouteChange(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  children: ReactNode;
}) {
  const selectedConversationId = route.kind === "conversation" ? route.conversationId : undefined;
  const selectedConversationIdRef = useRef<string | undefined>(undefined);
  const lastChatRouteRef = useRef<WorkspaceRoute>(defaultWorkspaceRoute());
  const backgroundActiveRunsRef = useRef<Set<string>>(new Set());
  const view = useMemo(() => workspaceRouteView(route), [route]);
  const [locallyUnreadConversationIds, setLocallyUnreadConversationIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const [browserLocale] = useState<LocaleCode | undefined>(() => readBrowserLocale());
  const [localePreference, setLocalePreference] = useState<LocaleCode | undefined>(() => readStoredLocale());
  const [themeOverride, setThemeOverride] = useState<ResolvedThemeMode | undefined>(() =>
    readStoredThemeMode()
  );
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => readSystemThemeMode());

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
    (options?: WorkspaceRouteChangeOptions) => {
      onRouteChange(defaultWorkspaceRoute(), options);
    },
    [onRouteChange]
  );

  const showConversation = useCallback(
    (conversationId: string, options?: WorkspaceRouteChangeOptions) => {
      onRouteChange({ kind: "conversation", conversationId }, options);
    },
    [onRouteChange]
  );

  const showSettings = useCallback(() => {
    onRouteChange({ kind: "settings" });
  }, [onRouteChange]);

  const showSuperadmin = useCallback(
    (tab: SuperadminRouteTab = "users", options?: WorkspaceRouteChangeOptions) => {
      onRouteChange({ kind: "superadmin", tab }, options);
    },
    [onRouteChange]
  );

  const selectWorkspaceView = useCallback(
    (nextView: WorkspaceRouteView) => {
      if (nextView === "settings") {
        showSettings();
        return;
      }
      if (nextView === "superadmin") {
        showSuperadmin("users");
        return;
      }
      onRouteChange(lastChatRouteRef.current);
    },
    [onRouteChange, showSettings, showSuperadmin]
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
        if (!listedConversationIds.has(conversationId) || activeRunConversationIds.has(conversationId)) {
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

  const selectThemeMode = useCallback((themeMode: ResolvedThemeMode) => {
    setThemeOverride(themeMode);
    writeStoredThemeMode(themeMode);
  }, []);

  const routeValue = useMemo<WorkspaceRouteContextValue>(
    () => ({
      route,
      view,
      selectedConversationId,
      goToDefaultChat,
      showConversation,
      showSettings,
      showSuperadmin,
      selectWorkspaceView,
      isConversationVisible,
      resetRouteMemory
    }),
    [
      goToDefaultChat,
      isConversationVisible,
      resetRouteMemory,
      route,
      selectWorkspaceView,
      selectedConversationId,
      showConversation,
      showSettings,
      showSuperadmin,
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
      themeOverride,
      systemThemeMode,
      selectThemeMode
    }),
    [browserLocale, localePreference, selectLocale, selectThemeMode, systemThemeMode, themeOverride]
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
  return useStrictContext(WorkspaceRouteContext, "useWorkspaceRouteState", "WorkspaceUiStateProvider");
}

export function useWorkspaceChromeState(): WorkspaceChromeContextValue {
  return useStrictContext(WorkspaceChromeContext, "useWorkspaceChromeState", "WorkspaceUiStateProvider");
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
  workspaceStyle: CSSProperties;
  toggleTheme(): void;
} {
  const { selectThemeMode, systemThemeMode, themeOverride } = useWorkspacePreferences();
  const resolvedThemeMode =
    themeOverride ?? resolveThemeModePreference(ui?.defaultThemeMode, systemThemeMode);
  const workspaceStyle = useMemo<CSSProperties>(
    () => ({
      ...(createThemeStyle(ui, resolvedThemeMode) ?? {})
    }),
    [resolvedThemeMode, ui]
  );

  useEffect(() => {
    applyDocumentThemeMode(resolvedThemeMode);
  }, [resolvedThemeMode]);

  const toggleTheme = useCallback(() => {
    selectThemeMode(resolvedThemeMode === "dark" ? "light" : "dark");
  }, [resolvedThemeMode, selectThemeMode]);

  return useMemo(
    () => ({
      resolvedThemeMode,
      workspaceStyle,
      toggleTheme
    }),
    [resolvedThemeMode, toggleTheme, workspaceStyle]
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
