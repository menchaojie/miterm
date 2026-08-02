import { useEffect, useState } from "react";
import {
  LOCAL_SHELL_OPTIONS,
  isLocalShellKind,
  shellNeedsPath,
} from "../settings";
import type { Category, HostDraft, SavedHost } from "../types";
import { emptyHostDraft } from "../types";

export type HostEditorMode = "add" | "edit";

function IconEye() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"
      />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2.1 3.51 3.5 2.1l18.4 18.4-1.41 1.41-3.11-3.1A11.7 11.7 0 0 1 12 19c-7 0-10-7-10-7a18.4 18.4 0 0 1 5.06-5.55L2.1 3.51zM12 7a5 5 0 0 1 4.9 6.1l-1.57-1.57A3 3 0 0 0 12.5 8.7L12 7zm9.9 5S18.9 19 12 19c-.7 0-1.35-.07-1.97-.2l1.7-1.7c.1 0 .18.01.27.01a5 5 0 0 0 5-5c0-.09 0-.18-.01-.27l3.48-3.48A18.3 18.3 0 0 1 21.9 12z"
      />
    </svg>
  );
}

interface HostEditorProps {
  open: boolean;
  mode: HostEditorMode;
  initial?: SavedHost | null;
  categories: Category[];
  defaultCategoryId?: number | null;
  busy?: boolean;
  errorMessage?: string;
  onClose: () => void;
  onSave: (draft: HostDraft) => void;
}

export function HostEditor({
  open,
  mode,
  initial,
  categories,
  defaultCategoryId = null,
  busy = false,
  errorMessage = "",
  onClose,
  onSave,
}: HostEditorProps) {
  const [draft, setDraft] = useState<HostDraft>(emptyHostDraft());
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShowPassword(false);
    if (mode === "edit" && initial) {
      const connType = initial.connType === "local" ? "local" : "ssh";
      const shell = isLocalShellKind(initial.shell)
        ? initial.shell
        : "powershell";
      setDraft({
        connType,
        name:
          connType === "local"
            ? initial.name
            : initial.name === initial.host
              ? ""
              : initial.name,
        host: initial.host,
        port: String(initial.port || 22),
        username: initial.username,
        password: initial.password,
        categoryId: initial.categoryId,
        shell,
        shellPath: initial.shellPath || "",
      });
    } else {
      setDraft(emptyHostDraft(defaultCategoryId, "ssh"));
    }
  }, [open, mode, initial, defaultCategoryId]);

  if (!open) return null;

  const isLocal = draft.connType === "local";
  const title =
    mode === "add"
      ? "增加主机"
      : isLocal
        ? "设置本地终端"
        : "编辑远程主机";

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="host-editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onSave(draft);
        }}
      >
        <h2 className="host-editor-title">{title}</h2>

        {mode === "add" ? (
          <div className="host-editor-field">
            <span className="host-editor-field-label">连接类型</span>
            <div
              className="host-editor-seg"
              role="radiogroup"
              aria-label="连接类型"
            >
              <label
                className={`host-editor-seg-item${
                  draft.connType === "ssh" ? " selected" : ""
                }`}
              >
                <input
                  type="radio"
                  name="conn-type"
                  checked={draft.connType === "ssh"}
                  disabled={busy}
                  onChange={() =>
                    setDraft((d) => ({
                      ...emptyHostDraft(d.categoryId, "ssh"),
                      categoryId: d.categoryId,
                    }))
                  }
                />
                远程 SSH
              </label>
              <label
                className={`host-editor-seg-item${
                  draft.connType === "local" ? " selected" : ""
                }`}
              >
                <input
                  type="radio"
                  name="conn-type"
                  checked={draft.connType === "local"}
                  disabled={busy}
                  onChange={() => {
                    const localCat = categories.find(
                      (c) => c.name === "本地" || c.name === "本地终端",
                    );
                    setDraft((d) => ({
                      ...emptyHostDraft(
                        localCat?.id ?? d.categoryId,
                        "local",
                      ),
                    }));
                  }}
                />
                本地终端
              </label>
            </div>
          </div>
        ) : null}

        <label className="host-editor-field">
          <span className="host-editor-field-label">名称</span>
          <input
            type="text"
            value={draft.name}
            disabled={busy}
            placeholder={
              isLocal ? "例如 本地终端 / Git Bash" : "不填则使用 Host / IP"
            }
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            autoComplete="off"
          />
        </label>
        <label className="host-editor-field">
          <span className="host-editor-field-label">分类</span>
          <select
            value={draft.categoryId ?? ""}
            disabled={busy}
            onChange={(e) => {
              const v = e.target.value;
              setDraft((d) => ({
                ...d,
                categoryId: v === "" ? null : Number(v),
              }));
            }}
          >
            <option value="">未分类</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        {isLocal ? (
          <>
            <label className="host-editor-field">
              <span className="host-editor-field-label">Shell</span>
              <select
                value={draft.shell}
                disabled={busy}
                onChange={(e) => {
                  const shell = e.target.value;
                  if (!isLocalShellKind(shell)) return;
                  setDraft((d) => ({ ...d, shell }));
                }}
              >
                {LOCAL_SHELL_OPTIONS.map((opt) => (
                  <option key={opt.kind} value={opt.kind}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            {shellNeedsPath(draft.shell) ? (
              <label className="host-editor-field">
                <span className="host-editor-field-label">可执行文件路径</span>
                <input
                  type="text"
                  value={draft.shellPath}
                  disabled={busy}
                  required={draft.shell === "custom"}
                  placeholder={
                    draft.shell === "gitbash"
                      ? "例如 D:\\Program Files\\Git\\bin\\bash.exe（可留空自动检测）"
                      : "例如 C:\\path\\to\\shell.exe"
                  }
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, shellPath: e.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
            ) : (
              <p className="host-editor-hint">
                系统 Shell 将自动检测路径；覆盖路径请选「自定义路径」。
              </p>
            )}
          </>
        ) : (
          <>
            <div className="host-editor-row host-editor-row-hostport">
              <label className="host-editor-field">
                <span className="host-editor-field-label">Host</span>
                <input
                  type="text"
                  value={draft.host}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, host: e.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className="host-editor-field host-editor-field-port">
                <span className="host-editor-field-label">Port</span>
                <input
                  type="text"
                  value={draft.port}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, port: e.target.value }))
                  }
                  autoComplete="off"
                />
              </label>
            </div>
            <label className="host-editor-field">
              <span className="host-editor-field-label">User</span>
              <input
                type="text"
                value={draft.username}
                disabled={busy}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, username: e.target.value }))
                }
                autoComplete="username"
              />
            </label>
            <div className="host-editor-field">
              <span className="host-editor-field-label">Password</span>
              <div className="host-editor-password-wrap">
                <input
                  type={showPassword ? "text" : "password"}
                  value={draft.password}
                  disabled={busy}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, password: e.target.value }))
                  }
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="host-editor-password-toggle"
                  disabled={busy}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>
          </>
        )}

        {errorMessage && <span className="connect-error">{errorMessage}</span>}
        <div className="host-editor-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}
