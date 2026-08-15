import type { Category } from "./types";

/** 分组键：命名分类 id，或未分类 */
export type CategoryGroupKey = number | "uncategorized";

export interface CategoryGroup<T> {
  key: CategoryGroupKey;
  /** 命名分类；未分类为 null */
  category: Category | null;
  label: string;
  items: T[];
}

/** 按分类 sortOrder 分组；未分类置末；孤儿 categoryId 归入未分类 */
export function buildCategoryGroups<T>(
  categories: Category[],
  items: T[],
  getCategoryId: (item: T) => number | null,
): CategoryGroup<T>[] {
  const buckets = new Map<number, T[]>();
  for (const c of categories) buckets.set(c.id, []);
  const uncategorized: T[] = [];

  for (const item of items) {
    const id = getCategoryId(item);
    if (id != null && buckets.has(id)) {
      buckets.get(id)!.push(item);
    } else {
      uncategorized.push(item);
    }
  }

  const groups: CategoryGroup<T>[] = categories.map((c) => ({
    key: c.id,
    category: c,
    label: c.name,
    items: buckets.get(c.id) ?? [],
  }));

  groups.push({
    key: "uncategorized",
    category: null,
    label: "未分类",
    items: uncategorized,
  });

  return groups;
}

export function categoryGroupKeyString(key: CategoryGroupKey): string {
  return String(key);
}

/** 折叠集合：键在集合内表示已折叠（默认展开） */
export function loadCollapsedGroupKeys(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(String));
  } catch {
    return new Set();
  }
}

export function saveCollapsedGroupKeys(
  storageKey: string,
  collapsed: Set<string>,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
  } catch {
    /* ignore */
  }
}

export function isGroupCollapsed(
  collapsed: Set<string>,
  key: CategoryGroupKey,
): boolean {
  return collapsed.has(categoryGroupKeyString(key));
}

export function toggleCollapsedGroupKey(
  prev: Set<string>,
  key: CategoryGroupKey,
): Set<string> {
  const k = categoryGroupKeyString(key);
  const next = new Set(prev);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  return next;
}
