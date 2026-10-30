use crate::{preferences, AppState, LastOpenedProject};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    page_id: Option<String>,
    last_used_at: u64,
}

#[derive(Deserialize, Serialize)]
struct History {
    version: u8,
    projects: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingProject {
    path: String,
    name: String,
    page_id: Option<String>,
    last_used_at: u64,
    page_count: Option<usize>,
    size_bytes: Option<u64>,
    modified_at: Option<u64>,
    status: &'static str,
}

fn millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| d.as_millis().try_into().ok())
}

fn now() -> u64 {
    millis(SystemTime::now()).unwrap_or(0)
}

// Entries are canonicalized when recorded. Comparisons must not probe every saved
// drive during page navigation; disconnected drives can take a long time to resolve.
fn identity(path: &str) -> String {
    let path = Path::new(path);
    #[cfg(windows)]
    {
        dunce::simplified(path)
            .to_string_lossy()
            .replace('/', "\\")
            .to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string_lossy().into_owned()
    }
}

pub fn same_path(a: &str, b: &str) -> bool {
    identity(a) == identity(b)
}

fn write_history(config: &Path, history: &History) -> Result<(), String> {
    fs::create_dir_all(config).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(config).map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec_pretty(history).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(config.join("working-projects.json"))
        .map_err(|e| e.error.to_string())?;
    Ok(())
}

fn read_history(config: &Path) -> Result<History, String> {
    match fs::read(config.join("working-projects.json")) {
        Ok(raw) => {
            let mut history: History = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            if history.version != 1 {
                return Err("Unsupported working project history version".into());
            }
            let mut seen = std::collections::HashSet::new();
            history
                .projects
                .sort_by_key(|p| std::cmp::Reverse(p.last_used_at));
            history
                .projects
                .retain(|p| !p.path.trim().is_empty() && seen.insert(identity(&p.path)));
            history.projects.truncate(HISTORY_LIMIT);
            Ok(history)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let previous = preferences::read_preferences(config, None).last_project;
            let history = History {
                version: 1,
                projects: previous
                    .into_iter()
                    .filter(|p| !p.path.trim().is_empty())
                    .map(|p| Entry {
                        path: fs::canonicalize(&p.path)
                            .map(|path| path.to_string_lossy().into_owned())
                            .unwrap_or(p.path),
                        page_id: Some(p.page_id),
                        last_used_at: now(),
                    })
                    .collect(),
            };
            // Persist migration even when empty so removing the final entry stays final.
            write_history(config, &history)?;
            Ok(history)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn inspect(entry: &Entry) -> WorkingProject {
    let path = Path::new(&entry.path);
    let mut result = WorkingProject {
        path: entry.path.clone(),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| entry.path.clone()),
        page_id: entry.page_id.clone(),
        last_used_at: entry.last_used_at,
        page_count: None,
        size_bytes: None,
        modified_at: None,
        status: "unavailable",
    };
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                result.status = "missing";
            }
            return result;
        }
    };
    if !metadata.is_file() {
        result.status = "invalid";
        return result;
    }
    result.size_bytes = Some(metadata.len());
    result.modified_at = metadata.modified().ok().and_then(millis);
    // SQLite changes may still live in the WAL. Include its size and update time;
    // opening the list must neither checkpoint the project nor create a database.
    let mut wal_name = path.as_os_str().to_os_string();
    wal_name.push("-wal");
    if let Ok(wal) = fs::metadata(wal_name) {
        result.size_bytes = Some(metadata.len().saturating_add(wal.len()));
        if wal.len() > 0 {
            result.modified_at = result.modified_at.max(wal.modified().ok().and_then(millis));
        }
    }
    let conn = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(conn) => conn,
        Err(_) => return result,
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(100));
    if let Err(error) = crate::validate_schema(&conn) {
        result.status = match error {
            crate::BackendError::Database(rusqlite::Error::SqliteFailure(ref e, _))
                if matches!(
                    e.code,
                    rusqlite::ErrorCode::DatabaseBusy
                        | rusqlite::ErrorCode::DatabaseLocked
                        | rusqlite::ErrorCode::PermissionDenied
                        | rusqlite::ErrorCode::CannotOpen
                ) =>
            {
                "unavailable"
            }
            _ => "invalid",
        };
        return result;
    }
    let manifest = conn
        .query_row("SELECT value FROM meta WHERE key='manifest'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional();
    match manifest {
        Ok(Some(raw)) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) => {
                result.page_count = value.get("pages").and_then(|p| p.as_array()).map(Vec::len);
                if result.page_count.is_none() {
                    result.status = "invalid";
                    return result;
                }
            }
            Err(_) => {
                result.status = "invalid";
                return result;
            }
        },
        Ok(None) => {} // Older projects can acquire a manifest when opened.
        Err(_) => return result,
    }
    result.status = "available";
    result
}

#[tauri::command]
pub async fn list_working_projects(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<WorkingProject>, String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let lock = state.preferences_lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let entries = {
            let _guard = lock.lock().map_err(|_| "preferences lock is unavailable")?;
            read_history(&config)?.projects
        };
        Ok(entries.iter().map(inspect).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn record_working_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
    page_id: Option<String>,
    previous_path: Option<String>,
) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    // Called only after a successful project load. Normalize the stored path once.
    let path = crate::canonical_or_absolute(Path::new(&project_path)).map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Err("Project file not found".into());
    }
    let entry = Entry {
        path: path.to_string_lossy().into_owned(),
        page_id,
        last_used_at: now(),
    };
    let _guard = state
        .preferences_lock
        .lock()
        .map_err(|_| "preferences lock is unavailable")?;
    let mut history = read_history(&config)?;
    history.projects.retain(|p| {
        !same_path(&p.path, &entry.path)
            && !previous_path
                .as_deref()
                .is_some_and(|old| same_path(&p.path, old))
    });
    history.projects.insert(0, entry.clone());
    history.projects.truncate(HISTORY_LIMIT);
    write_history(&config, &history)?;
    let mut prefs = preferences::read_preferences(&config, crate::current_os_locale());
    prefs.last_project = entry.page_id.map(|page_id| LastOpenedProject {
        path: entry.path,
        page_id,
    });
    preferences::write_preferences(&config, &prefs)
}

// Navigation updates a registered entry, but does not re-register an entry the
// user explicitly removed while leaving its project open.
pub fn remember_page(config: &Path, path: &str, page_id: &str) -> Result<bool, String> {
    let mut history = read_history(config)?;
    if let Some(entry) = history
        .projects
        .iter_mut()
        .find(|p| same_path(&p.path, path))
    {
        entry.page_id = Some(page_id.into());
        write_history(config, &history)?;
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn forget_working_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
) -> Result<(), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let _guard = state
        .preferences_lock
        .lock()
        .map_err(|_| "preferences lock is unavailable")?;
    let mut history = read_history(&config)?;
    history
        .projects
        .retain(|p| !same_path(&p.path, &project_path));
    write_history(&config, &history)?;
    let mut prefs = preferences::read_preferences(&config, crate::current_os_locale());
    if prefs
        .last_project
        .as_ref()
        .is_some_and(|p| same_path(&p.path, &project_path))
    {
        prefs.last_project = None;
        preferences::write_preferences(&config, &prefs)?;
    }
    Ok(())
}
