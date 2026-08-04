/**
 * 从 OSC 7 数据解析绝对路径。
 * 不用 URL()：Windows/WebView2 上 file:///tmp/... 可能被拆成 host=tmp，路径错乱。
 */
export function parseOsc7Path(data: string): string | null {
  const raw = data.trim();
  if (!raw.toLowerCase().startsWith("file:")) return null;

  const rest = raw.replace(/^file:/i, "");

  if (rest.startsWith("///")) {
    return normalizeAbsolutePath(decodePath(rest.slice(2)));
  }
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const slash = after.indexOf("/");
    if (slash < 0) return null;
    return normalizeAbsolutePath(decodePath(after.slice(slash)));
  }
  if (rest.startsWith("/")) {
    return normalizeAbsolutePath(decodePath(rest));
  }
  return null;
}

/** 从终端原始输出中提取 OSC 7 载荷（]7;…BEL） */
export function extractOsc7Payloads(text: string): string[] {
  const out: string[] = [];
  const re = /\u001b\]7;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function normalizeAbsolutePath(path: string): string | null {
  if (!path) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(path)) {
    path = path.slice(1);
  }
  if (path.includes("\0") || path.includes("\n") || path.includes("\r")) {
    return null;
  }
  if (!(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) {
    return null;
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.replace(/\/+$/, "");
  }
  return path || null;
}

/** SSH 会话初始工作目录猜测（无 OSC 时作为相对 cd 的基路径） */
export function guessUnixHome(username: string): string {
  const u = username.trim();
  if (!u || u === "root") return "/root";
  return `/home/${u}`;
}

/** 将路径安全地用于 bash/zsh 的 cd 参数 */
export function shellSingleQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function isRestorableCwd(cwd: string | null | undefined): cwd is string {
  if (!cwd) return false;
  if (cwd.includes("\0") || cwd.includes("\n") || cwd.includes("\r")) {
    return false;
  }
  if (!(cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd))) return false;
  if (cwd.startsWith("/") && cwd.length < 2) return false;
  return true;
}

function resolveRelative(cwd: string, rel: string): string {
  const parts = cwd.split("/").filter(Boolean);
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** 展开提示符中的 ~ / ~/… 或绝对路径 */
export function expandShellPath(
  path: string,
  homeHint?: string | null,
): string | null {
  const p = path.trim();
  if (!p) return null;
  const home = homeHint && isRestorableCwd(homeHint) ? homeHint : null;
  if (p === "~") return home;
  if (p.startsWith("~/")) {
    if (!home) return null;
    return resolveRelative(home, p.slice(2));
  }
  if (p.startsWith("/")) {
    return p.replace(/\/+$/, "") || "/";
  }
  if (/^[A-Za-z]:[\\/]/.test(p)) return p;
  return null;
}

/** 去掉常见 ANSI / OSC，便于匹配提示符 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\u001b[>=<]/g, "");
}

/**
 * 从 shell 输出末尾识别 user@host:path$/# 提示符中的路径。
 * 只认「最后一行非空行」——避免命令输出中间夹带的假提示符把 cwd 带跑。
 */
export function cwdFromPromptOutput(
  text: string,
  homeHint?: string | null,
): string | null {
  const plain = stripAnsi(text).replace(/\r/g, "\n");
  const lines = plain.split("\n");
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastLine = lines[i];
      break;
    }
  }
  if (!lastLine) return null;
  // 行尾必须是空闲提示符（$# 后仅空白），中间行的假提示符一律忽略
  const re = /\b([\w.-]+)@([\w.-]+):([^\n$#]+?)[$#][ \t]*$/;
  const m = lastLine.match(re);
  if (!m) return null;
  const pathPart = m[3].trim();
  if (!pathPart || pathPart.includes("@")) return null;
  return expandShellPath(pathPart, homeHint);
}

/**
 * 根据用户提交的一行命令更新 cwd。
 * homeHint：无 prev 时用于解析相对 cd（一般为 /home/user）。
 */
export function cwdAfterCommand(
  prev: string | null,
  line: string,
  homeHint?: string | null,
): string | null {
  const trimmed = line.trim();
  if (!trimmed) return prev;

  const cdMatch = trimmed.match(/^cd(?:\s+|\s*$)(.*)$/);
  if (!cdMatch) return prev;

  let arg = cdMatch[1].trim();
  const home = homeHint && isRestorableCwd(homeHint) ? homeHint : null;

  if (!arg || arg === "~") {
    return home;
  }
  if (arg === "-") return prev;

  if (
    (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) ||
    (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2)
  ) {
    arg = arg.slice(1, -1);
  }

  if (arg.startsWith("~/")) {
    if (!home) return null;
    return resolveRelative(home, arg.slice(2));
  }
  if (arg.startsWith("/")) {
    return arg.replace(/\/+$/, "") || "/";
  }
  if (/^[A-Za-z]:[\\/]/.test(arg)) {
    return arg;
  }

  const base = prev && isRestorableCwd(prev) ? prev : home;
  if (!base) return null;
  return resolveRelative(base, arg);
}

export type CompletedInputLine = {
  line: string;
  /** 该行输入过程中用过 Tab（远端补全未进入本地缓冲） */
  usedTab: boolean;
};

/** 从终端输入流维护当前编辑行，遇回车时返回完整行 */
export class InputLineTracker {
  private buf = "";
  private usedTab = false;

  /** 当前行仍有未提交输入（用户正在打字） */
  hasPending(): boolean {
    return this.buf.length > 0;
  }

  push(data: string): CompletedInputLine[] {
    const completed: CompletedInputLine[] = [];
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        if (this.buf.length > 0) {
          completed.push({ line: this.buf, usedTab: this.usedTab });
          this.buf = "";
          this.usedTab = false;
        }
        continue;
      }
      if (ch === "\u007f" || ch === "\b") {
        this.buf = this.buf.slice(0, -1);
        continue;
      }
      if (ch === "\t") {
        // Tab 补全内容由 shell 回显，不在 onData 里；标记后跳过不可靠的相对路径推断
        this.usedTab = true;
        continue;
      }
      if (ch < " ") continue;
      this.buf += ch;
    }
    return completed;
  }

  reset() {
    this.buf = "";
    this.usedTab = false;
  }
}
