export const runtime = "edge";

type GenerateRequest = {
  channel?: "official" | "relay";
  apiKey?: string;
  relayUrl?: string;
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  size?: string;
  steps?: number;
  scale?: number;
  sampler?: string;
  seed?: number;
};

const ALLOWED_MODELS = new Set([
  "nai-diffusion-4-5-full",
  "nai-diffusion-4-5-curated",
  "nai-diffusion-4-full",
  "nai-diffusion-3",
]);

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

function normalizeRelayUrl(value: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("中转 URL 仅支持 HTTP 或 HTTPS。 ");
  const path = url.pathname.replace(/\/$/, "");
  if (!path || path === "/") url.pathname = "/v1/images/generations";
  else if (path.endsWith("/v1")) url.pathname = `${path}/images/generations`;
  return url.toString();
}

function decodeBase64(value: string) {
  const normalized = value.includes(",") ? value.split(",").pop()! : value;
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function POST(request: Request) {
  let body: GenerateRequest;
  try {
    body = (await request.json()) as GenerateRequest;
  } catch {
    return jsonError("请求格式无效。 ");
  }

  const apiKey = body.apiKey?.trim();
  const prompt = body.prompt?.trim();
  const channel = body.channel === "relay" ? "relay" : "official";
  if (!apiKey) return jsonError("缺少 API Key。 ");
  if (!prompt) return jsonError("提示词不能为空。 ");
  if (prompt.length > 1800) return jsonError("提示词过长。 ");
  if (channel !== "relay") return jsonError("官方渠道已改为浏览器直连，请刷新页面后重试。 ");
  if (!body.relayUrl?.trim()) return jsonError("缺少中转服务 URL。 ");

  const [width, height] = (body.size || "832x1216").split("x").map(Number);
  const model = ALLOWED_MODELS.has(body.model || "") ? body.model! : "nai-diffusion-4-5-full";
  const steps = Math.max(10, Math.min(50, Math.round(body.steps || 28)));
  const scale = Math.max(1, Math.min(10, Number(body.scale || 6)));
  const seed = Number.isSafeInteger(body.seed) ? body.seed! : Math.floor(Math.random() * 4_294_967_295);

  let endpoint: string;
  try {
    endpoint = normalizeRelayUrl(body.relayUrl);
  } catch {
    return jsonError("中转服务 URL 格式不正确。 ");
  }

  const relayPayload = {
    model,
    prompt,
    negative_prompt: body.negativePrompt || "",
    size: `${width}x${height}`,
    width,
    height,
    n: 1,
    response_format: "b64_json",
    steps,
    scale,
    sampler: body.sampler || "k_euler_ancestral",
    seed,
  };

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/zip, image/*, application/json",
      },
      body: JSON.stringify(relayPayload),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      let message = `上游服务返回 ${upstream.status}`;
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string } | string; message?: string };
        message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || parsed.message || message;
      } catch {
        if (detail && detail.length < 220) message = detail;
      }
      return jsonError(message, upstream.status >= 500 ? 502 : upstream.status);
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType.startsWith("image/")) {
      return new Response(await upstream.arrayBuffer(), { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
    }

    if (contentType.includes("json")) {
      const data = (await upstream.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const item = data.data?.[0];
      if (item?.b64_json) {
        const bytes = decodeBase64(item.b64_json);
        return new Response(bytes, { headers: { "Content-Type": imageType("result", bytes), "Cache-Control": "no-store" } });
      }
      if (item?.url) {
        const image = await fetch(item.url);
        if (!image.ok) return jsonError("中转服务返回的图片链接无法读取。 ", 502);
        return new Response(await image.arrayBuffer(), { headers: { "Content-Type": image.headers.get("content-type") || "image/png", "Cache-Control": "no-store" } });
      }
      return jsonError("中转服务响应中没有图片数据。 ", 502);
    }

    return jsonError("中转服务返回了不支持的响应格式。 ", 502);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法连接生成服务";
    return jsonError(`连接生成服务失败：${message}`, 502);
  }
}
