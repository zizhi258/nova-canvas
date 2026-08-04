export type TagMarketItem = {
  id: string;
  name: string;
  prompt: string;
  category: string;
  description?: string;
  negative?: boolean;
  dataset?: string;
  path?: string[];
};

export type TagMarketDataset = {
  id: string;
  label: string;
  adult: boolean;
  count: number;
  items: TagMarketItem[];
};

export type TagMarketCatalog = {
  version: number;
  license: string;
  source: string;
  datasets: TagMarketDataset[];
};

export async function loadTagMarketCatalog() {
  const response = await fetch("/tag-market/catalog.json");
  if (!response.ok) throw new Error(`完整标签库加载失败（${response.status}）`);
  return response.json() as Promise<TagMarketCatalog>;
}

export const tagCategories = [
  "全部", "画质", "人物", "发型", "表情", "服装", "姿势", "构图", "光影", "场景", "风格", "负面词",
] as const;

export const builtInTags: TagMarketItem[] = [
  { id: "quality-masterpiece", name: "杰作", prompt: "masterpiece", category: "画质", description: "提升整体完成度" },
  { id: "quality-best", name: "最佳质量", prompt: "best quality", category: "画质" },
  { id: "quality-aesthetic", name: "高审美", prompt: "very aesthetic", category: "画质" },
  { id: "quality-detailed", name: "精致细节", prompt: "intricate details", category: "画质" },
  { id: "quality-wallpaper", name: "壁纸质感", prompt: "wallpaper quality", category: "画质" },
  { id: "person-1girl", name: "一位女孩", prompt: "1girl", category: "人物" },
  { id: "person-1boy", name: "一位男孩", prompt: "1boy", category: "人物" },
  { id: "person-solo", name: "单人", prompt: "solo", category: "人物" },
  { id: "person-adult", name: "成年角色", prompt: "adult", category: "人物" },
  { id: "person-android", name: "仿生人", prompt: "android", category: "人物" },
  { id: "hair-long", name: "长发", prompt: "long hair", category: "发型" },
  { id: "hair-short", name: "短发", prompt: "short hair", category: "发型" },
  { id: "hair-silver", name: "银发", prompt: "silver hair", category: "发型" },
  { id: "hair-black", name: "黑发", prompt: "black hair", category: "发型" },
  { id: "hair-wavy", name: "波浪发", prompt: "wavy hair", category: "发型" },
  { id: "hair-ponytail", name: "马尾", prompt: "ponytail", category: "发型" },
  { id: "face-smile", name: "微笑", prompt: "gentle smile", category: "表情" },
  { id: "face-serious", name: "认真", prompt: "serious expression", category: "表情" },
  { id: "face-blush", name: "脸红", prompt: "blush", category: "表情" },
  { id: "face-closed-eyes", name: "闭眼", prompt: "closed eyes", category: "表情" },
  { id: "face-looking", name: "看向镜头", prompt: "looking at viewer", category: "表情" },
  { id: "dress-kimono", name: "和服", prompt: "kimono", category: "服装" },
  { id: "dress-dress", name: "礼服", prompt: "elegant dress", category: "服装" },
  { id: "dress-suit", name: "西装", prompt: "formal suit", category: "服装" },
  { id: "dress-street", name: "街头穿搭", prompt: "streetwear", category: "服装" },
  { id: "dress-armor", name: "幻想铠甲", prompt: "fantasy armor", category: "服装" },
  { id: "pose-standing", name: "站立", prompt: "standing", category: "姿势" },
  { id: "pose-sitting", name: "坐姿", prompt: "sitting", category: "姿势" },
  { id: "pose-running", name: "奔跑", prompt: "running", category: "姿势" },
  { id: "pose-over-shoulder", name: "回眸", prompt: "looking back over shoulder", category: "姿势" },
  { id: "pose-hand-hair", name: "手抚头发", prompt: "hand in hair", category: "姿势" },
  { id: "shot-close", name: "特写", prompt: "close-up", category: "构图" },
  { id: "shot-cowboy", name: "牛仔镜头", prompt: "cowboy shot", category: "构图" },
  { id: "shot-full", name: "全身", prompt: "full body", category: "构图" },
  { id: "shot-dynamic", name: "动态构图", prompt: "dynamic composition", category: "构图" },
  { id: "shot-depth", name: "景深", prompt: "depth of field", category: "构图" },
  { id: "shot-low", name: "低机位", prompt: "from below", category: "构图" },
  { id: "light-cinematic", name: "电影光效", prompt: "cinematic lighting", category: "光影" },
  { id: "light-rim", name: "轮廓光", prompt: "rim lighting", category: "光影" },
  { id: "light-volumetric", name: "体积光", prompt: "volumetric lighting", category: "光影" },
  { id: "light-soft", name: "柔光", prompt: "soft lighting", category: "光影" },
  { id: "light-neon", name: "霓虹光", prompt: "neon lighting", category: "光影" },
  { id: "scene-night", name: "星空", prompt: "starry night", category: "场景" },
  { id: "scene-city", name: "未来都市", prompt: "futuristic city", category: "场景" },
  { id: "scene-forest", name: "魔法森林", prompt: "enchanted forest", category: "场景" },
  { id: "scene-room", name: "温馨房间", prompt: "cozy room", category: "场景" },
  { id: "scene-seaside", name: "海边", prompt: "seaside", category: "场景" },
  { id: "scene-flowers", name: "花海", prompt: "field of flowers", category: "场景" },
  { id: "style-anime", name: "动漫插画", prompt: "anime illustration", category: "风格" },
  { id: "style-watercolor", name: "水彩", prompt: "watercolor", category: "风格" },
  { id: "style-oil", name: "油画", prompt: "oil painting", category: "风格" },
  { id: "style-lineart", name: "线稿", prompt: "clean lineart", category: "风格" },
  { id: "style-cyberpunk", name: "赛博朋克", prompt: "cyberpunk", category: "风格" },
  { id: "style-retro", name: "复古未来", prompt: "retro futurism", category: "风格" },
  { id: "negative-lowres", name: "低分辨率", prompt: "lowres", category: "负面词", negative: true },
  { id: "negative-blurry", name: "模糊", prompt: "blurry", category: "负面词", negative: true },
  { id: "negative-anatomy", name: "错误人体", prompt: "bad anatomy", category: "负面词", negative: true },
  { id: "negative-hands", name: "错误手部", prompt: "bad hands, extra fingers", category: "负面词", negative: true },
  { id: "negative-text", name: "文字水印", prompt: "text, watermark, signature", category: "负面词", negative: true },
  { id: "negative-crop", name: "不良裁切", prompt: "cropped, out of frame", category: "负面词", negative: true },
];
