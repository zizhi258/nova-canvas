export type StoredGeneration = {
  id: number;
  blob: Blob;
  prompt: string;
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
  const records = await runRequest<StoredGeneration[]>(GENERATIONS_STORE, "readonly", (store) => store.getAll());
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
      version: 1,
      updatedAt: new Date().toISOString(),
      generations: records.map(({ id, prompt, model, size, createdAt, filename, blob }) => ({
        id,
        prompt,
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
