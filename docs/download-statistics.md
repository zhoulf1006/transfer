# 安装包下载量统计

## 目标与口径

官网展示“当前已有 N 次下载 · macOS N · Windows N”，数据由 GitHub Releases 与 Cloudflare R2 两个来源组成。

- GitHub：采用 Release asset 的官方 `download_count`。
- R2：采用安装包响应字节数除以对应对象大小，得到“完整包等效下载数”。
- 公开正式版和公开预发布版都统计；草稿、非安装包附件、`latest.json` 与统计文件不统计。
- GitHub asset 删除后保留最后一次已观测计数。
- R2 小数保存在状态中；官网总数、macOS、Windows 均向下取整。
- 两个来源相加表示下载事件，不尝试识别跨来源重复用户。

## 数据流

`.github/workflows/download-statistics.yml` 每小时第 17 分钟运行，也支持手动触发：

1. 从 R2 下载上一版 `stats/downloads.json`，首次运行时允许不存在。
2. 通过 S3 API 列出 `releases/` 下的对象及大小。
3. 分页读取 GitHub Releases，合并当前 asset `download_count` 与历史状态。
4. 从上次 R2 游标到当前完整小时，分最多 24 小时的窗口查询 Cloudflare GraphQL Analytics。
5. 仅接受 `dl.aloongplanet.com`、真实访客、`GET`、`200/206`、`/releases/` 的流量。
6. 所有查询和校验成功后，覆盖上传 `stats/downloads.json`，缓存 5 分钟。

工作流使用固定 concurrency group，避免两个定时任务同时覆盖状态。失败时不上传新状态，游标不会推进，下一次会自动补齐。游标落后超过 7 天时任务明确失败，避免把不可恢复的数据缺口伪装成连续累计。

首次运行查询最近 167 个完整小时，给 Cloudflare 的 7 天数据保留边界留出余量；之后只增量查询尚未统计的完整小时。

## 状态文件

`https://dl.aloongplanet.com/stats/downloads.json` 是公开、无敏感信息的机器可读状态：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-07-22T10:05:00.000Z",
  "r2Cursor": "2026-07-22T10:00:00.000Z",
  "summary": {
    "total": 12.5,
    "macos": 8,
    "windows": 4.5,
    "sources": { "github": 10, "r2": 2.5 }
  },
  "github": { "assets": {} },
  "r2": { "objects": {} }
}
```

`github.assets` 以 GitHub asset ID 为键，保证删除资产后历史计数仍保留。`r2.objects` 以 R2 对象路径为键，保存对象大小与累计响应字节；若同一路径的对象大小改变，任务失败，避免用新大小解释旧流量。

## Cloudflare Analytics Token

1. Cloudflare Dashboard → **Manage account** → **Account API tokens**。
2. 选择 **Create Token** → **Custom token**。
3. Token name 可填 `transfer-download-statistics`。
4. Permissions 只添加：**Zone / Analytics / Read**。
5. Zone Resources 选择：**Include / Specific zone / aloongplanet.com**。
6. 创建后立即复制 Token；它只显示一次。
7. GitHub 仓库 → **Settings → Secrets and variables → Actions → Secrets**，新增：
   - `CF_ANALYTICS_API_TOKEN`：上一步复制的 Token。
8. Cloudflare 的 `aloongplanet.com` Overview 页面复制 Zone ID。
9. GitHub 仓库 → **Settings → Secrets and variables → Actions → Variables**，新增：
   - `CF_ZONE_ID`：Zone ID。

工作流继续复用已有 `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`。Zone ID 不是密钥，因此放 Variable；Token 必须放 Secret。

## R2 CORS

Pages 与 R2 自定义域是不同 origin。进入 R2 → `transfer-releases` → **Settings → CORS Policy → Add CORS policy**，粘贴 `build/r2-download-stats-cors.json` 的内容并保存。规则只允许 `https://transfer.aloongplanet.com` 发起 `GET`。

首次工作流成功后验证：

```bash
curl -sS -D - -o /dev/null \
  -H 'Origin: https://transfer.aloongplanet.com' \
  https://dl.aloongplanet.com/stats/downloads.json
```

响应应包含：

```text
access-control-allow-origin: https://transfer.aloongplanet.com
```

## 官网行为与失败模式

下载区在版本号下方读取统计 JSON，5 秒超时。只有 schema 正确、三个汇总值均为非负有限数且总数等于 macOS 与 Windows 之和时才显示统计行。

- JSON 不存在、网络失败、CORS 未配置、超时或 HTTP 非 2xx：静默隐藏统计行。
- JSON 损坏、schema 不支持或数值非法：静默隐藏统计行。
- 统计加载失败不会阻止页面渲染，也不会改变 GitHub/R2 下载链接。
- 中文显示“当前已有 N 次下载 · macOS N · Windows N”；英文显示“Downloads so far: N · macOS N · Windows N”。
