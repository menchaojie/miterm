import type { FolderLayout } from "./splitLayout";

export type { FolderLayout, SplitDirection } from "./splitLayout";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "reconnecting"
  | "exited"
  | "error";

/** ssh-closed 原因：user=主动关闭；remote=对端退出；error=异常断线 */
export type SshCloseReason = "user" | "remote" | "error";

/** 固定的主机列表 Tab，不可关闭 */
export const HOSTS_TAB_ID = "hosts";

export type HostConnType = "ssh" | "local";

export type LocalShellKind = "powershell" | "cmd" | "gitbash" | "custom";

export interface Category {
  id: number;
  name: string;
  sortOrder: number;
}

export interface SavedHost {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  categoryId: number | null;
  lastUsedAt: number;
  connType: HostConnType;
  shell: string;
  shellPath: string;
}

export interface HostDraft {
  connType: HostConnType;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  categoryId: number | null;
  shell: LocalShellKind;
  shellPath: string;
}

export interface SessionTab {
  id: string;
  title: string;
  host: string;
  port: number;
  username: string;
  status: ConnectionStatus;
  errorMessage: string;
  /** ssh 远程或本地终端 */
  kind?: "ssh" | "local";
  /** 所属并发组；有值则不单独占一级 Tab */
  groupId?: string | null;
  /** 所属主机夹（一级 Tab）；与 groupId 互斥 */
  folderId?: string | null;
  /** 来源主机条目，用于同机再连 */
  savedHostId?: number | null;
  /** 写入终端的本地提示（seq 变化时追加一行） */
  systemNotice?: { seq: number; text: string } | null;
  /** 最近已知工作目录（OSC 7 / cd 跟踪），用于重连后恢复 */
  cwd?: string | null;
}

/** 主机夹：一级 Tab，内含多条同机二级会话 */
export interface HostFolder {
  id: string;
  savedHostId: number;
  /** 不含数量的标题 */
  baseTitle: string;
  sessionIds: string[];
  activeSessionId: string;
  /** 分屏布局；缺省视为单叶（当前激活会话全屏） */
  layout?: FolderLayout;
}

/** 并发会话 Tab（一组多主机同屏格子） */
export interface ConcurrentGroup {
  id: string;
  title: string;
  sessionIds: string[];
  focusedSessionId: string | null;
}

export interface SshOutputEvent {
  sessionId: string;
  data: number[];
}

export interface SshClosedEvent {
  sessionId: string;
  reason?: SshCloseReason;
}

/** 分类筛选：全部 / 未分类 / 具体分类 */
export type CategoryFilter = "all" | "uncategorized" | number;

export const emptyHostDraft = (
  categoryId: number | null = null,
  connType: HostConnType = "ssh",
): HostDraft => ({
  connType,
  name: connType === "local" ? "本地终端" : "",
  host: "127.0.0.1",
  port: "22",
  username: "",
  password: "",
  categoryId,
  shell: "powershell",
  shellPath: "",
});

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newGroupId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `grp-${crypto.randomUUID()}`;
  }
  return `grp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newFolderId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `fold-${crypto.randomUUID()}`;
  }
  return `fold-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function hostFolderTabTitle(
  baseTitle: string,
  count: number,
  activeIndex: number,
): string {
  return `${baseTitle}，共 ${count} 条，当前第 ${activeIndex} 条`;
}

export function isLocalHost(host: SavedHost): boolean {
  return host.connType === "local";
}

/**
 * 并发格子行列：在能放下 n 格的前提下，使 |cols-rows| 尽量小（接近 √n），
 * 同等时优先空位少，再优先横向更宽（cols >= rows）。
 * 例：2→2×1，3→2×2（末格横跨），4→2×2。
 */
export function concurrentGridDims(count: number): {
  cols: number;
  rows: number;
} {
  const n = Math.max(1, count);
  let best = { cols: n, rows: 1 };
  let bestScore = Number.POSITIVE_INFINITY;

  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const empty = cols * rows - n;
    const diff = Math.abs(cols - rows);
    const score = diff * 100 + empty * 10 + (cols < rows ? 1 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

/** 末行未铺满时，最后一格应横跨的列数（使底行连成一整块） */
export function concurrentLastCellColSpan(count: number, cols: number): number {
  const n = Math.max(1, count);
  if (cols <= 1 || n % cols === 0) return 1;
  return cols - (n % cols) + 1;
}
