/**
 * Forge AI — rag.ts
 * Retrieval-augmented generation for the study chat.
 *
 *   upload → extract text → chunk → embed → store (IndexedDB, per study plan)
 *   question → embed → cosine top-k → passages sent to the model with the question
 *
 * Everything is stored in the browser (IndexedDB): private to the device, no database
 * setup, and a plan loaded from History keeps its index. Vectors are unit length, so
 * cosine similarity is a dot product; a few hundred chunks search in well under a ms.
 */
import { apiEmbedTexts, apiExtractDocumentText } from './api';
import type { RetrievedPassage } from './api';

// ── Types ────────────────────────────────────────────────────
export type RagSource = { name: string; file?: File; text?: string };

export type RagProgress = {
  phase: 'reading' | 'embedding';
  done: number;
  total: number;
};

export type IndexResult = {
  chunks: number;
  indexedFiles: string[];
  failedFiles: string[];
};

type StoredChunk = {
  id: string;
  planId: string;
  source: string;
  page?: number;
  text: string;
  embedding: Float32Array;
};

type DraftChunk = { text: string; page?: number };

// ── Tunables ─────────────────────────────────────────────────
const CHUNK_SIZE = 900;      // characters (~200 tokens)
const CHUNK_OVERLAP = 150;   // keeps sentences that straddle a boundary retrievable
const MIN_CHUNK = 40;        // ignore scraps
const TOP_K = 5;
const MIN_SCORE = 0.4;       // cosine floor; below this a passage is treated as unrelated

// ── Chunking ─────────────────────────────────────────────────
/**
 * Splits text into ~CHUNK_SIZE pieces on line boundaries, never across a page marker
 * ("[Page N]" lines emitted by text extraction), remembering each chunk's page.
 */
export const chunkDocument = (text: string): DraftChunk[] => {
  const out: DraftChunk[] = [];
  let page: number | undefined;
  let buf = '';
  let bufPage: number | undefined;

  const push = (t: string, p: number | undefined) => {
    const trimmed = t.trim();
    if (trimmed.length >= MIN_CHUNK) out.push({ text: trimmed, page: p });
  };
  const flush = () => { push(buf, bufPage); buf = ''; };
  const flushWithOverlap = () => {
    const tail = buf.length > CHUNK_OVERLAP ? buf.slice(-CHUNK_OVERLAP) : '';
    push(buf, bufPage);
    buf = tail;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const marker = line.match(/^\[Page\s+(\d+)\]$/i);
    if (marker) { flush(); page = Number(marker[1]); continue; }

    if (line.length > CHUNK_SIZE) {
      // One enormous line (e.g. an unbroken transcript): hard-split with overlap.
      flush();
      for (let i = 0; i < line.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        push(line.slice(i, i + CHUNK_SIZE), page);
        if (i + CHUNK_SIZE >= line.length) break;
      }
      continue;
    }

    if (buf && buf.length + line.length + 1 > CHUNK_SIZE) flushWithOverlap();
    if (!buf) bufPage = page;
    buf += (buf ? '\n' : '') + line;
  }
  flush();
  return out;
};

// ── IndexedDB ────────────────────────────────────────────────
const DB_NAME = 'forgeai-rag';
const STORE = 'chunks';

let dbPromise: Promise<IDBDatabase> | null = null;
const openDb = (): Promise<IDBDatabase> => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('planId', 'planId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
};

const tx = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

// Loaded plans stay in memory so each question only pays for one query embedding.
const cache = new Map<string, StoredChunk[]>();

const loadChunks = async (planId: string): Promise<StoredChunk[]> => {
  const hit = cache.get(planId);
  if (hit) return hit;
  const rows = (await tx<StoredChunk[]>('readonly', s => s.index('planId').getAll(planId))) ?? [];
  if (rows.length) cache.set(planId, rows);
  return rows;
};

export const deleteIndex = async (planId: string): Promise<void> => {
  cache.delete(planId);
  try {
    const ids = (await tx<IDBValidKey[]>('readonly', s => s.index('planId').getAllKeys(planId))) ?? [];
    if (!ids.length) return;
    await tx('readwrite', s => { ids.forEach(id => s.delete(id)); });
  } catch { /* storage unavailable — nothing to clean */ }
};

export const clearAllIndexes = async (): Promise<void> => {
  cache.clear();
  try { await tx('readwrite', s => s.clear()); } catch { /* ignore */ }
};

export const hasIndex = async (planId: string): Promise<number> => {
  try { return (await loadChunks(planId)).length; } catch { return 0; }
};

// ── Indexing ─────────────────────────────────────────────────
export const indexSources = async (
  planId: string,
  sources: RagSource[],
  onProgress?: (p: RagProgress) => void
): Promise<IndexResult> => {
  const failedFiles: string[] = [];
  const indexedFiles: string[] = [];
  const drafts: { source: string; page?: number; text: string }[] = [];

  // 1) Read every source (PDFs/images/audio are transcribed by Gemini, in parallel)
  let read = 0;
  onProgress?.({ phase: 'reading', done: 0, total: sources.length });
  await Promise.all(sources.map(async src => {
    try {
      const text = src.text ?? (src.file ? await apiExtractDocumentText(src.file) : '');
      const pieces = chunkDocument(text);
      if (!pieces.length) throw new Error('no text found');
      for (const p of pieces) drafts.push({ source: src.name, ...p });
      indexedFiles.push(src.name);
    } catch (e) {
      console.warn(`RAG: could not read "${src.name}":`, e);
      failedFiles.push(src.name);
    } finally {
      onProgress?.({ phase: 'reading', done: ++read, total: sources.length });
    }
  }));

  if (!drafts.length) return { chunks: 0, indexedFiles, failedFiles };

  // 2) Embed all chunks
  onProgress?.({ phase: 'embedding', done: 0, total: drafts.length });
  const vectors = await apiEmbedTexts(
    drafts.map(d => d.text),
    'RETRIEVAL_DOCUMENT',
    done => onProgress?.({ phase: 'embedding', done, total: drafts.length })
  );

  // 3) Replace any previous index for this plan
  const rows: StoredChunk[] = drafts.map((d, i) => ({
    id: `${planId}:${i}`, planId, source: d.source, page: d.page, text: d.text, embedding: vectors[i],
  }));
  await deleteIndex(planId);
  await tx('readwrite', s => { rows.forEach(r => s.put(r)); });
  cache.set(planId, rows);

  return { chunks: rows.length, indexedFiles, failedFiles };
};

// ── Retrieval ────────────────────────────────────────────────
const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
};

export const retrieve = async (planId: string, query: string, k = TOP_K): Promise<RetrievedPassage[]> => {
  const chunks = await loadChunks(planId);
  if (!chunks.length || !query.trim()) return [];

  const [q] = await apiEmbedTexts([query], 'RETRIEVAL_QUERY');
  return chunks
    .map(c => ({ c, score: dot(q, c.embedding) }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c }) => ({
      source: c.page ? `${c.source}, p. ${c.page}` : c.source,
      text: c.text,
    }));
};
