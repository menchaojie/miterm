import { useRef } from "react";
import {
  CURSOR_COLOR,
  CURSOR_DIM,
  useSshTerminal,
  type TerminalCursorStyle,
} from "../hooks/useSshTerminal";
import type { ConnectionStatus } from "../types";
import "xterm/css/xterm.css";

interface TerminalViewProps {
  sessionId: string;
  status: ConnectionStatus;
  /** 是否在可见分格中（需 fit / 显示） */
  visible: boolean;
  /** 是否拥有键盘焦点 */
  focused: boolean;
  /** 分屏拖动等布局变化时递增，触发 resize */
  layoutEpoch?: number;
  /** 终端字号（px） */
  fontSize?: number;
  /** 自定义输入处理（并发同步输入） */
  onUserInput?: (data: string) => void;
  cursorStyle?: TerminalCursorStyle;
  cursorBlink?: boolean;
  /** 光标颜色；暗淡 block 可用更暗色 */
  cursorColor?: string;
  systemNotice?: { seq: number; text: string } | null;
  /** 会话已退出 / 重连失败时显示手动重连 */
  onReconnect?: () => void;
  onCwdChange?: (cwd: string | null) => void;
  homeHint?: string | null;
  initialCwd?: string | null;
}

export function TerminalView({
  sessionId,
  status,
  visible,
  focused,
  layoutEpoch = 0,
  fontSize = 14,
  onUserInput,
  cursorStyle = "bar",
  cursorBlink = true,
  cursorColor = CURSOR_COLOR,
  systemNotice = null,
  onReconnect,
  onCwdChange,
  homeHint = null,
  initialCwd = null,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useSshTerminal(
    containerRef,
    sessionId,
    status,
    visible,
    focused,
    layoutEpoch,
    onUserInput,
    cursorStyle,
    cursorBlink,
    cursorColor,
    systemNotice,
    onCwdChange,
    homeHint,
    initialCwd,
    fontSize,
  );

  const interactive = status === "connected";
  const showReconnect =
    Boolean(onReconnect) &&
    (status === "exited" || status === "error");

  return (
    <div className="terminal-view-wrap">
      <div
        ref={containerRef}
        className={`terminal-container${interactive ? "" : " terminal-disabled"}`}
      />
      {showReconnect ? (
        <div className="terminal-reconnect-bar">
          <span className="terminal-reconnect-text">会话已断开</span>
          <button
            type="button"
            className="terminal-reconnect-btn"
            onClick={onReconnect}
          >
            重新连接
          </button>
        </div>
      ) : null}
    </div>
  );
}

export { CURSOR_COLOR, CURSOR_DIM };
