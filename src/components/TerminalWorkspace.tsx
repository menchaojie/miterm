import { useMemo, useState } from "react";
import { TerminalView } from "./TerminalView";
import { RemoteFilePanel } from "./RemoteFilePanel";
import type { SessionTab } from "../types";
import { guessUnixHome } from "../cwd";

interface TerminalWorkspaceProps {
  sessions: SessionTab[];
  /** 二级会话顺序 */
  sessionIds: string[];
  activeSessionId: string;
  /** 工作区是否在前台（回主机列表 / 切走一级 Tab 时应为 false） */
  workspaceActive?: boolean;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** 同主机再开一条连接 */
  onAddSession: () => void;
  onReconnectSession?: (sessionId: string) => void;
  onCwdChange?: (sessionId: string, cwd: string | null) => void;
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

/**
 * 主机夹工作区：同机多会话层稳定挂载；悬停顶部显示二级 Tab + 加号。
 */
export function TerminalWorkspace({
  sessions,
  sessionIds,
  activeSessionId,
  workspaceActive = true,
  onSelectSession,
  onCloseSession,
  onAddSession,
  onReconnectSession,
  onCwdChange,
}: TerminalWorkspaceProps) {
  const [filesOpen, setFilesOpen] = useState(false);

  const ordered = sessionIds
    .map((id) => sessions.find((s) => s.id === id))
    .filter((t): t is SessionTab => Boolean(t));

  const activeTab = useMemo(
    () => ordered.find((t) => t.id === activeSessionId) ?? ordered[0],
    [ordered, activeSessionId],
  );

  const canBrowseFiles =
    Boolean(activeTab) &&
    activeTab?.kind !== "local" &&
    activeTab?.status === "connected";

  const filesInitialPath =
    activeTab?.cwd ||
    (activeTab ? guessUnixHome(activeTab.username) : "/");

  return (
    <div className="terminal-workspace">
      <div className="terminal-workspace-main">
        {workspaceActive && filesOpen && activeTab && canBrowseFiles ? (
          <RemoteFilePanel
            key={activeTab.id}
            sessionId={activeTab.id}
            initialPath={filesInitialPath}
            connected={activeTab.status === "connected"}
            onClose={() => setFilesOpen(false)}
          />
        ) : null}

        <div className="terminal-workspace-stages">
          {ordered.map((tab) => {
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
              >
                <div className="terminal-layer-body">
                  <TerminalView
                    sessionId={tab.id}
                    status={tab.status}
                    visible={visible}
                    focused={visible && !filesOpen}
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
                const name = `连接 ${index + 1}`;
                return (
                  <div
                    key={tab.id}
                    className={`solo-subtab${selected ? " active" : ""}${
                      tab.status === "error" ? " error" : ""
                    }${tab.status === "connecting" ? " connecting" : ""}`}
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
                title="远程文件 (SFTP)"
                aria-label="远程文件"
                aria-pressed={filesOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setFilesOpen((v) => !v);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                文件
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
