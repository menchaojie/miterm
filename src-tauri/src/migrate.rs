//! 从旧包名 `miterminal` / `com.miterminal.app` 迁移本地数据到 `miterm`。

use std::fs;
use std::path::{Path, PathBuf};

const LEGACY_IDENTIFIERS: &[&str] = &["com.miterminal.app", "miterminal"];
const DATA_FILES: &[&str] = &["hosts.db", "hosts.db-wal", "hosts.db-shm", "settings.json"];

/// 若新目录尚无 `hosts.db`，则从已知旧应用数据目录拷贝库与设置文件。
pub fn migrate_legacy_app_data(new_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(new_dir).map_err(|e| format!("create app data dir: {e}"))?;

    let new_db = new_dir.join("hosts.db");
    if new_db.exists() {
        // 主机库已在新目录：仍可补拷 settings.json
        migrate_missing_file(new_dir, "settings.json")?;
        return Ok(());
    }

    for old_dir in legacy_app_data_dirs() {
        let old_db = old_dir.join("hosts.db");
        if !old_db.is_file() {
            continue;
        }
        for name in DATA_FILES {
            let src = old_dir.join(name);
            let dst = new_dir.join(name);
            if src.is_file() && !dst.exists() {
                fs::copy(&src, &dst)
                    .map_err(|e| format!("migrate {} from {}: {e}", name, old_dir.display()))?;
                eprintln!(
                    "[miterm] migrated {} → {}",
                    src.display(),
                    dst.display()
                );
            }
        }
        return Ok(());
    }

    Ok(())
}

fn migrate_missing_file(new_dir: &Path, name: &str) -> Result<(), String> {
    let dst = new_dir.join(name);
    if dst.exists() {
        return Ok(());
    }
    for old_dir in legacy_app_data_dirs() {
        let src = old_dir.join(name);
        if src.is_file() {
            fs::copy(&src, &dst)
                .map_err(|e| format!("migrate {} from {}: {e}", name, old_dir.display()))?;
            eprintln!(
                "[miterm] migrated {} → {}",
                src.display(),
                dst.display()
            );
            break;
        }
    }
    Ok(())
}

fn legacy_app_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(windows)]
    if let Some(base) = std::env::var_os("APPDATA").map(PathBuf::from) {
        for id in LEGACY_IDENTIFIERS {
            dirs.push(base.join(id));
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let support = home.join("Library").join("Application Support");
        for id in LEGACY_IDENTIFIERS {
            dirs.push(support.join(id));
        }
    }

    #[cfg(target_os = "linux")]
    if let Some(home) = home_dir() {
        let share = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"));
        for id in LEGACY_IDENTIFIERS {
            dirs.push(share.join(id));
        }
    }

    dirs
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
