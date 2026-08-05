export type StoredGeneration = {
  id: number;
  blob: Blob;
  /** Optional legacy merged prompt. New records use the three prompt fields below. */
  prompt?: string;
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

type LegacyStoredGeneration = Omit<Partial<StoredGeneration>, "id" | "blob" | "model" | "size" | "createdAt" | "filename"> & {
  id: number;
  blob: Blob;
  model: string;
  size: string;
  createdAt: string;
  filename: string;
};

type LocalWritable = {
  write(data: Blob | string): Promise<void>;
  close(): Promise<void>;
};

type LocalFileHandle = {
  createWritable(): Promise<LocalWritable>;
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

export async function loadGenerations() {
  const records = await runRequest<LegacyStoredGeneration[]>(GENERATIONS_STORE, "readonly", (store) => store.getAll());
  return records.map(normalizeGeneration).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * Normalizes records written before prompt fields were split. Existing records
 * only have `prompt`; treating it as the positive prompt keeps their history
 * visible without requiring a destructive migration.
 */
export function normalizeGeneration(record: LegacyStoredGeneration): StoredGeneration {
  const legacyPrompt = typeof record.prompt === "string" ? record.prompt : "";
  return {
    ...record,
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

async function writeFile(directory: LocalDirectoryHandle, filename: string, data: Blob | string) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

function metadata(records: StoredGeneration[]) {
  return JSON.stringify(
    {
      version: 2,
      updatedAt: new Date().toISOString(),
      generations: records.map(({ id, artistPrompt, positivePrompt, negativePrompt, model, size, createdAt, filename, blob }) => ({
        id,
        artistPrompt,
        positivePrompt,
        negativePrompt,
        model,
        size,
        createdAt,
        filename,
        mimeType: blob.type,
      })),
    },
    null,
    2,
  );
}

export async function syncGenerationFolder(directory: LocalDirectoryHandle, records: StoredGeneration[], newest?: StoredGeneration) {
  if (!(await hasDirectoryPermission(directory))) throw new Error("本地文件夹写入权限已失效，请重新选择文件夹。 ");
  if (newest) await writeFile(directory, newest.filename, newest.blob);
  await writeFile(directory, "nova-canvas.json", metadata(records));
}

export async function exportAllToFolder(directory: LocalDirectoryHandle, records: StoredGeneration[]) {
  if (!(await hasDirectoryPermission(directory, true))) throw new Error("没有获得本地文件夹写入权限。 ");
  for (const record of records) await writeFile(directory, record.filename, record.blob);
  await writeFile(directory, "nova-canvas.json", metadata(records));
}
