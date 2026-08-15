import { Fragment, useMemo, useState } from "react";
import {
  buildCategoryGroups,
  isGroupCollapsed,
  loadCollapsedGroupKeys,
  saveCollapsedGroupKeys,
  toggleCollapsedGroupKey,
  type CategoryGroupKey,
} from "../categoryTree";
import { localShellLabel } from "../settings";
import type {
  Category,
  CategoryFilter,
  ConnectionStatus,
  SavedHost,
} from "../types";
import { isLocalHost } from "../types";

const COLLAPSE_KEY = "miterm.hostCategoryCollapse.v1";

interface HostListPageProps {
  hosts: SavedHost[];
  categories: Category[];
  selectedFilter: CategoryFilter;
  status: ConnectionStatus;
  errorMessage: string;
  onSelectFilter: (filter: CategoryFilter) => void;
  onAddCategory: () => void;
  onRenameCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onAdd: () => void;
  onLogin: (host: SavedHost) => void;
  onEdit: (host: SavedHost) => void;
  onDelete: (host: SavedHost) => void;
  /** 勾选多台后并发连接（同屏格子） */
  onConcurrentConnect: (hosts: SavedHost[]) => void;
  /** 主机列表侧栏（工作区）是否打开 */
  sidebarOpen?: boolean;
  /** 开关侧栏（默认显示工作区 Tab） */
  onToggleSidebar?: () => void;
}

function formatTime(unixSec: number): string {
  if (!unixSec) return "—";
  try {
    return new Date(unixSec * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function IconEdit() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
      />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54A.48.48 0 0 0 14 2h-4a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.64 8.47a.48.48 0 0 0 .12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.76 14.52a.49.49 0 0 0-.12.61l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h4c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  );
}

function IconDelete() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
      />
    </svg>
  );
}

function IconChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`cat-tree-chevron${collapsed ? " is-collapsed" : ""}`}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M9 6l6 6-6 6" />
    </svg>
  );
}

function filterFromGroupKey(key: CategoryGroupKey): CategoryFilter {
  return key === "uncategorized" ? "uncategorized" : key;
}

export function HostListPage({
  hosts,
  categories,
  selectedFilter,
  status,
  errorMessage,
  onSelectFilter,
  onAddCategory,
  onRenameCategory,
  onDeleteCategory,
  onAdd,
  onLogin,
  onEdit,
  onDelete,
  onConcurrentConnect,
  sidebarOpen = false,
  onToggleSidebar,
}: HostListPageProps) {
  const busy = status === "connecting";
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [collapsed, setCollapsed] = useState(() =>
    loadCollapsedGroupKeys(COLLAPSE_KEY),
  );

  const groups = useMemo(
    () => buildCategoryGroups(categories, hosts, (h) => h.categoryId),
    [categories, hosts],
  );

  const visibleHosts = useMemo(() => {
    const list: SavedHost[] = [];
    for (const g of groups) {
      if (isGroupCollapsed(collapsed, g.key)) continue;
      list.push(...g.items);
    }
    return list;
  }, [groups, collapsed]);

  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    visibleHosts.length > 0 &&
    visibleHosts.every((h) => selectedIds.has(h.id));

  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const h of visibleHosts) next.delete(h.id);
      } else {
        for (const h of visibleHosts) next.add(h.id);
      }
      return next;
    });
  };

  const toggleGroupItems = (items: SavedHost[]) => {
    if (items.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allOn = items.every((h) => next.has(h.id));
      if (allOn) {
        for (const h of items) next.delete(h.id);
      } else {
        for (const h of items) next.add(h.id);
      }
      return next;
    });
  };

  const toggleGroupCollapsed = (key: CategoryGroupKey) => {
    setCollapsed((prev) => {
      const next = toggleCollapsedGroupKey(prev, key);
      saveCollapsedGroupKeys(COLLAPSE_KEY, next);
      return next;
    });
  };

  const handleConcurrent = () => {
    const picked = hosts.filter((h) => selectedIds.has(h.id));
    onConcurrentConnect(picked);
    setSelectedIds(new Set());
  };

  let rowIndex = 0;

  return (
    <div className="host-list-page">
      <header className="host-list-header">
        <div>
          <p className="connect-subtitle">
            点击名称单独连接 · 勾选后可并发同屏 · 共 {hosts.length} 条
            {selectedCount > 0 ? ` · 已选 ${selectedCount}` : ""}
          </p>
        </div>
        <div className="host-list-header-actions">
          {onToggleSidebar ? (
            <button
              type="button"
              className={`btn-secondary${sidebarOpen ? " is-active" : ""}`}
              disabled={busy}
              title="打开/关闭工作区侧栏（收藏会话）· Ctrl+Shift+E"
              aria-pressed={sidebarOpen}
              onClick={onToggleSidebar}
            >
              收藏会话
            </button>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || selectedCount < 2}
            title={
              selectedCount < 2
                ? "请至少勾选 2 台主机"
                : `同时连接已选 ${selectedCount} 台`
            }
            onClick={handleConcurrent}
          >
            并发会话{selectedCount >= 2 ? ` (${selectedCount})` : ""}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={onAddCategory}
          >
            新建分类
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={onAdd}
          >
            增加主机
          </button>
        </div>
      </header>

      {busy && <div className="host-list-busy">正在连接，请稍候…</div>}
      {status === "error" && errorMessage && (
        <div className="host-list-error">{errorMessage}</div>
      )}

      <div className="host-table-wrap">
        <table className="host-table host-table-tree">
          <colgroup>
            <col className="host-col-check" />
            <col className="host-col-index" />
            <col className="host-col-name" />
            <col className="host-col-host" />
            <col className="host-col-port" />
            <col className="host-col-user" />
            <col className="host-col-time" />
            <col className="host-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th className="host-table-check-col">
                <input
                  type="checkbox"
                  className="host-row-check"
                  checked={allVisibleSelected}
                  disabled={busy || visibleHosts.length === 0}
                  title="全选已展开分组中的主机"
                  aria-label="全选已展开分组中的主机"
                  onChange={toggleAllVisible}
                />
              </th>
              <th className="host-table-index-col">#</th>
              <th>名称</th>
              <th>主机</th>
              <th>端口</th>
              <th>用户</th>
              <th>最近使用</th>
              <th className="host-table-actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            {hosts.length === 0 && categories.length === 0 ? (
              <tr>
                <td colSpan={8} className="host-table-empty-cell">
                  还没有保存的主机，可点右上角「增加主机」（远程 SSH 或本地终端）。
                </td>
              </tr>
            ) : (
              groups.map((group) => {
                const collapsedGroup = isGroupCollapsed(collapsed, group.key);
                const groupAllSelected =
                  group.items.length > 0 &&
                  group.items.every((h) => selectedIds.has(h.id));
                const isActive =
                  selectedFilter === filterFromGroupKey(group.key);

                return (
                  <Fragment key={String(group.key)}>
                    <tr
                      className={`host-tree-group-row${isActive ? " is-active" : ""}`}
                    >
                      <td className="host-cell-check">
                        <input
                          type="checkbox"
                          className="host-row-check"
                          checked={groupAllSelected}
                          disabled={busy || group.items.length === 0}
                          title="全选本组"
                          aria-label={`全选 ${group.label}`}
                          onChange={() => toggleGroupItems(group.items)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td colSpan={7}>
                        <div className="host-tree-group-bar">
                          <button
                            type="button"
                            className="host-tree-group-toggle"
                            disabled={busy}
                            aria-expanded={!collapsedGroup}
                            title={collapsedGroup ? "展开" : "折叠"}
                            onClick={() => toggleGroupCollapsed(group.key)}
                          >
                            <IconChevron collapsed={collapsedGroup} />
                          </button>
                          <button
                            type="button"
                            className="host-tree-group-title"
                            disabled={busy}
                            title="设为新建主机的默认分类"
                            onClick={() =>
                              onSelectFilter(filterFromGroupKey(group.key))
                            }
                          >
                            <span className="host-tree-group-label">
                              {group.label}
                            </span>
                            <span className="host-tree-group-count">
                              {group.items.length}
                            </span>
                          </button>
                          {group.category ? (
                            <div className="host-tree-group-actions">
                              <button
                                type="button"
                                className="btn-secondary host-tree-group-btn"
                                disabled={busy}
                                title="重命名分类"
                                onClick={() => {
                                  onSelectFilter(group.category!.id);
                                  onRenameCategory(group.category!);
                                }}
                              >
                                重命名
                              </button>
                              <button
                                type="button"
                                className="btn-danger-text host-tree-group-btn"
                                disabled={busy}
                                title="删除分类"
                                onClick={() => {
                                  onSelectFilter(group.category!.id);
                                  onDeleteCategory(group.category!);
                                }}
                              >
                                删除
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {!collapsedGroup
                      ? group.items.map((item) => {
                          rowIndex += 1;
                          const local = isLocalHost(item);
                          const displayName =
                            item.name?.trim() ||
                            (local
                              ? localShellLabel(item.shell)
                              : item.host);
                          const hostCol = local
                            ? localShellLabel(item.shell)
                            : item.host;
                          const checked = selectedIds.has(item.id);
                          return (
                            <tr
                              key={item.id}
                              className={`host-tree-item-row ${local ? "host-row-local " : ""}${
                                checked ? "host-row-selected" : ""
                              }`.trim()}
                            >
                              <td className="host-cell-check">
                                <input
                                  type="checkbox"
                                  className="host-row-check"
                                  checked={checked}
                                  disabled={busy}
                                  aria-label={`选择 ${displayName}`}
                                  onChange={() => toggleOne(item.id)}
                                />
                              </td>
                              <td className="host-cell-index">{rowIndex}</td>
                              <td className="host-cell-name">
                                <button
                                  type="button"
                                  className={`host-name-link${local ? " host-local-link" : ""}`}
                                  disabled={busy}
                                  title={
                                    local
                                      ? `打开 ${displayName}`
                                      : `登录 ${displayName}`
                                  }
                                  onClick={() => onLogin(item)}
                                >
                                  {displayName}
                                </button>
                                {local ? (
                                  <span className="host-local-hint">本机</span>
                                ) : null}
                              </td>
                              <td className="host-cell-host" title={hostCol}>
                                {hostCol}
                              </td>
                              <td className="host-cell-port">
                                {local ? "—" : item.port}
                              </td>
                              <td
                                className="host-cell-user"
                                title={item.username}
                              >
                                {local ? "—" : item.username || "—"}
                              </td>
                              <td className="host-cell-time">
                                {formatTime(item.lastUsedAt)}
                              </td>
                              <td className="host-cell-actions">
                                <div className="host-row-actions">
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn-edit"
                                    disabled={busy}
                                    title={local ? "设置" : "编辑"}
                                    aria-label={
                                      local
                                        ? `设置 ${displayName}`
                                        : `编辑 ${displayName}`
                                    }
                                    onClick={() => onEdit(item)}
                                  >
                                    {local ? <IconSettings /> : <IconEdit />}
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn-delete"
                                    disabled={busy}
                                    title="删除"
                                    aria-label={`删除 ${displayName}`}
                                    onClick={() => onDelete(item)}
                                  >
                                    <IconDelete />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      : null}
                    {!collapsedGroup && group.items.length === 0 ? (
                      <tr className="host-tree-empty-row">
                        <td colSpan={8} className="host-tree-empty-cell">
                          此分类下暂无主机
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
