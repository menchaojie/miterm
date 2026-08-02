import type { ConcurrentGroup, HostFolder } from "../types";
import { HOSTS_TAB_ID, hostFolderTabTitle } from "../types";
import { WindowControls } from "./WindowControls";

interface AppTabBarProps {
  folders: HostFolder[];
  groups: ConcurrentGroup[];
  activeTabId: string;
  /** 当前主机夹内会话的错误信息 */
  folderErrorMessage?: string;
  /** 当前并发组内会话的错误信息 */
  groupErrorMessage?: string;
  /** 当前是否在并发组 Tab，且可切换全选/取消 */
  syncToggle?: {
    allSynced: boolean;
    syncCount: number;
    total: number;
    onToggle: () => void;
  } | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenSettings: () => void;
}

function IconHosts() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 1h16c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V3c0-1.1.9-2 2-2zm0 8h16c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2zm0 8h16c1.1 0 2 .9 2 2v2H2v-2c0-1.1.9-2 2-2zM5 4v2h2V4H5zm0 8v2h2v-2H5zm0 8v2h2v-2H5z"
      />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54A.48.48 0 0 0 14 2h-4a.48.48 0 0 0-.48.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.49.49 0 0 0-.59.22L2.63 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.75 14.5a.49.49 0 0 0-.12.61l1.92 3.32c.13.22.39.3.59.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.25.42.48.42h4c.23 0 .43-.18.48-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.22.08.46 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"
      />
    </svg>
  );
}

/** 四格全亮：并发输入已全选 */
function IconGroupAllOn() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
    </svg>
  );
}

/** 仅一格亮、其余暗：未全选 / 点此全选 */
function IconGroupOneOn() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" opacity="0.28" d="M13 4h7v7h-7V4z" />
      <path fill="currentColor" opacity="0.28" d="M4 13h7v7H4v-7z" />
      <path fill="currentColor" opacity="0.28" d="M13 13h7v7h-7v-7z" />
      <path fill="currentColor" d="M4 4h7v7H4V4z" />
    </svg>
  );
}

/** 主机夹总数：叠层 */
function IconFolderCount() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="M2.5 11.2L8 13.8l5.5-2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 8.4L8 11l5.5-2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 5.6L8 8.2l5.5-2.6L8 3 2.5 5.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 主机夹当前二级：终端焦点 */
function IconFolderCurrent() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <rect
        x="2"
        y="3"
        width="12"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M5 7.2l1.7 1.4L5 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 10h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 非激活并发 Tab 的中性四格图标 */
function IconGroupNeutral() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        opacity="0.55"
        d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z"
      />
    </svg>
  );
}

export function AppTabBar({
  folders,
  groups,
  activeTabId,
  folderErrorMessage,
  groupErrorMessage,
  syncToggle = null,
  onSelectTab,
  onCloseTab,
  onOpenSettings,
}: AppTabBarProps) {
  const onHosts = activeTabId === HOSTS_TAB_ID;
  const banner = folderErrorMessage || groupErrorMessage || "";

  return (
    <header className="app-tabbar">
      <div className="app-tabbar-top">
        <div className="app-tabs" role="tablist" data-tauri-drag-region>
          <div
            className={`app-tab app-tab-hosts${onHosts ? " active" : ""}`}
            role="tab"
            aria-selected={onHosts}
          >
            <button
              type="button"
              className="app-tab-label app-tab-icon-btn"
              title="主机列表"
              aria-label="主机列表"
              onClick={() => onSelectTab(HOSTS_TAB_ID)}
            >
              <IconHosts />
            </button>
          </div>

          {groups.map((group) => {
            const selected = group.id === activeTabId;
            const canToggle = selected && Boolean(syncToggle);
            const allSynced = Boolean(syncToggle?.allSynced);
            return (
              <div
                key={group.id}
                className={`app-tab app-tab-group${selected ? " active" : ""}`}
                role="tab"
                aria-selected={selected}
              >
                <button
                  type="button"
                  className={`app-tab-group-icon-btn${
                    canToggle ? (allSynced ? " is-all" : " is-partial") : ""
                  }`}
                  title={
                    canToggle
                      ? allSynced
                        ? `全部取消并发输入（当前 ${syncToggle!.syncCount}/${syncToggle!.total}）`
                        : `全选并发输入（当前 ${syncToggle!.syncCount}/${syncToggle!.total}）`
                      : group.title
                  }
                  aria-label={
                    canToggle
                      ? allSynced
                        ? "全部取消并发输入"
                        : "全选并发输入"
                      : `打开 ${group.title}`
                  }
                  aria-pressed={canToggle ? allSynced : undefined}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canToggle && syncToggle) {
                      syncToggle.onToggle();
                      return;
                    }
                    onSelectTab(group.id);
                  }}
                >
                  {!selected ? (
                    <IconGroupNeutral />
                  ) : allSynced ? (
                    <IconGroupAllOn />
                  ) : (
                    <IconGroupOneOn />
                  )}
                </button>
                <button
                  type="button"
                  className="app-tab-label"
                  title={group.title}
                  onClick={() => onSelectTab(group.id)}
                >
                  {group.title}
                </button>
                <button
                  type="button"
                  className="app-tab-close"
                  title="关闭并发会话（断开全部）"
                  aria-label={`关闭 ${group.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(group.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}

          {folders.map((folder) => {
            const selected = folder.id === activeTabId;
            const count = folder.sessionIds.length;
            const activeIdx = Math.max(
              1,
              folder.sessionIds.indexOf(folder.activeSessionId) + 1,
            );
            const label = hostFolderTabTitle(
              folder.baseTitle,
              count,
              activeIdx,
            );
            return (
              <div
                key={folder.id}
                className={`app-tab app-tab-folder${selected ? " active" : ""}`}
                role="tab"
                aria-selected={selected}
              >
                <button
                  type="button"
                  className="app-tab-label"
                  title={label}
                  aria-label={label}
                  onClick={() => onSelectTab(folder.id)}
                >
                  <span className="app-tab-folder-name">{folder.baseTitle}</span>
                  <span className="app-tab-folder-stat" aria-hidden="true">
                    <IconFolderCount />
                    <span className="app-tab-folder-num">{count}</span>
                  </span>
                  <span className="app-tab-folder-dot" aria-hidden="true">
                    ·
                  </span>
                  <span className="app-tab-folder-stat is-current" aria-hidden="true">
                    <IconFolderCurrent />
                    <span className="app-tab-folder-num">{activeIdx}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="app-tab-close"
                  title="关闭主机夹（断开全部连接）"
                  aria-label={`关闭 ${label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(folder.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          className="app-settings-btn"
          title="设置"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <IconSettings />
        </button>
        <WindowControls />
      </div>
      {banner ? <div className="app-tab-error">{banner}</div> : null}
    </header>
  );
}
