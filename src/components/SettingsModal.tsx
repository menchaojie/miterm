import { useEffect, useState } from "react";
import {
  AUTO_RECONNECT_MAX_ATTEMPTS_MAX,
  AUTO_RECONNECT_MAX_ATTEMPTS_MIN,
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUTS,
  SETTINGS_TABS,
  SHORTCUT_ACTIONS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  clampTerminalFontSize,
  findShortcutConflict,
  formatShortcut,
  shortcutFromEvent,
  type AppSettings,
  type SettingsTabId,
  type ShortcutActionId,
  type ShortcutBinding,
} from "../settings";

interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

export function SettingsModal({
  open,
  settings,
  onClose,
  onSave,
}: SettingsModalProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<SettingsTabId>("connection");

  useEffect(() => {
    if (!open) return;
    setDraft(structuredClone(settings));
    setRecording(null);
    setError("");
    setActiveTab("connection");
  }, [open, settings]);

  useEffect(() => {
    if (!open || !recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const next = shortcutFromEvent(e);
      if (!next) return;

      const conflict = findShortcutConflict(draft.shortcuts, recording, next);
      if (conflict) {
        const label =
          SHORTCUT_ACTIONS.find((a) => a.id === conflict)?.label ?? conflict;
        setError(`与「${label}」冲突，请换一组按键`);
        return;
      }

      setDraft((d) => ({
        ...d,
        shortcuts: { ...d.shortcuts, [recording]: next },
      }));
      setError("");
      setRecording(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, recording, draft.shortcuts]);

  if (!open) return null;

  const setBinding = (id: ShortcutActionId, binding: ShortcutBinding) => {
    const conflict = findShortcutConflict(draft.shortcuts, id, binding);
    if (conflict) {
      const label =
        SHORTCUT_ACTIONS.find((a) => a.id === conflict)?.label ?? conflict;
      setError(`与「${label}」冲突`);
      return;
    }
    setError("");
    setDraft((d) => ({
      ...d,
      shortcuts: { ...d.shortcuts, [id]: binding },
    }));
  };

  const shortcutActions = SHORTCUT_ACTIONS.filter((a) => a.tab === activeTab);

  const shortcutHint =
    activeTab === "shortcutsNav"
      ? "默认：Ctrl+Tab / Ctrl+Shift+Tab 切会话 Tab；Ctrl+1～9 跳到对应 Tab（1=主机列表）。"
      : activeTab === "shortcutsPane"
        ? "默认：Ctrl+Shift+[ / ] 循环窗格；Ctrl+Alt+方向键跳相邻窗格；Ctrl+Shift+空格交替全部加入/退出并发。"
        : activeTab === "shortcutsFiles"
          ? "默认：Ctrl+Shift+E 打开或关闭侧栏（工作区 / 远程文件 / 命令）。"
          : "";

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !recording) onClose();
      }}
    >
      <div
        className="settings-modal"
        role="dialog"
        aria-labelledby="settings-title"
      >
        <h2 id="settings-title" className="settings-title">
          设置
        </h2>

        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {SETTINGS_TABS.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`settings-tab${selected ? " active" : ""}`}
                disabled={Boolean(recording)}
                onClick={() => {
                  setError("");
                  setRecording(null);
                  setActiveTab(tab.id);
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="settings-tab-panel" role="tabpanel">
          {activeTab === "connection" ? (
            <section className="settings-section">
              <p className="settings-hint">
                异常断线（网络/超时）时可自动重连；主动关 Tab、以及远程{" "}
                <code>exit</code>{" "}
                退出不会自动重连（终端内可点「重新连接」）。应用会启用
                TCP/SSH keepalive 以减少空闲被踢。
              </p>
              <label className="settings-check-row">
                <input
                  type="checkbox"
                  checked={draft.autoReconnect}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      autoReconnect: e.target.checked,
                    }))
                  }
                />
                <span>断线自动重连</span>
              </label>
              <label className="settings-field-row">
                <span className="settings-field-label">最大重试次数</span>
                <input
                  type="number"
                  className="settings-number-input"
                  min={AUTO_RECONNECT_MAX_ATTEMPTS_MIN}
                  max={AUTO_RECONNECT_MAX_ATTEMPTS_MAX}
                  disabled={!draft.autoReconnect}
                  value={draft.autoReconnectMaxAttempts}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setDraft((d) => ({
                      ...d,
                      autoReconnectMaxAttempts: Number.isFinite(n)
                        ? n
                        : d.autoReconnectMaxAttempts,
                    }));
                  }}
                />
              </label>
            </section>
          ) : null}

          {activeTab === "connection" ? (
            <section className="settings-section">
              <p className="settings-section-title">终端外观</p>
              <p className="settings-hint">
                仅缩放终端字体（不影响 Tab、侧栏等界面）。默认字号{" "}
                {TERMINAL_FONT_SIZE_DEFAULT}px，范围{" "}
                {TERMINAL_FONT_SIZE_MIN}～{TERMINAL_FONT_SIZE_MAX}。
              </p>
              <label className="settings-check-row">
                <input
                  type="checkbox"
                  checked={draft.ctrlWheelZoom}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      ctrlWheelZoom: e.target.checked,
                    }))
                  }
                />
                <span>启用 Ctrl + 滚轮缩放终端字体</span>
              </label>
              <label className="settings-field-row">
                <span className="settings-field-label">终端字号 (px)</span>
                <input
                  type="number"
                  className="settings-number-input"
                  min={TERMINAL_FONT_SIZE_MIN}
                  max={TERMINAL_FONT_SIZE_MAX}
                  value={draft.terminalFontSize}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setDraft((d) => ({
                      ...d,
                      terminalFontSize: Number.isFinite(n)
                        ? clampTerminalFontSize(n)
                        : d.terminalFontSize,
                    }));
                  }}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
                    }))
                  }
                >
                  重置
                </button>
              </label>
            </section>
          ) : (
            <section className="settings-section">
              {shortcutHint ? (
                <p className="settings-hint">{shortcutHint}</p>
              ) : null}
              <p className="settings-hint">
                点击「更改」后按下新组合键；Esc 取消录制。
              </p>
              <div className="settings-shortcut-list">
                {shortcutActions.map((action) => {
                  const binding = draft.shortcuts[action.id];
                  const isRec = recording === action.id;
                  return (
                    <div key={action.id} className="settings-shortcut-row">
                      <div className="settings-shortcut-meta">
                        <span className="settings-shortcut-label">
                          {action.label}
                        </span>
                        {action.hint ? (
                          <span className="settings-shortcut-desc">
                            {action.hint}
                          </span>
                        ) : null}
                      </div>
                      <kbd
                        className={`settings-shortcut-kbd${isRec ? " recording" : ""}`}
                      >
                        {isRec ? "按下快捷键…" : formatShortcut(binding)}
                      </kbd>
                      <div className="settings-shortcut-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setError("");
                            setRecording(isRec ? null : action.id);
                          }}
                        >
                          {isRec ? "取消" : "更改"}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          title="恢复该项默认"
                          onClick={() => {
                            setRecording(null);
                            setBinding(action.id, DEFAULT_SHORTCUTS[action.id]);
                          }}
                        >
                          默认
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {error ? <div className="settings-error">{error}</div> : null}
            </section>
          )}
        </div>

        <div className="settings-footer">
          <button
            type="button"
            className="btn-secondary"
            disabled={Boolean(recording)}
            onClick={() => {
              setDraft(structuredClone(DEFAULT_SETTINGS));
              setError("");
              setRecording(null);
            }}
          >
            全部恢复默认
          </button>
          <div className="settings-footer-right">
            <button
              type="button"
              className="btn-secondary"
              disabled={Boolean(recording)}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={Boolean(recording)}
              onClick={() =>
                onSave({
                  ...draft,
                  autoReconnectMaxAttempts: Math.min(
                    AUTO_RECONNECT_MAX_ATTEMPTS_MAX,
                    Math.max(
                      AUTO_RECONNECT_MAX_ATTEMPTS_MIN,
                      Math.floor(draft.autoReconnectMaxAttempts) ||
                        DEFAULT_SETTINGS.autoReconnectMaxAttempts,
                    ),
                  ),
                })
              }
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
