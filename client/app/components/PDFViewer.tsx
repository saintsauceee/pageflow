'use client';

import { useState, useCallback, useRef, useLayoutEffect, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const ZOOM_FACTOR = Math.pow(2, 1 / 3);
const RENDER_BUFFER = 2;
const MAX_HISTORY = 50;

const HIGHLIGHT_COLORS = [
  { id: 'yellow', bg: 'rgba(250, 204, 21, 0.45)',  dot: '#fbbf24' },
  { id: 'green',  bg: 'rgba(74, 222, 128, 0.4)',   dot: '#4ade80' },
  { id: 'blue',   bg: 'rgba(96, 165, 250, 0.4)',   dot: '#60a5fa' },
  { id: 'pink',   bg: 'rgba(244, 114, 182, 0.4)',  dot: '#f472b6' },
  { id: 'purple', bg: 'rgba(167, 139, 250, 0.4)',  dot: '#a78bfa' },
] as const;

type HighlightColor = typeof HIGHLIGHT_COLORS[number];
type ActiveTool = 'highlight' | 'eraser' | null;

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Highlight {
  id: string;
  pageNum: number;
  rects: HighlightRect[];
  captureScale: number;
  color: string;
}

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
  const [activeTool, setActiveTool] = useState<ActiveTool>(null);
  const [activeColor, setActiveColor] = useState<HighlightColor>(HIGHLIGHT_COLORS[0]);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [highlights, setHighlights] = useState<Highlight[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(`pageflow:hl:${name}`);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  });
  // Undo / redo stacks — session-only, not persisted
  const [past,   setPast]   = useState<Highlight[][]>([]);
  const [future, setFuture] = useState<Highlight[][]>([]);
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    placement: 'above' | 'below';
    range: Range;
  } | null>(null);
  const [menuColor,       setMenuColor]       = useState<HighlightColor>(HIGHLIGHT_COLORS[0]);
  const [showMenuPalette, setShowMenuPalette] = useState(false);

  const containerRef      = useRef<HTMLDivElement>(null);
  const pickerRef         = useRef<HTMLDivElement>(null);
  const selectionMenuRef  = useRef<HTMLDivElement>(null);
  const menuColorRef      = useRef<HTMLDivElement>(null);
  const wrapperEls   = useRef<Map<number, HTMLDivElement>>(new Map());
  const stableRefs   = useRef<Map<number, (el: HTMLDivElement | null) => void>>(new Map());
  const intersecting = useRef<Set<number>>(new Set());
  const visible      = useRef<Set<number>>(new Set());
  const unscaledHeight = useRef<number | null>(null);

  // Persist highlights to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(`pageflow:hl:${name}`, JSON.stringify(highlights));
    } catch { /* ignore quota errors */ }
  }, [highlights, name]);

  // Reload highlights + reset history when switching documents
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`pageflow:hl:${name}`);
      setHighlights(raw ? JSON.parse(raw) : []);
    } catch { setHighlights([]); }
    setPast([]);
    setFuture([]);
  }, [name]);

  // Color-picker dismiss
  useEffect(() => {
    if (!showColorPicker) return;
    const close = (e: MouseEvent) => {
      if (pickerRef.current?.contains(e.target as Node)) return;
      setShowColorPicker(false);
    };
    const id = setTimeout(() => document.addEventListener('click', close), 0);
    return () => { clearTimeout(id); document.removeEventListener('click', close); };
  }, [showColorPicker]);

  // Selection menu — dismiss on outside mousedown
  useEffect(() => {
    if (!selectionMenu) return;
    const dismiss = (e: MouseEvent) => {
      if (selectionMenuRef.current?.contains(e.target as Node)) return;
      setSelectionMenu(null);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [selectionMenu]);

  // Selection menu — dismiss on scroll
  useEffect(() => {
    if (!selectionMenu || !containerRef.current) return;
    const el = containerRef.current;
    const dismiss = () => setSelectionMenu(null);
    el.addEventListener('scroll', dismiss);
    return () => el.removeEventListener('scroll', dismiss);
  }, [selectionMenu]);

  // Selection menu — dismiss when a tool is activated
  useEffect(() => {
    if (activeTool !== null) setSelectionMenu(null);
  }, [activeTool]);

  // Collapse palette whenever the selection menu closes
  useEffect(() => {
    if (!selectionMenu) setShowMenuPalette(false);
  }, [selectionMenu]);

  // Dismiss menu color popover on outside click
  useEffect(() => {
    if (!showMenuPalette) return;
    const dismiss = (e: MouseEvent) => {
      if (menuColorRef.current?.contains(e.target as Node)) return;
      setShowMenuPalette(false);
    };
    const id = setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', dismiss); };
  }, [showMenuPalette]);

  // Pinch-to-zoom / Ctrl+scroll zoom (non-passive so preventDefault works)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let rafId: number | null = null;
    let pendingFactor = 1;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // Clamp per-event delta so scroll wheel doesn't jump too far
      const delta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 25);
      pendingFactor *= Math.exp(-delta / 100);
      // Batch into one state update per animation frame for smoothness
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          setScale((s) => Math.min(4, Math.max(0.25, s * pendingFactor)));
          pendingFactor = 1;
          rafId = null;
        });
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // ── History helpers ───────────────────────────────────────────────────────

  /** Call before every mutation. Saves current highlights and clears redo stack. */
  const commit = useCallback((next: Highlight[]) => {
    setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), highlights]);
    setFuture([]);
    setHighlights(next);
  }, [highlights]);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [highlights, ...f]);
    setHighlights(previous);
  }, [past, highlights]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, highlights]);
    setHighlights(next);
  }, [future, highlights]);

  // Keyboard shortcuts: ⌘Z / Ctrl+Z  →  undo
  //                     ⌘⇧Z / Ctrl+Y →  redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); redo(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // ─────────────────────────────────────────────────────────────────────────

  const zoomIn  = () => setScale((s) => Math.min(4, s * ZOOM_FACTOR));
  const zoomOut = () => setScale((s) => Math.max(0.25, s / ZOOM_FACTOR));

  const scrollToPage = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(numPages, page));
    wrapperEls.current.get(clamped)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [numPages]);

  const goToPrev = () => scrollToPage(currentPage - 1);
  const goToNext = () => scrollToPage(currentPage + 1);

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

  // ── Highlight ─────────────────────────────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    if (activeTool === 'eraser') return;

    const selection = window.getSelection();

    if (activeTool === 'highlight') {
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      const clientRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 1 && r.height > 1,
      );
      if (clientRects.length === 0) return;

      const pageRects = new Map<number, HighlightRect[]>();
      for (const rect of clientRects) {
        for (const [pageNum, el] of wrapperEls.current) {
          const elRect = el.getBoundingClientRect();
          const centerY = rect.top + rect.height / 2;
          if (centerY >= elRect.top && centerY <= elRect.bottom) {
            if (!pageRects.has(pageNum)) pageRects.set(pageNum, []);
            pageRects.get(pageNum)!.push({
              top:    rect.top  - elRect.top,
              left:   rect.left - elRect.left,
              width:  rect.width,
              height: rect.height,
            });
            break;
          }
        }
      }
      if (pageRects.size === 0) return;

      const newHighlights: Highlight[] = [...highlights];
      for (const [pageNum, rects] of pageRects) {
        newHighlights.push({
          id: `hl-${Date.now()}-${pageNum}`,
          pageNum, rects,
          captureScale: scale,
          color: activeColor.bg,
        });
      }
      commit(newHighlights);
      window.getSelection()?.removeAllRanges();
      return;
    }

    // activeTool === null: show floating selection menu
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionMenu(null);
      return;
    }

    const range = selection.getRangeAt(0);
    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width === 0 && boundingRect.height === 0) {
      setSelectionMenu(null);
      return;
    }

    const x = boundingRect.left + boundingRect.width / 2;
    const placement: 'above' | 'below' = boundingRect.top > 60 ? 'above' : 'below';
    const y = placement === 'above' ? boundingRect.top - 8 : boundingRect.bottom + 8;

    setSelectionMenu({ x, y, placement, range: range.cloneRange() });
  }, [activeTool, activeColor, scale, highlights, commit]);

  const applyHighlightFromMenu = useCallback((color: HighlightColor) => {
    if (!selectionMenu) return;

    const range = selectionMenu.range;
    const clientRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 1 && r.height > 1,
    );
    if (clientRects.length === 0) { setSelectionMenu(null); return; }

    const pageRects = new Map<number, HighlightRect[]>();
    for (const rect of clientRects) {
      for (const [pageNum, el] of wrapperEls.current) {
        const elRect = el.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;
        if (centerY >= elRect.top && centerY <= elRect.bottom) {
          if (!pageRects.has(pageNum)) pageRects.set(pageNum, []);
          pageRects.get(pageNum)!.push({
            top:    rect.top  - elRect.top,
            left:   rect.left - elRect.left,
            width:  rect.width,
            height: rect.height,
          });
          break;
        }
      }
    }

    if (pageRects.size > 0) {
      const newHighlights: Highlight[] = [...highlights];
      for (const [pageNum, rects] of pageRects) {
        newHighlights.push({
          id: `hl-${Date.now()}-${pageNum}`,
          pageNum, rects,
          captureScale: scale,
          color: color.bg,
        });
      }
      commit(newHighlights);
    }

    window.getSelection()?.removeAllRanges();
    setSelectionMenu(null);
  }, [selectionMenu, highlights, scale, commit]);

  // ── Eraser ────────────────────────────────────────────────────────────────

  const handleEraserClick = useCallback((e: React.MouseEvent) => {
    if (activeTool !== 'eraser') return;

    const cx = e.clientX;
    const cy = e.clientY;

    for (const [pageNum, el] of wrapperEls.current) {
      const elRect = el.getBoundingClientRect();
      if (cx < elRect.left || cx > elRect.right || cy < elRect.top || cy > elRect.bottom) continue;

      const relX = cx - elRect.left;
      const relY = cy - elRect.top;

      const hit = highlights.find(
        (h) =>
          h.pageNum === pageNum &&
          h.rects.some((r) => {
            const t  = r.top    * (scale / h.captureScale);
            const l  = r.left   * (scale / h.captureScale);
            const w  = r.width  * (scale / h.captureScale);
            const ht = r.height * (scale / h.captureScale);
            return relX >= l && relX <= l + w && relY >= t && relY <= t + ht;
          }),
      );

      if (hit) {
        commit(highlights.filter((h) => h.id !== hit.id));
        break;
      }
    }
  }, [activeTool, highlights, scale, commit]);

  // ─────────────────────────────────────────────────────────────────────────

  const phWidth  = Math.round(scale * 612);
  const phHeight = unscaledHeight.current != null
    ? Math.round(unscaledHeight.current * scale)
    : Math.round(scale * 792);

  const inputW = `${Math.max(2, String(numPages).length) + 1}ch`;

  const containerCursor =
    activeTool === 'highlight' ? ' cursor-text' :
    activeTool === 'eraser'    ? ' cursor-crosshair' : '';

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* ── Top bar ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-white/10 bg-[#16161e] shrink-0 min-w-0">
        <svg className="w-4 h-4 text-violet-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" />
        </svg>
        <span className="text-sm font-medium text-white/90 truncate">{name}</span>
      </div>

      {/* ── Scroll area + floating toolbar ──────────────────────── */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={containerRef}
          className={`h-full overflow-y-auto bg-[#0d0d12]${containerCursor}`}
          onMouseUp={handleMouseUp}
          onClick={handleEraserClick}
        >
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
                <div
                  key={pageNum}
                  ref={getWrapperRef(pageNum)}
                  data-page={pageNum}
                  className="relative"
                >
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

                  {highlights
                    .filter((h) => h.pageNum === pageNum)
                    .map((h) =>
                      h.rects.map((rect, i) => (
                        <div
                          key={`${h.id}-${i}`}
                          className="absolute"
                          style={{
                            top:    rect.top    * (scale / h.captureScale),
                            left:   rect.left   * (scale / h.captureScale),
                            width:  rect.width  * (scale / h.captureScale),
                            height: rect.height * (scale / h.captureScale),
                            background: h.color,
                            pointerEvents: activeTool === 'eraser' ? 'auto' : 'none',
                            zIndex: 5,
                          }}
                        />
                      )),
                    )}
                </div>
              ))}
            </div>
          </Document>
        </div>

        {/* ── Selection floating menu ───────────────────────────── */}
        {selectionMenu && (
          <div
            ref={selectionMenuRef}
            className="fixed z-50 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-[#1c1c28]/95 backdrop-blur-xl border border-white/10 shadow-xl shadow-black/50"
            style={{
              left: selectionMenu.x,
              top:  selectionMenu.y,
              transform: `translateX(-50%)${selectionMenu.placement === 'above' ? ' translateY(-100%)' : ''}`,
            }}
          >
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                window.getSelection()?.removeAllRanges();
                setSelectionMenu(null);
              }}
              title="Ask AI"
              className="flex items-center gap-1 px-2 h-6 rounded-lg text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 transition-all text-[11px] font-medium"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
              </svg>
              Ask
            </button>
            <div className="w-px h-4 bg-white/15 mx-0.5" />
            {/* Color trigger + popover */}
            <div ref={menuColorRef} className="relative">
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowMenuPalette((v) => !v)}
                title="Choose highlight color"
                className="flex items-center gap-1.5 px-2 h-7 rounded-lg hover:bg-white/8 transition-all"
              >
                <span
                  className="w-4 h-4 rounded-full"
                  style={{ background: menuColor.dot, boxShadow: `0 0 0 1.5px #1c1c28, 0 0 0 2.5px ${menuColor.dot}` }}
                />
                <svg
                  className="w-2.5 h-2.5 text-white/40"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
                  strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: showMenuPalette ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}
                >
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
              {showMenuPalette && (
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-[#1c1c28]/95 backdrop-blur-xl border border-white/10 shadow-xl shadow-black/50">
                  {HIGHLIGHT_COLORS.map((color) => (
                    <button
                      key={color.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setMenuColor(color); setShowMenuPalette(false); applyHighlightFromMenu(color); }}
                      title={`Highlight ${color.id}`}
                      className="w-5 h-5 rounded-full hover:scale-110 active:scale-95 transition-transform"
                      style={{
                        background: color.dot,
                        boxShadow: menuColor.id === color.id
                          ? `0 0 0 2px #1c1c28, 0 0 0 3.5px ${color.dot}`
                          : '0 0 0 1.5px rgba(255,255,255,0.12)',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="w-px h-4 bg-white/15 mx-0.5" />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const text = selectionMenu.range.toString();
                if (text) navigator.clipboard.writeText(text);
                window.getSelection()?.removeAllRanges();
                setSelectionMenu(null);
              }}
              title="Copy"
              className="w-6 h-6 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 transition-all"
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
              </svg>
            </button>
          </div>
        )}

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
              >−</button>

              {/* Zoom level */}
              <span className="text-xs text-white/45 tabular-nums w-9 text-center">
                {Math.round(scale * 100)}%
              </span>

              {/* Zoom in */}
              <button
                onClick={zoomIn}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 transition-all text-base leading-none"
              >+</button>

              {/* Divider */}
              <div className="w-px h-4 bg-white/12 mx-1.5" />

              {/* ── Highlighter ──────────────────────────────────── */}
              <div className="relative flex items-center">
                <button
                  onClick={() => { setActiveTool((t) => t === 'highlight' ? null : 'highlight'); setShowColorPicker(false); }}
                  title={activeTool === 'highlight' ? 'Disable highlighter' : 'Highlight text'}
                  className={`relative w-7 h-7 flex items-center justify-center rounded-lg transition-all ${
                    activeTool === 'highlight'
                      ? 'bg-yellow-400/15 text-yellow-300'
                      : 'text-white/50 hover:text-white/90 hover:bg-white/8'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 11-6 6v3h9l3-3"/>
                    <path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
                  </svg>
                  <span
                    className="absolute bottom-1 left-1/2 -translate-x-1/2 w-2 h-0.5 rounded-full"
                    style={{ background: activeColor.dot }}
                  />
                </button>

                {/* Chevron */}
                <button
                  onClick={() => setShowColorPicker((m) => !m)}
                  className="w-3 h-7 flex items-center justify-center text-white/25 hover:text-white/60 transition-all"
                >
                  <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                </button>

                {/* Color palette popup */}
                {showColorPicker && (
                  <div
                    ref={pickerRef}
                    className="absolute bottom-full mb-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-[#1c1c28]/95 backdrop-blur-xl border border-white/10 shadow-xl shadow-black/50 z-20"
                  >
                    {HIGHLIGHT_COLORS.map((color) => (
                      <button
                        key={color.id}
                        onClick={() => { setActiveColor(color); setShowColorPicker(false); }}
                        title={color.id}
                        className="w-5 h-5 rounded-full hover:scale-110 active:scale-95 transition-transform"
                        style={{
                          background: color.dot,
                          boxShadow: activeColor.id === color.id
                            ? `0 0 0 2px #1c1c28, 0 0 0 3.5px ${color.dot}`
                            : '0 0 0 1.5px rgba(255,255,255,0.12)',
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* ── Eraser ───────────────────────────────────────── */}
              <button
                onClick={() => setActiveTool((t) => t === 'eraser' ? null : 'eraser')}
                title={activeTool === 'eraser' ? 'Disable eraser' : 'Erase highlight'}
                className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all ${
                  activeTool === 'eraser'
                    ? 'bg-rose-400/15 text-rose-300'
                    : 'text-white/50 hover:text-white/90 hover:bg-white/8'
                }`}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/>
                  <path d="M22 21H7"/>
                  <path d="m5 11 9 9"/>
                </svg>
              </button>

              {/* Divider */}
              <div className="w-px h-4 bg-white/12 mx-1.5" />

              {/* ── Undo ─────────────────────────────────────────── */}
              <button
                onClick={undo}
                disabled={!canUndo}
                title="Undo (⌘Z)"
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 14 4 9l5-5"/>
                  <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>
                </svg>
              </button>

              {/* ── Redo ─────────────────────────────────────────── */}
              <button
                onClick={redo}
                disabled={!canRedo}
                title="Redo (⌘⇧Z)"
                className="w-7 h-7 flex items-center justify-center rounded-lg text-white/50 hover:text-white/90 hover:bg-white/8 disabled:opacity-25 disabled:cursor-not-allowed transition-all"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="m15 14 5-5-5-5"/>
                  <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/>
                </svg>
              </button>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}
