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
    pub category_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceParams {
    pub name: String,
    pub kind: String,
    pub payload: String,
    #[serde(default)]
    pub category_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceParams {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub payload: String,
    #[serde(default)]
    pub category_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub sort_order: i64,
    pub updated_at: i64,
    pub category_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCommandParams {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub category_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommandParams {
    pub id: i64,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub category_id: Option<i64>,
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

fn migrate_workspaces(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "workspaces", "category_id") {
        conn.execute(
            "ALTER TABLE workspaces ADD COLUMN category_id INTEGER",
            [],
        )
        .map_err(|e| format!("migrate workspaces category_id: {e}"))?;
    }
    Ok(())
}

fn migrate_saved_commands(conn: &Connection) -> Result<(), String> {
    if !table_has_column(conn, "saved_commands", "category_id") {
        conn.execute(
            "ALTER TABLE saved_commands ADD COLUMN category_id INTEGER",
            [],
        )
        .map_err(|e| format!("migrate saved_commands category_id: {e}"))?;
    }
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| format!("schema_meta: {e}"))?;
    Ok(())
}

fn upsert_domain_category(
    conn: &Connection,
    table: &str,
    name: &str,
) -> Result<i64, String> {
    if let Ok(id) = conn.query_row(
        &format!("SELECT id FROM {table} WHERE name = ?1"),
        params![name],
        |row| row.get::<_, i64>(0),
    ) {
        return Ok(id);
    }
    let next_order: i64 = conn
        .query_row(
            &format!("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM {table}"),
            [],
            |row| row.get(0),
        )
        .unwrap_or(1);
    conn.execute(
        &format!("INSERT INTO {table} (name, sort_order) VALUES (?1, ?2)"),
        params![name, next_order],
    )
    .map_err(|e| format!("insert {table}: {e}"))?;
    Ok(conn.last_insert_rowid())
}

/// 将实体表上仍指向主机 categories 的 category_id 迁到独立分类表，并重建 FK。
fn migrate_domain_categories(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS workspace_categories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           sort_order INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS command_categories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           sort_order INTEGER NOT NULL DEFAULT 0
         );",
    )
    .map_err(|e| format!("domain category tables: {e}"))?;

    if meta_get(conn, "domain_categories_v1").as_deref() == Some("1") {
        return Ok(());
    }

    remap_and_rebuild_entity_categories(
        conn,
        "workspaces",
        "workspace_categories",
        "CREATE TABLE workspaces_new (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           kind TEXT NOT NULL,
           payload TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           category_id INTEGER REFERENCES workspace_categories(id) ON DELETE SET NULL
         );
         INSERT INTO workspaces_new (id, name, kind, payload, updated_at, category_id)
           SELECT id, name, kind, payload, updated_at, category_id FROM workspaces;
         DROP TABLE workspaces;
         ALTER TABLE workspaces_new RENAME TO workspaces;",
    )?;

    remap_and_rebuild_entity_categories(
        conn,
        "saved_commands",
        "command_categories",
        "CREATE TABLE saved_commands_new (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL,
           category_id INTEGER REFERENCES command_categories(id) ON DELETE SET NULL
         );
         INSERT INTO saved_commands_new (id, title, body, sort_order, updated_at, category_id)
           SELECT id, title, body, sort_order, updated_at, category_id FROM saved_commands;
         DROP TABLE saved_commands;
         ALTER TABLE saved_commands_new RENAME TO saved_commands;",
    )?;

    meta_set(conn, "domain_categories_v1", "1")?;
    Ok(())
}

fn remap_and_rebuild_entity_categories(
    conn: &Connection,
    entity_table: &str,
    domain_table: &str,
    rebuild_sql: &str,
) -> Result<(), String> {
    if !table_has_column(conn, entity_table, "category_id") {
        return Ok(());
    }

    // 从主机 categories 按名称拷贝到域分类，并改写 entity.category_id
    let mut stmt = conn
        .prepare(&format!(
            "SELECT DISTINCT e.category_id, c.name
             FROM {entity_table} e
             LEFT JOIN categories c ON c.id = e.category_id
             WHERE e.category_id IS NOT NULL"
        ))
        .map_err(|e| format!("prepare remap {entity_table}: {e}"))?;
    let pairs: Vec<(i64, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("query remap {entity_table}: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("remap rows {entity_table}: {e}"))?;
    drop(stmt);

    for (old_id, name_opt) in pairs {
        let Some(name) = name_opt.filter(|n| !n.trim().is_empty()) else {
            conn.execute(
                &format!("UPDATE {entity_table} SET category_id = NULL WHERE category_id = ?1"),
                params![old_id],
            )
            .map_err(|e| format!("clear orphan cat on {entity_table}: {e}"))?;
            continue;
        };
        let new_id = upsert_domain_category(conn, domain_table, name.trim())?;
        if new_id == old_id {
            continue;
        }
        // 先搬到临时负数，避免与已有 id 冲突
        conn.execute(
            &format!(
                "UPDATE {entity_table} SET category_id = ?1 WHERE category_id = ?2"
            ),
            params![-old_id, old_id],
        )
        .map_err(|e| format!("temp remap {entity_table}: {e}"))?;
        conn.execute(
            &format!(
                "UPDATE {entity_table} SET category_id = ?1 WHERE category_id = ?2"
            ),
            params![new_id, -old_id],
        )
        .map_err(|e| format!("final remap {entity_table}: {e}"))?;
    }

    conn.execute_batch(rebuild_sql)
        .map_err(|e| format!("rebuild {entity_table}: {e}"))?;
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
             CREATE TABLE IF NOT EXISTS workspace_categories (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL UNIQUE,
               sort_order INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS command_categories (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL UNIQUE,
               sort_order INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS workspaces (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               kind TEXT NOT NULL,
               payload TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               category_id INTEGER REFERENCES workspace_categories(id) ON DELETE SET NULL
             );
             CREATE TABLE IF NOT EXISTS saved_commands (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               title TEXT NOT NULL,
               body TEXT NOT NULL,
               sort_order INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL,
               category_id INTEGER REFERENCES command_categories(id) ON DELETE SET NULL
             );
             CREATE TABLE IF NOT EXISTS schema_meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );",
        )
        .map_err(|e| format!("init schema: {e}"))?;

        migrate_saved_hosts(&conn)?;
        migrate_workspaces(&conn)?;
        migrate_saved_commands(&conn)?;
        migrate_domain_categories(&conn)?;

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

    fn list_domain_categories(conn: &Connection, table: &str) -> Result<Vec<Category>, String> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, name, sort_order FROM {table}
                 ORDER BY sort_order ASC, name COLLATE NOCASE ASC"
            ))
            .map_err(|e| format!("prepare {table}: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Category {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                })
            })
            .map_err(|e| format!("query {table}: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("{table} row: {e}"))?);
        }
        Ok(out)
    }

    fn create_domain_category(
        conn: &Connection,
        table: &str,
        name: &str,
    ) -> Result<Category, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("分类名称不能为空".into());
        }
        let next_order: i64 = conn
            .query_row(
                &format!("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM {table}"),
                [],
                |row| row.get(0),
            )
            .unwrap_or(1);
        conn.execute(
            &format!("INSERT INTO {table} (name, sort_order) VALUES (?1, ?2)"),
            params![name, next_order],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                "分类名称已存在".into()
            } else {
                format!("create {table}: {e}")
            }
        })?;
        Ok(Category {
            id: conn.last_insert_rowid(),
            name: name.to_string(),
            sort_order: next_order,
        })
    }

    fn update_domain_category(
        conn: &Connection,
        table: &str,
        id: i64,
        name: &str,
    ) -> Result<Category, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("分类名称不能为空".into());
        }
        let sort_order: i64 = conn
            .query_row(
                &format!("SELECT sort_order FROM {table} WHERE id = ?1"),
                params![id],
                |row| row.get(0),
            )
            .map_err(|_| "category not found".to_string())?;
        let n = conn
            .execute(
                &format!("UPDATE {table} SET name = ?1 WHERE id = ?2"),
                params![name, id],
            )
            .map_err(|e| {
                if e.to_string().contains("UNIQUE") {
                    "分类名称已存在".into()
                } else {
                    format!("update {table}: {e}")
                }
            })?;
        if n == 0 {
            return Err("category not found".into());
        }
        Ok(Category {
            id,
            name: name.to_string(),
            sort_order,
        })
    }

    fn delete_domain_category(
        conn: &Connection,
        table: &str,
        entity_table: &str,
        id: i64,
    ) -> Result<(), String> {
        conn.execute(
            &format!("UPDATE {entity_table} SET category_id = NULL WHERE category_id = ?1"),
            params![id],
        )
        .map_err(|e| format!("clear {entity_table} category: {e}"))?;
        let n = conn
            .execute(
                &format!("DELETE FROM {table} WHERE id = ?1"),
                params![id],
            )
            .map_err(|e| format!("delete {table}: {e}"))?;
        if n == 0 {
            return Err("category not found".into());
        }
        Ok(())
    }

    pub fn list_workspace_categories(&self) -> Result<Vec<Category>, String> {
        let conn = self.conn.lock();
        Self::list_domain_categories(&conn, "workspace_categories")
    }

    pub fn create_workspace_category(
        &self,
        params: SaveCategoryParams,
    ) -> Result<Category, String> {
        let conn = self.conn.lock();
        Self::create_domain_category(&conn, "workspace_categories", &params.name)
    }

    pub fn update_workspace_category(
        &self,
        params: UpdateCategoryParams,
    ) -> Result<Category, String> {
        let conn = self.conn.lock();
        Self::update_domain_category(&conn, "workspace_categories", params.id, &params.name)
    }

    pub fn delete_workspace_category(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        Self::delete_domain_category(&conn, "workspace_categories", "workspaces", id)
    }

    pub fn list_command_categories(&self) -> Result<Vec<Category>, String> {
        let conn = self.conn.lock();
        Self::list_domain_categories(&conn, "command_categories")
    }

    pub fn create_command_category(
        &self,
        params: SaveCategoryParams,
    ) -> Result<Category, String> {
        let conn = self.conn.lock();
        Self::create_domain_category(&conn, "command_categories", &params.name)
    }

    pub fn update_command_category(
        &self,
        params: UpdateCategoryParams,
    ) -> Result<Category, String> {
        let conn = self.conn.lock();
        Self::update_domain_category(&conn, "command_categories", params.id, &params.name)
    }

    pub fn delete_command_category(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock();
        Self::delete_domain_category(&conn, "command_categories", "saved_commands", id)
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
                "SELECT id, name, kind, payload, updated_at, category_id FROM workspaces
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
                    category_id: row.get(5)?,
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
        let category_id = params.category_id;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        if let Some(cid) = category_id {
            let ok: bool = conn
                .query_row(
                    "SELECT 1 FROM workspace_categories WHERE id = ?1",
                    params![cid],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if !ok {
                return Err("分类不存在".into());
            }
        }
        conn.execute(
            "INSERT INTO workspaces (name, kind, payload, updated_at, category_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, kind, params.payload, now, category_id],
        )
        .map_err(|e| format!("save workspace: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(SavedWorkspace {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            payload: params.payload,
            updated_at: now,
            category_id,
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
        let category_id = params.category_id;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        if let Some(cid) = category_id {
            let ok: bool = conn
                .query_row(
                    "SELECT 1 FROM workspace_categories WHERE id = ?1",
                    params![cid],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if !ok {
                return Err("分类不存在".into());
            }
        }
        let n = conn
            .execute(
                "UPDATE workspaces SET name = ?1, kind = ?2, payload = ?3, updated_at = ?4, category_id = ?5 WHERE id = ?6",
                params![name, kind, params.payload, now, category_id, params.id],
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
            category_id,
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
                "SELECT id, title, body, sort_order, updated_at, category_id FROM saved_commands
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
                    category_id: row.get(5)?,
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
        let category_id = params.category_id;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        if let Some(cid) = category_id {
            let ok: bool = conn
                .query_row(
                    "SELECT 1 FROM command_categories WHERE id = ?1",
                    params![cid],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if !ok {
                return Err("分类不存在".into());
            }
        }
        let next_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM saved_commands",
                [],
                |row| row.get(0),
            )
            .unwrap_or(1);
        conn.execute(
            "INSERT INTO saved_commands (title, body, sort_order, updated_at, category_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![title, body, next_order, now, category_id],
        )
        .map_err(|e| format!("save command: {e}"))?;
        let id = conn.last_insert_rowid();
        Ok(SavedCommand {
            id,
            title: title.to_string(),
            body: body.to_string(),
            sort_order: next_order,
            updated_at: now,
            category_id,
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
        let category_id = params.category_id;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock();
        if let Some(cid) = category_id {
            let ok: bool = conn
                .query_row(
                    "SELECT 1 FROM command_categories WHERE id = ?1",
                    params![cid],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if !ok {
                return Err("分类不存在".into());
            }
        }
        let sort_order: i64 = conn
            .query_row(
                "SELECT sort_order FROM saved_commands WHERE id = ?1",
                params![params.id],
                |row| row.get(0),
            )
            .map_err(|_| "command not found".to_string())?;
        let n = conn
            .execute(
                "UPDATE saved_commands SET title = ?1, body = ?2, updated_at = ?3, category_id = ?4 WHERE id = ?5",
                params![title, body, now, category_id, params.id],
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
            category_id,
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
