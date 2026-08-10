import { useCallback, useEffect, useState } from "react";
import {
  deleteCommandRow,
  listSavedCommands,
  saveCommandRow,
  updateCommandRow,
  type SavedCommandRow,
} from "../savedCommands";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
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

  const startCreate = () => {
    setCreating(true);
    setEditingId(null);
    setDraftTitle("");
    setDraftBody("");
    setError("");
  };

  const startEdit = (row: SavedCommandRow) => {
    setCreating(false);
    setEditingId(row.id);
    setDraftTitle(row.title);
    setDraftBody(row.body);
    setError("");
  };

  const cancelEdit = () => {
    setCreating(false);
    setEditingId(null);
    setDraftTitle("");
    setDraftBody("");
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
        await saveCommandRow({ title, body });
      } else if (editingId != null) {
        await updateCommandRow({ id: editingId, title, body });
      }
      cancelEdit();
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
      ) : rows.length === 0 && !creating ? (
        <div className="workspace-list-empty">
          尚无保存的命令。点「新建」添加常用命令；点击标题填入终端，点「运行」填入并回车。
        </div>
      ) : (
        <ul className="workspace-list saved-command-list">
          {rows.map((row) => (
            <li key={row.id} className="workspace-list-item saved-command-item">
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
                  {row.body.replace(/\s+/g, " ").trim()}
                </span>
              </button>
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
          ))}
        </ul>
      )}
    </div>
  );
}
