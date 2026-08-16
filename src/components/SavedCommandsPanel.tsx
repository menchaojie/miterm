import { useCallback, useEffect, useMemo, useState } from "react";
import type { Category } from "../types";
import {
  buildCategoryGroups,
  isGroupCollapsed,
  loadCollapsedGroupKeys,
  saveCollapsedGroupKeys,
  toggleCollapsedGroupKey,
  type CategoryGroupKey,
} from "../categoryTree";
import {
  createCommandCategory,
  deleteCommandCategory,
  listCommandCategories,
  updateCommandCategory,
} from "../domainCategories";
import {
  deleteCommandRow,
  listSavedCommands,
  saveCommandRow,
  updateCommandRow,
  type SavedCommandRow,
} from "../savedCommands";
import {
  IconFolder,
  IconRename,
  IconTrash,
  IconTreeChevron,
} from "./CatTreeIcons";

const CMD_COLLAPSE_KEY = "miterm.commandCategoryCollapse.v1";

export interface SavedCommandsPanelProps {
  canInject: boolean;
  injectDisabledReason?: string;
  /** 填入当前终端；run=true 时末尾带换行以执行 */
  onInject: (body: string, opts: { run: boolean }) => void;
}

export function SavedCommandsPanel({
  canInject,
  injectDisabledReason,
  onInject,
}: SavedCommandsPanelProps) {
  const [rows, setRows] = useState<SavedCommandRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(() =>
    loadCollapsedGroupKeys(CMD_COLLAPSE_KEY),
  );
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
  const [detailRow, setDetailRow] = useState<SavedCommandRow | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftCategoryId, setDraftCategoryId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextRows, nextCats] = await Promise.all([
        listSavedCommands(),
        listCommandCategories(),
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
  }, [refresh]);

  useEffect(() => {
    if (
      activeCategoryId != null &&
      !categories.some((c) => c.id === activeCategoryId)
    ) {
      setActiveCategoryId(null);
    }
  }, [categories, activeCategoryId]);

  const groups = useMemo(
    () => buildCategoryGroups(categories, rows, (r) => r.categoryId),
    [categories, rows],
  );

  const toggleGroupCollapsed = (key: CategoryGroupKey) => {
    setCollapsed((prev) => {
      const next = toggleCollapsedGroupKey(prev, key);
      saveCollapsedGroupKeys(CMD_COLLAPSE_KEY, next);
      return next;
    });
  };

  const addCategory = async () => {
    const name = window.prompt("命令分类名称");
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("分类名称不能为空");
      return;
    }
    try {
      const cat = await createCommandCategory(trimmed);
      await refresh();
      setActiveCategoryId(cat.id);
      setDraftCategoryId(cat.id);
    } catch (e) {
      setError(String(e));
    }
  };

  const renameCategory = async (cat: Category) => {
    const name = window.prompt("重命名命令分类", cat.name);
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("分类名称不能为空");
      return;
    }
    try {
      await updateCommandCategory(cat.id, trimmed);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const removeCategory = async (cat: Category) => {
    if (
      !window.confirm(
        `删除命令分类「${cat.name}」？该分类下的命令将变为未分类。`,
      )
    ) {
      return;
    }
    try {
      await deleteCommandCategory(cat.id);
      if (activeCategoryId === cat.id) setActiveCategoryId(null);
      if (draftCategoryId === cat.id) setDraftCategoryId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const startCreate = () => {
    setDetailRow(null);
    setCreating(true);
    setEditingId(null);
    setDraftTitle("");
    setDraftBody("");
    setDraftCategoryId(activeCategoryId);
    setError("");
  };

  const startEdit = (row: SavedCommandRow) => {
    setDetailRow(null);
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
      setDetailRow((prev) =>
        prev && prev.id === row.id ? { ...prev, categoryId } : prev,
      );
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
      if (detailRow?.id === row.id) setDetailRow(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const injectDisabledTitle = canInject
    ? undefined
    : injectDisabledReason || "请先打开并聚焦已连接的终端";

  const editorOpen = creating || editingId != null;

  return (
    <div className="workspace-list-pane saved-commands-pane">
      <div className="workspace-list-toolbar">
        <button
          type="button"
          className="btn-primary workspace-save-btn"
          onClick={startCreate}
          disabled={editorOpen}
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
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void addCategory()}
        >
          新建分类
        </button>
      </div>

      {error ? <div className="workspace-list-error">{error}</div> : null}

      {loading && rows.length === 0 ? (
        <div className="workspace-list-empty">加载中…</div>
      ) : rows.length === 0 && categories.length === 0 && !editorOpen ? (
        <div className="workspace-list-empty">
          尚无保存的命令。点「新建」添加；点击名称查看详情并可填入/运行。
        </div>
      ) : (
        <ul className="cat-tree-list saved-command-list">
          {groups.map((group) => {
            const collapsedGroup = isGroupCollapsed(collapsed, group.key);
            const isActive =
              (group.key === "uncategorized" && activeCategoryId == null) ||
              (typeof group.key === "number" &&
                activeCategoryId === group.key);
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
                    title="设为新建命令的默认分类"
                    onClick={() =>
                      setActiveCategoryId(
                        group.key === "uncategorized" ? null : group.key,
                      )
                    }
                  >
                    <IconFolder open={!collapsedGroup} />
                    <span className="cat-tree-group-label">{group.label}</span>
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
                      <li className="cat-tree-empty">暂无命令</li>
                    ) : (
                      group.items.map((row) => (
                        <li key={row.id} className="sidebar-name-item">
                          <button
                            type="button"
                            className="sidebar-name-btn"
                            title={row.title}
                            onClick={() => setDetailRow(row)}
                          >
                            {row.title}
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {detailRow ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDetailRow(null);
          }}
        >
          <div
            className="sidebar-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-detail-title"
          >
            <header className="sidebar-detail-header">
              <h3 id="command-detail-title" className="sidebar-detail-title">
                {detailRow.title}
              </h3>
              <button
                type="button"
                className="remote-file-close"
                title="关闭"
                aria-label="关闭"
                onClick={() => setDetailRow(null)}
              >
                ×
              </button>
            </header>
            <div className="sidebar-detail-body">
              <pre className="sidebar-detail-code">{detailRow.body}</pre>
              <label className="saved-command-field">
                <span>分类</span>
                <select
                  value={
                    detailRow.categoryId == null
                      ? ""
                      : String(detailRow.categoryId)
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    void changeCategory(
                      detailRow,
                      v === "" ? null : Number(v),
                    );
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
            </div>
            <div className="sidebar-detail-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={!canInject}
                title={
                  canInject ? "填入终端并回车执行" : injectDisabledTitle
                }
                onClick={() => {
                  onInject(detailRow.body, { run: true });
                  setDetailRow(null);
                }}
              >
                运行
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={!canInject}
                title={
                  canInject ? "填入终端（不回车）" : injectDisabledTitle
                }
                onClick={() => {
                  onInject(detailRow.body, { run: false });
                  setDetailRow(null);
                }}
              >
                填入
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => startEdit(detailRow)}
              >
                编辑
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void remove(detailRow)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editorOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) cancelEdit();
          }}
        >
          <div
            className="sidebar-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="command-editor-title"
          >
            <header className="sidebar-detail-header">
              <h3 id="command-editor-title" className="sidebar-detail-title">
                {creating ? "新建命令" : "编辑命令"}
              </h3>
              <button
                type="button"
                className="remote-file-close"
                title="关闭"
                aria-label="关闭"
                onClick={cancelEdit}
              >
                ×
              </button>
            </header>
            <div className="sidebar-detail-body">
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
                  rows={5}
                  onChange={(e) => setDraftBody(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="saved-command-field">
                <span>分类</span>
                <select
                  value={
                    draftCategoryId == null ? "" : String(draftCategoryId)
                  }
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
            </div>
            <div className="sidebar-detail-actions">
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
        </div>
      ) : null}
    </div>
  );
}
