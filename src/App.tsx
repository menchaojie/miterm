import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppTabBar } from "./components/AppTabBar";
import { ConcurrentWorkspace } from "./components/ConcurrentWorkspace";
import type { ConcurrentSyncControl } from "./components/ConcurrentWorkspace";
import { HostEditor, type HostEditorMode } from "./components/HostEditor";
import { HostListPage } from "./components/HostListPage";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import {
  SHORTCUT_ACTIONS,
  clampTerminalFontSize,
  isLocalShellKind,
  loadSettings,
  localShellLabel,
  matchShortcut,
  saveSettings,
  tabIndexForAction,
  type AppSettings,
} from "./settings";
import type {
  Category,
  CategoryFilter,
  ConcurrentGroup,
  HostDraft,
  HostFolder,
  SavedHost,
  SessionTab,
  SplitDirection,
  SshCloseReason,
  SshClosedEvent,
} from "./types";
import {
  HOSTS_TAB_ID,
  isLocalHost,
  newFolderId,
  newGroupId,
  newSessionId,
  newSubTabId,
  concurrentGridDims,
  type FolderSubTab,
} from "./types";
import {
  collectLayoutSessionIds,
  collectSubTabsSessionIds,
  ensureFolderLayout,
  findNeighborInGrid,
  findNeighborSessionId,
  layoutContainsSession,
  leafLayout,
  mapSubTabLayout,
  removeSessionFromLayout,
  setSplitRatio,
  splitLeaf,
  quadSplitLeaf,
  type PaneNavDirection,
} from "./splitLayout";
import { isRestorableCwd, shellSingleQuote, guessUnixHome } from "./cwd";
import {
  hydrateLayout,
  resolveHostsForPayload,
  saveWorkspaceRow,
  serializeFolderWorkspace,
  serializeGroupWorkspace,
  type SavedWorkspaceRow,
  type WorkspacePayload,
} from "./workspace";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import "./App.css";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function syncMaximizedClass(maximized: boolean) {
  document.documentElement.classList.toggle("window-maximized", maximized);
}

/** 兼容热更新前无 subTabs 的主机夹内存态 */
function normalizeHostFolder(f: HostFolder): HostFolder {
  if (f.subTabs && f.subTabs.length > 0) {
    const sessionIds = collectSubTabsSessionIds(f.subTabs);
    const activeSub =
      f.subTabs.find((t) => t.id === f.activeSubTabId) ?? f.subTabs[0];
    const layoutIds = collectLayoutSessionIds(activeSub.layout);
    const activeSessionId = layoutIds.includes(f.activeSessionId)
      ? f.activeSessionId
      : (layoutIds[0] ?? f.activeSessionId);
    return {
      ...f,
      sessionIds,
      activeSubTabId: activeSub.id,
      activeSessionId,
    };
  }
  const layout = ensureFolderLayout(f.layout, f.activeSessionId);
  const inLayout = new Set(collectLayoutSessionIds(layout));
  const subTabs: FolderSubTab[] = [{ id: newSubTabId(), layout }];
  for (const sid of f.sessionIds ?? []) {
    if (!inLayout.has(sid)) {
      subTabs.push({ id: newSubTabId(), layout: leafLayout(sid) });
    }
  }
  const activeSub = subTabs[0];
  const layoutIds = collectLayoutSessionIds(activeSub.layout);
  return {
    ...f,
    subTabs,
    activeSubTabId: activeSub.id,
    activeSessionId: layoutIds.includes(f.activeSessionId)
      ? f.activeSessionId
      : (layoutIds[0] ?? f.activeSessionId),
    sessionIds: collectSubTabsSessionIds(subTabs),
  };
}

function getActiveSubTab(folder: HostFolder): FolderSubTab {
  const f = normalizeHostFolder(folder);
  return f.subTabs.find((t) => t.id === f.activeSubTabId) ?? f.subTabs[0];
}

function hostBaseTitle(item: SavedHost): string {
  return (
    item.name?.trim() ||
    (isLocalHost(item)
      ? localShellLabel(item.shell)
      : item.username
        ? `${item.username}@${item.host}`
        : `${item.host}:${item.port}`)
  );
}

function buildSessionTab(
  item: SavedHost,
  sessionId: string,
  opts?: { groupId?: string; folderId?: string },
): SessionTab {
  const local = isLocalHost(item);
  return {
    id: sessionId,
    title: hostBaseTitle(item),
    host: item.host,
    port: item.port,
    username: item.username,
    status: "connecting",
    errorMessage: "",
    kind: local ? "local" : "ssh",
    groupId: opts?.groupId ?? null,
    folderId: opts?.folderId ?? null,
    savedHostId: item.id,
    // SSH：用家目录作相对 cd 基路径，便于重连恢复
    cwd: local ? null : guessUnixHome(item.username),
  };
}

async function invokeConnect(item: SavedHost, sessionId: string) {
  if (isLocalHost(item)) {
    const shell = isLocalShellKind(item.shell) ? item.shell : "powershell";
    await invoke<string>("local_connect", {
      params: {
        sessionId,
        shell,
        customPath: item.shellPath?.trim() || null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      },
    });
  } else {
    await invoke<string>("ssh_connect", {
      params: {
        sessionId,
        host: item.host,
        port: item.port,
        username: item.username,
        password: item.password,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      },
    });
  }
}

function App() {
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>([]);
  const [groups, setGroups] = useState<ConcurrentGroup[]>([]);
  const [folders, setFolders] = useState<HostFolder[]>([]);
  const [syncControl, setSyncControl] = useState<ConcurrentSyncControl | null>(
    null,
  );
  const [activeTabId, setActiveTabId] = useState<string>(HOSTS_TAB_ID);
  const [listError, setListError] = useState("");
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 各工作区（主机夹 / 并发组 / 主机列表）侧栏是否打开 */
  const [remoteFilesOpenMap, setRemoteFilesOpenMap] = useState<
    Record<string, boolean>
  >({});
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);

  const [savedHosts, setSavedHosts] = useState<SavedHost[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<CategoryFilter>("all");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<HostEditorMode>("add");
  const [editingHost, setEditingHost] = useState<SavedHost | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState("");

  const noticeSeqRef = useRef(0);
  const cancelReconnectRef = useRef(new Set<string>());
  const autoReconnectBusyRef = useRef(new Set<string>());
  const settingsRef = useRef(settings);
  const savedHostsRef = useRef(savedHosts);
  const sessionTabsRef = useRef(sessionTabs);
  const syncControlRef = useRef(syncControl);
  settingsRef.current = settings;
  savedHostsRef.current = savedHosts;
  sessionTabsRef.current = sessionTabs;
  syncControlRef.current = syncControl;

  const onHostsTab = activeTabId === HOSTS_TAB_ID;
  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeTabId) ?? null,
    [groups, activeTabId],
  );
  const activeFolder = useMemo(
    () => folders.find((f) => f.id === activeTabId) ?? null,
    [folders, activeTabId],
  );

  /** 快捷键轮换：并发组 + 主机夹（不含主机列表） */
  const cycleTabIds = useMemo(
    () => [...groups.map((g) => g.id), ...folders.map((f) => f.id)],
    [groups, folders],
  );

  const orderedTabIds = useMemo(
    () => [HOSTS_TAB_ID, ...cycleTabIds],
    [cycleTabIds],
  );

  const groupErrorMessage = useMemo(() => {
    if (!activeGroup) return "";
    const err = sessionTabs.find(
      (t) =>
        t.groupId === activeGroup.id &&
        t.status === "error" &&
        t.errorMessage,
    );
    return err?.errorMessage ?? "";
  }, [activeGroup, sessionTabs]);

  const folderErrorMessage = useMemo(() => {
    if (!activeFolder) return "";
    const active = sessionTabs.find((t) => t.id === activeFolder.activeSessionId);
    if (active?.status === "error" && active.errorMessage) {
      return active.errorMessage;
    }
    const err = sessionTabs.find(
      (t) =>
        t.folderId === activeFolder.id &&
        t.status === "error" &&
        t.errorMessage,
    );
    return err?.errorMessage ?? "";
  }, [activeFolder, sessionTabs]);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const refreshData = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([
        invoke<SavedHost[]>("list_saved_hosts"),
        invoke<Category[]>("list_categories"),
      ]);
      setSavedHosts(
        list.map((h) => ({
          ...h,
          connType: h.connType === "local" ? "local" : "ssh",
          shell: h.shell ?? "",
          shellPath: h.shellPath ?? "",
        })),
      );
      setCategories(cats);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    const sync = async () => {
      try {
        syncMaximizedClass(await win.isMaximized());
      } catch (e) {
        console.error(e);
      }
    };

    void (async () => {
      try {
        await win.setShadow(false);
      } catch {
        /* optional on some platforms */
      }
      await sync();
      unlisten = await win.onResized(() => {
        void sync();
      });
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  const defaultCategoryIdForAdd =
    typeof selectedFilter === "number" ? selectedFilter : null;

  const updateTab = useCallback(
    (id: string, patch: Partial<SessionTab>) => {
      setSessionTabs((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    },
    [],
  );

  const pushNotice = useCallback((sessionId: string, text: string) => {
    noticeSeqRef.current += 1;
    const seq = noticeSeqRef.current;
    setSessionTabs((prev) =>
      prev.map((t) =>
        t.id === sessionId ? { ...t, systemNotice: { seq, text } } : t,
      ),
    );
  }, []);

  const resolveHostForSession = useCallback(
    (tab: SessionTab): SavedHost | null => {
      if (tab.savedHostId == null) return null;
      return (
        savedHostsRef.current.find((h) => h.id === tab.savedHostId) ?? null
      );
    },
    [],
  );

  const restoreCwdAfterReconnect = useCallback(
    async (sessionId: string, cwd: string | null | undefined) => {
      if (!isRestorableCwd(cwd)) return;
      if (cancelReconnectRef.current.has(sessionId)) return;
      // 等 MOTD / hook 静默安装 / 首个提示符稍稳后再 cd
      await new Promise((r) => setTimeout(r, 450));
      if (cancelReconnectRef.current.has(sessionId)) return;
      const tab = sessionTabsRef.current.find((t) => t.id === sessionId);
      if (!tab || tab.status !== "connected") return;

      const data = Array.from(
        new TextEncoder().encode(`cd ${shellSingleQuote(cwd)}\n`),
      );
      try {
        await invoke("ssh_write", { sessionId, data });
        updateTab(sessionId, { cwd });
        pushNotice(sessionId, `已恢复工作目录：${cwd}`);
      } catch (e) {
        pushNotice(sessionId, `恢复工作目录失败：${String(e)}`);
        updateTab(sessionId, { cwd: null });
      }
    },
    [pushNotice, updateTab],
  );

  const reconnectSession = useCallback(
    async (sessionId: string, mode: "manual" | "auto" = "manual") => {
      const tab = sessionTabsRef.current.find((t) => t.id === sessionId);
      if (!tab) return;
      if (tab.status === "disconnecting") return;

      cancelReconnectRef.current.delete(sessionId);
      const cwdToRestore = tab.cwd;
      const host = resolveHostForSession(tab);
      if (!host) {
        pushNotice(
          sessionId,
          "无法重连：主机已从列表删除，请重新从主机列表打开。",
        );
        updateTab(sessionId, {
          status: "exited",
          errorMessage: "主机条目不存在",
        });
        return;
      }

      if (mode === "auto") {
        if (autoReconnectBusyRef.current.has(sessionId)) return;
        autoReconnectBusyRef.current.add(sessionId);
        const max = settingsRef.current.autoReconnectMaxAttempts;
        pushNotice(sessionId, "连接已断开。");
        try {
          for (let attempt = 1; attempt <= max; attempt++) {
            if (cancelReconnectRef.current.has(sessionId)) return;
            if (!sessionTabsRef.current.some((t) => t.id === sessionId)) return;

            pushNotice(sessionId, `正在重连… (${attempt}/${max})`);
            updateTab(sessionId, {
              status: "reconnecting",
              errorMessage: "",
            });
            try {
              await invokeConnect(host, sessionId);
              if (cancelReconnectRef.current.has(sessionId)) {
                try {
                  await invoke("ssh_disconnect", { sessionId });
                } catch {
                  /* ignore */
                }
                return;
              }
              updateTab(sessionId, {
                status: "connected",
                errorMessage: "",
              });
              try {
                await invoke("touch_saved_host", { id: host.id });
              } catch (e) {
                console.error(e);
              }
              await restoreCwdAfterReconnect(sessionId, cwdToRestore);
              return;
            } catch (e) {
              pushNotice(sessionId, `重连失败：${String(e)}`);
              if (attempt < max) {
                await new Promise((r) => setTimeout(r, 800 * attempt));
              }
            }
          }
          if (cancelReconnectRef.current.has(sessionId)) return;
          pushNotice(
            sessionId,
            `已达最大重试次数（${max}），可点击「重新连接」。`,
          );
          updateTab(sessionId, {
            status: "exited",
            errorMessage: "重连失败",
          });
        } finally {
          autoReconnectBusyRef.current.delete(sessionId);
        }
        return;
      }

      // manual
      pushNotice(sessionId, "正在重连…");
      updateTab(sessionId, { status: "reconnecting", errorMessage: "" });
      try {
        await invokeConnect(host, sessionId);
        if (cancelReconnectRef.current.has(sessionId)) {
          try {
            await invoke("ssh_disconnect", { sessionId });
          } catch {
            /* ignore */
          }
          return;
        }
        updateTab(sessionId, { status: "connected", errorMessage: "" });
        try {
          await invoke("touch_saved_host", { id: host.id });
        } catch (e) {
          console.error(e);
        }
        await restoreCwdAfterReconnect(sessionId, cwdToRestore);
      } catch (e) {
        pushNotice(sessionId, `重连失败：${String(e)}`);
        updateTab(sessionId, {
          status: "exited",
          errorMessage: String(e),
        });
      }
    },
    [pushNotice, resolveHostForSession, restoreCwdAfterReconnect, updateTab],
  );

  const handleCwdChange = useCallback(
    (sessionId: string, cwd: string | null) => {
      // null 表示「未知」而非家目录；保留原 cwd，避免远程文件面板回落 ~/
      if (cwd == null) return;
      updateTab(sessionId, { cwd });
    },
    [updateTab],
  );

  const onSessionClosed = useCallback(
    (sessionId: string, reason: SshCloseReason) => {
      if (reason === "user") return;

      const tab = sessionTabsRef.current.find((t) => t.id === sessionId);
      if (!tab) return;
      if (
        tab.status === "disconnecting" ||
        tab.status === "reconnecting" ||
        tab.status === "connecting"
      ) {
        return;
      }

      if (reason === "remote") {
        pushNotice(
          sessionId,
          "连接已断开（会话已退出）。\n可点击「重新连接」再次登录。",
        );
        updateTab(sessionId, { status: "exited", errorMessage: "" });
        return;
      }

      // abnormal
      if (!settingsRef.current.autoReconnect) {
        pushNotice(
          sessionId,
          "连接已断开。\n自动重连已关闭，可点击「重新连接」。",
        );
        updateTab(sessionId, { status: "exited", errorMessage: "" });
        return;
      }

      void reconnectSession(sessionId, "auto");
    },
    [pushNotice, reconnectSession, updateTab],
  );

  const detachSessionFromGroups = useCallback((sessionId: string) => {
    setGroups((prev) => {
      const next: ConcurrentGroup[] = [];
      for (const g of prev) {
        if (!g.sessionIds.includes(sessionId)) {
          next.push(g);
          continue;
        }
        const sessionIds = g.sessionIds.filter((id) => id !== sessionId);
        if (sessionIds.length === 0) continue;
        next.push({
          ...g,
          sessionIds,
          title: `并发 · ${sessionIds.length} 台`,
          focusedSessionId:
            g.focusedSessionId === sessionId
              ? sessionIds[0]
              : g.focusedSessionId,
        });
      }
      return next;
    });
  }, []);

  const detachSessionFromFolders = useCallback((sessionId: string) => {
    setFolders((prev) => {
      const next: HostFolder[] = [];
      for (const raw of prev) {
        const f = normalizeHostFolder(raw);
        if (!f.sessionIds.includes(sessionId)) {
          next.push(f);
          continue;
        }
        const subTabs: FolderSubTab[] = [];
        for (const st of f.subTabs) {
          const layout = removeSessionFromLayout(st.layout, sessionId);
          if (layout) subTabs.push({ ...st, layout });
        }
        if (subTabs.length === 0) continue;
        const activeSub =
          subTabs.find((t) => t.id === f.activeSubTabId) ?? subTabs[0];
        const layoutIds = collectLayoutSessionIds(activeSub.layout);
        const activeSessionId = layoutIds.includes(f.activeSessionId)
          ? f.activeSessionId
          : layoutIds[0];
        next.push({
          ...f,
          subTabs,
          activeSubTabId: activeSub.id,
          activeSessionId,
          sessionIds: collectSubTabsSessionIds(subTabs),
        });
      }
      return next;
    });
  }, []);

  const removeSessionLocally = useCallback(
    (sessionId: string) => {
      detachSessionFromGroups(sessionId);
      detachSessionFromFolders(sessionId);
      setSessionTabs((prev) => prev.filter((t) => t.id !== sessionId));
    },
    [detachSessionFromFolders, detachSessionFromGroups],
  );

  // 一级 Tab 被清空后，跳到仍存在的夹/组或主机列表
  useEffect(() => {
    if (activeTabId === HOSTS_TAB_ID) return;
    if (folders.some((f) => f.id === activeTabId)) return;
    if (groups.some((g) => g.id === activeTabId)) return;
    if (folders.length > 0) {
      setActiveTabId(folders[folders.length - 1].id);
      return;
    }
    if (groups.length > 0) {
      setActiveTabId(groups[groups.length - 1].id);
      return;
    }
    setActiveTabId(HOSTS_TAB_ID);
  }, [activeTabId, folders, groups]);

  const handleLogin = useCallback(
    async (item: SavedHost) => {
      const existing = folders.find((f) => f.savedHostId === item.id);
      if (existing) {
        setActiveTabId(existing.id);
        setListError("");
        try {
          await invoke("touch_saved_host", { id: item.id });
          await refreshData();
        } catch (e) {
          console.error(e);
        }
        return;
      }

      const folderId = newFolderId();
      const sessionId = newSessionId();
      const baseTitle = hostBaseTitle(item);
      const tab = buildSessionTab(item, sessionId, { folderId });

      const subTabId = newSubTabId();
      setFolders((prev) => [
        ...prev,
        {
          id: folderId,
          savedHostId: item.id,
          baseTitle,
          subTabs: [{ id: subTabId, layout: leafLayout(sessionId) }],
          activeSubTabId: subTabId,
          sessionIds: [sessionId],
          activeSessionId: sessionId,
        },
      ]);
      setSessionTabs((prev) => [...prev, tab]);
      setActiveTabId(folderId);
      setListError("");

      try {
        await invokeConnect(item, sessionId);
        updateTab(sessionId, { status: "connected", errorMessage: "" });
        try {
          await invoke("touch_saved_host", { id: item.id });
          await refreshData();
        } catch (e) {
          console.error(e);
        }
      } catch (e) {
        updateTab(sessionId, {
          status: "error",
          errorMessage: String(e),
        });
      }
    },
    [folders, refreshData, updateTab],
  );

  /** 「+」：新建二级 Tab（单窗格），不拆当前分屏 */
  const addSessionToFolder = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      const item = savedHosts.find((h) => h.id === folder.savedHostId);
      if (!item) {
        setListError("该主机已从列表删除，无法再开连接");
        return;
      }

      const sessionId = newSessionId();
      const subTabId = newSubTabId();
      const tab = buildSessionTab(item, sessionId, { folderId });

      setSessionTabs((prev) => [...prev, tab]);
      setFolders((prev) =>
        prev.map((raw) => {
          if (raw.id !== folderId) return raw;
          const f = normalizeHostFolder(raw);
          const subTabs = [
            ...f.subTabs,
            { id: subTabId, layout: leafLayout(sessionId) },
          ];
          return {
            ...f,
            subTabs,
            activeSubTabId: subTabId,
            activeSessionId: sessionId,
            sessionIds: collectSubTabsSessionIds(subTabs),
          };
        }),
      );
      setActiveTabId(folderId);
      setListError("");

      try {
        await invokeConnect(item, sessionId);
        updateTab(sessionId, { status: "connected", errorMessage: "" });
        try {
          await invoke("touch_saved_host", { id: item.id });
          await refreshData();
        } catch (e) {
          console.error(e);
        }
      } catch (e) {
        updateTab(sessionId, {
          status: "error",
          errorMessage: String(e),
        });
      }
    },
    [folders, refreshData, savedHosts, updateTab],
  );

  /** 右键分屏：同机新建连接并拆开窗格（不新增二级 Tab） */
  const splitSessionInFolder = useCallback(
    async (folderId: string, sessionId: string, direction: SplitDirection) => {
      const folderRaw = folders.find((f) => f.id === folderId);
      if (!folderRaw) return;
      const folder = normalizeHostFolder(folderRaw);
      if (!folder.sessionIds.includes(sessionId)) return;
      const item = savedHosts.find((h) => h.id === folder.savedHostId);
      if (!item) {
        setListError("该主机已从列表删除，无法再开连接");
        return;
      }

      const activeSub = getActiveSubTab(folder);
      if (!layoutContainsSession(activeSub.layout, sessionId)) return;

      const newId = newSessionId();
      const tab = buildSessionTab(item, newId, { folderId });

      setSessionTabs((prev) => [...prev, tab]);
      setFolders((prev) =>
        prev.map((raw) => {
          if (raw.id !== folderId) return raw;
          const f = normalizeHostFolder(raw);
          const subTabs = mapSubTabLayout(f.subTabs, f.activeSubTabId, (lay) =>
            splitLeaf(lay, sessionId, newId, direction),
          );
          return {
            ...f,
            subTabs,
            activeSessionId: newId,
            sessionIds: collectSubTabsSessionIds(subTabs),
          };
        }),
      );
      setActiveTabId(folderId);
      setListError("");

      try {
        await invokeConnect(item, newId);
        updateTab(newId, { status: "connected", errorMessage: "" });
        try {
          await invoke("touch_saved_host", { id: item.id });
          await refreshData();
        } catch (e) {
          console.error(e);
        }
      } catch (e) {
        updateTab(newId, {
          status: "error",
          errorMessage: String(e),
        });
      }
    },
    [folders, refreshData, savedHosts, updateTab],
  );

  /** 右键田字分屏：同机再开 3 条连接，当前叶变为四格 */
  const quadSplitSessionInFolder = useCallback(
    async (folderId: string, sessionId: string) => {
      const folderRaw = folders.find((f) => f.id === folderId);
      if (!folderRaw) return;
      const folder = normalizeHostFolder(folderRaw);
      if (!folder.sessionIds.includes(sessionId)) return;
      const item = savedHosts.find((h) => h.id === folder.savedHostId);
      if (!item) {
        setListError("该主机已从列表删除，无法再开连接");
        return;
      }

      const activeSub = getActiveSubTab(folder);
      if (!layoutContainsSession(activeSub.layout, sessionId)) return;

      const newIds: [string, string, string] = [
        newSessionId(),
        newSessionId(),
        newSessionId(),
      ];
      const tabs = newIds.map((id) =>
        buildSessionTab(item, id, { folderId }),
      );

      setSessionTabs((prev) => [...prev, ...tabs]);
      setFolders((prev) =>
        prev.map((raw) => {
          if (raw.id !== folderId) return raw;
          const f = normalizeHostFolder(raw);
          const subTabs = mapSubTabLayout(f.subTabs, f.activeSubTabId, (lay) =>
            quadSplitLeaf(lay, sessionId, newIds),
          );
          return {
            ...f,
            subTabs,
            activeSessionId: newIds[0],
            sessionIds: collectSubTabsSessionIds(subTabs),
          };
        }),
      );
      setActiveTabId(folderId);
      setListError("");

      await Promise.all(
        newIds.map(async (id) => {
          try {
            await invokeConnect(item, id);
            updateTab(id, { status: "connected", errorMessage: "" });
          } catch (e) {
            updateTab(id, {
              status: "error",
              errorMessage: String(e),
            });
          }
        }),
      );
      try {
        await invoke("touch_saved_host", { id: item.id });
        await refreshData();
      } catch (e) {
        console.error(e);
      }
    },
    [folders, refreshData, savedHosts, updateTab],
  );

  const handleConcurrentConnect = useCallback(
    async (hosts: SavedHost[]) => {
      if (hosts.length < 2) {
        setListError("请至少勾选 2 台主机后再开并发会话");
        return;
      }

      const groupId = newGroupId();
      const prepared = hosts.map((item) => {
        const sessionId = newSessionId();
        return {
          item,
          sessionId,
          tab: buildSessionTab(item, sessionId, { groupId }),
        };
      });
      const sessionIds = prepared.map((p) => p.sessionId);
      const group: ConcurrentGroup = {
        id: groupId,
        title: `并发 · ${hosts.length} 台`,
        sessionIds,
        focusedSessionId: sessionIds[0] ?? null,
      };

      setSessionTabs((prev) => [...prev, ...prepared.map((p) => p.tab)]);
      setGroups((prev) => [...prev, group]);
      setActiveTabId(groupId);
      setListError("");

      await Promise.all(
        prepared.map(async ({ item, sessionId }) => {
          try {
            await invokeConnect(item, sessionId);
            updateTab(sessionId, { status: "connected", errorMessage: "" });
            try {
              await invoke("touch_saved_host", { id: item.id });
            } catch (e) {
              console.error(e);
            }
          } catch (e) {
            updateTab(sessionId, {
              status: "error",
              errorMessage: String(e),
            });
          }
        }),
      );
      try {
        await refreshData();
      } catch (e) {
        console.error(e);
      }
    },
    [refreshData, updateTab],
  );

  const closeSession = useCallback(
    (sessionId: string) => {
      cancelReconnectRef.current.add(sessionId);
      autoReconnectBusyRef.current.delete(sessionId);
      // 先更新 UI，断开放后台，关 Tab 立即生效
      removeSessionLocally(sessionId);
      void invoke("ssh_disconnect", { sessionId }).catch((e) => {
        console.error(e);
      });
    },
    [removeSessionLocally],
  );

  const closeGroup = useCallback(
    (groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      const ids = [...group.sessionIds];
      for (const sessionId of ids) {
        cancelReconnectRef.current.add(sessionId);
        autoReconnectBusyRef.current.delete(sessionId);
      }
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
      setSessionTabs((prev) => prev.filter((t) => t.groupId !== groupId));
      for (const sessionId of ids) {
        void invoke("ssh_disconnect", { sessionId }).catch((e) => {
          console.error(e);
        });
      }
    },
    [groups],
  );

  const closeFolder = useCallback(
    (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      const ids = [...folder.sessionIds];
      for (const sessionId of ids) {
        cancelReconnectRef.current.add(sessionId);
        autoReconnectBusyRef.current.delete(sessionId);
      }
      setFolders((prev) => prev.filter((f) => f.id !== folderId));
      setSessionTabs((prev) => prev.filter((t) => t.folderId !== folderId));
      for (const sessionId of ids) {
        void invoke("ssh_disconnect", { sessionId }).catch((e) => {
          console.error(e);
        });
      }
    },
    [folders],
  );

  const closeTab = useCallback(
    (id: string) => {
      if (groups.some((g) => g.id === id)) {
        closeGroup(id);
        return;
      }
      if (folders.some((f) => f.id === id)) {
        closeFolder(id);
        return;
      }
      closeSession(id);
    },
    [closeFolder, closeGroup, closeSession, folders, groups],
  );

  const focusSessionInFolder = useCallback(
    (folderId: string, sessionId: string) => {
      setFolders((prev) =>
        prev.map((raw) => {
          if (raw.id !== folderId) return raw;
          const f = normalizeHostFolder(raw);
          const owner = f.subTabs.find((t) =>
            layoutContainsSession(t.layout, sessionId),
          );
          if (!owner) return f;
          return {
            ...f,
            activeSubTabId: owner.id,
            activeSessionId: sessionId,
          };
        }),
      );
    },
    [],
  );

  const focusSubTabInFolder = useCallback(
    (folderId: string, subTabId: string) => {
      setFolders((prev) =>
        prev.map((raw) => {
          if (raw.id !== folderId) return raw;
          const f = normalizeHostFolder(raw);
          const sub = f.subTabs.find((t) => t.id === subTabId);
          if (!sub) return f;
          const ids = collectLayoutSessionIds(sub.layout);
          return {
            ...f,
            activeSubTabId: subTabId,
            activeSessionId: ids.includes(f.activeSessionId)
              ? f.activeSessionId
              : (ids[0] ?? f.activeSessionId),
          };
        }),
      );
    },
    [],
  );

  /** 关闭整个二级 Tab（断开其布局内全部窗格） */
  const closeSubTabInFolder = useCallback(
    (folderId: string, subTabId: string) => {
      const folderRaw = folders.find((f) => f.id === folderId);
      if (!folderRaw) return;
      const folder = normalizeHostFolder(folderRaw);
      const sub = folder.subTabs.find((t) => t.id === subTabId);
      if (!sub) return;
      const ids = collectLayoutSessionIds(sub.layout);
      for (const id of ids) {
        closeSession(id);
      }
    },
    [closeSession, folders],
  );

  const changeFolderSplitRatio = useCallback(
    (folderId: string, splitId: string, ratio: number) => {
      setFolders((prev) =>
        prev.map((raw) => {
          if (raw.id !== folderId) return raw;
          const f = normalizeHostFolder(raw);
          return {
            ...f,
            subTabs: mapSubTabLayout(f.subTabs, f.activeSubTabId, (lay) =>
              setSplitRatio(lay, splitId, ratio),
            ),
          };
        }),
      );
    },
    [],
  );

  const focusSessionInGroup = useCallback(
    (groupId: string, sessionId: string) => {
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, focusedSessionId: sessionId } : g,
        ),
      );
    },
    [],
  );

  const openAdd = useCallback(() => {
    setEditorMode("add");
    setEditingHost(null);
    setEditorError("");
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((item: SavedHost) => {
    setEditorMode("edit");
    setEditingHost(item);
    setEditorError("");
    setEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => {
    if (editorBusy) return;
    setEditorOpen(false);
    setEditorError("");
  }, [editorBusy]);

  const handleEditorSave = useCallback(
    async (draft: HostDraft) => {
      if (draft.connType === "local") {
        if (draft.shell === "custom" && !draft.shellPath.trim()) {
          setEditorError("自定义 Shell 请填写可执行文件路径");
          return;
        }
      } else if (!draft.host.trim()) {
        setEditorError("请填写 Host");
        return;
      }

      const port =
        draft.connType === "local" ? 0 : parseInt(draft.port, 10) || 22;
      const params = {
        name: draft.name,
        host: draft.connType === "local" ? "local" : draft.host,
        port,
        username: draft.connType === "local" ? draft.shell : draft.username,
        password: draft.connType === "local" ? "" : draft.password,
        categoryId: draft.categoryId,
        connType: draft.connType,
        shell: draft.connType === "local" ? draft.shell : "",
        shellPath: draft.connType === "local" ? draft.shellPath.trim() : "",
      };

      setEditorBusy(true);
      setEditorError("");
      try {
        if (editorMode === "edit" && editingHost) {
          await invoke("update_saved_host", {
            params: { id: editingHost.id, ...params },
          });
        } else {
          await invoke("save_host", { params });
        }
        await refreshData();
        setEditorOpen(false);
      } catch (e) {
        setEditorError(String(e));
      } finally {
        setEditorBusy(false);
      }
    },
    [editorMode, editingHost, refreshData],
  );

  const handleDelete = useCallback(
    async (item: SavedHost) => {
      const label =
        item.name?.trim() ||
        (isLocalHost(item)
          ? localShellLabel(item.shell)
          : `${item.username}@${item.host}:${item.port}`);
      if (!window.confirm(`确定删除「${label}」？`)) return;
      try {
        await invoke("delete_saved_host", { id: item.id });
        await refreshData();
      } catch (e) {
        console.error(e);
        setListError(String(e));
      }
    },
    [refreshData],
  );

  const handleAddCategory = useCallback(async () => {
    const name = window.prompt("新分类名称");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setListError("分类名称不能为空");
      return;
    }
    try {
      const cat = await invoke<Category>("create_category", {
        params: { name: trimmed },
      });
      await refreshData();
      setSelectedFilter(cat.id);
    } catch (e) {
      setListError(String(e));
    }
  }, [refreshData]);

  const handleRenameCategory = useCallback(
    async (category: Category) => {
      const name = window.prompt("重命名分类", category.name);
      if (name == null) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setListError("分类名称不能为空");
        return;
      }
      try {
        await invoke("update_category", {
          params: { id: category.id, name: trimmed },
        });
        await refreshData();
      } catch (e) {
        setListError(String(e));
      }
    },
    [refreshData],
  );

  const handleDeleteCategory = useCallback(
    async (category: Category) => {
      if (
        !window.confirm(
          `确定删除分类「${category.name}」？其中的主机会变为未分类。`,
        )
      ) {
        return;
      }
      try {
        await invoke("delete_category", { id: category.id });
        if (selectedFilter === category.id) {
          setSelectedFilter("all");
        }
        await refreshData();
      } catch (e) {
        setListError(String(e));
      }
    },
    [refreshData, selectedFilter],
  );

  const handleSaveSettings = useCallback((next: AppSettings) => {
    saveSettings(next);
    setSettings(next);
    setSettingsOpen(false);
  }, []);

  const handleSaveCurrentWorkspace = useCallback(async () => {
    const name = window.prompt("工作区名称");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setListError("工作区名称不能为空");
      return;
    }

    try {
      if (activeFolder) {
        const folder = normalizeHostFolder(activeFolder);
        const folderSessions = sessionTabs.filter(
          (t) => t.folderId === folder.id,
        );
        const payload = serializeFolderWorkspace(folder, folderSessions);
        await saveWorkspaceRow({
          name: trimmed,
          kind: "folder",
          payload: JSON.stringify(payload),
        });
      } else if (activeGroup) {
        const groupSessions = sessionTabs.filter(
          (t) => t.groupId === activeGroup.id,
        );
        const payload = serializeGroupWorkspace(activeGroup, groupSessions);
        if (!payload) {
          setListError("并发工作区至少需要 2 台有效主机");
          return;
        }
        await saveWorkspaceRow({
          name: trimmed,
          kind: "group",
          payload: JSON.stringify(payload),
        });
      } else {
        setListError("请先打开主机夹或并发会话再保存工作区");
        return;
      }
      setListError("");
      setWorkspaceRefreshToken((n) => n + 1);
    } catch (e) {
      setListError(String(e));
    }
  }, [activeFolder, activeGroup, sessionTabs]);

  const handleOpenWorkspace = useCallback(
    async (_row: SavedWorkspaceRow, payload: WorkspacePayload) => {
      const check = resolveHostsForPayload(payload, savedHostsRef.current);
      if (!check.ok) {
        setListError(
          `无法打开：缺少主机 id ${check.missing.join(", ")}（可能已删除）`,
        );
        return;
      }

      const hostsById = new Map(
        savedHostsRef.current.map((h) => [h.id, h] as const),
      );

      try {
        if (payload.kind === "folder") {
          const folderId = newFolderId();
          const cwdBySession = new Map<string, string | null | undefined>();
          const tabs: SessionTab[] = [];
          const alloc = (
            savedHostId: number,
            cwd: string | null | undefined,
          ) => {
            const item = hostsById.get(savedHostId);
            if (!item) throw new Error(`missing host ${savedHostId}`);
            const sessionId = newSessionId();
            const tab = buildSessionTab(item, sessionId, { folderId });
            if (cwd) tab.cwd = cwd;
            tabs.push(tab);
            cwdBySession.set(sessionId, cwd);
            return sessionId;
          };

          const subTabs: FolderSubTab[] = [];
          let allLeafIds: string[] = [];
          for (const st of payload.subTabs) {
            const hydrated = hydrateLayout(st.layout, alloc);
            subTabs.push({ id: newSubTabId(), layout: hydrated.layout });
            allLeafIds = allLeafIds.concat(hydrated.leafSessionIds);
          }
          if (subTabs.length === 0) {
            setListError("工作区内容为空");
            return;
          }

          const activeSubTabIndex = Math.min(
            Math.max(0, payload.activeSubTabIndex ?? 0),
            subTabs.length - 1,
          );
          const activeSub = subTabs[activeSubTabIndex];
          const leafIds = collectLayoutSessionIds(activeSub.layout);
          const activeLeafIndex = Math.min(
            Math.max(0, payload.activeLeafIndex ?? 0),
            Math.max(0, leafIds.length - 1),
          );
          const activeSessionId =
            leafIds[activeLeafIndex] ?? leafIds[0] ?? allLeafIds[0];

          const baseItem = hostsById.get(payload.savedHostId);
          const folder: HostFolder = {
            id: folderId,
            savedHostId: payload.savedHostId,
            baseTitle:
              payload.baseTitle ||
              (baseItem ? hostBaseTitle(baseItem) : "工作区"),
            subTabs,
            activeSubTabId: activeSub.id,
            activeSessionId,
            sessionIds: allLeafIds,
          };

          setSessionTabs((prev) => [...prev, ...tabs]);
          setFolders((prev) => [...prev, folder]);
          setActiveTabId(folderId);
          setListError("");

          await Promise.all(
            tabs.map(async (tab) => {
              const item = hostsById.get(tab.savedHostId!);
              if (!item) return;
              try {
                await invokeConnect(item, tab.id);
                updateTab(tab.id, { status: "connected", errorMessage: "" });
                const cwd = cwdBySession.get(tab.id);
                if (tab.kind !== "local" && isRestorableCwd(cwd)) {
                  void restoreCwdAfterReconnect(tab.id, cwd);
                }
              } catch (e) {
                updateTab(tab.id, {
                  status: "error",
                  errorMessage: String(e),
                });
              }
            }),
          );
          return;
        }

        // group
        const groupId = newGroupId();
        const prepared = payload.members.map((m) => {
          const item = hostsById.get(m.savedHostId)!;
          const sessionId = newSessionId();
          const tab = buildSessionTab(item, sessionId, { groupId });
          if (m.cwd) tab.cwd = m.cwd;
          return { item, sessionId, tab, cwd: m.cwd };
        });
        const sessionIds = prepared.map((p) => p.sessionId);
        const focusedIndex = Math.min(
          Math.max(0, payload.focusedIndex ?? 0),
          sessionIds.length - 1,
        );
        const group: ConcurrentGroup = {
          id: groupId,
          title: `并发 · ${prepared.length} 台`,
          sessionIds,
          focusedSessionId: sessionIds[focusedIndex] ?? null,
        };

        setSessionTabs((prev) => [...prev, ...prepared.map((p) => p.tab)]);
        setGroups((prev) => [...prev, group]);
        setActiveTabId(groupId);
        setListError("");

        await Promise.all(
          prepared.map(async ({ item, sessionId, tab, cwd }) => {
            try {
              await invokeConnect(item, sessionId);
              updateTab(sessionId, { status: "connected", errorMessage: "" });
              if (tab.kind !== "local" && isRestorableCwd(cwd)) {
                void restoreCwdAfterReconnect(sessionId, cwd);
              }
            } catch (e) {
              updateTab(sessionId, {
                status: "error",
                errorMessage: String(e),
              });
            }
          }),
        );
      } catch (e) {
        setListError(String(e));
      }
    },
    [restoreCwdAfterReconnect, updateTab],
  );

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (settingsOpen || editorOpen) return;
      if (!settingsRef.current.ctrlWheelZoom) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.(".terminal-view-wrap")) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const dir = e.deltaY < 0 ? 1 : -1;
      setSettings((prev) => {
        const nextSize = clampTerminalFontSize(prev.terminalFontSize + dir);
        if (nextSize === prev.terminalFontSize) return prev;
        const next = { ...prev, terminalFontSize: nextSize };
        saveSettings(next);
        return next;
      });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [editorOpen, settingsOpen]);

  useEffect(() => {
    const unlisten = listen<SshClosedEvent>("ssh-closed", (event) => {
      const { sessionId, reason } = event.payload;
      const normalized: SshCloseReason =
        reason === "user" || reason === "remote" || reason === "error"
          ? reason
          : "error";
      onSessionClosed(sessionId, normalized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onSessionClosed]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (settingsOpen || editorOpen) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        const inXterm = Boolean(target.closest?.(".xterm"));
        const tag = target.tagName;
        const isFormField =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable;
        // 普通输入不抢键；Ctrl/Alt/Meta 组合仍走应用快捷键（含远程文件开关）
        if (isFormField && !inXterm && !(e.ctrlKey || e.altKey || e.metaKey)) {
          return;
        }
      }

      for (const action of SHORTCUT_ACTIONS) {
        const binding = settings.shortcuts[action.id];
        if (!matchShortcut(e, binding)) continue;

        const kind = tabIndexForAction(action.id);
        if (kind === "toggleFiles") {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;

          if (onHostsTab) {
            setRemoteFilesOpenMap((prev) => ({
              ...prev,
              [HOSTS_TAB_ID]: !Boolean(prev[HOSTS_TAB_ID]),
            }));
            return;
          }

          let workspaceId: string | null = null;
          if (activeFolder) workspaceId = activeFolder.id;
          else if (activeGroup) workspaceId = activeGroup.id;
          if (!workspaceId) return;

          setRemoteFilesOpenMap((prev) => ({
            ...prev,
            [workspaceId!]: !Boolean(prev[workspaceId!]),
          }));
          return;
        }
        if (kind === "toggleAllSync") {
          e.preventDefault();
          e.stopPropagation();
          if (e.repeat) return;
          const control = syncControlRef.current;
          if (!control) return;
          if (control.allSynced) control.clearAll();
          else control.selectAll();
          return;
        }
        if (
          kind === "focusPaneLeft" ||
          kind === "focusPaneRight" ||
          kind === "focusPaneUp" ||
          kind === "focusPaneDown"
        ) {
          e.preventDefault();
          e.stopPropagation();
          const direction: PaneNavDirection =
            kind === "focusPaneLeft"
              ? "left"
              : kind === "focusPaneRight"
                ? "right"
                : kind === "focusPaneUp"
                  ? "up"
                  : "down";
          if (activeGroup) {
            const paneIds = activeGroup.sessionIds.filter((id) =>
              sessionTabs.some((t) => t.id === id),
            );
            if (paneIds.length === 0) return;
            const cur =
              activeGroup.focusedSessionId &&
              paneIds.includes(activeGroup.focusedSessionId)
                ? activeGroup.focusedSessionId
                : paneIds[0];
            const { cols } = concurrentGridDims(paneIds.length);
            const target = findNeighborInGrid(
              paneIds,
              cur,
              direction,
              cols,
            );
            if (target) focusSessionInGroup(activeGroup.id, target);
            return;
          }
          if (activeFolder) {
            const folder = normalizeHostFolder(activeFolder);
            const layout = getActiveSubTab(folder).layout;
            const cur = folder.activeSessionId;
            const target = findNeighborSessionId(layout, cur, direction);
            if (target) focusSessionInFolder(folder.id, target);
            return;
          }
          return;
        }
        if (kind === "prevPane" || kind === "nextPane") {
          e.preventDefault();
          e.stopPropagation();
          if (activeGroup) {
            const paneIds = activeGroup.sessionIds.filter((id) =>
              sessionTabs.some((t) => t.id === id),
            );
            if (paneIds.length === 0) return;
            const cur =
              activeGroup.focusedSessionId &&
              paneIds.includes(activeGroup.focusedSessionId)
                ? activeGroup.focusedSessionId
                : paneIds[0];
            let idx = paneIds.indexOf(cur);
            if (idx < 0) idx = 0;
            const nextIdx =
              kind === "nextPane"
                ? (idx + 1) % paneIds.length
                : (idx - 1 + paneIds.length) % paneIds.length;
            focusSessionInGroup(activeGroup.id, paneIds[nextIdx]);
            return;
          }
          if (activeFolder) {
            const folder = normalizeHostFolder(activeFolder);
            const paneIds = collectLayoutSessionIds(
              getActiveSubTab(folder).layout,
            ).filter((id) => sessionTabs.some((t) => t.id === id));
            if (paneIds.length === 0) return;
            const cur = paneIds.includes(folder.activeSessionId)
              ? folder.activeSessionId
              : paneIds[0];
            let idx = paneIds.indexOf(cur);
            if (idx < 0) idx = 0;
            const nextIdx =
              kind === "nextPane"
                ? (idx + 1) % paneIds.length
                : (idx - 1 + paneIds.length) % paneIds.length;
            focusSessionInFolder(folder.id, paneIds[nextIdx]);
          }
          return;
        }
        if (kind === "prev" || kind === "next") {
          if (cycleTabIds.length === 0) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          let idx = cycleTabIds.indexOf(activeTabId);
          if (idx < 0) {
            idx = kind === "next" ? -1 : 0;
          }
          const nextIdx =
            kind === "next"
              ? (idx + 1) % cycleTabIds.length
              : (idx - 1 + cycleTabIds.length) % cycleTabIds.length;
          e.preventDefault();
          e.stopPropagation();
          selectTab(cycleTabIds[nextIdx]);
          return;
        }

        if (kind >= orderedTabIds.length) return;
        e.preventDefault();
        e.stopPropagation();
        selectTab(orderedTabIds[kind]);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeFolder,
    activeGroup,
    activeTabId,
    cycleTabIds,
    editorOpen,
    focusSessionInFolder,
    focusSessionInGroup,
    onHostsTab,
    orderedTabIds,
    selectTab,
    sessionTabs,
    settings.shortcuts,
    settingsOpen,
  ]);

  const handleSyncControlChange = useCallback(
    (control: ConcurrentSyncControl | null) => {
      setSyncControl(control);
    },
    [],
  );

  return (
    <div className="app app-main">
      <AppTabBar
        folders={folders}
        groups={groups}
        activeTabId={activeTabId}
        folderErrorMessage={folderErrorMessage}
        groupErrorMessage={groupErrorMessage}
        syncToggle={
          syncControl
            ? {
                allSynced: syncControl.allSynced,
                syncCount: syncControl.syncCount,
                total: syncControl.total,
                onToggle: () => {
                  if (syncControl.allSynced) syncControl.clearAll();
                  else syncControl.selectAll();
                },
              }
            : null
        }
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="app-content">
        <div
          className={`hosts-panel${onHostsTab ? "" : " panel-hidden"}`}
          aria-hidden={!onHostsTab}
        >
          <div className="hosts-panel-main">
            {Boolean(remoteFilesOpenMap[HOSTS_TAB_ID]) ? (
              <WorkspaceSidebar
                onClose={() =>
                  setRemoteFilesOpenMap((prev) => ({
                    ...prev,
                    [HOSTS_TAB_ID]: false,
                  }))
                }
                filesAvailable={false}
                canSaveCurrent={false}
                saveDisabledReason="请先打开主机夹或并发会话"
                onSaveCurrent={() => undefined}
                onOpenWorkspace={(row, payload) => {
                  void handleOpenWorkspace(row, payload);
                }}
                refreshToken={workspaceRefreshToken}
              />
            ) : null}
            <div className="hosts-panel-body">
              <HostListPage
                hosts={savedHosts}
                categories={categories}
                selectedFilter={selectedFilter}
                status="idle"
                errorMessage={listError}
                onSelectFilter={setSelectedFilter}
                onAddCategory={handleAddCategory}
                onRenameCategory={handleRenameCategory}
                onDeleteCategory={handleDeleteCategory}
                onAdd={openAdd}
                onLogin={handleLogin}
                onEdit={openEdit}
                onDelete={handleDelete}
                onConcurrentConnect={handleConcurrentConnect}
              />
            </div>
          </div>
        </div>

        <div
          className={`terminal-stack${onHostsTab ? " panel-hidden" : ""}`}
          aria-hidden={onHostsTab}
        >
          {groups.map((group) => {
            const visible = activeTabId === group.id;
            const groupSessions = sessionTabs.filter(
              (t) => t.groupId === group.id,
            );
            return (
              <div
                key={group.id}
                className={`concurrent-panel${visible ? "" : " panel-hidden"}`}
                aria-hidden={!visible}
              >
                <ConcurrentWorkspace
                  sessions={groupSessions}
                  sessionIds={group.sessionIds}
                  focusedSessionId={group.focusedSessionId}
                  workspaceActive={visible}
                  filesOpen={Boolean(remoteFilesOpenMap[group.id])}
                  onFilesOpenChange={(open) =>
                    setRemoteFilesOpenMap((prev) => ({
                      ...prev,
                      [group.id]: open,
                    }))
                  }
                  onFocusSession={(sessionId) =>
                    focusSessionInGroup(group.id, sessionId)
                  }
                  onCloseSession={closeSession}
                  onReconnectSession={(sessionId) => {
                    void reconnectSession(sessionId, "manual");
                  }}
                  onCwdChange={handleCwdChange}
                  onSyncControlChange={
                    visible ? handleSyncControlChange : undefined
                  }
                  fontSize={settings.terminalFontSize}
                  canSaveWorkspace
                  onSaveWorkspace={() => {
                    void handleSaveCurrentWorkspace();
                  }}
                  onOpenWorkspace={(row, payload) => {
                    void handleOpenWorkspace(row, payload);
                  }}
                  workspaceRefreshToken={workspaceRefreshToken}
                />
              </div>
            );
          })}

          {folders.map((folder) => {
            const visible = activeTabId === folder.id;
            const folderSessions = sessionTabs.filter(
              (t) => t.folderId === folder.id,
            );
            const norm = normalizeHostFolder(folder);
            return (
              <div
                key={folder.id}
                className={`solo-panel${visible ? "" : " panel-hidden"}`}
                aria-hidden={!visible}
              >
                <TerminalWorkspace
                  sessions={folderSessions}
                  subTabs={norm.subTabs}
                  activeSubTabId={norm.activeSubTabId}
                  activeSessionId={norm.activeSessionId}
                  workspaceActive={visible}
                  filesOpen={Boolean(remoteFilesOpenMap[folder.id])}
                  onFilesOpenChange={(open) =>
                    setRemoteFilesOpenMap((prev) => ({
                      ...prev,
                      [folder.id]: open,
                    }))
                  }
                  onSelectSubTab={(subTabId) =>
                    focusSubTabInFolder(folder.id, subTabId)
                  }
                  onSelectSession={(sessionId) =>
                    focusSessionInFolder(folder.id, sessionId)
                  }
                  onCloseSubTab={(subTabId) =>
                    closeSubTabInFolder(folder.id, subTabId)
                  }
                  onCloseSession={closeSession}
                  onReconnectSession={(sessionId) => {
                    void reconnectSession(sessionId, "manual");
                  }}
                  onCwdChange={handleCwdChange}
                  onAddSession={() => {
                    void addSessionToFolder(folder.id);
                  }}
                  onSplitSession={(sessionId, direction) => {
                    void splitSessionInFolder(folder.id, sessionId, direction);
                  }}
                  onQuadSplitSession={(sessionId) => {
                    void quadSplitSessionInFolder(folder.id, sessionId);
                  }}
                  onSplitRatioChange={(splitId, ratio) => {
                    changeFolderSplitRatio(folder.id, splitId, ratio);
                  }}
                  onSyncControlChange={
                    visible ? handleSyncControlChange : undefined
                  }
                  fontSize={settings.terminalFontSize}
                  canSaveWorkspace
                  onSaveWorkspace={() => {
                    void handleSaveCurrentWorkspace();
                  }}
                  onOpenWorkspace={(row, payload) => {
                    void handleOpenWorkspace(row, payload);
                  }}
                  workspaceRefreshToken={workspaceRefreshToken}
                />
              </div>
            );
          })}
        </div>
      </div>

      <HostEditor
        open={editorOpen}
        mode={editorMode}
        initial={editingHost}
        categories={categories}
        defaultCategoryId={defaultCategoryIdForAdd}
        busy={editorBusy}
        errorMessage={editorError}
        onClose={closeEditor}
        onSave={handleEditorSave}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
      />
    </div>
  );
}

export default App;
