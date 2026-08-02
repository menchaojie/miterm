import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls() {
  const onMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (e) {
      console.error("minimize failed", e);
    }
  };

  const onToggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (e) {
      console.error("toggleMaximize failed", e);
    }
  };

  const onClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error("close failed", e);
    }
  };

  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-control window-control-min"
        title="最小化"
        aria-label="最小化"
        onClick={onMinimize}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control window-control-max"
        title="最大化"
        aria-label="最大化"
        onClick={onToggleMaximize}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <rect
            x="1.5"
            y="1.5"
            width="9"
            height="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          />
        </svg>
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        title="关闭"
        aria-label="关闭"
        onClick={onClose}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path
            d="M2 2l8 8M10 2L2 10"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
