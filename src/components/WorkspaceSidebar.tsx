import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Category, CategoryFilter, SavedHost } from "../types";
import {
  buildCategoryGroups,
  isGroupCollapsed,
  loadCollapsedGroupKeys,
  saveCollapsedGroupKeys,
  toggleCollapsedGroupKey,
  type CategoryGroupKey,
} from "../categoryTree";
import {
  createWorkspaceCategory,
  deleteWorkspaceCategory,
  listWorkspaceCategories,
  updateWorkspaceCategory,
} from "../domainCategories";
import {
  deleteWorkspaceRow,
  layoutPaneCount,
  listWorkspaces,
  parseWorkspacePayload,
  updateWorkspaceRow,
  workspaceSummaryLabel,
  type SavedWorkspaceRow,
  type WorkspacePayload,
} from "../workspace";
import {
  IconFolder,
  IconRename,
  IconTrash,
  IconTreeChevron,
} from "./CatTreeIcons";
import { HostsNavPanel } from "./HostsNavPanel";
import { RemoteFilePanel } from "./RemoteFilePanel";
import { SavedCommandsPanel } from "./SavedCommandsPanel";

export type SidebarPane = "hosts" | "workspaces" | "files" | "commands";

const WIDTH_KEY = "miterm.sidebarWidth";
const LEGACY_WIDTH_KEY = "miterm.remoteFilePanelWidth";
const PANE_KEY = "miterm.sidebarPane";
const WS_COLLAPSE_KEY = "miterm.workspaceCategoryCollapse.v1";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 220;
const MAX_WIDTH = 720;

function loadSidebarWidth(): number {
  try {
    let raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null) raw = localStorage.getItem(LEGACY_WIDTH_KEY);
    const n = raw != null ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveSidebarWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

function loadSidebarPane(
  allowed: SidebarPane[],
  defaultPane: SidebarPane,
): SidebarPane {
  try {
    const v = localStorage.getItem(PANE_KEY);
    if (
      v === "hosts" ||
      v === "files" ||
      v === "workspaces" ||
      v === "commands"
    ) {
      if (allowed.includes(v)) return v;
    }
  } catch {
    /* ignore */
  }
  return defaultPane;
}

function saveSidebarPane(pane: SidebarPane) {
  try {
    localStorage.setItem(PANE_KEY, pane);
  } catch {
    /* ignore */
  }
}

export interface WorkspaceSidebarProps {
  onClose: () => void;
  /** 主页侧栏不可关闭时为 false */
  closable?: boolean;
  /** 是否允许「主机」导航 Tab（主页） */
  hostsAvailable?: boolean;
  hosts?: SavedHost[];
  hostCategories?: Category[];
  hostFilter?: CategoryFilter;
  onHostFilter?: (filter: CategoryFilter) => void;
  onAddHost?: () => void;
  onAddHostCategory?: () => void;
  onRenameHostCategory?: (category: Category) => void;
  onDeleteHostCategory?: (category: Category) => void;
  /** 是否允许远程文件 Tab */
  filesAvailable: boolean;
  filesSessionId?: string | null;
  filesInitialPath?: string;
  filesTerminalCwd?: string | null;
  filesConnected?: boolean;
  /** 当前是否有可保存的会话工作区 */
  canSaveCurrent: boolean;
  saveDisabledReason?: string;
  /** 保存当前工作区；categoryId 为归属分类 */
  onSaveCurrent: (categoryId: number | null) => void;
  onOpenWorkspace: (row: SavedWorkspaceRow, payload: WorkspacePayload) => void;
  /** 列表刷新令牌（保存后递增） */
  refreshToken?: number;
  /** 是否可向当前终端填入/运行命令 */
  canInjectCommand?: boolean;
  injectCommandDisabledReason?: string;
  onInjectCommand?: (body: string, opts: { run: boolean }) => void;
}

export function WorkspaceSidebar({
  onClose,
  closable = true,
  hostsAvailable = false,
  hosts = [],
  hostCategories = [],
  hostFilter = "all",
  onHostFilter,
  onAddHost,
  onAddHostCategory,
  onRenameHostCategory,
  onDeleteHostCategory,
  filesAvailable,
  filesSessionId = null,
  filesInitialPath = "/",
  filesTerminalCwd = null,
  filesConnected = false,
  canSaveCurrent,
  saveDisabledReason,
  onSaveCurrent,
  onOpenWorkspace,
  refreshToken = 0,
  canInjectCommand = false,
  injectCommandDisabledReason,
  onInjectCommand,
}: WorkspaceSidebarProps) {
  const allowedPanes = useMemo((): SidebarPane[] => {
    const list: SidebarPane[] = [];
    if (hostsAvailable) list.push("hosts");
    list.push("workspaces");
    if (filesAvailable) list.push("files");
    list.push("commands");
    return list;
  }, [hostsAvailable, filesAvailable]);

  const defaultPane: SidebarPane = hostsAvailable
    ? "hosts"
    : filesAvailable
      ? "files"
      : "workspaces";

  const [pane, setPane] = useState<SidebarPane>(() =>
    loadSidebarPane(allowedPanes, defaultPane),
  );
  const [panelWidth, setPanelWidth] = useState(loadSidebarWidth);
  const [rows, setRows] = useState<SavedWorkspaceRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [saveCategoryId, setSaveCategoryId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(() =>
    loadCollapsedGroupKeys(WS_COLLAPSE_KEY),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const effectivePane: SidebarPane = allowedPanes.includes(pane)
    ? pane
    : defaultPane;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextRows, nextCats] = await Promise.all([
        listWorkspaces(),
        listWorkspaceCategories(),
      ]);
      setRows(nextRows);
      setCategories(nextCats);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    if (!allowedPanes.includes(pane)) {
      setPane(defaultPane);
      saveSidebarPane(defaultPane);
    }
  }, [allowedPanes, pane, defaultPane]);

  const selectPane = (next: SidebarPane) => {
    if (!allowedPanes.includes(next)) return;
    setPane(next);
    saveSidebarPane(next);
  };

  const toggleGroupCollapsed = (key: CategoryGroupKey) => {
    setCollapsed((prev) => {
      const next = toggleCollapsedGroupKey(prev, key);
      saveCollapsedGroupKeys(WS_COLLAPSE_KEY, next);
      return next;
    });
  };

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: panelWidth };
    document.body.classList.add("remote-file-resizing");
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, dragRef.current.startW + dx),
    );
    setPanelWidth(next);
  };

  const onResizePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = null;
    document.body.classList.remove("remote-file-resizing");
    saveSidebarWidth(panelWidth);
  };

  const groups = useMemo(
    () => buildCategoryGroups(categories, rows, (r) => r.categoryId),
    [categories, rows],
  );

  const addCategory = async () => {
    const name = window.prompt("工作区分类名称");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("分类名称不能为空");
      return;
    }
    try {
      const cat = await createWorkspaceCategory(trimmed);
      await refresh();
      setSaveCategoryId(cat.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const renameCategory = async (cat: Category) => {
    const name = window.prompt("重命名工作区分类", cat.name);
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("分类名称不能为空");
      return;
    }
    try {
      await updateWorkspaceCategory(cat.id, trimmed);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeCategory = async (cat: Category) => {
    if (
      !window.confirm(
        `删除工作区分类「${cat.name}」？该分类下的工作区将变为未分类。`,
      )
    ) {
      return;
    }
    try {
      await deleteWorkspaceCategory(cat.id);
      if (saveCategoryId === cat.id) setSaveCategoryId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const changeCategory = async (
    row: SavedWorkspaceRow,
    categoryId: number | null,
  ) => {
    try {
      await updateWorkspaceRow({
        id: row.id,
        name: row.name,
        kind: row.kind,
        payload: row.payload,
        categoryId,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <aside
      className="workspace-sidebar"
      aria-label="侧栏"
      style={{ width: panelWidth }}
    >
      <div className="workspace-sidebar-header">
        <div className="workspace-sidebar-tabs" role="tablist">
          {hostsAvailable ? (
            <button
              type="button"
              role="tab"
              aria-selected={effectivePane === "hosts"}
              className={`workspace-sidebar-tab${
                effectivePane === "hosts" ? " active" : ""
              }`}
              onClick={() => selectPane("hosts")}
            >
              主机
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={effectivePane === "workspaces"}
            className={`workspace-sidebar-tab${
              effectivePane === "workspaces" ? " active" : ""
            }`}
            onClick={() => selectPane("workspaces")}
          >
            工作区
          </button>
          {filesAvailable ? (
            <button
              type="button"
              role="tab"
              aria-selected={effectivePane === "files"}
              className={`workspace-sidebar-tab${
                effectivePane === "files" ? " active" : ""
              }`}
              title="远程文件"
              onClick={() => selectPane("files")}
            >
              远程文件
            </button>
          ) : null}
          <button
            type="button"
            role="tab"
            aria-selected={effectivePane === "commands"}
            className={`workspace-sidebar-tab${
              effectivePane === "commands" ? " active" : ""
            }`}
            title="常用命令：填入或运行到当前终端"
            onClick={() => selectPane("commands")}
          >
            命令
          </button>
        </div>
        {closable ? (
          <button
            type="button"
            className="remote-file-close"
            title="关闭侧栏"
            aria-label="关闭侧栏"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>

      {effectivePane === "hosts" && hostsAvailable ? (
        <HostsNavPanel
          hosts={hosts}
          categories={hostCategories}
          selectedFilter={hostFilter}
          onSelectFilter={(f) => onHostFilter?.(f)}
          onAddCategory={() => onAddHostCategory?.()}
          onRenameCategory={(c) => onRenameHostCategory?.(c)}
          onDeleteCategory={(c) => onDeleteHostCategory?.(c)}
          onAddHost={() => onAddHost?.()}
        />
      ) : effectivePane === "workspaces" ? (
        <div className="workspace-list-pane">
          <div className="workspace-list-toolbar">
            <button
              type="button"
              className="btn-primary workspace-save-btn"
              disabled={!canSaveCurrent}
              title={
                canSaveCurrent
                  ? "将当前主机夹或并发组合保存为工作区"
                  : saveDisabledReason || "当前无可保存的会话"
              }
              onClick={() => onSaveCurrent(saveCategoryId)}
            >
              保存当前
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={loading}
              onClick={() => void refresh()}
            >
              刷新
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void addCategory()}
            >
              新建分类
            </button>
          </div>
          <label className="workspace-category-field">
            <span>保存到</span>
            <select
              value={saveCategoryId == null ? "" : String(saveCategoryId)}
              onChange={(e) => {
                const v = e.target.value;
                setSaveCategoryId(v === "" ? null : Number(v));
              }}
              aria-label="保存工作区时的分类"
              title="「保存当前」使用的分类"
            >
              <option value="">未分类</option>
              {categories.map((cat) => (
                <option key={cat.id} value={String(cat.id)}>
                  {cat.name}
                </option>
              ))}
            </select>
          </label>
          {error ? <div className="workspace-list-error">{error}</div> : null}
          {loading && rows.length === 0 ? (
            <div className="workspace-list-empty">加载中…</div>
          ) : rows.length === 0 && categories.length === 0 ? (
            <div className="workspace-list-empty">
              尚无保存的工作区。打开会话后可点「保存当前」。
            </div>
          ) : (
            <ul className="cat-tree-list">
              {groups.map((group) => {
                const collapsedGroup = isGroupCollapsed(collapsed, group.key);
                const isActive =
                  (group.key === "uncategorized" && saveCategoryId == null) ||
                  (typeof group.key === "number" &&
                    saveCategoryId === group.key);
                return (
                  <li key={String(group.key)} className="cat-tree-group">
                    <div
                      className={`cat-tree-group-header${isActive ? " is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="cat-tree-group-toggle"
                        aria-expanded={!collapsedGroup}
                        title={collapsedGroup ? "展开" : "折叠"}
                        onClick={() => toggleGroupCollapsed(group.key)}
                      >
                        <IconTreeChevron collapsed={collapsedGroup} />
                      </button>
                      <button
                        type="button"
                        className="cat-tree-group-title"
                        title="设为「保存当前」的分类"
                        onClick={() =>
                          setSaveCategoryId(
                            group.key === "uncategorized" ? null : group.key,
                          )
                        }
                      >
                        <IconFolder open={!collapsedGroup} />
                        <span className="cat-tree-group-label">
                          {group.label}
                        </span>
                        <span className="cat-tree-group-count">
                          {group.items.length}
                        </span>
                      </button>
                      {group.category ? (
                        <div className="cat-tree-group-actions">
                          <button
                            type="button"
                            className="cat-tree-group-btn"
                            title="重命名"
                            aria-label={`重命名分类 ${group.label}`}
                            onClick={() => void renameCategory(group.category!)}
                          >
                            <IconRename />
                          </button>
                          <button
                            type="button"
                            className="cat-tree-group-btn is-danger"
                            title="删除分类"
                            aria-label={`删除分类 ${group.label}`}
                            onClick={() => void removeCategory(group.category!)}
                          >
                            <IconTrash />
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {!collapsedGroup ? (
                      <ul className="cat-tree-children">
                        {group.items.length === 0 ? (
                          <li className="cat-tree-empty">暂无工作区</li>
                        ) : (
                          group.items.map((row) => {
                            const payload = parseWorkspacePayload(row.payload);
                            const summary = workspaceSummaryLabel(row, payload);
                            const panes = payload
                              ? layoutPaneCount(payload)
                              : 0;
                            const time = row.updatedAt
                              ? new Date(row.updatedAt * 1000).toLocaleString()
                              : "";
                            return (
                              <li
                                key={row.id}
                                className="workspace-list-item"
                              >
                                <div className="workspace-list-meta">
                                  <span className="workspace-list-name">
                                    {row.name}
                                  </span>
                                  <span className="workspace-list-summary">
                                    {summary}
                                  </span>
                                  {time ? (
                                    <span className="workspace-list-time">
                                      {time}
                                    </span>
                                  ) : null}
                                </div>
                                <label className="workspace-item-category">
                                  <span className="sr-only">移动到分类</span>
                                  <select
                                    value={
                                      row.categoryId == null
                                        ? ""
                                        : String(row.categoryId)
                                    }
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      void changeCategory(
                                        row,
                                        v === "" ? null : Number(v),
                                      );
                                    }}
                                    title="移动到分类"
                                  >
                                    <option value="">未分类</option>
                                    {categories.map((cat) => (
                                      <option
                                        key={cat.id}
                                        value={String(cat.id)}
                                      >
                                        {cat.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <div className="workspace-list-actions">
                                  <button
                                    type="button"
                                    className="btn-primary"
                                    disabled={!payload}
                                    title={
                                      panes ? `打开（${panes} 窗格）` : "打开"
                                    }
                                    onClick={() => {
                                      if (payload)
                                        onOpenWorkspace(row, payload);
                                    }}
                                  >
                                    打开
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    title="删除"
                                    onClick={() => {
                                      if (
                                        !window.confirm(
                                          `删除工作区「${row.name}」？`,
                                        )
                                      ) {
                                        return;
                                      }
                                      void deleteWorkspaceRow(row.id)
                                        .then(() => refresh())
                                        .catch((e) => setError(String(e)));
                                    }}
                                  >
                                    删除
                                  </button>
                                </div>
                              </li>
                            );
                          })
                        )}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : effectivePane === "commands" ? (
        <SavedCommandsPanel
          canInject={canInjectCommand}
          injectDisabledReason={injectCommandDisabledReason}
          onInject={(body, opts) => onInjectCommand?.(body, opts)}
        />
      ) : filesSessionId ? (
        <div className="workspace-files-host">
          <RemoteFilePanel
            key={filesSessionId}
            sessionId={filesSessionId}
            initialPath={filesInitialPath}
            terminalCwd={filesTerminalCwd}
            connected={filesConnected}
            onClose={onClose}
            embedded
          />
        </div>
      ) : (
        <div className="workspace-list-empty">无可用的远程文件会话</div>
      )}

      <div
        className="remote-file-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧栏宽度"
        title="拖动调整宽度"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      />
    </aside>
  );
}
