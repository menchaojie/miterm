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
  SshCloseReason,
  SshClosedEvent,
} from "./types";
import {
  HOSTS_TAB_ID,
  isLocalHost,
  newFolderId,
  newGroupId,
  newSessionId,
} from "./types";
import { isRestorableCwd, shellSingleQuote, guessUnixHome } from "./cwd";
import "./App.css";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function syncMaximizedClass(maximized: boolean) {
  document.documentElement.classList.toggle("window-maximized", maximized);
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
  settingsRef.current = settings;
  savedHostsRef.current = savedHosts;
  sessionTabsRef.current = sessionTabs;

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
      for (const f of prev) {
        if (!f.sessionIds.includes(sessionId)) {
          next.push(f);
          continue;
        }
        const sessionIds = f.sessionIds.filter((id) => id !== sessionId);
        if (sessionIds.length === 0) continue;
        next.push({
          ...f,
          sessionIds,
          activeSessionId:
            f.activeSessionId === sessionId
              ? sessionIds[0]
              : f.activeSessionId,
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

      setFolders((prev) => [
        ...prev,
        {
          id: folderId,
          savedHostId: item.id,
          baseTitle,
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
      const tab = buildSessionTab(item, sessionId, { folderId });
      setSessionTabs((prev) => [...prev, tab]);
      setFolders((prev) =>
        prev.map((f) =>
          f.id === folderId
            ? {
                ...f,
                sessionIds: [...f.sessionIds, sessionId],
                activeSessionId: sessionId,
              }
            : f,
        ),
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
        prev.map((f) =>
          f.id === folderId ? { ...f, activeSessionId: sessionId } : f,
        ),
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
        if (isFormField && !inXterm) return;
      }

      for (const action of SHORTCUT_ACTIONS) {
        const binding = settings.shortcuts[action.id];
        if (!matchShortcut(e, binding)) continue;

        const kind = tabIndexForAction(action.id);
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
            const paneIds = activeFolder.sessionIds.filter((id) =>
              sessionTabs.some((t) => t.id === id),
            );
            if (paneIds.length === 0) return;
            const cur = paneIds.includes(activeFolder.activeSessionId)
              ? activeFolder.activeSessionId
              : paneIds[0];
            let idx = paneIds.indexOf(cur);
            if (idx < 0) idx = 0;
            const nextIdx =
              kind === "nextPane"
                ? (idx + 1) % paneIds.length
                : (idx - 1 + paneIds.length) % paneIds.length;
            focusSessionInFolder(activeFolder.id, paneIds[nextIdx]);
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
          activeGroup && syncControl
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
                />
              </div>
            );
          })}

          {folders.map((folder) => {
            const visible = activeTabId === folder.id;
            const folderSessions = sessionTabs.filter(
              (t) => t.folderId === folder.id,
            );
            return (
              <div
                key={folder.id}
                className={`solo-panel${visible ? "" : " panel-hidden"}`}
                aria-hidden={!visible}
              >
                <TerminalWorkspace
                  sessions={folderSessions}
                  sessionIds={folder.sessionIds}
                  activeSessionId={folder.activeSessionId}
                  workspaceActive={visible}
                  onSelectSession={(sessionId) =>
                    focusSessionInFolder(folder.id, sessionId)
                  }
                  onCloseSession={closeSession}
                  onReconnectSession={(sessionId) => {
                    void reconnectSession(sessionId, "manual");
                  }}
                  onCwdChange={handleCwdChange}
                  onAddSession={() => {
                    void addSessionToFolder(folder.id);
                  }}
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
