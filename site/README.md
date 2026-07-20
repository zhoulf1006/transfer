# Transfer 官网落地页 (site/)

Astro 静态站,中英双语(中文 `/`,英文 `/en/`)。部署到 Cloudflare Pages。

## 本地预览

```bash
cd site
pnpm install
pnpm dev        # http://localhost:4321/
```

其他命令:

```bash
pnpm build      # 构建到 site/dist/
pnpm preview    # 预览构建产物
```

## 结构

```
site/
  src/
    pages/
      index.astro        # 中文首页 (/)
      en/index.astro     # 英文首页 (/en/)
    components/          # Hero / Features / HowItWorks / Download / Security
    layouts/Base.astro   # 顶栏 + 页脚 + <head>
    i18n/ui.ts           # 全部中英文案(提炼自 README)
    download-config.ts   # ★下载区数据源:版本号 + 文件名 + 三来源 URL
    styles/global.css    # 全局样式(品牌色 #8a67ab)
  public/favicon.svg     # 站点图标(复用 app 图标)
```

## 待办(阶段一之后)

- **换真实截图**:`src/components/Hero.astro` 里的占位框,替换为放在 `public/screenshots/` 的应用截图。
- **回填下载来源**:`src/download-config.ts` 顶部的 `R2_BASE` / `GITEE_REPO`(阶段三接好 R2、Gitee 后)。
- **换域名**:`astro.config.mjs` 的 `site` 字段。
- **发版更新版本号**:`download-config.ts` 的 `VERSION`(阶段三接 CI 后自动)。
