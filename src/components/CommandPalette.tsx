import { useEffect, useMemo, useRef, useState } from "react";
import type { Category } from "../types";
import { listCommandCategories } from "../domainCategories";
import {
  listSavedCommands,
  type SavedCommandRow,
} from "../savedCommands";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  canInject: boolean;
  injectDisabledReason?: string;
  onInject: (body: string, opts: { run: boolean }) => void;
}

function matchesQuery(row: SavedCommandRow, q: string): boolean {
  if (!q) return true;
  const hay = `${row.title}\n${row.body}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => hay.includes(part));
}

export function CommandPalette({
  open,
  onClose,
  canInject,
  injectDisabledReason,
  onInject,
}: CommandPaletteProps) {
  const [rows, setRows] = useState<SavedCommandRow[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setError("");
    setLoading(true);
    void Promise.all([listSavedCommands(), listCommandCategories()])
      .then(([list, cats]) => {
        setRows(list);
        setCategories(cats);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const filtered = useMemo(
    () => rows.filter((r) => matchesQuery(r, query.trim())),
    [rows, query],
  );

  useEffect(() => {
    setSelected((i) =>
      filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1),
    );
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  if (!open) return null;

  const categoryName = (id: number | null) => {
    if (id == null) return "未分类";
    return categories.find((c) => c.id === id)?.name ?? "未分类";
  };

  const inject = (row: SavedCommandRow, run: boolean) => {
    if (!canInject) {
      setError(injectDisabledReason || "请先打开并聚焦已连接的终端");
      return;
    }
    onInject(row.body, { run });
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setSelected((i) => (i + 1) % filtered.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      setSelected((i) => (i - 1 + filtered.length) % filtered.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = filtered[selected];
      if (!row) return;
      inject(row, e.shiftKey);
    }
  };

  return (
    <div
      className="command-palette-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="command-palette-header">
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            value={query}
            placeholder="搜索收藏命令…"
            aria-label="搜索收藏命令"
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
          />
          <span className="command-palette-hint">
            ↑↓ 选择 · Enter 填入 · Shift+Enter 运行 · Esc 关闭
          </span>
        </div>
        {!canInject ? (
          <div className="command-palette-banner">
            {injectDisabledReason || "请先打开并聚焦已连接的终端"}
          </div>
        ) : null}
        {error ? <div className="command-palette-error">{error}</div> : null}
        <div className="command-palette-list" ref={listRef} role="listbox">
          {loading ? (
            <div className="command-palette-empty">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="command-palette-empty">
              {rows.length === 0
                ? "尚无收藏命令。可在侧栏「命令」中新建。"
                : "无匹配命令"}
            </div>
          ) : (
            filtered.map((row, index) => {
              const active = index === selected;
              return (
                <div
                  key={row.id}
                  data-palette-index={index}
                  role="option"
                  aria-selected={active}
                  className={`command-palette-item${active ? " is-active" : ""}`}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => inject(row, false)}
                  onDoubleClick={() => inject(row, true)}
                >
                  <div className="command-palette-item-top">
                    <span className="command-palette-item-title">
                      {row.title}
                    </span>
                    <span className="command-palette-item-cat">
                      {categoryName(row.categoryId)}
                    </span>
                  </div>
                  <div className="command-palette-item-body">
                    {row.body.replace(/\s+/g, " ").trim()}
                  </div>
                  {active ? (
                    <div className="command-palette-item-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={!canInject}
                        onClick={(e) => {
                          e.stopPropagation();
                          inject(row, false);
                        }}
                      >
                        填入
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={!canInject}
                        onClick={(e) => {
                          e.stopPropagation();
                          inject(row, true);
                        }}
                      >
                        运行
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
