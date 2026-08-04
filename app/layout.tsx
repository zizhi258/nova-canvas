import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og-v2.png`;

  return {
    title: "Nova Canvas — NovelAI 图片生成工作台",
    description: "安全连接 NovelAI 官方或中转渠道，精细控制模型与生成参数。",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Nova Canvas — NovelAI 图片生成工作台",
      description: "把脑海里的世界，画出来。",
      type: "website",
      images: [{ url: image, width: 1734, height: 907, alt: "Nova Canvas 图片生成工作台" }],
    },
    twitter: { card: "summary_large_image", title: "Nova Canvas", description: "把脑海里的世界，画出来。", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
