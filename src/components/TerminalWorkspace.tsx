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
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { ConcurrentSyncControl } from "./ConcurrentWorkspace";
import type { FolderLayout, SessionTab, SplitDirection } from "../types";
import { guessUnixHome } from "../cwd";
import {
  collectLayoutSessionIds,
  countLayoutLeaves,
  ensureFolderLayout,
  layoutContainsSession,
} from "../splitLayout";

interface TerminalWorkspaceProps {
  sessions: SessionTab[];
  /** 二级会话顺序 */
  sessionIds: string[];
  activeSessionId: string;
  layout?: FolderLayout;
  /** 工作区是否在前台（回主机列表 / 切走一级 Tab 时应为 false） */
  workspaceActive?: boolean;
  /** 远程文件侧栏（由 App 控制，便于全局快捷键） */
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** 同主机再开一条连接（Tab 模式 / 兼容） */
  onAddSession: () => void;
  /** 右键分屏：在指定会话窗格上拆出同机新连接 */
  onSplitSession: (sessionId: string, direction: SplitDirection) => void;
  /** 拖动分割条改比例 */
  onSplitRatioChange: (splitId: string, ratio: number) => void;
  onReconnectSession?: (sessionId: string) => void;
  onCwdChange?: (sessionId: string, cwd: string | null) => void;
  /** 分屏并发输入：向 Tab 栏上报全选/取消（离开或非分屏时传 null） */
  onSyncControlChange?: (control: ConcurrentSyncControl | null) => void;
}

type CtxMenu = {
  x: number;
  y: number;
  sessionId: string;
};

const CTX_MENU_PAD = 8;

/** 将菜单锚定点限制在视口内，避免贴底/贴边被裁切 */
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
    // 优先翻到光标上方
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

/** 垂直分割示意：左右两格 */
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
      <rect x="3" y="4.2" width="3.6" height="7.6" rx="0.6" fill="currentColor" opacity="0.22" />
      <rect x="9.4" y="4.2" width="3.6" height="7.6" rx="0.6" fill="currentColor" opacity="0.38" />
    </svg>
  );
}

/** 水平分割示意：上下两格 */
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
      <rect x="3.2" y="3.4" width="9.6" height="3.2" rx="0.6" fill="currentColor" opacity="0.22" />
      <rect x="3.2" y="9.4" width="9.6" height="3.2" rx="0.6" fill="currentColor" opacity="0.38" />
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
 * 主机夹工作区：同机多会话；支持左右/上下分屏、分屏并发输入与右键菜单。
 */
export function TerminalWorkspace({
  sessions,
  sessionIds,
  activeSessionId,
  layout: layoutProp,
  workspaceActive = true,
  filesOpen,
  onFilesOpenChange,
  onSelectSession,
  onCloseSession,
  onAddSession,
  onSplitSession,
  onSplitRatioChange,
  onReconnectSession,
  onCwdChange,
  onSyncControlChange,
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

  const ordered = sessionIds
    .map((id) => byId(id))
    .filter((t): t is SessionTab => Boolean(t));

  const activeTab = useMemo(
    () => ordered.find((t) => t.id === activeSessionId) ?? ordered[0],
    [ordered, activeSessionId],
  );

  const layout = useMemo(
    () => ensureFolderLayout(layoutProp, activeSessionId),
    [layoutProp, activeSessionId],
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

  const syncCount = useMemo(
    () => layoutIds.filter((id) => syncIds.has(id)).length,
    [layoutIds, syncIds],
  );
  const allSynced =
    splitMode && layoutIds.length > 0 && syncCount === layoutIds.length;

  // 分屏叶子变化时：新窗格默认加入并发；离开布局的移除
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

  const canBrowseFiles =
    Boolean(activeTab) &&
    activeTab?.kind !== "local" &&
    activeTab?.status === "connected";

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

  // 菜单渲染后按实际尺寸贴边翻转，避免最底窗格被裁切
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
    // 先按估算高度上翻，减少首帧闪到窗外（含示意图菜单项）
    const estH = 180;
    const estW = 200;
    const pos = clampCtxMenuPos(e.clientX, e.clientY, estW, estH);
    setCtxMenu({ x: pos.x, y: pos.y, sessionId });
  };

  const bumpLayout = useCallback(() => {
    setLayoutEpoch((n) => n + 1);
  }, []);

  const renderLayout = (node: FolderLayout): ReactNode => {
    if (node.type === "leaf") {
      const tab = byId(node.sessionId);
      if (!tab) return null;
      const focused = tab.id === activeSessionId;
      const visible = workspaceActive;
      const inSync = syncIds.has(tab.id);
      return (
        <div
          key={tab.id}
          className={`split-leaf${focused ? " is-focused" : ""}${
            inSync ? " in-sync" : ""
          }`}
          onMouseDown={() => onSelectSession(tab.id)}
          onContextMenuCapture={(e) => openCtxMenu(tab.id, e)}
        >
          <div className="split-leaf-body">
            <TerminalView
              sessionId={tab.id}
              status={tab.status}
              visible={visible}
              focused={visible && focused && !filesOpen}
              layoutEpoch={layoutEpoch}
              cursorBlink={false}
              cursorStyle={inSync || focused ? "bar" : "block"}
              cursorColor={inSync || focused ? CURSOR_COLOR : CURSOR_DIM}
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
          {renderLayout(node.first)}
        </div>
        <SplitSash
          direction={node.direction}
          ratio={node.ratio}
          onRatioChange={(next) => {
            onSplitRatioChange(node.id, next);
            bumpLayout();
          }}
        />
        <div className="split-branch-child" style={secondStyle}>
          {renderLayout(node.second)}
        </div>
      </div>
    );
  };

  const ctxTab = ctxMenu ? byId(ctxMenu.sessionId) : null;
  const canSplitCtx = ctxTab?.status === "connected";
  const ctxInSync = ctxMenu ? syncIds.has(ctxMenu.sessionId) : false;
  const ctxInLayout = ctxMenu
    ? layoutContainsSession(layout, ctxMenu.sessionId)
    : false;

  return (
    <div className="terminal-workspace">
      <div className="terminal-workspace-main">
        {workspaceActive && filesOpen && activeTab && canBrowseFiles ? (
          <RemoteFilePanel
            key={activeTab.id}
            sessionId={activeTab.id}
            initialPath={filesInitialPath}
            terminalCwd={activeTab.cwd ?? null}
            connected={activeTab.status === "connected"}
            onClose={() => onFilesOpenChange(false)}
          />
        ) : null}

        <div
          className={`terminal-workspace-stages${splitMode ? " split-root" : ""}`}
        >
          {splitMode
            ? renderLayout(layout)
            : ordered.map((tab) => {
                const visible = workspaceActive && tab.id === activeSessionId;
                return (
                  <div
                    key={tab.id}
                    className={`terminal-layer${visible ? " is-visible" : ""}${
                      visible ? " is-focused" : ""
                    }`}
                    onMouseDown={() => {
                      if (visible) onSelectSession(tab.id);
                    }}
                    onContextMenuCapture={(e) => {
                      if (visible) openCtxMenu(tab.id, e);
                    }}
                  >
                    <div className="terminal-layer-body">
                      <TerminalView
                        sessionId={tab.id}
                        status={tab.status}
                        visible={visible}
                        focused={visible && !filesOpen}
                        layoutEpoch={layoutEpoch}
                        systemNotice={tab.systemNotice}
                        homeHint={
                          tab.kind === "local"
                            ? null
                            : guessUnixHome(tab.username)
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
                  </div>
                );
              })}
        </div>
      </div>

      {workspaceActive ? (
        <div className="solo-subtab-hit">
          <div className="solo-subtab-chrome">
            <div className="solo-subtabs" role="tablist" aria-label="同机会话">
              {ordered.map((tab, index) => {
                const selected = tab.id === activeSessionId;
                const inLayout = layoutContainsSession(layout, tab.id);
                const inSync = splitMode && syncIds.has(tab.id);
                const name = `连接 ${index + 1}`;
                return (
                  <div
                    key={tab.id}
                    className={`solo-subtab${selected ? " active" : ""}${
                      tab.status === "error" ? " error" : ""
                    }${tab.status === "connecting" ? " connecting" : ""}${
                      splitMode && !inLayout ? " dimmed" : ""
                    }${inSync ? " in-sync" : ""}`}
                  >
                    <button
                      type="button"
                      className="solo-subtab-label"
                      role="tab"
                      aria-selected={selected}
                      title={
                        inSync
                          ? `${name}（已加入并发）`
                          : splitMode && inLayout
                            ? `${name}（未加入并发）`
                            : name
                      }
                      aria-label={name}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectSession(tab.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <IconSession />
                      <span className="solo-subtab-num">{index + 1}</span>
                    </button>
                    <button
                      type="button"
                      className="solo-subtab-close"
                      title="关闭此连接"
                      aria-label={`关闭 ${name}`}
                      disabled={tab.status === "disconnecting"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseSession(tab.id);
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
                title="再开一条同机连接"
                aria-label="再开一条同机连接"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddSession();
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                +
              </button>
            </div>
            {canBrowseFiles ? (
              <button
                type="button"
                className={`solo-subtab-files${filesOpen ? " active" : ""}`}
                title="远程文件 (SFTP) · Ctrl+Shift+E"
                aria-label="远程文件"
                aria-pressed={filesOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  onFilesOpenChange(!filesOpen);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                文件
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {ctxMenu && canSplitCtx ? (
        <div
          ref={ctxMenuRef}
          className="session-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
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
          {splitMode && ctxInLayout ? (
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
          ) : null}
          {splitMode || ordered.length > 1 ? (
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
