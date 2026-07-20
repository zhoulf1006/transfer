# Cloudflare Pages 部署手册(落地页上线)

> 目标:把 `site/`(Astro)部署到 Cloudflare Pages,绑定 `transfer.aloongplanet.com`,
> 连 GitHub 仓库自动部署(以后 push 到指定分支自动重建)。

## 前置

- [ ] PR #6 已合并进 `master`(Pages 要构建 master 上的 `site/`;若先连 `feat/landing-page` 分支也行,但合并后要改回 master)。
- [ ] `aloongplanet.com` 已在同一 Cloudflare 账户(已确认)。

---

## 第 1 步:创建 Pages 项目并连 GitHub

1. Cloudflare 面板 → 左侧 **Workers & Pages** → **Create application** → **Pages** 标签 → **Connect to Git**。
2. 授权 Cloudflare 访问你的 GitHub(首次会跳 GitHub 授权页,选择只授权 `zhoulf1006/transfer` 仓库即可)。
3. 选中仓库 **zhoulf1006/transfer** → **Begin setup**。

## 第 2 步:构建配置(关键,照填)

在 "Set up builds and deployments" 页:

| 字段 | 填什么 |
|------|--------|
| **Project name** | `transfer`(会成为 `transfer.pages.dev`,随意) |
| **Production branch** | `master` |
| **Framework preset** | `Astro`(选了会自动带出下面两项;没有就手填) |
| **Build command** | `pnpm install && pnpm build` |
| **Build output directory** | `dist` |
| **Root directory (Advanced)** | `site` ← **务必设成 site,否则找不到 Astro 项目** |

环境变量(Advanced → Environment variables):

| 变量 | 值 | 说明 |
|------|-----|------|
| `NODE_VERSION` | `20` | Astro 4 需 Node 18+;保险起见指定 20 |

> ⚠️ **Root directory = `site`** 是最容易漏的一项。你的 Astro 项目在仓库的 `site/` 子目录,不设它 Pages 会在仓库根找 package.json 而失败。
> 设了 Root directory 后,Build output directory 填 `dist`(相对 site/,即 site/dist),**不要**写成 `site/dist`。

## 第 3 步:首次部署

1. 点 **Save and Deploy**。
2. Pages 会拉代码、`pnpm install`、`pnpm build`,几分钟后给你一个 `https://transfer.pages.dev`(或类似)。
3. 打开这个临时地址,确认落地页正常、下载按钮能点(下载指向 `dl.aloongplanet.com`,R2 已验证可下)。

## 第 4 步:绑定自定义域 transfer.aloongplanet.com

1. 进 Pages 项目 → **Custom domains** → **Set up a domain**。
2. 输入 `transfer.aloongplanet.com` → **Continue**。
3. 因为 `aloongplanet.com` 已在本账户,Pages 会**自动创建 DNS 记录**(你不用手动加)→ **Activate domain**。
4. 状态变 Active 后,`https://transfer.aloongplanet.com` 就是你的落地页。

## 第 5 步:验证

- 打开 `https://transfer.aloongplanet.com` —— 落地页出来
- 切中英(点右上角 EN/中文)—— `/en/` 正常
- 点各平台下载按钮 —— 跳到 `dl.aloongplanet.com/releases/v0.9.0/...`,能下

---

## 以后怎么更新落地页

连了 GitHub 自动部署后:**改 `site/` 下的东西 → 合并到 `master` → Pages 自动重建**。无需手动操作。

## 常见坑

- **构建失败 "package.json not found"** → Root directory 没设成 `site`。
- **构建失败 pnpm 版本** → Pages 会读 `site/package.json` 的 `packageManager`?本项目 site 没写该字段,Pages 默认 pnpm 版本一般够用;若报错,加环境变量 `PNPM_VERSION=9`。
- **页面 404 / 样式丢失** → Build output directory 应为 `dist`(相对 site/),别写成绝对或 `site/dist`。
- **下载按钮 404** → 检查 R2 桶里确有 `releases/v0.9.0/` 对应文件(已验证有)。
