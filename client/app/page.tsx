'use client';

import { useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';

const PDFViewer = dynamic(() => import('./components/PDFViewer'), { ssr: false });

interface PDFDoc {
  id: string;
  name: string;
  url: string;
  size: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Home() {
  const [docs, setDocs] = useState<PDFDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const newDocs: PDFDoc[] = [];
    for (const file of Array.from(files)) {
      if (file.type !== 'application/pdf') continue;
      const url = URL.createObjectURL(file);
      const doc: PDFDoc = {
        id: `${Date.now()}-${Math.random()}`,
        name: file.name.replace(/\.pdf$/i, ''),
        url,
        size: formatBytes(file.size),
      };
      newDocs.push(doc);
    }
    if (newDocs.length > 0) {
      setDocs((prev) => {
        const updated = [...newDocs, ...prev];
        return updated;
      });
      setActiveId(newDocs[0].id);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = () => setDragging(false);

  const removeDoc = (id: string) => {
    setDocs((prev) => {
      const updated = prev.filter((d) => d.id !== id);
      if (activeId === id) {
        setActiveId(updated.length > 0 ? updated[updated.length - 1].id : null);
      }
      return updated;
    });
  };

  const activeDoc = docs.find((d) => d.id === activeId) ?? null;

  return (
    <div className="flex h-screen bg-[#0d0d12] text-white overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`w-72 shrink-0 flex flex-col border-r border-white/10 bg-[#16161e] transition-colors ${
          dragging ? 'border-violet-500/50 bg-violet-500/5' : ''
        }`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center">
              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z" />
              </svg>
            </div>
            <span className="font-semibold text-white/90 tracking-tight">Pageflow</span>
          </div>
        </div>

        {/* Upload button */}
        <div className="px-4 pt-4 pb-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed border-white/15 text-sm text-white/50 hover:text-white/80 hover:border-violet-500/50 hover:bg-violet-500/5 transition-all group"
          >
            <svg
              className="w-4 h-4 group-hover:text-violet-400 transition-colors"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
            </svg>
            Upload PDF
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {/* Drag hint */}
        {dragging && (
          <div className="mx-4 mb-2 py-2 rounded-lg bg-violet-500/10 border border-violet-500/30 text-center text-xs text-violet-400">
            Drop PDFs here
          </div>
        )}

        {/* Document list */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {docs.length === 0 && !dragging && (
            <div className="flex flex-col items-center justify-center h-full gap-3 pb-16 text-center px-4">
              <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-white/35" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <div>
                <p className="text-xs text-white/45 leading-relaxed">No documents yet.</p>
                <p className="text-xs text-white/30">Upload or drag PDFs here.</p>
              </div>
            </div>
          )}

          {docs.map((doc) => (
            <DocCard
              key={doc.id}
              doc={doc}
              active={doc.id === activeId}
              onSelect={() => setActiveId(doc.id)}
              onRemove={() => removeDoc(doc.id)}
            />
          ))}
        </div>

        {/* Footer count */}
        {docs.length > 0 && (
          <div className="px-5 py-3 border-t border-white/10">
            <span className="text-xs text-white/40">
              {docs.length} document{docs.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </aside>

      {/* Main viewer */}
      <main className="flex-1 flex flex-col min-w-0">
        {activeDoc ? (
          <PDFViewer key={activeDoc.id} url={activeDoc.url} name={activeDoc.name} />
        ) : (
          <EmptyState onUpload={() => fileInputRef.current?.click()} />
        )}
      </main>
    </div>
  );
}

function DocCard({
  doc,
  active,
  onSelect,
  onRemove,
}: {
  doc: PDFDoc;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
        active
          ? 'bg-violet-500/15 border border-violet-500/20'
          : 'hover:bg-white/4 border border-transparent'
      }`}
    >
      {/* PDF icon */}
      <div
        className={`shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-xs font-bold mt-0.5 ${
          active ? 'bg-violet-500/30 text-violet-300' : 'bg-white/8 text-white/45'
        }`}
      >
        PDF
      </div>

      {/* Name + size */}
      <div className="flex-1 min-w-0">
        <p
          className={`text-xs font-medium leading-snug truncate ${
            active ? 'text-white/95' : 'text-white/65 group-hover:text-white/85'
          }`}
        >
          {doc.name}
        </p>
        <p className="text-[10px] text-white/40 mt-0.5">{doc.size}</p>
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-white/45 hover:text-red-400 hover:bg-red-400/10 transition-all"
        title="Delete"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        Delete
      </button>
    </div>
  );
}

function EmptyState({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 bg-[#0d0d12]">
      {/* Decorative rings */}
      <div className="relative">
        <div className="w-24 h-24 rounded-full border border-white/10 flex items-center justify-center">
          <div className="w-16 h-16 rounded-full border border-white/10 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center">
              <svg className="w-5 h-5 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-white/85 font-medium text-sm mb-1">No document open</h2>
        <p className="text-white/45 text-xs max-w-48 leading-relaxed">
          Upload a PDF from the sidebar or drag one anywhere to get started.
        </p>
      </div>

      <button
        onClick={onUpload}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600/80 hover:bg-violet-600 text-white text-xs font-medium transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
        Upload PDF
      </button>
    </div>
  );
}
