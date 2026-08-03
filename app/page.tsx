"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Channel = "official" | "relay";
type GeneratedImage = {
  id: number;
  src: string;
  prompt: string;
  model: string;
  size: string;
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

export default function Home() {
  const [channel, setChannel] = useState<Channel>("official");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [prompt, setPrompt] = useState("1girl, silver hair, standing in a field of luminous flowers, starry night, cinematic lighting, intricate details");
  const [negativePrompt, setNegativePrompt] = useState("lowres, blurry, bad anatomy, extra fingers, watermark, text");
  const [model, setModel] = useState(models[0].value);
  const [size, setSize] = useState("832x1216");
  const [steps, setSteps] = useState(28);
  const [scale, setScale] = useState(6);
  const [sampler, setSampler] = useState("k_euler_ancestral");
  const [seed, setSeed] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const controllerRef = useRef<AbortController | null>(null);

  const progressLabel = useMemo(
    () => [...progressCopy].reverse().find((item) => progress >= item.at)?.label ?? progressCopy[0].label,
    [progress],
  );

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

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
    if (!prompt.trim()) {
      setError("请先描述你想生成的画面。 ");
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
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          channel,
          apiKey,
          relayUrl: channel === "relay" ? relayUrl : undefined,
          prompt,
          negativePrompt,
          model,
          size,
          steps,
          scale,
          sampler,
          seed: seed ? Number(seed) : undefined,
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `生成失败（${response.status}）`);
      }

      setProgress(96);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("生成服务没有返回可显示的图片。 ");
      const src = URL.createObjectURL(blob);
      setImages((current) => [
        { id: Date.now(), src, prompt: prompt.trim(), model, size },
        ...current,
      ]);
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Nova Canvas 首页">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>NOVA <b>CANVAS</b></span>
        </a>
        <div className="topbar-note"><span className="live-dot" /> API 直连 · 密钥不留存</div>
        <a className="help-link" href="#guide">接入指南 <span>↗</span></a>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow"><span>✦</span> NOVELAI IMAGE STUDIO</p>
          <h1>把脑海里的世界，<em>画出来。</em></h1>
          <p className="hero-copy">连接 NovelAI 官方或你的中转服务，用精细参数掌控每一次创作。</p>
        </div>
        <div className="hero-stats" aria-label="产品特点">
          <div><strong>V4.5</strong><span>最新模型</span></div>
          <div><strong>1:1</strong><span>原图质量</span></div>
          <div><strong>0</strong><span>密钥留存</span></div>
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
                <span className="channel-icon relay-icon">↗</span>
                <span><b>中转渠道</b><small>自定义兼容接口</small></span>
                <i className="radio-dot" />
              </button>
            </div>
            {channel === "relay" && (
              <label className="field">
                <span>中转服务 URL <b>必填</b></span>
                <div className="input-wrap"><span className="input-icon">⌁</span><input type="url" value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="https://example.com/v1/images/generations" autoComplete="url" /></div>
                <small>支持完整生成端点，也可填写以 /v1 结尾的基础地址</small>
              </label>
            )}
            <label className="field">
              <span>API Key <b>必填</b></span>
              <div className="input-wrap"><span className="input-icon">⌘</span><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入你的 API Key" autoComplete="off" /><button type="button" className="key-toggle" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "隐藏密钥" : "显示密钥"}>{showKey ? "隐藏" : "显示"}</button></div>
              <small><span className="mini-lock">◆</span> 仅在本次生成请求中使用，不会保存或记录</small>
            </label>
          </section>

          <section className="panel prompt-panel">
            <div className="section-heading">
              <span className="step-number">02</span>
              <div><h2>描述画面</h2><p>详细的英文提示词通常会获得更稳定的效果</p></div>
            </div>
            <label className="field prompt-field">
              <span>正向提示词</span>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={1800} rows={5} />
              <span className="char-count">{prompt.length} / 1800</span>
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
            {error && <p className="error-message">{error}</p>}
            <button className="generate-button" type="submit" disabled={isGenerating}><span className="spark">✦</span><span>{isGenerating ? "正在生成..." : "开始生成"}<small>{isGenerating ? "请保持当前页面开启" : "预计消耗 25–32 Anlas"}</small></span><b>→</b></button>
            <p className="privacy-note"><span>◇</span> 请求由你的浏览器安全发送，本站不存储密钥与图片</p>
          </section>
        </div>
      </form>

      <section className="results-section" aria-labelledby="results-title">
        <div className="results-heading"><div><p className="eyebrow"><span>✦</span> YOUR CREATIONS</p><h2 id="results-title">创作结果</h2></div><span>{images.length ? `${images.length} 张作品` : "等待第一次灵感"}</span></div>
        {images.length === 0 ? (
          <div className="empty-result"><div className="empty-art"><i /><i /><span>✦</span></div><h3>画布已经准备好了</h3><p>完成上方设置并开始生成，你的作品会出现在这里。</p></div>
        ) : (
          <div className="image-grid">
            {images.map((image) => (
              <article className="image-card" key={image.id}>
                {/* Generated result URLs are local object URLs created from the API response. */}
                <img src={image.src} alt={image.prompt} />
                <div className="image-overlay"><span>{image.model.replace("nai-diffusion-", "V")}</span><a href={image.src} download={`nova-${image.id}.png`}>下载原图 ↓</a></div>
                <p>{image.prompt}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="guide" id="guide">
        <div><p className="eyebrow"><span>✦</span> QUICK GUIDE</p><h2>三步开始创作</h2></div>
        <ol><li><b>1</b><span><strong>选择渠道</strong>官方直连，或使用兼容的中转服务。</span></li><li><b>2</b><span><strong>输入密钥</strong>Key 只参与当前请求，刷新即清除。</span></li><li><b>3</b><span><strong>描述并生成</strong>调整参数，然后等待作品完成。</span></li></ol>
      </section>

      <footer><a className="brand footer-brand" href="#top"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>NOVA <b>CANVAS</b></span></a><p>Independent NovelAI client · Built for creators</p><span>密钥不留存 · 图片不上传</span></footer>
    </main>
  );
}
