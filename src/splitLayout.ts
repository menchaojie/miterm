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

export type PaneNavDirection = "left" | "right" | "up" | "down";

type LeafRect = {
  sessionId: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** 按分割树把各叶映射到 [0,1]×[0,1] 矩形（vertical=左右，horizontal=上下） */
export function collectLeafRects(
  layout: FolderLayout,
  x = 0,
  y = 0,
  w = 1,
  h = 1,
): LeafRect[] {
  if (layout.type === "leaf") {
    return [{ sessionId: layout.sessionId, x, y, w, h }];
  }
  if (layout.direction === "vertical") {
    const leftW = w * layout.ratio;
    return [
      ...collectLeafRects(layout.first, x, y, leftW, h),
      ...collectLeafRects(layout.second, x + leftW, y, w - leftW, h),
    ];
  }
  const topH = h * layout.ratio;
  return [
    ...collectLeafRects(layout.first, x, y, w, topH),
    ...collectLeafRects(layout.second, x, y + topH, w, h - topH),
  ];
}

function rangesOverlap(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): boolean {
  return a0 < b1 - 1e-6 && b0 < a1 - 1e-6;
}

/**
 * 在分屏树中按方向找相邻窗格。
 * 优先选与当前叶在垂直轴上有重叠、且在该方向上间隙最小的叶。
 */
export function findNeighborSessionId(
  layout: FolderLayout,
  focusedSessionId: string,
  direction: PaneNavDirection,
): string | null {
  const rects = collectLeafRects(layout);
  if (rects.length < 2) return null;
  const focused = rects.find((r) => r.sessionId === focusedSessionId);
  if (!focused) return null;

  const fcx = focused.x + focused.w / 2;
  const fcy = focused.y + focused.h / 2;
  type Cand = { id: string; gap: number; cross: number; overlap: boolean };
  const cands: Cand[] = [];

  for (const r of rects) {
    if (r.sessionId === focused.sessionId) continue;
    const rcx = r.x + r.w / 2;
    const rcy = r.y + r.h / 2;

    if (direction === "left") {
      if (rcx >= fcx - 1e-6) continue;
      cands.push({
        id: r.sessionId,
        gap: focused.x - (r.x + r.w),
        cross: Math.abs(fcy - rcy),
        overlap: rangesOverlap(
          focused.y,
          focused.y + focused.h,
          r.y,
          r.y + r.h,
        ),
      });
    } else if (direction === "right") {
      if (rcx <= fcx + 1e-6) continue;
      cands.push({
        id: r.sessionId,
        gap: r.x - (focused.x + focused.w),
        cross: Math.abs(fcy - rcy),
        overlap: rangesOverlap(
          focused.y,
          focused.y + focused.h,
          r.y,
          r.y + r.h,
        ),
      });
    } else if (direction === "up") {
      if (rcy >= fcy - 1e-6) continue;
      cands.push({
        id: r.sessionId,
        gap: focused.y - (r.y + r.h),
        cross: Math.abs(fcx - rcx),
        overlap: rangesOverlap(
          focused.x,
          focused.x + focused.w,
          r.x,
          r.x + r.w,
        ),
      });
    } else {
      if (rcy <= fcy + 1e-6) continue;
      cands.push({
        id: r.sessionId,
        gap: r.y - (focused.y + focused.h),
        cross: Math.abs(fcx - rcx),
        overlap: rangesOverlap(
          focused.x,
          focused.x + focused.w,
          r.x,
          r.x + r.w,
        ),
      });
    }
  }

  if (cands.length === 0) return null;
  const preferred = cands.filter((c) => c.overlap);
  const pool = preferred.length > 0 ? preferred : cands;
  pool.sort((a, b) => {
    const ga = Math.max(0, a.gap);
    const gb = Math.max(0, b.gap);
    if (Math.abs(ga - gb) > 1e-9) return ga - gb;
    return a.cross - b.cross;
  });
  return pool[0]?.id ?? null;
}

/** 并发网格：按行列方向找邻居（与 CSS grid 排布一致） */
export function findNeighborInGrid(
  sessionIds: string[],
  focusedSessionId: string,
  direction: PaneNavDirection,
  cols: number,
): string | null {
  const n = sessionIds.length;
  if (n < 2 || cols < 1) return null;
  const idx = sessionIds.indexOf(focusedSessionId);
  if (idx < 0) return null;
  const row = Math.floor(idx / cols);
  const col = idx % cols;
  const rows = Math.ceil(n / cols);

  let nextRow = row;
  let nextCol = col;
  if (direction === "left") nextCol = col - 1;
  else if (direction === "right") nextCol = col + 1;
  else if (direction === "up") nextRow = row - 1;
  else nextRow = row + 1;

  if (nextRow < 0 || nextCol < 0 || nextRow >= rows || nextCol >= cols) {
    return null;
  }
  const nextIdx = nextRow * cols + nextCol;
  if (nextIdx < 0 || nextIdx >= n) return null;
  return sessionIds[nextIdx] ?? null;
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

/**
 * 将 target 叶拆成田字四格：
 * vertical → 左列 horizontal(原, a) | 右列 horizontal(b, c)
 */
export function quadSplitLeaf(
  layout: FolderLayout,
  targetSessionId: string,
  newIds: [string, string, string],
): FolderLayout {
  const [idA, idB, idC] = newIds;
  if (layout.type === "leaf") {
    if (layout.sessionId !== targetSessionId) return layout;
    return {
      type: "split",
      id: newSplitId(),
      direction: "vertical",
      ratio: 0.5,
      first: {
        type: "split",
        id: newSplitId(),
        direction: "horizontal",
        ratio: 0.5,
        first: layout,
        second: leafLayout(idA),
      },
      second: {
        type: "split",
        id: newSplitId(),
        direction: "horizontal",
        ratio: 0.5,
        first: leafLayout(idB),
        second: leafLayout(idC),
      },
    };
  }
  return {
    ...layout,
    first: quadSplitLeaf(layout.first, targetSessionId, newIds),
    second: quadSplitLeaf(layout.second, targetSessionId, newIds),
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

/** 汇总多个二级 Tab 布局中的全部 session */
export function collectSubTabsSessionIds(
  subTabs: { layout: FolderLayout }[],
): string[] {
  const ids: string[] = [];
  for (const tab of subTabs) {
    ids.push(...collectLayoutSessionIds(tab.layout));
  }
  return ids;
}

/** 在指定二级 Tab 上更新 layout */
export function mapSubTabLayout<T extends { id: string; layout: FolderLayout }>(
  subTabs: T[],
  subTabId: string,
  map: (layout: FolderLayout) => FolderLayout,
): T[] {
  return subTabs.map((t) =>
    t.id === subTabId ? { ...t, layout: map(t.layout) } : t,
  );
}
