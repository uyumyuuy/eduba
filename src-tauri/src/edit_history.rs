use super::{
    completed_page_ids, open_connection, project_root, validate_manifest, BackendError,
    BackendResult,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
};

const MAX_OPERATIONS: usize = 100;
const MAX_COMPRESSED_BYTES: usize = 50 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryRecord {
    pub id: String,
    pub data: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryState {
    pub version: u8,
    pub order: Vec<String>,
    pub cursor: usize,
    #[serde(default)]
    pub records: Vec<HistoryRecord>,
}
impl Default for HistoryState {
    fn default() -> Self {
        Self {
            version: 1,
            order: Vec::new(),
            cursor: 0,
            records: Vec::new(),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageUpdate {
    pub page_id: String,
    pub data: Option<String>,
    pub expected_data: Option<String>,
    #[serde(default)]
    pub expected_missing: bool,
}
#[derive(Debug, Serialize)]
pub struct SavedHistory {
    pub order: Vec<String>,
    pub cursor: usize,
}

fn validate_state(state: &HistoryState) -> BackendResult<()> {
    let unique: HashSet<_> = state.order.iter().collect();
    if state.version != 1
        || state.order.len() > MAX_OPERATIONS
        || state.cursor > state.order.len()
        || unique.len() != state.order.len()
        || state.order.iter().any(|id| id.is_empty() || id.len() > 128)
    {
        return Err(BackendError::msg("invalid edit history state"));
    }
    Ok(())
}
fn validate_record(data: &str) -> BackendResult<()> {
    if data.len() > MAX_RECORD_BYTES {
        return Err(BackendError::msg("edit history record exceeds 128 MiB"));
    }
    let value: serde_json::Value = serde_json::from_str(data)?;
    if value["version"] != 1
        || !value["operation"]["changes"].is_array()
        || !value["operation"]["targetPageId"].is_string()
    {
        return Err(BackendError::msg("unsupported edit history record"));
    }
    Ok(())
}
fn compress(data: &str) -> BackendResult<Vec<u8>> {
    validate_record(data)?;
    let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
    gzip.write_all(data.as_bytes())?;
    Ok(gzip.finish()?)
}
fn decompress(data: &[u8]) -> BackendResult<String> {
    let mut plain = String::new();
    GzDecoder::new(data)
        .take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_string(&mut plain)?;
    validate_record(&plain)?;
    Ok(plain)
}

fn trim_to_budget(
    order: &mut Vec<String>,
    cursor: &mut usize,
    sizes: &HashMap<String, usize>,
    budget: usize,
) {
    let mut bytes: usize = sizes.values().sum();
    while bytes > budget && !order.is_empty() {
        let removed = if *cursor > 0 {
            *cursor -= 1;
            order.remove(0)
        } else {
            order.pop().unwrap()
        };
        bytes -= sizes[&removed];
    }
}

#[tauri::command]
pub fn load_edit_history(project_path: String) -> Result<HistoryState, String> {
    load_impl(&project_path).map_err(|error| error.to_string())
}
pub(super) fn load_impl(project_path: &str) -> BackendResult<HistoryState> {
    let conn = open_connection(&project_root(project_path)?)?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key='edit_history'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(HistoryState::default());
    };
    let mut state: HistoryState = serde_json::from_str(&raw)?;
    validate_state(&state)?;
    state.records.clear();
    for id in &state.order {
        let compressed: Vec<u8> = conn.query_row(
            "SELECT payload FROM edit_history_records WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        state.records.push(HistoryRecord {
            id: id.clone(),
            data: decompress(&compressed)?,
        });
    }
    Ok(state)
}

#[tauri::command]
pub fn save_project_state(
    project_path: String,
    manifest: String,
    updates: Vec<PageUpdate>,
    history: HistoryState,
) -> Result<SavedHistory, String> {
    save_impl(&project_path, &manifest, &updates, &history).map_err(|error| error.to_string())
}
pub(super) fn save_impl(
    project_path: &str,
    manifest: &str,
    updates: &[PageUpdate],
    history: &HistoryState,
) -> BackendResult<SavedHistory> {
    validate_manifest(manifest)?;
    validate_state(history)?;
    let mut seen = HashSet::new();
    for update in updates {
        let valid_page = if let Some(data) = &update.data {
            let page: serde_json::Value = serde_json::from_str(data)?;
            page["id"].as_str() == Some(&update.page_id)
        } else {
            true
        };
        if update.page_id.is_empty()
            || !seen.insert(&update.page_id)
            || !valid_page
            || (update.expected_missing && update.expected_data.is_some())
        {
            return Err(BackendError::msg(
                "project updates require unique matching page ids",
            ));
        }
    }
    let requested: HashSet<_> = history.order.iter().collect();
    let mut new_records = HashMap::new();
    for record in &history.records {
        if !requested.contains(&record.id) || new_records.contains_key(&record.id) {
            return Err(BackendError::msg("invalid edit history records"));
        }
        new_records.insert(record.id.clone(), compress(&record.data)?);
    }
    let mut conn = open_connection(&project_root(project_path)?)?;
    let tx = conn.transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS edit_history_records (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL)")?;
    let completed = completed_page_ids(&tx)?;
    for update in updates {
        if update.expected_missing {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM pages WHERE page_id=?1)",
                [&update.page_id],
                |row| row.get(0),
            )?;
            if exists {
                return Err(BackendError::msg("history expected an unrecognized page"));
            }
        }
        if let Some(expected) = &update.expected_data {
            if completed.contains(&update.page_id) {
                return Err(BackendError::msg(format!(
                    "page is marked proofread: {}",
                    update.page_id
                )));
            }
            let actual: Option<String> = tx
                .query_row(
                    "SELECT data FROM pages WHERE page_id=?1",
                    [&update.page_id],
                    |row| row.get(0),
                )
                .optional()?;
            if actual.as_ref() != Some(expected) {
                return Err(BackendError::msg(format!(
                    "page changed while saving history: {}",
                    update.page_id
                )));
            }
        }
    }
    for (id, compressed) in new_records {
        let existing: Option<Vec<u8>> = tx
            .query_row(
                "SELECT payload FROM edit_history_records WHERE id=?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            if existing != compressed {
                return Err(BackendError::msg("edit history record IDs are immutable"));
            }
        } else {
            tx.execute(
                "INSERT INTO edit_history_records(id,payload) VALUES (?1,?2)",
                params![id, compressed],
            )?;
        }
    }
    let mut order = history.order.clone();
    let mut cursor = history.cursor;
    let mut sizes = HashMap::new();
    for id in &order {
        let size: usize = tx.query_row(
            "SELECT length(payload) FROM edit_history_records WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        sizes.insert(id.clone(), size);
    }
    // Remove oldest applied changes first; retain the next redo and trim its far end if necessary.
    trim_to_budget(&mut order, &mut cursor, &sizes, MAX_COMPRESSED_BYTES);
    let keep: HashSet<_> = order.iter().collect();
    let existing: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM edit_history_records")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in existing {
        if !keep.contains(&id) {
            tx.execute("DELETE FROM edit_history_records WHERE id=?1", [&id])?;
        }
    }
    for update in updates {
        if let Some(data) = &update.data {
            tx.execute("INSERT INTO pages(page_id,data) VALUES (?1,?2) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data", params![update.page_id, data])?;
        } else {
            tx.execute("DELETE FROM pages WHERE page_id=?1", [&update.page_id])?;
        }
    }
    let state = HistoryState {
        version: 1,
        order: order.clone(),
        cursor,
        records: Vec::new(),
    };
    tx.execute("INSERT INTO meta(key,value) VALUES ('edit_history',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [serde_json::to_string(&state)?])?;
    tx.execute("INSERT INTO meta(key,value) VALUES ('manifest',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [manifest])?;
    tx.commit()?;
    Ok(SavedHistory { order, cursor })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::initialize_schema;
    use rusqlite::Connection;
    fn project() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.eduba");
        initialize_schema(&Connection::open(&path).unwrap()).unwrap();
        (dir, path.to_string_lossy().into_owned())
    }
    fn record(id: &str) -> HistoryRecord {
        HistoryRecord {
            id: id.into(),
            data: r#"{"version":1,"operation":{"targetPageId":"p","changes":[]}}"#.into(),
        }
    }
    #[test]
    fn old_projects_load_empty_and_gzip_records_survive_reopen_and_cursor_moves() {
        let (_dir, path) = project();
        assert!(load_impl(&path).unwrap().order.is_empty());
        let state = HistoryState {
            order: vec!["a".into(), "b".into()],
            cursor: 2,
            records: vec![record("a"), record("b")],
            ..Default::default()
        };
        save_impl(&path, r#"{"pages":[]}"#, &[], &state).unwrap();
        let conn = open_connection(&project_root(&path).unwrap()).unwrap();
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT payload FROM edit_history_records WHERE id='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(&blob[..2], &[0x1f, 0x8b]);
        save_impl(
            &path,
            r#"{"pages":[]}"#,
            &[],
            &HistoryState {
                cursor: 1,
                records: vec![],
                ..state.clone()
            },
        )
        .unwrap();
        let loaded = load_impl(&path).unwrap();
        assert_eq!(loaded.cursor, 1);
        assert_eq!(loaded.records[0].data, record("a").data);
        let unchanged: Vec<u8> = conn
            .query_row(
                "SELECT payload FROM edit_history_records WHERE id='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(blob, unchanged);
    }
    #[test]
    fn stale_page_or_missing_record_rolls_back_page_manifest_and_history() {
        let (_dir, path) = project();
        let update = PageUpdate {
            page_id: "p".into(),
            data: Some(r#"{"id":"p","value":1}"#.into()),
            expected_data: None,
            expected_missing: true,
        };
        save_impl(
            &path,
            r#"{"pages":[]}"#,
            &[update],
            &HistoryState::default(),
        )
        .unwrap();
        let update = PageUpdate {
            page_id: "p".into(),
            data: Some(r#"{"id":"p","value":2}"#.into()),
            expected_data: Some("stale".into()),
            expected_missing: false,
        };
        let history = HistoryState {
            order: vec!["a".into()],
            cursor: 1,
            records: vec![record("a")],
            ..Default::default()
        };
        assert!(save_impl(&path, r#"{"pages":[],"changed":true}"#, &[update], &history).is_err());
        assert!(load_impl(&path).unwrap().order.is_empty());
        let missing = HistoryState {
            records: vec![],
            ..history
        };
        assert!(save_impl(&path, r#"{"pages":[]}"#, &[], &missing).is_err());
        let conn = open_connection(&project_root(&path).unwrap()).unwrap();
        let saved: String = conn
            .query_row("SELECT data FROM pages WHERE page_id='p'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(saved.contains("1"));
        let manifest: String = conn
            .query_row("SELECT value FROM meta WHERE key='manifest'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(manifest, r#"{"pages":[]}"#);
    }
    #[test]
    fn branching_after_undo_deletes_abandoned_redo_records() {
        let (_dir, path) = project();
        let state = HistoryState {
            order: vec!["a".into(), "b".into()],
            cursor: 1,
            records: vec![record("a"), record("b")],
            ..Default::default()
        };
        save_impl(&path, "{}", &[], &state).unwrap();
        save_impl(
            &path,
            "{}",
            &[],
            &HistoryState {
                order: vec!["a".into(), "c".into()],
                cursor: 2,
                records: vec![record("c")],
                ..Default::default()
            },
        )
        .unwrap();
        let loaded = load_impl(&path).unwrap();
        assert_eq!(loaded.order, vec!["a", "c"]);
        let conn = open_connection(&project_root(&path).unwrap()).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM edit_history_records", [], |row| row
                .get::<_, usize>(
                0
            ))
            .unwrap(),
            2
        );
    }
    #[test]
    fn capacity_preserves_a_contiguous_undo_redo_chain_and_rejects_invalid_records() {
        let sizes = HashMap::from([("a".into(), 4), ("b".into(), 4), ("c".into(), 4)]);
        let mut order = vec!["a".into(), "b".into(), "c".into()];
        let mut cursor = 2;
        trim_to_budget(&mut order, &mut cursor, &sizes, 8);
        assert_eq!(order, vec!["b", "c"]);
        assert_eq!(cursor, 1);
        let mut order = vec!["a".into(), "b".into(), "c".into()];
        let mut cursor = 0;
        trim_to_budget(&mut order, &mut cursor, &sizes, 8);
        assert_eq!(order, vec!["a", "b"]);
        assert_eq!(cursor, 0);
        assert!(compress("invalid JSON").is_err());
        assert!(decompress(b"not gzip").is_err());
        assert!(validate_state(&HistoryState {
            order: (0..101).map(|i| i.to_string()).collect(),
            ..Default::default()
        })
        .is_err());
    }
    #[test]
    fn absent_page_snapshots_can_be_restored_without_overwriting_a_new_page() {
        let (_dir, path) = project();
        let data = r#"{"id":"p"}"#;
        let create = PageUpdate {
            page_id: "p".into(),
            data: Some(data.into()),
            expected_data: None,
            expected_missing: true,
        };
        save_impl(&path, "{}", &[create], &HistoryState::default()).unwrap();
        let duplicate = PageUpdate {
            page_id: "p".into(),
            data: Some(data.into()),
            expected_data: None,
            expected_missing: true,
        };
        assert!(save_impl(&path, "{}", &[duplicate], &HistoryState::default()).is_err());
        let delete = PageUpdate {
            page_id: "p".into(),
            data: None,
            expected_data: Some(data.into()),
            expected_missing: false,
        };
        save_impl(&path, "{}", &[delete], &HistoryState::default()).unwrap();
        let conn = open_connection(&project_root(&path).unwrap()).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pages", [], |row| row
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
}
