import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { allLines, type DocumentPage } from "./domain";
import { readablePageContent, readablePageStyles } from "./readableHtml";
import "./ReaderView.css";

export type ReaderEntry = { id: string; label: string; status: string };
type LoadPage = (id: string) => Promise<DocumentPage | null>;
type LoadImages = (page: DocumentPage, signal: AbortSignal) => Promise<Record<string, string>>;

function ReaderPage({ entry, root, loadPage, loadImages }: {
  entry: ReaderEntry; root: RefObject<HTMLDivElement>; loadPage: LoadPage; loadImages: LoadImages;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [page, setPage] = useState<DocumentPage | null>();
  const [images, setImages] = useState<Record<string, string>>();
  const [error, setError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), {
      root: root.current, rootMargin: "1000px 0px",
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!near || page !== undefined) return;
    let active = true;
    setError(false);
    loadPage(entry.id).then(value => { if (active) setPage(value); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [near, page, entry.id, loadPage, retry]);
  useEffect(() => {
    if (!near || !page?.figureRegions?.length) { setImages(undefined); return; }
    const controller = new AbortController();
    setImageError(false);
    loadImages(page, controller.signal).then(value => {
      if (!controller.signal.aborted) setImages(value);
    }, () => { if (!controller.signal.aborted) setImageError(true); });
    return () => controller.abort();
  }, [near, page, loadImages, retry]);
  const content = useMemo(() => page ? readablePageContent(page, images, t(imageError ? "reader.imagesFailed" : "reader.imagesLoading")) : "", [page, images, imageError, t]);
  const empty = page && !page.figureRegions?.length && !allLines(page).some(line => (line.correctedText ?? "").trim());
  return (
    <div ref={element} className="reader-page-content">
      {error ? <div className="reader-message" role="alert">{t("reader.loadFailed")} <button onClick={() => setRetry(value => value + 1)}>{t("reader.retry")}</button></div>
        : page === undefined ? <div className="reader-message">{t("reader.loading")}</div>
        : page === null ? <div className="reader-message">{t(entry.status === "review" ? "reader.empty" : "reader.pending")}</div>
        : <>
          {empty && <div className="reader-message">{t("reader.empty")}</div>}
          <div className="reader-content" dangerouslySetInnerHTML={{ __html: content }} />
          {imageError && <div className="reader-message" role="alert">{t("reader.imagesFailed")} <button onClick={() => setRetry(value => value + 1)}>{t("reader.retry")}</button></div>}
        </>}
    </div>
  );
}

export function ReaderView({ pages, jump, fontSize, loadPage, loadImages, onActivePage }: {
  pages: ReaderEntry[]; jump: { index: number; serial: number }; fontSize: number;
  loadPage: LoadPage; loadImages: LoadImages; onActivePage: (index: number) => void;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const documentRef = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);
  const target = useRef<number | null>(jump.index);
  const frame = useRef(0);
  const lastActive = useRef(-1);
  // PDF reconstruction is expensive. Serialize image work and release images
  // when their page leaves the nearby range; text stays cached for this visit.
  const imageQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queuedImages = useCallback<LoadImages>((page, signal) => {
    const task = imageQueue.current.catch(() => undefined).then(() => {
      signal.throwIfAborted();
      return loadImages(page, signal);
    });
    imageQueue.current = task;
    return task;
  }, [loadImages]);
  const report = useCallback((index: number) => {
    if (index >= 0 && index !== lastActive.current) { lastActive.current = index; onActivePage(index); }
  }, [onActivePage]);
  const alignTarget = useCallback(() => {
    const stage = root.current;
    const section = target.current === null ? null : sections.current[target.current];
    if (stage && section) stage.scrollTop += section.getBoundingClientRect().top - stage.getBoundingClientRect().top - 24;
  }, []);
  const trackPage = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (target.current !== null || !root.current) return;
      const top = root.current.getBoundingClientRect().top + 40;
      let low = 0, high = pages.length - 1, active = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if ((sections.current[middle]?.getBoundingClientRect().top ?? Infinity) <= top) { active = middle; low = middle + 1; }
        else high = middle - 1;
      }
      report(active);
    });
  }, [pages.length, report]);
  useLayoutEffect(() => {
    target.current = jump.index;
    alignTarget();
    report(jump.index);
  }, [jump, alignTarget, report]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { alignTarget(); trackPage(); });
    if (documentRef.current) observer.observe(documentRef.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0; };
  }, [alignTarget, trackPage]);
  const unlock = () => { target.current = null; trackPage(); };
  return (
    <div className="reader-stage" ref={root} tabIndex={0} role="region" aria-label={t("reader.reading")}
      onScroll={trackPage} onWheel={unlock} onPointerDown={unlock} onKeyDown={unlock}>
      <style>{readablePageStyles(".reader-content")}</style>
      <div className="reader-document" ref={documentRef} style={{ fontSize }}>
        {pages.map((entry, index) => <section className="reader-page" key={entry.id}
          ref={node => { sections.current[index] = node; }} aria-label={t("ui.page", { page: entry.label })}>
          <header className="reader-page-label">{entry.label}</header>
          <ReaderPage entry={entry} root={root} loadPage={loadPage} loadImages={queuedImages} />
        </section>)}
      </div>
    </div>
  );
}
