"use client";

import { unzipSync } from "fflate";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearGenerations,
  countLegacyBlobs,
  createThumbnailBlob,
  filenameFor,
  hasDirectoryPermission,
  isFileSystemAccessSupported,
  loadGenerations,
  loadArtistThreadFavorites,
  loadLegacyBlobs,
  loadLocalSetting,
  LocalDirectoryHandle,
  migrateLegacyBlob,
  readGenerationBlob,
  readGenerationPreview,
  saveGeneration,
  saveArtistThreadFavorites,
  saveLocalSetting,
  syncGenerationFolder,
  writeGenerationImage,
  writeGenerationThumbnail,
  ArtistThreadFavorite,
  StoredGeneration,
} from "./local-persistence";
import TagMarket from "./tag-market";
import { decodeBase64Image, detectImageMimeType } from "../features/generation/protocol/image-response";

type Channel = "official" | "relay";

/**
 * In-memory view of a generation. The image binary lives only in the local
 * folder; card previews are filled lazily (on screen) by `LazyImage`, while the
 * lightbox/download path reads the original on demand. The metadata list stays
 * tiny and can hold thousands of entries.
 */
type GeneratedImage = {
  id: number;
  src?: string;
  /** In-memory WebP sidecar URL used by cards; lightbox still reads `src`/original. */
  thumbnailSrc?: string;
  /** Optional legacy merged prompt retained when loading older records. */
  prompt?: string;
  artistPrompt: string;
  positivePrompt: string;
  negativePrompt: string;
  model: string;
  size: string;
  createdAt: string;
  filename: string;
  seed?: number;
  steps?: number;
  scale?: number;
  sampler?: string;
  durationMs?: number;
  mimeType?: string;
  migrated?: boolean;
};

/** Immutable snapshot of everything a queued generation task needs. */
type GenTaskParams = {
  channel: Channel;
  apiKey: string;
  relayUrl: string;
  artistPrompt: string;
  positivePrompt: string;
  negativePrompt: string;
  finalPrompt: string;
  model: string;
  size: string;
  steps: number;
  scale: number;
  sampler: string;
  seed: number;
};

type GenTask = {
  id: number;
  status: "pending" | "running" | "done" | "error";
  progress: number;
  error?: string;
  startedAt?: number;
  durationMs?: number;
  /** Automatic requeue count after upstream rate limiting. */
  retries?: number;
  params: GenTaskParams;
};

const MAX_CONCURRENT_TASKS = 2;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_RETRY_DELAY_MS = 6000;
/** How many image cards to render before switching to lazy/paginated loading. */
const PAGE_SIZE = 60;

type ArtistThread = {
  id: string;
  artistPrompt: string;
  images: GeneratedImage[];
  favorite?: ArtistThreadFavorite;
};

const models = [
  { value: "nai-diffusion-4-5-full", label: "NAI Diffusion V4.5 Full", tag: "推荐" },
  { value: "nai-diffusion-4-5-curated", label: "NAI Diffusion V4.5 Curated", tag: "" },
  { value: "nai-diffusion-4-full", label: "NAI Diffusion V4 Full", tag: "" },
  { value: "nai-diffusion-3", label: "NAI Diffusion V3", tag: "" },
];

const sizes = [
  { value: "832x1216", label: "竖图", shape: "portrait" },
  { value: "1216x832", label: "横图", shape: "landscape" },
  { value: "1024x1024", label: "方形", shape: "square" },
];

const progressCopy = [
  { at: 0, label: "正在安全连接生成通道" },
  { at: 18, label: "正在解析提示词" },
  { at: 42, label: "正在构建画面与光影" },
  { at: 68, label: "正在细化纹理与人物" },
  { at: 86, label: "正在完成高质量渲染" },
];

const OFFICIAL_ENDPOINT = "https://image.novelai.net/ai/generate-image";

function progressLabelFor(value: number) {
  return [...progressCopy].reverse().find((item) => value >= item.at)?.label ?? progressCopy[0].label;
}

/** Join prompt sections while avoiding empty sections and duplicate separators. */
function joinPromptParts(...parts: string[]) {
  return parts
    .map((part) => part.trim().replace(/^,+|,+$/g, "").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizedArtistPrompt(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function artistThreadKey(value: string) {
  const normalized = normalizedArtistPrompt(value);
  return normalized ? `artist:${normalized.toLocaleLowerCase()}` : "artist:untitled";
}

function artistThreadLabel(value: string) {
  return normalizedArtistPrompt(value) || "未填写画师串";
}

/** Copy text with a fallback for non-secure contexts where clipboard API is unavailable. */
async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

async function upstreamError(response: Response, fallback: string) {
  const detail = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } | string; message?: string };
    return typeof parsed.error === "string" ? parsed.error : parsed.error?.message || parsed.message || fallback;
  } catch {
    return detail && detail.length < 220 ? detail : fallback;
  }
}

async function officialImage(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) return response.blob();

  if (contentType.includes("json")) {
    const data = (await response.json()) as {
      images?: Array<string | { image?: string; b64_json?: string; base64?: string; data?: string; url?: string }>;
      data?: Array<{ image?: string; b64_json?: string; base64?: string; data?: string; url?: string }>;
    };
    const candidate = data.images?.[0] ?? data.data?.[0];
    if (typeof candidate === "string") {
      const bytes = decodeBase64Image(candidate);
      return new Blob([bytes.slice().buffer], { type: detectImageMimeType("result", bytes) });
    }
    const encoded = candidate?.image || candidate?.b64_json || ("base64" in (candidate || {}) ? candidate?.base64 : undefined) || ("data" in (candidate || {}) ? candidate?.data : undefined);
    if (encoded) {
      const bytes = decodeBase64Image(encoded);
      return new Blob([bytes.slice().buffer], { type: detectImageMimeType("result", bytes) });
    }
    if (candidate?.url) {
      const image = await fetch(candidate.url);
      if (!image.ok) throw new Error("NovelAI 返回的图片链接无法读取。 ");
      return image.blob();
    }
    throw new Error("NovelAI 响应中没有图片数据。 ");
  }

  const archive = new Uint8Array(await response.arrayBuffer());
  try {
    const files = unzipSync(archive);
    const entry = Object.entries(files).find(([name]) => /\.(png|jpe?g|webp)$/i.test(name));
    if (!entry) throw new Error("压缩包中没有图片");
    return new Blob([entry[1].slice().buffer], { type: detectImageMimeType(entry[0], entry[1]) });
  } catch {
    throw new Error("NovelAI 返回的图片数据无法解压。 ");
  }
}

/**
 * Loads an image binary from the authorized folder on demand and exposes it as
 * a blob URL while the card is mounted. Folder-backed URLs are revoked when
 * their cards unmount. Fresh generations carry only a small in-memory thumbnail
 * URL, so card rendering skips a disk read without retaining full originals.
 */
const previewRequestCache = new WeakMap<object, Map<string, Promise<Awaited<ReturnType<typeof readGenerationPreview>>>>>();

function loadGenerationPreview(directory: LocalDirectoryHandle, filename: string) {
  let requests = previewRequestCache.get(directory);
  if (!requests) {
    requests = new Map();
    previewRequestCache.set(directory, requests);
  }
  const existing = requests.get(filename);
  if (existing) return existing;
  const request = readGenerationPreview(directory, filename);
  requests.set(filename, request);
  request.then(
    () => requests?.delete(filename),
    () => requests?.delete(filename),
  );
  return request;
}

function LazyImage({
  image,
  directory,
  alt,
  className,
}: {
  image: GeneratedImage;
  directory: LocalDirectoryHandle | null;
  alt: string;
  className?: string;
}) {
  // Fresh generations may carry a thumbnail URL; historical records start
  // undefined and are filled on screen from the folder's WebP sidecar.
  const [src, setSrc] = useState<string | undefined>(image.thumbnailSrc || image.src);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef<string | undefined>(undefined);
  const revokeTimerRef = useRef<number | undefined>(undefined);
  const sourceKindRef = useRef<"thumbnail" | "original" | "inline" | "unknown">(
    image.thumbnailSrc ? "thumbnail" : image.src ? "inline" : "unknown",
  );
  const fallbackTriedRef = useRef(false);

  const releaseUrlNow = () => {
    if (revokeTimerRef.current !== undefined) {
      window.clearTimeout(revokeTimerRef.current);
      revokeTimerRef.current = undefined;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = undefined;
    }
  };

  const scheduleUrlRelease = () => {
    const url = urlRef.current;
    if (!url) return;
    if (revokeTimerRef.current !== undefined) window.clearTimeout(revokeTimerRef.current);
    revokeTimerRef.current = window.setTimeout(() => {
      if (urlRef.current === url) {
        URL.revokeObjectURL(url);
        urlRef.current = undefined;
      }
      revokeTimerRef.current = undefined;
    }, 0);
  };

  useEffect(() => {
    if (revokeTimerRef.current !== undefined) {
      window.clearTimeout(revokeTimerRef.current);
      revokeTimerRef.current = undefined;
    }
    if (src) {
      // Keep a cleanup on the settled-src branch too; otherwise the effect
      // that created a folder-backed URL would be replaced without an
      // unmount cleanup when `src` changes from undefined to the blob URL.
      return () => scheduleUrlRelease();
    }
    if (!directory) return;
    let cancelled = false;
    const node = ref.current;
    const reveal = () => {
      if (cancelled || urlRef.current || fallbackTriedRef.current) return;
      void loadGenerationPreview(directory, image.filename)
        .then(({ blob, thumbnail }) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          sourceKindRef.current = thumbnail ? "thumbnail" : "original";
          setSrc(url);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    if (!node || typeof IntersectionObserver === "undefined") {
      reveal();
      return () => {
        cancelled = true;
        scheduleUrlRelease();
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) reveal();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => {
      // Release folder-backed URLs when a card leaves the tree; the delayed
      // revoke keeps React StrictMode's development remount from breaking src.
      cancelled = true;
      observer.disconnect();
      // Delay one tick so React StrictMode's development remount can cancel
      // the revoke before the still-mounted image URL is invalidated.
      scheduleUrlRelease();
    };
  }, [src, directory, image.id, image.filename]);

  function handleImageError() {
    if (sourceKindRef.current === "thumbnail" && directory && !fallbackTriedRef.current) {
      fallbackTriedRef.current = true;
      releaseUrlNow();
      setSrc(undefined);
      void readGenerationBlob(directory, image.filename)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          sourceKindRef.current = "original";
          setSrc(url);
          setFailed(false);
        })
        .catch(() => setFailed(true));
      return;
    }
    setFailed(true);
  }

  return (
    <div className="lazy-image" ref={ref} style={{ minHeight: 220 }}>
      {failed ? (
        <span className="lazy-image-empty">图片文件未找到，可能需要迁移旧数据</span>
      ) : src ? (
        // onError unmounts the img so the browser never falls back to displaying
        // a long alt string as a broken-image placeholder.
        <img src={src} alt={alt || "生成图片"} loading="lazy" decoding="async" className={className} onError={handleImageError} />
      ) : (
        <span className="lazy-image-placeholder" aria-hidden="true" />
      )}
    </div>
  );
}

export default function Home() {
  const [channel, setChannel] = useState<Channel>("official");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [rememberKey, setRememberKey] = useState(false);
  const [keyStorageReady, setKeyStorageReady] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [artistPrompt, setArtistPrompt] = useState("");
  const [positivePrompt, setPositivePrompt] = useState("1girl, silver hair, standing in a field of luminous flowers, starry night, cinematic lighting, intricate details");
  const [negativePrompt, setNegativePrompt] = useState("lowres, blurry, bad anatomy, extra fingers, watermark, text");
  const [model, setModel] = useState(models[0].value);
  const [size, setSize] = useState("832x1216");
  const [steps, setSteps] = useState(28);
  const [scale, setScale] = useState(6);
  const [sampler, setSampler] = useState("k_euler_ancestral");
  const [seed, setSeed] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [tagMarketOpen, setTagMarketOpen] = useState(false);
  const [batchCount, setBatchCount] = useState(1);
  const [tasks, setTasks] = useState<GenTask[]>([]);
  const [formError, setFormError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [lightboxImage, setLightboxImage] = useState<GeneratedImage | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | undefined>(undefined);
  const [copiedSection, setCopiedSection] = useState<"prompt" | "negative" | "artist" | "thread" | null>(null);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxPan, setLightboxPan] = useState({ x: 0, y: 0 });
  const lightboxStageRef = useRef<HTMLDivElement | null>(null);
  const lightboxDragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const [artistFavorites, setArtistFavorites] = useState<ArtistThreadFavorite[]>([]);
  const [mainView, setMainView] = useState<"results" | "favorites">("results");
  const [connectionOpen, setConnectionOpen] = useState(true);
  const [selectedArtistThreadId, setSelectedArtistThreadId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<LocalDirectoryHandle | null>(null);
  const [directoryName, setDirectoryName] = useState("");
  const [fsSupported, setFsSupported] = useState(true);
  const [legacyCount, setLegacyCount] = useState(0);
  const [migrationState, setMigrationState] = useState<{ running: boolean; done: number; total: number } | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const controllersRef = useRef(new Map<number, AbortController>());
  // Synchronous concurrency gate: state updates are async, so the number of
  // in-flight tasks is tracked in a ref to stay correct even when effects fire
  // twice (StrictMode) or several tasks are enqueued in one render.
  const runningCountRef = useRef(0);
  const freshThumbnailUrlsRef = useRef<Map<number, string>>(new Map());
  const imagesRef = useRef<GeneratedImage[]>([]);
  const directoryRef = useRef<LocalDirectoryHandle | null>(null);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    directoryRef.current = directory;
  }, [directory]);

  const stepLightbox = useCallback((offset: number) => {
    setCopiedSection(null);
    setLightboxImage((current) => {
      if (!current || images.length < 2) return current;
      const index = images.findIndex((image) => image.id === current.id);
      if (index < 0) return current;
      return images[(index + offset + images.length) % images.length];
    });
  }, [images]);

  useEffect(() => {
    if (!lightboxImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxImage(null);
      if (event.key === "ArrowLeft") stepLightbox(-1);
      if (event.key === "ArrowRight") stepLightbox(1);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [lightboxImage, stepLightbox]);

  // Load the image binary for the currently open lightbox image on demand.
  // setState calls are deferred to microtasks to avoid cascading renders.
  useEffect(() => {
    if (!lightboxImage) return;
    let revoked = false;
    let createdUrl: string | undefined;
    const apply = (url: string | undefined) => {
      if (!revoked) void Promise.resolve().then(() => setLightboxSrc(url));
    };
    // Freshly generated images carry their blob URL on the record already.
    if (lightboxImage.src) {
      apply(lightboxImage.src);
      return () => {
        revoked = true;
      };
    }
    const dir = directoryRef.current;
    if (!dir) {
      apply(undefined);
      return () => {
        revoked = true;
      };
    }
    apply(undefined);
    void readGenerationBlob(dir, lightboxImage.filename)
      .then((blob) => {
        if (revoked) return;
        createdUrl = URL.createObjectURL(blob);
        setLightboxSrc(createdUrl);
      })
      .catch(() => {
        if (!revoked) setLightboxSrc(undefined);
      });
    return () => {
      revoked = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [lightboxImage]);

  // Zoom resets whenever another image is opened or stepped to.
  useEffect(() => {
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  }, [lightboxImage?.id]);

  // Wheel zoom needs a non-passive listener, otherwise preventDefault is ignored.
  useEffect(() => {
    const stage = lightboxStageRef.current;
    if (!stage || !lightboxImage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setLightboxZoom((value) => {
        const next = Math.min(4, Math.max(1, Math.round((value + (event.deltaY < 0 ? 0.25 : -0.25)) * 100) / 100));
        if (next === 1) setLightboxPan({ x: 0, y: 0 });
        return next;
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [lightboxImage]);

  function adjustLightboxZoom(delta: number) {
    setLightboxZoom((value) => {
      const next = Math.min(4, Math.max(1, Math.round((value + delta) * 100) / 100));
      if (next === 1) setLightboxPan({ x: 0, y: 0 });
      return next;
    });
  }

  function resetLightboxZoom() {
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  }

  function onLightboxPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (lightboxZoom <= 1) return;
    lightboxDragRef.current = { startX: event.clientX, startY: event.clientY, baseX: lightboxPan.x, baseY: lightboxPan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onLightboxPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = lightboxDragRef.current;
    if (!drag) return;
    setLightboxPan({ x: drag.baseX + event.clientX - drag.startX, y: drag.baseY + event.clientY - drag.startY });
  }

  function onLightboxPointerUp() {
    lightboxDragRef.current = null;
  }

  const activeTask = tasks.find((task) => task.status === "running") || null;
  const pendingTaskCount = tasks.filter((task) => task.status === "pending").length;
  const runningTaskCount = tasks.filter((task) => task.status === "running").length;

  const artistThreads = useMemo<ArtistThread[]>(() => {
    const grouped = new Map<string, GeneratedImage[]>();
    for (const image of images) {
      const key = artistThreadKey(image.artistPrompt);
      const existing = grouped.get(key);
      if (existing) existing.push(image);
      else grouped.set(key, [image]);
    }
    return [...grouped.entries()].map(([id, threadImages]) => ({
      id,
      artistPrompt: threadImages[0]?.artistPrompt || "",
      images: threadImages,
      favorite: artistFavorites.find((favorite) => favorite.id === id || artistThreadKey(favorite.artistPrompt) === id),
    }));
  }, [artistFavorites, images]);

  const favoriteThreads = useMemo<ArtistThread[]>(
    () => artistFavorites.map((favorite) => ({
      id: favorite.id,
      artistPrompt: favorite.artistPrompt,
      images: artistThreads.find((thread) => thread.id === favorite.id || artistThreadKey(thread.artistPrompt) === artistThreadKey(favorite.artistPrompt))?.images || [],
      favorite,
    })),
    [artistFavorites, artistThreads],
  );

  const selectedArtistThread = selectedArtistThreadId
    ? favoriteThreads.find((thread) => thread.id === selectedArtistThreadId) || null
    : null;

  useEffect(() => {
    let active = true;
    const controllers = controllersRef.current;
    const freshThumbnailUrls = freshThumbnailUrlsRef.current;

    void Promise.resolve().then(() => {
      if (!active) return;
      setFsSupported(isFileSystemAccessSupported());
      const savedKey = window.localStorage.getItem("nova-canvas:api-key");
      const shouldRemember = window.localStorage.getItem("nova-canvas:remember-key") === "true";
      if (shouldRemember && savedKey) {
        setApiKey(savedKey);
        setConnectionOpen(false);
      }
      setRememberKey(shouldRemember);
      setKeyStorageReady(true);
    });

    // Metadata only — no blobs are read into memory here, so this is fast and
    // light even with thousands of records.
    void loadGenerations()
      .then((records) => {
        if (!active) return;
        setImages(records);
      })
      .catch(() => active && setStorageNotice("浏览器未能读取之前保存的生成记录。 "));

    void loadArtistThreadFavorites()
      .then((favorites) => {
        if (active) setArtistFavorites(favorites);
      })
      .catch(() => active && setStorageNotice("无法读取之前保存的画师串收藏。"));

    void loadLocalSetting<LocalDirectoryHandle>("directory")
      .then(async (savedDirectory) => {
        if (!active || !savedDirectory || !(await hasDirectoryPermission(savedDirectory))) return;
        setDirectory(savedDirectory);
        setDirectoryName(savedDirectory.name);
      })
      .catch(() => undefined);

    void countLegacyBlobs()
      .then((count) => {
        if (active) setLegacyCount(count);
      })
      .catch(() => undefined);

    return () => {
      active = false;
      controllers.forEach((controller) => controller.abort());
      freshThumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
      freshThumbnailUrls.clear();
    };
  }, []);

  useEffect(() => {
    if (!keyStorageReady) return;
    window.localStorage.setItem("nova-canvas:remember-key", String(rememberKey));
    if (rememberKey && apiKey) window.localStorage.setItem("nova-canvas:api-key", apiKey);
    else window.localStorage.removeItem("nova-canvas:api-key");
  }, [apiKey, keyStorageReady, rememberKey]);

  function enqueueGeneration(event: FormEvent) {
    event.preventDefault();
    setFormError("");
    if (!fsSupported) {
      setFormError("当前浏览器不支持本地文件夹存储，请使用桌面版 Chrome 或 Edge。 ");
      return;
    }
    if (!directory) {
      setFormError("请先在「连接服务」中选择用于保存图片的本地文件夹。 ");
      setConnectionOpen(true);
      return;
    }
    if (!apiKey.trim()) {
      setFormError("请输入 API Key 后再开始生成。密钥仅用于本次请求。 ");
      setConnectionOpen(true);
      return;
    }
    if (channel === "relay" && !relayUrl.trim()) {
      setFormError("中转渠道需要填写服务 URL。 ");
      setConnectionOpen(true);
      return;
    }
    const cleanArtistPrompt = artistPrompt.trim();
    const cleanPositivePrompt = positivePrompt.trim();
    const finalPrompt = joinPromptParts(cleanArtistPrompt, cleanPositivePrompt);
    const cleanNegativePrompt = negativePrompt.trim();
    if (!finalPrompt) {
      setFormError("请先描述你想生成的画面。 ");
      return;
    }
    if (finalPrompt.length > 1800) {
      setFormError("画师串与正面提示词拼接后不能超过 1800 个字符，请删减后再生成。");
      return;
    }

    const baseSeed = seed ? Number(seed) : null;
    const now = Date.now();
    const nextTasks: GenTask[] = Array.from({ length: batchCount }, (_, index) => ({
      id: now + index,
      status: "pending",
      progress: 0,
      params: {
        channel,
        apiKey: apiKey.trim(),
        relayUrl: relayUrl.trim(),
        artistPrompt: cleanArtistPrompt,
        positivePrompt: cleanPositivePrompt,
        negativePrompt: cleanNegativePrompt,
        finalPrompt,
        model,
        size,
        steps,
        scale,
        sampler,
        // A fixed seed still yields distinct images across a batch by offsetting.
        seed: baseSeed === null ? Math.floor(Math.random() * 4_294_967_295) : baseSeed + index,
      },
    }));
    setTasks((current) => [...nextTasks, ...current]);
  }

  async function runTask(task: GenTask) {
    // Guard against duplicate launches of the same task.
    if (controllersRef.current.has(task.id)) return;
    const controller = new AbortController();
    controllersRef.current.set(task.id, controller);
    const startedAt = Date.now();
    const patch = (id: number, changes: Partial<GenTask>) =>
      setTasks((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    patch(task.id, { status: "running", startedAt, progress: 4 });
    const ticker = window.setInterval(() => {
      setTasks((current) =>
        current.map((item) => {
          if (item.id !== task.id || item.status !== "running") return item;
          const value = item.progress;
          if (value >= 91) return item;
          const step = value < 35 ? 3 : value < 70 ? 2 : 1;
          return { ...item, progress: Math.min(91, value + step) };
        }),
      );
    }, 520);

    const { params } = task;
    try {
      let blob: Blob;

      if (params.channel === "official") {
        const [width, height] = params.size.split("x").map(Number);
        const correlationId = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
        const isV4 = params.model.startsWith("nai-diffusion-4");
        const parameters = {
          params_version: 3,
          width,
          height,
          scale: params.scale,
          sampler: params.sampler,
          steps: params.steps,
          n_samples: 1,
          seed: params.seed,
          prompt: params.finalPrompt,
          negative_prompt: params.negativePrompt,
          ucPreset: 0,
          qualityToggle: true,
          sm: false,
          sm_dyn: false,
          dynamic_thresholding: false,
          controlnet_strength: 1,
          legacy: false,
          add_original_image: true,
          cfg_rescale: 0,
          noise_schedule: "karras",
          legacy_v3_extend: false,
          deliberate_euler_ancestral_bug: false,
          prefer_brownian: true,
          ...(isV4
            ? {
                v4_prompt: {
                  caption: { base_caption: params.finalPrompt, char_captions: [] },
                  use_coords: false,
                  use_order: true,
                  legacy_uc: false,
                },
                v4_negative_prompt: {
                  caption: { base_caption: params.negativePrompt, char_captions: [] },
                  use_coords: false,
                  use_order: false,
                  legacy_uc: false,
                },
              }
            : {}),
        };
        const response = await fetch(OFFICIAL_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${params.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Correlation-Id": correlationId,
            "X-Initiated-At": new Date().toISOString(),
          },
          signal: controller.signal,
          body: JSON.stringify({
            input: params.finalPrompt,
            model: params.model,
            action: "generate",
            parameters,
          }),
        });
        if (!response.ok) {
          const message = await upstreamError(response, `NovelAI 返回 ${response.status}`);
          const error = new Error(response.status >= 500 ? `${message}（请求编号：${correlationId}）` : message) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
        blob = await officialImage(response);
      } else {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            channel: params.channel,
            apiKey: params.apiKey,
            relayUrl: params.relayUrl,
            prompt: params.finalPrompt,
            negativePrompt: params.negativePrompt,
            model: params.model,
            size: params.size,
            steps: params.steps,
            scale: params.scale,
            sampler: params.sampler,
            seed: params.seed,
          }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          const error = new Error(data?.error || `生成失败（${response.status}）`) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }
        blob = await response.blob();
      }

      if (!blob.type.startsWith("image/")) throw new Error("生成服务没有返回可显示的图片。 ");
      const durationMs = Date.now() - startedAt;
      const id = Date.now();
      const createdAt = new Date().toISOString();
      const filename = filenameFor(id, blob);
      const targetDirectory = directoryRef.current;
      if (!targetDirectory) throw new Error("未选择本地文件夹，无法保存图片。 ");
      // Write the image binary to the folder first; only persist metadata to
      // IndexedDB once the file is safely on disk.
      await writeGenerationImage(targetDirectory, filename, blob);
      let thumbnailBlob: Blob | null = null;
      try {
        thumbnailBlob = await createThumbnailBlob(blob);
        if (thumbnailBlob) await writeGenerationThumbnail(targetDirectory, filename, thumbnailBlob);
      } catch {
        // The original remains the source of truth when thumbnail generation
        // or sidecar writing is unavailable.
        thumbnailBlob = null;
      }
      const record: StoredGeneration = {
        id,
        artistPrompt: params.artistPrompt,
        positivePrompt: params.positivePrompt,
        negativePrompt: params.negativePrompt,
        model: params.model,
        size: params.size,
        createdAt,
        filename,
        seed: params.seed,
        steps: params.steps,
        scale: params.scale,
        sampler: params.sampler,
        durationMs,
        mimeType: blob.type,
        migrated: true,
      };
      // Keep only the small card preview in memory. Lightbox/download read the
      // original from the authorized folder on demand.
      const freshThumbnailSrc = thumbnailBlob ? URL.createObjectURL(thumbnailBlob) : undefined;
      if (freshThumbnailSrc) freshThumbnailUrlsRef.current.set(id, freshThumbnailSrc);
      const nextImages = [
        { ...record, ...(freshThumbnailSrc ? { thumbnailSrc: freshThumbnailSrc } : {}) },
        ...imagesRef.current,
      ];
      imagesRef.current = nextImages;
      setImages(nextImages);
      setVisibleCount((current) => Math.max(current, PAGE_SIZE));
      try {
        await saveGeneration(record);
        await syncGenerationFolder(targetDirectory, nextImages);
        setStorageNotice(`图片已保存到“${targetDirectory.name}”文件夹。`);
      } catch (storageError) {
        setStorageNotice((storageError as Error).message || "图片已生成，但本地持久化失败。 ");
      }
      patch(task.id, { status: "done", progress: 100, durationMs });
    } catch (reason) {
      if ((reason as Error).name === "AbortError") {
        setTasks((current) => current.filter((item) => item.id !== task.id));
      } else {
        const message = (reason as Error).message || "生成未完成，请检查配置后重试。 ";
        const status = (reason as { status?: number }).status;
        const retries = task.retries ?? 0;
        // Retryable: throttling / concurrency limits / transient server or network errors.
        // Never retry client errors like 400/401/402/403 (bad params, bad key, no quota).
        const retryable =
          status === 408 || status === 409 || status === 425 || status === 429 ||
          (status !== undefined && status >= 500) ||
          (status === undefined && /429|too many|rate.?limit|concurrent|频繁|限流|failed to fetch|networkerror|network/i.test(message));
        if (retries < MAX_RATE_LIMIT_RETRIES && retryable) {
          // Upstream throttled or hiccuped: requeue with backoff instead of failing the batch.
          patch(task.id, { status: "error", error: `上游繁忙（${status ?? "网络错误"}），${RATE_LIMIT_RETRY_DELAY_MS / 1000} 秒后自动重试（第 ${retries + 1} 次）…` });
          window.setTimeout(() => {
            setTasks((current) =>
              current.map((item) =>
                item.id === task.id && item.status === "error"
                  ? { ...item, status: "pending", progress: 0, error: undefined, retries: retries + 1 }
                  : item,
              ),
            );
          }, RATE_LIMIT_RETRY_DELAY_MS);
        } else {
          patch(task.id, { status: "error", error: message });
        }
      }
    } finally {
      window.clearInterval(ticker);
      controllersRef.current.delete(task.id);
      runningCountRef.current = Math.max(0, runningCountRef.current - 1);
    }
  }

  function cancelTask(id: number) {
    controllersRef.current.get(id)?.abort();
    setTasks((current) => current.filter((task) => task.id !== id || (task.status !== "pending" && task.status !== "running")));
  }

  function cancelAllTasks() {
    controllersRef.current.forEach((controller) => controller.abort());
    setTasks((current) => current.filter((task) => task.status !== "pending" && task.status !== "running"));
  }

  function clearFinishedTasks() {
    setTasks((current) => current.filter((task) => task.status === "pending" || task.status === "running"));
  }

  // The queue drains itself: fill every free slot with the oldest pending
  // tasks. runningCountRef is the synchronous source of truth for capacity.
  useEffect(() => {
    const pendings = [...tasks].reverse().filter((task) => task.status === "pending");
    for (const task of pendings) {
      if (runningCountRef.current >= MAX_CONCURRENT_TASKS) break;
      if (controllersRef.current.has(task.id)) continue;
      runningCountRef.current += 1;
      void runTask(task);
    }
  }, [tasks]);

  /** Toggle a tag's prompt text inside the target prompt: present → remove, absent → append. */
  function toggleTag(value: string, target: "positive" | "negative") {
    const update = (current: string) => {
      const parts = current.split(",").map((item) => item.trim()).filter(Boolean);
      let next = parts;
      for (const piece of value.split(",").map((item) => item.trim()).filter(Boolean)) {
        const lower = piece.toLowerCase();
        next = next.some((item) => item.toLowerCase() === lower)
          ? next.filter((item) => item.toLowerCase() !== lower)
          : [...next, piece];
      }
      return next.join(", ");
    };
    if (target === "positive") setPositivePrompt(update);
    else setNegativePrompt(update);
  }

  function forgetApiKey() {
    setRememberKey(false);
    setApiKey("");
    window.localStorage.removeItem("nova-canvas:api-key");
    window.localStorage.setItem("nova-canvas:remember-key", "false");
    setStorageNotice("已清除当前浏览器保存的 API Key。 ");
  }

  async function chooseDirectory() {
    const picker = (window as Window & {
      showDirectoryPicker?: (options?: { mode?: "readwrite" }) => Promise<LocalDirectoryHandle>;
    }).showDirectoryPicker;
    if (!picker) {
      setStorageNotice("当前浏览器不支持文件夹写入，请使用桌面版 Chrome 或 Edge。 ");
      return;
    }
    try {
      const selected = await picker({ mode: "readwrite" });
      if (!(await hasDirectoryPermission(selected, true))) throw new Error("没有获得文件夹写入权限。 ");
      await saveLocalSetting("directory", selected);
      setDirectory(selected);
      setDirectoryName(selected.name);
      // Refresh the folder index file so it reflects the current metadata.
      const records = await loadGenerations();
      await syncGenerationFolder(selected, records);
      const legacy = await countLegacyBlobs();
      setLegacyCount(legacy);
      if (legacy > 0) {
        setStorageNotice(`已连接“${selected.name}”。检测到 ${legacy} 条旧记录仍保存在浏览器中，点击「迁移旧数据」可导入到文件夹。`);
      } else {
        setStorageNotice(`已连接“${selected.name}”，新作品会直接保存到此文件夹。`);
      }
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setStorageNotice((reason as Error).message || "无法连接本地文件夹。 ");
    }
  }

  /** Move legacy IndexedDB blobs into the authorized folder and strip them. */
  async function migrateLegacyData() {
    const targetDirectory = directoryRef.current;
    if (!targetDirectory) {
      setStorageNotice("请先选择本地文件夹后再迁移。 ");
      return;
    }
    if (migrationState?.running) return;
    try {
      const entries = await loadLegacyBlobs();
      if (entries.length === 0) {
        setLegacyCount(0);
        setStorageNotice("没有需要迁移的旧数据。 ");
        return;
      }
      setMigrationState({ running: true, done: 0, total: entries.length });
      let done = 0;
      let failed = 0;
      for (const entry of entries) {
        try {
          await migrateLegacyBlob(targetDirectory, entry);
        } catch {
          failed += 1;
        }
        done += 1;
        setMigrationState({ running: true, done, total: entries.length });
      }
      const records = await loadGenerations();
      setImages(records);
      await syncGenerationFolder(targetDirectory, records);
      const remaining = await countLegacyBlobs();
      setLegacyCount(remaining);
      setMigrationState(null);
      setStorageNotice(`迁移完成：${done - failed} 张已导入文件夹${failed ? `，${failed} 张失败` : ""}。`);
    } catch (reason) {
      setMigrationState(null);
      setStorageNotice((reason as Error).message || "迁移旧数据失败。 ");
    }
  }

  async function clearLocalHistory() {
    if (!window.confirm("确定清空浏览器中的生成记录吗？本地文件夹里的图片文件不会被删除。")) return;
    try {
      await clearGenerations();
      const freshThumbnailUrls = freshThumbnailUrlsRef.current;
      freshThumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
      freshThumbnailUrls.clear();
      setImages([]);
      setVisibleCount(PAGE_SIZE);
      const targetDirectory = directoryRef.current;
      if (targetDirectory) await syncGenerationFolder(targetDirectory, []);
      setStorageNotice("浏览器生成记录已清空；本地文件夹中的图片文件保持不变。 ");
    } catch (reason) {
      setStorageNotice((reason as Error).message || "清空本地记录失败。 ");
    }
  }

  function reuseGeneration(image: GeneratedImage) {
    setArtistPrompt(image.artistPrompt);
    setPositivePrompt(image.positivePrompt || image.prompt || "");
    setNegativePrompt(image.negativePrompt);
    setLightboxImage(null);
    if (mainView !== "results") setMainView("results");
  }

  function triggerDownload(url: string, filename: string) {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  /** Download an image on demand from the original file in the local folder. */
  async function downloadImage(image: GeneratedImage) {
    const fresh = image.src;
    if (fresh) {
      triggerDownload(fresh, image.filename);
      return;
    }
    const dir = directoryRef.current;
    if (!dir) return;
    try {
      const blob = await readGenerationBlob(dir, image.filename);
      const url = URL.createObjectURL(blob);
      triggerDownload(url, image.filename);
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      setStorageNotice("无法读取图片文件，可能需要先迁移旧数据。 ");
    }
  }

  const lightboxIndex = lightboxImage ? images.findIndex((image) => image.id === lightboxImage.id) : -1;

  async function copyLightboxSection(section: "prompt" | "negative" | "artist" | "thread", value: string) {
    if (!value.trim()) return;
    const copied = await copyText(value).catch(() => false);
    if (copied) {
      setCopiedSection(section);
      window.setTimeout(() => setCopiedSection(null), 1800);
    } else {
      setStorageNotice("复制失败，请手动选择提示词文本复制。 ");
    }
  }

  function persistArtistFavorites(nextFavorites: ArtistThreadFavorite[]) {
    setArtistFavorites(nextFavorites);
    void saveArtistThreadFavorites(nextFavorites).catch((reason) => {
      setStorageNotice((reason as Error).message || "画师串收藏保存失败。");
    });
  }

  function favoriteForThread(threadId: string, artistPrompt: string) {
    return artistFavorites.find((favorite) => favorite.id === threadId || artistThreadKey(favorite.artistPrompt) === artistThreadKey(artistPrompt));
  }

  function toggleArtistThreadFavorite(artistPrompt: string) {
    const id = artistThreadKey(artistPrompt);
    const existing = favoriteForThread(id, artistPrompt);
    const nextFavorites = existing
      ? artistFavorites.filter((favorite) => favorite !== existing)
      : [
          ...artistFavorites,
          {
            id,
            artistPrompt: normalizedArtistPrompt(artistPrompt),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
    persistArtistFavorites(nextFavorites);
    if (existing && selectedArtistThreadId === existing.id) {
      setSelectedArtistThreadId(null);
    }
  }

  function setArtistThreadCover(thread: ArtistThread, imageId: number) {
    const favorite = favoriteForThread(thread.id, thread.artistPrompt);
    if (!favorite) return;
    const nextFavorites = artistFavorites.map((candidate) => (
      candidate === favorite
        ? { ...candidate, coverImageId: imageId, updatedAt: new Date().toISOString() }
        : candidate
    ));
    persistArtistFavorites(nextFavorites);
  }

  function coverForThread(thread: ArtistThread) {
    return thread.images.find((image) => image.id === thread.favorite?.coverImageId) || thread.images[0] || null;
  }

  function renderImageCard(image: GeneratedImage, thread?: ArtistThread) {
    const resolvedThread = thread || artistThreads.find((candidate) => candidate.id === artistThreadKey(image.artistPrompt));
    const favorite = resolvedThread?.favorite;
    return (
      <article className="image-card" key={image.id}>
        {/* Card previews use the small WebP sidecar; the original stays on disk. */}
        <button type="button" className="image-preview-button" onClick={() => setLightboxImage(image)} aria-label="放大查看生成图片">
          <LazyImage image={image} directory={directory} alt={"生成图片"} />
        </button>
        <div className="image-overlay"><span>{image.model.replace("nai-diffusion-", "V")}</span><button type="button" className="image-download-button" onClick={() => downloadImage(image)}>下载原图</button></div>
        <div className="image-card-footer">
          <div className="image-card-actions">
            <button type="button" className={`image-favorite-button${favorite ? " active" : ""}`} onClick={() => toggleArtistThreadFavorite(image.artistPrompt)} aria-pressed={Boolean(favorite)}>{favorite ? "取消收藏" : "收藏画师串"}</button>
            {favorite && resolvedThread && <button type="button" className="image-cover-button" onClick={() => setArtistThreadCover(resolvedThread, image.id)}>{favorite.coverImageId === image.id ? "当前封面" : "设为封面"}</button>}
            <button type="button" className="image-reuse-button" onClick={() => reuseGeneration(image)}>再次使用提示词</button>
          </div>
        </div>
      </article>
    );
  }

  function renderFavoriteThreadCard(thread: ArtistThread) {
    const cover = coverForThread(thread);
    const favorite = thread.favorite;
    return (
      <article className="artist-thread-card" key={thread.id}>
        <div className="artist-thread-cover-frame">
          <button type="button" className="artist-thread-cover" onClick={() => { setSelectedArtistThreadId(thread.id); }} aria-label={`打开${artistThreadLabel(thread.artistPrompt)}的全部图片`} data-cover-source={favorite?.coverImageId === cover?.id ? "manual" : "latest"}>
            {cover ? <LazyImage image={cover} directory={directory} alt={artistThreadLabel(thread.artistPrompt)} /> : <span className="artist-thread-cover-empty">暂无生成图片</span>}
          </button>
          <div className="artist-thread-cover-caption">
            <h3 className="artist-thread-card-title" title={artistThreadLabel(thread.artistPrompt)}>{artistThreadLabel(thread.artistPrompt)}</h3>
            <p>{thread.images.length ? `${thread.images.length} 张生成图片` : "暂无生成图片"}</p>
          </div>
        </div>
        <div className="artist-thread-card-body">
          <div className="artist-thread-card-actions">
            <button type="button" className="image-reuse-button" onClick={() => setSelectedArtistThreadId(thread.id)}>查看全部图片</button>
            <button type="button" className="image-favorite-button active" onClick={() => toggleArtistThreadFavorite(thread.artistPrompt)}>取消收藏</button>
          </div>
        </div>
      </article>
    );
  }

  // Browsers without the File System Access API cannot store images locally,
  // so the whole workbench is replaced with a clear upgrade prompt.
  if (!fsSupported) {
    return (
      <main className="app-shell" id="main-content">
        <a className="skip-link" href="#main-content">跳到主要内容</a>
        <header className="topbar">
          <a className="brand" href="#top" aria-label="Nova Canvas 首页">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <span>NOVA <b>CANVAS</b></span>
          </a>
        </header>
        <section className="canvas-area" id="top" aria-label="浏览器不支持提示">
          <div className="canvas-scroll">
            <div className="empty-result">
              <div className="empty-art"><i /><i /><span aria-hidden="true" /></div>
              <h3>需要支持本地文件夹的浏览器</h3>
              <p>Nova Canvas 现在把作品直接保存到你授权的本地文件夹，不再占用浏览器存储。请使用桌面版 Chrome 或 Edge 打开本页。</p>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const visibleImages = images.slice(0, visibleCount);

  return (
    <main className="app-shell" id="main-content">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Nova Canvas 首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>NOVA <b>CANVAS</b></span>
        </a>
        <div className="topbar-status">
          <span className={`status-pill ${apiKey ? "ok" : "warn"}`}><i aria-hidden="true" />{channel === "official" ? "官方渠道" : "中转渠道"} · {apiKey ? "Key 已配置" : "未配置 Key"}</span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="favorites-nav" onClick={() => { setMainView("favorites"); setSelectedArtistThreadId(null); }}>画师串收藏 <b>{artistFavorites.length}</b></button>
        </div>
      </header>

      <div className="workbench" id="top">
        <form className="control-rail" onSubmit={enqueueGeneration}>
          <div className="rail-scroll">
            <section className="rail-section prompt-panel">
              <div className="rail-heading">
                <div><h2>描述画面</h2><p>详细的英文提示词通常会获得更稳定的效果</p></div>
                <button type="button" className="tag-market-trigger" onClick={() => setTagMarketOpen(true)}><span aria-hidden="true" /> 标签超市</button>
              </div>
              <label className="field prompt-field artist-prompt-field">
                <span>画师串 <small>可选；会与正面提示词自动拼接</small></span>
                <textarea value={artistPrompt} onChange={(event) => setArtistPrompt(event.target.value)} maxLength={1200} rows={2} placeholder="例如：masterpiece, best quality, by your favorite artist" />
                <span className="char-count">{artistPrompt.length} / 1200</span>
              </label>
              <label className="field prompt-field">
                <span>正面提示词</span>
                <textarea value={positivePrompt} onChange={(event) => setPositivePrompt(event.target.value)} maxLength={1800} rows={5} />
                <span className="char-count">{positivePrompt.length} / 1800</span>
              </label>
              <label className="field prompt-field negative-field">
                <span>反向提示词</span>
                <textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} maxLength={1000} rows={2} />
                <span className="char-count">{negativePrompt.length} / 1000</span>
              </label>
            </section>

            <section className="rail-section settings-panel">
              <div className="rail-heading">
                <div><h2>生成参数</h2><p>塑造图片比例与渲染细节</p></div>
              </div>
              <label className="field">
                <span>模型</span>
                <div className="select-wrap"><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option value={item.value} key={item.value}>{item.label}{item.tag ? ` · ${item.tag}` : ""}</option>)}</select></div>
              </label>
              <fieldset className="field size-field">
                <legend>画面比例</legend>
                <div className="size-grid">
                  {sizes.map((item) => (
                    <button type="button" key={item.value} className={size === item.value ? "active" : ""} onClick={() => setSize(item.value)}>
                      <i className={`shape ${item.shape}`} /><b>{item.label}</b><span>{item.value.replace("x", " × ")}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="field count-field">
                <legend>生成数量</legend>
                <div className="count-grid">
                  {[1, 2, 3, 4].map((count) => (
                    <button type="button" key={count} className={batchCount === count ? "active" : ""} onClick={() => setBatchCount(count)}>{count} 张</button>
                  ))}
                </div>
              </fieldset>
              <label className="range-field">
                <span><b>采样步数</b><output>{steps}</output></span>
                <input type="range" min="10" max="50" value={steps} onChange={(event) => setSteps(Number(event.target.value))} style={{ "--range-progress": `${((steps - 10) / 40) * 100}%` } as React.CSSProperties} />
                <small><span>更快</span><span>更精细</span></small>
              </label>
              <label className="range-field">
                <span><b>提示词相关性</b><output>{scale.toFixed(1)}</output></span>
                <input type="range" min="1" max="10" step="0.5" value={scale} onChange={(event) => setScale(Number(event.target.value))} style={{ "--range-progress": `${((scale - 1) / 9) * 100}%` } as React.CSSProperties} />
                <small><span>更自由</span><span>更准确</span></small>
              </label>
              <button className="advanced-toggle" type="button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced}><span>高级设置</span><i>{advanced ? "−" : "+"}</i></button>
              {advanced && (
                <div className="advanced-grid">
                  <label className="field"><span>采样器</span><div className="select-wrap"><select value={sampler} onChange={(event) => setSampler(event.target.value)}><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_sde">DPM++ SDE</option></select></div></label>
                  <label className="field"><span>随机种子</span><input className="plain-input" inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value.replace(/\D/g, ""))} placeholder="随机" /></label>
                </div>
              )}
            </section>

            <section className="rail-section connection-panel">
              <button type="button" className="rail-accordion" onClick={() => setConnectionOpen((value) => !value)} aria-expanded={connectionOpen}>
                <span className="rail-accordion-title">连接服务</span>
                <span className={`status-pill small ${directory ? "ok" : "warn"}`}><i aria-hidden="true" />{directoryName ? `文件夹 · ${directoryName}` : "未选择文件夹"}</span>
                <i className="chevron" aria-hidden="true" />
              </button>
              {connectionOpen && (
                <div className="rail-accordion-body">
                  <div className="folder-row">
                    <div><b>{directoryName || "尚未选择图片文件夹"}</b><small>作品直接保存到此文件夹；IndexedDB 仅存轻量元数据，不再占用浏览器存储</small></div>
                    <button type="button" onClick={chooseDirectory}>{directoryName ? "更换文件夹" : "选择文件夹"}</button>
                  </div>
                  {legacyCount > 0 && (
                    <div className="folder-row">
                      <div><b>{legacyCount} 条旧记录仍在浏览器中</b><small>迁移后图片会导入到文件夹，浏览器记录只保留元数据</small></div>
                      <button type="button" onClick={migrateLegacyData} disabled={Boolean(migrationState?.running)}>{migrationState?.running ? `迁移中 ${migrationState.done}/${migrationState.total}` : "迁移旧数据"}</button>
                    </div>
                  )}
                  <div className="channel-switch" role="radiogroup" aria-label="生成渠道">
                    <button type="button" role="radio" aria-checked={channel === "official"} className={channel === "official" ? "active" : ""} onClick={() => setChannel("official")}>
                      <span className="channel-icon official-icon">N</span>
                      <span><b>官方渠道</b><small>NovelAI 官方接口</small></span>
                    </button>
                    <button type="button" role="radio" aria-checked={channel === "relay"} className={channel === "relay" ? "active" : ""} onClick={() => setChannel("relay")}>
                      <span className="channel-icon relay-icon" aria-hidden="true">R</span>
                      <span><b>中转渠道</b><small>自定义兼容接口</small></span>
                    </button>
                  </div>
                  {channel === "relay" && (
                    <label className="field">
                      <span>中转服务 URL <b>必填</b></span>
                      <div className="input-wrap"><span className="input-icon" aria-hidden="true" /><input type="url" value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="https://example.com/v1/images/generations" autoComplete="url" /></div>
                      <small>支持完整生成端点，也可填写以 /v1 结尾的基础地址</small>
                    </label>
                  )}
                  <label className="field">
                    <span>API Key <b>必填</b></span>
                    <div className="input-wrap"><span className="input-icon key-icon" aria-hidden="true" /><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入你的 API Key" autoComplete="off" /><button type="button" className="key-toggle" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? "隐藏" : "显示"}</button></div>
                    <small><span className="mini-lock" aria-hidden="true" /> 默认仅用于当前页面；可选择只在此浏览器记住</small>
                  </label>
                  <div className="persistence-controls">
                    <div className="remember-row">
                      <label><input type="checkbox" checked={rememberKey} onChange={(event) => setRememberKey(event.target.checked)} /><span>在此浏览器记住 API Key</span></label>
                      {rememberKey && apiKey && <button type="button" onClick={forgetApiKey}>清除 Key</button>}
                    </div>
                    <p>Key 不会写入图片或 JSON，但同一浏览器中的脚本、本机用户及扩展可能读取它。</p>
                  </div>
                </div>
              )}
            </section>
          </div>

          <div className="rail-footer">
            {activeTask && (
              <div className="progress-block" role="status" aria-live="polite">
                <div className="progress-copy"><span>{progressLabelFor(activeTask.progress)}{pendingTaskCount > 0 ? ` · 还有 ${pendingTaskCount} 个排队` : ""}</span><b>{activeTask.progress}%</b></div>
                <div className="progress-track"><i style={{ width: `${activeTask.progress}%` }} /></div>
                <button type="button" onClick={cancelAllTasks}>取消全部任务</button>
              </div>
            )}
            {formError && <p className="error-message" role="alert">{formError}</p>}
            <button className="generate-button" type="submit"><span className="spark" aria-hidden="true" /><span>{runningTaskCount > 0 ? "加入队列" : "开始生成"}<small>{runningTaskCount > 0 ? `生成中 ${runningTaskCount} · 排队 ${pendingTaskCount}` : batchCount > 1 ? `一次生成 ${batchCount} 张 · 约 ${25 * batchCount}–${32 * batchCount} Anlas` : "预计消耗 25–32 Anlas"}</small></span><b aria-hidden="true" /></button>
            <p className="privacy-note"><span aria-hidden="true" /> 官方请求由浏览器直连；记录仅保存在你的设备</p>
            {storageNotice && <p className="rail-storage" role="status">{storageNotice}</p>}
          </div>
        </form>

        <section className="canvas-area" id="artist-favorites" aria-label="创作结果与画师串收藏">
          <div className="canvas-toolbar">
            <div className="view-tabs" role="tablist" aria-label="主区视图切换">
              <button type="button" role="tab" aria-selected={mainView === "results"} className={mainView === "results" ? "active" : ""} onClick={() => { setMainView("results"); setSelectedArtistThreadId(null); }}>创作结果</button>
              <button type="button" role="tab" aria-selected={mainView === "favorites"} className={mainView === "favorites" ? "active" : ""} onClick={() => setMainView("favorites")}>画师串收藏 <b>{artistFavorites.length}</b></button>
            </div>
            <div className="canvas-tools">
              {mainView === "results" ? (
                <>
                  <span>{images.length ? `${images.length} 张本机作品` : "等待第一次灵感"}</span>
                  {images.length > 0 && <button type="button" onClick={clearLocalHistory}>清空本机记录</button>}
                </>
              ) : (
                <span>{favoriteThreads.length} 个收藏 · 清空图片记录不会删除收藏</span>
              )}
            </div>
          </div>
          {tasks.length > 0 && (
            <div className="queue-strip" aria-label="生成任务队列">
              <div className="queue-strip-head">
                <span>任务队列 <b>{tasks.length}</b></span>
                <button type="button" onClick={clearFinishedTasks}>清除已完成</button>
              </div>
              <div className="queue-items">
                {tasks.map((task) => (
                  <div className={`queue-item ${task.status}`} key={task.id} title={task.error || task.params.finalPrompt}>
                    <span className="queue-item-model">{task.params.model.replace("nai-diffusion-", "V")}</span>
                    {task.status === "pending" && <span className="queue-badge pending">排队中</span>}
                    {task.status === "running" && <span className="queue-badge running">{task.progress}%</span>}
                    {task.status === "done" && <span className="queue-badge done">✓ {((task.durationMs || 0) / 1000).toFixed(2)}s</span>}
                    {task.status === "error" && <span className="queue-badge error">{/自动重试/.test(task.error || "") ? "等待重试" : "失败"}</span>}
                    {(task.status === "pending" || task.status === "running") && (
                      <button type="button" className="queue-cancel" onClick={() => cancelTask(task.id)} aria-label="取消该任务">×</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="canvas-scroll">
            {mainView === "favorites" ? (
              <section className="artist-favorites-view" aria-label="画师串收藏">
                {favoriteThreads.length === 0 ? (
                  <div className="empty-result artist-favorites-empty"><div className="empty-art"><i /><i /><span aria-hidden="true" /></div><h3>还没有收藏画师串</h3><p>在作品卡片中点击“收藏画师串”，即可集中查看该画师串的全部图片。</p></div>
                ) : (
                  <>
                    <div className="artist-favorites-heading"><div><p className="eyebrow"><span aria-hidden="true" /> ARTIST THREADS</p><h2 id="artist-favorites-title">画师串收藏</h2></div><span>点击封面查看该画师串的全部图片</span></div>
                    <div className="artist-thread-grid">{favoriteThreads.map((thread) => renderFavoriteThreadCard(thread))}</div>
                  </>
                )}
                {selectedArtistThread && (
                  <section className="artist-thread-detail" aria-labelledby="artist-thread-detail-title">
                    <div className="artist-thread-detail-heading"><div><p className="eyebrow"><span aria-hidden="true" /> CURRENT THREAD</p><h3 className="artist-thread-detail-title" id="artist-thread-detail-title">{artistThreadLabel(selectedArtistThread.artistPrompt)}</h3></div><div className="thread-heading-actions"><button type="button" className={`thread-copy${copiedSection === "thread" ? " copied" : ""}`} onClick={() => void copyLightboxSection("thread", selectedArtistThread.artistPrompt)}>{copiedSection === "thread" ? "已复制" : "复制画师串"}</button><button type="button" className="image-reuse-button" onClick={() => setSelectedArtistThreadId(null)}>返回收藏列表</button></div></div>
                    {selectedArtistThread.images.length === 0 ? (
                      <div className="empty-result artist-thread-empty"><h3>当前没有生成图片</h3><p>收藏仍会保留；下一次使用相同画师串生成图片后会自动归入这里。</p></div>
                    ) : (
                      <div className="image-grid">{selectedArtistThread.images.map((image) => renderImageCard(image, selectedArtistThread))}</div>
                    )}
                  </section>
                )}
              </section>
            ) : !directory ? (
              <div className="empty-result"><div className="empty-art"><i /><i /><span aria-hidden="true" /></div><h3>先选择一个图片文件夹</h3><p>作品会直接保存到你授权的本地文件夹，不再占用浏览器存储。请在左侧「连接服务」中选择文件夹后开始生成。</p></div>
            ) : images.length === 0 ? (
              <div className="empty-result"><div className="empty-art"><i /><i /><span aria-hidden="true" /></div><h3>画布已经准备好了</h3><p>完成左侧设置并开始生成，你的作品会出现在这里。</p><ol className="empty-steps"><li><b>1</b><span><strong>选择渠道</strong>官方直连，或使用兼容的中转服务。</span></li><li><b>2</b><span><strong>输入密钥</strong>Key 只参与当前请求，刷新即清除。</span></li><li><b>3</b><span><strong>描述并生成</strong>调整参数，然后等待作品完成。</span></li></ol></div>
            ) : (
              <>
                <div className="image-grid">
                  {visibleImages.map((image) => renderImageCard(image))}
                </div>
                {visibleCount < images.length && (
                  <div className="load-more-row">
                    <button type="button" className="load-more-button" onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}>加载更多（剩余 {images.length - visibleCount} 张）</button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <TagMarket open={tagMarketOpen} onClose={() => setTagMarketOpen(false)} onToggle={toggleTag} positivePrompt={positivePrompt} negativePrompt={negativePrompt} />

      {lightboxImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-labelledby="lightbox-title" onClick={() => setLightboxImage(null)}>
          <div className="image-lightbox-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="image-lightbox-header">
              <h2 id="lightbox-title">生成图片预览</h2>
              {images.length > 1 && lightboxIndex >= 0 && <span className="image-lightbox-counter" aria-hidden="true">{lightboxIndex + 1} / {images.length}</span>}
              <button type="button" className="image-lightbox-close" onClick={() => setLightboxImage(null)} aria-label="关闭图片预览"><span aria-hidden="true" /></button>
            </div>
            <div className="image-lightbox-body">
              <div
                className={`image-lightbox-stage${lightboxZoom > 1 ? " zoomed" : ""}`}
                ref={lightboxStageRef}
                onPointerDown={onLightboxPointerDown}
                onPointerMove={onLightboxPointerMove}
                onPointerUp={onLightboxPointerUp}
                onPointerCancel={onLightboxPointerUp}
                onDoubleClick={() => (lightboxZoom > 1 ? resetLightboxZoom() : setLightboxZoom(2.5))}
              >
                {lightboxSrc ? (
                  <img className="image-lightbox-image" src={lightboxSrc} alt={"生成图片"} draggable={false} style={{ transform: `translate(${lightboxPan.x}px, ${lightboxPan.y}px) scale(${lightboxZoom})` }} onError={() => setLightboxSrc(undefined)} />
                ) : (
                  <div className="image-lightbox-image lazy-image-placeholder" aria-hidden="true" />
                )}
                {images.length > 1 && lightboxZoom === 1 && (
                  <>
                    <button type="button" className="image-lightbox-nav prev" onClick={() => stepLightbox(-1)} aria-label="上一张图片"><span aria-hidden="true" /></button>
                    <button type="button" className="image-lightbox-nav next" onClick={() => stepLightbox(1)} aria-label="下一张图片"><span aria-hidden="true" /></button>
                  </>
                )}
                <div className="zoom-controls" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                  <button type="button" onClick={() => adjustLightboxZoom(-0.25)} disabled={lightboxZoom <= 1} aria-label="缩小">−</button>
                  <span>{Math.round(lightboxZoom * 100)}%</span>
                  <button type="button" onClick={() => adjustLightboxZoom(0.25)} disabled={lightboxZoom >= 4} aria-label="放大">+</button>
                  <button type="button" className="zoom-reset" onClick={resetLightboxZoom} disabled={lightboxZoom === 1}>重置</button>
                </div>
              </div>
              <aside className="image-lightbox-side">
                {lightboxImage.artistPrompt.trim() && (
                  <div className="prompt-block artist">
                    <div className="prompt-block-head">
                      <h3>画师串</h3>
                      <button type="button" className={`prompt-copy${copiedSection === "artist" ? " copied" : ""}`} onClick={() => void copyLightboxSection("artist", lightboxImage.artistPrompt)}>{copiedSection === "artist" ? "已复制" : "复制"}</button>
                    </div>
                    <p>{lightboxImage.artistPrompt}</p>
                  </div>
                )}
                <div className="prompt-block">
                  <div className="prompt-block-head">
                    <h3>提示词</h3>
                    <button type="button" className={`prompt-copy${copiedSection === "prompt" ? " copied" : ""}`} onClick={() => void copyLightboxSection("prompt", lightboxImage.positivePrompt || lightboxImage.prompt || "")}>{copiedSection === "prompt" ? "已复制" : "复制"}</button>
                  </div>
                  <p>{lightboxImage.positivePrompt || lightboxImage.prompt || "（未填写）"}</p>
                </div>
                <div className="prompt-block negative">
                  <div className="prompt-block-head">
                    <h3>反向提示词</h3>
                    <button type="button" className={`prompt-copy${copiedSection === "negative" ? " copied" : ""}`} onClick={() => void copyLightboxSection("negative", lightboxImage.negativePrompt)}>{copiedSection === "negative" ? "已复制" : "复制"}</button>
                  </div>
                  <p>{lightboxImage.negativePrompt || "（未填写）"}</p>
                </div>
                <div className="meta-chips" aria-label="生成参数">
                  <span className="meta-chip">模型 · {lightboxImage.model.replace("nai-diffusion-", "V")}</span>
                  <span className="meta-chip">尺寸 · {lightboxImage.size.replace("x", "×")}</span>
                  {lightboxImage.steps != null && <span className="meta-chip">步数 · {lightboxImage.steps}</span>}
                  {lightboxImage.scale != null && <span className="meta-chip">CFG · {lightboxImage.scale}</span>}
                  {lightboxImage.sampler && <span className="meta-chip">采样器 · {lightboxImage.sampler.replace(/^k_/, "")}</span>}
                  {lightboxImage.seed != null && <span className="meta-chip">种子 · {lightboxImage.seed}</span>}
                  {lightboxImage.durationMs != null && <span className="meta-chip">耗时 · {(lightboxImage.durationMs / 1000).toFixed(1)}s</span>}
                </div>
                <p className="lightbox-file">{lightboxImage.filename}{lightboxImage.createdAt ? ` · ${new Date(lightboxImage.createdAt).toLocaleString()}` : ""}</p>
                <div className="image-lightbox-actions">
                  <button type="button" className="image-reuse-button" onClick={() => reuseGeneration(lightboxImage)}>再次使用提示词</button>
                  {lightboxSrc ? <a href={lightboxSrc} download={lightboxImage.filename}>下载原图</a> : null}
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}
