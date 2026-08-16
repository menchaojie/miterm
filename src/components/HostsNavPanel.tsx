import { useMemo } from "react";
import type { Category, CategoryFilter, SavedHost } from "../types";
import {
  IconFolder,
  IconRename,
  IconTrash,
} from "./CatTreeIcons";

export interface HostsNavPanelProps {
  hosts: SavedHost[];
  categories: Category[];
  selectedFilter: CategoryFilter;
  onSelectFilter: (filter: CategoryFilter) => void;
  onAddCategory: () => void;
  onRenameCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onAddHost: () => void;
}

function filterKey(filter: CategoryFilter): string {
  return String(filter);
}

export function HostsNavPanel({
  hosts,
  categories,
  selectedFilter,
  onSelectFilter,
  onAddCategory,
  onRenameCategory,
  onDeleteCategory,
  onAddHost,
}: HostsNavPanelProps) {
  const uncategorizedCount = useMemo(
    () => hosts.filter((h) => h.categoryId == null).length,
    [hosts],
  );

  const countByCategory = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of categories) map.set(c.id, 0);
    for (const h of hosts) {
      if (h.categoryId != null && map.has(h.categoryId)) {
        map.set(h.categoryId, (map.get(h.categoryId) ?? 0) + 1);
      }
    }
    return map;
  }, [categories, hosts]);

  return (
    <div className="workspace-list-pane hosts-nav-pane">
      <div className="workspace-list-toolbar">
        <button
          type="button"
          className="btn-primary workspace-save-btn"
          onClick={onAddHost}
          title="增加主机"
        >
          增加主机
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onAddCategory}
          title="新建分类"
        >
          新建分类
        </button>
      </div>

      <ul className="hosts-nav-list" role="listbox" aria-label="主机分类">
        <li>
          <button
            type="button"
            role="option"
            aria-selected={selectedFilter === "all"}
            className={`hosts-nav-item${selectedFilter === "all" ? " is-active" : ""}`}
            onClick={() => onSelectFilter("all")}
          >
            <IconFolder open={selectedFilter === "all"} />
            <span className="hosts-nav-label">全部</span>
            <span className="hosts-nav-count">{hosts.length}</span>
          </button>
        </li>

        {categories.map((cat) => {
          const active = selectedFilter === cat.id;
          const count = countByCategory.get(cat.id) ?? 0;
          return (
            <li key={cat.id}>
              <div
                className={`hosts-nav-row${active ? " is-active" : ""}`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className="hosts-nav-item"
                  onClick={() => onSelectFilter(cat.id)}
                >
                  <IconFolder open={active} />
                  <span className="hosts-nav-label">{cat.name}</span>
                  <span className="hosts-nav-count">{count}</span>
                </button>
                <div className="hosts-nav-actions">
                  <button
                    type="button"
                    className="cat-tree-group-btn"
                    title="重命名分类"
                    aria-label={`重命名分类 ${cat.name}`}
                    onClick={() => onRenameCategory(cat)}
                  >
                    <IconRename />
                  </button>
                  <button
                    type="button"
                    className="cat-tree-group-btn is-danger"
                    title="删除分类"
                    aria-label={`删除分类 ${cat.name}`}
                    onClick={() => onDeleteCategory(cat)}
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            </li>
          );
        })}

        <li>
          <button
            type="button"
            role="option"
            aria-selected={selectedFilter === "uncategorized"}
            className={`hosts-nav-item${
              selectedFilter === "uncategorized" ? " is-active" : ""
            }`}
            onClick={() => onSelectFilter("uncategorized")}
          >
            <IconFolder open={selectedFilter === "uncategorized"} />
            <span className="hosts-nav-label">未分类</span>
            <span className="hosts-nav-count">{uncategorizedCount}</span>
          </button>
        </li>
      </ul>

      <p className="hosts-nav-hint" data-filter={filterKey(selectedFilter)}>
        点击分类筛选右侧列表；悬停分类可重命名或删除。
      </p>
    </div>
  );
}
