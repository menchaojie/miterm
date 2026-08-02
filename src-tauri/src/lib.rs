mod db;
mod local;
mod migrate;
mod ssh;

use std::sync::Arc;

use db::{
    Category, HostStore, SaveCategoryParams, SaveHostParams, SavedHost, UpdateCategoryParams,
    UpdateHostParams,
};
use local::{LocalConnectParams, LocalSessionManager};
use ssh::{
    classify_local_paths, ClassifyLocalPathsResult, ConnectParams, SftpClassifyPathsParams,
    SftpDownloadParams, SftpListParams, SftpListResult, SftpUploadParams, SftpUploadPathsParams,
    SshSessionManager,
};
use tauri::{AppHandle, Manager, State, Theme, image::Image};

struct AppState {
    ssh: Arc<SshSessionManager>,
    local: Arc<LocalSessionManager>,
    hosts: Arc<HostStore>,
}

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    params: ConnectParams,
) -> Result<String, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || ssh.connect(app, params))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn local_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    params: LocalConnectParams,
) -> Result<String, String> {
    let local = Arc::clone(&state.local);
    tokio::task::spawn_blocking(move || local.connect(app, params))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn ssh_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let ssh = Arc::clone(&state.ssh);
    let local = Arc::clone(&state.local);
    tokio::task::spawn_blocking(move || {
        if ssh.has_session(&session_id) {
            ssh.write(&session_id, data)
        } else if local.has_session(&session_id) {
            local.write(&session_id, data)
        } else {
            Err("not connected".into())
        }
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let ssh = Arc::clone(&state.ssh);
    let local = Arc::clone(&state.local);
    tokio::task::spawn_blocking(move || {
        if ssh.has_session(&session_id) {
            ssh.resize(&session_id, cols, rows)
        } else if local.has_session(&session_id) {
            local.resize(&session_id, cols, rows)
        } else {
            Err("not connected".into())
        }
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let ssh = Arc::clone(&state.ssh);
    let local = Arc::clone(&state.local);
    // 用户主动断开：不向 UI 广播 ssh-closed（前端已移除 Tab），避免误触发重连
    tokio::task::spawn_blocking(move || {
        if ssh.has_session(&session_id) {
            ssh.disconnect(&app, &session_id, false);
        } else if local.has_session(&session_id) {
            local.disconnect(&app, &session_id, false);
        }
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    params: SftpListParams,
) -> Result<SftpListResult, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || ssh.sftp_list(&params.session_id, &params.path))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    params: SftpUploadParams,
) -> Result<Option<String>, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || {
        ssh.sftp_upload(&app, &params.session_id, &params.remote_dir)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    params: SftpDownloadParams,
) -> Result<Option<String>, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || {
        ssh.sftp_download(&app, &params.session_id, &params.remote_path)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn sftp_download_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    params: SftpDownloadParams,
) -> Result<Option<String>, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || {
        ssh.sftp_download_dir(&app, &params.session_id, &params.remote_path)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn sftp_upload_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    params: SftpUploadParams,
) -> Result<Option<String>, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || {
        ssh.sftp_upload_dir(&app, &params.session_id, &params.remote_dir)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn sftp_classify_local_paths(
    params: SftpClassifyPathsParams,
) -> Result<ClassifyLocalPathsResult, String> {
    Ok(classify_local_paths(&params.paths))
}

#[tauri::command]
async fn sftp_upload_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    params: SftpUploadPathsParams,
) -> Result<String, String> {
    let ssh = Arc::clone(&state.ssh);
    tokio::task::spawn_blocking(move || {
        ssh.sftp_upload_paths(&app, &params.session_id, &params.remote_dir, &params.paths)
    })
    .await
    .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn list_saved_hosts(state: State<'_, AppState>) -> Result<Vec<SavedHost>, String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.list())
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn save_host(
    state: State<'_, AppState>,
    params: SaveHostParams,
) -> Result<SavedHost, String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.upsert(params))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn update_saved_host(
    state: State<'_, AppState>,
    params: UpdateHostParams,
) -> Result<SavedHost, String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.update(params))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn delete_saved_host(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.delete(id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn touch_saved_host(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.touch(id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn list_categories(state: State<'_, AppState>) -> Result<Vec<Category>, String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.list_categories())
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn create_category(
    state: State<'_, AppState>,
    params: SaveCategoryParams,
) -> Result<Category, String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.create_category(params))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn update_category(
    state: State<'_, AppState>,
    params: UpdateCategoryParams,
) -> Result<Category, String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.update_category(params))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[tauri::command]
async fn delete_category(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let hosts = Arc::clone(&state.hosts);
    tokio::task::spawn_blocking(move || hosts.delete_category(id))
        .await
        .map_err(|e| format!("task join error: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_theme(Some(Theme::Dark));
                // 运行时设置窗口/任务栏图标，避免仍显示默认 Tauri 图标
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
            }

            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app data dir: {e}"))?;
            migrate::migrate_legacy_app_data(&data_dir)?;
            let hosts = HostStore::open(&data_dir)?;
            app.manage(AppState {
                ssh: Arc::new(SshSessionManager::new()),
                local: Arc::new(LocalSessionManager::new()),
                hosts: Arc::new(hosts),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            local_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            sftp_list,
            sftp_upload,
            sftp_upload_dir,
            sftp_classify_local_paths,
            sftp_upload_paths,
            sftp_download,
            sftp_download_dir,
            list_saved_hosts,
            save_host,
            update_saved_host,
            delete_saved_host,
            touch_saved_host,
            list_categories,
            create_category,
            update_category,
            delete_category
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
