use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use tauri::{AppHandle, Emitter};

use super::{apply_tcp_keepalive, SessionAuth};

const CHUNK: usize = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResult {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgressPayload {
    pub session_id: String,
    pub transfer_id: String,
    pub direction: &'static str,
    pub remote_path: String,
    pub local_path: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// 目录下载时：当前文件序号（从 1）；单文件为 0
    pub file_index: u64,
    /// 目录下载时：文件总数；单文件为 0
    pub file_count: u64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListParams {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpUploadParams {
    pub session_id: String,
    pub remote_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDownloadParams {
    pub session_id: String,
    pub remote_path: String,
}

const MAX_DIR_FILES: usize = 8000;

pub struct SftpSideSession {
    session: Session,
}

/// 独立 TCP+SSH，专供 SFTP，避免与 PTY channel 抢同一 Session。
pub fn connect_sftp(auth: &SessionAuth) -> Result<SftpSideSession, String> {
    let tcp = TcpStream::connect((auth.host.as_str(), auth.port))
        .map_err(|e| format!("SFTP TCP connect failed: {e}"))?;
    if let Err(e) = apply_tcp_keepalive(&tcp) {
        eprintln!("[sftp] tcp keepalive: {e}");
    }

    let mut sess = Session::new().map_err(|e| format!("SFTP session: {e}"))?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SFTP handshake: {e}"))?;
    sess.userauth_password(&auth.username, &auth.password)
        .map_err(|e| format!("SFTP authentication failed: {e}"))?;
    if !sess.authenticated() {
        return Err("SFTP authentication failed".into());
    }
    sess.set_keepalive(true, 15);
    // 阻塞模式简化读写
    sess.set_blocking(true);

    Ok(SftpSideSession { session: sess })
}

pub fn ensure_sftp<'a>(
    slot: &'a Mutex<Option<SftpSideSession>>,
    auth: &SessionAuth,
) -> Result<parking_lot::MutexGuard<'a, Option<SftpSideSession>>, String> {
    let mut guard = slot.lock();
    if guard.is_none() {
        *guard = Some(connect_sftp(auth)?);
    }
    Ok(guard)
}

pub fn normalize_remote_dir(path: &str) -> String {
    let t = path.trim();
    if t.is_empty() || t == "~" {
        return "/".into();
    }
    let mut p = t.replace('\\', "/");
    if !p.starts_with('/') {
        p = format!("/{p}");
    }
    while p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

pub fn join_remote(dir: &str, name: &str) -> String {
    let base = normalize_remote_dir(dir);
    let name = name.trim().trim_start_matches('/');
    if name.is_empty() || name == "." {
        return base;
    }
    if name == ".." {
        return parent_remote(&base);
    }
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

pub fn parent_remote(path: &str) -> String {
    let p = normalize_remote_dir(path);
    if p == "/" {
        return "/".into();
    }
    match p.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => p[..i].to_string(),
        None => "/".into(),
    }
}

fn transfer_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("t-{ms}")
}

pub fn list_dir(side: &SftpSideSession, path: &str) -> Result<SftpListResult, String> {
    let path = normalize_remote_dir(path);
    let sftp = side
        .session
        .sftp()
        .map_err(|e| format!("open sftp: {e}"))?;
    let raw = sftp
        .readdir(Path::new(&path))
        .map_err(|e| format!("readdir {path}: {e}"))?;

    let mut entries: Vec<SftpEntry> = Vec::new();
    for (pbuf, stat) in raw {
        let name = pbuf
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let full = join_remote(&path, &name);
        entries.push(SftpEntry {
            name,
            path: full,
            is_dir: stat.is_dir(),
            size: stat.size.unwrap_or(0),
            mtime: stat.mtime.unwrap_or(0),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(SftpListResult { path, entries })
}

pub fn upload_file(
    app: &AppHandle,
    session_id: &str,
    side: &SftpSideSession,
    remote_dir: &str,
    local_path: &Path,
) -> Result<String, String> {
    let file_name = local_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| "invalid local file".to_string())?;
    let remote_path = join_remote(remote_dir, &file_name);
    let local_disp = local_path.to_string_lossy().into_owned();
    let tid = transfer_id();

    let mut local = File::open(local_path).map_err(|e| format!("open local: {e}"))?;
    let total = local
        .metadata()
        .map(|m| m.len())
        .unwrap_or(0);

    let sftp = side
        .session
        .sftp()
        .map_err(|e| format!("open sftp: {e}"))?;
    let mut remote = sftp
        .create(Path::new(&remote_path))
        .map_err(|e| format!("create remote: {e}"))?;

    let mut buf = vec![0u8; CHUNK];
    let mut done: u64 = 0;
    emit_progress(
        app,
        session_id,
        &tid,
        "upload",
        &remote_path,
        &local_disp,
        done,
        total,
        0,
        0,
        false,
        None,
    );

    loop {
        let n = local.read(&mut buf).map_err(|e| format!("read local: {e}"))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .map_err(|e| format!("write remote: {e}"))?;
        done += n as u64;
        emit_progress(
            app,
            session_id,
            &tid,
            "upload",
            &remote_path,
            &local_disp,
            done,
            total,
            0,
            0,
            false,
            None,
        );
    }

    emit_progress(
        app,
        session_id,
        &tid,
        "upload",
        &remote_path,
        &local_disp,
        done,
        total,
        0,
        0,
        true,
        None,
    );
    Ok(remote_path)
}

pub fn download_file(
    app: &AppHandle,
    session_id: &str,
    side: &SftpSideSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), String> {
    let remote_path = if remote_path.starts_with('/') {
        remote_path.to_string()
    } else {
        normalize_remote_dir(remote_path)
    };
    let local_disp = local_path.to_string_lossy().into_owned();
    let tid = transfer_id();

    let sftp = side
        .session
        .sftp()
        .map_err(|e| format!("open sftp: {e}"))?;

    let total = sftp
        .stat(Path::new(&remote_path))
        .ok()
        .and_then(|s| s.size)
        .unwrap_or(0);

    copy_remote_to_local(
        app,
        session_id,
        &tid,
        &sftp,
        &remote_path,
        local_path,
        &local_disp,
        total,
        0,
        0,
        0,
        total,
        true,
    )
}

struct PlannedFile {
    remote: String,
    /// 相对远程根目录的路径（用 /）
    rel: String,
    size: u64,
}

fn walk_remote(
    sftp: &ssh2::Sftp,
    remote_abs: &str,
    rel_prefix: &str,
    dirs: &mut Vec<String>,
    files: &mut Vec<PlannedFile>,
) -> Result<(), String> {
    if files.len() > MAX_DIR_FILES {
        return Err(format!(
            "目录内文件超过 {MAX_DIR_FILES} 个，请缩小范围后再下载"
        ));
    }

    let raw = sftp
        .readdir(Path::new(remote_abs))
        .map_err(|e| format!("readdir {remote_abs}: {e}"))?;

    for (pbuf, stat) in raw {
        let name = pbuf
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let child_remote = join_remote(remote_abs, &name);
        let child_rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };

        if stat.is_dir() {
            dirs.push(child_rel.clone());
            walk_remote(sftp, &child_remote, &child_rel, dirs, files)?;
        } else if stat.is_file() {
            if files.len() >= MAX_DIR_FILES {
                return Err(format!(
                    "目录内文件超过 {MAX_DIR_FILES} 个，请缩小范围后再下载"
                ));
            }
            files.push(PlannedFile {
                remote: child_remote,
                rel: child_rel,
                size: stat.size.unwrap_or(0),
            });
        }
        // 跳过符号链接等特殊文件
    }
    Ok(())
}

/// 递归下载远程目录到本机：先选父目录，再创建同名文件夹。
pub fn download_dir(
    app: &AppHandle,
    session_id: &str,
    side: &SftpSideSession,
    remote_path: &str,
    local_parent: &Path,
) -> Result<String, String> {
    let remote_root = normalize_remote_dir(remote_path);
    if remote_root == "/" {
        return Err("不支持下载根目录 /".into());
    }
    let folder_name = file_name_of(&remote_root);
    if folder_name.is_empty() || folder_name == "/" {
        return Err("无效的远程目录名".into());
    }

    let local_root = local_parent.join(&folder_name);
    fs::create_dir_all(&local_root).map_err(|e| format!("create local dir: {e}"))?;

    let sftp = side
        .session
        .sftp()
        .map_err(|e| format!("open sftp: {e}"))?;

    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<PlannedFile> = Vec::new();
    walk_remote(&sftp, &remote_root, "", &mut dirs, &mut files)?;

    for rel in &dirs {
        let local_dir = local_join(&local_root, rel);
        fs::create_dir_all(&local_dir).map_err(|e| format!("mkdir {}: {e}", local_dir.display()))?;
    }

    let file_count = files.len() as u64;
    let bytes_total: u64 = files.iter().map(|f| f.size).sum();
    let tid = transfer_id();
    let local_root_disp = local_root.to_string_lossy().into_owned();

    emit_progress(
        app,
        session_id,
        &tid,
        "download",
        &remote_root,
        &local_root_disp,
        0,
        bytes_total,
        if file_count > 0 { 1 } else { 0 },
        file_count,
        false,
        None,
    );

    let mut bytes_done: u64 = 0;
    for (i, file) in files.iter().enumerate() {
        let file_index = (i + 1) as u64;
        let local_file = local_join(&local_root, &file.rel);
        if let Some(parent) = local_file.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let local_disp = local_file.to_string_lossy().into_owned();
        copy_remote_to_local(
            app,
            session_id,
            &tid,
            &sftp,
            &file.remote,
            &local_file,
            &local_disp,
            file.size,
            file_index,
            file_count,
            bytes_done,
            bytes_total,
            false,
        )?;
        bytes_done += file.size;
    }

    emit_progress(
        app,
        session_id,
        &tid,
        "download",
        &remote_root,
        &local_root_disp,
        bytes_done.max(bytes_total),
        bytes_total,
        file_count,
        file_count,
        true,
        None,
    );

    Ok(local_root_disp)
}

struct PlannedLocalFile {
    local: PathBuf,
    /// 相对本地根的 unix 风格路径
    rel: String,
    size: u64,
}

fn walk_local(
    root: &Path,
    rel_prefix: &str,
    dirs: &mut Vec<String>,
    files: &mut Vec<PlannedLocalFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|e| format!("readdir {}: {e}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("readdir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        // 跳过明显危险/无用名
        if name.contains('\0') || name.contains('/') || name.contains('\\') {
            continue;
        }
        let child = entry.path();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // 不跟随符号链接，避免环与意外穿越
        if ft.is_symlink() {
            continue;
        }
        let child_rel = if rel_prefix.is_empty() {
            name
        } else {
            format!("{rel_prefix}/{name}")
        };
        if ft.is_dir() {
            dirs.push(child_rel.clone());
            walk_local(&child, &child_rel, dirs, files)?;
        } else if ft.is_file() {
            if files.len() >= MAX_DIR_FILES {
                return Err(format!(
                    "目录内文件超过 {MAX_DIR_FILES} 个，请缩小范围后再上传"
                ));
            }
            let size = fs::metadata(&child).map(|m| m.len()).unwrap_or(0);
            files.push(PlannedLocalFile {
                local: child,
                rel: child_rel,
                size,
            });
        }
    }
    Ok(())
}

fn ensure_remote_dir(sftp: &ssh2::Sftp, path: &str) -> Result<(), String> {
    let path = normalize_remote_dir(path);
    if path == "/" {
        return Ok(());
    }
    // 自顶向下创建缺失的父目录
    let mut acc = String::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        acc.push('/');
        acc.push_str(seg);
        match sftp.stat(Path::new(&acc)) {
            Ok(st) if st.is_dir() => continue,
            Ok(_) => return Err(format!("远程路径已存在且不是目录: {acc}")),
            Err(_) => {
                sftp.mkdir(Path::new(&acc), 0o755)
                    .map_err(|e| format!("mkdir {acc}: {e}"))?;
            }
        }
    }
    Ok(())
}

fn remote_join_rel(remote_root: &str, rel_unix: &str) -> String {
    let mut out = normalize_remote_dir(remote_root);
    for seg in rel_unix.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        out = join_remote(&out, seg);
    }
    out
}

fn copy_local_to_remote(
    app: &AppHandle,
    session_id: &str,
    tid: &str,
    sftp: &ssh2::Sftp,
    local_path: &Path,
    remote_path: &str,
    local_disp: &str,
    file_size: u64,
    file_index: u64,
    file_count: u64,
    bytes_base: u64,
    bytes_total: u64,
) -> Result<(), String> {
    let mut local = File::open(local_path).map_err(|e| format!("open local: {e}"))?;
    let mut remote = sftp
        .create(Path::new(remote_path))
        .map_err(|e| format!("create remote {remote_path}: {e}"))?;

    let display_total = if bytes_total > 0 {
        bytes_total
    } else {
        file_size
    };

    emit_progress(
        app,
        session_id,
        tid,
        "upload",
        remote_path,
        local_disp,
        bytes_base,
        display_total,
        file_index,
        file_count,
        false,
        None,
    );

    let mut buf = vec![0u8; CHUNK];
    let mut file_done: u64 = 0;
    loop {
        let n = local.read(&mut buf).map_err(|e| format!("read local: {e}"))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .map_err(|e| format!("write remote: {e}"))?;
        file_done += n as u64;
        emit_progress(
            app,
            session_id,
            tid,
            "upload",
            remote_path,
            local_disp,
            bytes_base + file_done,
            display_total,
            file_index,
            file_count,
            false,
            None,
        );
    }
    Ok(())
}

/// 递归上传本地目录到远端：在 `remote_dir` 下创建同名文件夹。
pub fn upload_dir(
    app: &AppHandle,
    session_id: &str,
    side: &SftpSideSession,
    remote_dir: &str,
    local_root: &Path,
) -> Result<String, String> {
    if !local_root.is_dir() {
        return Err("请选择本地文件夹".into());
    }
    let folder_name = local_root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "无效的本地目录名".to_string())?;

    let remote_parent = normalize_remote_dir(remote_dir);
    let remote_root = join_remote(&remote_parent, &folder_name);

    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<PlannedLocalFile> = Vec::new();
    walk_local(local_root, "", &mut dirs, &mut files)?;
    // 浅层目录先创建
    dirs.sort_by_key(|d| d.matches('/').count());

    let sftp = side
        .session
        .sftp()
        .map_err(|e| format!("open sftp: {e}"))?;

    ensure_remote_dir(&sftp, &remote_root)?;
    for rel in &dirs {
        let remote_subdir = remote_join_rel(&remote_root, rel);
        ensure_remote_dir(&sftp, &remote_subdir)?;
    }

    let file_count = files.len() as u64;
    let bytes_total: u64 = files.iter().map(|f| f.size).sum();
    let tid = transfer_id();
    let local_disp = local_root.to_string_lossy().into_owned();

    emit_progress(
        app,
        session_id,
        &tid,
        "upload",
        &remote_root,
        &local_disp,
        0,
        bytes_total,
        if file_count > 0 { 1 } else { 0 },
        file_count,
        false,
        None,
    );

    let mut bytes_done: u64 = 0;
    for (i, file) in files.iter().enumerate() {
        let file_index = (i + 1) as u64;
        let remote_path = remote_join_rel(&remote_root, &file.rel);
        let file_local_disp = file.local.to_string_lossy().into_owned();
        copy_local_to_remote(
            app,
            session_id,
            &tid,
            &sftp,
            &file.local,
            &remote_path,
            &file_local_disp,
            file.size,
            file_index,
            file_count,
            bytes_done,
            bytes_total,
        )?;
        bytes_done += file.size;
    }

    emit_progress(
        app,
        session_id,
        &tid,
        "upload",
        &remote_root,
        &local_disp,
        bytes_done.max(bytes_total),
        bytes_total,
        file_count,
        file_count,
        true,
        None,
    );

    Ok(remote_root)
}

fn local_join(root: &Path, rel_unix: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for seg in rel_unix.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        // 防止路径穿越
        if seg == ".." {
            continue;
        }
        out.push(seg);
    }
    out
}

/// `bytes_base`：本文件开始前已累计字节；`emit_final`：单文件下载结束时发 done
fn copy_remote_to_local(
    app: &AppHandle,
    session_id: &str,
    tid: &str,
    sftp: &ssh2::Sftp,
    remote_path: &str,
    local_path: &Path,
    local_disp: &str,
    file_size: u64,
    file_index: u64,
    file_count: u64,
    bytes_base: u64,
    bytes_total: u64,
    emit_final: bool,
) -> Result<(), String> {
    let mut remote = sftp
        .open(Path::new(remote_path))
        .map_err(|e| format!("open remote {remote_path}: {e}"))?;
    let mut local = File::create(local_path).map_err(|e| format!("create local: {e}"))?;

    let display_total = if bytes_total > 0 {
        bytes_total
    } else {
        file_size
    };

    emit_progress(
        app,
        session_id,
        tid,
        "download",
        remote_path,
        local_disp,
        bytes_base,
        display_total,
        file_index,
        file_count,
        false,
        None,
    );

    let mut buf = vec![0u8; CHUNK];
    let mut file_done: u64 = 0;
    loop {
        let n = remote
            .read(&mut buf)
            .map_err(|e| format!("read remote: {e}"))?;
        if n == 0 {
            break;
        }
        local
            .write_all(&buf[..n])
            .map_err(|e| format!("write local: {e}"))?;
        file_done += n as u64;
        emit_progress(
            app,
            session_id,
            tid,
            "download",
            remote_path,
            local_disp,
            bytes_base + file_done,
            display_total,
            file_index,
            file_count,
            false,
            None,
        );
    }

    if emit_final {
        emit_progress(
            app,
            session_id,
            tid,
            "download",
            remote_path,
            local_disp,
            bytes_base + file_done,
            display_total,
            file_index,
            file_count,
            true,
            None,
        );
    }
    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    session_id: &str,
    transfer_id: &str,
    direction: &'static str,
    remote_path: &str,
    local_path: &str,
    bytes_done: u64,
    bytes_total: u64,
    file_index: u64,
    file_count: u64,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "sftp-progress",
        SftpProgressPayload {
            session_id: session_id.to_string(),
            transfer_id: transfer_id.to_string(),
            direction,
            remote_path: remote_path.to_string(),
            local_path: local_path.to_string(),
            bytes_done,
            bytes_total,
            file_index,
            file_count,
            done,
            error,
        },
    );
}

pub fn pick_local_file() -> Result<Option<PathBuf>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("选择要上传的文件")
        .pick_file())
}

pub fn pick_save_path(default_name: &str) -> Result<Option<PathBuf>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("保存到本地")
        .set_file_name(default_name)
        .save_file())
}

pub fn pick_folder() -> Result<Option<PathBuf>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("选择保存位置（将在此创建同名文件夹）")
        .pick_folder())
}

pub fn pick_upload_folder() -> Result<Option<PathBuf>, String> {
    Ok(rfd::FileDialog::new()
        .set_title("选择要上传的文件夹")
        .pick_folder())
}

pub fn file_name_of(remote_path: &str) -> String {
    let p = remote_path.trim_end_matches('/');
    p.rsplit('/').next().unwrap_or("download").to_string()
}
