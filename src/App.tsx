import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyLanguage, t as globalT, type LocalePreference } from "./i18n";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  open as dialogOpen,
  save as dialogSave,
} from "@tauri-apps/plugin-dialog";
import JSZip from "jszip";
import {
  ChevronLeft,
  ChevronRight,
  FileDown,
  FilePlus2,
  FolderOpen,
  Save,
  Settings2,
  Square,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import { canvasToBase64, openProjectPdf, openSourcePdf } from "./pdf";
import { SourcePageThumbnailCache } from "./pdfThumbnail";
import { invokeCommand, isTauri, type ProjectInfo } from "./tauri";
import { SaveQueue } from "./persistence";
import {
  allLines,
  exportHocr,
  exportSvg,
  exportText,
  formattedSegments,
  parseHocr,
  processCanvas,
  updateLineText,
  updateLineFormatting,
  type TextFormatKind,
  type DocumentPage,
  type LogicalPageProvenance,
} from "./domain";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ImportModal } from "./ImportModal";
import { BulkReplaceDialog, type BulkMatch, type BulkReplaceRequest } from "./BulkReplaceDialog";
import { prepareBulkUpdates } from "./bulkApply";
import { candidatesForSelection } from "./correctionCandidates";
import { importEntries, type ImportConfig } from "./importConfig";
import { loadPageImage, type ImportMode } from "./pageImage";
import {
  defaultOcrMargins,
  maskOcrCanvas,
  validateOcrMargins,
} from "./ocrMargins";

type Status = "pending" | "ocr" | "review";
type Entry = LogicalPageProvenance & {
  id: string;
  label: string;
  status: Status;
  width?: number;
  height?: number;
  dpi?: number;
  importMode?: ImportMode;
  resolvedImportMode?: ImportMode;
  sourceDpiX?: number;
  sourceDpiY?: number;
};
type Settings = { modelPath: string; psm: 3 | 6 | 11; dpi: number };
type Manifest = { version: 1; pages: Entry[]; settings: Settings };
type HistoryChange = { pageId: string; beforeData: string; afterData: string };
type LineEditSession = { id: number; pageId: string; lineId: string; beforeData: string };
type HistoryOperation = { changes: HistoryChange[]; targetPageId: string; lineEditSessionId?: number };
type RenderedEntry = { canvas: HTMLCanvasElement; modeUsed: ImportMode; dpiX: number; dpiY: number; reason?: string; sourceWidth?: number; sourceHeight?: number; };
const defaultSettings: Settings = { modelPath: "", psm: 3, dpi: 300 };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  bytes.forEach((b) => (out += String.fromCharCode(b)));
  return btoa(out);
}
function makeImportManifest(config: ImportConfig): Manifest {
  return {
    version: 1,
    pages: importEntries(config),
    settings: { ...defaultSettings, dpi: config.dpi },
  };
}
function makeManifest(pageCount = 1): Manifest {
  const pages: Entry[] = [];
  for (let sourcePage = 1; sourcePage <= pageCount; sourcePage++) {
    pages.push({
      id: `page-${sourcePage}-single`,
      label: String(sourcePage),
      sourcePage,
      split: "single",
      rotation: 0,
      angle: 0,
      importMode: "render",
      status: "pending",
    });
  }
  return { version: 1, pages, settings: { ...defaultSettings } };
}
function parseManifest(raw: string | null): Manifest {
  if (!raw) return makeManifest();
  try {
    const data = JSON.parse(raw) as Partial<Manifest>;
    if (data.version !== undefined && data.version !== 1)
      throw new Error(globalT("appErrors.unsupportedVersion"));
    if (!data?.pages?.length)
      throw new Error(globalT("appErrors.missingPages"));
    return {
      version: 1,
      settings: { ...defaultSettings, ...data.settings },
      pages: data.pages.map((page, index) => ({
        id: String(page.id || `page-${index + 1}`),
        label: String(page.label || index + 1),
        sourcePage: Number(page.sourcePage || index + 1),
        split:
          page.split === "left" || page.split === "right"
            ? page.split
            : "single",
        rotation: [0, 90, 180, 270].includes(Number(page.rotation))
          ? Number(page.rotation)
          : 0,
        angle: Number(page.angle || 0),
        ocrMargins: page.ocrMargins
          ? validateOcrMargins(
              { ...defaultOcrMargins, ...page.ocrMargins },
              page.split === "left" || page.split === "right",
            )
          : undefined,
        crop: page.crop,
        status:
          page.status === "ocr" || page.status === "review"
            ? page.status
            : "pending",
        width: page.width,
        height: page.height,
        dpi:
          Number.isInteger(page.dpi) &&
          Number(page.dpi) >= 72 &&
          Number(page.dpi) <= 600
            ? Number(page.dpi)
            : undefined,
        importMode: page.importMode === "extract" ? "extract" : "render",
        resolvedImportMode:
          page.resolvedImportMode === "extract" || page.resolvedImportMode === "render"
            ? page.resolvedImportMode
            : undefined,
        sourceDpiX: Number.isFinite(Number(page.sourceDpiX)) ? Number(page.sourceDpiX) : undefined,
        sourceDpiY: Number.isFinite(Number(page.sourceDpiY)) ? Number(page.sourceDpiY) : undefined,
      })),
    };
  } catch {
    throw new Error(
      globalT("appErrors.invalidManifest"),
    );
  }
}

function PageThumbnail({ cache, sourcePage }: { cache: SourcePageThumbnailCache | null; sourcePage: number }) {
  const frameRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (!window.IntersectionObserver) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { root: frame.closest(".page-list"), rootMargin: "180px 0px" });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const clear = () => {
      const target = canvasRef.current;
      if (target) {
        target.width = 0;
        target.height = 0;
      }
    };
    // A logical entry can stay mounted while its project PDF changes. Clear
    // before waiting so the previous project's page is never shown here.
    clear();
    if (!visible || !cache) return;
    let active = true;
    void cache.get(sourcePage).then(source => {
      const target = canvasRef.current;
      if (!active || !target) return;
      target.width = source.width;
      target.height = source.height;
      target.getContext("2d")?.drawImage(source, 0, 0);
    }).catch(() => {
      if (active) clear();
    });
    return () => { active = false; };
  }, [cache, sourcePage, visible]);

  return <span ref={frameRef} className="thumb" aria-hidden="true"><canvas ref={canvasRef} /></span>;
}
type LineOverlayProps = { value:string; left:number; top:number; width:number; height:number; fontSize:number; onChange:(value:string)=>void; onFinish:()=>void; onUndo:()=>void; onRedo:()=>void; onFormat:(start:number,end:number,kind:TextFormatKind)=>void; onOpenBulk:(selection:string,start:number,end:number)=>void; };
function LineOverlay({value,left,top,width,height,fontSize:naturalFontSize,onChange,onFinish,onUndo,onRedo,onFormat,onOpenBulk}:LineOverlayProps) {
 const { t } = useTranslation(); const inputRef=useRef<HTMLTextAreaElement>(null); const [selection,setSelection]=useState({start:0,end:0}); const [ctrl,setCtrl]=useState(false);
 const selected=value.slice(selection.start,selection.end); const candidates=selected?candidatesForSelection(selected):[];
 useLayoutEffect(()=>{const input=inputRef.current;if(!input)return;input.style.fontSize=`${naturalFontSize}px`;const ratio=Math.min(1,Math.max(1,input.clientWidth-4)/Math.max(1,input.scrollWidth-4),Math.max(1,input.clientHeight-2)/Math.max(1,input.scrollHeight-2));input.style.fontSize=`${Math.max(1,naturalFontSize*(ratio<1?ratio*.98:1))}px`;},[height,naturalFontSize,value,width]);
 useEffect(()=>{const up=(event:KeyboardEvent)=>{if(event.key==='Control'||!event.ctrlKey)setCtrl(false)};const blur=()=>setCtrl(false);document.addEventListener('keyup',up);window.addEventListener('blur',blur);return()=>{document.removeEventListener('keyup',up);window.removeEventListener('blur',blur)}},[]);
 const capture=()=>{const input=inputRef.current;if(input)setSelection({start:input.selectionStart,end:input.selectionEnd})};
 const format=(kind:TextFormatKind)=>{if(selection.start<selection.end)onFormat(selection.start,selection.end,kind)};
 const replace=(text:string)=>{onChange(value.slice(0,selection.start)+text+value.slice(selection.end));setSelection({start:selection.start,end:selection.start+text.length})};
 return <><textarea ref={inputRef} autoFocus wrap="off" className="line-overlay" value={value} onChange={event=>onChange(event.currentTarget.value)} onSelect={capture} onKeyDown={event=>{setCtrl(event.ctrlKey);const key=event.key.toLowerCase();if(event.ctrlKey&&!event.nativeEvent.isComposing&&(key==='z'||key==='y')){event.preventDefault();if(key==='y'||event.shiftKey)onRedo();else onUndo();return}if(event.key==='Escape'||(event.key==='Enter'&&!event.nativeEvent.isComposing&&event.keyCode!==229)){event.preventDefault();onFinish();return}if(event.ctrlKey&&selection.start<selection.end){const kind=key==='b'?'bold':key==='i'?'italic':event.key==='ArrowUp'?'superscript':event.key==='ArrowDown'?'subscript':null;if(kind){event.preventDefault();format(kind)}else if(/^[1-9]$/.test(key)&&candidates[Number(key)-1]){event.preventDefault();replace(candidates[Number(key)-1])}else if(key==='g'){event.preventDefault();onOpenBulk(selected,selection.start,selection.end)}}}} onKeyUp={event=>setCtrl(event.ctrlKey)} onBlur={onFinish} style={{left,top,width,height,fontSize:naturalFontSize}} />
 {selected&&<div className="selection-toolbar" style={{left,top:Math.max(0,top-34)}} onMouseDown={event=>event.preventDefault()} role="toolbar" aria-label="Selected text tools"><button onClick={()=>format('bold')} aria-label={t("toolbar.bold")}>{ctrl?'Ctrl+B':t('toolbar.bold')}</button><button onClick={()=>format('italic')} aria-label={t("toolbar.italic")}>{ctrl?'Ctrl+I':t('toolbar.italic')}</button><button onClick={()=>format('superscript')} aria-label={t("toolbar.superscript")}>{ctrl?'Ctrl+↑':t('toolbar.superscript')}</button><button onClick={()=>format('subscript')} aria-label={t("toolbar.subscript")}>{ctrl?'Ctrl+↓':t('toolbar.subscript')}</button><button onClick={()=>onOpenBulk(selected,selection.start,selection.end)} aria-label={t("toolbar.bulkReplace")}>{ctrl?"Ctrl+G":t("toolbar.bulkReplace") }</button>{candidates.map((candidate,index)=><button key={candidate} onClick={()=>replace(candidate)} aria-label={candidate}>{candidate}{ctrl && index < 9 ? ` (Ctrl+${index+1})` : ""}</button>)}</div>}</>;
}
export default function App({ initialLanguage = "auto", initialOsLocale = null }: { initialLanguage?: LocalePreference; initialOsLocale?: string | null } = {}) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState<LocalePreference>(initialLanguage);
  const [languageSaving, setLanguageSaving] = useState(false);
  const osLocale = useRef<string | null>(initialOsLocale);
  const changeLanguage = useCallback(async (preference: LocalePreference) => {
    setLanguageSaving(true);
    try {
      if (isTauri) await invokeCommand("save_user_preferences", { language: preference });
      const resolved = await applyLanguage(preference, osLocale.current);
      document.documentElement.lang = resolved;
      setLanguage(preference);
      setStartupWarning(null);
      if (isTauri) {
        try { await invokeCommand("set_ui_language", { language: resolved }); }
        catch (error) { setNotice("notices.menuFailed", { error: errorText(error) }); }
      }
    } catch (error) {
      setNotice("notices.languageSaveFailed", { error: errorText(error) });
    } finally { setLanguageSaving(false); }
  }, []);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [manifest, setManifest] = useState<Manifest>(makeManifest);
  const [index, setIndex] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [doc, setDoc] = useState<DocumentPage | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<HistoryOperation[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryOperation[]>([]);
  const [zoom, setZoom] = useState(0.42);
  const [busy, setBusy] = useState<"open" | "save" | "ocr" | null>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [notice, updateNotice] = useState<{ key: string; values?: Record<string, string | number> }>({ key: "notice.welcome" });
  const [startupWarning, setStartupWarning] = useState<{ key: string; values: { error: string } } | null>(null);
  const setNotice = useCallback((key: string, values?: Record<string, string | number>) => updateNotice({ key, values }), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulkReplace, setBulkReplace] = useState<{ search: string } | null>(null);
  const [importSource, setImportSource] = useState<{
    path: string;
    pdf: PDFDocumentProxy;
  } | null>(null);
  const [importCreating, setImportCreating] = useState(false);
  const [confirmOcr, setConfirmOcr] = useState<"current" | "all" | null>(null);
  const [exportScope, setExportScope] = useState<"current" | "all">("all");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectRef = useRef<ProjectInfo | null>(null),
    manifestRef = useRef(manifest),
    indexRef = useRef(0),
    docRef = useRef<DocumentPage | null>(null),
    environmentModel = useRef(""),
    loading = useRef(0),
    documentLoading = useRef(0),
    ocrLoading = useRef(0),
    cancelled = useRef(false),
    timer = useRef<number | null>(null),
    writeQueue = useRef(new SaveQueue()),
    working = useRef(false),
    closing = useRef(false),
    importActive = useRef(false),
    importCreatingRef = useRef(false),
    importSession = useRef(0),
    sourcePdfRef = useRef<PDFDocumentProxy | null>(null),
    bulkSnippetCanvases = useRef(new Map<string, Promise<HTMLCanvasElement | null>>()),
    lineEditSession = useRef<LineEditSession | null>(null),
    nextLineEditSession = useRef(0),
    finishLineEditRef = useRef<(lineId?: string) => void>(() => undefined),
    historyApplying = useRef(false);
  const current = manifest.pages[index] ?? null;
  const [thumbnailCacheState, setThumbnailCacheState] = useState<{ pdf: PDFDocumentProxy; cache: SourcePageThumbnailCache } | null>(null);
  // Create the cache in an effect. React StrictMode intentionally tears down
  // and recreates effects in development, so a useMemo-owned cache would be
  // disposed before its second effect setup could use it.
  useEffect(() => {
    if (!pdf) {
      setThumbnailCacheState(null);
      return;
    }
    const cache = new SourcePageThumbnailCache(pdf);
    setThumbnailCacheState({ pdf, cache });
    return () => cache.dispose();
  }, [pdf]);
  // Do not let the prior document's cache render during the commit where the
  // PDF changed, before the replacement effect has run.
  const thumbnailCache = thumbnailCacheState?.pdf === pdf ? thumbnailCacheState.cache : null;
  const putProject = useCallback((value: ProjectInfo | null) => {
    projectRef.current = value;
    setProject(value);
  }, []);
  const putManifest = useCallback((value: Manifest) => {
    manifestRef.current = value;
    setManifest(value);
  }, []);
  const putDoc = useCallback((value: DocumentPage | null) => {
    docRef.current = value;
    setDoc(value);
  }, []);
  const putIndex = useCallback((value: number) => {
    indexRef.current = value;
    setIndex(value);
  }, []);
  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = projectRef.current,
      entry = manifestRef.current.pages[indexRef.current],
      page = docRef.current;
    if (!isTauri || !p || !entry) return;
    const projectPath = p.path,
      pageId = entry.id,
      data = page?.id === entry.id ? JSON.stringify(copy(page)) : null,
      savedManifest = JSON.stringify(copy(manifestRef.current));
    const write = async () => {
      if (data) await invokeCommand("save_page", { projectPath, pageId, data });
      await invokeCommand("save_manifest", {
        projectPath,
        manifest: savedManifest,
      });
    };
    return writeQueue.current.enqueue(write);
  }, []);
  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (working.current) return;
      setBusy("save");
      flush()
        .then(
          () => setNotice("notices.saved"),
          (e) => setNotice("notices.saveFailed", { error: errorText(e) }),
        )
        .finally(() => {
          if (!working.current) setBusy(null);
        });
    }, 450);
  }, [flush]);

  const renderEntry = useCallback(
    async (
      entry: Entry,
      token: number,
      sourcePdf = pdf,
      destination?: HTMLCanvasElement,
      respectOcrCancellation = true,
    ): Promise<RenderedEntry | undefined> => {
      if (!sourcePdf) return;
      const source = await sourcePdf.getPage(entry.sourcePage);
      const requestedDpi = entry.dpi ?? manifestRef.current.settings.dpi;
      const requestedMode = entry.resolvedImportMode ?? entry.importMode ?? "render";
      const loaded = await loadPageImage(source, requestedMode, requestedDpi);
      if (entry.resolvedImportMode === "extract" && loaded.modeUsed !== "extract") {
        throw new Error(
          globalT("appErrors.extractFailed", {
            reason: loaded.reason ?? globalT("appErrors.extractReason"),
          }),
        );
      }
      const result = processCanvas(loaded.canvas, {
        sourcePage: entry.sourcePage,
        rotation: entry.rotation as 0 | 90 | 180 | 270,
        split: entry.split === "single" ? "none" : entry.split,
        crop: entry.crop,
        deskew: Boolean(entry.angle),
        maxDeskewDegrees: Math.abs(entry.angle || 0),
      });
      if (
        (!destination && (token !== loading.current || !canvasRef.current)) ||
        (destination && respectOcrCancellation && cancelled.current)
      )
        return;
      const image = result.pages[0]?.canvas;
      if (!image) throw new Error(globalT("appErrors.processedPage"));
      if (entry.resolvedImportMode && entry.width && entry.height && (entry.width !== image.width || entry.height !== image.height)) {
        throw new Error(globalT("appErrors.coordinateMismatch"));
      }
      const target = destination ?? canvasRef.current!;
      target.width = image.width;
      target.height = image.height;
      target.getContext("2d")!.drawImage(image, 0, 0);
      if (!destination) setCanvasSize({ width: image.width, height: image.height });
      return { ...loaded, canvas: image };
    },
    [pdf],
  );
  useEffect(() => {
    if (!project || !current) return;
    const token = ++documentLoading.current;
    putDoc(null);
    setSelected(null);
    setEditing(null);
    setCanvasSize({ width: 0, height: 0 });
    invokeCommand("load_page", {
      projectPath: project.path,
      pageId: current.id,
    })
      .then((saved) => {
        if (token === documentLoading.current && saved)
          putDoc(JSON.parse(saved) as DocumentPage);
      })
      .catch(
        (e) =>
          token === documentLoading.current &&
          setNotice("notices.pageLoadFailed", { error: errorText(e) }),
      );
  }, [project, index, current?.id, putDoc]);
  useEffect(() => {
    if (!project || !pdf || !current) return;
    const token = ++loading.current;
    renderEntry(current, token).catch(
      (e) =>
        token === loading.current &&
        setNotice("notices.pdfRenderFailed", { error: errorText(e) }),
    );
    // Transform changes redraw only the processed image; they do not discard a loaded document or its undo stack.
  }, [
    project,
    pdf,
    current?.id,
    current?.rotation,
    current?.split,
    current?.dpi,
    current?.importMode,
    current?.resolvedImportMode,
    manifest.settings.dpi,
    JSON.stringify(current?.crop),
    renderEntry,
  ]);
  const openInfo = useCallback(
    async (info: ProjectInfo) => {
      if (working.current) return;
      working.current = true;
      setBusy("open");
      let existing: Manifest;
      try {
        existing = parseManifest(info.manifest);
      } catch (e) {
        setNotice("notices.genericError", { error: errorText(e) });
        setBusy(null);
        working.current = false;
        return;
      }
      if (!existing.settings.modelPath)
        existing.settings.modelPath = environmentModel.current;
      try {
        const opened = await openProjectPdf(info.path, info.pdfSize);
        const oldPdf = pdf;
        setPdf(null);
        if (oldPdf) await oldPdf.destroy();
        putProject(info);
        bulkSnippetCanvases.current.clear();
        lineEditSession.current = null;
        setEditing(null);
        setUndoStack([]);
        setRedoStack([]);
        putManifest(existing);
        putIndex(0);
        putDoc(null);
        setPdf(opened);
        if (!info.manifest) {
          const next = makeManifest(opened.numPages);
          next.settings.modelPath = existing.settings.modelPath;
          putManifest(next);
          await invokeCommand("save_manifest", {
            projectPath: info.path,
            manifest: JSON.stringify(next),
          });
        }
        setNotice("notices.opened", { name: info.name });
      } catch (e) {
        setNotice("notices.pdfLoadFailed", { error: errorText(e) });
      } finally {
        setBusy(null);
        working.current = false;
      }
    },
    [pdf, putDoc, putIndex, putManifest, putProject],
  );
  const closeImport = useCallback(() => {
    importSession.current += 1;
    importActive.current = false;
    const source = sourcePdfRef.current;
    sourcePdfRef.current = null;
    setImportSource(null);
    source?.destroy().catch(() => undefined);
  }, []);
  const importPdf = useCallback(async () => {
    if (working.current || importActive.current) return;
    importActive.current = true;
    const session = ++importSession.current;
    let source: PDFDocumentProxy | null = null;
    try {
      await flush();
      const pdfPath = await dialogOpen({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof pdfPath !== "string") {
        importActive.current = false;
        return;
      }
      const { pdfSize } = await invokeCommand("inspect_pdf", { pdfPath });
      source = await openSourcePdf(pdfPath, pdfSize);
      if (session !== importSession.current) {
        await source.destroy();
        return;
      }
      sourcePdfRef.current = source;
      setImportSource({ path: pdfPath, pdf: source });
    } catch (e) {
      if (source) await source.destroy().catch(() => undefined);
      if (session === importSession.current) {
        importActive.current = false;
        setNotice("notices.pdfInspectFailed", { error: errorText(e) });
      }
    }
  }, [flush]);
  const confirmImport = useCallback(
    async (config: ImportConfig) => {
      if (!importSource || importCreatingRef.current || working.current) return;
      const source = sourcePdfRef.current;
      if (!source) return;
      importCreatingRef.current = true;
      setImportCreating(true);
      try {
        const projectPath = await dialogSave({
          defaultPath: importSource.path.replace(/\.pdf$/i, ".eduba"),
          filters: [{ name: "Eduba", extensions: ["eduba"] }],
        });
        if (typeof projectPath !== "string") return;
        const next = makeImportManifest(config);
        next.settings = {
          ...manifestRef.current.settings,
          dpi: config.dpi,
          modelPath:
            manifestRef.current.settings.modelPath || environmentModel.current,
        };
        const info = await invokeCommand("create_project", {
          pdfPath: importSource.path,
          projectPath,
          manifest: JSON.stringify(next),
        });
        sourcePdfRef.current = null;
        setImportSource(null);
        importActive.current = false;
        await source.destroy();
        await openInfo(info);
      } catch (e) {
        setNotice("notices.importFailed", { error: errorText(e) });
      } finally {
        importCreatingRef.current = false;
        setImportCreating(false);
      }
    },
    [importSource, openInfo],
  );
  const openProject = useCallback(async () => {
    if (working.current || importActive.current) return;
    try {
      await flush();
      const path = await dialogOpen({
        multiple: false,
        filters: [{ name: "Eduba", extensions: ["eduba"] }],
      });
      if (typeof path === "string")
        await openInfo(
          await invokeCommand("open_project", { projectPath: path }),
        );
    } catch (e) {
      setNotice("notices.projectOpenFailed", { error: errorText(e) });
    }
  }, [flush, openInfo]);
  const finishLineEdit = useCallback((lineId?: string) => {
    const session = lineEditSession.current;
    if (!session || (lineId && session.lineId !== lineId)) return;
    lineEditSession.current = null;
    setUndoStack((old) => {
      let start = old.length;
      while (start > 0 && old[start - 1].lineEditSessionId === session.id) start -= 1;
      const stable = old.slice(0, start);
      const afterData = JSON.stringify(docRef.current);
      if (session.beforeData === afterData) return stable.slice(-100);
      return [...stable.slice(-99), {
        targetPageId: session.pageId,
        changes: [{ pageId: session.pageId, beforeData: session.beforeData, afterData }],
      }];
    });
    setRedoStack((old) => old.filter((operation) => operation.lineEditSessionId !== session.id));
    setEditing((current) => current === session.lineId ? null : current);
  }, []);
  finishLineEditRef.current = finishLineEdit;
  const beginLineEdit = useCallback((lineId: string) => {
    finishLineEditRef.current();
    const pageId = manifestRef.current.pages[indexRef.current]?.id;
    if (!pageId) return;
    const before = docRef.current;
    if (!before) return;
    lineEditSession.current = { id: ++nextLineEditSession.current, pageId, lineId, beforeData: JSON.stringify(before) };
    setSelected(lineId);
    setEditing(lineId);
  }, []);
  const commitLineEdit = useCallback((lineId: string, update: (before: DocumentPage) => DocumentPage) => {
    if (working.current || importActive.current) return;
    const before = docRef.current;
    const session = lineEditSession.current;
    if (!before || !session || session.lineId !== lineId || session.pageId !== manifestRef.current.pages[indexRef.current]?.id) return;
    const after = update(before);
    setUndoStack((old) => {
      let start = old.length;
      while (start > 0 && old[start - 1].lineEditSessionId === session.id) start -= 1;
      const stable = old.slice(0, start).slice(-99);
      const sessionEdits = old.slice(start).slice(-99);
      return [...stable, ...sessionEdits, {
        targetPageId: session.pageId,
        changes: [{ pageId: session.pageId, beforeData: JSON.stringify(before), afterData: JSON.stringify(after) }],
        lineEditSessionId: session.id,
      }];
    });
    setRedoStack([]);
    putDoc(after);
    scheduleSave();
  }, [putDoc, scheduleSave]);
  const go = useCallback(
    async (next: number) => {
      if (working.current || importActive.current) {
        setNotice("notices.navigationBusy");
        return;
      }
      if (next < 0 || next >= manifestRef.current.pages.length || next === indexRef.current) return;
      finishLineEditRef.current();
      try {
        setBusy("save");
        await flush();
        putIndex(next);
      } catch (e) {
        setNotice("notices.navigationSaveFailed", { error: errorText(e) });
      } finally {
        setBusy(null);
      }
    },
    [flush, putIndex],
  );
  const editLine = useCallback((id: string, text: string) => {
    commitLineEdit(id, (before) => updateLineText(before, id, text));
  }, [commitLineEdit]);
  const applyHistory = useCallback(async (operation: HistoryOperation, reverse: boolean) => {
    const projectInfo = projectRef.current;
    if (!projectInfo) return;
    await flush();
    const updates = operation.changes.map((change) => ({
      pageId: change.pageId,
      expectedData: reverse ? change.afterData : change.beforeData,
      data: reverse ? change.beforeData : change.afterData,
    }));
    await invokeCommand("apply_bulk_corrections", { projectPath: projectInfo.path, updates });
    const target = manifestRef.current.pages.findIndex((page) => page.id === operation.targetPageId);
    if (target < 0) return;
    const targetChange = operation.changes.find((change) => change.pageId === operation.targetPageId);
    if (target === indexRef.current && targetChange) putDoc(JSON.parse(reverse ? targetChange.beforeData : targetChange.afterData) as DocumentPage);
    else putIndex(target);
  }, [flush, putDoc, putIndex]);
  const undo = useCallback(async () => {
    if (working.current || importActive.current || historyApplying.current) return;
    const operation = undoStack.at(-1);
    const session = lineEditSession.current;
    if (session && (!operation || operation.lineEditSessionId !== session.id)) {
      finishLineEditRef.current();
      return;
    }
    if (!operation) return;
    historyApplying.current = true;
    setBusy("save");
    try {
      await applyHistory(operation, true);
      setUndoStack((old) => old.slice(0, -1));
      setRedoStack((old) => [operation, ...old].slice(0, 100));
    } catch (error) { setNotice("notices.saveFailed", { error: errorText(error) }); }
    finally { historyApplying.current = false; setBusy(null); }
  }, [applyHistory, undoStack, setNotice]);
  const redo = useCallback(async () => {
    if (working.current || importActive.current || historyApplying.current) return;
    const operation = redoStack[0];
    const session = lineEditSession.current;
    if (session && (!operation || operation.lineEditSessionId !== session.id)) {
      finishLineEditRef.current();
      return;
    }
    if (!operation) return;
    historyApplying.current = true;
    setBusy("save");
    try {
      await applyHistory(operation, false);
      setRedoStack((old) => old.slice(1));
      setUndoStack((old) => [...old, operation].slice(-100));
    } catch (error) { setNotice("notices.saveFailed", { error: errorText(error) }); }
    finally { historyApplying.current = false; setBusy(null); }
  }, [applyHistory, redoStack, setNotice]);
  const recognize = useCallback(
    async (entry: Entry, token: number) => {
      const worker = document.createElement("canvas");
      const rendered = await renderEntry(entry, token, undefined, worker);
      if (!rendered) throw new Error(globalT("appErrors.imageCreate"));
      if (cancelled.current || token !== ocrLoading.current)
        throw new Error(globalT("appErrors.ocrCancelled"));
      const sourceDpiX = entry.rotation === 90 || entry.rotation === 270 ? rendered.dpiY : rendered.dpiX;
      const sourceDpiY = entry.rotation === 90 || entry.rotation === 270 ? rendered.dpiX : rendered.dpiY;
      const renderDpi = Math.max(70, Math.min(2400, Math.round(Math.sqrt(sourceDpiX * sourceDpiY))));
      const hocr = await invokeCommand("run_ocr", {
        imageBase64: canvasToBase64(
          maskOcrCanvas(worker, entry.split, entry.ocrMargins),
        ),
        modelPath: manifestRef.current.settings.modelPath,
        psm: manifestRef.current.settings.psm,
        dpi: renderDpi,
      });
      if (cancelled.current) throw new Error(globalT("appErrors.ocrCancelled"));
      const parsed = parseHocr(hocr, {
        sourcePage: entry.sourcePage,
        pageId: entry.id,
      })[0];
      if (!parsed) throw new Error(globalT("appErrors.hocrMissingPage"));
      return {
        ...parsed,
        id: entry.id,
        sourcePage: entry.sourcePage,
        split: entry.split,
        rotation: entry.rotation,
        angle: entry.angle,
        crop: entry.crop,
        ocrMargins: entry.ocrMargins,
        width: worker.width,
        height: worker.height,
        importMode: entry.importMode ?? "render",
        resolvedImportMode: rendered.modeUsed,
        sourceDpiX,
        sourceDpiY,
      };
    },
    [renderEntry],
  );
  const runOcr = useCallback(
    async (scope: "current" | "all") => {
      if (!projectRef.current || working.current || importActive.current)
        return;
      finishLineEditRef.current();
      working.current = true;
      try {
        await flush();
      } catch (error) {
        working.current = false;
        setNotice("notices.ocrSaveFailed", { error: errorText(error) });
        return;
      }
      const targets =
        scope === "current"
          ? [manifestRef.current.pages[indexRef.current]]
          : manifestRef.current.pages.filter((p) => p.status !== "review");
      if (!targets.length) {
        working.current = false;
        setNotice("notices.noPendingOcr");
        return;
      }
      cancelled.current = false;
      setBusy("ocr");
      setProgress({ done: 0, total: targets.length });
      try {
        for (let i = 0; i < targets.length; i++) {
          if (cancelled.current) break;
          const entry = targets[i],
            token = ++ocrLoading.current,
            result = await recognize(entry, token);
          if (cancelled.current) break;
          const next = {
            ...manifestRef.current,
            pages: manifestRef.current.pages.map((p) =>
              p.id === entry.id
                ? {
                    ...p,
                    status: "review" as const,
                    width: result.width,
                    height: result.height,
                    dpi: entry.dpi ?? manifestRef.current.settings.dpi,
                    importMode: result.importMode ?? entry.importMode ?? "render",
                    resolvedImportMode: result.resolvedImportMode ?? entry.resolvedImportMode,
                    sourceDpiX: result.sourceDpiX,
                    sourceDpiY: result.sourceDpiY,
                  }
                : p,
            ),
          };
          const path = projectRef.current.path,
            data = JSON.stringify(result),
            savedManifest = JSON.stringify(next);
          const write = async () => {
            await invokeCommand("save_page", {
              projectPath: path,
              pageId: entry.id,
              data,
            });
            await invokeCommand("save_manifest", {
              projectPath: path,
              manifest: savedManifest,
            });
          };
          await writeQueue.current.enqueue(write);
          putManifest(next);
          if (entry.id === next.pages[indexRef.current]?.id) putDoc(result);
          setProgress({ done: i + 1, total: targets.length });
        }
        setNotice(
          cancelled.current ? "notices.ocrCancelled" : "notices.ocrComplete",
        );
      } catch (e) {
        setNotice("notices.ocrFailed", { error: errorText(e) });
      } finally {
        working.current = false;
        setBusy(null);
        setProgress(null);
        const active = manifestRef.current.pages[indexRef.current];
        if (active) {
          const token = ++loading.current;
          renderEntry(active, token).catch(() => undefined);
        }
      }
    },
    [putDoc, putManifest, recognize],
  );
  const askOcr = useCallback(
    (scope: "current" | "all") => {
      if (importActive.current) return;
      if (
        scope === "current" &&
        docRef.current &&
        allLines(docRef.current).some(
          (line) => line.correctedText !== line.originalText,
        )
      )
        setConfirmOcr(scope);
      else runOcr(scope);
    },
    [runOcr],
  );
  const cancelOcr = useCallback(() => {
    cancelled.current = true;
    invokeCommand("cancel_ocr").catch(() => undefined);
  }, []);
  const exportFile = useCallback(
    async (type: "txt" | "hocr" | "svg", scope: "current" | "all" = "all") => {
      if (!projectRef.current || working.current || importActive.current)
        return;
      try {
        working.current = true;
        setBusy("save");
        await flush();
        const pages: DocumentPage[] = [];
        const entries =
          scope === "current"
            ? [manifestRef.current.pages[indexRef.current]]
            : manifestRef.current.pages;
        for (const entry of entries) {
          const saved = await invokeCommand("load_page", {
            projectPath: projectRef.current.path,
            pageId: entry.id,
          });
          if (saved) pages.push(JSON.parse(saved) as DocumentPage);
        }
        if (!pages.length)
          throw new Error(globalT("appErrors.noExport"));
        let content = "",
          suffix = type === "txt" ? "txt" : type === "hocr" ? "html" : "svg",
          readyBase64 = false;
        if (type === "txt") content = exportText(pages);
        else if (type === "hocr") content = exportHocr(pages);
        else if (pages.length === 1) content = exportSvg(pages[0]);
        else {
          const zip = new JSZip();
          pages.forEach((page, i) =>
            zip.file(`page-${i + 1}.svg`, exportSvg(page)),
          );
          content = await zip.generateAsync({ type: "base64" });
          suffix = "zip";
          readyBase64 = true;
        }
        const path = await dialogSave({
          defaultPath: `${projectRef.current.name.replace(/\.eduba$/i, "")}.${suffix}`,
          filters: [{ name: suffix.toUpperCase(), extensions: [suffix] }],
        });
        if (typeof path === "string")
          await invokeCommand("export_file", {
            path,
            contentBase64: readyBase64 ? content : encode(content),
          });
        setNotice("notices.exported");
      } catch (e) {
        setNotice("notices.exportFailed", { error: errorText(e) });
      } finally {
        working.current = false;
        setBusy(null);
      }
    },
    [flush],
  );
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    listen<string>("app-menu", (event) => {
      if (working.current || importActive.current) return;
      if (event.payload === "import") importPdf();
      if (event.payload === "open") openProject();
      if (event.payload === "export") exportFile("txt");
      if (event.payload === "settings") setSettingsOpen(true);
    }).then((value) => (off = value));
    return () => off?.();
  }, [exportFile, importPdf, openProject]);
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing.current) return;
        event.preventDefault();
        if (
          working.current ||
          importActive.current ||
          importCreatingRef.current
        ) {
          setNotice("notices.closeBusy");
          return;
        }
        try {
          if (timer.current) clearTimeout(timer.current);
          await flush();
          await writeQueue.current.idle();
          closing.current = true;
          await getCurrentWindow().destroy();
        } catch (error) {
          setNotice("notices.closeSaveFailed", { error: errorText(error) });
        }
      })
      .then((value) => {
        unlisten = value;
      });
    return () => unlisten?.();
  }, [flush]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      importSession.current += 1;
      importActive.current = false;
      const source = sourcePdfRef.current;
      sourcePdfRef.current = null;
      source?.destroy().catch(() => undefined);
      flush().catch(() => undefined);
    },
    [flush],
  );
  useEffect(() => {
    if (!isTauri) return;
    invokeCommand("get_environment")
      .then((env) => {
        environmentModel.current = env.modelPath;
        if (!manifestRef.current.settings.modelPath)
          putManifest({
            ...manifestRef.current,
            settings: {
              ...manifestRef.current.settings,
              modelPath: env.modelPath,
            },
          });
      })
      .catch(() => undefined);
  }, [putManifest]);
  useEffect(() => {
    const key = "eduba-language-error";
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    window.sessionStorage.removeItem(key);
    try {
      const saved = JSON.parse(raw) as { kind?: "load" | "menu"; error?: string };
      setStartupWarning({
        key: saved.kind === "menu" ? "notices.menuFailed" : "notices.languageLoadFailed",
        values: { error: saved.error ?? raw },
      });
    } catch {
      setStartupWarning({ key: "notices.languageLoadFailed", values: { error: raw } });
    }
  }, [setNotice]);
  const openBulkReplace = useCallback(async (search: string) => {
    if (!project || working.current || importActive.current || !search) return;
    try {
      finishLineEditRef.current();
      await flush();
      bulkSnippetCanvases.current.clear();
      setBulkReplace({ search });
    } catch (error) {
      setNotice("notices.saveFailed", { error: errorText(error) });
    }
  }, [flush, project, setNotice]);
  const getBulkSnippet = useCallback(async (pageId: string, bbox?: BulkMatch["bbox"]) => {
    if (!pdf || !bbox) return null;
    const entry = manifestRef.current.pages.find((candidate) => candidate.id === pageId);
    if (!entry) return null;
    let sourcePromise = bulkSnippetCanvases.current.get(pageId);
    if (!sourcePromise) {
      sourcePromise = (async () => {
        const target = document.createElement("canvas");
        const rendered = await renderEntry(entry, loading.current, pdf, target, false);
        return rendered?.canvas ?? null;
      })();
      bulkSnippetCanvases.current.set(pageId, sourcePromise);
    }
    const source = await sourcePromise;
    if (!source) return null;
    const left = Math.max(0, Math.floor(bbox.left));
    const top = Math.max(0, Math.floor(bbox.top));
    const right = Math.min(source.width, Math.ceil(bbox.right));
    const bottom = Math.min(source.height, Math.ceil(bbox.bottom));
    if (right <= left || bottom <= top) return null;
    const crop = document.createElement("canvas");
    crop.width = right - left;
    crop.height = bottom - top;
    crop.getContext("2d")?.drawImage(source, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return "data:image/png;base64," + canvasToBase64(crop);
  }, [pdf, renderEntry]);

  const applyBulkReplace = useCallback(async ({ search, replacement, selections }: BulkReplaceRequest) => {
    if (!project || !selections.length) return;
    await flush();
    const updates = await prepareBulkUpdates({ selections, search, replacement, loadPage: async (pageId) => {
      const saved = await invokeCommand("load_page", { projectPath: project.path, pageId });
      if (!saved) throw new Error("Page data is unavailable.");
      return saved;
    }});
    const changes = await invokeCommand("apply_bulk_corrections", { projectPath: project.path, updates });
    const currentId = manifestRef.current.pages[indexRef.current]?.id;
    const targetPageId = changes.some((item) => item.pageId === currentId)
      ? currentId!
      : changes[0]?.pageId;
    if (targetPageId) {
      setUndoStack((old) => [...old.slice(-99), { targetPageId, changes }]);
      setRedoStack([]);
    }
    const change = changes.find((item) => item.pageId === currentId);
    if (change?.afterData && docRef.current) putDoc(JSON.parse(change.afterData) as DocumentPage);
    setBulkReplace(null);
  }, [flush, project, putDoc]);
  const lines = useMemo(() => (doc ? allLines(doc) : []), [doc]);
  const w = canvasSize.width * zoom,
    h = canvasSize.height * zoom;
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div>
            <div className="brand-name">EDUBA</div>
            <div className="brand-sub">{t("ui.tagline")}</div>
          </div>
        </div>
        <div className="project-title">
          <span>{project?.name ?? t("ui.newProject")}</span>
          <span className="muted">
            {project
              ? t("ui.logicalPageCount", { count: manifest.pages.length })
              : t("ui.projectFile")}
          </span>
        </div>
        <button
          className="icon-btn"
          disabled={Boolean(busy)}
          onClick={() => {
            if (!importActive.current) setSettingsOpen(true);
          }}
          title={t("ui.settings")} aria-label={t("ui.settings")}
        >
          <Settings2 size={16} />
        </button>
      </header>
      <nav className="toolbar">
        <button onClick={importPdf} disabled={Boolean(busy)}>
          <FilePlus2 size={15} /> {t("ui.importPdf")}
        </button>
        <button onClick={openProject} disabled={Boolean(busy)}>
          <FolderOpen size={15} /> {t("ui.open")}
        </button>
        <span className="toolbar-divider" />
        <button
          onClick={() => {
            setBusy("save");
            flush()
              .then(
                () => setNotice("notices.saved"),
                (e) => setNotice("notices.saveFailed", { error: errorText(e) }),
              )
              .finally(() => setBusy(null));
          }}
          disabled={!project || Boolean(busy)}
        >
          <Save size={15} /> {t("ui.save")}
        </button>
        <button onClick={undo} disabled={!undoStack.length || Boolean(busy)}>
          <Undo2 size={15} /> {t("ui.undo")}
        </button>
        <button onClick={redo} disabled={!redoStack.length || Boolean(busy)}>
          <Redo2 size={15} /> {t("ui.redo")}
        </button>
        <span className="toolbar-spacer" />
        <button
          className="secondary"
          onClick={() => askOcr("current")}
          disabled={!project || Boolean(busy)}
        >
          {t("ui.ocrCurrent")}
        </button>
        <button
          className="primary"
          onClick={() => askOcr("all")}
          disabled={!project || Boolean(busy)}
        >
          {progress ? `${progress.done}/${progress.total}` : t("ui.ocrPending")}
        </button>
        {busy === "ocr" && (
          <button className="ocr-stop" onClick={cancelOcr}>
            <Square size={13} /> {t("ui.cancel")}
          </button>
        )}
        <span className="toolbar-divider" />
        <select
          value={exportScope}
          onChange={(e) => setExportScope(e.target.value as "current" | "all")}
          disabled={!project || Boolean(busy)}
        >
          <option value="current">{t("ui.currentPage")}</option>
          <option value="all">{t("ui.allPages")}</option>
        </select>
        <button
          onClick={() => exportFile("txt", exportScope)}
          disabled={!project || Boolean(busy)}
        >
          <FileDown size={15} /> TXT
        </button>
        <button
          onClick={() => exportFile("hocr", exportScope)}
          disabled={!project || Boolean(busy)}
        >
          hOCR
        </button>
        <button
          onClick={() => exportFile("svg", exportScope)}
          disabled={!project || Boolean(busy)}
        >
          SVG
        </button>
      </nav>
      <section className="workspace">
        <aside className="sidebar">
          <div className="side-heading">
            <span>{t("ui.logicalPages")}</span>
            <span className="page-count">{manifest.pages.length}</span>
          </div>
          <div className="page-list">
            {manifest.pages.map((page, i) => (
              <button
                key={page.id}
                className={`page-item ${i === index ? "active" : ""}`}
                onClick={() => go(i)}
                disabled={Boolean(busy)}
                aria-label={`${t("ui.page", { page: page.label })} · ${t("ui.sourcePage", { page: page.sourcePage })} · ${page.split === "single" ? t("ui.whole") : page.split === "left" ? t("ui.left") : t("ui.right")}`}
              >
                <PageThumbnail cache={thumbnailCache} sourcePage={page.sourcePage} />
                <span className="page-meta">
                  <strong>{page.label}</strong>
                  <small>
                    {t("ui.sourcePage", { page: page.sourcePage })} ·{" "}
                    {page.split === "single"
                      ? t("ui.whole")
                      : page.split === "left"
                        ? t("ui.left")
                        : t("ui.right")}
                  </small>
                </span>
                <span
                  className={`status-dot ${page.status === "review" ? "ready" : ""}`}
                />
              </button>
            ))}
          </div>
        </aside>
        <section className="editor-area">
          <div className="canvas-toolbar">
            <div className="breadcrumb">
              <strong>
                {current ? t("ui.page", { page: current.label }) : t("ui.openPdf")}
              </strong>
              <span>
                ／{" "}
                {current?.split === "single"
                  ? t("ui.whole")
                  : current?.split === "left"
                    ? t("ui.leftPage")
                    : t("ui.rightPage")}
              </span>
            </div>
            <div className="view-tools">
              <button
                className="icon-btn"
                onClick={() => setZoom((v) => Math.max(0.2, v - 0.08))}
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                className="icon-btn"
                onClick={() => setZoom((v) => Math.min(1.1, v + 0.08))}
              >
                ＋
              </button>
              <span className="toolbar-divider short" />
              <button
                className="icon-btn"
                onClick={() => go(index - 1)}
                disabled={index === 0 || Boolean(busy)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon-btn"
                onClick={() => go(index + 1)}
                disabled={index >= manifest.pages.length - 1 || Boolean(busy)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
          <div className="proofing-grid">
            <article className="pdf-pane">
              <div className="pane-label">
                <span>{t("ui.processedImage")}</span>
              </div>
              <div className="pdf-stage">
                {project ? (
                  <canvas
                    ref={canvasRef}
                    className="rendered-page"
                    style={{ width: w || undefined, height: h || undefined }}
                  />
                ) : (
                  <Empty />
                )}
              </div>
            </article>
            <article className="ocr-pane">
              <div className="pane-label">
                <span>{t("ui.recognitionLayout")}</span>
                <span className="pane-hint">{t("ui.clickLine")}</span>
              </div>
              <div className="ocr-stage">
                {doc && canvasSize.width ? (
                  <div
                    className="layout-card"
                    style={{ width: w, height: h, minHeight: h }}
                  >
                    <svg
                      className="layout-svg"
                      viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
                    >
                      {lines.map((line) => (
                        <g key={line.id}>
                          <rect
                            className={selected === line.id ? "selected" : ""}
                            x={line.bbox.left}
                            y={line.bbox.top}
                            width={Math.max(
                              1,
                              line.bbox.right - line.bbox.left,
                            )}
                            height={Math.max(
                              1,
                              line.bbox.bottom - line.bbox.top,
                            )}
                            onClick={() => beginLineEdit(line.id)}
                          />
                          <text
                            x={line.bbox.left}
                            y={
                              line.bbox.bottom + (line.baseline?.intercept ?? 0)
                            }
                            fontFamily="monospace"
                            fontSize={
                              line.fontSize ||
                              Math.max(10, line.bbox.bottom - line.bbox.top)
                            }
                            textLength={Math.max(
                              1,
                              line.bbox.right - line.bbox.left,
                            )}
                            lengthAdjust="spacingAndGlyphs"
                          >
                            {line.formatting?.length ? <tspan dangerouslySetInnerHTML={{ __html: formattedSegments(line, true) }} /> : line.correctedText}
                          </text>
                        </g>
                      ))}
                    </svg>
                    {editing &&
                      (() => {
                        const line = lines.find((v) => v.id === editing);
                        return line ? (
                          <LineOverlay
                            value={line.correctedText}
                            onChange={(value) => editLine(line.id, value)}
                            onFinish={() => finishLineEdit(line.id)}
                            onUndo={() => void undo()}
                            onRedo={() => void redo()}
                            onFormat={(start, end, kind) => commitLineEdit(line.id, (before) => updateLineFormatting(before, line.id, start, end, kind))}
                            onOpenBulk={(selection) => void openBulkReplace(selection)}
                            left={line.bbox.left * zoom}
                            top={line.bbox.top * zoom}
                            width={Math.max(20, (line.bbox.right - line.bbox.left) * zoom)}
                            height={Math.max(22, (line.bbox.bottom - line.bbox.top) * zoom + 8)}
                            fontSize={Math.max(1, (line.fontSize || line.bbox.bottom - line.bbox.top) * zoom)}
                          />
                        ) : null;
                      })()}
                  </div>
                ) : (
                  <div className="ocr-empty">
                    <strong>
                      {project
                        ? t("ui.noOcr")
                        : t("ui.importToStart")}
                    </strong>
                    <span>
                      {project
                        ? t("ui.runOcrHint")
                        : t("ui.singleFileHint")}
                    </span>
                  </div>
                )}
              </div>
            </article>
          </div>
        </section>
      </section>
      <footer className="statusbar">
        <span className="status-left">
          {startupWarning && <span title={t(startupWarning.key, startupWarning.values)}>{t(startupWarning.key, startupWarning.values)}</span>}
          <span>{t(notice.key, notice.values)}</span>
        </span>
        <span className={`save-indicator ${busy === "save" ? "working" : ""}`}>
          {busy === "save" ? t("ui.saving") : project ? t("ui.autosave") : t("ui.idle")}
        </span>
      </footer>
      {bulkReplace && project && (<BulkReplaceDialog open={true} projectPath={project.path} initialSearch={bulkReplace.search} getSnippet={getBulkSnippet} onApply={applyBulkReplace} onClose={() => { bulkSnippetCanvases.current.clear(); setBulkReplace(null); }} />)}
      {importSource && (
        <ImportModal
          pdfPath={importSource.path}
          pdf={importSource.pdf}
          onCancel={closeImport}
          onConfirm={confirmImport}
          busy={importCreating}
        />
      )}{" "}
      {settingsOpen && (
        <SettingsModal
          manifest={manifest}
          putManifest={putManifest}
          scheduleSave={scheduleSave}
          language={language}
          changeLanguage={changeLanguage}
          languageSaving={languageSaving}
          close={() => setSettingsOpen(false)}
        />
      )}{" "}
      {confirmOcr && (
        <div className="modal-scrim">
          <div className="modal">
            <div className="modal-head">
              <div>
                <div className="eyebrow">{t("ui.recognizeAgain")}</div>
                <h2>{t("ui.replaceTitle")}</h2>
              </div>
              <button className="icon-btn" onClick={() => setConfirmOcr(null)}>
                <X size={16} />
              </button>
            </div>
            <p>{t("ui.replaceDescription")}</p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setConfirmOcr(null)}>
                {t("ui.back")}
              </button>
              <button
                className="primary"
                onClick={() => {
                  const scope = confirmOcr;
                  setConfirmOcr(null);
                  runOcr(scope);
                }}
              >
                {t("ui.replaceOcr")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
function Empty() {
  const { t } = useTranslation();
  return (
    <div className="empty-state">
      <strong>Eduba</strong>
      <span>{t("ui.importToStart")}</span>
    </div>
  );
}
function SettingsModal({
  manifest,
  putManifest,
  scheduleSave,
  close,
  language,
  changeLanguage,
  languageSaving,
}: {
  manifest: Manifest;
  putManifest: (v: Manifest) => void;
  scheduleSave: () => void;
  close: () => void;
  language: LocalePreference;
  changeLanguage: (language: LocalePreference) => Promise<void>;
  languageSaving: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="modal-scrim">
      <div className="modal settings-modal">
        <div className="modal-head"><div><div className="eyebrow">{t("ui.ocrSettings")}</div><h2>{t("ui.settings")}</h2></div><button className="icon-btn" onClick={close} aria-label={t("ui.close")}><X size={16} /></button></div>
        <label>{t("ui.language")}
          <select aria-label={t("ui.language")} disabled={languageSaving} value={language} onChange={(e) => void changeLanguage(e.target.value as LocalePreference)}>
            <option value="auto">{t("language.auto")}</option><option value="en">{t("language.en")}</option><option value="ja">{t("language.ja")}</option><option value="zh-Hans">{t("language.zh-Hans")}</option><option value="zh-Hant">{t("language.zh-Hant")}</option>
          </select>
        </label>
        <label>{t("ui.model")}
          <button className="file-select" onClick={async () => {
            const path = await dialogOpen({ multiple: false, filters: [{ name: t("ui.model"), extensions: ["traineddata"] }] });
            if (typeof path === "string") { putManifest({ ...manifest, settings: { ...manifest.settings, modelPath: path } }); scheduleSave(); }
          }}>{manifest.settings.modelPath || t("ui.selectModel")}</button>
        </label>
        <label>PSM<select value={manifest.settings.psm} onChange={(e) => { putManifest({ ...manifest, settings: { ...manifest.settings, psm: Number(e.target.value) as Settings["psm"] } }); scheduleSave(); }}><option value="3">3 — {t("ui.automatic")}</option><option value="6">6 — {t("ui.singleBlock")}</option><option value="11">11 — {t("ui.sparseText")}</option></select></label>
        <div className="modal-actions"><button className="primary" onClick={close}>{t("ui.done")}</button></div>
      </div>
    </div>
  );
}
