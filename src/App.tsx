import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import JSZip from "jszip";
import { ChevronLeft, ChevronRight, FileDown, FilePlus2, FolderOpen, Save, Settings2, Square, Undo2, Redo2, X } from "lucide-react";
import { canvasToBase64, openProjectPdf } from "./pdf";
import { invokeCommand, isTauri, type ProjectInfo } from "./tauri";
import { SaveQueue } from "./persistence";
import { allLines, exportHocr, exportSvg, exportText, parseHocr, processCanvas, updateLineText, type DocumentPage, type LogicalPageProvenance } from "./domain";
import type { PDFDocumentProxy } from "pdfjs-dist";

type Status = "pending" | "ocr" | "review";
type Entry = LogicalPageProvenance & { id: string; label: string; status: Status; width?: number; height?: number; dpi?: number };
type Settings = { modelPath: string; psm: 3 | 6 | 11; dpi: number };
type Manifest = { version: 1; pages: Entry[]; settings: Settings };
const defaultSettings: Settings = { modelPath: "", psm: 3, dpi: 300 };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function encode(value: string) { const bytes = new TextEncoder().encode(value); let out = ""; bytes.forEach(b => out += String.fromCharCode(b)); return btoa(out); }
function makeManifest(pageCount = 1, sample = false): Manifest {
  const pages: Entry[] = [];
  for (let sourcePage = 1; sourcePage <= pageCount; sourcePage++) {
    const transformations = sample ? [{ split: "left" as const, rotation: 90 }, { split: "right" as const, rotation: 90 }] : [{ split: "single" as const, rotation: 0 }];
    transformations.forEach((value, i) => pages.push({ id: `page-${sourcePage}-${value.split}`, label: sample ? `${sourcePage}${i ? "R" : "L"}` : String(sourcePage), sourcePage, split: value.split, rotation: value.rotation, angle: 0, status: "pending" }));
  }
  return { version: 1, pages, settings: { ...defaultSettings } };
}
function parseManifest(raw: string | null): Manifest {
  if (!raw) return makeManifest();
  try {
    const data = JSON.parse(raw) as Partial<Manifest>;
    if (data.version !== undefined && data.version !== 1) throw new Error("unsupported project version");
    if (!data?.pages?.length) throw new Error("プロジェクトのページ情報がありません");
    return { version: 1, settings: { ...defaultSettings, ...data.settings }, pages: data.pages.map((page, index) => ({
      id: String(page.id || `page-${index + 1}`), label: String(page.label || index + 1), sourcePage: Number(page.sourcePage || index + 1),
      split: page.split === "left" || page.split === "right" ? page.split : "single", rotation: [0,90,180,270].includes(Number(page.rotation)) ? Number(page.rotation) : 0,
      angle: Number(page.angle || 0), crop: page.crop, status: page.status === "ocr" || page.status === "review" ? page.status : "pending", width: page.width, height: page.height, dpi: Number.isInteger(page.dpi) && Number(page.dpi) >= 72 && Number(page.dpi) <= 600 ? Number(page.dpi) : undefined,
    })) };
  } catch { throw new Error("プロジェクトのページ情報を読み取れません。保存ファイルは変更していません。"); }
}

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [manifest, setManifest] = useState<Manifest>(makeManifest);
  const [index, setIndex] = useState(0);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [doc, setDoc] = useState<DocumentPage | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<DocumentPage[]>([]);
  const [redoStack, setRedoStack] = useState<DocumentPage[]>([]);
  const [zoom, setZoom] = useState(.42);
  const [busy, setBusy] = useState<"open" | "save" | "ocr" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [notice, setNotice] = useState("PDF を読み込み、OCR 結果を校正します。");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmOcr, setConfirmOcr] = useState<"current" | "all" | null>(null);
  const [exportScope, setExportScope] = useState<"current" | "all">("all");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectRef = useRef<ProjectInfo | null>(null), manifestRef = useRef(manifest), indexRef = useRef(0), docRef = useRef<DocumentPage | null>(null), environmentModel = useRef(""), loading = useRef(0), documentLoading = useRef(0), ocrLoading = useRef(0), cancelled = useRef(false), timer = useRef<number | null>(null), writeQueue = useRef(new SaveQueue()), working = useRef(false), closing = useRef(false);
  const current = manifest.pages[index] ?? null;
  const putProject = useCallback((value: ProjectInfo | null) => { projectRef.current = value; setProject(value); }, []);
  const putManifest = useCallback((value: Manifest) => { manifestRef.current = value; setManifest(value); }, []);
  const putDoc = useCallback((value: DocumentPage | null) => { docRef.current = value; setDoc(value); }, []);
  const putIndex = useCallback((value: number) => { indexRef.current = value; setIndex(value); }, []);
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const p = projectRef.current, entry = manifestRef.current.pages[indexRef.current], page = docRef.current;
    if (!isTauri || !p || !entry) return;
    const projectPath = p.path, pageId = entry.id, data = page?.id === entry.id ? JSON.stringify(copy(page)) : null, savedManifest = JSON.stringify(copy(manifestRef.current));
    const write = async () => { if (data) await invokeCommand("save_page", { projectPath, pageId, data }); await invokeCommand("save_manifest", { projectPath, manifest: savedManifest }); };
    return writeQueue.current.enqueue(write);
  }, []);
  const scheduleSave = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = window.setTimeout(() => { timer.current = null; if (working.current) return; setBusy("save"); flush().then(() => setNotice("保存済み"), e => setNotice(`保存に失敗しました: ${errorText(e)}`)).finally(() => { if (!working.current) setBusy(null); }); }, 450); }, [flush]);

  const renderEntry = useCallback(async (entry: Entry, token: number, sourcePdf = pdf, destination?: HTMLCanvasElement) => {
    if (!sourcePdf) return;
    const source = await sourcePdf.getPage(entry.sourcePage); const scale = Math.max(72, Math.min(600, entry.dpi ?? manifestRef.current.settings.dpi)) / 72;
    const viewport = source.getViewport({ scale }); const raw = document.createElement("canvas"); raw.width = Math.ceil(viewport.width); raw.height = Math.ceil(viewport.height);
    await source.render({ canvasContext: raw.getContext("2d")!, viewport }).promise;
    const result = processCanvas(raw, { sourcePage: entry.sourcePage, rotation: entry.rotation as 0|90|180|270, split: entry.split === "single" ? "none" : entry.split, crop: entry.crop, deskew: Boolean(entry.angle), maxDeskewDegrees: Math.abs(entry.angle || 0) });
    if ((!destination && (token !== loading.current || !canvasRef.current)) || (destination && cancelled.current)) return;
    const image = result.pages[0]?.canvas; if (!image) throw new Error("処理済みページを作成できません");
    const target = destination ?? canvasRef.current!; target.width = image.width; target.height = image.height; target.getContext("2d")!.drawImage(image, 0, 0); if (!destination) setCanvasSize({ width: image.width, height: image.height });
  }, [pdf]);
  useEffect(() => {
    if (!project || !current) return; const token = ++documentLoading.current;
    putDoc(null); setSelected(null); setEditing(null); setUndoStack([]); setRedoStack([]); setCanvasSize({ width: 0, height: 0 });
    invokeCommand("load_page", { projectPath: project.path, pageId: current.id }).then(saved => { if (token === documentLoading.current && saved) putDoc(JSON.parse(saved) as DocumentPage); }).catch(e => token === documentLoading.current && setNotice(`ページを読み込めません: ${errorText(e)}`));
  }, [project, index, current?.id, putDoc]);
  useEffect(() => {
    if (!project || !pdf || !current) return;
    const token = ++loading.current;
    renderEntry(current, token).catch(e => token === loading.current && setNotice(`PDF を描画できません: ${errorText(e)}`));
  // Transform changes redraw only the processed image; they do not discard a loaded document or its undo stack.
  }, [project, pdf, current?.id, current?.rotation, current?.split, current?.dpi, manifest.settings.dpi, JSON.stringify(current?.crop), renderEntry]);
  const openInfo = useCallback(async (info: ProjectInfo, created = false) => {
    if (working.current) return; working.current = true; setBusy("open"); let existing: Manifest; try { existing = parseManifest(info.manifest); } catch (e) { setNotice(errorText(e)); setBusy(null); working.current = false; return; }
    if (!existing.settings.modelPath) existing.settings.modelPath = environmentModel.current;
    try { const opened = await openProjectPdf(info.path, info.pdfSize); const oldPdf = pdf; setPdf(null); if (oldPdf) await oldPdf.destroy(); putProject(info); putManifest(existing); putIndex(0); putDoc(null); setPdf(opened); if (created || !info.manifest) { const next = makeManifest(opened.numPages); next.settings.modelPath = existing.settings.modelPath; putManifest(next); await invokeCommand("save_manifest", { projectPath: info.path, manifest: JSON.stringify(next) }); } setNotice(`${info.name} を開きました。`); }
    catch (e) { setNotice(`PDF を読み込めません: ${errorText(e)}`); } finally { setBusy(null); working.current = false; }
  }, [pdf, putDoc, putIndex, putManifest, putProject]);
  const importPdf = useCallback(async () => { if (working.current) return; try { await flush(); const pdfPath = await dialogOpen({ multiple: false, filters: [{ name: "PDF", extensions: ["pdf"] }] }); if (typeof pdfPath !== "string") return; const projectPath = await dialogSave({ defaultPath: pdfPath.replace(/\.pdf$/i, ".eduba"), filters: [{ name: "Eduba", extensions: ["eduba"] }] }); if (typeof projectPath !== "string") return; await openInfo(await invokeCommand("create_project", { pdfPath, projectPath }), true); } catch (e) { setNotice(`インポートできません: ${errorText(e)}`); } }, [flush, openInfo]);
  const openProject = useCallback(async () => { if (working.current) return; try { await flush(); const path = await dialogOpen({ multiple: false, filters: [{ name: "Eduba", extensions: ["eduba"] }] }); if (typeof path === "string") await openInfo(await invokeCommand("open_project", { projectPath: path })); } catch (e) { setNotice(`プロジェクトを開けません: ${errorText(e)}`); } }, [flush, openInfo]);
  const go = useCallback(async (next: number) => { if (working.current) { setNotice("処理中はページを移動できません。"); return; } if (next < 0 || next >= manifestRef.current.pages.length || next === indexRef.current) return; try { setBusy("save"); await flush(); putIndex(next); } catch (e) { setNotice(`保存できないため移動できません: ${errorText(e)}`); } finally { setBusy(null); } }, [flush, putIndex]);
  const editLine = useCallback((id: string, text: string) => { if (working.current) return; const before = docRef.current; if (!before) return; const after = updateLineText(before, id, text); setUndoStack(old => [...old.slice(-99), before]); setRedoStack([]); putDoc(after); scheduleSave(); }, [putDoc, scheduleSave]);
  const undo = useCallback(() => { if (working.current) return; const now = docRef.current, prior = undoStack.at(-1); if (!now || !prior) return; setUndoStack(old => old.slice(0, -1)); setRedoStack(old => [now, ...old].slice(0, 100)); putDoc(prior); scheduleSave(); }, [putDoc, scheduleSave, undoStack]);
  const redo = useCallback(() => { if (working.current) return; const now = docRef.current, next = redoStack[0]; if (!now || !next) return; setRedoStack(old => old.slice(1)); setUndoStack(old => [...old, now].slice(-100)); putDoc(next); scheduleSave(); }, [putDoc, redoStack, scheduleSave]);
  const recognize = useCallback(async (entry: Entry, token: number) => {
    const worker = document.createElement("canvas"); await renderEntry(entry, token, undefined, worker); if (cancelled.current || token !== ocrLoading.current) throw new Error("OCR を中止しました");
    const renderDpi = entry.dpi ?? manifestRef.current.settings.dpi;
    const hocr = await invokeCommand("run_ocr", { imageBase64: canvasToBase64(worker), modelPath: manifestRef.current.settings.modelPath, psm: manifestRef.current.settings.psm, dpi: renderDpi });
    if (cancelled.current) throw new Error("OCR を中止しました"); const parsed = parseHocr(hocr, { sourcePage: entry.sourcePage, pageId: entry.id })[0]; if (!parsed) throw new Error("hOCR にページがありません");
    return { ...parsed, id: entry.id, sourcePage: entry.sourcePage, split: entry.split, rotation: entry.rotation, angle: entry.angle, crop: entry.crop, width: worker.width, height: worker.height };
  }, [renderEntry]);
  const runOcr = useCallback(async (scope: "current" | "all") => {
    if (!projectRef.current || working.current) return; working.current = true;
    try { await flush(); } catch (error) { working.current = false; setNotice(`保存できないため OCR を開始できません: ${errorText(error)}`); return; }
    const targets = scope === "current" ? [manifestRef.current.pages[indexRef.current]] : manifestRef.current.pages.filter(p => p.status !== "review"); if (!targets.length) { working.current = false; setNotice("OCR 待ちのページはありません。"); return; }
    cancelled.current = false; setBusy("ocr"); setProgress({done:0,total:targets.length});
    try { for (let i=0; i<targets.length; i++) { if (cancelled.current) break; const entry = targets[i], token = ++ocrLoading.current, result = await recognize(entry, token); if (cancelled.current) break; const next = { ...manifestRef.current, pages: manifestRef.current.pages.map(p => p.id === entry.id ? { ...p, status:"review" as const, width:result.width, height:result.height, dpi:entry.dpi ?? manifestRef.current.settings.dpi } : p) }; const path = projectRef.current.path, data = JSON.stringify(result), savedManifest = JSON.stringify(next); const write = async () => { await invokeCommand("save_page", { projectPath:path, pageId:entry.id, data }); await invokeCommand("save_manifest", { projectPath:path, manifest:savedManifest }); }; await writeQueue.current.enqueue(write); putManifest(next); if (entry.id === next.pages[indexRef.current]?.id) putDoc(result); setProgress({done:i+1,total:targets.length}); } setNotice(cancelled.current ? "OCR を中止しました。保存済みの結果は残っています。" : "OCR が完了しました。"); }
    catch (e) { setNotice(`OCR に失敗しました: ${errorText(e)}`); } finally { working.current = false; setBusy(null); setProgress(null); const active = manifestRef.current.pages[indexRef.current]; if (active) { const token = ++loading.current; renderEntry(active, token).catch(() => undefined); } }
  }, [putDoc, putManifest, recognize]);
  const askOcr = useCallback((scope: "current" | "all") => { if (scope === "current" && docRef.current && allLines(docRef.current).some(line => line.correctedText !== line.originalText)) setConfirmOcr(scope); else runOcr(scope); }, [runOcr]);
  const cancelOcr = useCallback(() => { cancelled.current = true; invokeCommand("cancel_ocr").catch(() => undefined); }, []);
  const changePreprocess = useCallback((rotation: number, split: "single"|"left"|"right") => { if (working.current) return;
    const active = manifestRef.current.pages[indexRef.current]; if (!active || active.status === "review") { setNotice("OCR 済みページの処理変更は、新しいプロジェクトで行ってください。"); return; }
    const next = { ...manifestRef.current, pages: manifestRef.current.pages.map(page => page.id === active.id ? { ...page, rotation, split, dpi: undefined } : page) }; putManifest(next); scheduleSave();
  }, [putManifest, scheduleSave]);
  const applySpreadPreset = useCallback(() => { if (working.current) return;
    if (manifestRef.current.pages.some(page => page.status === "review")) { setNotice("OCR 済みページがあるため、見開きプリセットは適用できません。"); return; }
    const count = Math.max(...manifestRef.current.pages.map(page => page.sourcePage)); const next = makeManifest(count, true); next.settings = copy(manifestRef.current.settings); putManifest(next); putIndex(0); putDoc(null); scheduleSave(); setNotice("見開きプリセットを適用しました。90°時計回りで左右に分割します。");
  }, [putDoc, putIndex, putManifest, scheduleSave]);
  const exportFile = useCallback(async (type: "txt"|"hocr"|"svg", scope: "current"|"all" = "all") => {
    if (!projectRef.current || working.current) return; try { working.current=true; setBusy("save"); await flush(); const pages: DocumentPage[] = []; const entries = scope === "current" ? [manifestRef.current.pages[indexRef.current]] : manifestRef.current.pages; for (const entry of entries) { const saved = await invokeCommand("load_page", { projectPath:projectRef.current.path, pageId:entry.id }); if (saved) pages.push(JSON.parse(saved) as DocumentPage); } if (!pages.length) throw new Error("エクスポートできる OCR 結果がありません"); let content = "", suffix = type === "txt" ? "txt" : type === "hocr" ? "html" : "svg", readyBase64 = false; if (type === "txt") content=exportText(pages); else if (type === "hocr") content=exportHocr(pages); else if (pages.length === 1) content=exportSvg(pages[0]); else { const zip=new JSZip(); pages.forEach((page,i)=>zip.file(`page-${i+1}.svg`,exportSvg(page))); content=await zip.generateAsync({type:"base64"}); suffix="zip"; readyBase64=true; } const path=await dialogSave({defaultPath:`${projectRef.current.name.replace(/\.eduba$/i,"")}.${suffix}`,filters:[{name:suffix.toUpperCase(),extensions:[suffix]}]}); if(typeof path === "string") await invokeCommand("export_file",{path,contentBase64:readyBase64?content:encode(content)}); setNotice("エクスポートしました。"); } catch(e) { setNotice(`エクスポートできません: ${errorText(e)}`); } finally { working.current=false; setBusy(null); }
  }, [flush]);
  useEffect(() => { if (!isTauri) return; let off: (()=>void)|undefined; listen<string>("app-menu", event => { if (working.current) return; if(event.payload==="import") importPdf(); if(event.payload==="open") openProject(); if(event.payload==="export") exportFile("txt"); if(event.payload==="settings") setSettingsOpen(true); }).then(value=>off=value); return ()=>off?.(); }, [exportFile, importPdf, openProject]);
  useEffect(() => { if (!isTauri) return; let unlisten: (() => void) | undefined; getCurrentWindow().onCloseRequested(async event => { if (closing.current) return; event.preventDefault(); if (working.current) { setNotice("OCR または保存処理が完了するまで閉じられません。"); return; } try { if (timer.current) clearTimeout(timer.current); await flush(); await writeQueue.current.idle(); closing.current = true; await getCurrentWindow().destroy(); } catch (error) { setNotice(`閉じる前に保存できません: ${errorText(error)}`); } }).then(value => { unlisten = value; }); return () => unlisten?.(); }, [flush]);
  useEffect(() => () => { if(timer.current) clearTimeout(timer.current); flush().catch(()=>undefined); }, [flush]);
  useEffect(() => { if(!isTauri) return; invokeCommand("get_environment").then(env => { environmentModel.current = env.modelPath; if(!manifestRef.current.settings.modelPath) putManifest({...manifestRef.current,settings:{...manifestRef.current.settings,modelPath:env.modelPath}}); }).catch(()=>undefined); }, [putManifest]);
  const lines = useMemo(() => doc ? allLines(doc) : [], [doc]); const w=canvasSize.width*zoom, h=canvasSize.height*zoom;
  return <main className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark">E</div><div><div className="brand-name">EDUBA</div><div className="brand-sub">OCR PROOFREADING DESK</div></div></div><div className="project-title"><span>{project?.name ?? "新しいプロジェクト"}</span><span className="muted">{project ? `${manifest.pages.length} 論理ページ` : ".eduba プロジェクト"}</span></div><button className="icon-btn" disabled={Boolean(busy)} onClick={()=>setSettingsOpen(true)} title="設定"><Settings2 size={16}/></button></header>
    <nav className="toolbar"><button onClick={importPdf} disabled={Boolean(busy)}><FilePlus2 size={15}/> PDF を読み込む</button><button onClick={openProject} disabled={Boolean(busy)}><FolderOpen size={15}/> 開く</button><span className="toolbar-divider"/><button onClick={()=>{setBusy("save");flush().then(()=>setNotice("保存済み"),e=>setNotice(`保存に失敗しました: ${errorText(e)}`)).finally(()=>setBusy(null));}} disabled={!project||Boolean(busy)}><Save size={15}/> 保存</button><button onClick={undo} disabled={!undoStack.length||Boolean(busy)}><Undo2 size={15}/> 元に戻す</button><button onClick={redo} disabled={!redoStack.length||Boolean(busy)}><Redo2 size={15}/> やり直す</button><span className="toolbar-spacer"/><button className="secondary" onClick={()=>askOcr("current")} disabled={!project||Boolean(busy)}>現在を OCR</button><button className="primary" onClick={()=>askOcr("all")} disabled={!project||Boolean(busy)}>{progress?`${progress.done}/${progress.total}`:"未処理を OCR"}</button>{busy==="ocr"&&<button className="ocr-stop" onClick={cancelOcr}><Square size={13}/> 中止</button>}<span className="toolbar-divider"/><select value={exportScope} onChange={e=>setExportScope(e.target.value as "current"|"all")} disabled={!project||Boolean(busy)}><option value="current">現在のページ</option><option value="all">全ページ</option></select><button onClick={()=>exportFile("txt",exportScope)} disabled={!project||Boolean(busy)}><FileDown size={15}/> TXT</button><button onClick={()=>exportFile("hocr",exportScope)} disabled={!project||Boolean(busy)}>hOCR</button><button onClick={()=>exportFile("svg",exportScope)} disabled={!project||Boolean(busy)}>SVG</button></nav>
    <section className="workspace"><aside className="sidebar"><div className="side-heading"><span>論理ページ</span><span className="page-count">{manifest.pages.length}</span></div><div className="page-list">{manifest.pages.map((page,i)=><button key={page.id} className={`page-item ${i===index?"active":""}`} onClick={()=>go(i)}><span className="thumb"/><span className="page-meta"><strong>{page.label}</strong><small>原稿 {page.sourcePage} · {page.split==="single"?"全体":page.split==="left"?"左":"右"}</small></span><span className={`status-dot ${page.status==="review"?"ready":""}`}/></button>)}</div></aside><section className="editor-area"><div className="canvas-toolbar"><div className="breadcrumb"><strong>{current?`ページ ${current.label}`:"PDF を開く"}</strong><span>／ {current?.split==="single"?"全ページ":current?.split==="left"?"左ページ":"右ページ"}</span></div><div className="view-tools"><button className="icon-btn" onClick={()=>setZoom(v=>Math.max(.2,v-.08))}>−</button><span>{Math.round(zoom*100)}%</span><button className="icon-btn" onClick={()=>setZoom(v=>Math.min(1.1,v+.08))}>＋</button><span className="toolbar-divider short"/><button className="icon-btn" onClick={()=>go(index-1)} disabled={index===0||Boolean(busy)}><ChevronLeft size={15}/></button><button className="icon-btn" onClick={()=>go(index+1)} disabled={index>=manifest.pages.length-1||Boolean(busy)}><ChevronRight size={15}/></button></div></div><div className="proofing-grid"><article className="pdf-pane"><div className="pane-label"><span>処理済み画像</span></div><div className="pdf-stage">{project?<canvas ref={canvasRef} className="rendered-page" style={{width:w||undefined,height:h||undefined}}/>:<Empty/>}</div></article><article className="ocr-pane"><div className="pane-label"><span>認識レイアウト</span><span className="pane-hint">行をクリックして編集</span></div><div className="ocr-stage">{doc&&canvasSize.width?<div className="layout-card" style={{width:w,height:h,minHeight:h}}><svg className="layout-svg" viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}>{lines.map(line=><g key={line.id}><rect className={selected===line.id?"selected":""} x={line.bbox.left} y={line.bbox.top} width={Math.max(1,line.bbox.right-line.bbox.left)} height={Math.max(1,line.bbox.bottom-line.bbox.top)} onClick={()=>{setSelected(line.id);setEditing(line.id);}}/><text x={line.bbox.left} y={line.bbox.bottom+(line.baseline?.intercept??0)} fontFamily="monospace" fontSize={line.fontSize||Math.max(10,line.bbox.bottom-line.bbox.top)} textLength={Math.max(1,line.bbox.right-line.bbox.left)} lengthAdjust="spacingAndGlyphs">{line.correctedText}</text></g>)}</svg>{editing&&(()=>{const line=lines.find(v=>v.id===editing);return line?<textarea autoFocus className="line-overlay" value={line.correctedText} onChange={e=>editLine(line.id,e.target.value)} onBlur={()=>setEditing(null)} onKeyDown={e=>e.key==="Escape"&&setEditing(null)} style={{left:line.bbox.left*zoom,top:line.bbox.top*zoom,width:Math.max(20,(line.bbox.right-line.bbox.left)*zoom),height:Math.max(22,(line.bbox.bottom-line.bbox.top)*zoom+8),fontSize:Math.max(10,(line.fontSize||line.bbox.bottom-line.bbox.top)*zoom)}}/>:null;})()}</div>:<div className="ocr-empty"><strong>{project?"まだ OCR 結果がありません":"PDF を読み込みます"}</strong><span>{project?"「現在を OCR」を実行してください。候補辞書はまだ登録されていません。":"1つの .eduba ファイルに保存されます。"}</span></div>}</div></article></div></section></section>
    <footer className="statusbar"><span>{notice}</span><span className={`save-indicator ${busy==="save"?"working":""}`}>{busy==="save"?"保存中…":project?"自動保存":"待機中"}</span></footer>
    {settingsOpen&&<SettingsModal manifest={manifest} current={current} putManifest={putManifest} scheduleSave={scheduleSave} changePreprocess={changePreprocess} applySpreadPreset={applySpreadPreset} close={()=>setSettingsOpen(false)}/>} {confirmOcr&&<div className="modal-scrim"><div className="modal"><div className="modal-head"><div><div className="eyebrow">RECOGNIZE AGAIN</div><h2>修正を置き換えますか？</h2></div><button className="icon-btn" onClick={()=>setConfirmOcr(null)}><X size={16}/></button></div><p>このページの手入力による修正は、新しい OCR 結果で置き換えられます。</p><div className="modal-actions"><button className="secondary" onClick={()=>setConfirmOcr(null)}>戻る</button><button className="primary" onClick={()=>{const scope=confirmOcr;setConfirmOcr(null);runOcr(scope);}}>置き換えて OCR</button></div></div></div>}
  </main>;
}
function Empty(){return <div className="empty-state"><strong>Eduba</strong><span>PDF を読み込んで開始します</span></div>}
function SettingsModal({manifest,current,putManifest,scheduleSave,changePreprocess,applySpreadPreset,close}:{manifest:Manifest;current:Entry|null;putManifest:(v:Manifest)=>void;scheduleSave:()=>void;changePreprocess:(r:number,s:"single"|"left"|"right")=>void;applySpreadPreset:()=>void;close:()=>void}){const split=current?.split??"single";const dpiLocked=manifest.pages.some(page=>page.status==="review");return <div className="modal-scrim"><div className="modal settings-modal"><div className="modal-head"><div><div className="eyebrow">OCR SETTINGS</div><h2>認識設定</h2></div><button className="icon-btn" onClick={close}><X size={16}/></button></div><label>モデル (.traineddata)<button className="file-select" onClick={async()=>{const path=await dialogOpen({multiple:false,filters:[{name:"Tesseract model",extensions:["traineddata"]}]});if(typeof path==="string"){putManifest({...manifest,settings:{...manifest.settings,modelPath:path}});scheduleSave();}}}>{manifest.settings.modelPath||"モデルを選択"}</button></label><div className="form-row"><label>PSM<select value={manifest.settings.psm} onChange={e=>{putManifest({...manifest,settings:{...manifest.settings,psm:Number(e.target.value) as Settings["psm"]}});scheduleSave();}}><option value="3">3 — 自動</option><option value="6">6 — 単一ブロック</option><option value="11">11 — 疎なテキスト</option></select></label><label>DPI<input disabled={dpiLocked} type="number" min="72" max="600" value={manifest.settings.dpi} onChange={e=>{putManifest({...manifest,settings:{...manifest.settings,dpi:Math.max(72,Math.min(600,Number(e.target.value)||300))}});scheduleSave();}}/></label></div><div className="form-row"><label>現在ページの回転<select value={current?.rotation??0} onChange={e=>changePreprocess(Number(e.target.value),split)}><option value="0">0°</option><option value="90">90° 時計回り</option><option value="180">180°</option><option value="270">270°</option></select></label><label>現在ページの面<select value={split} onChange={e=>changePreprocess(current?.rotation??0,e.target.value as "single"|"left"|"right")}><option value="single">分割しない</option><option value="left">左</option><option value="right">右</option></select></label></div><p className="settings-note">見開きスキャンは、下のプリセットで全ページを 90° 時計回りに回転して左右の論理ページへ分割します。OCR 済みページは保護されます。OCR を実行した後は、座標を保つため DPI を固定します。</p><button className="secondary" onClick={applySpreadPreset}>見開き原稿プリセットを適用</button><div className="modal-actions"><button className="primary" onClick={close}>完了</button></div></div></div>}
