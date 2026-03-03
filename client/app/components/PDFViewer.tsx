'use client';

import { useState, useCallback, useRef, useLayoutEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const ZOOM_FACTOR = Math.pow(2, 1 / 3);
const RENDER_BUFFER = 2;

interface PDFViewerProps {
  url: string;
  name: string;
}

export default function PDFViewer({ url, name }: PDFViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set([1, 2, 3]));

  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const stableRefs = useRef<Map<number, (el: HTMLDivElement | null) => void>>(new Map());
  const intersecting = useRef<Set<number>>(new Set());
  const visible = useRef<Set<number>>(new Set());
  const unscaledHeight = useRef<number | null>(null);

  const zoomIn  = () => setScale((s) => Math.min(4, s * ZOOM_FACTOR));
  const zoomOut = () => setScale((s) => Math.max(0.25, s / ZOOM_FACTOR));

  const scrollToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(numPages, page));
    wrapperEls.current.get(clamped)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [numPages]);

  const goToPrev = () => scrollToPage(currentPage - 1);
  const goToNext = () => scrollToPage(currentPage + 1);

  // Keep input in sync with tracked page unless the user is actively editing
  const commitPageInput = () => {
    const parsed = parseInt(pageInput, 10);
    if (!isNaN(parsed)) scrollToPage(parsed);
    else setPageInput(String(currentPage));
  };

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setCurrentPage(1);
    setPageInput('1');
    setRenderedPages(new Set([1, 2, 3]));
    intersecting.current.clear();
    visible.current.clear();
    unscaledHeight.current = null;
  }, []);

  const getWrapperRef = useCallback((page: number) => {
    if (!stableRefs.current.has(page)) {
      stableRefs.current.set(page, (el: HTMLDivElement | null) => {
        if (el) wrapperEls.current.set(page, el);
        else wrapperEls.current.delete(page);
      });
    }
    return stableRefs.current.get(page)!;
  }, []);

  useLayoutEffect(() => {
    if (!numPages || !containerRef.current) return;

    const ioRender = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const page = Number(entry.target.getAttribute('data-page'));
          if (entry.isIntersecting) intersecting.current.add(page);
          else intersecting.current.delete(page);
        });
        if (intersecting.current.size === 0) return;
        const pages = [...intersecting.current];
        const lo = Math.max(1, Math.min(...pages) - RENDER_BUFFER);
        const hi = Math.min(numPages, Math.max(...pages) + RENDER_BUFFER);
        setRenderedPages((prev) => {
          const next = new Set<number>();
          for (let p = lo; p <= hi; p++) next.add(p);
          if (next.size === prev.size && [...next].every((p) => prev.has(p))) return prev;
          return next;
        });
      },
      { root: containerRef.current, rootMargin: '100% 0px', threshold: 0 },
    );

    const ioTrack = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const page = Number(entry.target.getAttribute('data-page'));
          if (entry.isIntersecting) visible.current.add(page);
          else visible.current.delete(page);
        });
        if (visible.current.size === 0) return;
        const p = Math.min(...visible.current);
        setCurrentPage(p);
        setPageInput(String(p));
      },
      { root: containerRef.current, rootMargin: '0px', threshold: 0 },
    );

    wrapperEls.current.forEach((el) => { ioRender.observe(el); ioTrack.observe(el); });
    return () => { ioRender.disconnect(); ioTrack.disconnect(); };
  }, [numPages]);

  const onFirstPageRender = useCallback((pageNum: number, capturedScale: number) => {
    if (unscaledHeight.current !== null) return;
    const el = wrapperEls.current.get(pageNum);
    if (el && el.offsetHeight > 0) unscaledHeight.current = el.offsetHeight / capturedScale;
  }, []);

  const phWidth  = Math.round(scale * 612);
  const phHeight = unscaledHeight.current != null
    ? Math.round(unscaledHeight.current * scale)
    : Math.round(scale * 792);

  const inputW = `${Math.max(2, String(numPages).length) + 1}ch`;

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar (filename only) ──────────────────────────────── */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10 bg-[#16161e] shrink-0 min-w-0">
        <svg className="w-4 h-4 text-violet-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" />
        </svg>
        <span className="text-sm font-medium text-white/90 truncate">{name}</span>
      </div>

      {/* ── Scroll area + floating toolbar ──────────────────────── */}
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="h-full overflow-y-auto bg-[#0d0d12]">
          <Document
            file={url}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={
              <div className="flex flex-col items-center justify-center h-64 gap-3">
                <div className="w-8 h-8 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin" />
                <span className="text-sm text-white/50">Loading document…</span>
              </div>
            }
            error={
              <div className="flex flex-col items-center justify-center h-64">
                <span className="text-red-400/60 text-sm">Failed to load PDF</span>
              </div>
            }
          >
            <div className="py-8 pb-24 flex flex-col items-center gap-6">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                <div key={pageNum} ref={getWrapperRef(pageNum)} data-page={pageNum}>
                  {renderedPages.has(pageNum) ? (
                    <Page
                      pageNumber={pageNum}
                      scale={scale}
                      onRenderSuccess={() => onFirstPageRender(pageNum, scale)}
                      renderTextLayer
                      renderAnnotationLayer
                      className="shadow-2xl shadow-black/60 rounded-sm"
                    />
                  ) : (
                    <div style={{ width: phWidth, height: phHeight }} className="bg-white/3 rounded-sm" />
                  )}
                </div>
              ))}
            </div>
          </Document>
        </div>

        {/* ── Floating toolbar ──────────────────────────────────── */}
        {numPages > 0 && (
          <div className="pointer-events-none absolute bottom-6 inset-x-0 flex justify-center z-10">
            <div className="pointer-events-auto flex items-center gap-0.5 px-2 py-1.5 rounded-2xl bg-[#1c1c28]/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50">

              {/* Prev */}
              <button
                onClick={goToPrev}
                disabled={currentPage <= 1}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              {/* Page input */}
              <div className="flex items-center gap-1.5 px-1">
                <input
                  type="number"
                  min={1}
                  max={numPages}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={commitPageInput}
                  onKeyDown={(e) => { if (e.key === 'Enter') { commitPageInput(); (e.target as HTMLInputElement).blur(); } }}
                  style={{ width: inputW }}
                  className="bg-white/6 border border-white/10 rounded-lg py-0.5 text-center text-xs text-white/80 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 tabular-nums"
                />
                <span className="text-xs text-white/30 tabular-nums">/ {numPages}</span>
              </div>

              {/* Next */}
              <button
                onClick={goToNext}
                disabled={currentPage >= numPages}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>

              {/* Divider */}
              <div className="w-px h-4 bg-white/12 mx-1.5" />

              {/* Zoom out */}
              <button
                onClick={zoomOut}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 transition-all text-base leading-none"
              >
                −
              </button>

              {/* Zoom level */}
              <span className="text-xs text-white/45 tabular-nums w-9 text-center">
                {Math.round(scale * 100)}%
              </span>

              {/* Zoom in */}
              <button
                onClick={zoomIn}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 transition-all text-base leading-none"
              >
                +
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
