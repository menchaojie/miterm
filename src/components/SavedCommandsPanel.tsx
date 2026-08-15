import { useCallback, useEffect, useMemo, useState } from "react";
import type { Category, CategoryFilter } from "../types";
import {
  deleteCommandRow,
  listSavedCommands,
  saveCommandRow,
  updateCommandRow,
  type SavedCommandRow,
} from "../savedCommands";

const CMD_FILTER_KEY = "miterm.commandCategoryFilter";

function loadCommandFilter(): CategoryFilter {
  try {
    const v = localStorage.getItem(CMD_FILTER_KEY);
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

function saveCommandFilter(filter: CategoryFilter) {
  try {
    localStorage.setItem(CMD_FILTER_KEY, String(filter));
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

export interface SavedCommandsPanelProps {
  canInject: boolean;
  injectDisabledReason?: string;
  /** 与主机/工作区共用的分类 */
  categories?: Category[];
  /** 填入当前终端；run=true 时末尾带换行以执行 */
  onInject: (body: string, opts: { run: boolean }) => void;
}

export function SavedCommandsPanel({
  canInject,
  injectDisabledReason,
  categories = [],
  onInject,
}: SavedCommandsPanelProps) {
  const [rows, setRows] = useState<SavedCommandRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<CategoryFilter>(loadCommandFilter);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await listSavedCommands());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof filter === "number" && !categories.some((c) => c.id === filter)) {
      setFilter("all");
      saveCommandFilter("all");
    }
  }, [categories, filter]);

  const onFilterChange = (next: CategoryFilter) => {
    setFilter(next);
    saveCommandFilter(next);
    if (creating || editingId != null) {
      if (typeof next === "number") setDraftCategoryId(next);
      else if (next === "uncategorized") setDraftCategoryId(null);
    }
  };

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraftTitle("");
    setDraftBody("");
    if (typeof filter === "number") setDraftCategoryId(filter);
    else setDraftCategoryId(null);
    setError("");
  };

  const startEdit = (row: SavedCommandRow) => {
    setCreating(false);
    setEditingId(row.id);
    setDraftTitle(row.title);
    setDraftBody(row.body);
    setDraftCategoryId(row.categoryId);
    setError("");
  };

  const cancelEdit = () => {
    setCreating(false);
    setEditingId(null);
    setDraftTitle("");
    setDraftBody("");
    setDraftCategoryId(null);
  };

  const saveDraft = async () => {
    const title = draftTitle.trim();
    const body = draftBody.trimEnd();
    if (!title) {
      setError("命令标题不能为空");
      return;
    }
    if (!body.trim()) {
      setError("命令内容不能为空");
      return;
    }
    setError("");
    try {
      if (creating) {
        await saveCommandRow({
          title,
          body,
          categoryId: draftCategoryId,
        });
      } else if (editingId != null) {
        await updateCommandRow({
          id: editingId,
          title,
          body,
          categoryId: draftCategoryId,
        });
      }
      cancelEdit();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const changeCategory = async (
    row: SavedCommandRow,
    categoryId: number | null,
  ) => {
    try {
      await updateCommandRow({
        id: row.id,
        title: row.title,
        body: row.body,
        categoryId,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = async (row: SavedCommandRow) => {
    if (!window.confirm(`删除命令「${row.title}」？`)) return;
    try {
      await deleteCommandRow(row.id);
      if (editingId === row.id) cancelEdit();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const filteredRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "uncategorized") {
      return rows.filter((r) => r.categoryId == null);
    }
    return rows.filter((r) => r.categoryId === filter);
  }, [rows, filter]);

  const injectDisabledTitle = canInject
    ? undefined
    : injectDisabledReason || "请先打开并聚焦已连接的终端";

  return (
    <div className="workspace-list-pane saved-commands-pane">
      <div className="workspace-list-toolbar">
        <button
          type="button"
          className="btn-primary workspace-save-btn"
          onClick={startCreate}
          disabled={creating || editingId != null}
        >
          新建
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
            aria-label="按分类筛选命令"
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
      </div>

      {error ? <div className="workspace-list-error">{error}</div> : null}

      {creating || editingId != null ? (
        <div className="saved-command-editor">
          <label className="saved-command-field">
            <span>标题</span>
            <input
              type="text"
              value={draftTitle}
              placeholder="例如：查看磁盘"
              onChange={(e) => setDraftTitle(e.target.value)}
              autoFocus
            />
          </label>
          <label className="saved-command-field">
            <span>命令</span>
            <textarea
              value={draftBody}
              placeholder={"例如：df -h\n可多行"}
              rows={4}
              onChange={(e) => setDraftBody(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="saved-command-field">
            <span>分类</span>
            <select
              value={draftCategoryId == null ? "" : String(draftCategoryId)}
              onChange={(e) => {
                const v = e.target.value;
                setDraftCategoryId(v === "" ? null : Number(v));
              }}
            >
              <option value="">未分类</option>
              {categories.map((cat) => (
                <option key={cat.id} value={String(cat.id)}>
                  {cat.name}
                </option>
              ))}
            </select>
          </label>
          <div className="saved-command-editor-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void saveDraft()}
            >
              保存
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={cancelEdit}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <div className="workspace-list-empty">加载中…</div>
      ) : filteredRows.length === 0 && !creating ? (
        <div className="workspace-list-empty">
          {rows.length === 0
            ? "尚无保存的命令。点「新建」添加常用命令；点击标题填入终端，点「运行」填入并回车。"
            : "当前分类下没有命令。"}
        </div>
      ) : (
        <ul className="workspace-list saved-command-list">
          {filteredRows.map((row) => {
            const catName =
              row.categoryId == null
                ? "未分类"
                : (categories.find((c) => c.id === row.categoryId)?.name ??
                  "未分类");
            return (
              <li
                key={row.id}
                className="workspace-list-item saved-command-item"
              >
                <button
                  type="button"
                  className="saved-command-main"
                  title={
                    canInject
                      ? `填入终端（不回车）\n${row.body}`
                      : injectDisabledTitle
                  }
                  disabled={!canInject}
                  onClick={() => onInject(row.body, { run: false })}
                >
                  <span className="workspace-list-name">{row.title}</span>
                  <span className="workspace-list-summary saved-command-preview">
                    {catName} · {row.body.replace(/\s+/g, " ").trim()}
                  </span>
                </button>
                <label className="workspace-item-category">
                  <span className="sr-only">分类</span>
                  <select
                    value={
                      row.categoryId == null ? "" : String(row.categoryId)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      void changeCategory(row, v === "" ? null : Number(v));
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
                    disabled={!canInject}
                    title={
                      canInject
                        ? "填入终端并回车执行"
                        : injectDisabledTitle
                    }
                    onClick={() => onInject(row.body, { run: true })}
                  >
                    运行
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => startEdit(row)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void remove(row)}
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
  );
}
