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
