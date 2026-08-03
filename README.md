# Nova Canvas

Nova Canvas 是一个面向 NovelAI 的中文图片生成工作台。它提供清晰的参数配置界面，可通过 NovelAI 官方接口或兼容的中转服务生成图片，并在浏览器中预览、管理和下载结果。

![Nova Canvas 预览](public/og.png)

## 功能特点

- 浏览器直连 NovelAI 官方图片生成接口，绕过托管平台的出站网络限制
- 支持兼容的中转服务地址
- 支持选择模型、尺寸、步数、提示词引导系数等生成参数
- 支持正向提示词与负向提示词
- 完整迁移参考插件的三套本地标签库，共 21,000+ 个标签，保留分类与多级路径
- 标签超市支持标签库切换、分类/子分类浏览、中英文搜索、批量添加和渐进加载
- 标签收藏及自定义标签保存在当前浏览器，无需后端
- 在页面内展示生成结果并下载原图
- API Key 默认仅用于当前页面，也可由用户主动选择保存在当前浏览器
- 生成图片与记录使用 IndexedDB 保存在本机，刷新页面后仍可恢复
- 支持选择本地文件夹，同步图片文件与不含密钥的 `nova-canvas.json`
- 提供适配桌面端与移动端的中文界面

## 技术栈

- React 19、Next.js 16
- [vinext](https://github.com/cloudflare/vinext) 与 Vite
- Cloudflare Workers / Sites
- TypeScript、ESLint
- Drizzle ORM（预留 D1 数据库支持）

## 环境要求

- Node.js `>= 22.13.0`
- pnpm（推荐）或 npm
- 可用的 NovelAI API Key；使用中转渠道时还需提供兼容的服务地址

## 本地运行

```bash
pnpm install
pnpm dev
```

启动后，根据终端输出在浏览器中打开本地地址。

也可以使用 npm：

```bash
npm install
npm run dev
```

## 使用方法

1. 选择“官方直连”或“中转服务”。
2. 输入 API Key；如果选择中转服务，还需填写服务地址。
3. 编写正向提示词，并按需添加负向提示词；也可打开“标签超市”搜索、组合标签。
4. 选择模型、画面尺寸和其他生成参数。
5. 点击“开始生成”，完成后即可预览和下载图片。
6. 如需长期保留，可勾选“记住 API Key”或选择图片文件夹进行本机同步。

中转地址既可以是完整的图片生成端点，也可以是以 `/v1` 结尾的基础地址。

## 常用命令

```bash
# 启动开发服务器
pnpm dev

# 构建生产版本
pnpm build

# 运行构建与页面测试
pnpm test

# 检查代码规范
pnpm lint

# 根据 Drizzle schema 生成迁移
pnpm db:generate
```

## 项目结构

```text
app/                    页面、样式和图片生成 API
app/api/generate/       中转服务请求适配
build/                  Sites/Vite 构建插件
db/                     Drizzle 数据库入口与 schema
drizzle/                数据库迁移元数据
examples/d1/            可选的 Cloudflare D1 示例
public/                 静态资源
tests/                  渲染结果测试
worker/                 Cloudflare Worker 入口
.openai/hosting.json    Sites 托管配置
```

## 部署

项目包含 `.openai/hosting.json`，可直接关联 OpenAI Sites 项目。也可以基于 vinext/Cloudflare Workers 的部署流程自行发布。

生产部署前请确认：

- 服务运行环境能够访问所选图片生成接口。
- 不要把 API Key 写入代码、提交到 Git，或记录在服务日志中。
- 只使用你信任的中转服务；中转服务会收到请求中的 API Key 和生成参数。

## 隐私说明

API Key 默认只存在于当前页面内存中。用户主动勾选“记住 API Key”后，Key 会保存在当前浏览器的本地存储中；它不会写入图片、`nova-canvas.json` 或项目服务端。浏览器本地存储无法防止同源恶意脚本、浏览器扩展或其他本机用户读取，因此请只在可信设备上启用。

生成图片及其提示词、模型、尺寸等元数据保存在当前浏览器的 IndexedDB 中。支持 File System Access API 的桌面 Chromium 浏览器还可以把图片与 `nova-canvas.json` 同步到用户授权的本地文件夹；不支持该能力的浏览器仍可使用 IndexedDB。官方渠道由浏览器直接请求 NovelAI，中转渠道会经过本项目的服务端路由。

标签数据由 `chami_tavern-scene-plugin` 的 CC0 数据文件导入，生成后的完整目录位于 `public/tag-market/catalog.json`。如参考插件的数据有更新，可运行 `pnpm tags:import "F:\\mine\\noval-plugin\\chami_tavern-scene-plugin"` 重新生成目录。

## 相关资料

- [vinext](https://github.com/cloudflare/vinext)
- [Drizzle ORM：Cloudflare D1 指南](https://orm.drizzle.team/docs/get-started/d1-new)
