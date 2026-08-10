import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView, CURSOR_COLOR, CURSOR_DIM } from "./TerminalView";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { getSessionTerminalSelection } from "../hooks/useSshTerminal";
import type { SessionTab } from "../types";
import { concurrentGridDims, concurrentLastCellColSpan } from "../types";
import type { SavedWorkspaceRow, WorkspacePayload } from "../workspace";
import { guessUnixHome } from "../cwd";
import { commandTextForInject } from "../savedCommands";

export interface ConcurrentSyncControl {
  allSynced: boolean;
  syncCount: number;
  total: number;
  selectAll: () => void;
  clearAll: () => void;
}

interface ConcurrentWorkspaceProps {
  sessions: SessionTab[];
  /** 格子顺序（与连接顺序一致） */
  sessionIds: string[];
  focusedSessionId: string | null;
  /** 工作区是否在前台 */
  workspaceActive?: boolean;
  /** 远程文件侧栏（由 App 控制，便于全局快捷键） */
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  canSaveWorkspace?: boolean;
  saveWorkspaceDisabledReason?: string;
  onSaveWorkspace?: () => void;
  onOpenWorkspace?: (
    row: SavedWorkspaceRow,
    payload: WorkspacePayload,
  ) => void;
  workspaceRefreshToken?: number;
  onFocusSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onReconnectSession?: (sessionId: string) => void;
  onCwdChange?: (sessionId: string, cwd: string | null) => void;
  /** 向 Tab 栏上报全选/取消控制（离开时传 null） */
  onSyncControlChange?: (control: ConcurrentSyncControl | null) => void;
  /** 终端字号（px） */
  fontSize?: number;
}

function sessionLabel(tab: SessionTab): string {
  return (
    tab.title ||
    (tab.username ? `${tab.username}@${tab.host}` : `${tab.host}:${tab.port}`)
  );
}

function statusLabel(tab: SessionTab, label: string): string {
  if (tab.status === "connecting" || tab.status === "reconnecting") {
    return `${label}…`;
  }
  if (tab.status === "error" || tab.status === "exited") return `! ${label}`;
  if (tab.status === "disconnecting") return `${label}（断开中）`;
  return label;
}

/** 已加入并发输入（链式） */
function IconSyncOn() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.5 4.5a2.5 2.5 0 0 0 0 5h1v1.2h-1a3.7 3.7 0 1 1 0-7.4h1V4.5h-1zm3 0h-1V3.3h1a3.7 3.7 0 1 1 0 7.4h-1V9.5h1a2.5 2.5 0 0 0 0-5z"
      />
    </svg>
  );
}

/** 未加入并发输入（断开链） */
function IconSyncOff() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.5 4.5a2.5 2.5 0 0 0 0 5h.8v1.2h-.8a3.7 3.7 0 1 1 0-7.4h.8V4.5h-.8zm3 0h-.8V3.3h.8a3.7 3.7 0 0 1 2.6 6.3l-.9-.9A2.5 2.5 0 0 0 9.5 4.5zm-5.2 8.2 8.2-8.2.9.9-8.2 8.2-.9-.9z"
      />
    </svg>
  );
}

export function ConcurrentWorkspace({
  sessions,
  sessionIds,
  focusedSessionId,
  workspaceActive = true,
  filesOpen,
  onFilesOpenChange,
  canSaveWorkspace = false,
  saveWorkspaceDisabledReason,
  onSaveWorkspace,
  onOpenWorkspace,
  workspaceRefreshToken = 0,
  onFocusSession,
  onCloseSession,
  onReconnectSession,
  onCwdChange,
  onSyncControlChange,
  fontSize = 14,
}: ConcurrentWorkspaceProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
    selection: string;
  } | null>(null);
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

  const ordered = sessionIds
    .map((id) => byId(id))
    .filter((t): t is SessionTab => Boolean(t));

  const { cols, rows } = concurrentGridDims(ordered.length);
  const lastSpan = concurrentLastCellColSpan(ordered.length, cols);

  const allIdsKey = ordered.map((t) => t.id).join("\n");
  const allIds = useMemo(
    () => (allIdsKey ? allIdsKey.split("\n") : []),
    [allIdsKey],
  );
  const prevAllIdsRef = useRef<string[]>([]);
  const syncCount = useMemo(
    () => allIds.filter((id) => syncIds.has(id)).length,
    [allIds, syncIds],
  );
  const allSynced = allIds.length > 0 && syncCount === allIds.length;

  useEffect(() => {
    setSyncIds((prev) => {
      const prevAll = new Set(prevAllIdsRef.current);
      const next = new Set<string>();
      if (prevAllIdsRef.current.length === 0) {
        for (const id of allIds) next.add(id);
      } else {
        for (const id of allIds) {
          if (prev.has(id)) next.add(id);
          else if (!prevAll.has(id)) next.add(id);
        }
      }
      prevAllIdsRef.current = allIds;
      if (
        next.size === prev.size &&
        [...next].every((id) => prev.has(id))
      ) {
        return prev;
      }
      return next;
    });
  }, [allIds]);

  const selectAllSync = useCallback(() => {
    setSyncIds(new Set(allIds));
  }, [allIds]);

  const clearAllSync = useCallback(() => {
    setSyncIds(new Set());
  }, []);

  useEffect(() => {
    if (!onSyncControlChange) return;
    onSyncControlChange({
      allSynced,
      syncCount,
      total: allIds.length,
      selectAll: selectAllSync,
      clearAll: clearAllSync,
    });
  }, [
    allIds.length,
    allSynced,
    clearAllSync,
    onSyncControlChange,
    selectAllSync,
    syncCount,
  ]);

  useEffect(() => {
    return () => onSyncControlChange?.(null);
  }, [onSyncControlChange]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setLayoutEpoch((n) => n + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setLayoutEpoch((n) => n + 1);
  }, [ordered.length, cols, rows, lastSpan]);

  const toggleSync = useCallback((sessionId: string) => {
    setSyncIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

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

  const focusedTab = useMemo(
    () =>
      ordered.find((t) => t.id === focusedSessionId) ?? ordered[0] ?? null,
    [ordered, focusedSessionId],
  );

  const injectSavedCommand = useCallback(
    (body: string, opts: { run: boolean }) => {
      const id = focusedSessionId ?? focusedTab?.id;
      if (!id) return;
      const tab = sessionsRef.current.find((t) => t.id === id);
      if (!tab || tab.status !== "connected") return;
      handleUserInput(tab.id, commandTextForInject(body, opts.run));
    },
    [focusedSessionId, focusedTab?.id, handleUserInput],
  );

  const canBrowseFiles =
    Boolean(focusedTab) &&
    focusedTab?.kind !== "local" &&
    focusedTab?.status === "connected";
  const canInjectCommand = focusedTab?.status === "connected";
  const filesInitialPath =
    focusedTab?.cwd ||
    (focusedTab ? guessUnixHome(focusedTab.username) : "/");

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
    const pad = 8;
    let x = ctxMenu.x;
    let y = ctxMenu.y;
    if (x + rect.width > window.innerWidth - pad) {
      x = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (y + rect.height > window.innerHeight - pad) {
      y = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    if (x !== ctxMenu.x || y !== ctxMenu.y) {
      setCtxMenu((prev) => (prev ? { ...prev, x, y } : prev));
    }
  }, [ctxMenu]);

  const openCtxMenu = (sessionId: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFocusSession(sessionId);
    const selection = getSessionTerminalSelection(sessionId);
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      sessionId,
      selection,
    });
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

  const ctxInSync = ctxMenu ? syncIds.has(ctxMenu.sessionId) : false;
  const ctxSelection = ctxMenu?.selection?.trim() ? ctxMenu.selection : "";

  return (
    <div className="concurrent-workspace">
      <div className="concurrent-workspace-main">
      {workspaceActive && filesOpen ? (
        <WorkspaceSidebar
          onClose={() => onFilesOpenChange(false)}
          filesAvailable={canBrowseFiles}
          filesSessionId={canBrowseFiles ? focusedTab?.id ?? null : null}
          filesInitialPath={filesInitialPath}
          filesTerminalCwd={focusedTab?.cwd ?? null}
          filesConnected={focusedTab?.status === "connected"}
          canSaveCurrent={canSaveWorkspace}
          saveDisabledReason={saveWorkspaceDisabledReason}
          onSaveCurrent={() => onSaveWorkspace?.()}
          onOpenWorkspace={(row, payload) => onOpenWorkspace?.(row, payload)}
          refreshToken={workspaceRefreshToken}
          canInjectCommand={canInjectCommand}
          injectCommandDisabledReason="请先聚焦已连接的终端窗格"
          onInjectCommand={injectSavedCommand}
        />
      ) : null}
      <div
        className="concurrent-desk"
        ref={gridRef}
        style={
          {
            "--concurrent-cols": cols,
            "--concurrent-rows": rows,
          } as CSSProperties
        }
      >
        <div className="concurrent-grid">
          {ordered.map((tab, index) => {
            const focused = focusedSessionId === tab.id;
            const label = sessionLabel(tab);
            const isLast = index === ordered.length - 1;
            const span = isLast && lastSpan > 1 ? lastSpan : 1;
            const connecting =
              tab.status === "connecting" || tab.status === "reconnecting";
            const errored =
              tab.status === "error" || tab.status === "exited";
            const inSync = syncIds.has(tab.id);
            const showFilesBtn =
              tab.kind !== "local" && tab.status === "connected";

            return (
              <div
                key={tab.id}
                className={[
                  "concurrent-cell",
                  focused ? "focused" : "",
                  errored ? "error" : "",
                  connecting ? "is-connecting" : "",
                  inSync ? "in-sync" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
                title={label}
                onMouseDown={() => onFocusSession(tab.id)}
                onContextMenuCapture={(e) => openCtxMenu(tab.id, e)}
              >
                <div className="concurrent-cell-body">
                  <TerminalView
                    sessionId={tab.id}
                    status={tab.status}
                    visible
                    focused={focused && !(filesOpen && canBrowseFiles)}
                    layoutEpoch={layoutEpoch}
                    fontSize={fontSize}
                    cursorBlink={false}
                    cursorStyle={
                      inSync || focused ? "bar" : "block"
                    }
                    cursorColor={
                      inSync || focused ? CURSOR_COLOR : CURSOR_DIM
                    }
                    onUserInput={(data) => handleUserInput(tab.id, data)}
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
                      onCwdChange
                        ? (cwd) => onCwdChange(tab.id, cwd)
                        : undefined
                    }
                  />
                </div>

                {errored && tab.errorMessage ? (
                  <div
                    className="concurrent-cell-error"
                    title={tab.errorMessage}
                  >
                    {tab.errorMessage}
                  </div>
                ) : null}

                <div className="concurrent-cell-hit">
                  <div className="concurrent-cell-chrome">
                    <button
                      type="button"
                      className={`concurrent-sync-btn${
                        inSync ? " active" : ""
                      }`}
                      title={
                        inSync
                          ? "退出并发输入（键入不再同步到此会话）"
                          : "加入并发输入"
                      }
                      aria-label={
                        inSync ? `退出并发：${label}` : `加入并发：${label}`
                      }
                      aria-pressed={inSync}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSync(tab.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {inSync ? <IconSyncOn /> : <IconSyncOff />}
                    </button>
                    <span className="concurrent-cell-title" title={label}>
                      {statusLabel(tab, label)}
                    </span>
                    {showFilesBtn ? (
                      <button
                        type="button"
                        className={`concurrent-files-btn${
                          filesOpen && focused ? " active" : ""
                        }`}
                        title="侧栏（工作区 / 远程文件 / 命令）"
                        aria-label={`侧栏：${label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onFocusSession(tab.id);
                          onFilesOpenChange(focused ? !filesOpen : true);
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        文件
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="concurrent-cell-close"
                      title="关闭此连接"
                      aria-label={`关闭 ${label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseSession(tab.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>

      {ctxMenu ? (
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
          {ctxSelection ? (
            <div className="session-ctx-menu-sep" role="separator" />
          ) : null}
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
        </div>
      ) : null}
    </div>
  );
}
