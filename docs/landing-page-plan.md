# Transfer 官网落地页 + 全球下载方案(设计文档)

> 目标:做一个类似 filo.buildwithais.com 的 App 介绍页,申请域名、部署到 Cloudflare,
> 并把 GitHub Release 安装包同步到 Cloudflare + 国内镜像,让全球(尤其中国大陆)用户都能无障碍下载。

## 0. 已确认的决策(决策树结论)

| 维度 | 决策 | 理由 |
|------|------|------|
| 中国可达性 | **不备案** → Cloudflare 全球 + 国内免备案镜像 | 备案需 2–3 周 + 国内注册商,个人开源项目不划算 |
| 国内镜像 | **Gitee Releases** | 免费、免备案、大陆访问快、开源项目最常用 |
| 落地页框架 | **Astro**(静态站 + i18n 中/英) | 为营销/文档站而生,首屏快、SEO 好,内置多语言 |
| 落地页托管 | **Cloudflare Pages** | 与参考站同栈;静态站免费 |
| 安装包托管 | **Cloudflare R2 公开桶 + 自定义域** | 安装包 81–177 MiB,**远超 Pages 单文件 25 MiB 上限**,只能放 R2 |
| 域名 | **新买,Cloudflare Registrar** | 无溢价、自带隐私保护;支持直接注册新域名 |

## 1. 关键事实(带证据)

- 参考站 `filo.buildwithais.com` 的 NS = `laura/lex.ns.cloudflare.com` → **确实托管在 Cloudflare**。
- **Cloudflare Pages 单文件上限 25 MiB**(developers.cloudflare.com/pages/platform/limits)。
- 当前 Release 资产(tag `v0.9.0`,Release 标题 `v0.9.0-release`):
  - `Transfer-0.9.0-mac-arm64.dmg` — 92 MiB
  - `Transfer-0.9.0-mac-universal.dmg` — 177 MiB
  - `Transfer-0.9.0-mac-x64.dmg` — 98 MiB
  - `Transfer-0.9.0-win-portable.exe` — 81 MiB
  - `Transfer-0.9.0-win-setup.exe` — 81 MiB
  - → **全部超 25 MiB**,必须走 R2,不能放 Pages。
- **R2 单对象上限 ~5 TiB**(developers.cloudflare.com/r2/platform/limits)→ 装得下。
- 现有 CI:`.github/workflows/build.yml`,tag `v*` 触发,产 mac dmg + win exe,`softprops/action-gh-release` 发 GitHub Release。
- 现有内容资产:`README.md`(中)、`README.en.md`(英),含完整功能表、工作原理、安全提醒 → **落地页文案可直接复用**。
- 项目图标资产在 `build/`(electron-builder icon)。

## 2. 目标架构

```
                         ┌─────────────────────────────────────┐
用户浏览器 ──────────────►│  落地页  transfer.example.com        │  Cloudflare Pages (Astro 静态站)
                         │  Hero / 功能 / 截图 / 下载按钮 / 页脚 │
                         └──────────────┬──────────────────────┘
                                        │ 点"下载"
                    ┌───────────────────┼────────────────────┐
                    ▼(海外/默认)         ▼(中国用户优先)       ▼(兜底)
        dl.example.com (R2 公开桶)   Gitee Releases        GitHub Releases
        Transfer-x.y.z-*.dmg/.exe    同名安装包             原始 Release
```

发版链路(改造后的 CI):
```
push tag vX.Y.Z
   └─► GitHub Actions
         ├─ 打包 mac dmg (arm64/x64/universal) + win exe (setup/portable)
         ├─ 发 GitHub Release (现状,保留)
         ├─ 【新增】rclone/aws-s3 推所有安装包 → Cloudflare R2 桶 releases/vX.Y.Z/
         ├─ 【新增】写/更新 R2 里 latest.json(记录最新版本号 + 各平台文件名)
         └─ 【新增】nkduy/gitee-release 或 API 推安装包 → Gitee Releases 镜像
```

落地页下载按钮读取 `dl.example.com/latest.json` 得到最新版本与文件清单,拼出三平台下载链接;
按 `navigator.language` / 时区粗判是否中国用户,决定默认展示 Gitee 还是 R2 链接(两个都列出,只是排序/默认不同)。

## 3. 落地页信息架构(对齐参考站 filo)

自上而下:

1. **顶栏 Nav**:Logo + 产品名 + 语言切换(中/英)+ GitHub 链接 + 主"下载"按钮。
2. **Hero**:一句话价值主张(局域网文件/文本/截图互传,无服务器无账号无云)+ 主副下载 CTA + 一张主截图/动图。
3. **核心特性区**:卡片式,取 README 特性表(自动发现 / 文件传送 / 文本消息 / 聊天界面 / 截图标注 / 自动接收 / 多语言)。
4. **工作原理**:简化版拓扑图(两台设备 UDP 发现 + HTTPS 直传,数据只在局域网)。
5. **截图/演示区**:主界面 + 截图标注工具的实拍图。
6. **下载区**(锚点 `#download`):
   - 三平台三张卡:macOS (Apple Silicon / Intel / Universal)、Windows (安装版 / 便携版)。
   - 每卡两个来源:主链接(海外 R2 / 中国 Gitee)+ 次链接(GitHub)。
   - 显示当前版本号(来自 latest.json)。
7. **安全说明**:复用 README 的安全提醒 + VPN/全隧道限制(可折叠)。
8. **页脚**:开源协议(MIT)、GitHub、Gitee、版本、作者。

多语言:Astro i18n,`/`(中文默认)+ `/en`。文案抽到 `src/i18n/{zh,en}.ts`。

## 4. 需要"你"手动做的事(需账号/付款/浏览器登录,我做不了)

> 这些我会给你**逐步操作清单**,但必须你本人在浏览器/终端里完成(涉及登录、实名、付款)。

- [ ] **M1. 注册 Cloudflare 账号**(若无)。
- [ ] **M2. 在 Cloudflare Registrar 买域名**(定好域名名字;约 $10/年起,看后缀)。
- [ ] **M3. 开通 Cloudflare R2**(需绑卡;免费额度:10GB 存储 + 每月 1000 万次 A 类/1 亿次 B 类操作,egress 免费)。
- [ ] **M4. 注册 Gitee 账号 + 建镜像仓库**(如 `zhoulf1006/transfer`)。
- [ ] **M5. 生成各类密钥并存进 GitHub Secrets**:
  - R2:`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`
  - Gitee:`GITEE_PAT`(私人令牌;仓库 `gitee.com/aloong/transfer`)
- [ ] **M6. 在 Cloudflare 建 Pages 项目**(连 GitHub 仓库或用 wrangler 部署)+ 绑自定义域。
- [ ] **M7. 给 R2 桶绑自定义域** `dl.example.com` 并开公开访问。

## 5. 我能自动化/直接产出的事

- [ ] **A1. 落地页脚手架**:在仓库新建 `site/`(Astro 项目),写好页面、组件、i18n、样式、下载逻辑。
- [ ] **A2. 文案 + 结构**:从 README 中/英版提炼 Hero/特性/原理/安全文案。
- [ ] **A3. 下载按钮逻辑**:读 `latest.json`、地区判断、三平台链接拼装。
- [ ] **A4. CI 改造**:在 `build.yml` 加 R2 上传 + latest.json 生成 + Gitee 镜像三步(用 secrets,不硬编码)。
- [ ] **A5. `latest.json` 生成脚本** + R2 上传脚本(rclone 或 aws-cli 指向 R2 S3 端点)。
- [ ] **A6. Pages 部署配置**(`wrangler.toml` 或 Pages 构建设置说明)。
- [ ] **A7. 本地预览验证**(`pnpm --dir site dev`)+ 构建产物检查。
- [ ] **A8. 文档**:一份"运维手册",写清如何发版、如何换域名、密钥都是什么。

## 6. 分阶段落地(建议顺序)

**阶段一:落地页可本地看(纯我做,不依赖任何账号)**
- A1 + A2 + A3(下载链接先用占位/GitHub 兜底)→ 本地 `pnpm dev` 看效果 → 你 review 视觉与文案。

**阶段二:上线落地页(需你 M1/M6)**
- 你建 Pages 项目 → 我配好构建设置 → 先用 `*.pages.dev` 免费域名上线看真机 → 满意后绑自定义域(依赖 M2)。

**阶段三:安装包托管 + 发版同步(需你 M3/M4/M5/M7)**
- 你开 R2 + Gitee + 存好 secrets → 我改 CI(A4/A5)→ 打一个测试 tag 跑通全链路 → 落地页下载按钮接真链接。

**阶段四:中国可达性验证 + 收尾**
- 你(或找大陆的朋友)实测:落地页能否打开、Gitee 下载是否顺畅 → 我按结果微调默认来源逻辑 → 写运维手册(A8)。

## 7. 边界情况 / 已知坑(前置到纸面)

- **Pages 25 MiB 限制**:落地页里**绝不能**把安装包当静态资源打包进 Pages,只能引用 R2/Gitee 外链。
- **R2 免费额度**:egress 免费,但存储 10GB;历史版本累积会超——latest.json 只指最新版,旧版可定期清理或只留最近 N 个。
- **中国访问落地页**:Cloudflare 免费版**不接大陆节点**,落地页本身在大陆可能偶尔打不开/慢。缓解:页面极简+静态首屏可秒开;若长期不稳,再考虑把落地页也镜像一份到 Gitee Pages(备选,不在本期)。
- **地区判断不可靠**:`navigator.language=zh` ≠ 在中国;时区判断也可被 VPN 干扰。策略:**永远两个来源都显示**,只调整默认高亮,不做强制重定向。
- **Gitee 仓库审核**:Gitee 对新仓库/Release 附件有人工审核,首次上传大文件可能延迟或需实名。发版同步要容忍 Gitee 步骤失败不阻断 GitHub 主流程(`continue-on-error`)。
- **CI secrets 缺失**:R2/Gitee 步骤要在 secret 缺失时**跳过而非报错**(照现有 mac 签名的 `HAS_XXX` 模式),让 fork/无凭据也能跑基础打包。
- **universal dmg 体积**:177 MiB 单文件,R2 上传/Gitee 审核都最吃力;可考虑下载区默认只推 arm64/x64,universal 作为"不确定就选它"的次选。
- **latest.json 缓存**:R2/CF 边缘缓存可能让新版本延迟生效;上传后需 purge 或设短 cache-control。

## 8. 成本预估(个人项目)

- 域名:约 $8–12/年(Cloudflare Registrar 成本价)。
- Cloudflare Pages:免费。
- Cloudflare R2:免费额度内基本 $0(存储 <10GB、egress 免费)。
- Gitee:免费。
- **合计:≈ 一个域名的钱/年。**
