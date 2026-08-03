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

function safeRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export default function TagMarket({ open, onClose, onApply }: Props) {
  const [query, setQuery] = useState("");
  const [datasetId, setDatasetId] = useState("all");
  const [category, setCategory] = useState("全部");
  const [subCategory, setSubCategory] = useState("全部");
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
    return datasets.find((dataset) => dataset.id === datasetId)?.items || [];
  }, [allTags, customTags, datasetId, datasets, favorites]);
  const categories = useMemo(() => ["全部", ...Array.from(new Set(sourceItems.map((tag) => tag.category)))], [sourceItems]);
  const subCategories = useMemo(() => {
    const scoped = category === "全部" ? sourceItems : sourceItems.filter((tag) => tag.category === category);
    return ["全部", ...Array.from(new Set(scoped.map((tag) => tag.path?.[0]).filter((value): value is string => Boolean(value))))];
  }, [category, sourceItems]);
  const filteredTags = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return sourceItems.filter((tag) => {
      if (category !== "全部" && tag.category !== category) return false;
      if (subCategory !== "全部" && tag.path?.[0] !== subCategory) return false;
      if (!normalized) return true;
      return `${tag.name} ${tag.prompt} ${tag.category} ${(tag.path || []).join(" ")}`.toLowerCase().includes(normalized);
    });
  }, [category, query, sourceItems, subCategory]);
  const visibleTags = filteredTags.slice(0, visibleLimit);
  const itemById = useMemo(() => new Map(allTags.map((tag) => [tag.id, tag])), [allTags]);
  const totalCount = datasets.reduce((total, dataset) => total + dataset.count, 0);

  if (!open) return null;

  function changeDataset(id: string) {
    setDatasetId(id);
    setCategory("全部");
    setSubCategory("全部");
    setVisibleLimit(PAGE_SIZE);
  }

  function changeCategory(value: string) {
    setCategory(value);
    setSubCategory("全部");
    setVisibleLimit(PAGE_SIZE);
  }

  function toggleFavorite(id: string) {
    const next = favorites.includes(id) ? favorites.filter((value) => value !== id) : [...favorites, id];
    setFavorites(next);
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  }

  function addCustomTag() {
    if (!customName.trim() || !customPrompt.trim()) return;
    const item: TagMarketItem = { id: `custom-${Date.now()}`, name: customName.trim(), prompt: customPrompt.trim(), category: "自定义", dataset: "custom" };
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
          <div><p>TAG MARKET · COMPLETE</p><h2 id="tag-market-title">标签超市</h2><span>{loading ? "正在载入完整标签库…" : `已收录 ${totalCount.toLocaleString()} 个原始标签，可搜索完整中英文内容`}</span></div>
          <button type="button" className="tag-market-close" onClick={onClose} aria-label="关闭标签超市">×</button>
        </header>

        <div className="tag-market-toolbar">
          <label className="tag-search"><span aria-hidden="true">⌕</span><input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setVisibleLimit(PAGE_SIZE); }} placeholder="搜索中文、英文、分类或路径" /></label>
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
          <nav className="tag-categories" aria-label="标签分类">
            {categories.map((item) => <button type="button" key={item} className={category === item ? "active" : ""} onClick={() => changeCategory(item)}>{item}<small>{item === "全部" ? sourceItems.length.toLocaleString() : sourceItems.filter((tag) => tag.category === item).length.toLocaleString()}</small></button>)}
          </nav>
          <div className="tag-content">
            <div className="custom-tag-row">
              <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="自定义名称" />
              <input value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="英文提示词，如 moonlight" />
              <button type="button" onClick={addCustomTag} disabled={!customName.trim() || !customPrompt.trim()}>新增标签</button>
            </div>
            {subCategories.length > 1 && <div className="tag-subcategories">{subCategories.map((item) => <button type="button" key={item} className={subCategory === item ? "active" : ""} onClick={() => { setSubCategory(item); setVisibleLimit(PAGE_SIZE); }}>{item}</button>)}</div>}
            {catalogError && <p className="tag-catalog-error">{catalogError}，当前显示基础备用标签。</p>}
            <div className="tag-result-summary">找到 <b>{filteredTags.length.toLocaleString()}</b> 个标签{filteredTags.length > visibleTags.length && `，当前显示前 ${visibleTags.length.toLocaleString()} 个`}</div>
            <div className="tag-grid">
              {visibleTags.map((tag) => {
                const active = selected.includes(tag.id);
                return <article key={tag.id} className={`tag-card ${active ? "selected" : ""}`}>
                  <button type="button" className="tag-card-main" onClick={() => setSelected((value) => active ? value.filter((id) => id !== tag.id) : [...value, tag.id])} aria-pressed={active}>
                    <span className="tag-check">{active ? "✓" : "+"}</span><b>{tag.name}</b><code>{tag.prompt}</code>{tag.path?.length ? <small>{[tag.category, ...tag.path].join(" / ")}</small> : null}
                  </button>
                  <button type="button" className={`tag-favorite ${favorites.includes(tag.id) ? "active" : ""}`} onClick={() => toggleFavorite(tag.id)} aria-label={favorites.includes(tag.id) ? `取消收藏 ${tag.name}` : `收藏 ${tag.name}`}>★</button>
                  {tag.dataset === "custom" && <button type="button" className="tag-delete" onClick={() => removeCustom(tag.id)} aria-label={`删除 ${tag.name}`}>×</button>}
                </article>;
              })}
              {!loading && !visibleTags.length && <div className="tag-empty"><b>没有找到标签</b><span>换个关键词，或在上方添加自定义标签。</span></div>}
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
