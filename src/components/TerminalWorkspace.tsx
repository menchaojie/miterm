import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { TerminalView } from "./TerminalView";
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { FolderLayout, SessionTab, SplitDirection } from "../types";
import { guessUnixHome } from "../cwd";
import {
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
}

type CtxMenu = {
  x: number;
  y: number;
  sessionId: string;
};

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
 * 主机夹工作区：同机多会话；支持左右/上下分屏与右键菜单。
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
}: TerminalWorkspaceProps) {
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
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

  const openCtxMenu = (sessionId: string, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSelectSession(sessionId);
    setCtxMenu({ x: e.clientX, y: e.clientY, sessionId });
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
      return (
        <div
          key={tab.id}
          className={`split-leaf${focused ? " is-focused" : ""}`}
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
                const name = `连接 ${index + 1}`;
                return (
                  <div
                    key={tab.id}
                    className={`solo-subtab${selected ? " active" : ""}${
                      tab.status === "error" ? " error" : ""
                    }${tab.status === "connecting" ? " connecting" : ""}${
                      splitMode && !inLayout ? " dimmed" : ""
                    }`}
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
          className="session-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSplitSession(ctxMenu.sessionId, "vertical");
              setCtxMenu(null);
            }}
          >
            垂直分割（左右）
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSplitSession(ctxMenu.sessionId, "horizontal");
              setCtxMenu(null);
            }}
          >
            水平分割（上下）
          </button>
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
