#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{menu::MenuBuilder, AppHandle, Emitter, Manager, State};
use thiserror::Error;

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
pub struct OcrArgs {
    pub image_base64: String,
    pub model_path: String,
    pub psm: u8,
    pub dpi: u16,
    pub tesseract_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
    pub path: String,
    pub content_base64: String,
}

pub struct AppState {
    ocr_child: Arc<Mutex<Option<Child>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            ocr_child: Arc::new(Mutex::new(None)),
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
) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        create_project_impl(&CreateProjectArgs {
            pdf_path,
            project_path,
            manifest,
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
    if project.exists() {
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
    temporary.persist_noclobber(&project).map_err(|error| {
        BackendError::msg(format!(
            "could not create project without overwrite: {error}"
        ))
    })?;
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

fn run_ocr_blocking(child_slot: Arc<Mutex<Option<Child>>>, args: OcrArgs) -> BackendResult<String> {
    if args.psm > 13 {
        return Err(BackendError::msg(
            "page segmentation mode must be between 0 and 13",
        ));
    }
    if !(72..=600).contains(&args.dpi) {
        return Err(BackendError::msg("OCR DPI must be between 72 and 600"));
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::default();
    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let menu = MenuBuilder::new(app)
                .text("import", "PDFをインポート…")
                .text("open", "プロジェクトを開く…")
                .text("export", "書き出す…")
                .text("settings", "設定")
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("app-menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            get_environment,
            create_project,
            open_project,
            read_pdf_range,
            inspect_pdf,
            read_source_pdf_range,
            save_manifest,
            load_page,
            save_page,
            run_ocr,
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
            pdf_path: pdf.to_string_lossy().into_owned(),
            project_path: invalid_project.to_string_lossy().into_owned(),
            manifest: Some("[]".into()),
        })
        .is_err());
        assert!(!invalid_project.exists());
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
