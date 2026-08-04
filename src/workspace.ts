import { invoke } from "@tauri-apps/api/core";
import type { FolderLayout } from "./splitLayout";
import { countLayoutLeaves } from "./splitLayout";
import type {
  ConcurrentGroup,
  HostFolder,
  SavedHost,
  SessionTab,
} from "./types";

export type WorkspaceKind = "folder" | "group";

export interface SavedWorkspaceRow {
  id: number;
  name: string;
  kind: WorkspaceKind;
  payload: string;
  updatedAt: number;
}

/** 持久化布局：leaf 存 savedHostId + cwd，不存瞬时 sessionId */
export type PersistedLayout =
  | { type: "leaf"; savedHostId: number; cwd?: string | null }
  | {
      type: "split";
      direction: "vertical" | "horizontal";
      ratio: number;
      first: PersistedLayout;
      second: PersistedLayout;
    };

export type FolderWorkspacePayload = {
  kind: "folder";
  savedHostId: number;
  baseTitle?: string;
  subTabs: { layout: PersistedLayout }[];
  activeSubTabIndex: number;
  /** 活动叶在活动 subTab 布局中的序号 */
  activeLeafIndex?: number;
};

export type GroupWorkspacePayload = {
  kind: "group";
  members: { savedHostId: number; cwd?: string | null }[];
  focusedIndex?: number;
};

export type WorkspacePayload = FolderWorkspacePayload | GroupWorkspacePayload;

export function parseWorkspacePayload(raw: string): WorkspacePayload | null {
  try {
    const data = JSON.parse(raw) as WorkspacePayload;
    if (data?.kind === "folder" || data?.kind === "group") return data;
    return null;
  } catch {
    return null;
  }
}

export function layoutPaneCount(payload: WorkspacePayload): number {
  if (payload.kind === "group") return payload.members.length;
  let n = 0;
  for (const st of payload.subTabs) {
    n += countPersistedLeaves(st.layout);
  }
  return n;
}

function countPersistedLeaves(layout: PersistedLayout): number {
  if (layout.type === "leaf") return 1;
  return (
    countPersistedLeaves(layout.first) + countPersistedLeaves(layout.second)
  );
}

export function persistLayout(
  layout: FolderLayout,
  sessionsById: Map<string, SessionTab>,
  fallbackHostId: number,
): PersistedLayout {
  if (layout.type === "leaf") {
    const tab = sessionsById.get(layout.sessionId);
    return {
      type: "leaf",
      savedHostId: tab?.savedHostId ?? fallbackHostId,
      cwd: tab?.cwd ?? null,
    };
  }
  return {
    type: "split",
    direction: layout.direction,
    ratio: layout.ratio,
    first: persistLayout(layout.first, sessionsById, fallbackHostId),
    second: persistLayout(layout.second, sessionsById, fallbackHostId),
  };
}

export function serializeFolderWorkspace(
  folder: HostFolder,
  sessions: SessionTab[],
): FolderWorkspacePayload {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const activeIdx = Math.max(
    0,
    folder.subTabs.findIndex((t) => t.id === folder.activeSubTabId),
  );
  const activeSub = folder.subTabs[activeIdx] ?? folder.subTabs[0];
  const liveLeafIds = activeSub ? collectLiveLeafIds(activeSub.layout) : [];
  const activeLeafIndex = Math.max(0, liveLeafIds.indexOf(folder.activeSessionId));

  return {
    kind: "folder",
    savedHostId: folder.savedHostId,
    baseTitle: folder.baseTitle,
    subTabs: folder.subTabs.map((st) => ({
      layout: persistLayout(st.layout, byId, folder.savedHostId),
    })),
    activeSubTabIndex: activeIdx,
    activeLeafIndex: activeLeafIndex >= 0 ? activeLeafIndex : 0,
  };
}

function collectLiveLeafIds(layout: FolderLayout): string[] {
  if (layout.type === "leaf") return [layout.sessionId];
  return [
    ...collectLiveLeafIds(layout.first),
    ...collectLiveLeafIds(layout.second),
  ];
}

export function serializeGroupWorkspace(
  group: ConcurrentGroup,
  sessions: SessionTab[],
): GroupWorkspacePayload | null {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const members: { savedHostId: number; cwd?: string | null }[] = [];
  for (const sid of group.sessionIds) {
    const tab = byId.get(sid);
    if (!tab?.savedHostId) continue;
    members.push({ savedHostId: tab.savedHostId, cwd: tab.cwd ?? null });
  }
  if (members.length < 2) return null;
  const focusedIndex = group.focusedSessionId
    ? Math.max(0, group.sessionIds.indexOf(group.focusedSessionId))
    : 0;
  return {
    kind: "group",
    members,
    focusedIndex,
  };
}

/** 将持久化布局还原为 FolderLayout，并返回 leaf 顺序对应的 session 元数据 */
export function hydrateLayout(
  layout: PersistedLayout,
  alloc: (savedHostId: number, cwd: string | null | undefined) => string,
): { layout: FolderLayout; leafSessionIds: string[] } {
  if (layout.type === "leaf") {
    const id = alloc(layout.savedHostId, layout.cwd);
    return { layout: { type: "leaf", sessionId: id }, leafSessionIds: [id] };
  }
  const first = hydrateLayout(layout.first, alloc);
  const second = hydrateLayout(layout.second, alloc);
  const splitId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? `split-${crypto.randomUUID()}`
      : `split-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    layout: {
      type: "split",
      id: splitId,
      direction: layout.direction,
      ratio: layout.ratio,
      first: first.layout,
      second: second.layout,
    },
    leafSessionIds: [...first.leafSessionIds, ...second.leafSessionIds],
  };
}

export function workspaceSummaryLabel(
  row: SavedWorkspaceRow,
  payload: WorkspacePayload | null,
): string {
  if (!payload) return row.kind === "group" ? "并发" : "主机夹";
  if (payload.kind === "group") {
    return `并发 · ${payload.members.length} 台`;
  }
  const panes = layoutPaneCount(payload);
  const tabs = payload.subTabs.length;
  if (tabs > 1) return `主机夹 · ${tabs} 页 · ${panes} 窗格`;
  return panes > 1 ? `主机夹 · ${panes} 窗格` : "主机夹 · 单窗";
}

export async function listWorkspaces(): Promise<SavedWorkspaceRow[]> {
  const rows = await invoke<SavedWorkspaceRow[]>("list_workspaces");
  return rows.map((r) => ({
    ...r,
    kind: r.kind === "group" ? "group" : "folder",
  }));
}

export async function saveWorkspaceRow(params: {
  name: string;
  kind: WorkspaceKind;
  payload: string;
}): Promise<SavedWorkspaceRow> {
  return invoke("save_workspace", { params });
}

export async function updateWorkspaceRow(params: {
  id: number;
  name: string;
  kind: WorkspaceKind;
  payload: string;
}): Promise<SavedWorkspaceRow> {
  return invoke("update_workspace", { params });
}

export async function deleteWorkspaceRow(id: number): Promise<void> {
  await invoke("delete_workspace", { id });
}

export function resolveHostsForPayload(
  payload: WorkspacePayload,
  savedHosts: SavedHost[],
): { ok: true } | { ok: false; missing: number[] } {
  const ids = new Set<number>();
  if (payload.kind === "folder") {
    ids.add(payload.savedHostId);
    const walk = (lay: PersistedLayout) => {
      if (lay.type === "leaf") ids.add(lay.savedHostId);
      else {
        walk(lay.first);
        walk(lay.second);
      }
    };
    for (const st of payload.subTabs) walk(st.layout);
  } else {
    for (const m of payload.members) ids.add(m.savedHostId);
  }
  const missing = [...ids].filter((id) => !savedHosts.some((h) => h.id === id));
  if (missing.length) return { ok: false, missing };
  return { ok: true };
}

export function folderLivePaneCount(folder: HostFolder): number {
  return folder.subTabs.reduce((n, st) => n + countLayoutLeaves(st.layout), 0);
}
