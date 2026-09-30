#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{menu::MenuBuilder, AppHandle, Emitter, Manager, State};
use thiserror::Error;
mod preferences;
mod edit_history;
use edit_history::{load_edit_history, save_project_state};
#[path = "style_classifier_runtime/lib.rs"]
pub mod style_classifier_runtime;
use preferences::{LastOpenedProject, LocalePreference, SupportedLocale, UserPreferences};

const SCHEMA_VERSION: &str = "1";
const CHUNK_SIZE: usize = 1024 * 1024;
const MAX_RANGE: u64 = 16 * 1024 * 1024;
const MAX_OCR_IMAGE: usize = 64 * 1024 * 1024;

fn process_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        dunce::simplified(&path).to_path_buf()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

#[derive(Debug, Error)]
enum BackendError {
    #[error("{0}")]
    Message(String),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64 error: {0}")]
    Base64(#[from] base64::DecodeError),
}

impl BackendError {
    fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }
}

type BackendResult<T> = Result<T, BackendError>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub pdf_size: u64,
    pub manifest: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectArgs {
    pub pdf_path: String,
    pub project_path: String,
    pub manifest: Option<String>,
    #[serde(default)]
    pub overwrite_existing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathArgs {
    pub project_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPdfArgs {
    pub project_path: String,
    pub begin: u64,
    pub end: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSourcePdfArgs {
    pub pdf_path: String,
    pub begin: u64,
    pub end: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestArgs {
    pub project_path: String,
    pub manifest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageArgs {
    pub project_path: String,
    pub page_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePageArgs {
    pub project_path: String,
    pub page_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCorrectionsArgs {
    pub project_path: String,
    pub search: String,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionMatch {
    pub page_id: String,
    pub page_label: String,
    pub line_id: String,
    pub line_text: String,
    pub formatting: Option<serde_json::Value>,
    pub auto_formatting: Option<serde_json::Value>,
    pub bbox: Option<serde_json::Value>,
    /// Bounding box of this occurrence (or a bounded line-box approximation).
    #[serde(rename = "matchBBox")]
    pub match_bbox: Option<serde_json::Value>,
    /// Zero-based non-overlapping occurrence within the line text.
    pub match_ordinal: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionSearchPage {
    pub results: Vec<CorrectionMatch>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPageUpdate {
    pub page_id: String,
    pub expected_data: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyBulkCorrectionsArgs {
    pub project_path: String,
    pub updates: Vec<BulkPageUpdate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkPageChange {
    pub page_id: String,
    pub before_data: String,
    pub after_data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrArgs {
    pub image_base64: String,
    pub model_path: String,
    pub psm: u8,
    pub dpi: u16,
    pub tesseract_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StyleBBox {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StyleSample {
    bbox: StyleBBox,
    #[serde(default)]
    line_bbox: Option<StyleBBox>,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
    pub path: String,
    pub content_base64: String,
}

pub struct AppState {
    ocr_child: Arc<Mutex<Option<Child>>>,
    preferences_lock: Arc<Mutex<()>>,
    style_classifier: Arc<Mutex<Option<style_classifier_runtime::Classifier>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            ocr_child: Arc::new(Mutex::new(None)),
            preferences_lock: Arc::new(Mutex::new(())),
            style_classifier: Arc::new(Mutex::new(None)),
        }
    }
}

fn project_root(value: &str) -> BackendResult<PathBuf> {
    if value.trim().is_empty() {
        return Err(BackendError::msg("project path is required"));
    }
    Ok(PathBuf::from(value))
}

fn db_path(root: &Path) -> PathBuf {
    root.to_path_buf()
}

fn open_connection(root: &Path) -> BackendResult<Connection> {
    let db = db_path(root);
    if !db.is_file() {
        return Err(BackendError::msg(format!(
            "not an Eduba project file: {}",
            db.display()
        )));
    }
    let conn = Connection::open(db)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    validate_schema(&conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &Connection) -> BackendResult<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY NOT NULL,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pdf_chunks (
           chunk_index INTEGER PRIMARY KEY NOT NULL,
           data BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS pages (
           page_id TEXT PRIMARY KEY NOT NULL,
           data TEXT NOT NULL
         );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?1)",
        [SCHEMA_VERSION],
    )?;
    Ok(())
}

fn validate_schema(conn: &Connection) -> BackendResult<()> {
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if version.as_deref() != Some(SCHEMA_VERSION) {
        return Err(BackendError::msg(
            "unsupported or missing Eduba project schema version",
        ));
    }
    for table in ["meta", "pdf_chunks", "pages"] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(BackendError::msg(format!(
                "project is missing table {table}"
            )));
        }
    }
    Ok(())
}

fn canonical_or_absolute(path: &Path) -> BackendResult<PathBuf> {
    if path.exists() {
        Ok(fs::canonicalize(path)?)
    } else {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()?.join(path)
        };
        Ok(absolute)
    }
}

fn read_project_info(root: &Path, conn: &Connection) -> BackendResult<ProjectInfo> {
    let pdf_size: u64 = conn.query_row("SELECT value FROM meta WHERE key='pdf_size'", [], |r| {
        let value: String = r.get(0)?;
        value
            .parse::<u64>()
            .map_err(|_| rusqlite::Error::InvalidQuery)
    })?;
    let manifest = conn
        .query_row("SELECT value FROM meta WHERE key='manifest'", [], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    let path = canonical_or_absolute(root)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Eduba project")
        .to_string();
    Ok(ProjectInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        pdf_size,
        manifest,
    })
}

#[tauri::command]
fn get_environment(app: AppHandle) -> Result<serde_json::Value, String> {
    get_environment_impl(&app).map_err(|e| e.to_string())
}

fn get_environment_impl(app: &AppHandle) -> BackendResult<serde_json::Value> {
    let resource = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("resources"));
    let default_model_name = "eng_assyriology_scan_candidate_20260920_v1.traineddata";
    let model_candidates = [
        std::env::var_os("EDUBA_MODEL_PATH").map(PathBuf::from),
        Some(resource.join("models").join(default_model_name)),
        Some(resource.join("resources/models").join(default_model_name)),
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/models")
                .join(default_model_name),
        ),
        Some(resource.join("models").join("eng.traineddata")),
        #[cfg(debug_assertions)]
        Some(PathBuf::from(
            r"D:\work\assyrian-ocr\trial\runs\eng_assyriology-scan-candidate-v1-20260920\seed\eng_assyriology_scan_candidate_20260920_v1.traineddata",
        )),
    ];
    let model = model_candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .unwrap_or_else(|| resource.join("models").join(default_model_name));
    let tesseract = resolve_tesseract_path(app);
    let model = process_path(model);
    let tesseract = process_path(tesseract);
    Ok(serde_json::json!({
        "modelPath": model.to_string_lossy(),
        "tesseractPath": tesseract.to_string_lossy()
    }))
}

fn resolve_tesseract_path(app: &AppHandle) -> PathBuf {
    let resource = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("resources"));
    let mut candidates = vec![
        std::env::var_os("EDUBA_TESSERACT_PATH").map(PathBuf::from),
        Some(resource.join("tesseract").join("tesseract.exe")),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/tesseract/tesseract.exe")),
    ];
    #[cfg(debug_assertions)]
    candidates.push(Some(PathBuf::from(
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    )));
    candidates
        .into_iter()
        .flatten()
        .find(|p| p.is_file())
        .unwrap_or_else(|| resource.join("tesseract").join("tesseract.exe"))
}

#[tauri::command]
async fn create_project(
    pdf_path: String,
    project_path: String,
    manifest: Option<String>,
    overwrite_existing: bool,
) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_project_impl(&CreateProjectArgs {
            pdf_path,
            project_path,
            manifest,
            overwrite_existing,
        })
    })
    .await
    .map_err(|e| format!("project import worker failed: {e}"))?
    .map_err(|e| e.to_string())
}

fn create_project_impl(args: &CreateProjectArgs) -> BackendResult<ProjectInfo> {
    let manifest = args
        .manifest
        .as_deref()
        .map(validate_manifest)
        .transpose()?;
    let pdf = PathBuf::from(&args.pdf_path);
    if !pdf.is_file() {
        return Err(BackendError::msg(format!(
            "PDF file not found: {}",
            pdf.display()
        )));
    }
    let project = project_root(&args.project_path)?;
    if project.exists() && !args.overwrite_existing {
        return Err(BackendError::msg(format!(
            "refusing to overwrite existing project path: {}",
            project.display()
        )));
    }
    if let Some(parent) = project.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Some(parent) = project.parent() {
        if !parent.is_dir() {
            return Err(BackendError::msg(format!(
                "project parent directory not found: {}",
                parent.display()
            )));
        }
    }
    let temporary = tempfile::NamedTempFile::new_in(
        project
            .parent()
            .ok_or_else(|| BackendError::msg("project path has no parent directory"))?,
    )?;
    {
        let mut conn = Connection::open(temporary.path())?;
        initialize_schema(&conn)?;
        let tx = conn.transaction()?;
        let mut source = fs::File::open(pdf)?;
        let mut pdf_size = 0usize;
        let mut index = 0i64;
        loop {
            let mut chunk = Vec::with_capacity(CHUNK_SIZE);
            let read = Read::by_ref(&mut source)
                .take(CHUNK_SIZE as u64)
                .read_to_end(&mut chunk)?;
            if read == 0 {
                break;
            }
            tx.execute(
                "INSERT INTO pdf_chunks(chunk_index, data) VALUES (?1, ?2)",
                params![index, chunk],
            )?;
            index += 1;
            pdf_size += read;
        }
        tx.execute(
            "INSERT INTO meta(key, value) VALUES ('pdf_size', ?1)",
            [pdf_size.to_string()],
        )?;
        if let Some(manifest) = manifest {
            tx.execute(
                "INSERT INTO meta(key, value) VALUES ('manifest', ?1)",
                [manifest],
            )?;
        }
        tx.commit()?;
    }
    if args.overwrite_existing {
        temporary
            .persist(&project)
            .map_err(|error| BackendError::msg(format!("could not replace project: {error}")))?;
    } else {
        temporary.persist_noclobber(&project).map_err(|error| {
            BackendError::msg(format!(
                "could not create project without overwrite: {error}"
            ))
        })?;
    }
    let conn = open_connection(&project)?;
    read_project_info(&project, &conn)
}

fn validate_manifest(manifest: &str) -> BackendResult<&str> {
    let value: serde_json::Value = serde_json::from_str(manifest)?;
    if !value.is_object() {
        return Err(BackendError::msg("manifest must be a JSON object"));
    }
    Ok(manifest)
}

fn source_pdf_size(path: &str) -> BackendResult<u64> {
    let pdf = PathBuf::from(path);
    let metadata = fs::metadata(&pdf)?;
    if !metadata.is_file() {
        return Err(BackendError::msg(format!(
            "PDF path is not a regular file: {}",
            pdf.display()
        )));
    }
    let mut file = fs::File::open(&pdf)?;
    let mut prefix = [0u8; 1024];
    let read = file.read(&mut prefix)?;
    if !prefix[..read].windows(5).any(|window| window == b"%PDF-") {
        return Err(BackendError::msg(format!(
            "file is not a PDF (missing %PDF- header): {}",
            pdf.display()
        )));
    }
    Ok(metadata.len())
}

#[tauri::command]
fn inspect_pdf(pdf_path: String) -> Result<serde_json::Value, String> {
    source_pdf_size(&pdf_path)
        .map(|pdf_size| serde_json::json!({ "pdfSize": pdf_size }))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_source_pdf_range(pdf_path: String, begin: u64, end: u64) -> Result<String, String> {
    read_source_pdf_range_impl(&ReadSourcePdfArgs {
        pdf_path,
        begin,
        end,
    })
    .map_err(|e| e.to_string())
}

fn read_source_pdf_range_impl(args: &ReadSourcePdfArgs) -> BackendResult<String> {
    if args.end < args.begin {
        return Err(BackendError::msg(
            "PDF range end must be greater than or equal to begin",
        ));
    }
    let length = args.end - args.begin;
    if length > MAX_RANGE {
        return Err(BackendError::msg(
            "PDF range is too large (maximum is 16 MiB)",
        ));
    }
    let pdf_size = source_pdf_size(&args.pdf_path)?;
    if args.begin > pdf_size || args.end > pdf_size {
        return Err(BackendError::msg("PDF range is outside the source PDF"));
    }
    if length == 0 {
        return Ok(String::new());
    }
    let mut source = fs::File::open(&args.pdf_path)?;
    source.seek(SeekFrom::Start(args.begin))?;
    let mut bytes = vec![0; length as usize];
    source.read_exact(&mut bytes)?;
    Ok(BASE64.encode(bytes))
}
#[tauri::command]
fn open_project(project_path: String) -> Result<ProjectInfo, String> {
    open_project_impl(&project_path).map_err(|e| e.to_string())
}

fn open_project_impl(value: &str) -> BackendResult<ProjectInfo> {
    let root = project_root(value)?;
    if !root.is_file() {
        return Err(BackendError::msg(format!(
            "project file not found: {}",
            root.display()
        )));
    }
    let conn = open_connection(&root)?;
    read_project_info(&root, &conn)
}

#[tauri::command]
fn read_pdf_range(project_path: String, begin: u64, end: u64) -> Result<String, String> {
    read_pdf_range_impl(&ReadPdfArgs {
        project_path,
        begin,
        end,
    })
    .map_err(|e| e.to_string())
}

fn read_pdf_range_impl(args: &ReadPdfArgs) -> BackendResult<String> {
    if args.end < args.begin {
        return Err(BackendError::msg(
            "PDF range end must be greater than or equal to begin",
        ));
    }
    let length = args.end - args.begin;
    if length > MAX_RANGE {
        return Err(BackendError::msg(
            "PDF range is too large (maximum is 16 MiB)",
        ));
    }
    let root = project_root(&args.project_path)?;
    let conn = open_connection(&root)?;
    let pdf_size: u64 = conn.query_row("SELECT value FROM meta WHERE key='pdf_size'", [], |r| {
        let value: String = r.get(0)?;
        value
            .parse::<u64>()
            .map_err(|_| rusqlite::Error::InvalidQuery)
    })?;
    if args.begin > pdf_size || args.end > pdf_size {
        return Err(BackendError::msg("PDF range is outside the stored PDF"));
    }
    if length == 0 {
        return Ok(String::new());
    }
    let first = args.begin / CHUNK_SIZE as u64;
    let last = (args.end - 1) / CHUNK_SIZE as u64;
    let mut output = Vec::with_capacity(length as usize);
    let mut stmt = conn.prepare(
        "SELECT chunk_index, data FROM pdf_chunks WHERE chunk_index BETWEEN ?1 AND ?2 ORDER BY chunk_index",
    )?;
    let rows = stmt.query_map(params![first as i64, last as i64], |row| {
        Ok((row.get::<_, i64>(0)? as u64, row.get::<_, Vec<u8>>(1)?))
    })?;
    for row in rows {
        let (index, bytes) = row?;
        let chunk_start = index * CHUNK_SIZE as u64;
        let from = args.begin.saturating_sub(chunk_start) as usize;
        let to = ((args.end.saturating_sub(chunk_start)) as usize).min(bytes.len());
        if from < to {
            output.extend_from_slice(&bytes[from..to]);
        }
    }
    if output.len() != length as usize {
        return Err(BackendError::msg("stored PDF chunks are incomplete"));
    }
    Ok(BASE64.encode(output))
}

#[tauri::command]
fn save_manifest(project_path: String, manifest: String) -> Result<(), String> {
    save_manifest_impl(&ManifestArgs {
        project_path,
        manifest,
    })
    .map_err(|e| e.to_string())
}

fn save_manifest_impl(args: &ManifestArgs) -> BackendResult<()> {
    let value: serde_json::Value = serde_json::from_str(&args.manifest)?;
    if !value.is_object() {
        return Err(BackendError::msg("manifest must be a JSON object"));
    }
    let root = project_root(&args.project_path)?;
    let conn = open_connection(&root)?;
    conn.execute(
        "INSERT INTO meta(key,value) VALUES ('manifest',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [&args.manifest],
    )?;
    Ok(())
}

#[tauri::command]
fn load_page(project_path: String, page_id: String) -> Result<Option<String>, String> {
    load_page_impl(&PageArgs {
        project_path,
        page_id,
    })
    .map_err(|e| e.to_string())
}

fn load_page_impl(args: &PageArgs) -> BackendResult<Option<String>> {
    if args.page_id.trim().is_empty() {
        return Err(BackendError::msg("page id is required"));
    }
    let root = project_root(&args.project_path)?;
    let conn = open_connection(&root)?;
    conn.query_row(
        "SELECT data FROM pages WHERE page_id=?1",
        [&args.page_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(BackendError::from)
}

#[tauri::command]
fn save_page(project_path: String, page_id: String, data: String) -> Result<(), String> {
    save_page_impl(&SavePageArgs {
        project_path,
        page_id,
        data,
    })
    .map_err(|e| e.to_string())
}

fn save_page_impl(args: &SavePageArgs) -> BackendResult<()> {
    if args.page_id.trim().is_empty() {
        return Err(BackendError::msg("page id is required"));
    }
    let _: serde_json::Value = serde_json::from_str(&args.data)?;
    let root = project_root(&args.project_path)?;
    let mut conn = open_connection(&root)?;
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO pages(page_id,data) VALUES (?1,?2) ON CONFLICT(page_id) DO UPDATE SET data=excluded.data",
        params![args.page_id, args.data],
    )?;
    tx.commit()?;
    Ok(())
}

fn manifest_page_order(conn: &Connection) -> BackendResult<Vec<(String, String)>> {
    let manifest: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key='manifest'", [], |row| row.get(0))
        .optional()?;
    let mut ordered = Vec::new();
    if let Some(raw) = manifest {
        if let Some(pages) = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| value.get("pages").and_then(serde_json::Value::as_array).cloned())
        {
            for (index, page) in pages.iter().enumerate() {
                let Some(id) = page.get("id").and_then(serde_json::Value::as_str) else { continue };
                let label = page
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| (index + 1).to_string());
                ordered.push((id.to_owned(), label));
            }
        }
    }
    let mut known: HashSet<String> = ordered.iter().map(|(id, _)| id.clone()).collect();
    let mut stmt = conn.prepare("SELECT page_id FROM pages ORDER BY page_id")?;
    let stored = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for page_id in stored {
        let page_id = page_id?;
        if known.insert(page_id.clone()) {
            ordered.push((page_id.clone(), page_id));
        }
    }
    Ok(ordered)
}

fn completed_page_ids(conn: &Connection) -> BackendResult<HashSet<String>> {
    let manifest: Option<String> = conn.query_row("SELECT value FROM meta WHERE key='manifest'", [], |row| row.get(0)).optional()?;
    let Some(raw) = manifest else { return Ok(HashSet::new()); };
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    Ok(value.get("pages").and_then(serde_json::Value::as_array).into_iter().flatten()
        .filter(|page| page.get("completed").and_then(serde_json::Value::as_bool) == Some(true))
        .filter_map(|page| page.get("id").and_then(serde_json::Value::as_str).map(str::to_owned))
        .collect())
}
fn rect_components(value: &serde_json::Value) -> Option<(f64, f64, f64, f64)> {
    Some((value.get("left")?.as_f64()?, value.get("top")?.as_f64()?, value.get("right")?.as_f64()?, value.get("bottom")?.as_f64()?))
}

// match_indices yields UTF-8 byte offsets; hOCR character arrays are Unicode scalar indexed.
fn correction_match_bbox(line: &serde_json::Value, text: &str, byte_start: usize, byte_end: usize) -> Option<serde_json::Value> {
    let start = text.get(..byte_start)?.chars().count();
    let end = text.get(..byte_end)?.chars().count();
    if end <= start { return None; }
    let count = text.chars().count();
    let line_bounds = rect_components(line.get("bbox")?)?;
    let mut bounds: Option<(f64, f64, f64, f64)> = None;
    if let Some(chars) = line.get("chars").and_then(serde_json::Value::as_array).filter(|chars| chars.len() == count) {
        for character in chars.iter().skip(start).take(end - start) {
            let Some(rect) = character.get("bbox").and_then(rect_components) else { continue; };
            bounds = Some(match bounds { Some((left, top, right, bottom)) => (left.min(rect.0), top.min(rect.1), right.max(rect.2), bottom.max(rect.3)), None => rect });
        }
    }
    if let Some((left, top, right, bottom)) = bounds {
        // Preserve real character geometry, but reject the malformed hOCR
        // boxes emitted for some rotated images (for example x=0, x=0 for
        // every glyph). Those boxes cannot describe a crop.
        if right > left
            && bottom > top
            && right > line_bounds.0
            && left < line_bounds.2
            && bottom > line_bounds.1
            && top < line_bounds.3
        {
            return Some(serde_json::json!({ "left": left, "top": top, "right": right, "bottom": bottom }));
        }
    }
    // Edited or ligatured lines may have no reliable character boxes. Use only
    // the matched fraction of the line, never the complete line image.
    let (left, top, right, bottom) = line_bounds;
    if count == 0 { return None; }
    let width = right - left;
    let height = bottom - top;
    if width >= height {
        Some(serde_json::json!({ "left": left + width * start as f64 / count as f64, "top": top, "right": left + width * end as f64 / count as f64, "bottom": bottom }))
    } else {
        Some(serde_json::json!({ "left": left, "top": top + height * start as f64 / count as f64, "right": right, "bottom": top + height * end as f64 / count as f64 }))
    }
}
fn search_corrections_impl(args: &SearchCorrectionsArgs) -> BackendResult<CorrectionSearchPage> {
    if args.search.is_empty() {
        return Err(BackendError::msg("search text is required"));
    }
    if args.page_size == 0 || args.page_size > 200 {
        return Err(BackendError::msg("page size must be between 1 and 200"));
    }
    let root = project_root(&args.project_path)?;
    let conn = open_connection(&root)?;
    let completed = completed_page_ids(&conn)?;
    let start = args.page.checked_mul(args.page_size).unwrap_or(usize::MAX);
    let mut total = 0usize;
    let mut results = Vec::with_capacity(args.page_size);

    for (page_id, page_label) in manifest_page_order(&conn)? {
        if completed.contains(&page_id) { continue; }
        let Some(data) = conn
            .query_row("SELECT data FROM pages WHERE page_id=?1", [&page_id], |row| row.get::<_, String>(0))
            .optional()?
        else { continue };
        let page: serde_json::Value = serde_json::from_str(&data)?;
        let Some(blocks) = page.get("blocks").and_then(serde_json::Value::as_array) else { continue };
        for block in blocks {
            let Some(paragraphs) = block.get("paragraphs").and_then(serde_json::Value::as_array) else { continue };
            for paragraph in paragraphs {
                let Some(lines) = paragraph.get("lines").and_then(serde_json::Value::as_array) else { continue };
                for line in lines {
                    let (Some(line_id), Some(line_text)) = (
                        line.get("id").and_then(serde_json::Value::as_str),
                        line.get("correctedText").and_then(serde_json::Value::as_str),
                    ) else { continue };
                    for (match_ordinal, (byte_start, matched)) in line_text.match_indices(&args.search).enumerate() {
                        if total >= start && results.len() < args.page_size {
                            results.push(CorrectionMatch {
                                page_id: page_id.clone(),
                                page_label: page_label.clone(),
                                line_id: line_id.to_owned(),
                                line_text: line_text.to_owned(),
                                formatting: line.get("formatting").cloned(),
                                auto_formatting: line.get("autoFormatting").cloned(),
                                bbox: line.get("bbox").cloned(),
                                match_bbox: correction_match_bbox(line, line_text, byte_start, byte_start + matched.len()),
                                match_ordinal,
                            });
                        }
                        total = total.saturating_add(1);
                    }
                }
            }
        }
    }

    Ok(CorrectionSearchPage {
        results,
        total,
        page: args.page,
        page_size: args.page_size,
    })
}

#[tauri::command]
fn search_corrections(
    project_path: String,
    search: String,
    page: usize,
    page_size: usize,
) -> Result<CorrectionSearchPage, String> {
    search_corrections_impl(&SearchCorrectionsArgs {
        project_path,
        search,
        page,
        page_size,
    })
    .map_err(|error| error.to_string())
}

fn apply_bulk_corrections_impl(args: &ApplyBulkCorrectionsArgs) -> BackendResult<Vec<BulkPageChange>> {
    if args.updates.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = HashSet::new();
    for update in &args.updates {
        if update.page_id.trim().is_empty() || !seen.insert(&update.page_id) {
            return Err(BackendError::msg("bulk updates require unique non-empty page ids"));
        }
        let _: serde_json::Value = serde_json::from_str(&update.data)?;
    }

    let root = project_root(&args.project_path)?;
    let mut conn = open_connection(&root)?;
    let tx = conn.transaction()?;
    let completed = completed_page_ids(&tx)?;
    let mut changes = Vec::with_capacity(args.updates.len());
    for update in &args.updates {
        if completed.contains(&update.page_id) {
            return Err(BackendError::msg(format!("page is marked proofread: {}", update.page_id)));
        }
        let current: Option<String> = tx
            .query_row(
                "SELECT data FROM pages WHERE page_id=?1",
                [&update.page_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(before_data) = current else {
            return Err(BackendError::msg(format!("page not found: {}", update.page_id)));
        };
        if before_data != update.expected_data {
            return Err(BackendError::msg(format!(
                "page changed while preparing bulk replacement: {}",
                update.page_id
            )));
        }
        changes.push(BulkPageChange {
            page_id: update.page_id.clone(),
            before_data,
            after_data: update.data.clone(),
        });
    }
    for change in &changes {
        tx.execute(
            "UPDATE pages SET data=?1 WHERE page_id=?2",
            params![change.after_data, change.page_id],
        )?;
    }
    tx.commit()?;
    Ok(changes)
}

#[tauri::command]
fn apply_bulk_corrections(
    project_path: String,
    updates: Vec<BulkPageUpdate>,
) -> Result<Vec<BulkPageChange>, String> {
    apply_bulk_corrections_impl(&ApplyBulkCorrectionsArgs {
        project_path,
        updates,
    })
    .map_err(|error| error.to_string())
}

fn model_spec(model_path: &str) -> BackendResult<(PathBuf, String)> {
    let requested = process_path(PathBuf::from(model_path));
    if requested.as_os_str().is_empty() {
        return Err(BackendError::msg("model path is required"));
    }
    let (dir, file) = if requested.is_file() {
        (
            requested
                .parent()
                .ok_or_else(|| BackendError::msg("model path has no parent directory"))?
                .to_path_buf(),
            requested
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| BackendError::msg("model filename is invalid"))?
                .to_string(),
        )
    } else if requested.is_dir() {
        let candidate = requested.join("eng_assyriology_scan_candidate_20260920_v1.traineddata");
        let model = if candidate.is_file() {
            candidate
        } else {
            return Err(BackendError::msg(format!(
                "traineddata file not found in {}",
                requested.display()
            )));
        };
        (
            requested,
            model.file_stem().unwrap().to_string_lossy().into_owned(),
        )
    } else {
        return Err(BackendError::msg(format!(
            "model file not found: {model_path}"
        )));
    };
    Ok((dir, file))
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

#[tauri::command]
async fn classify_word_styles(
    app: AppHandle,
    state: State<'_, AppState>,
    image_base64: String,
    samples: Vec<StyleSample>,
) -> Result<Vec<style_classifier_runtime::Prediction>, String> {
    let classifier = state.style_classifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        classify_word_styles_blocking(&app, classifier, image_base64, samples)
    })
    .await
    .map_err(|e| format!("style classification worker failed: {e}"))?
    .map_err(|e| e.to_string())
}

fn style_model_path(app: &AppHandle) -> PathBuf {
    let resource = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("resources"));
    let name = "style_word_cnn.onnx";
    [
        Some(resource.join("models").join(name)),
        Some(resource.join("resources/models").join(name)),
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources/models")
                .join(name),
        ),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file())
    .unwrap_or_else(|| resource.join("models").join(name))
}

fn pixel_bbox(bbox: &StyleBBox, width: u32, height: u32) -> BackendResult<(u32, u32, u32, u32)> {
    let values = [bbox.left, bbox.top, bbox.right, bbox.bottom];
    if values.iter().any(|v| !v.is_finite())
        || bbox.left < 0.0
        || bbox.top < 0.0
        || bbox.right <= bbox.left
        || bbox.bottom <= bbox.top
    {
        return Err(BackendError::msg(
            "style sample bbox must be finite, non-empty, and non-negative",
        ));
    }
    let left = bbox.left.floor() as u32;
    let top = bbox.top.floor() as u32;
    let right = bbox.right.ceil() as u32;
    let bottom = bbox.bottom.ceil() as u32;
    if right > width || bottom > height || left >= right || top >= bottom {
        return Err(BackendError::msg("style sample bbox is outside the image"));
    }
    Ok((left, top, right, bottom))
}

fn classify_word_styles_blocking(
    app: &AppHandle,
    classifier: Arc<Mutex<Option<style_classifier_runtime::Classifier>>>,
    image_base64: String,
    samples: Vec<StyleSample>,
) -> BackendResult<Vec<style_classifier_runtime::Prediction>> {
    use style_classifier_runtime::{crop_words_with_padding, GrayImage, Thresholds, WordBBox};

    if samples.len() > 1000 {
        return Err(BackendError::msg(
            "style classification accepts at most 1000 samples per batch",
        ));
    }
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = image_base64
        .trim()
        .split_once(',')
        .map(|(_, data)| data)
        .unwrap_or(image_base64.trim());
    let bytes = BASE64.decode(encoded)?;
    if bytes.is_empty() || bytes.len() > MAX_OCR_IMAGE {
        return Err(BackendError::msg("style image is empty or exceeds 64 MiB"));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| BackendError::msg(format!("could not identify style image: {e}")))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20000);
    limits.max_image_height = Some(20000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let page = reader
        .decode()
        .map_err(|e| BackendError::msg(format!("could not decode style image: {e}")))?
        .to_luma8();
    if page.width() == 0 || page.height() == 0 || page.width() > 20000 || page.height() > 20000 {
        return Err(BackendError::msg(
            "style image dimensions are invalid or exceed 20000 pixels",
        ));
    }
    let mut words: Vec<GrayImage> = Vec::with_capacity(samples.len());
    let mut texts = Vec::with_capacity(samples.len());
    for sample in samples {
        let (left, top, right, bottom) = pixel_bbox(&sample.bbox, page.width(), page.height())?;
        if let Some(line_bbox) = sample.line_bbox {
            let (line_left, line_top, line_right, line_bottom) =
                pixel_bbox(&line_bbox, page.width(), page.height())?;
            if left < line_left || top < line_top || right > line_right || bottom > line_bottom {
                return Err(BackendError::msg("word bbox must be contained by lineBbox"));
            }
            let line = image::imageops::crop_imm(
                &page,
                line_left,
                line_top,
                line_right - line_left,
                line_bottom - line_top,
            )
            .to_image();
            let crops = crop_words_with_padding(
                &line,
                &[WordBBox {
                    x: left - line_left,
                    y: top - line_top,
                    width: right - left,
                    height: bottom - top,
                }],
            )
            .map_err(|e| BackendError::msg(format!("could not crop style word: {e}")))?;
            words.push(crops.into_iter().next().expect("one crop requested"));
        } else {
            let crops = crop_words_with_padding(
                &page,
                &[WordBBox {
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                }],
            )
            .map_err(|e| BackendError::msg(format!("could not crop style word: {e}")))?;
            words.push(crops.into_iter().next().expect("one crop requested"));
        }
        texts.push(sample.text);
    }
    let mut model = classifier
        .lock()
        .map_err(|_| BackendError::msg("style classifier lock was poisoned"))?;
    if model.is_none() {
        let path = style_model_path(app);
        if !path.is_file() {
            return Err(BackendError::msg(format!(
                "style ONNX model not found: {}",
                path.display()
            )));
        }
        *model = Some(
            style_classifier_runtime::Classifier::load(
                &path,
                Thresholds {
                    italic: style_classifier_runtime::DEFAULT_ITALIC_THRESHOLD,
                    bold: style_classifier_runtime::BOLD_THRESHOLD,
                },
                4,
            )
            .map_err(|e| BackendError::msg(format!("could not load style model: {e}")))?,
        );
    }
    model
        .as_mut()
        .expect("initialized above")
        .predict_with_texts(&words, &texts)
        .map_err(|e| BackendError::msg(format!("style inference failed: {e}")))
}

#[tauri::command]
async fn run_ocr(
    app: AppHandle,
    state: State<'_, AppState>,
    image_base64: String,
    model_path: String,
    psm: u8,
    dpi: Option<u16>,
) -> Result<String, String> {
    let child_slot = state.ocr_child.clone();
    let tesseract_path = resolve_tesseract_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        run_ocr_blocking(
            child_slot,
            OcrArgs {
                image_base64,
                model_path,
                psm,
                dpi: dpi.unwrap_or(300),
                tesseract_path,
            },
        )
    })
    .await
    .map_err(|e| format!("OCR worker failed: {e}"))?
    .map_err(|e| e.to_string())
}

// PDF image resolution may exceed the manual 72–600 DPI UI range; this scalar only hints Tesseract and never resamples the image.
fn validate_ocr_dpi(dpi: u16) -> BackendResult<()> {
    if !(70..=2400).contains(&dpi) {
        return Err(BackendError::msg("OCR DPI must be between 70 and 2400"));
    }
    Ok(())
}

fn run_ocr_blocking(child_slot: Arc<Mutex<Option<Child>>>, args: OcrArgs) -> BackendResult<String> {
    if args.psm > 13 {
        return Err(BackendError::msg(
            "page segmentation mode must be between 0 and 13",
        ));
    }
    validate_ocr_dpi(args.dpi)?;
    let image = BASE64.decode(args.image_base64.trim())?;
    if image.is_empty() || image.len() > MAX_OCR_IMAGE {
        return Err(BackendError::msg("OCR image is empty or exceeds 64 MiB"));
    }
    let (model_dir, model_stem) = model_spec(&args.model_path)?;
    let tesseract = process_path(args.tesseract_path);
    if !tesseract.is_file() {
        return Err(BackendError::msg(format!(
            "tesseract executable not found: {}",
            tesseract.display()
        )));
    }
    let mut input = tempfile::NamedTempFile::new()?;
    input.write_all(&image)?;
    input.flush()?;
    let stdout_file = tempfile::NamedTempFile::new()?;
    let stderr_file = tempfile::NamedTempFile::new()?;
    let stdout_path = stdout_file.path().to_path_buf();
    let stderr_path = stderr_file.path().to_path_buf();
    let mut command = Command::new(&tesseract);
    command
        .arg(input.path())
        .arg("stdout")
        .arg("--oem")
        .arg("1")
        .arg("--psm")
        .arg(args.psm.to_string())
        .arg("--dpi")
        .arg(args.dpi.to_string())
        .arg("-l")
        .arg(&model_stem)
        .arg("--tessdata-dir")
        .arg(&model_dir)
        .arg("-c")
        .arg("tessedit_create_hocr=1")
        .arg("-c")
        .arg("hocr_char_boxes=1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file.reopen()?))
        .stderr(Stdio::from(stderr_file.reopen()?));
    hide_console(&mut command);
    {
        let mut slot = child_slot
            .lock()
            .map_err(|_| BackendError::msg("OCR cancellation state is unavailable"))?;
        if slot.is_some() {
            return Err(BackendError::msg("an OCR operation is already running"));
        }
        let child = command.spawn()?;
        *slot = Some(child);
    }
    let status = loop {
        let status = {
            let mut slot = child_slot
                .lock()
                .map_err(|_| BackendError::msg("OCR cancellation state is unavailable"))?;
            let child = slot
                .as_mut()
                .ok_or_else(|| BackendError::msg("OCR process disappeared"))?;
            child.try_wait()?
        };
        if let Some(status) = status {
            break status;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    };
    let child = child_slot
        .lock()
        .map_err(|_| BackendError::msg("OCR cancellation state is unavailable"))?
        .take()
        .ok_or_else(|| BackendError::msg("OCR process disappeared"))?;
    drop(child);
    let stdout = fs::read(stdout_path)?;
    let stderr = fs::read(stderr_path)?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(BackendError::msg(if detail.is_empty() {
            format!("tesseract exited with {status}")
        } else {
            format!("tesseract failed: {detail}")
        }));
    }
    String::from_utf8(stdout).map_err(|_| BackendError::msg("tesseract returned non-UTF-8 hOCR"))
}

#[tauri::command]
fn cancel_ocr(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state
        .ocr_child
        .lock()
        .map_err(|_| "OCR cancellation state is unavailable".to_string())?;
    if let Some(child) = slot.as_mut() {
        child
            .kill()
            .map_err(|e| format!("could not cancel OCR: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn export_file(path: String, content_base64: String) -> Result<(), String> {
    export_file_impl(&ExportArgs {
        path,
        content_base64,
    })
    .map_err(|e| e.to_string())
}

fn export_file_impl(args: &ExportArgs) -> BackendResult<()> {
    let path = PathBuf::from(&args.path);
    if path.as_os_str().is_empty() {
        return Err(BackendError::msg("export path is required"));
    }
    let bytes = BASE64.decode(args.content_base64.trim())?;
    if let Some(parent) = path.parent() {
        if !parent.is_dir() {
            return Err(BackendError::msg(format!(
                "export directory not found: {}",
                parent.display()
            )));
        }
    }
    fs::write(path, bytes)?;
    Ok(())
}

fn current_os_locale() -> Option<String> {
    sys_locale::get_locale()
}

fn preferences_for_app(app: &AppHandle) -> Result<UserPreferences, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not locate app config directory: {e}"))?;
    Ok(preferences::read_preferences(
        &config_dir,
        current_os_locale(),
    ))
}

#[tauri::command]
fn get_user_preferences(app: AppHandle) -> Result<UserPreferences, String> {
    preferences_for_app(&app)
}

#[tauri::command]
fn save_user_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    language: LocalePreference,
) -> Result<(), String> {
    let _lock = state
        .preferences_lock
        .lock()
        .map_err(|_| "preferences lock is unavailable".to_string())?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not locate app config directory: {e}"))?;
    let mut preferences = preferences::read_preferences(&config_dir, current_os_locale());
    preferences.language = language;
    preferences::write_preferences(&config_dir, &preferences)
}

#[tauri::command]
fn save_magnifier_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    image_magnifier_enabled: bool,
    text_magnifier_enabled: bool,
) -> Result<(), String> {
    let _lock = state
        .preferences_lock
        .lock()
        .map_err(|_| "preferences lock is unavailable".to_string())?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not locate app config directory: {e}"))?;
    let mut preferences = preferences::read_preferences(&config_dir, current_os_locale());
    preferences.image_magnifier_enabled = image_magnifier_enabled;
    preferences.text_magnifier_enabled = text_magnifier_enabled;
    preferences::write_preferences(&config_dir, &preferences)
}

#[tauri::command]
fn save_last_opened_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_path: String,
    page_id: String,
) -> Result<(), String> {
    if project_path.trim().is_empty() || page_id.trim().is_empty() {
        return Err("project path and page ID are required".into());
    }
    let _lock = state
        .preferences_lock
        .lock()
        .map_err(|_| "preferences lock is unavailable".to_string())?;
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not locate app config directory: {e}"))?;
    let mut preferences = preferences::read_preferences(&config_dir, current_os_locale());
    preferences.last_project = Some(LastOpenedProject {
        path: project_path,
        page_id,
    });
    preferences::write_preferences(&config_dir, &preferences)
}

fn supported_locale(value: &str) -> Result<SupportedLocale, String> {
    match value {
        "en" => Ok(SupportedLocale::En),
        "ja" => Ok(SupportedLocale::Ja),
        "zh-Hans" => Ok(SupportedLocale::ZhHans),
        "zh-Hant" => Ok(SupportedLocale::ZhHant),
        other => Err(format!("unsupported resolved language: {other}")),
    }
}

fn menu_text(locale: &SupportedLocale) -> [&'static str; 4] {
    match locale {
        SupportedLocale::Ja => [
            "PDFをインポート…",
            "プロジェクトを開く…",
            "書き出す…",
            "設定",
        ],
        SupportedLocale::ZhHans => ["导入 PDF…", "打开项目…", "导出…", "设置"],
        SupportedLocale::ZhHant => ["匯入 PDF…", "開啟專案…", "匯出…", "設定"],
        SupportedLocale::En => ["Import PDF…", "Open Project…", "Export…", "Settings"],
    }
}

fn rebuild_menu(app: &AppHandle, locale: &SupportedLocale) -> Result<(), String> {
    let labels = menu_text(locale);
    let menu = MenuBuilder::new(app)
        .text("import", labels[0])
        .text("open", labels[1])
        .text("export", labels[2])
        .text("settings", labels[3])
        .build()
        .map_err(|e| format!("could not build localized menu: {e}"))?;
    app.set_menu(menu)
        .map(|_| ())
        .map_err(|e| format!("could not set localized menu: {e}"))
}

#[tauri::command]
fn set_ui_language(app: AppHandle, language: String) -> Result<(), String> {
    let locale = supported_locale(&language)?;
    rebuild_menu(&app, &locale)
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::default();
    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let preferences = preferences_for_app(&app.handle())
                .unwrap_or_else(|_| UserPreferences::default_with_os(current_os_locale()));
            let locale = preferences::resolve_locale(
                &preferences.language,
                preferences.os_locale.as_deref(),
            );
            rebuild_menu(&app.handle(), &locale).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("app-menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            get_environment,
            get_user_preferences,
            save_user_preferences,
            save_magnifier_preferences,
            save_last_opened_project,
            set_ui_language,
            create_project,
            open_project,
            read_pdf_range,
            inspect_pdf,
            read_source_pdf_range,
            save_manifest,
            load_page,
            save_page,
            load_edit_history,
            save_project_state,
            search_corrections,
            apply_bulk_corrections,
            run_ocr,
            classify_word_styles,
            cancel_ocr,
            export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Eduba");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempdir().unwrap();
        let pdf = dir.path().join("source.pdf");
        let project = dir.path().join("book.eduba");
        let bytes: Vec<u8> = (0..(CHUNK_SIZE + 31)).map(|n| (n % 251) as u8).collect();
        fs::write(&pdf, bytes).unwrap();
        (dir, pdf, project)
    }

    #[test]
    fn sqlite_roundtrip_chunks_and_page_data() {
        let (_dir, pdf, project) = fixture();
        let info = create_project_impl(&CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: project.to_string_lossy().into_owned(),
            manifest: None,
        })
        .unwrap();
        assert_eq!(info.pdf_size, (CHUNK_SIZE + 31) as u64);
        let range = read_pdf_range_impl(&ReadPdfArgs {
            project_path: project.to_string_lossy().into_owned(),
            begin: CHUNK_SIZE as u64 - 5,
            end: CHUNK_SIZE as u64 + 12,
        })
        .unwrap();
        let expected: Vec<u8> = (0..(CHUNK_SIZE + 31)).map(|n| (n % 251) as u8).collect();
        assert_eq!(
            BASE64.decode(range).unwrap(),
            expected[CHUNK_SIZE - 5..CHUNK_SIZE + 12]
        );
        save_manifest_impl(&ManifestArgs {
            project_path: project.to_string_lossy().into_owned(),
            manifest: r#"{"version":1,"pages":[{"id":"page-1"}]}"#.into(),
        })
        .unwrap();
        save_page_impl(&SavePageArgs {
            project_path: project.to_string_lossy().into_owned(),
            page_id: "page-1".into(),
            data: r#"{"blocks":[{"text":"hello"}]}"#.into(),
        })
        .unwrap();
        assert_eq!(
            load_page_impl(&PageArgs {
                project_path: project.to_string_lossy().into_owned(),
                page_id: "page-1".into(),
            })
            .unwrap()
            .as_deref(),
            Some(r#"{"blocks":[{"text":"hello"}]}"#)
        );
        let reopened = open_project_impl(&project.to_string_lossy()).unwrap();
        assert_eq!(
            reopened.manifest.as_deref(),
            Some(r#"{"version":1,"pages":[{"id":"page-1"}]}"#)
        );
        assert!(project.is_file());
        assert!(!project.with_extension("eduba-wal").exists());
        assert!(!project.with_extension("eduba-shm").exists());
    }

    #[test]
    fn create_refuses_overwrite_and_page_update_preserves_pdf() {
        let (_dir, pdf, project) = fixture();
        let args = CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: project.to_string_lossy().into_owned(),
            manifest: None,
        };
        create_project_impl(&args).unwrap();
        assert!(create_project_impl(&args).is_err());
        save_page_impl(&SavePageArgs {
            project_path: project.to_string_lossy().into_owned(),
            page_id: "page-1".into(),
            data: "{\"text\":\"updated\"}".into(),
        })
        .unwrap();
        let conn = open_connection(&project).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM pdf_chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let _: Option<String> = conn
            .query_row("SELECT data FROM pages WHERE page_id='page-1'", [], |r| {
                r.get(0)
            })
            .optional()
            .unwrap();
        let mut file = fs::File::open(pdf).unwrap();
        let mut source = Vec::new();
        file.read_to_end(&mut source).unwrap();
        assert_eq!(source.len(), CHUNK_SIZE + 31);
    }

    #[test]
    fn confirmed_import_replaces_existing_project_and_failed_import_keeps_it() {
        let (_dir, pdf, project) = fixture();
        let path = project.to_string_lossy().into_owned();
        let original = CreateProjectArgs {
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: path.clone(),
            manifest: Some(r#"{"version":1,"name":"original"}"#.into()),
            overwrite_existing: false,
        };
        create_project_impl(&original).unwrap();
        save_page_impl(&SavePageArgs {
            project_path: path.clone(),
            page_id: "old-page".into(),
            data: r#"{"text":"old"}"#.into(),
        })
        .unwrap();

        let replacement = CreateProjectArgs {
            manifest: Some(r#"{"version":1,"name":"replacement"}"#.into()),
            overwrite_existing: true,
            ..original
        };
        let info = create_project_impl(&replacement).unwrap();
        assert_eq!(info.manifest.as_deref(), replacement.manifest.as_deref());
        assert_eq!(
            load_page_impl(&PageArgs {
                project_path: path.clone(),
                page_id: "old-page".into(),
            })
            .unwrap(),
            None
        );
        assert_eq!(fs::read(&pdf).unwrap().len() as u64, info.pdf_size);

        let invalid = CreateProjectArgs {
            manifest: Some("[]".into()),
            ..replacement
        };
        assert!(create_project_impl(&invalid).is_err());
        assert_eq!(open_project_impl(&path).unwrap().manifest, info.manifest);
    }

    #[test]
    fn source_pdf_range_reads_exact_bytes_and_rejects_out_of_bounds() {
        let dir = tempdir().unwrap();
        let pdf = dir.path().join("source.pdf");
        let bytes = b"%PDF-1.7\nsource-bytes";
        fs::write(&pdf, bytes).unwrap();
        assert_eq!(
            source_pdf_size(&pdf.to_string_lossy()).unwrap(),
            bytes.len() as u64
        );
        assert!(source_pdf_size(&dir.path().to_string_lossy()).is_err());
        let non_pdf = dir.path().join("not-a-pdf.bin");
        fs::write(&non_pdf, b"plain text").unwrap();
        assert!(source_pdf_size(&non_pdf.to_string_lossy()).is_err());
        let encoded = read_source_pdf_range_impl(&ReadSourcePdfArgs {
            pdf_path: pdf.to_string_lossy().into_owned(),
            begin: 5,
            end: 14,
        })
        .unwrap();
        assert_eq!(BASE64.decode(encoded).unwrap(), bytes[5..14]);
        assert!(read_source_pdf_range_impl(&ReadSourcePdfArgs {
            pdf_path: pdf.to_string_lossy().into_owned(),
            begin: 0,
            end: bytes.len() as u64 + 1,
        })
        .is_err());
    }

    #[test]
    fn initial_manifest_is_validated_and_persists() {
        let (_dir, pdf, project) = fixture();
        let manifest = r#"{"version":1,"pages":[{"id":"page-1","source":1}]}"#;
        let info = create_project_impl(&CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: project.to_string_lossy().into_owned(),
            manifest: Some(manifest.into()),
        })
        .unwrap();
        assert_eq!(info.manifest.as_deref(), Some(manifest));
        assert_eq!(
            open_project_impl(&project.to_string_lossy())
                .unwrap()
                .manifest
                .as_deref(),
            Some(manifest)
        );

        let invalid_project = project.with_file_name("invalid.eduba");
        assert!(create_project_impl(&CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: invalid_project.to_string_lossy().into_owned(),
            manifest: Some("[]".into()),
        })
        .is_err());
        assert!(!invalid_project.exists());
    }
    #[test]
    fn ocr_dpi_accepts_native_range_and_rejects_outside() {
        assert!(validate_ocr_dpi(70).is_ok());
        assert!(validate_ocr_dpi(2400).is_ok());
        assert!(validate_ocr_dpi(69).is_err());
        assert!(validate_ocr_dpi(2401).is_err());
    }

    #[test]
    fn correction_match_bbox_uses_unicode_character_offsets_and_safe_fallback() {
        let line = serde_json::json!({
            "bbox": {"left": 0, "top": 0, "right": 30, "bottom": 10},
            "chars": [
                {"bbox": {"left": 0, "top": 0, "right": 5, "bottom": 10}},
                {"bbox": {"left": 6, "top": 0, "right": 11, "bottom": 10}},
                {"bbox": {"left": 12, "top": 0, "right": 20, "bottom": 10}}
            ]
        });
        let text = "šxš";
        assert_eq!(correction_match_bbox(&line, text, 0, "š".len()).unwrap()["right"], 5.0);
        assert_eq!(correction_match_bbox(&line, text, "šx".len(), text.len()).unwrap()["left"], 12.0);
        let mismatched = serde_json::json!({"bbox": {"left": 0, "top": 0, "right": 30, "bottom": 10}, "chars": [{}]});
        let fallback = correction_match_bbox(&mismatched, "abc", 1, 2).unwrap();
        assert_eq!(fallback["left"], 10.0);
        assert_eq!(fallback["right"], 20.0);

        let degenerate = serde_json::json!({
            "bbox": {"left": 0, "top": 0, "right": 100, "bottom": 10},
            "chars": [{"bbox": {"left": 0, "top": 1, "right": 0, "bottom": 9}}, {"bbox": {"left": 0, "top": 1, "right": 0, "bottom": 9}}, {"bbox": {"left": 0, "top": 1, "right": 0, "bottom": 9}}, {"bbox": {"left": 0, "top": 1, "right": 0, "bottom": 9}}]
        });
        let bounded = correction_match_bbox(&degenerate, "word", 0, 1).unwrap();
        assert_eq!(bounded["left"], 0.0);
        assert_eq!(bounded["right"], 25.0);
    }
    #[test]
    fn bulk_search_uses_manifest_order_and_corrected_text() {
        let (_dir, pdf, project) = fixture();
        create_project_impl(&CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: project.to_string_lossy().into_owned(),
            manifest: Some(r#"{"version":1,"pages":[{"id":"second","label":"2"},{"id":"first","label":"1"}]}"#.into()),
        }).unwrap();
        let first = r#"{"blocks":[{"paragraphs":[{"lines":[{"id":"line-a","correctedText":"old old","originalText":"ignored","bbox":{"left":1,"top":2,"right":3,"bottom":4},"formatting":[{"start":0,"end":3,"kind":"italic"}],"autoFormatting":[{"start":4,"end":7,"kind":"superscript"}]}]}]}]}"#;
        let second = r#"{"blocks":[{"paragraphs":[{"lines":[{"id":"line-b","correctedText":"old","originalText":"different"}]}]}]}"#;
        save_page_impl(&SavePageArgs { project_path: project.to_string_lossy().into_owned(), page_id: "first".into(), data: first.into() }).unwrap();
        save_page_impl(&SavePageArgs { project_path: project.to_string_lossy().into_owned(), page_id: "second".into(), data: second.into() }).unwrap();

        let found = search_corrections_impl(&SearchCorrectionsArgs {
            project_path: project.to_string_lossy().into_owned(),
            search: "old".into(), page: 0, page_size: 2,
        }).unwrap();
        assert_eq!(found.total, 3);
        assert_eq!(found.results.len(), 2);
        assert_eq!(found.results[0].page_id, "second");
        assert_eq!(found.results[0].match_ordinal, 0);
        assert_eq!(found.results[1].page_id, "first");
        assert!(found.results[1].match_bbox.is_some());
        let serialized = serde_json::to_value(&found.results[1]).unwrap();
        assert!(serialized.get("matchBBox").is_some());
        assert!(serialized.get("matchBbox").is_none());
        assert_eq!(serialized["formatting"][0]["kind"], "italic");
        assert_eq!(serialized["autoFormatting"][0]["kind"], "superscript");
        let last = search_corrections_impl(&SearchCorrectionsArgs {
            project_path: project.to_string_lossy().into_owned(),
            search: "old".into(), page: 1, page_size: 2,
        }).unwrap();
        assert_eq!(last.results[0].match_ordinal, 1);
        assert!(search_corrections_impl(&SearchCorrectionsArgs {
            project_path: project.to_string_lossy().into_owned(),
            search: "".into(), page: 0, page_size: 2,
        }).is_err());
    }

    #[test]
    fn bulk_operations_exclude_and_reject_completed_pages() {
        let (_dir, pdf, project) = fixture();
        let path = project.to_string_lossy().into_owned();
        create_project_impl(&CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: path.clone(),
            manifest: Some(r#"{"version":1,"pages":[{"id":"done","label":"1","completed":true},{"id":"open","label":"2"}]}"#.into()),
        }).unwrap();
        let page = r#"{"blocks":[{"paragraphs":[{"lines":[{"id":"line","correctedText":"old"}]}]}]}"#;
        save_page_impl(&SavePageArgs { project_path: path.clone(), page_id: "done".into(), data: page.into() }).unwrap();
        save_page_impl(&SavePageArgs { project_path: path.clone(), page_id: "open".into(), data: page.into() }).unwrap();
        let found = search_corrections_impl(&SearchCorrectionsArgs { project_path: path.clone(), search: "old".into(), page: 0, page_size: 10 }).unwrap();
        assert_eq!(found.results.len(), 1);
        assert_eq!(found.results[0].page_id, "open");
        assert!(apply_bulk_corrections_impl(&ApplyBulkCorrectionsArgs { project_path: path, updates: vec![BulkPageUpdate { page_id: "done".into(), expected_data: page.into(), data: r#"{"blocks":[]}"#.into() }] }).is_err());
    }
    #[test]
    fn bulk_updates_are_atomic_and_reject_stale_page_data() {
        let (_dir, pdf, project) = fixture();
        create_project_impl(&CreateProjectArgs {
            overwrite_existing: false,
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: project.to_string_lossy().into_owned(),
            manifest: None,
        }).unwrap();
        let first = r#"{"blocks":[],"version":1}"#;
        let second = r#"{"blocks":[],"version":2}"#;
        let path = project.to_string_lossy().into_owned();
        save_page_impl(&SavePageArgs { project_path: path.clone(), page_id: "first".into(), data: first.into() }).unwrap();
        save_page_impl(&SavePageArgs { project_path: path.clone(), page_id: "second".into(), data: second.into() }).unwrap();

        let changes = apply_bulk_corrections_impl(&ApplyBulkCorrectionsArgs {
            project_path: path.clone(),
            updates: vec![
                BulkPageUpdate { page_id: "first".into(), expected_data: first.into(), data: r#"{"blocks":[],"version":11}"#.into() },
                BulkPageUpdate { page_id: "second".into(), expected_data: second.into(), data: r#"{"blocks":[],"version":12}"#.into() },
            ],
        }).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(load_page_impl(&PageArgs { project_path: path.clone(), page_id: "first".into() }).unwrap().as_deref(), Some(r#"{"blocks":[],"version":11}"#));

        assert!(apply_bulk_corrections_impl(&ApplyBulkCorrectionsArgs {
            project_path: path.clone(),
            updates: vec![
                BulkPageUpdate { page_id: "first".into(), expected_data: r#"{"blocks":[],"version":11}"#.into(), data: r#"{"blocks":[],"version":21}"#.into() },
                BulkPageUpdate { page_id: "second".into(), expected_data: "stale".into(), data: r#"{"blocks":[],"version":22}"#.into() },
            ],
        }).is_err());
        assert_eq!(load_page_impl(&PageArgs { project_path: path, page_id: "first".into() }).unwrap().as_deref(), Some(r#"{"blocks":[],"version":11}"#));
    }
    #[test]
    #[ignore = "requires a local Tesseract runtime, model, and fixture image"]
    fn ocr_integration_fixture_returns_hocr() {
        let image_path = std::env::var_os("EDUBA_OCR_FIXTURE_IMAGE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"D:\work\eduba\tmp\pdfs\sample-left-300.png"));
        let model_path = std::env::var_os("EDUBA_MODEL_PATH").map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(r"D:\work\assyrian-ocr\trial\runs\eng_assyriology-scan-candidate-v1-20260920\seed\eng_assyriology_scan_candidate_20260920_v1.traineddata")
        });
        let tesseract_path = std::env::var_os("EDUBA_TESSERACT_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(r"D:\work\eduba\src-tauri\resources\tesseract\tesseract.exe")
            });
        assert!(
            image_path.is_file(),
            "OCR fixture image is missing: {}",
            image_path.display()
        );
        assert!(
            model_path.is_file(),
            "OCR model is missing: {}",
            model_path.display()
        );
        assert!(
            tesseract_path.is_file(),
            "Tesseract executable is missing: {}",
            tesseract_path.display()
        );
        let image = BASE64.encode(fs::read(image_path).unwrap());
        let result = run_ocr_blocking(
            Arc::new(Mutex::new(None)),
            OcrArgs {
                image_base64: image,
                model_path: fs::canonicalize(&model_path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                psm: 3,
                dpi: 300,
                tesseract_path,
            },
        )
        .unwrap();
        assert!(result.contains("ocr_page"));
        assert!(result.contains("ocrx_word"));
        assert!(result.contains("ocrx_cinfo"));
    }
}
