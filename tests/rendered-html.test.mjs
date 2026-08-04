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
