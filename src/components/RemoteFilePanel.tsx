import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

interface SftpListResult {
  path: string;
  entries: SftpEntry[];
}

interface SftpProgressEvent {
  sessionId: string;
  transferId: string;
  direction: "upload" | "download" | string;
  remotePath: string;
  localPath: string;
  bytesDone: number;
  bytesTotal: number;
  fileIndex?: number;
  fileCount?: number;
  done: boolean;
  error?: string | null;
}

interface RemoteFilePanelProps {
  sessionId: string;
  /** 打开时默认目录（一般为会话 cwd） */
  initialPath: string;
  connected: boolean;
  onClose: () => void;
}

const WIDTH_KEY = "miterm.remoteFilePanelWidth";
const LEGACY_WIDTH_KEY = "miterminal.remoteFilePanelWidth";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 220;
const MAX_WIDTH = 720;

function loadPanelWidth(): number {
  try {
    let raw = localStorage.getItem(WIDTH_KEY);
    if (raw == null) {
      raw = localStorage.getItem(LEGACY_WIDTH_KEY);
      if (raw != null) {
        localStorage.setItem(WIDTH_KEY, raw);
        localStorage.removeItem(LEGACY_WIDTH_KEY);
      }
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
  } catch {
    /* ignore */
  }
  return DEFAULT_WIDTH;
}

function savePanelWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    localStorage.removeItem(LEGACY_WIDTH_KEY);
  } catch {
    /* ignore */
  }
}

function parentPath(path: string): string {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

function basename(path: string): string {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1) || p;
}

function formatSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMtime(sec: number): string {
  if (!sec) return "—";
  try {
    return new Date(sec * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`remote-file-chevron-svg${open ? " is-open" : ""}`}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M6.2 3.6a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 1 1-1.06-1.06L9.14 8 6.2 5.06a.75.75 0 0 1 0-1.06z"
      />
    </svg>
  );
}

function IconFolder({ open }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill={open ? "rgba(120, 170, 210, 0.95)" : "rgba(100, 150, 190, 0.85)"}
        d="M1.75 3.5A1.75 1.75 0 0 1 3.5 1.75h3.17c.46 0 .9.18 1.22.51l.86.86h5.75c.97 0 1.75.78 1.75 1.75v7.88A1.75 1.75 0 0 1 13.5 14.5h-10A1.75 1.75 0 0 1 1.75 12.75V3.5z"
      />
    </svg>
  );
}

function IconFile() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        fill="rgba(170, 170, 170, 0.9)"
        d="M3.75 1.5A1.75 1.75 0 0 0 2 3.25v9.5c0 .97.78 1.75 1.75 1.75h8.5A1.75 1.75 0 0 0 14 12.75v-6.19c0-.46-.18-.9-.51-1.23L9.67 1.99A1.75 1.75 0 0 0 8.44 1.5H3.75zm5 .5v3.25c0 .41.34.75.75.75h3.19L8.75 2z"
      />
    </svg>
  );
}

type ChildrenCache = Record<string, SftpEntry[]>;

export function RemoteFilePanel({
  sessionId,
  initialPath,
  connected,
  onClose,
}: RemoteFilePanelProps) {
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [rootPath, setRootPath] = useState(initialPath || "/");
  const [pathInput, setPathInput] = useState(initialPath || "/");
  const [rootEntries, setRootEntries] = useState<SftpEntry[]>([]);
  const [childrenCache, setChildrenCache] = useState<ChildrenCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedPath, setSelectedPath] = useState(initialPath || "/");
  const [bootLoading, setBootLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<SftpProgressEvent | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const uploadDir = useMemo(() => {
    if (selectedPath === rootPath) return rootPath;
    const findIsDir = (list: SftpEntry[]): boolean | null => {
      for (const e of list) {
        if (e.path === selectedPath) return e.isDir;
      }
      return null;
    };
    let hit = findIsDir(rootEntries);
    if (hit == null) {
      for (const kids of Object.values(childrenCache)) {
        hit = findIsDir(kids);
        if (hit != null) break;
      }
    }
    if (hit === true) return selectedPath;
    if (hit === false) return parentPath(selectedPath);
    return rootPath;
  }, [selectedPath, rootPath, rootEntries, childrenCache]);

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startX: e.clientX, startW: panelWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.classList.add("remote-file-resizing");
  };

  const onResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, drag.startW + (e.clientX - drag.startX)),
    );
    setPanelWidth(next);
  };

  const onResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    document.body.classList.remove("remote-file-resizing");
    setPanelWidth((w) => {
      savePanelWidth(w);
      return w;
    });
  };

  useEffect(() => {
    return () => {
      document.body.classList.remove("remote-file-resizing");
    };
  }, []);

  const listDir = useCallback(
    async (target: string): Promise<SftpEntry[]> => {
      const result = await invoke<SftpListResult>("sftp_list", {
        params: { sessionId, path: target },
      });
      return result.entries;
    },
    [sessionId],
  );

  const loadRoot = useCallback(
    async (target: string) => {
      if (!connected) {
        setError("会话未连接");
        return;
      }
      setBootLoading(true);
      setError("");
      setLoadingPaths((prev) => new Set(prev).add(target));
      try {
        const entries = await listDir(target);
        setRootPath(target);
        setPathInput(target);
        setRootEntries(entries);
        setChildrenCache({});
        setExpanded(new Set());
        setSelectedPath(target);
      } catch (e) {
        setError(String(e));
      } finally {
        setBootLoading(false);
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(target);
          return next;
        });
      }
    },
    [connected, listDir],
  );

  useEffect(() => {
    void loadRoot(initialPath || "/");
  }, [initialPath, loadRoot, sessionId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<SftpProgressEvent>("sftp-progress", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      setProgress(event.payload);
      if (event.payload.done && !event.payload.error) {
        window.setTimeout(() => setProgress(null), 1500);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [sessionId]);

  const ensureChildren = useCallback(
    async (dirPath: string) => {
      if (!connected) return;
      if (childrenCache[dirPath]) return;
      setLoadingPaths((prev) => new Set(prev).add(dirPath));
      setError("");
      try {
        const entries = await listDir(dirPath);
        setChildrenCache((prev) => ({ ...prev, [dirPath]: entries }));
      } catch (e) {
        setError(String(e));
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [childrenCache, connected, listDir],
  );

  const toggleExpand = async (dirPath: string) => {
    const willOpen = !expanded.has(dirPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(dirPath);
      else next.delete(dirPath);
      return next;
    });
    if (willOpen) {
      await ensureChildren(dirPath);
    }
  };

  const refreshNode = async (dirPath: string) => {
    if (!connected) return;
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    setError("");
    try {
      const entries = await listDir(dirPath);
      if (dirPath === rootPath) {
        setRootEntries(entries);
        setChildrenCache({});
      } else {
        setChildrenCache((prev) => ({ ...prev, [dirPath]: entries }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  };

  const onSubmitPath = (e: React.FormEvent) => {
    e.preventDefault();
    void loadRoot(pathInput.trim() || "/");
  };

  const onUpload = async () => {
    if (!connected || busy) return;
    setBusy(true);
    setError("");
    try {
      const remote = await invoke<string | null>("sftp_upload", {
        params: { sessionId, remoteDir: uploadDir },
      });
      if (remote) {
        await refreshNode(uploadDir);
        if (uploadDir !== rootPath && !expanded.has(uploadDir)) {
          setExpanded((prev) => new Set(prev).add(uploadDir));
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDownload = async (entry: SftpEntry) => {
    if (!connected || busy) return;
    setBusy(true);
    setError("");
    try {
      if (entry.isDir) {
        await invoke<string | null>("sftp_download_dir", {
          params: { sessionId, remotePath: entry.path },
        });
      } else {
        await invoke<string | null>("sftp_download", {
          params: { sessionId, remotePath: entry.path },
        });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pct =
    progress && progress.bytesTotal > 0
      ? Math.min(
          100,
          Math.round((progress.bytesDone / progress.bytesTotal) * 100),
        )
      : null;

  const renderEntries = (entries: SftpEntry[], depth: number) =>
    entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const isLoading = loadingPaths.has(entry.path);
      const selected = selectedPath === entry.path;
      const kids = childrenCache[entry.path];

      return (
        <div key={entry.path} className="remote-file-tree-branch">
          <div
            className={`remote-file-tree-row${selected ? " is-selected" : ""}${
              entry.isDir ? " is-dir" : ""
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
            title={`${entry.path}${
              entry.mtime ? `\n${formatMtime(entry.mtime)}` : ""
            }`}
            onClick={() => setSelectedPath(entry.path)}
            onDoubleClick={() => {
              if (entry.isDir) void toggleExpand(entry.path);
            }}
          >
            {entry.isDir ? (
              <button
                type="button"
                className="remote-file-twist"
                aria-label={isOpen ? "折叠" : "展开"}
                disabled={isLoading}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleExpand(entry.path);
                }}
              >
                {isLoading ? (
                  <span className="remote-file-spin" aria-hidden="true" />
                ) : (
                  <IconChevron open={isOpen} />
                )}
              </button>
            ) : (
              <span className="remote-file-twist-spacer" />
            )}

            <span className="remote-file-type-icon" aria-hidden="true">
              {entry.isDir ? <IconFolder open={isOpen} /> : <IconFile />}
            </span>

            <span className="remote-file-tree-name">{entry.name}</span>

            {!entry.isDir ? (
              <span className="remote-file-tree-size">
                {formatSize(entry.size)}
              </span>
            ) : null}

            <button
              type="button"
              className="remote-file-dl"
              title={
                entry.isDir
                  ? "下载整个文件夹到本地"
                  : `下载到本地（${formatMtime(entry.mtime)}）`
              }
              disabled={!connected || busy}
              onClick={(e) => {
                e.stopPropagation();
                void onDownload(entry);
              }}
            >
              下载
            </button>
          </div>

          {entry.isDir && isOpen ? (
            <div className="remote-file-tree-children">
              {isLoading && !kids ? (
                <div
                  className="remote-file-tree-hint"
                  style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                >
                  加载中…
                </div>
              ) : kids && kids.length === 0 ? (
                <div
                  className="remote-file-tree-hint"
                  style={{ paddingLeft: 8 + (depth + 1) * 14 }}
                >
                  空目录
                </div>
              ) : kids ? (
                renderEntries(kids, depth + 1)
              ) : null}
            </div>
          ) : null}
        </div>
      );
    });

  return (
    <aside
      className="remote-file-panel"
      aria-label="远程文件"
      style={{ width: panelWidth }}
    >
      <div className="remote-file-header">
        <span className="remote-file-title">远程文件</span>
        <button
          type="button"
          className="remote-file-close"
          title="关闭"
          aria-label="关闭文件面板"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <form className="remote-file-pathbar" onSubmit={onSubmitPath}>
        <button
          type="button"
          className="remote-file-icon-btn"
          title="上级目录"
          disabled={!connected || bootLoading || rootPath === "/"}
          onClick={() => void loadRoot(parentPath(rootPath))}
        >
          ↑
        </button>
        <input
          className="remote-file-path-input"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          spellCheck={false}
          disabled={!connected}
          aria-label="远程路径"
        />
        <button
          type="submit"
          className="remote-file-icon-btn"
          title="转到"
          disabled={!connected || bootLoading}
        >
          ↵
        </button>
        <button
          type="button"
          className="remote-file-icon-btn"
          title="刷新当前树根"
          disabled={!connected || bootLoading}
          onClick={() => void refreshNode(rootPath)}
        >
          ↻
        </button>
      </form>

      <div className="remote-file-actions">
        <button
          type="button"
          className="remote-file-action-btn"
          disabled={!connected || busy}
          title={`上传到 ${uploadDir}`}
          onClick={() => void onUpload()}
        >
          上传…
        </button>
        <span className="remote-file-upload-hint" title={uploadDir}>
          → {basename(uploadDir)}
        </span>
      </div>

      {progress ? (
        <div className="remote-file-progress">
          <div className="remote-file-progress-label">
            {progress.direction === "upload" ? "上传" : "下载"}{" "}
            {progress.done ? "完成" : "中…"}
            {pct != null ? ` ${pct}%` : ""}
            {progress.fileCount && progress.fileCount > 0
              ? ` · ${progress.fileIndex ?? 0}/${progress.fileCount} 个文件`
              : ""}
          </div>
          <div className="remote-file-progress-track">
            <div
              className="remote-file-progress-bar"
              style={{
                width:
                  pct != null
                    ? `${pct}%`
                    : progress.done
                      ? "100%"
                      : "30%",
              }}
            />
          </div>
          <div className="remote-file-progress-meta" title={progress.remotePath}>
            {formatSize(progress.bytesDone)}
            {progress.bytesTotal > 0
              ? ` / ${formatSize(progress.bytesTotal)}`
              : ""}
            {progress.remotePath
              ? ` · ${progress.remotePath.split("/").pop() || progress.remotePath}`
              : ""}
          </div>
        </div>
      ) : null}

      {error ? <div className="remote-file-error">{error}</div> : null}

      <div className="remote-file-list-wrap">
        <div
          className={`remote-file-tree-row is-root${
            selectedPath === rootPath ? " is-selected" : ""
          }`}
          onClick={() => setSelectedPath(rootPath)}
          title={rootPath}
        >
          <span className="remote-file-twist-spacer" />
          <span className="remote-file-type-icon" aria-hidden="true">
            <IconFolder open />
          </span>
          <span className="remote-file-tree-name is-root-name">
            {basename(rootPath)}
          </span>
          {rootPath !== "/" ? (
            <button
              type="button"
              className="remote-file-dl"
              title="下载当前文件夹到本地"
              disabled={!connected || busy}
              onClick={(e) => {
                e.stopPropagation();
                void onDownload({
                  name: basename(rootPath),
                  path: rootPath,
                  isDir: true,
                  size: 0,
                  mtime: 0,
                });
              }}
            >
              下载
            </button>
          ) : null}
        </div>

        {bootLoading && rootEntries.length === 0 ? (
          <div className="remote-file-empty">加载中…</div>
        ) : rootEntries.length === 0 ? (
          <div className="remote-file-empty">空目录</div>
        ) : (
          <div className="remote-file-tree">{renderEntries(rootEntries, 1)}</div>
        )}
      </div>

      <div
        className="remote-file-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整远程文件面板宽度"
        title="拖动调整宽度"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      />
    </aside>
  );
}
