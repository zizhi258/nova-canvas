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
