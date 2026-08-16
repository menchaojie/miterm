/** 分类分组树共用图标 */

export function IconTreeChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`cat-tree-chevron${collapsed ? " is-collapsed" : ""}`}
      viewBox="0 0 24 24"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function IconFolder({ open = true }: { open?: boolean }) {
  if (open) {
    return (
      <svg
        className="cat-tree-folder"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="M20 6h-8l-1.4-1.4A2 2 0 0 0 9.2 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm0 12H4V8h16v10z"
          opacity="0.35"
        />
        <path
          fill="currentColor"
          d="M4 8h16v2.2l-1.6 6.3A1.5 1.5 0 0 1 17 18H7a1.5 1.5 0 0 1-1.4-1.5L4 8z"
        />
      </svg>
    );
  }
  return (
    <svg
      className="cat-tree-folder"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
      />
    </svg>
  );
}

export function IconRename() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.42l-2.34-2.34a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"
      />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
      />
    </svg>
  );
}
