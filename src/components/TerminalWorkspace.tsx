import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView, CURSOR_COLOR, CURSOR_DIM } from "./TerminalView";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import type { ConcurrentSyncControl } from "./ConcurrentWorkspace";
import { getSessionTerminalSelection } from "../hooks/useSshTerminal";
import type {
  FolderLayout,
  FolderSubTab,
  SessionTab,
  SplitDirection,
} from "../types";
import type { SavedWorkspaceRow, WorkspacePayload } from "../workspace";
import { guessUnixHome } from "../cwd";
import { commandTextForInject } from "../savedCommands";
import {
  collectLayoutSessionIds,
  countLayoutLeaves,
  layoutContainsSession,
} from "../splitLayout";

interface TerminalWorkspaceProps {
  sessions: SessionTab[];
  /** 二级 Tab（每个 Tab 内可多分屏窗格） */
  subTabs: FolderSubTab[];
  activeSubTabId: string;
  activeSessionId: string;
  workspaceActive?: boolean;
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  /** 工作区侧栏 */
  canSaveWorkspace?: boolean;
  saveWorkspaceDisabledReason?: string;
  onSaveWorkspace?: (categoryId: number | null) => void;
  onOpenWorkspace?: (
    row: import("../workspace").SavedWorkspaceRow,
    payload: import("../workspace").WorkspacePayload,
  ) => void;
  workspaceRefreshToken?: number;
  /** 与主机共用的分类（工作区筛选/归属） */
  workspaceCategories?: import("../types").Category[];
  onSelectSubTab: (subTabId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSubTab: (subTabId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** 新建二级 Tab */
  onAddSession: () => void;
  onSplitSession: (sessionId: string, direction: SplitDirection) => void;
  onQuadSplitSession: (sessionId: string) => void;
  onSplitRatioChange: (splitId: string, ratio: number) => void;
  onReconnectSession?: (sessionId: string) => void;
  onCwdChange?: (sessionId: string, cwd: string | null) => void;
  onSyncControlChange?: (control: ConcurrentSyncControl | null) => void;
  /** 终端字号（px） */
  fontSize?: number;
}

type CtxMenu = {
  x: number;
  y: number;
  sessionId: string;
  selection: string;
};

const CTX_MENU_PAD = 8;

function clampCtxMenuPos(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let nextX = x;
  let nextY = y;
  if (nextX + width > vw - CTX_MENU_PAD) {
    nextX = Math.max(CTX_MENU_PAD, vw - width - CTX_MENU_PAD);
  }
  if (nextX < CTX_MENU_PAD) nextX = CTX_MENU_PAD;
  if (nextY + height > vh - CTX_MENU_PAD) {
    nextY = y - height;
    if (nextY < CTX_MENU_PAD) {
      nextY = Math.max(CTX_MENU_PAD, vh - height - CTX_MENU_PAD);
    }
  }
  if (nextY < CTX_MENU_PAD) nextY = CTX_MENU_PAD;
  return { x: nextX, y: nextY };
}

function IconSession() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M4 6.5l2 1.75L4 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 10h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconSplitVertical() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect
        x="1.5"
        y="2"
        width="13"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M8 2.5v11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <rect
        x="3"
        y="4.2"
        width="3.6"
        height="7.6"
        rx="0.6"
        fill="currentColor"
        opacity="0.22"
      />
      <rect
        x="9.4"
        y="4.2"
        width="3.6"
        height="7.6"
        rx="0.6"
        fill="currentColor"
        opacity="0.38"
      />
    </svg>
  );
}

function IconSplitHorizontal() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect
        x="1.5"
        y="2"
        width="13"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M2 8h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <rect
        x="3.2"
        y="3.4"
        width="9.6"
        height="3.2"
        rx="0.6"
        fill="currentColor"
        opacity="0.22"
      />
      <rect
        x="3.2"
        y="9.4"
        width="9.6"
        height="3.2"
        rx="0.6"
        fill="currentColor"
        opacity="0.38"
      />
    </svg>
  );
}

function IconSplitQuad() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect
        x="1.5"
        y="2"
        width="13"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M8 2.5v11M2 8h12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <rect
        x="3"
        y="3.4"
        width="3.8"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        opacity="0.22"
      />
      <rect
        x="9.2"
        y="3.4"
        width="3.8"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        opacity="0.3"
      />
      <rect
        x="3"
        y="9.4"
        width="3.8"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        opacity="0.3"
      />
      <rect
        x="9.2"
        y="9.4"
        width="3.8"
        height="3.2"
        rx="0.5"
        fill="currentColor"
        opacity="0.4"
      />
    </svg>
  );
}

function SplitSash({
  direction,
  ratio,
  onRatioChange,
}: {
  direction: SplitDirection;
  ratio: number;
  onRatioChange: (ratio: number) => void;
}) {
  const onMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sash = e.currentTarget as HTMLElement;
    const parent = sash.parentElement;
    if (!parent) return;
    document.body.classList.add("split-sash-dragging");

    const vertical = direction === "vertical";
    const startPos = vertical ? e.clientX : e.clientY;
    const startRatio = ratio;
    const startRect = parent.getBoundingClientRect();
    const containerSize = vertical ? startRect.width : startRect.height;

    const onMove = (ev: MouseEvent) => {
      if (containerSize <= 0) return;
      const pos = vertical ? ev.clientX : ev.clientY;
      onRatioChange(startRatio + (pos - startPos) / containerSize);
    };
    const onUp = () => {
      document.body.classList.remove("split-sash-dragging");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className={`split-sash split-sash-${direction}`}
      role="separator"
      aria-orientation={direction === "vertical" ? "vertical" : "horizontal"}
      onMouseDown={onMouseDown}
    />
  );
}

/**
 * 主机夹工作区：二级 Tab + Tab 内分屏；分屏不新增二级 Tab。
 */
export function TerminalWorkspace({
  sessions,
  subTabs,
  activeSubTabId,
  activeSessionId,
  workspaceActive = true,
  filesOpen,
  onFilesOpenChange,
  canSaveWorkspace = false,
  saveWorkspaceDisabledReason,
  onSaveWorkspace,
  onOpenWorkspace,
  workspaceRefreshToken = 0,
  workspaceCategories,
  onSelectSubTab,
  onSelectSession,
  onCloseSubTab,
  onCloseSession,
  onAddSession,
  onSplitSession,
  onQuadSplitSession,
  onSplitRatioChange,
  onReconnectSession,
  onCwdChange,
  onSyncControlChange,
  fontSize = 14,
}: TerminalWorkspaceProps) {
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const [syncIds, setSyncIds] = useState<Set<string>>(() => new Set());
  const syncIdsRef = useRef(syncIds);
  const sessionsRef = useRef(sessions);
  syncIdsRef.current = syncIds;
  sessionsRef.current = sessions;

  const byId = useCallback(
    (id: string) => sessions.find((s) => s.id === id),
    [sessions],
  );

  const activeSubTab = useMemo(
    () => subTabs.find((t) => t.id === activeSubTabId) ?? subTabs[0],
    [subTabs, activeSubTabId],
  );

  const layout: FolderLayout = useMemo(
    () => activeSubTab?.layout ?? { type: "leaf", sessionId: activeSessionId },
    [activeSubTab, activeSessionId],
  );

  const splitMode = countLayoutLeaves(layout) > 1;

  const layoutIdsKey = useMemo(
    () => collectLayoutSessionIds(layout).join("\n"),
    [layout],
  );
  const layoutIds = useMemo(
    () => (layoutIdsKey ? layoutIdsKey.split("\n") : []),
    [layoutIdsKey],
  );
  const prevLayoutIdsRef = useRef<string[]>([]);

  const activeTab = useMemo(() => {
    const focused = byId(activeSessionId);
    if (focused && layoutContainsSession(layout, focused.id)) return focused;
    return byId(layoutIds[0] ?? "") ?? null;
  }, [activeSessionId, byId, layout, layoutIds]);

  const syncCount = useMemo(
    () => layoutIds.filter((id) => syncIds.has(id)).length,
    [layoutIds, syncIds],
  );
  const allSynced =
    splitMode && layoutIds.length > 0 && syncCount === layoutIds.length;

  useEffect(() => {
    if (!splitMode) {
      prevLayoutIdsRef.current = [];
      setSyncIds((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    setSyncIds((prev) => {
      const prevAll = new Set(prevLayoutIdsRef.current);
      const next = new Set<string>();
      if (prevLayoutIdsRef.current.length === 0) {
        for (const id of layoutIds) next.add(id);
      } else {
        for (const id of layoutIds) {
          if (prev.has(id)) next.add(id);
          else if (!prevAll.has(id)) next.add(id);
        }
      }
      prevLayoutIdsRef.current = layoutIds;
      if (
        next.size === prev.size &&
        [...next].every((id) => prev.has(id))
      ) {
        return prev;
      }
      return next;
    });
  }, [layoutIds, splitMode]);

  const selectAllSync = useCallback(() => {
    setSyncIds(new Set(layoutIds));
  }, [layoutIds]);

  const clearAllSync = useCallback(() => {
    setSyncIds(new Set());
  }, []);

  const toggleSync = useCallback((sessionId: string) => {
    setSyncIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!onSyncControlChange) return;
    if (!workspaceActive || !splitMode) {
      onSyncControlChange(null);
      return;
    }
    onSyncControlChange({
      allSynced,
      syncCount,
      total: layoutIds.length,
      selectAll: selectAllSync,
      clearAll: clearAllSync,
    });
  }, [
    allSynced,
    clearAllSync,
    layoutIds.length,
    onSyncControlChange,
    selectAllSync,
    splitMode,
    syncCount,
    workspaceActive,
  ]);

  useEffect(() => {
    return () => onSyncControlChange?.(null);
  }, [onSyncControlChange]);

  const handleUserInput = useCallback((sourceId: string, data: string) => {
    const bytes = Array.from(new TextEncoder().encode(data));
    const sync = syncIdsRef.current;
    const list = sessionsRef.current;
    const targets = new Set<string>();
    targets.add(sourceId);
    if (sync.size > 0) {
      for (const id of sync) {
        const tab = list.find((t) => t.id === id);
        if (tab?.status === "connected") targets.add(id);
      }
    }
    for (const id of targets) {
      const tab = list.find((t) => t.id === id);
      if (tab?.status !== "connected") continue;
      invoke("ssh_write", { sessionId: id, data: bytes }).catch(console.error);
    }
  }, []);

  const injectSavedCommand = useCallback(
    (body: string, opts: { run: boolean }) => {
      const tab = sessionsRef.current.find((t) => t.id === activeSessionId);
      if (!tab || tab.status !== "connected") return;
      handleUserInput(tab.id, commandTextForInject(body, opts.run));
    },
    [activeSessionId, handleUserInput],
  );

  const canBrowseFiles =
    Boolean(activeTab) &&
    activeTab?.kind !== "local" &&
    activeTab?.status === "connected";

  const canInjectCommand = activeTab?.status === "connected";

  const filesInitialPath =
    activeTab?.cwd ||
    (activeTab ? guessUnixHome(activeTab.username) : "/");

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampCtxMenuPos(ctxMenu.x, ctxMenu.y, rect.width, rect.height);
    if (next.x !== ctxMenu.x || next.y !== ctxMenu.y) {
      setCtxMenu((prev) =>
        prev ? { ...prev, x: next.x, y: next.y } : prev,
      );
    }
  }, [ctxMenu]);

  const openCtxMenu = (sessionId: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectSession(sessionId);
    const selection = getSessionTerminalSelection(sessionId);
    const pos = clampCtxMenuPos(e.clientX, e.clientY, 220, 320);
    setCtxMenu({ x: pos.x, y: pos.y, sessionId, selection });
  };

  const copySelection = async (text: string) => {
    const value = text.trimEnd();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      console.error(err);
    }
  };

  const pasteFromClipboard = async (sessionId: string) => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      handleUserInput(sessionId, text);
    } catch (err) {
      console.error(err);
    }
  };

  const bumpLayout = useCallback(() => {
    setLayoutEpoch((n) => n + 1);
  }, []);

  const renderLayout = (
    node: FolderLayout,
    opts: { interactive: boolean; paneSplit: boolean },
  ): ReactNode => {
    if (node.type === "leaf") {
      const tab = byId(node.sessionId);
      if (!tab) return null;
      const focused = opts.interactive && tab.id === activeSessionId;
      const visible = workspaceActive && opts.interactive;
      const inSync = opts.paneSplit && syncIds.has(tab.id);
      return (
        <div
          key={tab.id}
          className={`split-leaf${focused ? " is-focused" : ""}${
            inSync ? " in-sync" : ""
          }`}
          onMouseDown={() => {
            if (opts.interactive) onSelectSession(tab.id);
          }}
          onContextMenuCapture={(e) => {
            if (opts.interactive) openCtxMenu(tab.id, e);
          }}
        >
          <div className="split-leaf-body">
            <TerminalView
              sessionId={tab.id}
              status={tab.status}
              visible={visible}
              focused={visible && focused && !filesOpen}
              layoutEpoch={layoutEpoch}
              fontSize={fontSize}
              cursorBlink={false}
              cursorStyle={
                opts.paneSplit
                  ? inSync || focused
                    ? "bar"
                    : "block"
                  : "bar"
              }
              cursorColor={
                opts.paneSplit
                  ? inSync || focused
                    ? CURSOR_COLOR
                    : CURSOR_DIM
                  : CURSOR_COLOR
              }
              onUserInput={
                opts.interactive && opts.paneSplit
                  ? (data) => handleUserInput(tab.id, data)
                  : undefined
              }
              systemNotice={tab.systemNotice}
              homeHint={
                tab.kind === "local" ? null : guessUnixHome(tab.username)
              }
              initialCwd={tab.cwd ?? null}
              onReconnect={
                onReconnectSession
                  ? () => onReconnectSession(tab.id)
                  : undefined
              }
              onCwdChange={
                onCwdChange ? (cwd) => onCwdChange(tab.id, cwd) : undefined
              }
            />
          </div>
        </div>
      );
    }

    const vertical = node.direction === "vertical";
    const style = {
      flexDirection: vertical ? "row" : "column",
    } as CSSProperties;
    const firstStyle = {
      flex: `${node.ratio} 1 0`,
      minWidth: 0,
      minHeight: 0,
    } as CSSProperties;
    const secondStyle = {
      flex: `${1 - node.ratio} 1 0`,
      minWidth: 0,
      minHeight: 0,
    } as CSSProperties;

    return (
      <div key={node.id} className="split-branch" style={style}>
        <div className="split-branch-child" style={firstStyle}>
          {renderLayout(node.first, opts)}
        </div>
        {opts.interactive ? (
          <SplitSash
            direction={node.direction}
            ratio={node.ratio}
            onRatioChange={(next) => {
              onSplitRatioChange(node.id, next);
              bumpLayout();
            }}
          />
        ) : (
          <div className={`split-sash split-sash-${node.direction}`} />
        )}
        <div className="split-branch-child" style={secondStyle}>
          {renderLayout(node.second, opts)}
        </div>
      </div>
    );
  };

  const ctxTab = ctxMenu ? byId(ctxMenu.sessionId) : null;
  const canSplitCtx = ctxTab?.status === "connected";
  const canPasteCtx = canSplitCtx;
  const ctxSelection = ctxMenu?.selection?.trim() ? ctxMenu.selection : "";
  const ctxInSync = ctxMenu ? syncIds.has(ctxMenu.sessionId) : false;
  const ctxInLayout = ctxMenu
    ? layoutContainsSession(layout, ctxMenu.sessionId)
    : false;
  const showCtxMenu = Boolean(
    ctxMenu && (canSplitCtx || ctxSelection || canPasteCtx),
  );

  return (
    <div className="terminal-workspace">
      <div className="terminal-workspace-main">
        {workspaceActive && filesOpen ? (
          <WorkspaceSidebar
            onClose={() => onFilesOpenChange(false)}
            filesAvailable={canBrowseFiles}
            filesSessionId={canBrowseFiles ? activeTab?.id ?? null : null}
            filesInitialPath={filesInitialPath}
            filesTerminalCwd={activeTab?.cwd ?? null}
            filesConnected={activeTab?.status === "connected"}
            canSaveCurrent={canSaveWorkspace}
            saveDisabledReason={saveWorkspaceDisabledReason}
            onSaveCurrent={(categoryId) => onSaveWorkspace?.(categoryId)}
            onOpenWorkspace={(row, payload) =>
              onOpenWorkspace?.(row as SavedWorkspaceRow, payload as WorkspacePayload)
            }
            refreshToken={workspaceRefreshToken}
            categories={workspaceCategories}
            canInjectCommand={canInjectCommand}
            injectCommandDisabledReason="请先聚焦已连接的终端窗格"
            onInjectCommand={injectSavedCommand}
          />
        ) : null}

        <div className="terminal-workspace-stages split-root">
          {subTabs.map((st) => {
            const active = st.id === activeSubTabId;
            const paneSplit = countLayoutLeaves(st.layout) > 1;
            return (
              <div
                key={st.id}
                className={`subtab-stage${active ? " is-active" : ""}`}
                aria-hidden={!active}
              >
                {renderLayout(st.layout, {
                  interactive: active,
                  paneSplit: active && paneSplit,
                })}
              </div>
            );
          })}

          {workspaceActive ? (
            <div className="solo-subtab-hit">
              <div className="solo-subtab-chrome">
                <div className="solo-subtabs" role="tablist" aria-label="二级会话">
                  {subTabs.map((st, index) => {
                    const selected = st.id === activeSubTabId;
                    const leafIds = collectLayoutSessionIds(st.layout);
                    const anyError = leafIds.some(
                      (id) => byId(id)?.status === "error",
                    );
                    const anyConnecting = leafIds.some((id) => {
                      const s = byId(id)?.status;
                      return s === "connecting" || s === "reconnecting";
                    });
                    const paneCount = leafIds.length;
                    const name =
                      paneCount > 1
                        ? `连接 ${index + 1}（${paneCount} 窗格）`
                        : `连接 ${index + 1}`;
                    return (
                      <div
                        key={st.id}
                        className={`solo-subtab${selected ? " active" : ""}${
                          anyError ? " error" : ""
                        }${anyConnecting ? " connecting" : ""}`}
                      >
                        <button
                          type="button"
                          className="solo-subtab-label"
                          role="tab"
                          aria-selected={selected}
                          title={name}
                          aria-label={name}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectSubTab(st.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <IconSession />
                          <span className="solo-subtab-num">{index + 1}</span>
                          {paneCount > 1 ? (
                            <span className="solo-subtab-panes">
                              {paneCount}
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          className="solo-subtab-close"
                          title="关闭此二级会话"
                          aria-label={`关闭 ${name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseSubTab(st.id);
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="solo-subtab-add"
                    title="新建二级会话"
                    aria-label="新建二级会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddSession();
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    +
                  </button>
                </div>
                <button
                  type="button"
                  className={`solo-subtab-files${filesOpen ? " active" : ""}`}
                  title="侧栏（工作区 / 远程文件 / 命令）· Ctrl+Shift+E"
                  aria-label="侧栏"
                  aria-pressed={filesOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFilesOpenChange(!filesOpen);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  侧栏
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {showCtxMenu && ctxMenu ? (
        <div
          ref={ctxMenuRef}
          className="session-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctxSelection ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void copySelection(ctxSelection);
                setCtxMenu(null);
              }}
            >
              复制
            </button>
          ) : null}
          {canPasteCtx ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void pasteFromClipboard(ctxMenu.sessionId);
                setCtxMenu(null);
              }}
            >
              粘贴
            </button>
          ) : null}
          {canSplitCtx ? (
            <>
              {ctxSelection || canPasteCtx ? (
                <div className="session-ctx-menu-sep" role="separator" />
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="session-ctx-menu-item"
                onClick={() => {
                  onSplitSession(ctxMenu.sessionId, "vertical");
                  setCtxMenu(null);
                }}
              >
                <span className="session-ctx-menu-icon" aria-hidden="true">
                  <IconSplitVertical />
                </span>
                <span className="session-ctx-menu-text">
                  <span className="session-ctx-menu-title">垂直分割</span>
                  <span className="session-ctx-menu-hint">左右分屏</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-ctx-menu-item"
                onClick={() => {
                  onSplitSession(ctxMenu.sessionId, "horizontal");
                  setCtxMenu(null);
                }}
              >
                <span className="session-ctx-menu-icon" aria-hidden="true">
                  <IconSplitHorizontal />
                </span>
                <span className="session-ctx-menu-text">
                  <span className="session-ctx-menu-title">水平分割</span>
                  <span className="session-ctx-menu-hint">上下分屏</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="session-ctx-menu-item"
                onClick={() => {
                  onQuadSplitSession(ctxMenu.sessionId);
                  setCtxMenu(null);
                }}
              >
                <span className="session-ctx-menu-icon" aria-hidden="true">
                  <IconSplitQuad />
                </span>
                <span className="session-ctx-menu-text">
                  <span className="session-ctx-menu-title">田字分割</span>
                  <span className="session-ctx-menu-hint">四格分屏</span>
                </span>
              </button>
              {splitMode && ctxInLayout ? (
                <>
                  <div className="session-ctx-menu-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      toggleSync(ctxMenu.sessionId);
                      setCtxMenu(null);
                    }}
                  >
                    {ctxInSync ? "退出并发输入" : "加入并发输入"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      selectAllSync();
                      setCtxMenu(null);
                    }}
                  >
                    全部加入并发输入
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      clearAllSync();
                      setCtxMenu(null);
                    }}
                  >
                    全部退出并发输入
                  </button>
                </>
              ) : null}
              {splitMode ? (
                <>
                  <div className="session-ctx-menu-sep" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className="danger"
                    onClick={() => {
                      onCloseSession(ctxMenu.sessionId);
                      setCtxMenu(null);
                    }}
                  >
                    关闭此窗格
                  </button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
