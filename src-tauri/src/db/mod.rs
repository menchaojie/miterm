use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedHost {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub category_id: Option<i64>,
    pub last_used_at: i64,
    /// ssh | local
    pub conn_type: String,
    /// powershell | cmd | gitbash | custom（仅 local）
    pub shell: String,
    pub shell_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHostParams {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub category_id: Option<i64>,
    pub conn_type: Option<String>,
    pub shell: Option<String>,
    pub shell_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateHostParams {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub category_id: Option<i64>,
    pub conn_type: Option<String>,
    pub shell: Option<String>,
    pub shell_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCategoryParams {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategoryParams {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspace {
    pub id: i64,
    pub name: String,
    /// folder | group
    pub kind: String,
    pub payload: String,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceParams {
    pub name: String,
    pub kind: String,
    pub payload: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceParams {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub sort_order: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCommandParams {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommandParams {
    pub id: i64,
    pub title: String,
    pub body: String,
}

fn resolve_name(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        fallback.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn normalize_conn_type(raw: Option<&str>) -> String {
    match raw.map(str::trim).unwrap_or("ssh") {
        "local" => "local".into(),
        _ => "ssh".into(),
    }
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut stmt| {
            let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
            for col in cols {
                if col? == column {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .unwrap_or(false)
}

fn migrate_saved_hosts(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "saved_hosts", "name") {
        conn.execute_batch(
            "ALTER TABLE saved_hosts ADD COLUMN name TEXT NOT NULL DEFAULT '';
             UPDATE saved_hosts SET name = host WHERE name = '' OR name IS NULL;",
        )
        .map_err(|e| format!("migrate name column: {e}"))?;
    } else {
        let _ = conn.execute(
            "UPDATE saved_hosts SET name = host WHERE name = '' OR name IS NULL",
            [],
        );
    }

    if !table_has_column(conn, "saved_hosts", "category_id") {
        conn.execute(
            "ALTER TABLE saved_hosts ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL",
            [],
        )
        .map_err(|e| format!("migrate category_id: {e}"))?;
    }

    let needs_conn = !table_has_column(conn, "saved_hosts", "conn_type");
    let needs_shell = !table_has_column(conn, "saved_hosts", "shell");
    let needs_path = !table_has_column(conn, "saved_hosts", "shell_path");

    if needs_conn || needs_shell || needs_path {
        // 重建表：去掉 UNIQUE(host,port,username)，便于多条本地终端
        conn.execute_batch(
            "CREATE TABLE saved_hosts_new (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL DEFAULT '',
               host TEXT NOT NULL,
               port INTEGER NOT NULL,
               username TEXT NOT NULL,
               password TEXT NOT NULL,
               category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
               last_used_at INTEGER NOT NULL,
               conn_type TEXT NOT NULL DEFAULT 'ssh',
               shell TEXT NOT NULL DEFAULT '',
               shell_path TEXT NOT NULL DEFAULT ''
             );
             INSERT INTO saved_hosts_new
               (id, name, host, port, username, password, category_id, last_used_at, conn_type, shell, shell_path)
             SELECT
               id,
               COALESCE(NULLIF(TRIM(name), ''), host),
               host,
               port,
               username,
               password,
               category_id,
               last_used_at,
               'ssh',
               '',
               ''
             FROM saved_hosts;
             DROP TABLE saved_hosts;
             ALTER TABLE saved_hosts_new RENAME TO saved_hosts;",
        )
        .map_err(|e| format!("migrate conn_type/shell: {e}"))?;
    }

    Ok(())
}

pub struct HostStore {
    conn: Mutex<Connection>,
}

impl HostStore {
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir)
            .map_err(|e| format!("create app data dir: {e}"))?;

        let path = app_data_dir.join("hosts.db");
        let conn = Connection::open(&path).map_err(|e| format!("open db: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS categories (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL UNIQUE,
               sort_order INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS saved_hosts (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL DEFAULT '',
               host TEXT NOT NULL,
               port INTEGER NOT NULL,
               username TEXT NOT NULL,
               password TEXT NOT NULL,
               category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
               last_used_at INTEGER NOT NULL,
               conn_type TEXT NOT NULL DEFAULT 'ssh',
               shell TEXT NOT NULL DEFAULT '',
               shell_path TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS workspaces (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               kind TEXT NOT NULL,
               payload TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS saved_commands (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               title TEXT NOT NULL,
               body TEXT NOT NULL,
               sort_order INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("init schema: {e}"))?;

        migrate_saved_hosts(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn list_categories(&self) -> Result<Vec<Category>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, sort_order FROM categories
                 ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
            )
            .map_err(|e| format!("prepare categories: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Category {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                })
            })
            .map_err(|e| format!("query categories: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("category row: {e}"))?);
        }
        Ok(out)
    }

    pub fn create_category(&self, params: SaveCategoryParams) -> Result<Category, String> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err("分类名称不能为空".into());
        }
        let conn = self.conn.lock();
        let next_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories",
                [],
                |row| row.get(0),
            )
            .unwrap_or(1);
        conn.execute(
            "INSERT INTO categories (name, sort_order) VALUES (?1, ?2)",
            params![name, next_order],
        )
        .map_err(|e| format!("create category: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(Category {
            id,
            name: name.to_string(),
            sort_order: next_order,
        })
    }

    pub fn update_category(&self, params: UpdateCategoryParams) -> Result<Category, String> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err("分类名称不能为空".into());
        }
        let conn = self.conn.lock();
        let sort_order: i64 = conn
            .query_row(
                "SELECT sort_order FROM categories WHERE id = ?1",
                params![params.id],
                |row| row.get(0),
            )
            .map_err(|_| "category not found".to_string())?;
        let n = conn
            .execute(
                "UPDATE categories SET name = ?1 WHERE id = ?2",
                params![name, params.id],
            )
            .map_err(|e| format!("update category: {e}"))?;
        if n == 0 {
            return Err("category not found".into());
        }
        Ok(Category {
            id: params.id,
            name: name.to_string(),
            sort_order,
        })
    }

    pub fn delete_category(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE saved_hosts SET category_id = NULL WHERE category_id = ?1",
            params![id],
        )
        .map_err(|e| format!("clear hosts category: {e}"))?;
        let n = conn
            .execute("DELETE FROM categories WHERE id = ?1", params![id])
            .map_err(|e| format!("delete category: {e}"))?;
        if n == 0 {
            return Err("category not found".into());
        }
        Ok(())
    }

    fn map_host_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedHost> {
        let host: String = row.get(2)?;
        let mut name: String = row.get(1)?;
        if name.trim().is_empty() {
            name = host.clone();
        }
        Ok(SavedHost {
            id: row.get(0)?,
            name,
            host,
            port: row.get::<_, i64>(3)? as u16,
            username: row.get(4)?,
            password: row.get(5)?,
            category_id: row.get(6)?,
            last_used_at: row.get(7)?,
            conn_type: row.get(8)?,
            shell: row.get(9)?,
            shell_path: row.get(10)?,
        })
    }

    const SELECT_HOST: &'static str = "SELECT id, name, host, port, username, password,
                 category_id, last_used_at, conn_type, shell, shell_path
                 FROM saved_hosts";

    pub fn list(&self) -> Result<Vec<SavedHost>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(&format!(
                "{} ORDER BY last_used_at DESC",
                Self::SELECT_HOST
            ))
            .map_err(|e| format!("prepare list: {e}"))?;

        let rows = stmt
            .query_map([], Self::map_host_row)
            .map_err(|e| format!("query list: {e}"))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("row: {e}"))?);
        }
        Ok(out)
    }

    fn fetch_host(conn: &Connection, id: i64) -> Result<SavedHost, String> {
        conn.query_row(
            &format!("{} WHERE id = ?1", Self::SELECT_HOST),
            params![id],
            Self::map_host_row,
        )
        .map_err(|e| format!("fetch host: {e}"))
    }

    pub fn upsert(&self, params: SaveHostParams) -> Result<SavedHost, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let conn_type = normalize_conn_type(params.conn_type.as_deref());
        let shell = params
            .shell
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let shell_path = params
            .shell_path
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();

        let (host, port, username, password, name_fallback) = if conn_type == "local" {
            if shell.is_empty() {
                return Err("请选择本地 Shell".into());
            }
            (
                "local".to_string(),
                0u16,
                shell.clone(),
                String::new(),
                shell.clone(),
            )
        } else {
            let host = params.host.trim().to_string();
            if host.is_empty() {
                return Err("请填写 Host".into());
            }
            (
                host.clone(),
                params.port,
                params.username.trim().to_string(),
                params.password,
                host,
            )
        };
        let name = resolve_name(&params.name, &name_fallback);

        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO saved_hosts
               (name, host, port, username, password, category_id, last_used_at, conn_type, shell, shell_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                name,
                host,
                port as i64,
                username,
                password,
                params.category_id,
                now,
                conn_type,
                if conn_type == "local" {
                    shell
                } else {
                    String::new()
                },
                if conn_type == "local" {
                    shell_path
                } else {
                    String::new()
                },
            ],
        )
        .map_err(|e| format!("insert: {e}"))?;

        let id = conn.last_insert_rowid();
        Self::fetch_host(&conn, id)
    }

    pub fn update(&self, params: UpdateHostParams) -> Result<SavedHost, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let conn_type = normalize_conn_type(params.conn_type.as_deref());
        let shell = params
            .shell
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let shell_path = params
            .shell_path
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();

        let (host, port, username, password, name_fallback) = if conn_type == "local" {
            if shell.is_empty() {
                return Err("请选择本地 Shell".into());
            }
            (
                "local".to_string(),
                0u16,
                shell.clone(),
                String::new(),
                shell.clone(),
            )
        } else {
            let host = params.host.trim().to_string();
            if host.is_empty() {
                return Err("请填写 Host".into());
            }
            (
                host.clone(),
                params.port,
                params.username.trim().to_string(),
                params.password,
                host,
            )
        };
        let name = resolve_name(&params.name, &name_fallback);

        let conn = self.conn.lock();
        let n = conn
            .execute(
                "UPDATE saved_hosts
                 SET name = ?1, host = ?2, port = ?3, username = ?4, password = ?5,
                     category_id = ?6, last_used_at = ?7, conn_type = ?8, shell = ?9, shell_path = ?10
                 WHERE id = ?11",
                params![
                    name,
                    host,
                    port as i64,
                    username,
                    password,
                    params.category_id,
                    now,
                    conn_type,
                    if conn_type == "local" {
                        shell
                    } else {
                        String::new()
                    },
                    if conn_type == "local" {
                        shell_path
                    } else {
                        String::new()
                    },
                    params.id
                ],
            )
            .map_err(|e| format!("update: {e}"))?;
        if n == 0 {
            return Err("host not found".into());
        }

        Self::fetch_host(&conn, params.id)
    }

    pub fn touch(&self, id: i64) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        let n = conn
            .execute(
                "UPDATE saved_hosts SET last_used_at = ?1 WHERE id = ?2",
                params![now, id],
            )
            .map_err(|e| format!("touch: {e}"))?;
        if n == 0 {
            return Err("host not found".into());
        }
        Ok(())
    }

    pub fn delete(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        let n = conn
            .execute("DELETE FROM saved_hosts WHERE id = ?1", params![id])
            .map_err(|e| format!("delete: {e}"))?;
        if n == 0 {
            return Err("host not found".into());
        }
        Ok(())
    }

    pub fn list_workspaces(&self) -> Result<Vec<SavedWorkspace>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, kind, payload, updated_at FROM workspaces
                 ORDER BY updated_at DESC, id DESC",
            )
            .map_err(|e| format!("prepare workspaces: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SavedWorkspace {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    payload: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("query workspaces: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("workspace row: {e}"))?);
        }
        Ok(out)
    }

    pub fn save_workspace(&self, params: SaveWorkspaceParams) -> Result<SavedWorkspace, String> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err("工作区名称不能为空".into());
        }
        let kind = match params.kind.trim() {
            "group" => "group",
            _ => "folder",
        };
        if params.payload.trim().is_empty() {
            return Err("工作区内容不能为空".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO workspaces (name, kind, payload, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![name, kind, params.payload, now],
        )
        .map_err(|e| format!("save workspace: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(SavedWorkspace {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            payload: params.payload,
            updated_at: now,
        })
    }

    pub fn update_workspace(
        &self,
        params: UpdateWorkspaceParams,
    ) -> Result<SavedWorkspace, String> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err("工作区名称不能为空".into());
        }
        let kind = match params.kind.trim() {
            "group" => "group",
            _ => "folder",
        };
        if params.payload.trim().is_empty() {
            return Err("工作区内容不能为空".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        let n = conn
            .execute(
                "UPDATE workspaces SET name = ?1, kind = ?2, payload = ?3, updated_at = ?4 WHERE id = ?5",
                params![name, kind, params.payload, now, params.id],
            )
            .map_err(|e| format!("update workspace: {e}"))?;
        if n == 0 {
            return Err("workspace not found".into());
        }
        Ok(SavedWorkspace {
            id: params.id,
            name: name.to_string(),
            kind: kind.to_string(),
            payload: params.payload,
            updated_at: now,
        })
    }

    pub fn delete_workspace(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        let n = conn
            .execute("DELETE FROM workspaces WHERE id = ?1", params![id])
            .map_err(|e| format!("delete workspace: {e}"))?;
        if n == 0 {
            return Err("workspace not found".into());
        }
        Ok(())
    }

    pub fn list_commands(&self) -> Result<Vec<SavedCommand>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, body, sort_order, updated_at FROM saved_commands
                 ORDER BY sort_order ASC, updated_at DESC, id DESC",
            )
            .map_err(|e| format!("prepare commands: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SavedCommand {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body: row.get(2)?,
                    sort_order: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("query commands: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("command row: {e}"))?);
        }
        Ok(out)
    }

    pub fn save_command(&self, params: SaveCommandParams) -> Result<SavedCommand, String> {
        let title = params.title.trim();
        if title.is_empty() {
            return Err("命令标题不能为空".into());
        }
        let body = params.body.trim_end();
        if body.trim().is_empty() {
            return Err("命令内容不能为空".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        let next_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM saved_commands",
                [],
                |row| row.get(0),
            )
            .unwrap_or(1);
        conn.execute(
            "INSERT INTO saved_commands (title, body, sort_order, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![title, body, next_order, now],
        )
        .map_err(|e| format!("save command: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(SavedCommand {
            id,
            title: title.to_string(),
            body: body.to_string(),
            sort_order: next_order,
            updated_at: now,
        })
    }

    pub fn update_command(&self, params: UpdateCommandParams) -> Result<SavedCommand, String> {
        let title = params.title.trim();
        if title.is_empty() {
            return Err("命令标题不能为空".into());
        }
        let body = params.body.trim_end();
        if body.trim().is_empty() {
            return Err("命令内容不能为空".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        let sort_order: i64 = conn
            .query_row(
                "SELECT sort_order FROM saved_commands WHERE id = ?1",
                params![params.id],
                |row| row.get(0),
            )
            .map_err(|_| "command not found".to_string())?;
        let n = conn
            .execute(
                "UPDATE saved_commands SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4",
                params![title, body, now, params.id],
            )
            .map_err(|e| format!("update command: {e}"))?;
        if n == 0 {
            return Err("command not found".into());
        }
        Ok(SavedCommand {
            id: params.id,
            title: title.to_string(),
            body: body.to_string(),
            sort_order,
            updated_at: now,
        })
    }

    pub fn delete_command(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        let n = conn
            .execute("DELETE FROM saved_commands WHERE id = ?1", params![id])
            .map_err(|e| format!("delete command: {e}"))?;
        if n == 0 {
            return Err("command not found".into());
        }
        Ok(())
    }
}
