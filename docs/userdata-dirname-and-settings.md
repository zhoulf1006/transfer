# 统一 userData 目录名 + 设置菜单加"打开目录"入口

> 状态:设计(待 review 后实现)
> 触发:用户要 ①dev 与打包版 userData 目录名一致 ②设置里能一键打开图片目录/数据目录

## 1. 背景与事实(坐实)

- **无 `app.setName()`**(grep 全 src 无):`app.getName()` 走 Electron 默认——
  - **dev**(`electron-vite dev`,未打包):读 `package.json` `name` = **`transfer`**(小写)。
  - **打包版**:electron-builder 写入 `productName: Transfer`,`getName()` = **`Transfer`**(大写)。
  - 故 `getPath('userData')` 目录名 dev/打包**不一致**(mac 大小写不敏感看不出,Win/Linux 是两目录)。[electron-builder.yml:2 productName / package.json name]
- **userData 里存**:`messages.db`、`settings.json`、身份文件、`sent-images/`(截图原图)。[index.ts:229-255]
- **macOS 大小写不敏感(实测坐实)**:只建 `transfer/` 时 `existsSync('Transfer')` === true;`renameSync('transfer'→'Transfer')` 不报错、文件存活(同 inode 改显示名)。
- **既有设置 UI**:`SettingsModal`(App.tsx:593),标题"接收设置",仅自动接收开关+阈值,齿轮 ⚙ 入口(App.tsx:208)。

## 2. 目标

1. dev 与打包版 userData 目录名统一为 **`Transfer`**(`app.setName`)。
2. 设置弹层加"存储"分区:**打开图片目录**(`sent-images`)+ **打开数据目录**(整个 userData)。

**不做迁移**:用户只在 mac 开发,实测已证 mac 大小写不敏感 → `transfer` 与 `Transfer` 本就同一目录,`setName` 后 dev 无缝复用原数据,无需迁移脚本/逻辑。(Win/Linux 大小写敏感才需迁,但非当前场景,不做。)

## 3. 方案

### 3.1 统一目录名:`app.setName('Transfer')`

`index.ts` **最顶部**(所有 `getPath('userData')` / 单实例锁 / override 之前)加:

```ts
app.setName('Transfer') // dev 也用打包版目录名,统一 userData
```

- 必须在**第一次读 userData 之前**,否则目录名已定。
- 放在 `TRANSFER_USERDATA` override 之前无妨:override 是显式 `setPath('userData', ...)`,优先级高于 name 推导,不冲突。
- **mac 无缝**:大小写不敏感 → `transfer` 与 `Transfer` 同目录,setName 后 dev 直接复用原数据,无需迁移。

### 3.2 设置菜单加"存储"分区

`SettingsModal` 标题 "接收设置" → **"设置"**;分区:

```
┌─ 设置 ───────────────────────────────────┐
│  接收                                     │
│  ☑ 启用自动接收(文本始终自动)           │
│    文件大小上限 [100] MB                  │
│                                           │
│  存储                                     │
│  文件:  …/Downloads              📂       │
│                          [取消]  [保存]   │
└───────────────────────────────────────────┘
```

**展示式一行**(标签 + 路径 + 文件夹图标,点图标打开该目录):
- **文件:** → 接收文件的**下载目录**(`app.getPath('downloads')`,如 `~/Downloads`)。**收发的文件与图片都落这**(接收落盘无按类型分目录,见 receive-file.ts:`receiveDir` 唯一;`ext` 仅用于重名去重加序号)。
- **只有这一行**:`sent-images`(发送截图副本)是**内部实现**,不暴露给用户;数据目录(userData)也不暴露。故存储分区只展示 downloads。
- 路径过长:`text-overflow: ellipsis` + `direction: rtl` 左截断(保留末尾文件夹名可见)+ `title` 悬停看全,不撑破弹层。
- 图标 fire-and-forget,点即 `shell.openPath` 弹系统文件管理器,不关弹层。

**新增 IPC**(shared/ipc.ts CMD):
- `getStorageDirs` → main 返回 `{ downloads: app.getPath('downloads') }`(设置页展示路径用)。
- `openDownloadsDir` → main: `shell.openPath(downloads)`。
- ~~`openImagesDir` / `openDataDir`~~ 均已删(设置里不再有图片目录/数据目录入口)。

preload 暴露 `getStorageDirs()` / `openDownloadsDir()`。

## 4. 影响面 / 改动清单(外科手术式)

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 顶部 `app.setName('Transfer')`(override/锁/首次读 userData 之前);IPC handler `getStorageDirs`/`openDownloadsDir`(删 `openDataDir`/`openImagesDir`;`mkdir` import 随之清)。 |
| `src/shared/ipc.ts` | CMD 加 `getStorageDirs`/`openDownloadsDir`(删 `openDataDir`/`openImagesDir`);`StorageDirs = { downloads }`。 |
| `src/preload/index.ts` | 暴露 `getStorageDirs`/`openDownloadsDir`(删 `openDataDir`/`openImagesDir`)。 |
| `src/renderer/src/App.tsx` | `SettingsModal` 标题改"设置";"存储"分区改**展示式一行**(文件:downloads 路径 + 📂 图标),进弹层 `getStorageDirs` 拿路径;样式 storageRow/Label/Path(rtl 左截断)/IconBtn。 |
| `docs/` | 本文;DESIGN 若记了目录名/设置结构则同步。 |

## 5. 成功标准 / 验证

1. typecheck + test + build 绿。
2. dev 实测:`pnpm dev` 后 userData 目录名为 `Transfer`(mac 上 `~/Library/Application Support/Transfer/`),且原有聊天历史/设置仍在(mac 同目录,无缝)。
3. 设置弹层"存储":文件行显示 downloads 路径;📂 图标点击弹开下载目录;长路径省略不撑破弹层、悬停看全。
4. 回归:自动接收设置读写不变;多实例测试(TRANSFER_USERDATA)不受 setName 影响(override 仍优先)。

## 6. 分步实现(带检查点)

1. index.ts:顶部 `app.setName('Transfer')` → typecheck。✅时序在 override/锁/首次读之前。
2. IPC:CMD `getStorageDirs`/`openDownloadsDir`(删 `openDataDir`/`openImagesDir`)+ `StorageDirs = {downloads}` + handler + preload → typecheck。
3. SettingsModal 标题改"设置" + "存储"展示式一行(文件:downloads 路径 + 📂)+ 接线 → build。
4. dev 实测目录名 + 路径展示 + 图标弹目录。
5. 回同步 DESIGN(如涉及)。
6. 全绿后发版(v0.4.2)。
