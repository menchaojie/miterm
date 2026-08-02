/** 垂直分割 = 左右；水平分割 = 上下 */
export type SplitDirection = "vertical" | "horizontal";

export type FolderLayout =
  | { type: "leaf"; sessionId: string }
  | {
      type: "split";
      id: string;
      direction: SplitDirection;
      /** first 占比，0.2～0.8 */
      ratio: number;
      first: FolderLayout;
      second: FolderLayout;
    };

export function newSplitId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `split-${crypto.randomUUID()}`;
  }
  return `split-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function leafLayout(sessionId: string): FolderLayout {
  return { type: "leaf", sessionId };
}

export function collectLayoutSessionIds(layout: FolderLayout): string[] {
  if (layout.type === "leaf") return [layout.sessionId];
  return [
    ...collectLayoutSessionIds(layout.first),
    ...collectLayoutSessionIds(layout.second),
  ];
}

export function layoutContainsSession(
  layout: FolderLayout,
  sessionId: string,
): boolean {
  if (layout.type === "leaf") return layout.sessionId === sessionId;
  return (
    layoutContainsSession(layout.first, sessionId) ||
    layoutContainsSession(layout.second, sessionId)
  );
}

export function countLayoutLeaves(layout: FolderLayout): number {
  if (layout.type === "leaf") return 1;
  return countLayoutLeaves(layout.first) + countLayoutLeaves(layout.second);
}

/** 将 target 叶节点拆成 split(first=原叶, second=新叶) */
export function splitLeaf(
  layout: FolderLayout,
  targetSessionId: string,
  newSessionId: string,
  direction: SplitDirection,
): FolderLayout {
  if (layout.type === "leaf") {
    if (layout.sessionId !== targetSessionId) return layout;
    return {
      type: "split",
      id: newSplitId(),
      direction,
      ratio: 0.5,
      first: layout,
      second: leafLayout(newSessionId),
    };
  }
  return {
    ...layout,
    first: splitLeaf(layout.first, targetSessionId, newSessionId, direction),
    second: splitLeaf(layout.second, targetSessionId, newSessionId, direction),
  };
}

/** 从布局中移除会话；若整棵树空则返回 null；split 只剩一侧时提升 */
export function removeSessionFromLayout(
  layout: FolderLayout,
  sessionId: string,
): FolderLayout | null {
  if (layout.type === "leaf") {
    return layout.sessionId === sessionId ? null : layout;
  }
  const first = removeSessionFromLayout(layout.first, sessionId);
  const second = removeSessionFromLayout(layout.second, sessionId);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}

/** 将焦点叶上的 session 换成 another（用于子 Tab 点到未入布局的会话） */
export function replaceLeafSession(
  layout: FolderLayout,
  focusedSessionId: string,
  nextSessionId: string,
): FolderLayout {
  if (layout.type === "leaf") {
    if (layout.sessionId !== focusedSessionId) return layout;
    return { type: "leaf", sessionId: nextSessionId };
  }
  return {
    ...layout,
    first: replaceLeafSession(layout.first, focusedSessionId, nextSessionId),
    second: replaceLeafSession(layout.second, focusedSessionId, nextSessionId),
  };
}

/** 单叶时同步为当前激活会话（Tab 模式） */
export function syncLeafToActive(
  layout: FolderLayout | undefined,
  activeSessionId: string,
): FolderLayout {
  if (!layout) return leafLayout(activeSessionId);
  if (layout.type === "leaf") return leafLayout(activeSessionId);
  return layout;
}

export function setSplitRatio(
  layout: FolderLayout,
  splitId: string,
  ratio: number,
): FolderLayout {
  const clamped = Math.min(0.8, Math.max(0.2, ratio));
  if (layout.type === "leaf") return layout;
  if (layout.id === splitId) {
    return { ...layout, ratio: clamped };
  }
  return {
    ...layout,
    first: setSplitRatio(layout.first, splitId, clamped),
    second: setSplitRatio(layout.second, splitId, clamped),
  };
}

export function ensureFolderLayout(
  layout: FolderLayout | undefined,
  activeSessionId: string,
): FolderLayout {
  return layout ?? leafLayout(activeSessionId);
}
