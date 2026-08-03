import { createDecipheriv, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve(process.argv[2] || "../noval-plugin/chami_tavern-scene-plugin");
const outputFile = path.resolve(process.argv[3] || "public/tag-market/catalog.json");
const password = Buffer.from("061020");

function decryptCryptoJs(value) {
  const payload = Buffer.from(value.trim(), "base64");
  if (payload.subarray(0, 8).toString() !== "Salted__") throw new Error("标签文件不是预期的 CryptoJS/OpenSSL 格式");
  const salt = payload.subarray(8, 16);
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = createHash("md5").update(Buffer.concat([previous, password, salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  const decipher = createDecipheriv("aes-256-cbc", material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8");
}

function flattenDataset(root, datasetId, datasetLabel, adult) {
  const items = [];
  let sequence = 0;
  const walk = (value, category, pathParts) => {
    if (typeof value === "string") {
      const prompt = value.trim();
      if (!prompt) return;
      sequence += 1;
      items.push({
        id: `${datasetId}-${sequence}`,
        name: pathParts.at(-1) || prompt,
        prompt,
        category,
        path: pathParts.slice(0, -1),
        dataset: datasetId,
        negative: false,
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) walk(child, category, [...pathParts, name]);
  };
  for (const [category, value] of Object.entries(root)) walk(value, category, []);
  return { id: datasetId, label: datasetLabel, adult, count: items.length, items };
}

const definitions = [
  ["static-tags.json", "common", "通用标签库", false],
  ["static-tags1.json", "codex", "所长常规 NovelAI 法典", false],
  ["static-tags2.json", "adult", "所长色色 NovelAI 法典", true],
];

const datasets = [];
for (const [filename, id, label, adult] of definitions) {
  const encrypted = await readFile(path.join(sourceRoot, "data", filename), "utf8");
  const parsed = JSON.parse(decryptCryptoJs(encrypted));
  datasets.push(flattenDataset(parsed.categories || parsed, id, label, adult));
}

await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify({ version: 1, license: "CC0-1.0", source: "chami_tavern-scene-plugin", datasets }));
console.log(`已导入 ${datasets.reduce((total, dataset) => total + dataset.count, 0)} 个标签到 ${outputFile}`);
