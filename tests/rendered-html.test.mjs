import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ships the Nova Canvas product experience", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(page, /NOVA <b>CANVAS<\/b>/);
  assert.match(page, /官方渠道/);
  assert.match(page, /中转渠道/);
  assert.match(page, /\/api\/generate/);
  assert.match(layout, /NovelAI 图片生成工作台/);
  assert.doesNotMatch(page, /SkeletonPreview/);
});

test("tag market keeps complete-path recursive navigation", async () => {
  const source = await readFile(new URL("../app/tag-market.tsx", import.meta.url), "utf8");

  assert.match(source, /selectedPath/);
  assert.match(source, /function completePath/);
  assert.match(source, /childFolders/);
  assert.match(source, /tag-breadcrumbs/);
  assert.match(source, /datasetId === "favorites"/);
  assert.match(source, /datasetId === "custom"/);
  assert.match(source, /datasetId === "all"/);
  assert.match(source, /dataset\.adult \? "adult"/);
  assert.doesNotMatch(source, /filter\(\s*\(tag\)\s*=>\s*!tag\.adult/);
});

test("ships the complete migrated tag market catalog", async () => {
  const catalog = JSON.parse(await readFile(new URL("../public/tag-market/catalog.json", import.meta.url), "utf8"));
  assert.equal(catalog.license, "CC0-1.0");
  assert.deepEqual(catalog.datasets.map((dataset) => dataset.id), ["common", "codex", "adult"]);
  assert.equal(catalog.datasets.reduce((total, dataset) => total + dataset.items.length, 0), 21169);
  assert.ok(catalog.datasets[0].items.some((item) => item.name === "衬衫" && item.prompt === "shirt"));
});

test("splits prompt history and provides an accessible image lightbox", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const persistence = await readFile(new URL("../app/local-persistence.ts", import.meta.url), "utf8");

  assert.match(page, /artistPrompt/);
  assert.match(page, /positivePrompt/);
  assert.match(page, /negativePrompt/);
  assert.match(page, /joinPromptParts/);
  assert.match(page, /replace\(\/\^,\+\|,\+\$\/g, ""\)/);
  assert.match(page, /const finalPrompt = joinPromptParts/);
  assert.match(page, /finalPrompt\.length > 1800/);
  assert.match(page, /image-lightbox/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /reuseGeneration/);
  assert.match(persistence, /normalizeGeneration/);
  assert.match(persistence, /legacyPrompt/);
  assert.match(persistence, /artistPrompt, positivePrompt, negativePrompt/);
  assert.match(persistence, /positivePrompt: typeof record\.positivePrompt === "string" \? record\.positivePrompt : legacyPrompt/);
});

test("omits disabled optional NovelAI parameters instead of sending invalid null values", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(page, /skip_cfg_above_sigma:\s*null/);
});

test("ships artist-thread favorites with durable covers and full-thread detail", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const persistence = await readFile(new URL("../app/local-persistence.ts", import.meta.url), "utf8");

  assert.match(page, /artistThreadKey/);
  assert.match(page, /loadArtistThreadFavorites/);
  assert.match(page, /saveArtistThreadFavorites/);
  assert.match(page, /artist-favorites-view/);
  assert.match(page, /renderFavoriteThreadCard/);
  assert.match(page, /data-cover-source/);
  assert.match(page, /setArtistThreadCover/);
  assert.match(page, /image-lightbox-meta/);
  assert.match(page, /lightboxImage\.createdAt/);
  assert.match(persistence, /ArtistThreadFavorite/);
  assert.match(persistence, /artist-thread-favorites/);
  assert.match(persistence, /normalizeArtistThreadFavorite/);
  assert.match(persistence, /LEGACY_ARTIST_FAVORITES_SETTING/);
});

test("ships the accessible editorial UI refresh", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(page, /className="skip-link" href="#main-content"/);
  assert.match(page, /className="error-message" role="alert"/);
  assert.match(page, /loading="lazy" decoding="async"/);
  assert.match(styles, /--indigo:\s*#6366f1/);
  assert.match(styles, /\.favorites-nav:focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(layout, /\/og-v2\.png/);
});

test("uses persisted WebP previews and keeps image cards cheap and stable", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const persistence = await readFile(new URL("../app/local-persistence.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /thumbnailSrc/);
  assert.match(page, /readGenerationPreview/);
  assert.match(page, /createThumbnailBlob/);
  assert.match(persistence, /THUMBNAIL_MAX_DIMENSION\s*=\s*384/);
  assert.match(persistence, /thumbnailFilenameFor/);
  assert.match(persistence, /writeGenerationThumbnail/);
  assert.doesNotMatch(styles, /\.image-card\s*\{[^}]*\bcontent-visibility\s*:/);
  assert.doesNotMatch(styles, /\.image-card\s*\{[^}]*\bcontain-intrinsic-size\s*:/);
  assert.doesNotMatch(styles, /\.image-card\s*\{[^}]*\banimation\s*:/);
  assert.doesNotMatch(styles, /\.image-card:hover/);
  assert.doesNotMatch(styles, /\.image-card img\s*\{[^}]*\btransform\s*:/);
  assert.doesNotMatch(styles, /\.image-overlay span,\s*\.image-download-button\s*\{[^}]*backdrop-filter\s*:/);
  assert.match(styles, /\.image-overlay span,\s*\.image-download-button\s*\{[^}]*background:\s*rgba\(27, 22, 35, 0\.9\)/);
  assert.match(styles, /\.image-card-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.image-card-actions\s*>\s*\.image-reuse-button:last-child/);
});

test("keeps long artist threads and prompt metadata within responsive containers", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /artist-thread-card-title/);
  assert.match(page, /artist-thread-detail-title/);
  assert.match(page, /image-card-footer/);
  assert.doesNotMatch(page, /<p className="image-prompt-row">/);
  assert.match(page, /lightboxImage\.positivePrompt/);
  assert.match(page, /lightboxImage\.negativePrompt/);
  assert.match(styles, /\.artist-thread-detail-heading > div[\s\S]*?min-width:\s*0/);
  assert.match(styles, /\.artist-thread-detail-heading > \.image-reuse-button[\s\S]*?flex:\s*0 0 auto/);
  assert.match(styles, /\.image-card-footer[\s\S]*?padding/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
  assert.match(styles, /word-break:\s*break-word/);
  assert.match(styles, /white-space:\s*normal/);
  assert.match(styles, /\.image-lightbox-meta dd[\s\S]*?min-width:\s*0/);
});

test("adds a readable gradient caption to artist-thread covers", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(page, /artist-thread-cover-frame/);
  assert.match(page, /artist-thread-cover-caption/);
  assert.match(page, /title=\{artistThreadLabel\(thread\.artistPrompt\)\}/);
  assert.match(styles, /\.artist-thread-cover-frame::after[\s\S]*?linear-gradient/);
  assert.match(styles, /\.artist-thread-cover-caption[\s\S]*?position:\s*absolute/);
  assert.match(styles, /-webkit-line-clamp:\s*2/);
  assert.match(styles, /\.artist-thread-grid\s*\{\s*grid-template-columns:\s*repeat\(2/);
  assert.match(styles, /\.artist-thread-cover\s*\{[\s\S]*?aspect-ratio:\s*4\s*\/\s*3/);
  assert.match(styles, /\.artist-thread-cover img\s*\{[\s\S]*?object-position:\s*center top/);
  assert.match(styles, /\.artist-favorites-view\s+\.artist-thread-cover\s*\{\s*aspect-ratio:\s*4\s*\/\s*5/);
});
