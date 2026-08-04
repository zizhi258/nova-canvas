"use client";

import { useEffect, useMemo, useState } from "react";
import { builtInTags, loadTagMarketCatalog, TagMarketDataset, TagMarketItem } from "./tag-market-data";

type Props = {
  open: boolean;
  onClose: () => void;
  onApply: (value: string, target: "positive" | "negative") => void;
};

const CUSTOM_KEY = "nova-canvas:custom-tags";
const FAVORITES_KEY = "nova-canvas:favorite-tags";
const PAGE_SIZE = 180;
const ROOT_LABEL = "全部目录";

function safeRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

/** The directory path excludes the final tag name. */
function directoryPath(tag: TagMarketItem): string[] {
  return [tag.category, ...(tag.path || [])];
}

/** Search and display use the complete [category, ...path, name] path. */
function completePath(tag: TagMarketItem): string[] {
  return [...directoryPath(tag), tag.name];
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function startsWithPath(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

export default function TagMarket({ open, onClose, onApply }: Props) {
  const [query, setQuery] = useState("");
  const [datasetId, setDatasetId] = useState("all");
  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<TagMarketItem[]>([]);
  const [datasets, setDatasets] = useState<TagMarketDataset[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(true);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [customName, setCustomName] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [target, setTarget] = useState<"positive" | "negative">("positive");

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setFavorites(safeRead<string[]>(FAVORITES_KEY, []));
      setCustomTags(safeRead<TagMarketItem[]>(CUSTOM_KEY, []).map((tag) => ({ ...tag, dataset: "custom" })));
    });
    void loadTagMarketCatalog()
      .then((catalog) => active && setDatasets(catalog.datasets))
      .catch((reason) => {
        if (!active) return;
        setCatalogError((reason as Error).message);
        setDatasets([{ id: "fallback", label: "基础标签", adult: false, count: builtInTags.length, items: builtInTags }]);
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, open]);

  const allCatalogTags = useMemo(() => datasets.flatMap((dataset) => dataset.items), [datasets]);
  const allTags = useMemo(() => [...allCatalogTags, ...customTags], [allCatalogTags, customTags]);
  const sourceItems = useMemo(() => {
    if (datasetId === "favorites") return allTags.filter((tag) => favorites.includes(tag.id));
    if (datasetId === "custom") return customTags;
    if (datasetId === "all") return allTags;
    // Do not infer an adult-content filter here: the catalog's common, codex,
    // and adult datasets are all available as first-class tabs.
    return datasets.find((dataset) => dataset.id === datasetId)?.items || [];
  }, [allTags, customTags, datasetId, datasets, favorites]);

  const normalizedQuery = query.trim().toLowerCase();
  const searchMode = normalizedQuery.length > 0;
  const directoryItems = useMemo(
    () => sourceItems.filter((tag) => samePath(directoryPath(tag), selectedPath)),
    [selectedPath, sourceItems],
  );
  const childFolders = useMemo(() => {
    const folders = new Map<string, { name: string; path: string[]; count: number }>();
    for (const tag of sourceItems) {
      const path = directoryPath(tag);
      if (!startsWithPath(path, selectedPath) || path.length <= selectedPath.length) continue;
      const name = path[selectedPath.length];
      if (!name) continue;
      const nextPath = [...selectedPath, name];
      const key = nextPath.join("\u0000");
      const folder = folders.get(key);
      if (folder) folder.count += 1;
      else folders.set(key, { name, path: nextPath, count: 1 });
    }
    return [...folders.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans"));
  }, [selectedPath, sourceItems]);
  const searchResults = useMemo(() => {
    if (!searchMode) return [];
    return sourceItems.filter((tag) => {
      const pathText = completePath(tag).join(" ");
      return `${pathText} ${tag.prompt} ${tag.description || ""}`.toLowerCase().includes(normalizedQuery);
    });
  }, [normalizedQuery, searchMode, sourceItems]);
  // Browsing renders tags at the current directory. When a directory also
  // contains nested folders, its direct tags remain visible so no catalog item
  // becomes unreachable; at a leaf this is the complete tag list for the node.
  const browseTags = directoryItems;
  const filteredTags = searchMode ? searchResults : browseTags;
  const visibleTags = filteredTags.slice(0, visibleLimit);
  const itemById = useMemo(() => new Map(allTags.map((tag) => [tag.id, tag])), [allTags]);
  const totalCount = datasets.reduce((total, dataset) => total + dataset.count, 0);

  if (!open) return null;

  function changeDataset(id: string) {
    setDatasetId(id);
    // A dataset is its own tree. Never carry a path from another tree over.
    setSelectedPath([]);
    setVisibleLimit(PAGE_SIZE);
  }

  function changePath(path: string[]) {
    setSelectedPath(path);
    setVisibleLimit(PAGE_SIZE);
  }

  function toggleFavorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter((value) => value !== id) : [...favorites, id];
    setFavorites(next);
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  }

  function addCustomTag() {
    if (!customName.trim() || !customPrompt.trim()) return;
    const item: TagMarketItem = {
      id: `custom-${Date.now()}`,
      name: customName.trim(),
      prompt: customPrompt.trim(),
      category: "自定义",
      dataset: "custom",
    };
    const next = [...customTags, item];
    setCustomTags(next);
    setSelected((value) => [...value, item.id]);
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
    setCustomName("");
    setCustomPrompt("");
    changeDataset("custom");
  }

  function removeCustom(id: string) {
    const next = customTags.filter((tag) => tag.id !== id);
    setCustomTags(next);
    setSelected((value) => value.filter((item) => item !== id));
    const nextFavorites = favorites.filter((item) => item !== id);
    setFavorites(nextFavorites);
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(nextFavorites));
  }

  function applySelection() {
    const value = selected.map((id) => itemById.get(id)?.prompt).filter((prompt): prompt is string => Boolean(prompt)).join(", ");
    if (!value) return;
    onApply(value, target);
    setSelected([]);
    onClose();
  }

  return (
    <div className="tag-market-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="tag-market" role="dialog" aria-modal="true" aria-labelledby="tag-market-title">
        <header className="tag-market-header">
          <div>
            <p>TAG MARKET · COMPLETE</p>
            <h2 id="tag-market-title">标签超市</h2>
            <span>{loading ? "正在加载完整标签库…" : `已收录 ${totalCount.toLocaleString()} 个原始标签，可搜索完整中英文内容`}</span>
          </div>
          <button type="button" className="tag-market-close" onClick={onClose} aria-label="关闭标签超市">×</button>
        </header>

        <div className="tag-market-toolbar">
          <label className="tag-search">
            <span aria-hidden="true">⌕</span>
            <input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setVisibleLimit(PAGE_SIZE); }} placeholder="搜索中文、英文、分类或完整路径" />
          </label>
          <div className="tag-target" aria-label="添加位置">
            <button type="button" className={target === "positive" ? "active" : ""} onClick={() => setTarget("positive")}>正向提示词</button>
            <button type="button" className={target === "negative" ? "active" : ""} onClick={() => setTarget("negative")}>反向提示词</button>
          </div>
        </div>

        <nav className="tag-datasets" aria-label="标签库">
          <button type="button" className={datasetId === "all" ? "active" : ""} onClick={() => changeDataset("all")}>全部库 <small>{totalCount.toLocaleString()}</small></button>
          {datasets.map((dataset) => <button type="button" key={dataset.id} className={`${datasetId === dataset.id ? "active" : ""} ${dataset.adult ? "adult" : ""}`} onClick={() => changeDataset(dataset.id)}>{dataset.label} <small>{dataset.count.toLocaleString()}</small></button>)}
          <button type="button" className={datasetId === "favorites" ? "active" : ""} onClick={() => changeDataset("favorites")}>★ 收藏 <small>{favorites.length}</small></button>
          <button type="button" className={datasetId === "custom" ? "active" : ""} onClick={() => changeDataset("custom")}>自定义 <small>{customTags.length}</small></button>
        </nav>

        <div className="tag-market-body">
          <nav className="tag-categories" aria-label="标签目录">
            <button type="button" className={!selectedPath.length && !searchMode ? "active" : ""} onClick={() => changePath([])}>根目录<small>{sourceItems.length.toLocaleString()}</small></button>
            {!searchMode && childFolders.map((folder) => <button type="button" key={folder.path.join("/")} className={selectedPath.join("/") === folder.path.join("/") ? "active" : ""} onClick={() => changePath(folder.path)} title={folder.path.join(" / ")}>{folder.name}<small>{folder.count.toLocaleString()}</small></button>)}
          </nav>
          <div className="tag-content">
            <div className="custom-tag-row">
              <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="自定义名称" aria-label="自定义名称" />
              <input value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="英文提示词，例如 moonlight" aria-label="自定义英文提示词" />
              <button type="button" onClick={addCustomTag} disabled={!customName.trim() || !customPrompt.trim()}>新增标签</button>
            </div>

            <nav className="tag-breadcrumbs" aria-label="当前位置">
              <button type="button" className={!selectedPath.length && !searchMode ? "active" : ""} onClick={() => changePath([])}>{ROOT_LABEL}</button>
              {!searchMode && selectedPath.map((segment, index) => <span className="tag-breadcrumb-segment" key={`${segment}-${index}`}><span aria-hidden="true">›</span><button type="button" className={index === selectedPath.length - 1 ? "active" : ""} onClick={() => changePath(selectedPath.slice(0, index + 1))}>{segment}</button></span>)}
              {searchMode && <span className="tag-breadcrumb-search">搜索结果</span>}
            </nav>

            {!searchMode && childFolders.length > 0 && <section className="tag-folder-section" aria-label="子目录">
              <div className="tag-folder-heading"><b>子目录</b><small>选择文件夹继续浏览</small></div>
              <div className="tag-folder-grid">
                {childFolders.map((folder) => <button type="button" className="tag-folder-card" key={`folder-${folder.path.join("/")}`} onClick={() => changePath(folder.path)} aria-label={`打开目录 ${folder.name}，${folder.count} 个标签`}>
                  <span className="tag-folder-icon" aria-hidden="true">▰</span><b>{folder.name}</b><small>{folder.count.toLocaleString()} 个标签</small>
                </button>)}
              </div>
            </section>}

            {catalogError && <p className="tag-catalog-error">{catalogError}，当前显示基础备用标签。</p>}
            <div className="tag-result-summary">{searchMode ? "搜索到" : "当前目录"} <b>{filteredTags.length.toLocaleString()}</b> 个标签{filteredTags.length > visibleTags.length && `，当前显示前 ${visibleTags.length.toLocaleString()} 个`}</div>
            <div className="tag-grid">
              {visibleTags.map((tag) => {
                const active = selected.includes(tag.id);
                return <article key={tag.id} className={`tag-card ${active ? "selected" : ""}`}>
                  <button type="button" className="tag-card-main" onClick={() => setSelected((value) => active ? value.filter((id) => id !== tag.id) : [...value, tag.id])} aria-pressed={active}>
                    <span className="tag-check" aria-hidden="true">{active ? "✓" : "+"}</span><b>{tag.name}</b><code>{tag.prompt}</code><small>{completePath(tag).join(" / ")}</small>
                  </button>
                  <button type="button" className={`tag-favorite ${favorites.includes(tag.id) ? "active" : ""}`} onClick={() => toggleFavorite(tag.id)} aria-label={favorites.includes(tag.id) ? `取消收藏 ${tag.name}` : `收藏 ${tag.name}`}>★</button>
                  {tag.dataset === "custom" && <button type="button" className="tag-delete" onClick={() => removeCustom(tag.id)} aria-label={`删除 ${tag.name}`}>×</button>}
                </article>;
              })}
              {!loading && !visibleTags.length && <div className="tag-empty"><b>{searchMode ? "没有找到标签" : childFolders.length ? "选择一个子目录" : "当前目录没有标签"}</b><span>{searchMode ? "换个关键词试试，或在上方添加自定义标签。" : "使用面包屑或目录按钮返回上级。"}</span></div>}
            </div>
            {visibleTags.length < filteredTags.length && <button type="button" className="tag-load-more" onClick={() => setVisibleLimit((value) => value + PAGE_SIZE)}>继续显示 {Math.min(PAGE_SIZE, filteredTags.length - visibleTags.length).toLocaleString()} 个</button>}
          </div>
        </div>

        <footer className="tag-market-footer">
          <span>已选择 <b>{selected.length}</b> 个标签</span>
          <div><button type="button" className="tag-clear" onClick={() => setSelected([])} disabled={!selected.length}>清空</button><button type="button" className="tag-apply" onClick={applySelection} disabled={!selected.length}>添加到{target === "positive" ? "正向" : "反向"}提示词</button></div>
        </footer>
      </section>
    </div>
  );
}
