import { useMemo, useState } from "react";
import { localShellLabel } from "../settings";
import type {
  Category,
  CategoryFilter,
  ConnectionStatus,
  SavedHost,
} from "../types";
import { isLocalHost } from "../types";

interface HostListPageProps {
  hosts: SavedHost[];
  categories: Category[];
  selectedFilter: CategoryFilter;
  status: ConnectionStatus;
  errorMessage: string;
  onLogin: (host: SavedHost) => void;
  onEdit: (host: SavedHost) => void;
  onDelete: (host: SavedHost) => void;
  /** 勾选多台后并发连接（同屏格子） */
  onConcurrentConnect: (hosts: SavedHost[]) => void;
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

function filterTitle(
  filter: CategoryFilter,
  categories: Category[],
): string {
  if (filter === "all") return "全部主机";
  if (filter === "uncategorized") return "未分类";
  return categories.find((c) => c.id === filter)?.name ?? "主机";
}

export function HostListPage({
  hosts,
  categories,
  selectedFilter,
  status,
  errorMessage,
  onLogin,
  onEdit,
  onDelete,
  onConcurrentConnect,
}: HostListPageProps) {
  const busy = status === "connecting";
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

  const filteredHosts = useMemo(() => {
    if (selectedFilter === "all") return hosts;
    if (selectedFilter === "uncategorized") {
      return hosts.filter((h) => h.categoryId == null);
    }
    return hosts.filter((h) => h.categoryId === selectedFilter);
  }, [hosts, selectedFilter]);

  const selectedCount = selectedIds.size;
  const allFilteredSelected =
    filteredHosts.length > 0 &&
    filteredHosts.every((h) => selectedIds.has(h.id));

  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const h of filteredHosts) next.delete(h.id);
      } else {
        for (const h of filteredHosts) next.add(h.id);
      }
      return next;
    });
  };

  const handleConcurrent = () => {
    const picked = hosts.filter((h) => selectedIds.has(h.id));
    onConcurrentConnect(picked);
    setSelectedIds(new Set());
  };

  const title = filterTitle(selectedFilter, categories);

  return (
    <div className="host-list-page">
      <header className="host-list-header">
        <div>
          <h2 className="connect-title host-list-filter-title">{title}</h2>
          <p className="connect-subtitle">
            点击名称单独连接 · 勾选后可并发同屏 · 共 {filteredHosts.length} 条
            {selectedCount > 0 ? ` · 已选 ${selectedCount}` : ""}
          </p>
        </div>
        <div className="host-list-header-actions">
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
        </div>
      </header>

      {busy && <div className="host-list-busy">正在连接，请稍候…</div>}
      {status === "error" && errorMessage && (
        <div className="host-list-error">{errorMessage}</div>
      )}

      <div className="host-table-wrap">
        <table className="host-table">
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
                  checked={allFilteredSelected}
                  disabled={busy || filteredHosts.length === 0}
                  title="全选当前列表"
                  aria-label="全选当前列表"
                  onChange={toggleAllFiltered}
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
            {filteredHosts.length === 0 ? (
              <tr>
                <td colSpan={8} className="host-table-empty-cell">
                  {hosts.length === 0
                    ? "还没有保存的主机，可在左侧「主机」侧栏点「增加主机」。"
                    : "当前分类下没有主机。"}
                </td>
              </tr>
            ) : (
              filteredHosts.map((item, index) => {
                const local = isLocalHost(item);
                const displayName =
                  item.name?.trim() ||
                  (local ? localShellLabel(item.shell) : item.host);
                const hostCol = local
                  ? localShellLabel(item.shell)
                  : item.host;
                const checked = selectedIds.has(item.id);
                return (
                  <tr
                    key={item.id}
                    className={`${local ? "host-row-local " : ""}${
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
                    <td className="host-cell-index">{index + 1}</td>
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
                    <td className="host-cell-user" title={item.username}>
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
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
