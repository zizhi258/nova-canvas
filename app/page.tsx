"use client";

import { unzipSync } from "fflate";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  clearGenerations,
  exportAllToFolder,
  filenameFor,
  hasDirectoryPermission,
  loadGenerations,
  loadArtistThreadFavorites,
  loadLocalSetting,
  LocalDirectoryHandle,
  saveGeneration,
  saveArtistThreadFavorites,
  saveLocalSetting,
  ArtistThreadFavorite,
  StoredGeneration,
  syncGenerationFolder,
} from "./local-persistence";
import TagMarket from "./tag-market";

type Channel = "official" | "relay";
type GeneratedImage = {
  id: number;
  src: string;
  blob: Blob;
  /** Optional legacy merged prompt retained when loading older records. */
  prompt?: string;
  artistPrompt: string;
  positivePrompt: string;
  negativePrompt: string;
  model: string;
  size: string;
  createdAt: string;
  filename: string;
};

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

/** Join prompt sections while avoiding empty sections and duplicate separators. */
function joinPromptParts(...parts: string[]) {
  return parts
    .map((part) => part.trim().replace(/^,+|,+$/g, "").trim())
    .filter(Boolean)
    .join(", ");
}

function displayPrompt(image: Pick<GeneratedImage, "artistPrompt" | "positivePrompt" | "prompt">) {
  return joinPromptParts(image.artistPrompt, image.positivePrompt || image.prompt || "");
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

function imageType(name: string, bytes: Uint8Array) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".webp") || (bytes[0] === 0x52 && bytes[1] === 0x49)) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || (bytes[0] === 0xff && bytes[1] === 0xd8)) return "image/jpeg";
  return "image/png";
}

function decodeBase64Image(value: string) {
  const normalized = value.includes(",") ? value.split(",").pop()! : value;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
      return new Blob([bytes.slice().buffer], { type: imageType("result", bytes) });
    }
    const encoded = candidate?.image || candidate?.b64_json || ("base64" in (candidate || {}) ? candidate?.base64 : undefined) || ("data" in (candidate || {}) ? candidate?.data : undefined);
    if (encoded) {
      const bytes = decodeBase64Image(encoded);
      return new Blob([bytes.slice().buffer], { type: imageType("result", bytes) });
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
    return new Blob([entry[1].slice().buffer], { type: imageType(entry[0], entry[1]) });
  } catch {
    throw new Error("NovelAI 返回的图片数据无法解压。 ");
  }
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
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [storageNotice, setStorageNotice] = useState("");
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [lightboxImage, setLightboxImage] = useState<GeneratedImage | null>(null);
  const [artistFavorites, setArtistFavorites] = useState<ArtistThreadFavorite[]>([]);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [selectedArtistThreadId, setSelectedArtistThreadId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<LocalDirectoryHandle | null>(null);
  const [directoryName, setDirectoryName] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!lightboxImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxImage(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [lightboxImage]);

  const progressLabel = useMemo(
    () => [...progressCopy].reverse().find((item) => progress >= item.at)?.label ?? progressCopy[0].label,
    [progress],
  );

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
    const trackedUrls = objectUrlsRef.current;
    void Promise.resolve().then(() => {
      if (!active) return;
      const savedKey = window.localStorage.getItem("nova-canvas:api-key");
      const shouldRemember = window.localStorage.getItem("nova-canvas:remember-key") === "true";
      if (shouldRemember && savedKey) setApiKey(savedKey);
      setRememberKey(shouldRemember);
      setKeyStorageReady(true);
    });

    void loadGenerations()
      .then((records) => {
        if (!active) return;
        setImages(
          records.map((record) => {
            const src = URL.createObjectURL(record.blob);
            objectUrlsRef.current.push(src);
            return { ...record, src };
          }),
        );
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

    return () => {
      active = false;
      controllerRef.current?.abort();
      trackedUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!keyStorageReady) return;
    window.localStorage.setItem("nova-canvas:remember-key", String(rememberKey));
    if (rememberKey && apiKey) window.localStorage.setItem("nova-canvas:api-key", apiKey);
    else window.localStorage.removeItem("nova-canvas:api-key");
  }, [apiKey, keyStorageReady, rememberKey]);

  async function generate(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!apiKey.trim()) {
      setError("请输入 API Key 后再开始生成。密钥仅用于本次请求。 ");
      return;
    }
    if (channel === "relay" && !relayUrl.trim()) {
      setError("中转渠道需要填写服务 URL。 ");
      return;
    }
    const cleanArtistPrompt = artistPrompt.trim();
    const cleanPositivePrompt = positivePrompt.trim();
    const finalPrompt = joinPromptParts(cleanArtistPrompt, cleanPositivePrompt);
    const cleanNegativePrompt = negativePrompt.trim();
    if (!finalPrompt) {
      setError("请先描述你想生成的画面。 ");
      return;
    }
    if (finalPrompt.length > 1800) {
      setError("画师串与正面提示词拼接后不能超过 1800 个字符，请删减后再生成。");
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setIsGenerating(true);
    setProgress(4);
    const ticker = window.setInterval(() => {
      setProgress((value) => {
        if (value >= 91) return value;
        const step = value < 35 ? 3 : value < 70 ? 2 : 1;
        return Math.min(91, value + step);
      });
    }, 520);

    try {
      const generatedSeed = seed ? Number(seed) : Math.floor(Math.random() * 4_294_967_295);
      let blob: Blob;

      if (channel === "official") {
        const [width, height] = size.split("x").map(Number);
        const cleanPrompt = finalPrompt;
        const correlationId = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
        const isV4 = model.startsWith("nai-diffusion-4");
        const parameters = {
          params_version: 3,
          width,
          height,
          scale,
          sampler,
          steps,
          n_samples: 1,
          seed: generatedSeed,
          prompt: cleanPrompt,
          negative_prompt: cleanNegativePrompt,
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
                  caption: { base_caption: cleanPrompt, char_captions: [] },
                  use_coords: false,
                  use_order: true,
                  legacy_uc: false,
                },
                v4_negative_prompt: {
                  caption: { base_caption: cleanNegativePrompt, char_captions: [] },
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
            Authorization: `Bearer ${apiKey.trim()}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Correlation-Id": correlationId,
            "X-Initiated-At": new Date().toISOString(),
          },
          signal: controller.signal,
          body: JSON.stringify({
            input: cleanPrompt,
            model,
            action: "generate",
            parameters,
          }),
        });
        if (!response.ok) {
          const message = await upstreamError(response, `NovelAI 返回 ${response.status}`);
          throw new Error(response.status >= 500 ? `${message}（请求编号：${correlationId}）` : message);
        }
        blob = await officialImage(response);
      } else {
        const response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            channel,
            apiKey,
            relayUrl,
            prompt: finalPrompt,
            negativePrompt: cleanNegativePrompt,
            model,
            size,
            steps,
            scale,
            sampler,
            seed: generatedSeed,
          }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error || `生成失败（${response.status}）`);
        }
        blob = await response.blob();
      }

      setProgress(96);
      if (!blob.type.startsWith("image/")) throw new Error("生成服务没有返回可显示的图片。 ");
      const id = Date.now();
      const createdAt = new Date().toISOString();
      const filename = filenameFor(id, blob);
      const record: StoredGeneration = {
        id,
        blob,
        artistPrompt: cleanArtistPrompt,
        positivePrompt: cleanPositivePrompt,
        negativePrompt: cleanNegativePrompt,
        model,
        size,
        createdAt,
        filename,
      };
      const src = URL.createObjectURL(blob);
      objectUrlsRef.current.push(src);
      const nextImages = [{ ...record, src }, ...images];
      setImages(nextImages);
      try {
        await saveGeneration(record);
        if (directory) {
          const stored = nextImages.map(({ id: imageId, blob: imageBlob, artistPrompt: imageArtistPrompt, positivePrompt: imagePositivePrompt, negativePrompt: imageNegativePrompt, model: imageModel, size: imageSize, createdAt: imageCreatedAt, filename: imageFilename }) => ({
            id: imageId,
            blob: imageBlob,
            artistPrompt: imageArtistPrompt,
            positivePrompt: imagePositivePrompt,
            negativePrompt: imageNegativePrompt,
            model: imageModel,
            size: imageSize,
            createdAt: imageCreatedAt,
            filename: imageFilename,
          }));
          await syncGenerationFolder(directory, stored, record);
          setStorageNotice(`图片已保存到浏览器和“${directory.name}”文件夹。`);
        } else {
          setStorageNotice("图片已保存在当前浏览器；选择本地文件夹后可同步图片与 JSON。 ");
        }
      } catch (storageError) {
        setStorageNotice((storageError as Error).message || "图片已生成，但本地持久化失败。 ");
      }
      setProgress(100);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") {
        setError((reason as Error).message || "生成未完成，请检查配置后重试。 ");
      }
    } finally {
      window.clearInterval(ticker);
      window.setTimeout(() => {
        setIsGenerating(false);
        setProgress(0);
      }, 450);
      controllerRef.current = null;
    }
  }

  function cancelGeneration() {
    controllerRef.current?.abort();
    setIsGenerating(false);
    setProgress(0);
  }

  function appendTags(value: string, target: "positive" | "negative") {
    const update = (current: string) => {
      const existing = current.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
      const additions = value.split(",").map((item) => item.trim()).filter((item) => item && !existing.includes(item.toLowerCase()));
      return [current.trim().replace(/,\s*$/, ""), ...additions].filter(Boolean).join(", ");
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
      setStorageNotice("当前浏览器不支持文件夹写入；图片仍会保存在浏览器本地数据库中。 ");
      return;
    }
    try {
      const selected = await picker({ mode: "readwrite" });
      if (!(await hasDirectoryPermission(selected, true))) throw new Error("没有获得文件夹写入权限。 ");
      const records = await loadGenerations();
      await exportAllToFolder(selected, records);
      await saveLocalSetting("directory", selected);
      setDirectory(selected);
      setDirectoryName(selected.name);
      setStorageNotice(`已连接“${selected.name}”，现有图片和 nova-canvas.json 已同步。`);
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setStorageNotice((reason as Error).message || "无法连接本地文件夹。 ");
    }
  }

  async function clearLocalHistory() {
    if (!window.confirm("确定清空当前浏览器中的生成记录吗？已同步到文件夹的图片文件不会被删除。")) return;
    try {
      await clearGenerations();
      images.forEach((image) => URL.revokeObjectURL(image.src));
      setImages([]);
      if (directory) await syncGenerationFolder(directory, []);
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
    document.querySelector(".prompt-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        {/* Generated result URLs are local object URLs created from the API response. */}
        <button type="button" className="image-preview-button" onClick={() => setLightboxImage(image)} aria-label="放大查看生成图片">
          <img src={image.src} alt={displayPrompt(image) || "生成图片"} loading="lazy" decoding="async" />
        </button>
        <div className="image-overlay"><span>{image.model.replace("nai-diffusion-", "V")}</span><a href={image.src} download={image.filename}>下载原图</a></div>
        <div className="image-card-footer">
          <div className="image-card-actions">
            <button type="button" className="image-reuse-button" onClick={() => reuseGeneration(image)}>再次使用提示词</button>
            <button type="button" className={`image-favorite-button${favorite ? " active" : ""}`} onClick={() => toggleArtistThreadFavorite(image.artistPrompt)} aria-pressed={Boolean(favorite)}>{favorite ? "取消收藏" : "收藏画师串"}</button>
            {favorite && resolvedThread && <button type="button" className="image-cover-button" onClick={() => setArtistThreadCover(resolvedThread, image.id)}>{favorite.coverImageId === image.id ? "当前封面" : "设为封面"}</button>}
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
            {cover ? <img src={cover.src} alt={artistThreadLabel(thread.artistPrompt)} loading="lazy" decoding="async" /> : <span className="artist-thread-cover-empty">暂无生成图片</span>}
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

  return (
    <main className="app-shell" id="main-content">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Nova Canvas 首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>NOVA <b>CANVAS</b></span>
        </a>
        <div className="topbar-note"><span className="live-dot" /> API 直连 · 本机可选保存</div>
        <a className="help-link" href="#guide">接入指南 <span aria-hidden="true" /></a>
        <button type="button" className="favorites-nav" onClick={() => { setFavoritesOpen(true); setSelectedArtistThreadId(null); document.querySelector(".results-section")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>画师串收藏 <b>{artistFavorites.length}</b></button>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow"><span aria-hidden="true" /> NOVELAI IMAGE STUDIO</p>
          <h1>把脑海里的世界，<em>画出来。</em></h1>
          <p className="hero-copy">连接 NovelAI 官方或你的中转服务，用精细参数掌控每一次创作。</p>
        </div>
        <div className="hero-stats" aria-label="产品特点">
          <div><strong>V4.5</strong><span>最新模型</span></div>
          <div><strong>1:1</strong><span>原图质量</span></div>
          <div><strong>LOCAL</strong><span>本机存储</span></div>
        </div>
      </section>

      <form className="workspace" onSubmit={generate}>
        <div className="control-column">
          <section className="panel connection-panel">
            <div className="section-heading">
              <span className="step-number">01</span>
              <div><h2>连接服务</h2><p>选择图片生成请求的发送方式</p></div>
              <span className="secure-badge">安全连接</span>
            </div>
            <div className="channel-switch" role="radiogroup" aria-label="生成渠道">
              <button type="button" role="radio" aria-checked={channel === "official"} className={channel === "official" ? "active" : ""} onClick={() => setChannel("official")}>
                <span className="channel-icon official-icon">N</span>
                <span><b>官方渠道</b><small>NovelAI 官方接口</small></span>
                <i className="radio-dot" />
              </button>
              <button type="button" role="radio" aria-checked={channel === "relay"} className={channel === "relay" ? "active" : ""} onClick={() => setChannel("relay")}>
                <span className="channel-icon relay-icon" aria-hidden="true">R</span>
                <span><b>中转渠道</b><small>自定义兼容接口</small></span>
                <i className="radio-dot" />
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
              <div className="input-wrap"><span className="input-icon" aria-hidden="true" /><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入你的 API Key" autoComplete="off" /><button type="button" className="key-toggle" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? "隐藏" : "显示"}</button></div>
              <small><span className="mini-lock" aria-hidden="true" /> 默认仅用于当前页面；可选择只在此浏览器记住</small>
            </label>
            <div className="persistence-controls">
              <div className="remember-row">
                <label><input type="checkbox" checked={rememberKey} onChange={(event) => setRememberKey(event.target.checked)} /><span>在此浏览器记住 API Key</span></label>
                {rememberKey && apiKey && <button type="button" onClick={forgetApiKey}>清除 Key</button>}
              </div>
              <p>Key 不会写入图片或 JSON，但同一浏览器中的脚本、本机用户及扩展可能读取它。</p>
              <div className="folder-row">
                <div><b>{directoryName || "尚未选择图片文件夹"}</b><small>图片始终保存在浏览器；授权后同时写入图片文件和 nova-canvas.json</small></div>
                <button type="button" onClick={chooseDirectory}>{directoryName ? "更换文件夹" : "选择文件夹"}</button>
              </div>
              {storageNotice && <p className="storage-notice" role="status">{storageNotice}</p>}
            </div>
          </section>

          <section className="panel prompt-panel">
            <div className="section-heading">
              <span className="step-number">02</span>
              <div><h2>描述画面</h2><p>详细的英文提示词通常会获得更稳定的效果</p></div>
              <button type="button" className="tag-market-trigger" onClick={() => setTagMarketOpen(true)}><span aria-hidden="true" /> 标签超市</button>
            </div>
            <label className="field prompt-field artist-prompt-field">
              <span>画师串 <small>可选；会与正面提示词自动拼接</small></span>
              <textarea value={artistPrompt} onChange={(event) => setArtistPrompt(event.target.value)} maxLength={1200} rows={3} placeholder="例如：masterpiece, best quality, by your favorite artist" />
              <span className="char-count">{artistPrompt.length} / 1200</span>
            </label>
            <label className="field prompt-field">
              <span>正面提示词</span>
              <textarea value={positivePrompt} onChange={(event) => setPositivePrompt(event.target.value)} maxLength={1800} rows={5} />
              <span className="char-count">{positivePrompt.length} / 1800</span>
            </label>
            <label className="field prompt-field negative-field">
              <span>反向提示词</span>
              <textarea value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} maxLength={1000} rows={3} />
              <span className="char-count">{negativePrompt.length} / 1000</span>
            </label>
          </section>
        </div>

        <div className="settings-column">
          <section className="panel settings-panel">
            <div className="section-heading compact-heading">
              <span className="step-number">03</span>
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

          <section className="generate-card">
            {isGenerating && (
              <div className="progress-block" role="status" aria-live="polite">
                <div className="progress-copy"><span>{progressLabel}</span><b>{progress}%</b></div>
                <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
                <button type="button" onClick={cancelGeneration}>取消生成</button>
              </div>
            )}
            {error && <p className="error-message" role="alert">{error}</p>}
            <button className="generate-button" type="submit" disabled={isGenerating}><span className="spark" aria-hidden="true" /><span>{isGenerating ? "正在生成..." : "开始生成"}<small>{isGenerating ? "请保持当前页面开启" : "预计消耗 25–32 Anlas"}</small></span><b aria-hidden="true" /></button>
            <p className="privacy-note"><span aria-hidden="true" /> 官方请求由浏览器直连；记录仅保存在你的设备</p>
          </section>
        </div>
      </form>
      <TagMarket open={tagMarketOpen} onClose={() => setTagMarketOpen(false)} onApply={appendTags} />

      <section className="results-section" id="artist-favorites" aria-labelledby="results-title">
        <div className="artist-favorites-toolbar">
          <button type="button" className={`artist-favorites-toggle${favoritesOpen ? " active" : ""}`} onClick={() => { setFavoritesOpen((value) => !value); setSelectedArtistThreadId(null); }} aria-expanded={favoritesOpen}>画师串收藏 <b>{artistFavorites.length}</b></button>
          {favoritesOpen && <span>收藏只保存画师串设置，清空图片记录不会删除收藏。</span>}
        </div>
        {favoritesOpen && (
          <section className="artist-favorites-view" aria-labelledby="artist-favorites-title">
            <div className="artist-favorites-heading"><div><p className="eyebrow"><span aria-hidden="true" /> ARTIST THREADS</p><h2 id="artist-favorites-title">画师串收藏</h2></div><span>{favoriteThreads.length} 个收藏</span></div>
            {favoriteThreads.length === 0 ? (
              <div className="empty-result artist-favorites-empty"><div className="empty-art"><i /><i /><span aria-hidden="true" /></div><h3>还没有收藏画师串</h3><p>在作品卡片中点击“收藏画师串”，即可集中查看该画师串的全部图片。</p></div>
            ) : (
              <div className="artist-thread-grid">{favoriteThreads.map((thread) => renderFavoriteThreadCard(thread))}</div>
            )}
            {selectedArtistThread && (
              <section className="artist-thread-detail" aria-labelledby="artist-thread-detail-title">
                <div className="artist-thread-detail-heading"><div><p className="eyebrow"><span aria-hidden="true" /> CURRENT THREAD</p><h3 className="artist-thread-detail-title" id="artist-thread-detail-title">{artistThreadLabel(selectedArtistThread.artistPrompt)}</h3></div><button type="button" className="image-reuse-button" onClick={() => setSelectedArtistThreadId(null)}>返回收藏列表</button></div>
                {selectedArtistThread.images.length === 0 ? (
                  <div className="empty-result artist-thread-empty"><h3>当前没有生成图片</h3><p>收藏仍会保留；下一次使用相同画师串生成图片后会自动归入这里。</p></div>
                ) : (
                  <div className="image-grid">{selectedArtistThread.images.map((image) => renderImageCard(image, selectedArtistThread))}</div>
                )}
              </section>
            )}
          </section>
        )}
        <div className="results-heading"><div><p className="eyebrow"><span aria-hidden="true" /> YOUR CREATIONS</p><h2 id="results-title">创作结果</h2></div><div className="results-tools"><span>{images.length ? `${images.length} 张本机作品` : "等待第一次灵感"}</span>{images.length > 0 && <button type="button" onClick={clearLocalHistory}>清空本机记录</button>}</div></div>
        {images.length === 0 ? (
          <div className="empty-result"><div className="empty-art"><i /><i /><span aria-hidden="true" /></div><h3>画布已经准备好了</h3><p>完成上方设置并开始生成，你的作品会出现在这里。</p></div>
        ) : (
          <div className="image-grid">
            {images.map((image) => (
              <article className="image-card" key={image.id}>
                {/* Generated result URLs are local object URLs created from the API response. */}
                <button type="button" className="image-preview-button" onClick={() => setLightboxImage(image)} aria-label="放大查看生成图片">
                  <img src={image.src} alt={displayPrompt(image) || "生成图片"} loading="lazy" decoding="async" />
                </button>
                <div className="image-overlay"><span>{image.model.replace("nai-diffusion-", "V")}</span><a href={image.src} download={image.filename}>下载原图</a></div>
                <div className="image-card-footer">
                  <div className="image-card-actions">
                    <button type="button" className={`image-favorite-button${favoriteForThread(artistThreadKey(image.artistPrompt), image.artistPrompt) ? " active" : ""}`} onClick={() => toggleArtistThreadFavorite(image.artistPrompt)} aria-pressed={Boolean(favoriteForThread(artistThreadKey(image.artistPrompt), image.artistPrompt))}>{favoriteForThread(artistThreadKey(image.artistPrompt), image.artistPrompt) ? "取消收藏" : "收藏画师串"}</button>
                    {(() => {
                      const thread = artistThreads.find((candidate) => candidate.id === artistThreadKey(image.artistPrompt));
                      const favorite = thread?.favorite;
                      return favorite && thread ? <button type="button" className="image-cover-button" onClick={() => setArtistThreadCover(thread, image.id)}>{favorite.coverImageId === image.id ? "当前封面" : "设为封面"}</button> : null;
                    })()}
                    <button type="button" className="image-reuse-button" onClick={() => reuseGeneration(image)}>再次使用提示词</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {lightboxImage && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-labelledby="lightbox-title" onClick={() => setLightboxImage(null)}>
          <div className="image-lightbox-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="image-lightbox-header">
              <h2 id="lightbox-title">生成图片预览</h2>
              <button type="button" className="image-lightbox-close" onClick={() => setLightboxImage(null)} aria-label="关闭图片预览"><span aria-hidden="true" /></button>
            </div>
            <img className="image-lightbox-image" src={lightboxImage.src} alt={displayPrompt(lightboxImage) || "生成图片"} />
            <dl className="image-lightbox-meta">
              <div><dt>画师串</dt><dd>{lightboxImage.artistPrompt || "（未填写）"}</dd></div>
              <div><dt>正面提示词</dt><dd>{lightboxImage.positivePrompt || lightboxImage.prompt || "（未填写）"}</dd></div>
              <div><dt>负面提示词</dt><dd>{lightboxImage.negativePrompt || "（未填写）"}</dd></div>
              <div><dt>模型</dt><dd>{lightboxImage.model}</dd></div>
              <div><dt>尺寸</dt><dd>{lightboxImage.size}</dd></div>
              <div><dt>生成时间</dt><dd>{lightboxImage.createdAt ? new Date(lightboxImage.createdAt).toLocaleString() : "（未知）"}</dd></div>
              <div><dt>文件名</dt><dd>{lightboxImage.filename}</dd></div>
            </dl>
            <div className="image-lightbox-actions">
              <button type="button" className="image-reuse-button" onClick={() => reuseGeneration(lightboxImage)}>再次使用提示词</button>
              <a href={lightboxImage.src} download={lightboxImage.filename}>下载原图</a>
            </div>
          </div>
        </div>
      )}

      <section className="guide" id="guide">
        <div><p className="eyebrow"><span aria-hidden="true" /> QUICK GUIDE</p><h2>三步开始创作</h2></div>
        <ol><li><b>1</b><span><strong>选择渠道</strong>官方直连，或使用兼容的中转服务。</span></li><li><b>2</b><span><strong>输入密钥</strong>Key 只参与当前请求，刷新即清除。</span></li><li><b>3</b><span><strong>描述并生成</strong>调整参数，然后等待作品完成。</span></li></ol>
      </section>

      <footer><a className="brand footer-brand" href="#top"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>NOVA <b>CANVAS</b></span></a><p>Independent NovelAI client · Built for creators</p><span>密钥不留存 · 图片不上传</span></footer>
    </main>
  );
}
