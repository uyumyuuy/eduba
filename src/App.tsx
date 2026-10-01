import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { EditToolbarButton } from "./EditToolbarButton";
import { FormattedEditMirror } from "./FormattedEditMirror";
import { EditImageFocus } from "./EditImageFocus";
import { ProofingTextMagnifier } from "./ProofingTextMagnifier";
import { createPortal } from "react-dom";
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
  Settings2,
  Square,
  Undo2,
  Redo2,
  ScanLine,
  Eraser,
  GitMerge,
  ListOrdered,
  X,
} from "lucide-react";
import { canvasToBase64, openProjectPdf, openSourcePdf } from "./pdf";
import { LogicalPageThumbnailCache } from "./pdfThumbnail";
import { invokeCommand, isTauri, type ProjectInfo } from "./tauri";
import { SaveQueue } from "./persistence";
import { compactChange, historyPageUpdate, HistoryPersistence, type ProjectPageUpdate, type HistoryOperation as EditHistoryOperation } from "./editHistory";
import { createReadableHtml } from "./readableHtml";
import { loadReadableFontFaces, notoSerifLicense } from "./readableHtmlFonts";
import { inferWordStyles, clearAutoWordStyles } from "./styleDetection";
import {
  allLines,
  effectiveFormatting,
  exportHocr,
  exportSvg,
  exportText,
  formattedSegments,
  parseHocr,
  processCanvas,
  updateLineText,
  splitLineAtCaret,
  updateLineFormatting,
  applyScriptDetection,
  type OcrLine,
  type TextFormatKind,
  type TextFormatRange,
  type DocumentPage,
  type LogicalPageProvenance,
  type Rect,
} from "./domain";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ImportModal } from "./ImportModal";
import { ScriptCalibrationDialog, type ScriptCalibrationCandidate, type ScriptCalibrationProgress } from "./ScriptCalibrationDialog";
import { DEFAULT_SCRIPT_DETECTION_SETTINGS, SCRIPT_HEIGHT_REFERENCE_VERSION, ScriptHeightTrainer, detectScriptRanges, migrateLegacyScriptSettings, referenceHeightsForPage, type ScriptDetectionSettings, type ScriptHeightProfile } from "./scriptDetection";
import { BulkReplaceDialog, type BulkMatch, type BulkReplaceRequest } from "./BulkReplaceDialog";
import { prepareBulkUpdates } from "./bulkApply";
import { addOcrRegion, prepareRegionOcrImage, removeOcrLinesInRegion, removeOcrLineAtPoint, mergeOcrLinesInRegion } from "./ocrRegion";
import { lineIdsCrossed, moveLineAfter, reorderPageLines, type Point } from "./readingOrder";
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
  /** A user-owned review marker. It is independent of OCR status. */
  completed?: boolean;
  width?: number;
  height?: number;
  dpi?: number;
  importMode?: ImportMode;
  resolvedImportMode?: ImportMode;
  sourceDpiX?: number;
  sourceDpiY?: number;
};
type Settings = { modelPath: string; psm: 3 | 6 | 11; dpi: number; scriptHeightReferenceVersion: number; scriptHeightProfile?: ScriptHeightProfile } & ScriptDetectionSettings;
type Manifest = { version: 1; pages: Entry[]; settings: Settings };
type HistoryChange = { pageId: string; beforeData: string; afterData: string };
type ScriptCalibrationSampleScope = { kind: "all-pages" } | { kind: "current-page"; pageId: string };
type LineEditSession = { id: number; pageId: string; lineId: string; beforeData: string };
type HistoryOperation = EditHistoryOperation<Settings, Entry>;
type RenderedEntry = { canvas: HTMLCanvasElement; modeUsed: ImportMode; dpiX: number; dpiY: number; reason?: string; sourceWidth?: number; sourceHeight?: number; };
const defaultSettings: Settings = {
  modelPath: "",
  psm: 3,
  dpi: 300,
  ...DEFAULT_SCRIPT_DETECTION_SETTINGS,
  scriptHeightReferenceVersion: SCRIPT_HEIGHT_REFERENCE_VERSION,
};
function projectSettings(input?: Partial<Settings>): Settings {
  const legacy = input?.scriptHeightReferenceVersion !== SCRIPT_HEIGHT_REFERENCE_VERSION;
  const profile = input?.scriptHeightProfile;
  return {
    ...defaultSettings,
    ...input,
    ...(legacy ? migrateLegacyScriptSettings(input ?? {}) : {}),
    scriptHeightReferenceVersion: SCRIPT_HEIGHT_REFERENCE_VERSION,
    scriptHeightProfile: profile?.version === 1 && profile.ratios && typeof profile.ratios === "object"
      ? profile : undefined,
  };
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/** Maps the page coordinate at one viewport centre into the other viewport. */
export function synchronizePageScroll(
  source: HTMLElement,
  target: HTMLElement,
  sourcePage: HTMLElement,
  targetPage: HTMLElement,
) {
  const sourceWidth = sourcePage.clientWidth;
  const sourceHeight = sourcePage.clientHeight;
  const targetWidth = targetPage.clientWidth;
  const targetHeight = targetPage.clientHeight;
  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) return false;

  const pageX = (source.scrollLeft + source.clientWidth / 2 - sourcePage.offsetLeft) / sourceWidth;
  const pageY = (source.scrollTop + source.clientHeight / 2 - sourcePage.offsetTop) / sourceHeight;
  const nextLeft = targetPage.offsetLeft + pageX * targetWidth - target.clientWidth / 2;
  const nextTop = targetPage.offsetTop + pageY * targetHeight - target.clientHeight / 2;
  const beforeLeft = target.scrollLeft;
  const beforeTop = target.scrollTop;
  target.scrollLeft = nextLeft;
  target.scrollTop = nextTop;
  return Math.abs(target.scrollLeft - beforeLeft) >= 0.5 || Math.abs(target.scrollTop - beforeTop) >= 0.5;
}

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
      // Detection thresholds are project-owned. Spreading the defaults first
      // keeps older manifests readable as fields are added.
      settings: projectSettings(data.settings),
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
        completed: page.status === "review" && page.completed === true,
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

function PageThumbnail({ cache, page }: { cache: LogicalPageThumbnailCache | null; page: Entry }) {
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
    void cache.get(page).then(source => {
      const target = canvasRef.current;
      if (!active || !target) return;
      target.width = source.width;
      target.height = source.height;
      target.getContext("2d")?.drawImage(source, 0, 0);
    }).catch(() => {
      if (active) clear();
    });
    return () => { active = false; };
  }, [cache, page, visible]);

  return <span ref={frameRef} className="thumb" aria-hidden="true"><canvas ref={canvasRef} /></span>;
}
type LineOverlayProps = { portalTarget:HTMLElement|null; value:string; formatting:TextFormatRange[]; left:number; top:number; width:number; height:number; fontSize:number; onChange:(value:string)=>void; onCaretChange:(offset:number)=>void; onFinish:()=>void; onUndo:()=>void; onRedo:()=>void; onFormat:(start:number,end:number,kind:TextFormatKind)=>void; onOpenBulk:(selection:string,start:number,end:number)=>void; onSplit:(caret:number)=>void; textMagnifierEnabled:boolean; };
function LineOverlay({portalTarget,value,formatting,left,top,width,height,fontSize:naturalFontSize,onChange,onCaretChange,onFinish,onUndo,onRedo,onFormat,onOpenBulk,onSplit,textMagnifierEnabled}:LineOverlayProps) {
 const { t } = useTranslation(); const inputRef=useRef<HTMLTextAreaElement>(null); const mirrorRef=useRef<HTMLDivElement>(null); const toolbarRef=useRef<HTMLDivElement>(null); const magnifierRef=useRef<HTMLDivElement>(null); const [magnifierPosition,setMagnifierPosition]=useState<{left:number;top:number}|null>(null); const [magnifierFontSize,setMagnifierFontSize]=useState(naturalFontSize*2); const [selection,setSelection]=useState({start:0,end:0,caret:0}); const [ctrl,setCtrl]=useState(false);
 const selected=value.slice(selection.start,selection.end); const candidates=selected?candidatesForSelection(selected):[];
 // Keep the normal text baseline fixed while giving raised glyphs room above it.
 const extraTop=Math.min(top,Math.max(4,naturalFontSize*.45));
 const editTop=top-extraTop;
 const editHeight=height+extraTop;
 const editStyle={left,top:editTop,width,height:editHeight,paddingTop:extraTop,fontSize:naturalFontSize};
 useLayoutEffect(()=>{const input=inputRef.current;if(!input)return;input.style.fontSize=`${naturalFontSize}px`;const ratio=Math.min(1,Math.max(1,input.clientWidth-4)/Math.max(1,input.scrollWidth-4),Math.max(1,input.clientHeight-2)/Math.max(1,input.scrollHeight-2));input.style.fontSize=`${Math.max(1,naturalFontSize*(ratio<1?ratio*.98:1))}px`;setMagnifierFontSize(Math.min(36,(Number.parseFloat(input.style.fontSize)||naturalFontSize)*2));if(mirrorRef.current){mirrorRef.current.style.fontSize=input.style.fontSize;mirrorRef.current.scrollLeft=input.scrollLeft;mirrorRef.current.scrollTop=input.scrollTop;}},[height,naturalFontSize,value,width,formatting]);
 useEffect(()=>{const up=(event:KeyboardEvent)=>{if(event.key==='Control'||!event.ctrlKey)setCtrl(false)};const blur=()=>setCtrl(false);document.addEventListener('keyup',up);window.addEventListener('blur',blur);return()=>{document.removeEventListener('keyup',up);window.removeEventListener('blur',blur)}},[]);
 const capture=()=>{const input=inputRef.current;if(input){const caret=input.selectionDirection==="backward"?input.selectionStart:input.selectionEnd;setSelection({start:input.selectionStart,end:input.selectionEnd,caret});onCaretChange(caret)}};
 useEffect(()=>{const input=inputRef.current;if(!input)return;const syncSelection=()=>capture();input.addEventListener("select",syncSelection);document.addEventListener("selectionchange",syncSelection);return()=>{input.removeEventListener("select",syncSelection);document.removeEventListener("selectionchange",syncSelection)}},[]);
 useEffect(()=>{const timer=window.setTimeout(()=>{if(inputRef.current===document.activeElement)capture()},0);return()=>window.clearTimeout(timer)},[]);
 useLayoutEffect(()=>{const place=()=>{const toolbar=toolbarRef.current,stage=portalTarget;if(!toolbar||!stage)return;const rect=toolbar.getBoundingClientRect(),stageRect=stage.getBoundingClientRect();const panelWidth=Math.min(250,Math.max(120,stage.clientWidth-16));const minLeft=stageRect.left+8,maxLeft=Math.max(minLeft,stageRect.left+stage.clientWidth-panelWidth-8);const viewportLeft=Math.max(minLeft,Math.min(maxLeft,rect.left));
// Keep the 60px panel above the toolbar; near the scroll viewport top, place it below the toolbar.
const viewportTop=rect.top-stageRect.top>=70?rect.top-68:rect.bottom+8;setMagnifierPosition({left:viewportLeft-stageRect.left+stage.scrollLeft,top:viewportTop-stageRect.top+stage.scrollTop});};place();window.addEventListener("resize",place);document.addEventListener("scroll",place,true);return()=>{window.removeEventListener("resize",place);document.removeEventListener("scroll",place,true)}},[portalTarget,left,top,selection.start,selection.end,value]);

 const format=(kind:TextFormatKind)=>{if(selection.start<selection.end)onFormat(selection.start,selection.end,kind)};
 const replace=(text:string)=>{onChange(value.slice(0,selection.start)+text+value.slice(selection.end));setSelection({start:selection.start,end:selection.start+text.length,caret:selection.start+text.length});onCaretChange(selection.start+text.length)};
 return <>{formatting.length>0&&<FormattedEditMirror mirrorRef={mirrorRef} value={value} formatting={formatting} className="line-edit-mirror" style={editStyle} />}<textarea ref={inputRef} autoFocus wrap="off" className={`line-overlay ${formatting.length?"has-formatting":""}`} value={value} onChange={event=>{onChange(event.currentTarget.value);onCaretChange(event.currentTarget.selectionStart)}} onSelect={capture} onScroll={event=>{if(mirrorRef.current){mirrorRef.current.scrollLeft=event.currentTarget.scrollLeft;mirrorRef.current.scrollTop=event.currentTarget.scrollTop}}} onKeyDown={event=>{setCtrl(event.ctrlKey);const key=event.key.toLowerCase();if(event.ctrlKey&&!event.nativeEvent.isComposing&&(key==='z'||key==='y')){event.preventDefault();if(key==='y'||event.shiftKey)onRedo();else onUndo();return}if(event.key==='Escape'||(event.key==='Enter'&&!event.nativeEvent.isComposing&&event.keyCode!==229)){event.preventDefault();onFinish();return}if(event.ctrlKey&&selection.start<selection.end){const kind=key==='b'?'bold':key==='i'?'italic':event.key==='ArrowUp'?'superscript':event.key==='ArrowDown'?'subscript':null;if(kind){event.preventDefault();format(kind)}else if(/^[1-9]$/.test(key)&&candidates[Number(key)-1]){event.preventDefault();replace(candidates[Number(key)-1])}else if(key==='g'){event.preventDefault();onOpenBulk(selected,selection.start,selection.end)}}}} onKeyUp={event=>{setCtrl(event.ctrlKey);capture()}} onBlur={onFinish} style={editStyle} />
 {!selected&&<div ref={toolbarRef} className="selection-toolbar" style={{left,top:Math.max(0,editTop-48)}} onMouseDown={event=>event.preventDefault()} role="toolbar" aria-label="Line tools"><EditToolbarButton label={t("toolbar.splitLine")} onClick={()=>onSplit(selection.start)} disabled={selection.start===0||selection.start===value.length}>{t("toolbar.splitLine")}</EditToolbarButton></div>}
 {selected&&<div ref={toolbarRef} className="selection-toolbar" style={{left,top:Math.max(0,editTop-48)}} onMouseDown={event=>event.preventDefault()} role="toolbar" aria-label="Selected text tools">
  <EditToolbarButton label={t("toolbar.bold")} shortcut="B" showShortcut={ctrl} onClick={()=>format("bold")}>{t("toolbar.bold")}</EditToolbarButton>
  <EditToolbarButton label={t("toolbar.italic")} shortcut="I" showShortcut={ctrl} onClick={()=>format("italic")}>{t("toolbar.italic")}</EditToolbarButton>
  <EditToolbarButton label={t("toolbar.superscript")} shortcut="↑" showShortcut={ctrl} onClick={()=>format("superscript")}>{t("toolbar.superscript")}</EditToolbarButton>
  <EditToolbarButton label={t("toolbar.subscript")} shortcut="↓" showShortcut={ctrl} onClick={()=>format("subscript")}>{t("toolbar.subscript")}</EditToolbarButton>
  <EditToolbarButton label={t("toolbar.bulkReplace")} shortcut="G" showShortcut={ctrl} onClick={()=>onOpenBulk(selected,selection.start,selection.end)}>{t("toolbar.bulkReplace")}</EditToolbarButton>
  {candidates.map((candidate,index)=><EditToolbarButton className="text-candidate" key={candidate} label={candidate} shortcut={index<9?String(index+1):undefined} showShortcut={ctrl} onClick={()=>replace(candidate)}>{candidate}</EditToolbarButton>)}
</div>}{textMagnifierEnabled&&magnifierPosition&&portalTarget&&createPortal(<ProofingTextMagnifier ref={magnifierRef} value={value} formatting={formatting} selectionStart={selection.start} selectionEnd={selection.end} caret={selection.caret} fontSize={magnifierFontSize} style={{left:magnifierPosition.left,top:magnifierPosition.top}} />,portalTarget)}</>;
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
  const [editCaret, setEditCaret] = useState<{ lineId: string; offset: number } | null>(null);
  const [regionMode, setRegionMode] = useState<"add" | "delete" | "merge" | "order" | null>(null);
  const [regionSelection, setRegionSelection] = useState<Rect | null>(null);
  const [regionHintHidden, setRegionHintHidden] = useState(false);
  const [orderVisited, setOrderVisited] = useState<string[]>([]);
  const [orderPendingVisited, setOrderPendingVisited] = useState<string[]>([]);
  const [orderPreviewIds, setOrderPreviewIds] = useState<string[] | null>(null);
  const [orderHoverId, setOrderHoverId] = useState<string | null>(null);
  const [undoStack, renderUndoStack] = useState<HistoryOperation[]>([]);
  const [redoStack, renderRedoStack] = useState<HistoryOperation[]>([]);
  const undoStackRef = useRef<HistoryOperation[]>([]);
  const redoStackRef = useRef<HistoryOperation[]>([]);
  const persistedHistory = useRef(new HistoryPersistence<Settings, Entry>());
  const editingHistoryGroup = useRef<{ last: HistoryOperation; operation: HistoryOperation } | null>(null);
  const setUndoStack = useCallback((update: HistoryOperation[] | ((old: HistoryOperation[]) => HistoryOperation[])) => {
    const next = typeof update === "function" ? update(undoStackRef.current) : update;
    undoStackRef.current = next;
    renderUndoStack(next);
  }, []);
  const setRedoStack = useCallback((update: HistoryOperation[] | ((old: HistoryOperation[]) => HistoryOperation[])) => {
    const next = typeof update === "function" ? update(redoStackRef.current) : update;
    redoStackRef.current = next;
    renderRedoStack(next);
  }, []);
  const [zoom, setZoom] = useState(0.42);
  const [busy, setBusy] = useState<"open" | "save" | "ocr" | null>(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [notice, updateNotice] = useState<{ key: string; values?: Record<string, string | number> }>({ key: "notice.welcome" });
  const [startupWarning, setStartupWarning] = useState<{ key: string; values: { error: string } } | null>(null);
  const setNotice = useCallback((key: string, values?: Record<string, string | number>) => updateNotice({ key, values }), []);
  const setMagnifierPreference = useCallback((key: "imageMagnifierEnabled" | "textMagnifierEnabled", enabled: boolean) => {
    magnifierPreferencesTouched.current = true;
    const before = magnifierPreferencesRef.current;
    const next = { ...before, [key]: enabled };
    magnifierPreferencesRef.current = next;
    setMagnifierPreferences(next);
    const sequence = ++magnifierSaveSequence.current;
    magnifierSaveQueue.current = magnifierSaveQueue.current.catch(() => undefined).then(async () => {
      try {
        await invokeCommand("save_magnifier_preferences", next);
        persistedMagnifierPreferences.current = next;
      } catch (error) {
        if (sequence === magnifierSaveSequence.current) {
          const rollback = persistedMagnifierPreferences.current;
          magnifierPreferencesRef.current = rollback;
          setMagnifierPreferences(rollback);
          setNotice("notices.magnifierSaveFailed", { error: errorText(error) });
        }
      }
    });
  }, [setNotice]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [magnifierPreferences, setMagnifierPreferences] = useState({ imageMagnifierEnabled: true, textMagnifierEnabled: true });
  const magnifierPreferencesRef = useRef(magnifierPreferences);
  const persistedMagnifierPreferences = useRef(magnifierPreferences);
  const magnifierSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const magnifierSaveSequence = useRef(0);
  const magnifierPreferencesTouched = useRef(false);

  const [bulkReplace, setBulkReplace] = useState<{ search: string; initialMatch?: BulkMatch } | null>(null);
  const [scriptCalibrationOpen, setScriptCalibrationOpen] = useState(false);
  const [scriptCalibrationCandidates, setScriptCalibrationCandidates] = useState<ScriptCalibrationCandidate[]>([]);
  const [scriptCalibrationLoading, setScriptCalibrationLoading] = useState(false);
  const [scriptCalibrationProgress, setScriptCalibrationProgress] = useState<ScriptCalibrationProgress | null>(null);
  const [importSource, setImportSource] = useState<{
    path: string;
    pdf: PDFDocumentProxy;
  } | null>(null);
  const [importCreating, setImportCreating] = useState(false);
  const [confirmOcr, setConfirmOcr] = useState<"current" | "all" | null>(null);
  const [exportScope, setExportScope] = useState<"current" | "all">("all");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfPageRef = useRef<HTMLDivElement>(null);
  const regionHintRef = useRef<HTMLDivElement>(null);
  const suppressLayoutClick = useRef(false);
  const orderVisitedRef = useRef<string[]>([]);
  const orderDrag = useRef<{ pointerId: number; page: DocumentPage; last: Point; clientX: number; clientY: number; ids: string[]; priorVisited: string[]; visits: string[] } | null>(null);
  const regionDrag = useRef<{ pointerId: number; x: number; y: number; clientX: number; clientY: number } | null>(null);
  const regionScrollTimer = useRef<number | null>(null);
  const pdfStageRef = useRef<HTMLDivElement>(null);
  const ocrStageRef = useRef<HTMLDivElement>(null);
  const layoutCardRef = useRef<HTMLDivElement>(null);
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
    scriptSnippetCanvases = useRef(new Map<string, Promise<HTMLCanvasElement | null>>()),
    scriptCandidateLines = useRef(new Map<string, OcrLine>()),
    scriptCandidateHeights = useRef(new Map<string, number>()),
    scriptHeightProfileRef = useRef<{ projectPath: string; profile: ScriptHeightProfile } | null>(null),
    scriptCandidatePool = useRef<ScriptCalibrationCandidate[]>([]),
    scriptCandidateBuckets = useRef<ScriptCalibrationCandidate[][]>([[], [], []]),
    scriptScanGeneration = useRef(0),
    lineEditSession = useRef<LineEditSession | null>(null),
    nextLineEditSession = useRef(0),
    finishLineEditRef = useRef<(lineId?: string) => void>(() => undefined),
    historyApplying = useRef(false),
    lastProjectWrite = useRef<Promise<void>>(Promise.resolve()),
    restorationStarted = useRef(false),
    restorationGeneration = useRef(0),
    scrollSyncTarget = useRef<"pdf" | "ocr" | null>(null),
    lastScrolledPane = useRef<"pdf" | "ocr">("pdf");
  const current = manifest.pages[index] ?? null;
  const [thumbnailCacheState, setThumbnailCacheState] = useState<{ pdf: PDFDocumentProxy; cache: LogicalPageThumbnailCache } | null>(null);
  // Create the cache in an effect. React StrictMode intentionally tears down
  // and recreates effects in development, so a useMemo-owned cache would be
  // disposed before its second effect setup could use it.
  useEffect(() => {
    if (!pdf) {
      setThumbnailCacheState(null);
      return;
    }
    const cache = new LogicalPageThumbnailCache(pdf);
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
  const saveLastOpenedProject = useCallback((info: ProjectInfo, pageId: string) => {
    if (!isTauri) return;
    const write = lastProjectWrite.current
      .catch(() => undefined)
      .then(() => invokeCommand("save_last_opened_project", { projectPath: info.path, pageId }));
    lastProjectWrite.current = write;
    void write.catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!project || !current) return;
    saveLastOpenedProject(project, current.id);
  }, [current?.id, project, saveLastOpenedProject]);
  const clearCompletion = useCallback(async (pageIds: string[]) => {
    const protectedIds = new Set(pageIds.filter(id => manifestRef.current.pages.some(page => page.id === id && page.completed)));
    if (!protectedIds.size) return true;
    if (!window.confirm(t("ui.editCompletedConfirm"))) return false;
    const previous = manifestRef.current;
    const next = { ...previous, pages: previous.pages.map(page => protectedIds.has(page.id) ? { ...page, completed: false } : page) };
    putManifest(next);
    const info = projectRef.current;
    try {
      if (isTauri && info) await writeQueue.current.enqueue(() => invokeCommand("save_manifest", { projectPath: info.path, manifest: JSON.stringify(copy(next)) }));
      return true;
    } catch (error) {
      putManifest(previous);
      setNotice("notices.saveFailed", { error: errorText(error) });
      return false;
    }
  }, [putManifest, setNotice, t]);
  const persistState = useCallback(async (projectPath: string, savedManifest: string, updates: ProjectPageUpdate[], undo: HistoryOperation[], redo: HistoryOperation[]) => {
    const store = persistedHistory.current;
    const captured = store.capture(undo, redo);
    let retained = { order: captured.order, cursor: captured.cursor };
    await writeQueue.current.enqueue(async () => {
      retained = await invokeCommand("save_project_state", { projectPath, manifest: savedManifest, updates, history: store.pending(captured) });
      store.confirm(retained.order);
    });
    const byId = new Map(captured.order.map((id, index) => [id, captured.operations[index]]));
    const operations = retained.order.map(id => byId.get(id)!);
    return { undo: operations.slice(0, retained.cursor), redo: operations.slice(retained.cursor) };
  }, []);
  const commitHistoryOperation = useCallback(async (projectPath: string, updates: ProjectPageUpdate[], operation: HistoryOperation, nextManifest = manifestRef.current) => {
    const undo = [...undoStackRef.current.slice(-99), operation];
    const retained = await persistState(projectPath, JSON.stringify(copy(nextManifest)), updates, undo, []);
    setUndoStack(retained.undo);
    setRedoStack(retained.redo);
  }, [persistState, setUndoStack, setRedoStack]);
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
    const undo = undoStackRef.current, redo = redoStackRef.current;
    const session = lineEditSession.current;
    const last = undo.at(-1);
    let savedUndo = undo;
    let groupStart = undo.length;
    // Autosaving must not fill the retained history with individual keystrokes.
    // The live editor still keeps its incremental undo until the edit is finished.
    if (session && data && redo.length === 0 && last?.lineEditSessionId === session.id) {
      let start = undo.length;
      while (start > 0 && undo[start - 1].lineEditSessionId === session.id) start--;
      groupStart = start;
      if (editingHistoryGroup.current?.last !== last) editingHistoryGroup.current = {
        last, operation: { targetPageId: pageId, changes: [compactChange({ pageId, beforeData: session.beforeData, afterData: data })] },
      };
      savedUndo = [...undo.slice(0, start), editingHistoryGroup.current.operation];
    }
    const retained = await persistState(projectPath, savedManifest, data ? [{ pageId, data }] : [], savedUndo, redo);
    const liveUndo = savedUndo === undo ? retained.undo : [
      ...retained.undo.filter(operation => operation !== editingHistoryGroup.current?.operation), ...undo.slice(groupStart),
    ];
    if (undoStackRef.current === undo && redoStackRef.current === redo &&
        (liveUndo.length !== undo.length || retained.redo.length !== redo.length)) {
      setUndoStack(liveUndo);
      setRedoStack(retained.redo);
    }
  }, [persistState, setUndoStack, setRedoStack]);
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
    async (info: ProjectInfo, savedPageId?: string, quiet = false) => {
      if (working.current) return;
      working.current = true;
      setBusy("open");
      let existing: Manifest;
      try {
        existing = parseManifest(info.manifest);
      } catch (e) {
        if (!quiet) setNotice("notices.genericError", { error: errorText(e) });
        setBusy(null);
        working.current = false;
        return;
      }
      if (!existing.settings.modelPath)
        existing.settings.modelPath = environmentModel.current;
      try {
        const opened = await openProjectPdf(info.path, info.pdfSize);
        const historyStore = new HistoryPersistence<Settings, Entry>();
        const restoredHistory = await (async () => {
          try {
            return historyStore.restore(await invokeCommand("load_edit_history", { projectPath: info.path }));
          } catch (error) {
            await opened.destroy();
            throw error;
          }
        })();
        const oldPdf = pdf;
        setPdf(null);
        if (oldPdf) await oldPdf.destroy();
        putProject(info);
        persistedHistory.current = historyStore;
        editingHistoryGroup.current = null;
        bulkSnippetCanvases.current.clear();
        lineEditSession.current = null;
        setEditing(null);
        setUndoStack(restoredHistory.undo);
        setRedoStack(restoredHistory.redo);
        putManifest(existing);
        const savedIndex = existing.pages.findIndex((page) => page.id === savedPageId);
        putIndex(savedIndex >= 0 ? savedIndex : 0);
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
        if (!quiet) setNotice("notices.opened", { name: info.name });
      } catch (e) {
        if (!quiet) setNotice("notices.pdfLoadFailed", { error: errorText(e) });
      } finally {
        setBusy(null);
        working.current = false;
      }
    },
    [pdf, putDoc, putIndex, putManifest, putProject, setUndoStack, setRedoStack],
  );
  useEffect(() => {
    if (!isTauri || restorationStarted.current) return;
    restorationStarted.current = true;
    const generation = restorationGeneration.current;
    void invokeCommand("get_user_preferences")
      .then(async (preferences) => {
        if (!magnifierPreferencesTouched.current) {
          const loaded = { imageMagnifierEnabled: preferences.imageMagnifierEnabled ?? true, textMagnifierEnabled: preferences.textMagnifierEnabled ?? true };
          magnifierPreferencesRef.current = loaded;
          persistedMagnifierPreferences.current = loaded;
          setMagnifierPreferences(loaded);
        }
        const lastProject = preferences.lastProject;
        if (!lastProject?.path || !lastProject.pageId || working.current || generation !== restorationGeneration.current) return;
        try {
          const info = await invokeCommand("open_project", { projectPath: lastProject.path });
          if (generation !== restorationGeneration.current || working.current) return;
          await openInfo(info, lastProject.pageId, true);
        } catch {
          // A moved, deleted, or damaged project must not block application startup.
        }
      })
      .catch(() => undefined);
  }, [openInfo]);
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
    restorationGeneration.current += 1;
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
        await flush();
        const info = await invokeCommand("create_project", {
          pdfPath: importSource.path,
          projectPath,
          manifest: JSON.stringify(next),
          overwriteExisting: true,
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
    [flush, importSource, openInfo],
  );
  const openProject = useCallback(async () => {
    if (working.current || importActive.current) return;
    restorationGeneration.current += 1;
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
    const hadSessionHistory = [...undoStackRef.current, ...redoStackRef.current].some(operation => operation.lineEditSessionId === session.id);
    lineEditSession.current = null;
    setUndoStack((old) => {
      let start = old.length;
      while (start > 0 && old[start - 1].lineEditSessionId === session.id) start -= 1;
      const stable = old.slice(0, start);
      const afterData = JSON.stringify(docRef.current);
      if (session.beforeData === afterData) return stable.slice(-100);
      return [...stable.slice(-99), {
        targetPageId: session.pageId,
        changes: [compactChange({ pageId: session.pageId, beforeData: session.beforeData, afterData })],
      }];
    });
    setRedoStack((old) => old.filter((operation) => operation.lineEditSessionId !== session.id));
    setEditing((current) => current === session.lineId ? null : current);
    if (hadSessionHistory) scheduleSave();
  }, [scheduleSave, setUndoStack, setRedoStack]);
  finishLineEditRef.current = finishLineEdit;
  const beginLineEdit = useCallback(async (lineId: string) => {
    finishLineEditRef.current();
    const pageId = manifestRef.current.pages[indexRef.current]?.id;
    if (!pageId) return;
    const before = docRef.current;
    if (!before) return;
    if (!await clearCompletion([pageId])) return;
    lineEditSession.current = { id: ++nextLineEditSession.current, pageId, lineId, beforeData: JSON.stringify(before) };
    setSelected(lineId);
    setEditing(lineId);
  }, [clearCompletion]);
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
        changes: [compactChange({ pageId: session.pageId, beforeData: JSON.stringify(before), afterData: JSON.stringify(after) })],
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
    const updates: ProjectPageUpdate[] = [];
    for (const change of operation.changes) {
      const current = await invokeCommand("load_page", { projectPath: projectInfo.path, pageId: change.pageId });
      updates.push(historyPageUpdate(change, current, reverse));
    }
    const operationSettings = reverse ? operation.beforeSettings : operation.afterSettings;
    const operationEntry = reverse ? operation.beforeEntry : operation.afterEntry;
    const next = { ...manifestRef.current,
      settings: operationSettings ? copy(operationSettings) : manifestRef.current.settings,
      pages: operationEntry ? manifestRef.current.pages.map(entry => entry.id === operationEntry.id ? copy(operationEntry) : entry) : manifestRef.current.pages,
    };
    const undo = reverse ? undoStackRef.current.slice(0, -1) : [...undoStackRef.current, operation].slice(-100);
    const redo = reverse ? [operation, ...redoStackRef.current].slice(0, 100) : redoStackRef.current.slice(1);
    const retained = await persistState(projectInfo.path, JSON.stringify(copy(next)), updates, undo, redo);
    setUndoStack(retained.undo);
    setRedoStack(retained.redo);
    if (operationSettings || operationEntry) putManifest(next);
    const target = manifestRef.current.pages.findIndex((page) => page.id === operation.targetPageId);
    if (target < 0) return;
    const targetChange = updates.find((change) => change.pageId === operation.targetPageId);
    if (target === indexRef.current && targetChange) {
      documentLoading.current++;
      putDoc(targetChange.data === null ? null : JSON.parse(targetChange.data) as DocumentPage);
    }
    else putIndex(target);
    orderVisitedRef.current = []; setOrderVisited([]); setOrderPendingVisited([]); setOrderPreviewIds(null);
  }, [flush, persistState, putDoc, putIndex, putManifest, setUndoStack, setRedoStack]);
  const undo = useCallback(async () => {
    if (working.current || importActive.current || historyApplying.current) return;
    const operation = undoStack.at(-1);
    const session = lineEditSession.current;
    if (session && (!operation || operation.lineEditSessionId !== session.id)) {
      finishLineEditRef.current();
      return;
    }
    if (!operation) return;
    if (!await clearCompletion(operation.changes.map(change => change.pageId))) return;
    historyApplying.current = true;
    setBusy("save");
    try {
      await applyHistory(operation, true);
    } catch (error) { setNotice("notices.saveFailed", { error: errorText(error) }); }
    finally { historyApplying.current = false; setBusy(null); }
  }, [applyHistory, clearCompletion, undoStack, setNotice]);
  const redo = useCallback(async () => {
    if (working.current || importActive.current || historyApplying.current) return;
    const operation = redoStack[0];
    const session = lineEditSession.current;
    if (session && (!operation || operation.lineEditSessionId !== session.id)) {
      finishLineEditRef.current();
      return;
    }
    if (!operation) return;
    if (!await clearCompletion(operation.changes.map(change => change.pageId))) return;
    historyApplying.current = true;
    setBusy("save");
    try {
      await applyHistory(operation, false);
    } catch (error) { setNotice("notices.saveFailed", { error: errorText(error) }); }
    finally { historyApplying.current = false; setBusy(null); }
  }, [applyHistory, clearCompletion, redoStack, setNotice]);
  const save = useCallback(async () => {
    if (!projectRef.current || busy || working.current || importActive.current || historyApplying.current) return;
    setBusy("save");
    try {
      await flush();
      setNotice("notices.saved");
    } catch (error) {
      setNotice("notices.saveFailed", { error: errorText(error) });
    } finally {
      setBusy(null);
    }
  }, [busy, flush, setNotice]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
      const key = event.key.toLowerCase();
      if (key !== "s" && key !== "z" && key !== "y") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      // Other inputs keep their own text undo; the line editor already handles history.
      if (key !== "s" && target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
      event.preventDefault();
      if (event.repeat || busy || document.querySelector(".modal")) return;
      if (key === "s") {
        if (!event.shiftKey) void save();
      } else if (key === "y" || event.shiftKey) {
        void redo();
      } else {
        void undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, redo, save, undo]);
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
      let detected = applyScriptDetection(parsed, manifestRef.current.settings, manifestRef.current.settings.scriptHeightProfile);
      try {
        detected = await inferWordStyles(detected, canvasToBase64(worker), worker.width, worker.height,
          (imageBase64, samples) => invokeCommand("classify_word_styles", { imageBase64, samples }));      } catch (error) {
        console.warn("Word style classification was skipped.", error);
      }
      return {
        ...detected,
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
          : manifestRef.current.pages.filter((p) => p.status !== "review" && !p.completed);
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
            data = JSON.stringify(result);
          const beforeData = await invokeCommand("load_page", { projectPath: path, pageId: entry.id });
          await commitHistoryOperation(path, [{ pageId: entry.id, ...(beforeData === null ? { expectedMissing: true } : { expectedData: beforeData }), data }], {
            targetPageId: entry.id, changes: [{ pageId: entry.id, beforeData, afterData: data }],
            beforeEntry: copy(entry), afterEntry: copy(next.pages.find(page => page.id === entry.id)!),
          }, next);
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
    [commitHistoryOperation, flush, putDoc, putManifest, recognize, renderEntry, setNotice],
  );
  const askOcr = useCallback(
    async (scope: "current" | "all") => {
      if (importActive.current) return;
      const active = manifestRef.current.pages[indexRef.current];
      const hasManualCorrections = scope === "current" && Boolean(docRef.current && (
        (docRef.current.manualOcrRegions?.length ?? 0) > 0 ||
        (docRef.current.deletedOcrLineIds?.length ?? 0) > 0 ||
        Boolean(docRef.current.manualReadingOrder) ||
        allLines(docRef.current).some(line => line.scriptDetectionManuallyEdited) ||
        allLines(docRef.current).some(line =>
          line.correctedText !== line.originalText ||
          Boolean(line.formatting?.length) ||
          line.id.includes("--split"))
      ));
      // Keep the existing destructive-OCR confirmation when corrections exist.
      // Its approval handler clears completion immediately before OCR starts.
      if (scope === "current" && active?.completed && !hasManualCorrections) {
        if (!await clearCompletion([active.id])) return;
        void runOcr(scope);
        return;
      }
      if (hasManualCorrections) setConfirmOcr(scope);
      else runOcr(scope);
    },
    [clearCompletion, runOcr],
  );
  const cancelOcr = useCallback(() => {
    cancelled.current = true;
    invokeCommand("cancel_ocr").catch(() => undefined);
  }, []);
  const addSelectedRegion = useCallback(async (selection: Rect) => {
    const entry = manifestRef.current.pages[indexRef.current];
    const source = canvasRef.current;
    const beforePage = docRef.current;
    const info = projectRef.current;
    if (!entry || entry.status !== "review" || !source || !beforePage || !info || working.current || importActive.current) return;
    working.current = true;
    cancelled.current = false;
    setBusy("ocr");
    try {
      await flush();
      const padding = 20;
      const input = prepareRegionOcrImage(source, selection, beforePage, padding);
      const dpiX = entry.sourceDpiX ?? entry.dpi ?? manifestRef.current.settings.dpi;
      const dpiY = entry.sourceDpiY ?? entry.dpi ?? manifestRef.current.settings.dpi;
      const dpi = Math.max(70, Math.min(2400, Math.round(Math.sqrt(dpiX * dpiY))));
      const imageBase64 = canvasToBase64(input);
      const ocrArgs = {
        imageBase64,
        modelPath: manifestRef.current.settings.modelPath,
        dpi,
      };
      const regionId = entry.id + "--manual-" + crypto.randomUUID();
      let psm: 11 | 6 = 11;
      const recognize = async (mode: 11 | 6) => {
        if (cancelled.current) throw new Error(globalT("appErrors.ocrCancelled"));
        const hocr = await invokeCommand("run_ocr", { ...ocrArgs, psm: mode });
        if (cancelled.current) throw new Error(globalT("appErrors.ocrCancelled"));
        const page = parseHocr(hocr, { sourcePage: entry.sourcePage, pageId: regionId })[0];
        if (!page) throw new Error(globalT("appErrors.hocrMissingPage"));
        return page;
      };
      let recognized = await recognize(psm);
      // Sparse-text segmentation can overlook isolated digits in a column.
      if (!allLines(recognized).some(line => line.words.some(word => word.originalText.trim()))) {
        psm = 6;
        recognized = await recognize(psm);
      }
      recognized = applyScriptDetection(recognized, manifestRef.current.settings, manifestRef.current.settings.scriptHeightProfile);
      try {
        recognized = await inferWordStyles(recognized, canvasToBase64(input), input.width, input.height,
          (imageBase64, samples) => invokeCommand("classify_word_styles", { imageBase64, samples }));      } catch (error) {
        console.warn("Word style classification was skipped for the added OCR region.", error);
      }
      const result = addOcrRegion(beforePage, recognized, selection, padding, regionId, psm);
      if (!result.addedWords) {
        setNotice("notices.regionEmpty");
        setRegionMode("add");
        return;
      }
      const beforeData = JSON.stringify(copy(beforePage));
      const afterData = JSON.stringify(copy(result.page));
      await commitHistoryOperation(info.path, [{ pageId: entry.id, expectedData: beforeData, data: afterData }], {
        targetPageId: entry.id, changes: [{ pageId: entry.id, beforeData, afterData }],
      });
      putDoc(result.page);
      setNotice("notices.regionAdded", { count: result.addedLines });
    } catch (error) {
      setNotice(cancelled.current ? "notices.ocrCancelled" : "notices.ocrFailed", cancelled.current ? undefined : { error: errorText(error) });
      setRegionMode("add");
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, [commitHistoryOperation, flush, putDoc, setNotice]);
  const deleteSelectedRegion = useCallback(async (selection: Rect | { x: number; y: number }) => {
    const entry = manifestRef.current.pages[indexRef.current];
    const beforePage = docRef.current;
    const info = projectRef.current;
    if (!entry || entry.status !== "review" || !beforePage || !info || working.current || importActive.current) return;
    const result = "x" in selection ? removeOcrLineAtPoint(beforePage, selection.x, selection.y) : removeOcrLinesInRegion(beforePage, selection);
    if (!result.removedLines) { setNotice("notices.regionDeleteEmpty"); setRegionMode("delete"); return; }
    working.current = true;
    setBusy("save");
    try {
      await flush();
      const beforeData = JSON.stringify(copy(beforePage));
      const afterData = JSON.stringify(copy(result.page));
      await commitHistoryOperation(info.path, [{ pageId: entry.id, expectedData: beforeData, data: afterData }], {
        targetPageId: entry.id, changes: [{ pageId: entry.id, beforeData, afterData }],
      });
      putDoc(result.page);
      setNotice("notices.regionDeleted", { count: result.removedLines });
    } catch (error) {
      setNotice("notices.saveFailed", { error: errorText(error) });
      setRegionMode("delete");
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, [commitHistoryOperation, flush, putDoc, setNotice]);
  const mergeSelectedRegion = useCallback(async (selection: Rect) => {
    const entry = manifestRef.current.pages[indexRef.current];
    const beforePage = docRef.current;
    const info = projectRef.current;
    if (!entry || entry.status !== "review" || !beforePage || !info || working.current || importActive.current) return;
    const result = mergeOcrLinesInRegion(beforePage, selection);
    if (!result.mergedLines) {
      setNotice("notices.regionMergeUnavailable", { reason: globalT(`notices.mergeReason.${result.reason ?? "tooFew"}`) });
      setRegionMode("merge");
      return;
    }
    working.current = true;
    setBusy("save");
    try {
      await flush();
      const beforeData = JSON.stringify(copy(beforePage));
      const afterData = JSON.stringify(copy(result.page));
      await commitHistoryOperation(info.path, [{ pageId: entry.id, expectedData: beforeData, data: afterData }], {
        targetPageId: entry.id, changes: [{ pageId: entry.id, beforeData, afterData }],
      });
      putDoc(result.page);
      setNotice("notices.regionMerged", { count: result.mergedLines });
    } catch (error) {
      setNotice("notices.saveFailed", { error: errorText(error) });
      setRegionMode("merge");
    } finally {
      working.current = false;
      setBusy(null);
    }
  }, [commitHistoryOperation, flush, putDoc, setNotice]);
  const clientToRegionPage = useCallback((clientX: number, clientY: number) => {
    const target = regionMode === "add" ? canvasRef.current : layoutCardRef.current;
    if (!target || !canvasSize.width || !canvasSize.height) return null;
    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: Math.max(0, Math.min(canvasSize.width, (clientX - bounds.left) * canvasSize.width / bounds.width)),
      y: Math.max(0, Math.min(canvasSize.height, (clientY - bounds.top) * canvasSize.height / bounds.height)),
    };
  }, [canvasSize.height, canvasSize.width, regionMode]);
  const stopRegionScroll = useCallback(() => {
    if (regionScrollTimer.current !== null) window.clearInterval(regionScrollTimer.current);
    regionScrollTimer.current = null;
  }, []);
  const onRegionPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionMode || event.button !== 0 || busy ||
      (regionMode === "add" && event.currentTarget !== pdfPageRef.current) ||
      (regionMode !== "add" && event.currentTarget !== layoutCardRef.current)) return;
    const point = clientToRegionPage(event.clientX, event.clientY);
    if (!point || point.x <= 0 || point.x >= canvasSize.width || point.y <= 0 || point.y >= canvasSize.height) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    regionDrag.current = { pointerId: event.pointerId, x: point.x, y: point.y, clientX: event.clientX, clientY: event.clientY };
    setRegionSelection({ left: point.x, top: point.y, right: point.x, bottom: point.y });
    stopRegionScroll();
    regionScrollTimer.current = window.setInterval(() => {
      const drag = regionDrag.current, stage = regionMode === "add" ? pdfStageRef.current : ocrStageRef.current;
      if (!drag || !stage) return;
      const bounds = stage.getBoundingClientRect();
      const edge = 28;
      const dx = drag.clientX < bounds.left + edge ? -14 : drag.clientX > bounds.right - edge ? 14 : 0;
      const dy = drag.clientY < bounds.top + edge ? -14 : drag.clientY > bounds.bottom - edge ? 14 : 0;
      if (!dx && !dy) return;
      const oldLeft = stage.scrollLeft, oldTop = stage.scrollTop;
      stage.scrollLeft += dx; stage.scrollTop += dy;
      if (oldLeft === stage.scrollLeft && oldTop === stage.scrollTop) return;
      const current = clientToRegionPage(drag.clientX, drag.clientY);
      if (current) setRegionSelection({ left: Math.min(drag.x, current.x), top: Math.min(drag.y, current.y),
        right: Math.max(drag.x, current.x), bottom: Math.max(drag.y, current.y) });
    }, 30);
  }, [busy, canvasSize.height, canvasSize.width, clientToRegionPage, regionMode, stopRegionScroll]);
  const onRegionPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = regionDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.clientX = event.clientX; drag.clientY = event.clientY;
    const point = clientToRegionPage(event.clientX, event.clientY);
    if (!point) return;
    setRegionSelection({ left: Math.min(drag.x, point.x), top: Math.min(drag.y, point.y),
      right: Math.max(drag.x, point.x), bottom: Math.max(drag.y, point.y) });
  }, [clientToRegionPage]);
  const onRegionPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = regionDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    regionDrag.current = null;
    stopRegionScroll();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const point = clientToRegionPage(event.clientX, event.clientY);
    setRegionSelection(null);
    if (!point) return;
    const selection: Rect = {
      left: Math.floor(Math.min(drag.x, point.x)), top: Math.floor(Math.min(drag.y, point.y)),
      right: Math.ceil(Math.max(drag.x, point.x)), bottom: Math.ceil(Math.max(drag.y, point.y)),
    };
    const isClick = Math.abs(drag.x - point.x) < 4 && Math.abs(drag.y - point.y) < 4;
    if (regionMode === "delete") {
      suppressLayoutClick.current = true;
      window.setTimeout(() => { suppressLayoutClick.current = false; }, 0);
      setRegionMode(null);
      if (isClick) void deleteSelectedRegion({ x: point.x, y: point.y });
      else if (selection.right - selection.left >= 4 && selection.bottom - selection.top >= 4) void deleteSelectedRegion(selection);
      else setNotice("notices.regionTooSmall");
      return;
    }
    if (regionMode === "merge") {
      suppressLayoutClick.current = true;
      window.setTimeout(() => { suppressLayoutClick.current = false; }, 0);
      if (selection.right - selection.left < 4 || selection.bottom - selection.top < 4) {
        setNotice("notices.regionMergeUnavailable", { reason: globalT("notices.mergeReason.tooFew") });
        return;
      }
      setRegionMode(null);
      void mergeSelectedRegion(selection);
      return;
    }
    if (selection.right - selection.left < 4 || selection.bottom - selection.top < 4) {
      setNotice("notices.regionTooSmall");
      return;
    }
    setRegionMode(null);
    void addSelectedRegion(selection);
  }, [addSelectedRegion, clientToRegionPage, deleteSelectedRegion, mergeSelectedRegion, regionMode, setNotice, stopRegionScroll]);
  const extendReadingOrder = useCallback((drag: NonNullable<typeof orderDrag.current>, point: Point) => {
    const previous = drag.last;
    drag.last = point;
    const already = new Set([...drag.priorVisited, ...drag.visits]);
    let changed = false;
    for (const id of lineIdsCrossed(allLines(drag.page), previous, point)) {
      if (already.has(id)) continue;
      const anchor = drag.visits.at(-1) ?? drag.priorVisited.at(-1);
      if (anchor) drag.ids = moveLineAfter(drag.ids, anchor, id);
      drag.visits.push(id);
      already.add(id);
      changed = true;
    }
    if (changed) {
      setOrderPendingVisited(drag.visits.slice());
      setOrderPreviewIds(drag.ids.slice());
    }
  }, []);
  const onOrderPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (regionMode !== "order" || event.button !== 0 || busy || working.current || !docRef.current) return;
    const point = clientToRegionPage(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const page = docRef.current;
    const drag = { pointerId: event.pointerId, page, last: point,
      clientX: event.clientX, clientY: event.clientY,
      ids: allLines(page).map(line => line.id), priorVisited: orderVisitedRef.current.slice(), visits: [] as string[] };
    orderDrag.current = drag;
    extendReadingOrder(drag, point);
    stopRegionScroll();
    regionScrollTimer.current = window.setInterval(() => {
      const active = orderDrag.current, stage = ocrStageRef.current;
      if (!active || !stage) return;
      const bounds = stage.getBoundingClientRect();
      const edge = 28;
      const dx = active.clientX < bounds.left + edge ? -14 : active.clientX > bounds.right - edge ? 14 : 0;
      const dy = active.clientY < bounds.top + edge ? -14 : active.clientY > bounds.bottom - edge ? 14 : 0;
      if (!dx && !dy) return;
      const oldLeft = stage.scrollLeft, oldTop = stage.scrollTop;
      stage.scrollLeft += dx; stage.scrollTop += dy;
      if (oldLeft === stage.scrollLeft && oldTop === stage.scrollTop) return;
      const next = clientToRegionPage(active.clientX, active.clientY);
      if (next) extendReadingOrder(active, next);
    }, 30);
  }, [busy, clientToRegionPage, extendReadingOrder, regionMode, stopRegionScroll]);
  const onOrderPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (regionMode !== "order") return;
    const point = clientToRegionPage(event.clientX, event.clientY);
    if (!point) return;
    const drag = orderDrag.current;
    if (drag && drag.pointerId === event.pointerId) {
      drag.clientX = event.clientX; drag.clientY = event.clientY;
      extendReadingOrder(drag, point);
    } else if (!drag && docRef.current) {
      setOrderHoverId(lineIdsCrossed(allLines(docRef.current), point, point)[0] ?? null);
    }
  }, [clientToRegionPage, extendReadingOrder, regionMode]);
  const onOrderPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = orderDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = clientToRegionPage(event.clientX, event.clientY);
    if (point) extendReadingOrder(drag, point);
    orderDrag.current = null;
    stopRegionScroll();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    suppressLayoutClick.current = true;
    window.setTimeout(() => { suppressLayoutClick.current = false; }, 0);
    if (!drag.visits.length) { setOrderPendingVisited([]); setOrderPreviewIds(null); return; }
    const visited = [...drag.priorVisited, ...drag.visits];
    const oldIds = allLines(drag.page).map(line => line.id);
    if (drag.ids.every((id, index) => id === oldIds[index])) {
      orderVisitedRef.current = visited; setOrderVisited(visited); setOrderPendingVisited([]); setOrderPreviewIds(null);
      return;
    }
    const entry = manifestRef.current.pages[indexRef.current];
    const info = projectRef.current;
    if (!entry || entry.id !== drag.page.id || !info || working.current) { setOrderPendingVisited([]); setOrderPreviewIds(null); return; }
    working.current = true;
    setBusy("save");
    void (async () => {
      try {
        await flush();
        const next = reorderPageLines(drag.page, drag.ids);
        const beforeData = JSON.stringify(copy(drag.page)), afterData = JSON.stringify(copy(next));
        await commitHistoryOperation(info.path, [{ pageId: entry.id, expectedData: beforeData, data: afterData }], {
          targetPageId: entry.id, changes: [{ pageId: entry.id, beforeData, afterData }],
        });
        putDoc(next);
        orderVisitedRef.current = visited; setOrderVisited(visited);
        setNotice("notices.readingOrderUpdated");
      } catch (error) {
        setNotice("notices.saveFailed", { error: errorText(error) });
      } finally {
        setOrderPendingVisited([]);
        setOrderPreviewIds(null);
        working.current = false;
        setBusy(null);
      }
    })();
  }, [clientToRegionPage, commitHistoryOperation, extendReadingOrder, flush, putDoc, setNotice, stopRegionScroll]);
  const onOrderPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (orderDrag.current?.pointerId !== event.pointerId) return;
    orderDrag.current = null;
    stopRegionScroll();
    setOrderPendingVisited([]);
    setOrderPreviewIds(null);
  }, [stopRegionScroll]);
  const exportFile = useCallback(
    async (type: "txt" | "hocr" | "html" | "svg", scope: "current" | "all" = "all") => {
      if (!projectRef.current || working.current || importActive.current)
        return;
      try {
        working.current = true;
        setBusy("save");
        await flush();
        const pages: DocumentPage[] = [];
        const labeledPages: { page: DocumentPage; label: string }[] = [];
        const entries =
          scope === "current"
            ? [manifestRef.current.pages[indexRef.current]]
            : manifestRef.current.pages;
        for (const entry of entries) {
          const saved = await invokeCommand("load_page", {
            projectPath: projectRef.current.path,
            pageId: entry.id,
          });
          if (saved) {
            const page = JSON.parse(saved) as DocumentPage;
            pages.push(page);
            labeledPages.push({ page, label: entry.label });
          }
        }
        if (!pages.length)
          throw new Error(globalT("appErrors.noExport"));
        let content = "",
          suffix = type === "txt" ? "txt" : type === "hocr" ? "html" : type === "html" ? "readable.html" : "svg",
          readyBase64 = false;
        if (type === "txt") content = exportText(pages);
        else if (type === "hocr") content = exportHocr(pages);
        else if (type === "html") content = createReadableHtml(projectRef.current.name.replace(/\.eduba$/i, ""), labeledPages, await loadReadableFontFaces(), notoSerifLicense);
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
          filters: [{ name: suffix.toUpperCase(), extensions: [suffix.endsWith(".html") ? "html" : suffix] }],
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
          await lastProjectWrite.current.catch(() => undefined);
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
  const openBulkReplace = useCallback(async (search: string, lineId: string, selectionStart: number) => {
    if (!project || working.current || importActive.current || !search) return;
    try {
      const page = docRef.current;
      const line = page && allLines(page).find(candidate => candidate.id === lineId);
      let initialMatch: BulkMatch | undefined;
      if (page && line) {
        let cursor = 0, ordinal = 0;
        while (cursor <= selectionStart) {
          const start = line.correctedText.indexOf(search, cursor);
          if (start < 0 || start > selectionStart) break;
          if (start === selectionStart) {
            initialMatch = { pageId: page.id, pageLabel: manifestRef.current.pages.find(entry => entry.id === page.id)?.label ?? "", lineId, lineText: line.correctedText, matchOrdinal: ordinal };
            break;
          }
          cursor = start + search.length;
          ordinal++;
        }
      }
      finishLineEditRef.current();
      await flush();
      bulkSnippetCanvases.current.clear();
      setBulkReplace({ search, initialMatch });
    } catch (error) {
      setNotice("notices.saveFailed", { error: errorText(error) });
    }
  }, [flush, project, setNotice]);
  const getBulkSnippet = useCallback(async (match: BulkMatch) => {
    const bbox = match.matchBBox;
    if (!pdf || !bbox) return null;
    const entry = manifestRef.current.pages.find((candidate) => candidate.id === match.pageId);
    if (!entry) return null;
    let sourcePromise = bulkSnippetCanvases.current.get(match.pageId);
    if (!sourcePromise) {
      sourcePromise = (async () => {
        const target = document.createElement("canvas");
        const rendered = await renderEntry(entry, loading.current, pdf, target, false);
        return rendered?.canvas ?? null;
      })();
      // Search result pagination can touch many pages. Keep only recent full-page
      // renders; the individual data URLs remain owned by their result rows.
      bulkSnippetCanvases.current.set(match.pageId, sourcePromise);
      while (bulkSnippetCanvases.current.size > 8) {
        const oldest = bulkSnippetCanvases.current.keys().next().value;
        if (!oldest) break;
        bulkSnippetCanvases.current.delete(oldest);
      }
    }
    const source = await sourcePromise;
    if (!source) return null;
    const matchLeft = bbox.left;
    const matchTop = bbox.top;
    const matchRight = bbox.right;
    const matchBottom = bbox.bottom;
    if (![matchLeft, matchTop, matchRight, matchBottom].every(Number.isFinite) || matchRight <= matchLeft || matchBottom <= matchTop) return null;
    const matchHeight = matchBottom - matchTop;
    // Keep only a small amount of neighboring text. The result row is a
    // recognition aid, so showing an entire line makes the match illegible.
    const paddingX = Math.max(8, Math.ceil(matchHeight * 1.2));
    const paddingY = Math.max(4, Math.ceil(matchHeight * .3));
    const left = Math.max(0, Math.floor(matchLeft - paddingX));
    const top = Math.max(0, Math.floor(matchTop - paddingY));
    const right = Math.min(source.width, Math.ceil(matchRight + paddingX));
    const bottom = Math.min(source.height, Math.ceil(matchBottom + paddingY));
    if (right <= left || bottom <= top) return null;
    const crop = document.createElement("canvas");
    crop.width = right - left;
    crop.height = bottom - top;
    crop.getContext("2d")?.drawImage(source, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return "data:image/png;base64," + canvasToBase64(crop);
  }, [pdf, renderEntry]);

  const chooseScriptCalibrationCandidates = useCallback(() => {
    const shuffle = (items: ScriptCalibrationCandidate[]) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    };
    const picked = scriptCandidateBuckets.current.flatMap(bucket => shuffle(bucket).slice(0, 6));
    const pickedKeys = new Set(picked.map(item => `${item.pageId}:${item.lineId}`));
    const remainder = shuffle(scriptCandidatePool.current.filter(item => !pickedKeys.has(`${item.pageId}:${item.lineId}`)));
    setScriptCalibrationCandidates([...picked, ...remainder].slice(0, 18));
  }, []);
  const scanScriptCalibrationCandidates = useCallback(async (
    draftSettings: ScriptDetectionSettings = manifestRef.current.settings,
    scope: ScriptCalibrationSampleScope = { kind: "all-pages" },
  ) => {
    const projectInfo = projectRef.current;
    if (!projectInfo || scriptCalibrationLoading) return;
    const generation = ++scriptScanGeneration.current;
    setScriptCalibrationLoading(true);
    scriptCandidatePool.current = [];
    scriptCandidateLines.current.clear();
    scriptCandidateHeights.current.clear();
    scriptSnippetCanvases.current.clear();
    const eligibleAll = manifestRef.current.pages.filter(page => page.status === "review" && !page.completed);
    const eligible = scope.kind === "current-page"
      ? eligibleAll.filter(page => page.id === scope.pageId)
      : eligibleAll;
    const cached = scriptHeightProfileRef.current?.projectPath === projectInfo.path
      ? scriptHeightProfileRef.current.profile : undefined;
    const learning = !cached;
    const total = eligible.length + (learning ? eligibleAll.length : 0);
    setScriptCalibrationProgress({ completed: 0, total });
    type Stored = { candidate: ScriptCalibrationCandidate; line: OcrLine; referenceHeight?: number };
    const buckets: Stored[][] = [[], [], []];
    const seen = [0, 0, 0];
    const add = (bucket: number, item: Stored) => {
      seen[bucket] += 1;
      if (buckets[bucket].length < 32) buckets[bucket].push(item);
      else {
        const replacement = Math.floor(Math.random() * seen[bucket]);
        if (replacement < 32) buckets[bucket][replacement] = item;
      }
    };
    try {
      let profile = cached;
      if (!profile) {
        const trainer = new ScriptHeightTrainer();
        for (let pageIndex = 0; pageIndex < eligibleAll.length; pageIndex += 1) {
          if (generation !== scriptScanGeneration.current) return;
          const saved = await invokeCommand("load_page", { projectPath: projectInfo.path, pageId: eligibleAll[pageIndex].id });
          if (saved) trainer.addPage(JSON.parse(saved) as DocumentPage);
          setScriptCalibrationProgress({ completed: pageIndex + 1, total });
        }
        profile = trainer.finish();
        scriptHeightProfileRef.current = { projectPath: projectInfo.path, profile };
      }
      for (let pageIndex = 0; pageIndex < eligible.length; pageIndex += 1) {
        if (generation !== scriptScanGeneration.current) return;
        const entry = eligible[pageIndex];
        const saved = await invokeCommand("load_page", { projectPath: projectInfo.path, pageId: entry.id });
        if (saved) {
          const page = JSON.parse(saved) as DocumentPage;
          const references = referenceHeightsForPage(page, profile);
          const lines = allLines(page).filter(line =>
            line.correctedText === line.originalText && !line.geometryApproximate &&
            !line.scriptDetectionManuallyEdited && !line.formatting?.length,
          );
          // Keep all eligible lines when sampling one page so its selection can
          // still fill the balanced 18-example preview. Across all pages, retain
          // one page-local line per category before reservoir sampling.
          const selected: Array<{ line: OcrLine; referenceHeight?: number } | undefined> = [undefined, undefined, undefined];
          for (const line of lines) {
            const referenceHeight = references.get(line.id);
            if (!referenceHeight) continue;
            const ranges = detectScriptRanges(line, draftSettings, referenceHeight, profile);
            const category = ranges.some(range => range.kind === "superscript") ? 0 : ranges.some(range => range.kind === "subscript") ? 1 : 2;
            if (scope.kind === "current-page") add(category, { candidate: { pageId: entry.id, lineId: line.id, lineText: line.correctedText, bbox: line.bbox }, line, referenceHeight });
            else if (!selected[category] || Math.random() < 0.5) selected[category] = { line, referenceHeight };
          }
          if (scope.kind !== "current-page") selected.forEach((item, category) => {
            if (!item) return;
            const { line, referenceHeight } = item;
            add(category, { candidate: { pageId: entry.id, lineId: line.id, lineText: line.correctedText, bbox: line.bbox }, line, referenceHeight });
          });
        }
        setScriptCalibrationProgress({ completed: (learning ? eligibleAll.length : 0) + pageIndex + 1, total });
      }
      if (generation !== scriptScanGeneration.current) return;
      const retained = buckets.flat();
      scriptCandidatePool.current = retained.map(item => item.candidate);
      scriptCandidateBuckets.current = buckets.map(bucket => bucket.map(item => item.candidate));
      retained.forEach(item => {
        const key = `${item.candidate.pageId}:${item.candidate.lineId}`;
        scriptCandidateLines.current.set(key, item.line);
        if (item.referenceHeight) scriptCandidateHeights.current.set(key, item.referenceHeight);
      });
      chooseScriptCalibrationCandidates();
    } catch (error) {
      if (generation === scriptScanGeneration.current) setNotice("notices.pageLoadFailed", { error: errorText(error) });
    } finally {
      if (generation === scriptScanGeneration.current) setScriptCalibrationLoading(false);
    }
  }, [chooseScriptCalibrationCandidates, scriptCalibrationLoading, setNotice]);
  const openScriptCalibration = useCallback(async () => {
    if (!projectRef.current || working.current || importActive.current) return;
    finishLineEditRef.current();
    try {
      await flush();
      scriptHeightProfileRef.current = null;
      setScriptCalibrationOpen(true);
      void scanScriptCalibrationCandidates();
    } catch (error) {
      setNotice("notices.saveFailed", { error: errorText(error) });
    }
  }, [flush, scanScriptCalibrationCandidates, setNotice]);
  const getScriptCalibrationSnippet = useCallback(async (candidate: ScriptCalibrationCandidate) => {
    if (!pdf) return null;
    let sourcePromise = scriptSnippetCanvases.current.get(candidate.pageId);
    if (!sourcePromise) {
      const entry = manifestRef.current.pages.find(page => page.id === candidate.pageId);
      if (!entry) return null;
      sourcePromise = (async () => {
        const target = document.createElement("canvas");
        const rendered = await renderEntry(entry, loading.current, pdf, target, false);
        return rendered?.canvas ?? null;
      })();
      scriptSnippetCanvases.current.set(candidate.pageId, sourcePromise);
      while (scriptSnippetCanvases.current.size > 8) {
        const oldest = scriptSnippetCanvases.current.keys().next().value;
        if (!oldest) break;
        scriptSnippetCanvases.current.delete(oldest);
      }
    }
    const source = await sourcePromise;
    const key = candidate.pageId + ":" + candidate.lineId;
    const line = scriptCandidateLines.current.get(key);
    const referenceHeight = scriptCandidateHeights.current.get(key);
    const validBox = (box: { left: number; top: number; right: number; bottom: number } | undefined) =>
      Boolean(box && [box.left, box.top, box.right, box.bottom].every(Number.isFinite) &&
        box.right > box.left && box.bottom > box.top);
    if (!source || !validBox(candidate.bbox)) return null;
    const charBoxes = (line?.chars ?? []).map(char => char.bbox).filter(
      (box): box is NonNullable<typeof box> => validBox(box),
    );
    const hasBaseline = Boolean(line?.baseline && Number.isFinite(line.baseline.slope) &&
      Number.isFinite(line.baseline.intercept));
    const hasHeightGuide = hasBaseline && Number.isFinite(referenceHeight) && (referenceHeight ?? 0) > 0;
    const baselinePageY = (x: number) => line!.bbox.bottom + line!.baseline!.intercept +
      line!.baseline!.slope * (x - line!.bbox.left);
    // Include edge glyphs and both height-guide endpoints without altering the
    // project image. The left gutter keeps the measurement readable.
    const boxes = [candidate.bbox, ...charBoxes];
    const left = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.left))) - 8);
    const right = Math.min(source.width, Math.ceil(Math.max(...boxes.map(box => box.right))) + 8);
    const guideTop = hasHeightGuide
      ? Math.min(baselinePageY(line!.bbox.left), baselinePageY(line!.bbox.right)) - referenceHeight!
      : Infinity;
    const baselineBottom = hasBaseline
      ? Math.max(baselinePageY(line!.bbox.left), baselinePageY(line!.bbox.right))
      : -Infinity;
    const top = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.top), guideTop)) - 8);
    const bottom = Math.min(source.height, Math.ceil(Math.max(...boxes.map(box => box.bottom), baselineBottom)) + 8);
    if (right <= left || bottom <= top) return null;
    const gutter = hasHeightGuide ? 58 : 0;
    const crop = document.createElement("canvas");
    crop.width = right - left + gutter;
    crop.height = bottom - top;
    const context = crop.getContext("2d");
    if (!context) return null;
    if (gutter) {
      context.fillStyle = "#f2f3ec";
      context.fillRect(0, 0, gutter, crop.height);
    }
    context.drawImage(source, left, top, right - left, bottom - top, gutter, 0, right - left, bottom - top);
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = "rgba(213, 83, 39, 0.5)";
    for (const box of charBoxes) {
      context.strokeRect(box.left - left + gutter, box.top - top, box.right - box.left, box.bottom - box.top);
    }
    if (hasBaseline) {
      const imageX = (x: number) => x - left + gutter;
      const baselineY = (x: number) => baselinePageY(x) - top;
      context.beginPath();
      context.setLineDash([5, 3]);
      context.lineWidth = 1.5;
      context.strokeStyle = "rgba(17, 105, 193, 0.75)";
      context.moveTo(imageX(line!.bbox.left), baselineY(line!.bbox.left));
      context.lineTo(imageX(line!.bbox.right), baselineY(line!.bbox.right));
      context.stroke();
      if (hasHeightGuide) {
        const guideY = (x: number) => baselineY(x) - referenceHeight!;
        context.beginPath();
        context.setLineDash([4, 3]);
        context.strokeStyle = "rgba(23, 126, 76, 0.8)";
        context.moveTo(imageX(line!.bbox.left), guideY(line!.bbox.left));
        context.lineTo(imageX(line!.bbox.right), guideY(line!.bbox.right));
        context.stroke();
        const markerX = gutter - 8;
        const upper = guideY(line!.bbox.left);
        const lower = baselineY(line!.bbox.left);
        context.beginPath();
        context.setLineDash([]);
        context.moveTo(markerX, upper);
        context.lineTo(markerX, lower);
        context.moveTo(markerX - 5, upper);
        context.lineTo(markerX + 5, upper);
        context.moveTo(markerX - 5, lower);
        context.lineTo(markerX + 5, lower);
        context.stroke();
        context.font = "10px sans-serif";
        context.fillStyle = "rgba(20, 103, 62, 0.95)";
        context.fillText("H=" + Math.round(referenceHeight! * 10) / 10 + "px", 4,
          Math.max(12, Math.min(crop.height - 4, (upper + lower) / 2)));
      }
    }
    context.restore();
    return "data:image/png;base64," + canvasToBase64(crop);
  }, [pdf, renderEntry]);
  const applyScriptCalibration = useCallback(async (settings: ScriptDetectionSettings) => {
    const projectInfo = projectRef.current;
    if (!projectInfo || working.current || importActive.current) return;
    finishLineEditRef.current();
    working.current = true;
    setBusy("save");
    const beforeSettings = copy(manifestRef.current.settings);
    const profile = scriptHeightProfileRef.current?.projectPath === projectInfo.path
      ? scriptHeightProfileRef.current.profile : manifestRef.current.settings.scriptHeightProfile;
    const eligible = manifestRef.current.pages.filter(page => page.status === "review" && !page.completed);
    setScriptCalibrationProgress({ completed: 0, total: eligible.length });
    const changes: HistoryChange[] = [];
    try {
      await flush();
      for (let start = 0; start < eligible.length; start += 20) {
        const updates: { pageId: string; expectedData: string; data: string }[] = [];
        for (const entry of eligible.slice(start, start + 20)) {
          const saved = await invokeCommand("load_page", { projectPath: projectInfo.path, pageId: entry.id });
          if (!saved) continue;
          const parsedPage = JSON.parse(saved) as DocumentPage;
          const withoutOldStyles = clearAutoWordStyles(parsedPage);
          let updated = applyScriptDetection(withoutOldStyles, settings, profile);
          const styleCanvas = document.createElement("canvas");
          const rendered = await renderEntry(entry, loading.current, pdf, styleCanvas, false);
          if (!rendered) throw new Error(globalT("appErrors.processedPage"));
          updated = await inferWordStyles(updated, canvasToBase64(styleCanvas), styleCanvas.width, styleCanvas.height,
            (imageBase64, samples) => invokeCommand("classify_word_styles", { imageBase64, samples }));
          const data = JSON.stringify(updated);
          if (data !== saved) updates.push({ pageId: entry.id, expectedData: saved, data });
        }
        if (updates.length) {
          changes.push(...updates.map(update => ({ pageId: update.pageId, beforeData: update.expectedData, afterData: update.data })));
        }
        setScriptCalibrationProgress({ completed: Math.min(start + 20, eligible.length), total: eligible.length });
      }
      const next = { ...manifestRef.current, settings: { ...manifestRef.current.settings, ...settings, scriptHeightProfile: profile, scriptHeightReferenceVersion: SCRIPT_HEIGHT_REFERENCE_VERSION } };
      const currentChange = changes.find(change => change.pageId === manifestRef.current.pages[indexRef.current]?.id);
      if (changes.length || JSON.stringify(beforeSettings) !== JSON.stringify(next.settings)) {
        await commitHistoryOperation(projectInfo.path, changes.map(change => ({ pageId: change.pageId, expectedData: change.beforeData, data: change.afterData })), {
          targetPageId: currentChange?.pageId ?? manifestRef.current.pages[indexRef.current]?.id ?? "", changes, beforeSettings, afterSettings: copy(next.settings),
        }, next);
      }
      putManifest(next);
      if (currentChange) putDoc(JSON.parse(currentChange.afterData) as DocumentPage);
      setNotice("notices.saved");
    } finally {
      working.current = false;
      setBusy(null);
      setScriptCalibrationProgress(null);
    }
  }, [commitHistoryOperation, flush, putDoc, putManifest, setNotice, renderEntry, pdf]);
  const applyBulkReplace = useCallback(async ({ search, replacement, replacementFormatting, preserveFormatting, selections }: BulkReplaceRequest) => {
    if (!project || !selections.length) return;
    await flush();
    const updates = await prepareBulkUpdates({ selections, search, replacement, replacementFormatting, preserveFormatting, loadPage: async (pageId) => {
      const saved = await invokeCommand("load_page", { projectPath: project.path, pageId });
      if (!saved) throw new Error("Page data is unavailable.");
      return saved;
    }});
    const changes = updates.map(update => ({ pageId: update.pageId, beforeData: update.expectedData, afterData: update.data }));
    const currentId = manifestRef.current.pages[indexRef.current]?.id;
    const targetPageId = changes.some((item) => item.pageId === currentId)
      ? currentId!
      : changes[0]?.pageId;
    if (targetPageId) {
      await commitHistoryOperation(project.path, updates, { targetPageId, changes: changes.map(compactChange) });
    }
    const change = changes.find((item) => item.pageId === currentId);
    if (change?.afterData && docRef.current) putDoc(JSON.parse(change.afterData) as DocumentPage);
    setBulkReplace(null);
  }, [commitHistoryOperation, flush, project, putDoc]);
  const lines = useMemo(() => (doc ? allLines(doc) : []), [doc]);
  const orderedLines = useMemo(() => {
    if (!orderPreviewIds) return lines;
    const byId = new Map(lines.map(line => [line.id, line]));
    return orderPreviewIds.map(id => byId.get(id)).filter((line): line is OcrLine => line != null);
  }, [lines, orderPreviewIds]);
  const orderChosenIds = new Set([...orderVisited, ...orderPendingVisited]);
  const activeOrderId = orderPendingVisited.at(-1) ?? orderVisited.at(-1);
  const w = canvasSize.width * zoom,
    h = canvasSize.height * zoom;
  const synchronizeProofingPane = useCallback((sourcePane: "pdf" | "ocr") => {
    const pdfStage = pdfStageRef.current;
    const ocrStage = ocrStageRef.current;
    const pageElement = pdfPageRef.current;
    const layoutCard = layoutCardRef.current;
    if (!pdfStage || !ocrStage || !pageElement || !layoutCard) return;
    const targetPane = sourcePane === "pdf" ? "ocr" : "pdf";
    const changed = sourcePane === "pdf"
      ? synchronizePageScroll(pdfStage, ocrStage, pageElement, layoutCard)
      : synchronizePageScroll(ocrStage, pdfStage, layoutCard, pageElement);
    if (changed) scrollSyncTarget.current = targetPane;
  }, []);
  const onProofingScroll = useCallback((sourcePane: "pdf" | "ocr") => {
    if (scrollSyncTarget.current === sourcePane) {
      scrollSyncTarget.current = null;
      return;
    }
    lastScrolledPane.current = sourcePane;
    synchronizeProofingPane(sourcePane);
  }, [synchronizeProofingPane]);
  useEffect(() => { setRegionMode(null); setRegionSelection(null); regionDrag.current = null; stopRegionScroll(); }, [current?.id, stopRegionScroll]);
  useEffect(() => { setRegionHintHidden(false); }, [regionMode]);
  useEffect(() => {
    if (regionMode === "order") return;
    orderDrag.current = null;
    orderVisitedRef.current = [];
    setOrderVisited([]);
    setOrderPendingVisited([]);
    setOrderPreviewIds(null);
    setOrderHoverId(null);
  }, [regionMode]);
  useEffect(() => {
    if (regionMode && (current?.completed || busy === "ocr")) {
      regionDrag.current = null; stopRegionScroll(); setRegionSelection(null); setRegionMode(null);
    } else if (!regionMode) stopRegionScroll();
  }, [busy, current?.completed, regionMode, stopRegionScroll]);
  useEffect(() => {
    if (!regionMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      regionDrag.current = null;
      stopRegionScroll();
      setRegionSelection(null);
      setRegionMode(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [regionMode, stopRegionScroll]);
  useEffect(() => () => stopRegionScroll(), [stopRegionScroll]);
  useLayoutEffect(() => {
    const pdfStage = pdfStageRef.current;
    const ocrStage = ocrStageRef.current;
    if (!pdfStage || !ocrStage) return;
    pdfStage.scrollLeft = 0;
    pdfStage.scrollTop = 0;
    ocrStage.scrollLeft = 0;
    ocrStage.scrollTop = 0;
    scrollSyncTarget.current = null;
    lastScrolledPane.current = "pdf";
  }, [current?.id]);
  useLayoutEffect(() => {
    synchronizeProofingPane(lastScrolledPane.current);
  }, [h, synchronizeProofingPane, w]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => synchronizeProofingPane(lastScrolledPane.current));
    if (pdfStageRef.current) observer.observe(pdfStageRef.current);
    if (ocrStageRef.current) observer.observe(ocrStageRef.current);
    return () => observer.disconnect();
  }, [synchronizeProofingPane]);
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
        <button onClick={undo} disabled={!undoStack.length || Boolean(busy)} title="Ctrl+Z" aria-keyshortcuts="Control+Z">
          <Undo2 size={15} /> {t("ui.undo")}
        </button>
        <button onClick={redo} disabled={!redoStack.length || Boolean(busy)} title="Ctrl+Y" aria-keyshortcuts="Control+Y">
          <Redo2 size={15} /> {t("ui.redo")}
        </button>
        <span className="toolbar-spacer" />
        <button className="secondary" onClick={() => void openScriptCalibration()} disabled={!project || Boolean(busy)}>
          {t("scriptCalibration.open")}
        </button>
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
          onClick={() => exportFile("html", exportScope)}
          disabled={!project || Boolean(busy)}
        >
          HTML
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
                aria-label={`${t("ui.page", { page: page.label })} · ${t("ui.sourcePage", { page: page.sourcePage })} · ${page.split === "single" ? t("ui.whole") : page.split === "left" ? t("ui.left") : t("ui.right")}${page.completed ? ` · ${t("ui.pageComplete")}` : ""}`}
              >
                <PageThumbnail cache={thumbnailCache} page={page} />
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
                <span className={`status-dot ${page.status === "review" ? "ready" : ""}`} />
                {page.completed && <span className="page-complete-mark" aria-label={t("ui.pageComplete")} title={t("ui.pageComplete")}>✓</span>}
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
            <button
              className={"region-add-button" + (regionMode === "add" ? " active" : "")}
              disabled={current?.status !== "review" || !doc || !canvasSize.width || Boolean(busy)}
              aria-pressed={regionMode === "add"}
              onClick={() => {
                if (regionMode === "add") { regionDrag.current = null; stopRegionScroll(); setRegionSelection(null); setRegionMode(null); return; }
                void (async () => {
                  const active = manifestRef.current.pages[indexRef.current];
                  if (!active || !await clearCompletion([active.id])) return;
                  if (manifestRef.current.pages[indexRef.current]?.id !== active.id) return;
                  finishLineEditRef.current();
                  setSelected(null);
                  setRegionMode("add");
                })();
              }}
            >{regionMode === "add" ? <X size={15} /> : <ScanLine size={15} />} {t(regionMode === "add" ? "ui.finishAddOcrRegion" : "ui.addOcrRegion")}</button>
            <button
              className={"region-add-button region-delete-button" + (regionMode === "delete" ? " active" : "")}
              disabled={current?.status !== "review" || !doc || !canvasSize.width || Boolean(busy)}
              aria-pressed={regionMode === "delete"}
              onClick={() => {
                if (regionMode === "delete") { regionDrag.current = null; stopRegionScroll(); setRegionSelection(null); setRegionMode(null); return; }
                void (async () => {
                  const active = manifestRef.current.pages[indexRef.current];
                  if (!active || !await clearCompletion([active.id])) return;
                  if (manifestRef.current.pages[indexRef.current]?.id !== active.id) return;
                  finishLineEditRef.current();
                  setSelected(null);
                  setRegionMode("delete");
                })();
              }}
            >{regionMode === "delete" ? <X size={15} /> : <Eraser size={15} />} {t(regionMode === "delete" ? "ui.finishDeleteOcrRegion" : "ui.deleteOcrRegion")}</button>
            <button
              className={"region-add-button region-merge-button" + (regionMode === "merge" ? " active" : "")}
              disabled={current?.status !== "review" || !doc || !canvasSize.width || Boolean(busy)}
              aria-pressed={regionMode === "merge"}
              onClick={() => {
                if (regionMode === "merge") { regionDrag.current = null; stopRegionScroll(); setRegionSelection(null); setRegionMode(null); return; }
                void (async () => {
                  const active = manifestRef.current.pages[indexRef.current];
                  if (!active || !await clearCompletion([active.id])) return;
                  if (manifestRef.current.pages[indexRef.current]?.id !== active.id) return;
                  finishLineEditRef.current();
                  setSelected(null);
                  setRegionMode("merge");
                })();
              }}
            >{regionMode === "merge" ? <X size={15} /> : <GitMerge size={15} />} {t(regionMode === "merge" ? "ui.finishMergeOcrRegions" : "ui.mergeOcrRegions")}</button>
            <button
              className={"region-add-button region-order-button" + (regionMode === "order" ? " active" : "")}
              disabled={current?.status !== "review" || !doc || !canvasSize.width || Boolean(busy)}
              aria-pressed={regionMode === "order"}
              onClick={() => {
                if (regionMode === "order") { setRegionMode(null); return; }
                void (async () => {
                  const active = manifestRef.current.pages[indexRef.current];
                  if (!active || !await clearCompletion([active.id])) return;
                  if (manifestRef.current.pages[indexRef.current]?.id !== active.id) return;
                  finishLineEditRef.current();
                  setSelected(null);
                  orderVisitedRef.current = []; setOrderVisited([]); setOrderPendingVisited([]); setOrderPreviewIds(null);
                  setRegionMode("order");
                })();
              }}
            ><ListOrdered size={15} /> {t(regionMode === "order" ? "ui.finishReadingOrder" : "ui.changeReadingOrder")}</button>
            {current?.status === "review" && <label className="page-complete-toggle" title={t("ui.pageCompleteHint")}>
              <input type="checkbox" checked={Boolean(current.completed)} disabled={Boolean(busy)} onChange={(event) => {
                if (event.currentTarget.checked) finishLineEditRef.current();
                const next = { ...manifestRef.current, pages: manifestRef.current.pages.map(page => page.id === current.id ? { ...page, completed: event.currentTarget.checked } : page) };
                putManifest(next); scheduleSave();
              }} />
              <span>{t("ui.pageComplete")}</span>
            </label>}
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
          <div className="proofing-grid" onPointerMove={(event) => {
              if (!regionMode || !regionHintRef.current) return;
              const box = regionHintRef.current.getBoundingClientRect();
              const margin = 40;
              setRegionHintHidden(event.clientX >= box.left - margin && event.clientX <= box.right + margin &&
                event.clientY >= box.top - margin && event.clientY <= box.bottom + margin);
            }} onPointerLeave={() => setRegionHintHidden(false)}>
            <article className={"pdf-pane" + (regionMode && regionMode !== "add" ? " region-inactive" : "")}>
              <div className="pane-label">
                <span>{t("ui.processedImage")}</span>
              </div>
              {regionMode === "add" && <div ref={regionHintRef} className={"region-instruction" + (regionHintHidden ? " hidden" : "")} role="status">
                {t("ui.regionSelectHint")}
              </div>}
              <div ref={pdfStageRef} className="pdf-stage" onScroll={() => onProofingScroll("pdf")}>
                {project ? (
                  <div
                    ref={pdfPageRef}
                    className={"pdf-page" + (regionMode === "add" ? " selecting" : "")}
                    style={{ width: w || undefined, height: h || undefined }}
                    onPointerDown={onRegionPointerDown}
                    onPointerMove={onRegionPointerMove}
                    onPointerUp={onRegionPointerUp}
                    onPointerCancel={(event) => {
                      if (regionDrag.current?.pointerId !== event.pointerId) return;
                      regionDrag.current = null;
                      stopRegionScroll();
                      setRegionSelection(null);
                    }}
                  >
                    <canvas ref={canvasRef} className="rendered-page" />
                    {regionMode === "add" && doc && <svg
                      className="recognized-region-overlay"
                      viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
                      aria-hidden="true"
                    >
                      {allLines(doc).flatMap(line => line.words.map(word => <rect
                        key={word.id}
                        x={word.bbox.left}
                        y={word.bbox.top}
                        width={Math.max(0, word.bbox.right - word.bbox.left)}
                        height={Math.max(0, word.bbox.bottom - word.bbox.top)}
                      />))}
                    </svg>}
                    {editing && doc && (() => {
                      const line = allLines(doc).find(candidate => candidate.id === editing);
                      return line ? <EditImageFocus line={line} caret={editCaret?.lineId === line.id ? editCaret.offset : 0}
                        zoom={zoom} pageWidth={canvasSize.width} sourceRef={canvasRef} showMagnifier={magnifierPreferences.imageMagnifierEnabled} /> : null;
                    })()}
                    {regionMode === "add" && regionSelection && <div className="region-selection" style={{
                      left: regionSelection.left * zoom, top: regionSelection.top * zoom,
                      width: (regionSelection.right - regionSelection.left) * zoom,
                      height: (regionSelection.bottom - regionSelection.top) * zoom,
                    }} />}
                  </div>
                ) : (
                  <Empty />
                )}
              </div>
            </article>
            <article className={"ocr-pane" + (regionMode === "add" ? " region-inactive" : "")}>
              <div className="pane-label">
                <span>{t("ui.recognitionLayout")}</span>
                {regionMode === null || regionMode === "add" ? <span className="pane-hint">{t("ui.clickLine")}</span> : null}
              </div>
              {(regionMode === "delete" || regionMode === "merge" || regionMode === "order") && <div ref={regionHintRef} className={"region-instruction" + (regionHintHidden ? " hidden" : "")} role="status">
                {t(regionMode === "order" ? (orderChosenIds.size ? "ui.readingOrderNextHint" : "ui.readingOrderFirstHint") : regionMode === "merge" ? "ui.regionMergeHint" : "ui.regionDeleteHint")}
              </div>}
              <div ref={ocrStageRef} className="ocr-stage" onScroll={() => onProofingScroll("ocr")}>
                {doc && canvasSize.width ? (
                  <div
                    ref={layoutCardRef}
                    className={"layout-card" + (regionMode === "delete" || regionMode === "merge" || regionMode === "order" ? " selecting" : "")}
                    style={{ width: w, height: h, minHeight: h }}
                    onPointerDown={regionMode === "order" ? onOrderPointerDown : onRegionPointerDown}
                    onPointerMove={regionMode === "order" ? onOrderPointerMove : onRegionPointerMove}
                    onPointerLeave={() => { if (!orderDrag.current) setOrderHoverId(null); }}
                    onPointerUp={regionMode === "order" ? onOrderPointerUp : onRegionPointerUp}
                    onPointerCancel={regionMode === "order" ? onOrderPointerCancel : (event) => {
                      if (regionDrag.current?.pointerId !== event.pointerId) return;
                      regionDrag.current = null;
                      stopRegionScroll();
                      setRegionSelection(null);
                    }}
                    onClickCapture={(event) => {
                      if (suppressLayoutClick.current) { event.stopPropagation(); suppressLayoutClick.current = false; }
                    }}
                  >
                    <svg
                      className="layout-svg"
                      viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
                    >
                      {lines.map((line) => (
                        <g key={line.id}>
                          <rect
                            className={regionMode === "order" && line.id === activeOrderId
                              ? "reading-order-active"
                              : regionMode === "order" && orderChosenIds.has(line.id)
                                ? "reading-order-chosen"
                                : selected === line.id ? "selected" : ""}
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
                            onClick={() => { if (!regionMode) void beginLineEdit(line.id); }}
                          />
                          <text
                            x={line.bbox.left}
                            y={
                              line.bbox.bottom + (line.baseline?.intercept ?? 0)
                            }
                            fontFamily="Noto Serif"
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
                            {(line.formatting?.length || line.autoFormatting?.length) ? <tspan dangerouslySetInnerHTML={{ __html: formattedSegments(line, true) }} /> : line.correctedText}
                          </text>
                        </g>
                      ))}
                    </svg>
                    {regionMode === "order" && <svg className="reading-order-overlay" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`} aria-label={t("ui.readingOrderOverlay")}>
                      <defs><marker id="reading-order-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth={8 / zoom} markerHeight={8 / zoom} markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#275e6a" /></marker></defs>
                      {orderedLines.slice(0, -1).map((line, number) => {
                        const next = orderedLines[number + 1];
                        const x1 = (line.bbox.left + line.bbox.right) / 2, y1 = (line.bbox.top + line.bbox.bottom) / 2;
                        const x2 = (next.bbox.left + next.bbox.right) / 2, y2 = (next.bbox.top + next.bbox.bottom) / 2;
                        const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy);
                        if (length < 1) return null;
                        const radius = 13 / zoom;
                        return <line key={line.id + "-arrow"} x1={x1 + dx * radius / length} y1={y1 + dy * radius / length}
                          x2={x2 - dx * radius / length} y2={y2 - dy * radius / length}
                          stroke="#275e6a" strokeWidth={2.4 / zoom} opacity=".9" markerEnd="url(#reading-order-arrow)" />;
                      })}
                      {orderedLines.map((line, number) => {
                        const x = (line.bbox.left + line.bbox.right) / 2, y = (line.bbox.top + line.bbox.bottom) / 2;
                        const active = line.id === activeOrderId;
                        const chosen = orderChosenIds.has(line.id);
                        return <g key={line.id} className={active ? "reading-order-active" : chosen ? "reading-order-chosen" : line.id === orderHoverId ? "reading-order-hover" : ""}>
                          <circle cx={x} cy={y} r={13 / zoom} />
                          <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={11 / zoom} fontWeight="700">{number + 1}</text>
                        </g>;
                      })}
                    </svg>}
                    {(regionMode === "delete" || regionMode === "merge") && regionSelection && <div className={"region-selection " + (regionMode === "merge" ? "merging" : "deleting")} style={{
                      left: regionSelection.left * zoom, top: regionSelection.top * zoom,
                      width: (regionSelection.right - regionSelection.left) * zoom,
                      height: (regionSelection.bottom - regionSelection.top) * zoom,
                    }} />}
                    {editing &&
                      (() => {
                        const line = lines.find((v) => v.id === editing);
                        return line ? (
                          <LineOverlay
                            key={line.id}
                            portalTarget={ocrStageRef.current}
                            value={line.correctedText}
                            formatting={effectiveFormatting(line)}
                            onChange={(value) => editLine(line.id, value)}
                            onCaretChange={(offset) => setEditCaret({ lineId: line.id, offset })}
                            onFinish={() => finishLineEdit(line.id)}
                            onUndo={() => void undo()}
                            onRedo={() => void redo()}
                            onFormat={(start, end, kind) => commitLineEdit(line.id, (before) => updateLineFormatting(before, line.id, start, end, kind))}
                            onOpenBulk={(selection, start) => void openBulkReplace(selection, line.id, start)}
                            onSplit={(caret) => { const before = docRef.current; if (!before) return; const after = splitLineAtCaret(before, line.id, caret); if (after === before) { setNotice("notices.splitUnavailable"); return; } commitLineEdit(line.id, () => after); finishLineEdit(line.id); }}
                            left={line.bbox.left * zoom}
                            top={line.bbox.top * zoom}
                            width={Math.max(20, (line.bbox.right - line.bbox.left) * zoom)}
                            height={Math.max(22, (line.bbox.bottom - line.bbox.top) * zoom + 8)}
                            fontSize={Math.max(1, (line.fontSize || line.bbox.bottom - line.bbox.top) * zoom)}
                            textMagnifierEnabled={magnifierPreferences.textMagnifierEnabled}
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
      {scriptCalibrationOpen && project && (
        <ScriptCalibrationDialog
          open={true}
          initialSettings={manifest.settings}
          candidates={scriptCalibrationCandidates}
          loading={scriptCalibrationLoading}
          progress={scriptCalibrationProgress}
          getSnippet={getScriptCalibrationSnippet}
          detectPreview={(candidate, settings) => {
            const line = scriptCandidateLines.current.get(`${candidate.pageId}:${candidate.lineId}`);
            return line ? detectScriptRanges(line, settings, scriptCandidateHeights.current.get(`${candidate.pageId}:${candidate.lineId}`), scriptHeightProfileRef.current?.profile) : [];
          }}
          onReshuffleCurrentPage={current?.status === "review" && !current.completed ? (settings) => void scanScriptCalibrationCandidates(settings, { kind: "current-page", pageId: current.id }) : undefined}
          onReshuffleAllPages={(settings) => void scanScriptCalibrationCandidates(settings, { kind: "all-pages" })}
          onApply={applyScriptCalibration}
          onClose={() => {
            scriptScanGeneration.current += 1;
            setScriptCalibrationLoading(false);
            scriptSnippetCanvases.current.clear();
            setScriptCalibrationOpen(false);
            setScriptCalibrationProgress(null);
          }}
        />
      )}
      {bulkReplace && project && (<BulkReplaceDialog open={true} projectPath={project.path} initialSearch={bulkReplace.search} initialMatch={bulkReplace.initialMatch} getSnippet={getBulkSnippet} onApply={applyBulkReplace} onClose={() => { bulkSnippetCanvases.current.clear(); setBulkReplace(null); }} />)}
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
          magnifierPreferences={magnifierPreferences}
          setMagnifierPreference={setMagnifierPreference}
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
                  const active = manifestRef.current.pages[indexRef.current];
                  void clearCompletion(active ? [active.id] : []).then((cleared) => {
                    if (cleared) void runOcr(scope);
                  });
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
  magnifierPreferences,
  setMagnifierPreference,
}: {
  manifest: Manifest;
  putManifest: (v: Manifest) => void;
  scheduleSave: () => void;
  close: () => void;
  language: LocalePreference;
  changeLanguage: (language: LocalePreference) => Promise<void>;
  languageSaving: boolean;
  magnifierPreferences: { imageMagnifierEnabled: boolean; textMagnifierEnabled: boolean };
  setMagnifierPreference: (key: "imageMagnifierEnabled" | "textMagnifierEnabled", enabled: boolean) => void;
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
        <label className="settings-checkbox"><input type="checkbox" checked={magnifierPreferences.imageMagnifierEnabled} onChange={(event) => setMagnifierPreference("imageMagnifierEnabled", event.currentTarget.checked)} />{t("ui.imageMagnifier")}</label>
        <label className="settings-checkbox"><input type="checkbox" checked={magnifierPreferences.textMagnifierEnabled} onChange={(event) => setMagnifierPreference("textMagnifierEnabled", event.currentTarget.checked)} />{t("ui.textMagnifier")}</label>
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
