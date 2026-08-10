import type { LocalShellKind } from "./types";

export type { LocalShellKind };

export type ShortcutBinding = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** 规范化后的键名，如 "tab" | "1" | "pageup" | "arrowleft" */
  key: string;
};

export type ShortcutActionId =
  | "previousTab"
  | "nextTab"
  | "previousPane"
  | "nextPane"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "toggleAllSync"
  | "hostsTab"
  | "tab2"
  | "tab3"
  | "tab4"
  | "tab5"
  | "tab6"
  | "tab7"
  | "tab8"
  | "tab9"
  | "toggleRemoteFiles";

export type ShortcutMap = Record<ShortcutActionId, ShortcutBinding>;

/** 设置弹窗顶部分组 Tab */
export type SettingsTabId =
  | "connection"
  | "shortcutsNav"
  | "shortcutsPane"
  | "shortcutsFiles";

export const SETTINGS_TABS: { id: SettingsTabId; label: string }[] = [
  { id: "connection", label: "连接" },
  { id: "shortcutsNav", label: "Tab 导航" },
  { id: "shortcutsPane", label: "窗格" },
  { id: "shortcutsFiles", label: "远程文件" },
];

export type AppSettings = {
  shortcuts: ShortcutMap;
  /** 异常断线时自动重连（exit / 主动关 Tab 不自动重连） */
  autoReconnect: boolean;
  /** 自动重连最大次数 */
  autoReconnectMaxAttempts: number;
  /** Ctrl/Cmd + 滚轮缩放终端字体 */
  ctrlWheelZoom: boolean;
  /** 终端字号（px），全局共用 */
  terminalFontSize: number;
};

export const LOCAL_SHELL_OPTIONS: {
  kind: LocalShellKind;
  label: string;
  hint?: string;
  /** 非系统 shell，编辑时需/可填路径 */
  pathEditable?: boolean;
}[] = [
  {
    kind: "powershell",
    label: "PowerShell",
    hint: "优先自动检测 pwsh / Windows PowerShell",
  },
  { kind: "cmd", label: "命令提示符 (cmd)", hint: "使用系统 ComSpec" },
  {
    kind: "gitbash",
    label: "Git Bash",
    hint: "可填写 bash.exe 完整路径",
    pathEditable: true,
  },
  {
    kind: "custom",
    label: "自定义路径",
    hint: "填写可执行文件完整路径",
    pathEditable: true,
  },
];

export function isLocalShellKind(v: unknown): v is LocalShellKind {
  return (
    v === "powershell" || v === "cmd" || v === "gitbash" || v === "custom"
  );
}

export function localShellLabel(kind: string): string {
  return LOCAL_SHELL_OPTIONS.find((o) => o.kind === kind)?.label ?? kind;
}

export function shellNeedsPath(kind: LocalShellKind): boolean {
  return Boolean(
    LOCAL_SHELL_OPTIONS.find((o) => o.kind === kind)?.pathEditable,
  );
}

export const SHORTCUT_ACTIONS: {
  id: ShortcutActionId;
  label: string;
  hint?: string;
  /** 设置页所属分组 */
  tab: SettingsTabId;
}[] = [
  {
    id: "previousTab",
    label: "上一个会话 Tab",
    hint: "仅在会话 Tab 间循环（不含主机列表）",
    tab: "shortcutsNav",
  },
  {
    id: "nextTab",
    label: "下一个会话 Tab",
    hint: "仅在会话 Tab 间循环（不含主机列表）",
    tab: "shortcutsNav",
  },
  {
    id: "hostsTab",
    label: "主机列表",
    hint: "默认对应第 1 个 Tab（Ctrl+1）",
    tab: "shortcutsNav",
  },
  { id: "tab2", label: "第 2 个 Tab", tab: "shortcutsNav" },
  { id: "tab3", label: "第 3 个 Tab", tab: "shortcutsNav" },
  { id: "tab4", label: "第 4 个 Tab", tab: "shortcutsNav" },
  { id: "tab5", label: "第 5 个 Tab", tab: "shortcutsNav" },
  { id: "tab6", label: "第 6 个 Tab", tab: "shortcutsNav" },
  { id: "tab7", label: "第 7 个 Tab", tab: "shortcutsNav" },
  { id: "tab8", label: "第 8 个 Tab", tab: "shortcutsNav" },
  { id: "tab9", label: "第 9 个 Tab", tab: "shortcutsNav" },
  {
    id: "previousPane",
    label: "上一窗格 / 二级会话",
    hint: "并发组窗格或主机夹二级会话",
    tab: "shortcutsPane",
  },
  {
    id: "nextPane",
    label: "下一窗格 / 二级会话",
    hint: "并发组窗格或主机夹二级会话",
    tab: "shortcutsPane",
  },
  {
    id: "focusPaneLeft",
    label: "聚焦左侧窗格",
    hint: "按布局方向移动焦点",
    tab: "shortcutsPane",
  },
  {
    id: "focusPaneRight",
    label: "聚焦右侧窗格",
    tab: "shortcutsPane",
  },
  {
    id: "focusPaneUp",
    label: "聚焦上方窗格",
    tab: "shortcutsPane",
  },
  {
    id: "focusPaneDown",
    label: "聚焦下方窗格",
    tab: "shortcutsPane",
  },
  {
    id: "toggleAllSync",
    label: "全部加入/退出并发输入",
    hint: "在分屏或并发组内交替：全选 ↔ 全部取消",
    tab: "shortcutsPane",
  },
  {
    id: "toggleRemoteFiles",
    label: "打开/关闭侧栏",
    hint: "工作区 / 远程文件 / 命令；默认 Ctrl+Shift+E",
    tab: "shortcutsFiles",
  },
];

const STORAGE_KEY = "miterm.settings.v1";
const LEGACY_STORAGE_KEY = "miterminal.settings.v1";

function binding(
  key: string,
  mods: Partial<Omit<ShortcutBinding, "key">> = {},
): ShortcutBinding {
  return {
    ctrl: Boolean(mods.ctrl),
    alt: Boolean(mods.alt),
    shift: Boolean(mods.shift),
    meta: Boolean(mods.meta),
    key,
  };
}

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  previousTab: binding("tab", { ctrl: true, shift: true }),
  nextTab: binding("tab", { ctrl: true }),
  previousPane: binding("[", { ctrl: true, shift: true }),
  nextPane: binding("]", { ctrl: true, shift: true }),
  focusPaneLeft: binding("arrowleft", { ctrl: true, alt: true }),
  focusPaneRight: binding("arrowright", { ctrl: true, alt: true }),
  focusPaneUp: binding("arrowup", { ctrl: true, alt: true }),
  focusPaneDown: binding("arrowdown", { ctrl: true, alt: true }),
  toggleAllSync: binding("space", { ctrl: true, shift: true }),
  hostsTab: binding("1", { ctrl: true }),
  tab2: binding("2", { ctrl: true }),
  tab3: binding("3", { ctrl: true }),
  tab4: binding("4", { ctrl: true }),
  tab5: binding("5", { ctrl: true }),
  tab6: binding("6", { ctrl: true }),
  tab7: binding("7", { ctrl: true }),
  tab8: binding("8", { ctrl: true }),
  tab9: binding("9", { ctrl: true }),
  toggleRemoteFiles: binding("e", { ctrl: true, shift: true }),
};

export const DEFAULT_SETTINGS: AppSettings = {
  shortcuts: { ...DEFAULT_SHORTCUTS },
  autoReconnect: true,
  autoReconnectMaxAttempts: 5,
  ctrlWheelZoom: true,
  terminalFontSize: 14,
};

export const AUTO_RECONNECT_MAX_ATTEMPTS_MIN = 1;
export const AUTO_RECONNECT_MAX_ATTEMPTS_MAX = 20;

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 28;

export function clampTerminalFontSize(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : NaN;
  if (!Number.isFinite(v)) return TERMINAL_FONT_SIZE_DEFAULT;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, v));
}

export function normalizeKey(key: string): string {
  if (key === " ") return "space";
  const lower = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  if (lower === "control" || lower === "ctrl") return "ctrl";
  if (lower === "alt" || lower === "option") return "alt";
  if (lower === "shift") return "shift";
  if (lower === "meta" || lower === "os") return "meta";
  return lower;
}

export function shortcutFromEvent(e: KeyboardEvent): ShortcutBinding | null {
  const key = normalizeKey(e.key);
  if (key === "ctrl" || key === "alt" || key === "shift" || key === "meta") {
    return null;
  }
  return {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    key,
  };
}

export function formatShortcut(s: ShortcutBinding): string {
  const parts: string[] = [];
  if (s.ctrl) parts.push("Ctrl");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  if (s.meta) parts.push("Meta");
  const keyLabel =
    s.key === " " || s.key === "space"
      ? "Space"
      : s.key === "tab"
        ? "Tab"
        : s.key === "pageup"
          ? "PageUp"
          : s.key === "pagedown"
            ? "PageDown"
            : s.key === "arrowleft"
              ? "←"
              : s.key === "arrowright"
                ? "→"
                : s.key === "arrowup"
                  ? "↑"
                  : s.key === "arrowdown"
                    ? "↓"
                    : s.key.length === 1
                      ? s.key.toUpperCase()
                      : s.key.charAt(0).toUpperCase() + s.key.slice(1);
  parts.push(keyLabel);
  return parts.join("+");
}

export function shortcutsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    a.key === b.key
  );
}

export function matchShortcut(
  e: KeyboardEvent,
  binding: ShortcutBinding,
): boolean {
  if (e.ctrlKey !== binding.ctrl) return false;
  if (e.altKey !== binding.alt) return false;
  if (e.shiftKey !== binding.shift) return false;
  if (e.metaKey !== binding.meta) return false;
  if (normalizeKey(e.key) === binding.key) return true;
  if (binding.key === "tab" && e.code === "Tab") return true;
  if (
    (binding.key === "space" || binding.key === " ") &&
    (e.code === "Space" || e.key === " " || e.key === "Spacebar")
  ) {
    return true;
  }
  // Ctrl+Shift+[ ] 时 key 常为 { }，用物理键码匹配
  if (
    binding.key === "[" &&
    (e.code === "BracketLeft" || e.key === "[" || e.key === "{")
  ) {
    return true;
  }
  if (
    binding.key === "]" &&
    (e.code === "BracketRight" || e.key === "]" || e.key === "}")
  ) {
    return true;
  }
  if (
    binding.key.length === 1 &&
    binding.key >= "0" &&
    binding.key <= "9" &&
    (e.code === `Digit${binding.key}` || e.code === `Numpad${binding.key}`)
  ) {
    return true;
  }
  // 字母键：终端焦点下 e.key 偶发不稳定，用物理键码兜底
  if (
    binding.key.length === 1 &&
    binding.key >= "a" &&
    binding.key <= "z" &&
    e.code === `Key${binding.key.toUpperCase()}`
  ) {
    return true;
  }
  return false;
}

function isShortcutBinding(v: unknown): v is ShortcutBinding {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ctrl === "boolean" &&
    typeof o.alt === "boolean" &&
    typeof o.shift === "boolean" &&
    typeof o.meta === "boolean" &&
    typeof o.key === "string" &&
    o.key.length > 0
  );
}

function clampReconnectAttempts(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : NaN;
  if (!Number.isFinite(v)) return DEFAULT_SETTINGS.autoReconnectMaxAttempts;
  return Math.min(
    AUTO_RECONNECT_MAX_ATTEMPTS_MAX,
    Math.max(AUTO_RECONNECT_MAX_ATTEMPTS_MIN, v),
  );
}

export function loadSettings(): AppSettings {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    let fromLegacy = false;
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      fromLegacy = Boolean(raw);
    }
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const shortcuts = { ...DEFAULT_SHORTCUTS };
    if (parsed.shortcuts && typeof parsed.shortcuts === "object") {
      for (const action of SHORTCUT_ACTIONS) {
        const cand = (parsed.shortcuts as Record<string, unknown>)[action.id];
        if (isShortcutBinding(cand)) {
          shortcuts[action.id] = cand;
        }
      }
    }
    const settings: AppSettings = {
      shortcuts,
      autoReconnect:
        typeof parsed.autoReconnect === "boolean"
          ? parsed.autoReconnect
          : DEFAULT_SETTINGS.autoReconnect,
      autoReconnectMaxAttempts: clampReconnectAttempts(
        parsed.autoReconnectMaxAttempts,
      ),
      ctrlWheelZoom:
        typeof parsed.ctrlWheelZoom === "boolean"
          ? parsed.ctrlWheelZoom
          : DEFAULT_SETTINGS.ctrlWheelZoom,
      terminalFontSize: clampTerminalFontSize(parsed.terminalFontSize),
    };
    if (fromLegacy) {
      saveSettings(settings);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return settings;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function findShortcutConflict(
  shortcuts: ShortcutMap,
  actionId: ShortcutActionId,
  binding: ShortcutBinding,
): ShortcutActionId | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === actionId) continue;
    if (shortcutsEqual(shortcuts[action.id], binding)) {
      return action.id;
    }
  }
  return null;
}

/** Tab / 窗格 / 面板动作分类 */
export function tabIndexForAction(
  action: ShortcutActionId,
):
  | number
  | "prev"
  | "next"
  | "prevPane"
  | "nextPane"
  | "toggleFiles"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown"
  | "toggleAllSync" {
  switch (action) {
    case "previousTab":
      return "prev";
    case "nextTab":
      return "next";
    case "previousPane":
      return "prevPane";
    case "nextPane":
      return "nextPane";
    case "focusPaneLeft":
      return "focusPaneLeft";
    case "focusPaneRight":
      return "focusPaneRight";
    case "focusPaneUp":
      return "focusPaneUp";
    case "focusPaneDown":
      return "focusPaneDown";
    case "toggleAllSync":
      return "toggleAllSync";
    case "toggleRemoteFiles":
      return "toggleFiles";
    case "hostsTab":
      return 0;
    case "tab2":
      return 1;
    case "tab3":
      return 2;
    case "tab4":
      return 3;
    case "tab5":
      return 4;
    case "tab6":
      return 5;
    case "tab7":
      return 6;
    case "tab8":
      return 7;
    case "tab9":
      return 8;
  }
}
