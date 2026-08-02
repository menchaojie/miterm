import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  InputLineTracker,
  cwdAfterCommand,
  cwdFromPromptOutput,
  extractOsc7Payloads,
  parseOsc7Path,
} from "../cwd";
import type {
  ConnectionStatus,
  SshOutputEvent,
} from "../types";

const CURSOR_COLOR = "#4fc3f7";
/** 非输入态实心块：贴近底色，弱化存在感 */
const CURSOR_DIM = "#2c2c2c";

export type TerminalCursorStyle = "bar" | "block" | "underline";

export function useSshTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  sessionId: string,
  status: ConnectionStatus,
  visible: boolean,
  focused: boolean,
  layoutEpoch = 0,
  /** 若提供，则由外部决定写入哪些 session（用于并发同步输入） */
  onUserInput?: (data: string) => void,
  cursorStyle: TerminalCursorStyle = "bar",
  cursorBlink = true,
  cursorColor: string = CURSOR_COLOR,
  /** seq 变化时向终端追加一行本地提示 */
  systemNotice?: { seq: number; text: string } | null,
  /** 工作目录变化（OSC 7 或 cd 跟踪） */
  onCwdChange?: (cwd: string | null) => void,
  /** 相对 cd 的家目录兜底，如 /home/ubuntu */
  homeHint?: string | null,
  /** 会话已记录的 cwd（种子 / 重连前路径） */
  initialCwd?: string | null,
) {
  const connected = status === "connected";
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const statusRef = useRef(status);
  const sessionIdRef = useRef(sessionId);
  const visibleRef = useRef(visible);
  const onUserInputRef = useRef(onUserInput);
  const onCwdChangeRef = useRef(onCwdChange);
  const homeHintRef = useRef(homeHint ?? null);
  const cwdRef = useRef<string | null>(initialCwd ?? homeHint ?? null);
  const lineTrackerRef = useRef(new InputLineTracker());
  const promptScanBufRef = useRef("");
  const lastNoticeSeqRef = useRef(0);
  statusRef.current = status;
  sessionIdRef.current = sessionId;
  visibleRef.current = visible;
  onUserInputRef.current = onUserInput;
  onCwdChangeRef.current = onCwdChange;
  homeHintRef.current = homeHint ?? null;

  /**
   * source:
   * - cd / osc7：可信，始终采纳
   * - prompt：提示符猜测；若从「非家目录」突然变成家目录则忽略（敲命令时易误报 ~）
   * - null：不清除已有 cwd，避免面板回落到 ~/
   */
  const reportCwd = (
    next: string | null,
    source: "cd" | "osc7" | "prompt" = "osc7",
  ) => {
    if (next == null) return;
    if (next === cwdRef.current) return;
    const home = homeHintRef.current;
    if (
      source === "prompt" &&
      home &&
      next === home &&
      cwdRef.current &&
      cwdRef.current !== home
    ) {
      return;
    }
    cwdRef.current = next;
    onCwdChangeRef.current?.(next);
  };

  const trackTypedLines = (data: string) => {
    for (const { line, usedTab } of lineTrackerRef.current.push(data)) {
      // Tab 补全后本地只有前缀（如 cd ai），不能用来拼路径；等提示符 / OSC 校正
      if (usedTab) continue;
      reportCwd(
        cwdAfterCommand(cwdRef.current, line, homeHintRef.current),
        "cd",
      );
    }
  };

  const trackOutputForCwd = (bytes: number[]) => {
    const text = new TextDecoder().decode(Uint8Array.from(bytes));
    for (const payload of extractOsc7Payloads(text)) {
      const path = parseOsc7Path(payload);
      if (path) reportCwd(path, "osc7");
    }
    promptScanBufRef.current = (promptScanBufRef.current + text).slice(-4096);
    const fromPrompt = cwdFromPromptOutput(
      promptScanBufRef.current,
      homeHintRef.current,
    );
    if (fromPrompt) reportCwd(fromPrompt, "prompt");
  };

  /** 连接中 / 重连中即可收 MOTD；键盘输入仍须已连接。 */
  const isOutputAllowed = () => {
    const s = statusRef.current;
    return s === "connected" || s === "connecting" || s === "reconnecting";
  };
  const isInputAllowed = () => statusRef.current === "connected";

  const resetTerminal = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    terminal.clear();
    terminal.refresh(0, terminal.rows - 1);
  }, []);

  const scheduleTerminalReset = useCallback(() => {
    resetTerminal();
    window.setTimeout(() => resetTerminal(), 0);
    window.setTimeout(() => resetTerminal(), 50);
  }, [resetTerminal]);

  const resize = useCallback(async () => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!fitAddon || !terminal) return;

    fitAddon.fit();
    if (isOutputAllowed()) {
      await invoke("ssh_resize", {
        sessionId: sessionIdRef.current,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink,
      cursorStyle,
      cursorInactiveStyle: cursorStyle,
      cursorWidth: cursorStyle === "bar" ? 2 : 1,
      fontSize: 14,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: cursorColor,
        cursorAccent: "#1e1e1e",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    lastNoticeSeqRef.current = 0;
    lineTrackerRef.current.reset();
    promptScanBufRef.current = "";
    cwdRef.current = initialCwd ?? homeHint ?? null;
    if (cwdRef.current) {
      onCwdChangeRef.current?.(cwdRef.current);
    }

    // OSC 7：shell 上报当前目录（xterm 解析；原始流里也会再扫一遍）
    terminal.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7Path(data);
      if (path) reportCwd(path, "osc7");
      return true;
    });

    terminal.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (ev.ctrlKey && ev.code === "Tab") return false;
      if (
        ev.ctrlKey &&
        ev.shiftKey &&
        (ev.code === "BracketLeft" || ev.code === "BracketRight")
      ) {
        return false;
      }
      if (
        ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey &&
        /^Digit[1-9]$/.test(ev.code)
      ) {
        return false;
      }
      return true;
    });

    const onData = terminal.onData((data) => {
      if (!isInputAllowed()) return;
      trackTypedLines(data);
      if (onUserInputRef.current) {
        onUserInputRef.current(data);
        return;
      }
      const bytes = Array.from(new TextEncoder().encode(data));
      invoke("ssh_write", {
        sessionId: sessionIdRef.current,
        data: bytes,
      }).catch(console.error);
    });

    const unlistenOutput = listen<SshOutputEvent>("ssh-output", (event) => {
      if (event.payload.sessionId !== sessionIdRef.current) return;
      if (!isOutputAllowed()) return;
      trackOutputForCwd(event.payload.data);
      terminal.write(Uint8Array.from(event.payload.data));
    });

    const onWindowResize = () => {
      if (visibleRef.current) resize();
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      onData.dispose();
      unlistenOutput.then((fn) => fn());
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // cursor 样式在下方 effect 更新；此处仅创建终端
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, resize, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    // 仅全新连接清屏；重连保留历史并追加本地提示
    if (status === "connecting") {
      resetTerminal();
      lastNoticeSeqRef.current = 0;
      lineTrackerRef.current.reset();
      promptScanBufRef.current = "";
      return;
    }

    if (status === "disconnecting" || status === "idle") {
      scheduleTerminalReset();
      return;
    }

    if (
      status === "reconnecting" ||
      status === "exited" ||
      status === "error"
    ) {
      return;
    }

    if (!connected) return;

    const timer = window.setTimeout(() => {
      if (visible) resize();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [status, connected, visible, resize, resetTerminal, scheduleTerminalReset]);

  useEffect(() => {
    if (!systemNotice || systemNotice.seq === lastNoticeSeqRef.current) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    lastNoticeSeqRef.current = systemNotice.seq;
    terminal.writeln("");
    for (const raw of systemNotice.text.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      terminal.writeln(`\x1b[33m${line}\x1b[0m`);
    }
  }, [systemNotice]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      resize();
      if (focused && status === "connected") {
        terminalRef.current?.focus();
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [visible, focused, connected, status, resize, layoutEpoch]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.cursorInactiveStyle = cursorStyle;
    terminal.options.cursorWidth = cursorStyle === "bar" ? 2 : 1;
    terminal.options.theme = {
      ...terminal.options.theme,
      cursor: cursorColor,
      cursorAccent: "#1e1e1e",
    };
    terminal.refresh(0, terminal.rows - 1);
  }, [cursorBlink, cursorStyle, cursorColor]);

  return { resize };
}

export { CURSOR_COLOR, CURSOR_DIM };
