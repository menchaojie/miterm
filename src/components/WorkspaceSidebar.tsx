import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RemoteFilePanel } from "./RemoteFilePanel";
import { SavedCommandsPanel } from "./SavedCommandsPanel";
import type { Category, CategoryFilter } from "../types";
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

export type SidebarPane = "workspaces" | "files" | "commands";

const WIDTH_KEY = "miterm.sidebarWidth";
const LEGACY_WIDTH_KEY = "miterm.remoteFilePanelWidth";
const PANE_KEY = "miterm.sidebarPane";
const WS_FILTER_KEY = "miterm.workspaceCategoryFilter";
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

function loadSidebarPane(defaultPane: SidebarPane): SidebarPane {
  try {
    const v = localStorage.getItem(PANE_KEY);
    if (v === "files" || v === "workspaces" || v === "commands") return v;
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

function loadWorkspaceFilter(): CategoryFilter {
  try {
    const v = localStorage.getItem(WS_FILTER_KEY);
    if (v === "all" || v === "uncategorized") return v;
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* ignore */
  }
  return "all";
}

function saveWorkspaceFilter(filter: CategoryFilter) {
  try {
    localStorage.setItem(WS_FILTER_KEY, String(filter));
  } catch {
    /* ignore */
  }
}

function filterToSelectValue(filter: CategoryFilter): string {
  if (filter === "all") return "all";
  if (filter === "uncategorized") return "uncategorized";
  return String(filter);
}

function selectValueToFilter(value: string): CategoryFilter {
  if (value === "all") return "all";
  if (value === "uncategorized") return "uncategorized";
  const n = Number(value);
  return Number.isFinite(n) ? n : "all";
}

export interface WorkspaceSidebarProps {
  onClose: () => void;
  /** 是否允许远程文件 Tab */
  filesAvailable: boolean;
  filesSessionId?: string | null;
  filesInitialPath?: string;
  filesTerminalCwd?: string | null;
  filesConnected?: boolean;
  /** 与主机共用的分类列表 */
  categories?: Category[];
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
  filesAvailable,
  filesSessionId = null,
  filesInitialPath = "/",
  filesTerminalCwd = null,
  filesConnected = false,
  categories: categoriesProp,
  canSaveCurrent,
  saveDisabledReason,
  onSaveCurrent,
  onOpenWorkspace,
  refreshToken = 0,
  canInjectCommand = false,
  injectCommandDisabledReason,
  onInjectCommand,
}: WorkspaceSidebarProps) {
  const defaultPane: SidebarPane = filesAvailable ? "files" : "workspaces";
  const [pane, setPane] = useState<SidebarPane>(() =>
    loadSidebarPane(defaultPane),
  );
  const [panelWidth, setPanelWidth] = useState(loadSidebarWidth);
  const [rows, setRows] = useState<SavedWorkspaceRow[]>([]);
  const [categoriesLocal, setCategoriesLocal] = useState<Category[]>([]);
  const [filter, setFilter] = useState<CategoryFilter>(loadWorkspaceFilter);
  const [saveCategoryId, setSaveCategoryId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const categories = categoriesProp ?? categoriesLocal;

  const effectivePane: SidebarPane =
    pane === "files" && !filesAvailable ? "workspaces" : pane;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const nextRows = await listWorkspaces();
      setRows(nextRows);
      if (categoriesProp == null) {
        setCategoriesLocal(await invoke<Category[]>("list_categories"));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [categoriesProp]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    if (pane === "files" && !filesAvailable) {
      setPane("workspaces");
    }
  }, [filesAvailable, pane]);

  useEffect(() => {
    if (typeof filter === "number" && !categories.some((c) => c.id === filter)) {
      setFilter("all");
      saveWorkspaceFilter("all");
    }
  }, [categories, filter]);

  const selectPane = (next: SidebarPane) => {
    if (next === "files" && !filesAvailable) return;
    setPane(next);
    saveSidebarPane(next);
  };

  const onFilterChange = (next: CategoryFilter) => {
    setFilter(next);
    saveWorkspaceFilter(next);
    if (typeof next === "number") setSaveCategoryId(next);
    else if (next === "uncategorized") setSaveCategoryId(null);
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

  const filteredRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "uncategorized") {
      return rows.filter((r) => r.categoryId == null);
    }
    return rows.filter((r) => r.categoryId === filter);
  }, [rows, filter]);

  const parsedRows = useMemo(
    () =>
      filteredRows.map((r) => ({
        row: r,
        payload: parseWorkspacePayload(r.payload),
      })),
    [filteredRows],
  );

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
          <button
            type="button"
            role="tab"
            aria-selected={effectivePane === "files"}
            className={`workspace-sidebar-tab${
              effectivePane === "files" ? " active" : ""
            }`}
            disabled={!filesAvailable}
            title={
              filesAvailable
                ? "远程文件"
                : "需在已连接的 SSH 会话中打开远程文件"
            }
            onClick={() => selectPane("files")}
          >
            远程文件
          </button>
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
        <button
          type="button"
          className="remote-file-close"
          title="关闭侧栏"
          aria-label="关闭侧栏"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {effectivePane === "workspaces" ? (
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
          </div>
          <div className="workspace-category-row">
            <label className="workspace-category-field">
              <span>筛选</span>
              <select
                value={filterToSelectValue(filter)}
                onChange={(e) =>
                  onFilterChange(selectValueToFilter(e.target.value))
                }
                aria-label="按分类筛选工作区"
              >
                <option value="all">全部（{rows.length}）</option>
                <option value="uncategorized">
                  未分类（{rows.filter((r) => r.categoryId == null).length}）
                </option>
                {categories.map((cat) => (
                  <option key={cat.id} value={String(cat.id)}>
                    {`${cat.name}（${rows.filter((r) => r.categoryId === cat.id).length}）`}
                  </option>
                ))}
              </select>
            </label>
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
          </div>
          {error ? <div className="workspace-list-error">{error}</div> : null}
          {loading && rows.length === 0 ? (
            <div className="workspace-list-empty">加载中…</div>
          ) : parsedRows.length === 0 ? (
            <div className="workspace-list-empty">
              {rows.length === 0
                ? "尚无保存的工作区。打开会话后可点「保存当前」。"
                : "当前分类下没有工作区。"}
            </div>
          ) : (
            <ul className="workspace-list">
              {parsedRows.map(({ row, payload }) => {
                const summary = workspaceSummaryLabel(row, payload);
                const panes = payload ? layoutPaneCount(payload) : 0;
                const time = row.updatedAt
                  ? new Date(row.updatedAt * 1000).toLocaleString()
                  : "";
                const catName =
                  row.categoryId == null
                    ? "未分类"
                    : (categories.find((c) => c.id === row.categoryId)?.name ??
                      "未分类");
                return (
                  <li key={row.id} className="workspace-list-item">
                    <div className="workspace-list-meta">
                      <span className="workspace-list-name">{row.name}</span>
                      <span className="workspace-list-summary">
                        {summary} · {catName}
                      </span>
                      {time ? (
                        <span className="workspace-list-time">{time}</span>
                      ) : null}
                    </div>
                    <label className="workspace-item-category">
                      <span className="sr-only">分类</span>
                      <select
                        value={
                          row.categoryId == null ? "" : String(row.categoryId)
                        }
                        onChange={(e) => {
                          const v = e.target.value;
                          void changeCategory(
                            row,
                            v === "" ? null : Number(v),
                          );
                        }}
                        title="更改分类"
                      >
                        <option value="">未分类</option>
                        {categories.map((cat) => (
                          <option key={cat.id} value={String(cat.id)}>
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
                        title={panes ? `打开（${panes} 窗格）` : "打开"}
                        onClick={() => {
                          if (payload) onOpenWorkspace(row, payload);
                        }}
                      >
                        打开
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        title="删除"
                        onClick={() => {
                          if (!window.confirm(`删除工作区「${row.name}」？`)) {
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
              })}
            </ul>
          )}
        </div>
      ) : effectivePane === "commands" ? (
        <SavedCommandsPanel
          canInject={canInjectCommand}
          injectDisabledReason={injectCommandDisabledReason}
          categories={categories}
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
