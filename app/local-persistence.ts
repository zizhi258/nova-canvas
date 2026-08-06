/**
 * Local persistence for Nova Canvas.
 *
 * Storage model (folder-first):
 * - Image binaries live ONLY in the user-authorized local folder, one file per
 *   generation (e.g. `nova-123.png`). The File System Access API is required.
 * - IndexedDB keeps a lightweight `generations` store with metadata only
 *   (prompt, model, params, filename, ...). Records are a few hundred bytes
 *   each, so thousands of them load instantly and never bloat memory.
 * - Artist-thread favorites and the directory handle stay in the `settings`
 *   store, unchanged from before.
 *
 * Legacy records written by the previous model kept the image blob inside
 * IndexedDB. `loadLegacyBlobs` + `migrateLegacyBlob` move those blobs out to
 * the folder and rewrite the record without the blob, flagged `migrated: true`.
 * Until a user runs migration, such records still carry their blob; normal
 * `loadGenerations` strips the blob from the in-memory view so the UI stays
 * light, but the image cannot be displayed until its file exists in the folder.
 */

export type StoredGeneration = {
  id: number;
  artistPrompt: string;
  positivePrompt: string;
  negativePrompt: string;
  model: string;
  size: string;
  createdAt: string;
  filename: string;
  /** Generation parameters captured at enqueue time (absent on older records). */
  seed?: number;
  steps?: number;
  scale?: number;
  sampler?: string;
  durationMs?: number;
  /** Best-effort MIME type remembered so the UI can hint at the format. */
  mimeType?: string;
  /** True once the image file has been written to the local folder. Legacy
   *  records created before the folder-only storage model kept the blob in
   *  IndexedDB; this stays false until migration writes the file out. */
  migrated?: boolean;
};

/**
 * A saved "artist thread" is intentionally kept separate from individual
 * generation records.  Existing databases only contain the generations and
 * settings stores, so favourites can be added as a regular settings value
 * without changing or deleting the existing object stores.
 */
export type ArtistThreadFavorite = {
  /** Stable key derived from the normalized artist prompt. */
  id: string;
  artistPrompt: string;
  /** Optional image id selected as the cover for this thread. */
  coverImageId?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type StoredArtistThreadFavorite = ArtistThreadFavorite;

/** A record as it may exist on disk, including legacy blob/prompt fields. */
type LegacyStoredGeneration = Partial<StoredGeneration> & {
  id: number;
  model: string;
  size: string;
  createdAt: string;
  filename: string;
  /** Legacy inline image binary (pre-migration). */
  blob?: Blob;
  /** Optional legacy merged prompt. New records use the three prompt fields. */
  prompt?: string;
};

type LocalWritable = {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
};

type LocalFileHandle = {
  createWritable(): Promise<LocalWritable>;
  getFile?(): Promise<File>;
};

export type LocalDirectoryHandle = {
  name: string;
  getFileHandle(name: string, options: { create: boolean }): Promise<LocalFileHandle>;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
};

const DATABASE_NAME = "nova-canvas-local";
const DATABASE_VERSION = 1;
const GENERATIONS_STORE = "generations";
const SETTINGS_STORE = "settings";
const ARTIST_THREAD_FAVORITES_SETTING = "artist-thread-favorites";
const LEGACY_ARTIST_FAVORITES_SETTING = "artist-favorites";

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(GENERATIONS_STORE)) {
        database.createObjectStore(GENERATIONS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地数据库。"));
  });
}

async function runRequest<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地数据操作失败。"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error("本地数据写入失败。"));
  });
}

/** Whether the current browser can authorize a local folder for image files. */
export function isFileSystemAccessSupported() {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/**
 * Loads every generation as lightweight metadata. Uses a cursor so legacy
 * records that still carry a blob are normalized (and the blob reference
 * dropped) one at a time, keeping the memory peak low even before migration.
 */
export async function loadGenerations() {
  const database = await openDatabase();
  return new Promise<StoredGeneration[]>((resolve, reject) => {
    const transaction = database.transaction(GENERATIONS_STORE, "readonly");
    const store = transaction.objectStore(GENERATIONS_STORE);
    const records: StoredGeneration[] = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      records.push(normalizeGeneration(cursor.value as LegacyStoredGeneration));
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("本地数据读取失败。"));
    transaction.oncomplete = () => {
      database.close();
      resolve(records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
    };
    transaction.onerror = () => reject(transaction.error || new Error("本地数据读取失败。"));
  });
}

/**
 * Normalizes records written before prompt fields were split. Existing records
 * only have `prompt`; treating it as the positive prompt keeps their history
 * visible without requiring a destructive migration. The blob (if present on a
 * legacy record) is intentionally dropped from the metadata view.
 */
export function normalizeGeneration(record: LegacyStoredGeneration): StoredGeneration {
  const legacyPrompt = typeof record.prompt === "string" ? record.prompt : "";
  const { blob: _blob, prompt: _prompt, ...metadata } = record;
  void _blob;
  void _prompt;
  return {
    ...metadata,
    artistPrompt: typeof record.artistPrompt === "string" ? record.artistPrompt : "",
    positivePrompt: typeof record.positivePrompt === "string" ? record.positivePrompt : legacyPrompt,
    negativePrompt: typeof record.negativePrompt === "string" ? record.negativePrompt : "",
  };
}

export function saveGeneration(record: StoredGeneration) {
  return runRequest<IDBValidKey>(GENERATIONS_STORE, "readwrite", (store) => store.put(record));
}

export function clearGenerations() {
  return runRequest<undefined>(GENERATIONS_STORE, "readwrite", (store) => store.clear());
}

export function saveLocalSetting(key: string, value: unknown) {
  return runRequest<IDBValidKey>(SETTINGS_STORE, "readwrite", (store) => store.put(value, key));
}

export function loadLocalSetting<T>(key: string) {
  return runRequest<T | undefined>(SETTINGS_STORE, "readonly", (store) => store.get(key));
}

/** A legacy record that still carries its inline blob, awaiting migration. */
export type LegacyBlobEntry = {
  id: number;
  blob: Blob;
  filename: string;
  record: StoredGeneration;
};

/**
 * Returns every generation record that still keeps its image blob in IndexedDB
 * (i.e. written by the old storage model and not yet migrated to the folder).
 * Walked with a cursor so the blob is only held one at a time.
 */
export async function loadLegacyBlobs() {
  const database = await openDatabase();
  return new Promise<LegacyBlobEntry[]>((resolve, reject) => {
    const transaction = database.transaction(GENERATIONS_STORE, "readonly");
    const store = transaction.objectStore(GENERATIONS_STORE);
    const entries: LegacyBlobEntry[] = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as LegacyStoredGeneration;
      if (value.blob instanceof Blob && !value.migrated) {
        entries.push({ id: value.id, blob: value.blob, filename: value.filename, record: normalizeGeneration(value) });
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("本地数据读取失败。"));
    transaction.oncomplete = () => {
      database.close();
      resolve(entries);
    };
    transaction.onerror = () => reject(transaction.error || new Error("本地数据读取失败。"));
  });
}

/** Count legacy (un-migrated) records without loading their blobs. */
export async function countLegacyBlobs() {
  const database = await openDatabase();
  return new Promise<number>((resolve, reject) => {
    const transaction = database.transaction(GENERATIONS_STORE, "readonly");
    const store = transaction.objectStore(GENERATIONS_STORE);
    let count = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const value = cursor.value as LegacyStoredGeneration;
      if (value.blob instanceof Blob && !value.migrated) count += 1;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("本地数据读取失败。"));
    transaction.oncomplete = () => {
      database.close();
      resolve(count);
    };
    transaction.onerror = () => reject(transaction.error || new Error("本地数据读取失败。"));
  });
}

/**
 * Writes one legacy blob to the folder and rewrites the record without the
 * blob, flagged `migrated: true`. Safe to call repeatedly: re-running migration
 * skips already-migrated records.
 */
export async function migrateLegacyBlob(directory: LocalDirectoryHandle, entry: LegacyBlobEntry) {
  await writeFile(directory, entry.filename, entry.blob);
  const migrated: StoredGeneration = {
    ...entry.record,
    migrated: true,
    mimeType: entry.record.mimeType || entry.blob.type || undefined,
  };
  await saveGeneration(migrated);
  return migrated;
}

/**
 * Keep the prompt as the user entered it while deriving a stable id for
 * grouping.  Older/hand-written settings may omit the id, so normalization
 * fills it in rather than discarding the favourite.
 */
function artistThreadId(prompt: string) {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized ? `artist:${normalized.toLocaleLowerCase()}` : "artist:untitled";
}

export function normalizeArtistThreadFavorite(value: unknown): ArtistThreadFavorite | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ArtistThreadFavorite> & { prompt?: unknown };
  const artistPrompt = typeof record.artistPrompt === "string"
    ? record.artistPrompt
    : typeof record.prompt === "string"
      ? record.prompt
      : "";
  if (!artistPrompt.trim() && typeof record.id !== "string") return null;
  const id = typeof record.id === "string" && record.id.trim() ? record.id : artistThreadId(artistPrompt);
  const coverImageId = typeof record.coverImageId === "number" && Number.isFinite(record.coverImageId)
    ? record.coverImageId
    : undefined;
  return {
    id,
    artistPrompt,
    ...(coverImageId === undefined ? {} : { coverImageId }),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
  };
}

/** Load favourites while accepting the first key used by early builds. */
export async function loadArtistThreadFavorites() {
  const saved = await loadLocalSetting<unknown>(ARTIST_THREAD_FAVORITES_SETTING);
  const legacy = saved === undefined ? await loadLocalSetting<unknown>(LEGACY_ARTIST_FAVORITES_SETTING) : undefined;
  const value = saved ?? legacy;
  if (!Array.isArray(value)) return [];
  const deduped = new Map<string, ArtistThreadFavorite>();
  for (const candidate of value) {
    const favorite = normalizeArtistThreadFavorite(candidate);
    if (favorite) deduped.set(favorite.id, favorite);
  }
  return [...deduped.values()];
}

export function saveArtistThreadFavorites(favorites: ArtistThreadFavorite[]) {
  return saveLocalSetting(ARTIST_THREAD_FAVORITES_SETTING, favorites);
}

// Short aliases make the persistence API easy to discover for callers that
// refer to these records simply as "artist favourites".
export const loadArtistFavorites = loadArtistThreadFavorites;
export const saveArtistFavorites = saveArtistThreadFavorites;

export async function hasDirectoryPermission(handle: LocalDirectoryHandle, requestAccess = false) {
  if (!handle.queryPermission) return true;
  const options = { mode: "readwrite" as const };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return requestAccess && handle.requestPermission ? (await handle.requestPermission(options)) === "granted" : false;
}

function extensionFor(blob: Blob) {
  if (blob.type.includes("webp")) return "webp";
  if (blob.type.includes("jpeg") || blob.type.includes("jpg")) return "jpg";
  return "png";
}

export function filenameFor(id: number, blob: Blob) {
  return `nova-${id}.${extensionFor(blob)}`;
}

/** Maximum edge used for the small image shown in cards and thread covers. */
export const THUMBNAIL_MAX_DIMENSION = 384;

/** Sidecar name derived from the original file name (e.g. nova-1.thumb.webp). */
export function thumbnailFilenameFor(filename: string) {
  const extensionIndex = filename.lastIndexOf(".");
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  return `${stem}.thumb.webp`;
}

async function writeFile(directory: LocalDirectoryHandle, filename: string, data: Blob | string) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

/** Read an image file back from the authorized folder as a Blob. */
export async function readGenerationBlob(directory: LocalDirectoryHandle, filename: string) {
  const handle = await directory.getFileHandle(filename, { create: false });
  if (!handle.getFile) throw new Error("当前浏览器不支持读取文件夹中的文件。");
  return handle.getFile();
}

type DecodedImage = ImageBitmap | HTMLImageElement;

/** Decode an image using the browser's async decoder, with a DOM fallback. */
async function decodeImage(blob: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Some older Chromium builds reject a format in createImageBitmap even
      // though an HTMLImageElement can still decode it.
    }
  }
  if (typeof document === "undefined" || typeof URL === "undefined") return null;
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

async function canvasToWebp(canvas: OffscreenCanvas | HTMLCanvasElement) {
  const encoded = "convertToBlob" in canvas
    ? await canvas.convertToBlob({ type: "image/webp", quality: 0.82 })
    : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  return encoded?.type === "image/webp" ? encoded : null;
}

/**
 * Make a small WebP sidecar for card rendering. Returning null is deliberate:
 * browsers without a usable canvas/decoder simply fall back to the original.
 */
export async function createThumbnailBlob(blob: Blob, maxDimension = THUMBNAIL_MAX_DIMENSION) {
  const source = await decodeImage(blob);
  if (!source) return null;

  const sourceWidth = "naturalWidth" in source ? source.naturalWidth : source.width;
  const sourceHeight = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (!sourceWidth || !sourceHeight) {
    if ("close" in source) source.close();
    return null;
  }
  const scale = Math.min(1, maxDimension / sourceWidth, maxDimension / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height)
    : typeof document !== "undefined"
      ? Object.assign(document.createElement("canvas"), { width, height })
      : null;
  if (!canvas) {
    if ("close" in source) source.close();
    return null;
  }

  try {
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    return await canvasToWebp(canvas);
  } finally {
    if ("close" in source) source.close();
  }
}

/** Write a generated or lazily-created thumbnail sidecar. */
export function writeGenerationThumbnail(directory: LocalDirectoryHandle, filename: string, blob: Blob) {
  return writeFile(directory, thumbnailFilenameFor(filename), blob);
}

/** Read an existing sidecar, or create it lazily from the original file. */
export async function readGenerationPreview(directory: LocalDirectoryHandle, filename: string) {
  try {
    const thumbnail = await readGenerationBlob(directory, thumbnailFilenameFor(filename));
    if (thumbnail.size > 0) return { blob: thumbnail, thumbnail: true } as const;
  } catch {
    // Older folders do not have sidecars yet; create one on first reveal.
  }

  const original = await readGenerationBlob(directory, filename);
  try {
    const thumbnail = await createThumbnailBlob(original);
    if (thumbnail) {
      try {
        await writeGenerationThumbnail(directory, filename, thumbnail);
      } catch {
        // A read-only or revoked folder must not prevent the original preview.
      }
      return { blob: thumbnail, thumbnail: true } as const;
    }
  } catch {
    // Fall through to the original when decoding/encoding is unavailable.
  }
  return { blob: original, thumbnail: false } as const;
}

/** Write a freshly generated image into the authorized folder. */
export function writeGenerationImage(directory: LocalDirectoryHandle, filename: string, blob: Blob) {
  return writeFile(directory, filename, blob);
}

function metadata(records: StoredGeneration[]) {
  return JSON.stringify(
    {
      version: 3,
      updatedAt: new Date().toISOString(),
      generations: records.map(({ id, artistPrompt, positivePrompt, negativePrompt, model, size, createdAt, filename, mimeType, seed, steps, scale, sampler, durationMs, migrated }) => ({
        id,
        artistPrompt,
        positivePrompt,
        negativePrompt,
        model,
        size,
        createdAt,
        filename,
        ...(mimeType ? { mimeType } : {}),
        ...(seed != null ? { seed } : {}),
        ...(steps != null ? { steps } : {}),
        ...(scale != null ? { scale } : {}),
        ...(sampler ? { sampler } : {}),
        ...(durationMs != null ? { durationMs } : {}),
        ...(migrated ? { migrated } : {}),
      })),
    },
    null,
    2,
  );
}

/**
 * Refresh the `nova-canvas.json` index file in the folder. Image binaries are
 * written separately at generation time (and during migration), so this only
 * keeps the human-readable metadata index in sync.
 */
export async function syncGenerationFolder(directory: LocalDirectoryHandle, records: StoredGeneration[]) {
  if (!(await hasDirectoryPermission(directory))) throw new Error("本地文件夹写入权限已失效，请重新选择文件夹。 ");
  await writeFile(directory, "nova-canvas.json", metadata(records));
}

/**
 * Write the metadata index for the full set of records. Kept for callers that
 * want an explicit "export index" step (e.g. after choosing a folder).
 */
export async function exportAllToFolder(directory: LocalDirectoryHandle, records: StoredGeneration[]) {
  if (!(await hasDirectoryPermission(directory, true))) throw new Error("没有获得本地文件夹写入权限。 ");
  await writeFile(directory, "nova-canvas.json", metadata(records));
}
