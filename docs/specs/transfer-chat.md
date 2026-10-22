# 传输与聊天(transfer-chat)

> 关联决策:[ADR-0003](../adr/0003-chat-persistence-node-sqlite.md)(聊天持久化)、
> [ADR-0004](../adr/0004-https-self-signed-tofu.md)(TOFU pinning)、
> [ADR-0020](../adr/0020-upload-idle-timeout-not-total.md)(超时改空闲语义)
>
> ⚠️ **这是一份存量逆向 spec**:模块先有实现、后补 spec(2026-08-21)。下面的边界穷举取自
> 三个独立来源——现行实现、`docs/DESIGN.md` 早期的失败模式表、以及**测试用例名**(它们记录的是
> 真正被驱动过的边界,而不是有人想到过的边界)。凡三者不一致处以实现为准,并在「已知缺口」标出。
> 与 [features/transfer-chat.md](../features/transfer-chat.md) 的分工:那边写"现在能干什么",这里写"想全了哪些边界、什么明确不做"。

## Problem

局域网里传个文件常要绕道 U 盘或网盘,传一段文本更是没有轻量通道——微信/邮件既要账号又压缩画质,AirDrop 只覆盖苹果生态。用户要的是:两台机器在同一个 Wi-Fi 下,像发消息一样把东西递过去。

约束来自使用场景本身:**没有服务器、没有账号**,两端地位对等;网络随时可能变(换 Wi-Fi、睡眠唤醒、对方退出);用户不愿为一次传输做任何配置。

## Solution

把文本与文件**统一为聊天气泡流**:选中设备即进入会话,发文本、发文件、发截图都是往流里加一条消息,记录本地持久化。传输走 LocalSend v2 协议直连对端(HTTPS + 指纹 TOFU,见 ADR-0004),文本被编码成一种特殊的"文件"随协商请求一起送达,不占用传输通道。

三个取舍决定了后面所有的边界:

1. **接收要用户确认**,而确认是异步的(用户可能几分钟后才点)。于是协商请求要在服务端**挂起**等确认,两端超时必须满足序关系,否则发送方会在用户点之前就断开。
2. **同一时刻只接受一个传输会话**。并发会话会让"谁的 token、谁的进度"变得难以推理,而局域网场景里并发传输的收益很低。
3. **超时一律是空闲语义,不是总时长**(ADR-0020)。判据是"还有没有字节在动",不是"传了多久"——否则文件一大就必然超时。

## User stories

- 作为发送方,我选中一台设备,拖进去几个文件,能看到每个文件各自的进度,并在对方拒绝或出错时知道**具体是什么原因**,而不是笼统的"失败"。
- 作为发送方,我发一段文字,对方立刻看到,不需要他点任何确认。
- 作为接收方,我在聊天流里看到"对方要发 X 给你",我点接收或拒绝;我可以只接受其中几个。
- 作为接收方,我打开自动接收后,小于阈值的文件不再打扰我。
- 作为任一方,我关掉 app 再打开,聊天记录还在。
- 作为任一方,我传一个很大的文件,只要网络没断,它就应该传完——慢只是慢。

### transfer-chat::US-001 Copy a chat image to paste it elsewhere

As either party, I right-click an image in the conversation — one I received or one I sent — and copy it, so I can paste it into another app without saving it to a file first.

- transfer-chat::US-001/AC-01: Right-clicking the thumbnail of an image message, received or sent, opens a menu whose items are, in this order: 复制图片 / 保存图片 / 用系统程序打开 (Copy Image / Save Image / Open with System App).
- transfer-chat::US-001/AC-02: Choosing 复制图片 closes the menu and puts the image on the system clipboard as image pixels only, with no file reference; pasting into an app that accepts images inserts the image.
- transfer-chat::US-001/AC-03: Copying shows no feedback, on success or on failure: the menu closes and nothing else appears.
- transfer-chat::US-001/AC-04: When the original file can no longer be read or decoded at the moment of copying (deleted, moved, or replaced by something undecodable after its thumbnail appeared), the clipboard keeps its previous content untouched.
- transfer-chat::US-001/AC-05: A JPEG whose EXIF orientation is one of the seven non-default values is copied rotated and/or mirrored as that value specifies, so it matches the full-size view; a JPEG with no orientation, the default one, an unrecognised value or unreadable EXIF, and every PNG, is copied as its pixels are stored.

## Functional Requirements

### transfer-chat::REQ-001 Thumbnails follow the EXIF orientation

- transfer-chat::REQ-001/AC-01: A JPEG with a non-default EXIF orientation shows its thumbnail in the orientation the full-size view shows (it used to show as stored, e.g. sideways), generated at the same width as every other thumbnail — a photo turned upright by a quarter turn is not narrower than one that is not; every other image's thumbnail is unchanged.
- transfer-chat::REQ-001/AC-02: Messages received before the upgrade get the corrected thumbnail the next time they are displayed; nothing is migrated or stored.

### transfer-chat::REQ-002 The image menu stays inside the window

- transfer-chat::REQ-002/AC-01: When the menu, opened at the pointer, would cross the window's right edge it opens to the left of the pointer instead; when it would cross the bottom edge it opens above the pointer.
- transfer-chat::REQ-002/AC-02: Wherever the pointer is, the whole menu stays inside the window with a 4px margin, at its full width (no item wrapped or narrowed).

### transfer-chat::REQ-003 Thumbnail tooltip (direct acceptance)

The thumbnail's tooltip reads 点击查看原图 · 右键复制或保存 / Click to view · Right-click to copy or save.

## 失败模式与边界穷举

标注约定:**〔测〕**=有自动化用例驱动;**〔门〕**=由门禁/护栏守住;**〔缺〕**=已知未覆盖,理由见「已知缺口」;**〔人工〕**=manual check with a reviewable record (screenshot or measurement).

### A. 会话协商

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 首个协商请求到达 | 创建挂起会话,在聊天流里问用户,占用单会话锁 | 〔测〕 |
| 会话占用期间,**别的设备**再来 | 返回 busy(409),不打断进行中的会话 | 〔测〕 |
| 会话占用期间,**同一设备同一身份**重试 | 覆盖旧的挂起会话,不返回 409——否则发送方会被自己的重试卡到超时 | 〔测〕 |
| 用户全部接受 | 为每个文件各发一个 token,进入传输态 | 〔测〕 |
| 用户**部分**接受 | 只为被接受的文件发 token;待收集合 = 拿到 token 的那批,**不是**请求列表全集 | 〔测〕 |
| 用户拒绝 | 403,立即清理会话 | 〔测〕 |
| 用户始终不点 | 确认窗口到期自动拒绝并清理 | 〔测〕 |
| 用户点了接受,但发送方**此前已超时断开** | 推进会话之前先预检连接是否已断;已断则回滚会话、不占用单会话锁。**不能靠"往断开的连接写会失败"来发现**——那是个 no-op,不抛错 | 〔测〕 |
| 收到的是文本消息 | 不占用单会话锁:直接入流显示,回 204,不进入传输态 | 〔测〕 |
| 对同一条请求重复回应 | 静默忽略,不二次改状态 | 〔测〕 |
| 回应一个不存在的请求 | no-op | 〔测〕 |

### B. 传输进行中

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 挂起期(尚未接受)就来传文件 | 403——此时还没有有效 token | 〔测〕 |
| token / 来源 IP / 文件标识 任一不匹配 | 403 | 〔测〕 |
| 多个文件同时传 | 各传各的,互不干扰;**全部收完**才算这次传输完成 | 〔测〕 |
| 重复传一个**已经收到**的文件 | 幂等:丢弃重复内容,不重复落盘,仍回成功 | 〔测〕 |
| 单个文件传输耗时超过空闲阈值 | **不算空闲**。凡消费请求体的路径都要刷新计时器——包括上面那条把内容直接丢弃的幂等路径,漏一条,该路径上的长传输会被静默清掉,而同会话其他文件跟着陪葬 | 〔测〕 |
| 真的没有字节在动 | 仍必须按空闲清理——修误判很容易滑成把闸拆了,两者在正向用例上表现一模一样 | 〔测〕 |
| 发送方那侧长时间没有字节被传输层接受 | 按空闲失败。注意这个信号**比"每个 chunk 一次"粗得多**(见 ADR-0020),定阈值要按"已缓冲字节 ÷ 对端消费速率"估 | 〔测〕 |
| 对端收完了却迟不回应 | 仍要失败——这是防"接收方异常挂起时发送方永挂" | 〔测〕 |
| 两端同时判定超时 | 序关系锁死:发送方阈值 > 接收方判空闲的**上界**(含扫描粒度)+ 余量,让会话的所有者先清理 | 〔门〕 |
| 传输中途发送方主动取消 | 停止接收、删除临时文件、清理会话、通知本地界面 | 〔测〕 |
| 取消时某个文件**已经落盘完成** | 删不掉(已不在临时名之列)。落盘完成后会校验会话是否还在,不在则不上报完成,避免"取消后又说成功" | 〔测〕 |
| 传输中途连接断开 | 由空闲超时清理,临时文件随之删除 | 〔测〕 |

### C. 落盘

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 文件名含路径穿越(`../`、绝对路径) | 只取文件名本身,不允许写出接收目录 | 〔测〕 |
| 接收目录已有同名文件 | 自动加后缀,**绝不覆盖**。判重必须是原子占位,不能"先查再写"——并发同名会在查与写之间互相覆盖 | 〔测〕 |
| 磁盘写满 | 该文件转失败并给出"空间不足",删除残留;**同批其他文件不受影响** | 〔测〕 |
| 内容校验不通过 | 该文件转失败并给出"校验失败",不留下"已接收"的假象 | 〔测〕 |
| 临时文件与最终文件跨盘 | 不允许——必须同目录,否则改名不是原子操作 | 〔缺〕 |
| 接收目录不存在或不可写 | 自动接收要退回询问,不能默默失败 | 〔测〕 |
| 超大文件 | 全程流式,内存占用与文件大小无关(ADR-0020) | 〔测〕 |

### D. 发送侧的失败分类

用户看到的必须是**具体原因**,不是笼统"失败"。分类的判定顺序有意为之:先看在线状态,再看传输层错误码,最后才回落到关键词猜测——**顺序反了会把离线误报成 VPN 问题**。

| 来源 | 边界 | 覆盖 |
|---|---|---|
| 对端状态 | 已离线 / 正忙 / 未在监听 / 对方内部错误 | 〔测〕 |
| 连接与信任 | 连接超时(如对方开 VPN 全隧道)/ 证书指纹不匹配 / 网络错误 | 〔测〕 |
| 信任 fail-closed | **本机没有对端指纹时必须响亮失败**,不得静默放行 | 〔测〕 |
| 协议兼容 | 对方无法解析请求 / 对方要求 PIN(本项目未实现 PIN,仅识别并提示)/ 请求过于频繁 | 〔测〕 |
| 本地文件 | 选中后文件被删或移动 / 没有读取权限 | 〔测〕 |
| 组批时机 | **"这个文件不能发"的判定必须在组批之前完成**——留到发送后再判会把同批正常文件一起判失败 | 〔测〕 |
| 目录 | 选中的是文件夹(含 macOS 应用程序包这类"看起来是单个文件"的目录)→ 该条明确提示不支持,同批普通文件照常发送 | 〔测〕 |
| 同一对端连发多条 | 发送方本地排队,避免自己的第二条撞上自己造成 busy | 〔测〕 |

### E. 文本消息

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 一条纯文本 | 编码成特殊"文件"随协商请求送达,不走传输通道,对方回 204 | 〔测〕 |
| 文本 + 文件混在一批 | 不按文本处理,走正常传输 | 〔测〕 |
| 正文超长 | 截断到上限 | 〔测〕 |
| 非 ASCII 正文 | 长度按字节算,不按字符数 | 〔测〕 |
| 连发两条相同内容 | 两条都要收到,不能被当成重复丢掉 | 〔测〕 |
| 文本不受自动接收开关限制 | 始终自动接收 | 〔测〕 |

### F. 传输速度与总耗时

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 传输中显示速度 | 进度事件不带时间戳,速度按两帧之间的字节增量算并**平滑**——瞬时增量会在几十到几百 MB/s 之间乱跳 | 〔测〕 |
| 第一帧还算不出速度 | 该位留空,**不得显示 0 MB/s** ——那会让人以为卡住了 | 〔测〕 |
| 时间差为 0 / 时钟回拨 / 字节倒退 | 一律保持上次读数,不产生 Infinity 或负速度 | 〔测〕 |
| 用时的计时起点 | 发送方是**点发送那一刻**(含发送前算摘要那段,那正是大文件"点了没反应"的几十秒);接收方是**点接收那一刻**(此前是用户自己在犹豫,不算传输) | 〔测〕 |
| 传输中的用时 | 随进度帧刷新,所以它在走;帧停了数字也停——那时传输本就卡住,停住是诚实的 | 〔缺〕 |
| 终态的用时 | 定格落库,**已有值不覆盖**(幂等重传、重复 respond 不得改写) | 〔测〕 |
| 没发生过传输的终态 | 拒绝、过期不记耗时——一个字节都没传过,给它一个耗时是编造 | 〔测〕 |
| 文本消息 / 图片消息 | 都不显示用时:文本气泡没有文件行,图片传完变缩略图也没有 | 〔测/人工〕 |
| 失败 | 显示用时——花掉的时间是事实 | 〔测〕 |
| **升级前的老消息** | 该字段为空,右端**整个不出现**,不得退化成 `0s` 或空出一块 | 〔测〕 |
| 重启后失去起点的消息 | 同上,宁可不显示也不拿消息创建时刻硬算 | 〔测〕 |
| 时长格式 | 统一 `h/m/s`,**不随语言变**、不加空格;不足 1 时不写 h、不足 1 分不写 m;不足 1 秒向上取整成 `1s` | 〔测〕 |

### G. 表结构演进(见 ADR-0021)

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 老用户升级 | 每次启动自检列是否齐全,缺的补上。**不能只把新列写进建表语句**——那对已存在的表是 no-op,老用户第一次写就抛异常,而这条路径只在"老库+新代码"下才走,日常开发碰不到 | 〔测〕 |
| 迁移重复执行 | 幂等,已有的列跳过 | 〔测〕 |
| 迁移不得丢数据 | 老行的既有字段一个不少 | 〔测〕 |
| 用户降级回旧版 | 旧版的 INSERT 不带新列,必须仍能写入——**新增列必须可空** | 〔测〕 |
| 加列却忘了让 migrate 补 | 在结构上不可能:建表与补列从同一份声明派生 | 〔门〕 |
| 下次改表结构 | 把改动前的建表语句追加进历史快照,否则从那个版本升级的路径失去覆盖 | 〔缺〕靠人记得 |

### H. 聊天流与持久化

| 边界 | 期望行为 | 覆盖 |
|---|---|---|
| 进度更新 | 只走实时推送,**不落库**;节流窗口内合并,但**终态必须强制推送**,否则界面停在 99% | 〔测〕 |
| 同一文件失败后重试 | 新一轮的首帧要立刻推,不被上一轮的节流残留吞掉 | 〔测〕 |
| 并发多文件的进度 | 按文件标识精确对应,不张冠李戴 | 〔测〕 |
| 历史分页 | 有上限,超出被钳制 | 〔测〕 |
| 状态是无约束文本列 | 读到**联合类型之外**的值(用户装过新版本写了库、再降级回旧版)必须优雅降级:集合归属写成覆盖每个成员的查表并收敛成布尔,映射查表要带兜底 | 〔测〕 |
| 应用退出 | 挂起中的确认全部拒绝 + 库里待定消息标记过期,否则发送方要等到协议默认超时(以天计) | 〔测〕 |

### I. Image context menu and copy

| Boundary | Expected behaviour | Coverage |
|---|---|---|
| Original deleted or moved after its thumbnail appeared, then 复制图片 | The clipboard keeps its previous content; the menu closes; no message (transfer-chat::US-001/AC-04) | 〔测〕 |
| Original replaced by something undecodable (another format, not an image) | Same as deleted: clipboard untouched (transfer-chat::US-001/AC-04) | 〔测〕 |
| Original replaced by a different image at the same path | That image is copied: copying reads the file at the moment of copying, not the thumbnail on screen | 〔测〕 |
| Sent image whose original the user later moved or deleted | Sent files point at the user's own path, so this is the deleted case above. Sent screenshots and pasted images point at the app's internal copy, which is kept, so they still copy — a sent image copies through the menu like a received one | 〔测〕 |
| Which images have the menu at all | Only those the platform image decoder reads, measured 2026-10-22 on macOS: PNG and JPEG. BMP, GIF, TIFF, HEIC and SVG are not decoded (WebP not sampled); such messages show the file row, which has no image menu, so copy is unreachable for them — unchanged | 〔测〕 file row without menu / 〔人工〕 the format list |
| EXIF orientation 2–8 (mirror, 180°, 90° either way, transpose, transverse) | Copied and thumbnailed as the value specifies (transfer-chat::US-001/AC-05, transfer-chat::REQ-001/AC-01) | 〔测〕 |
| No EXIF, orientation 1, 0 or above 8, truncated or malformed EXIF | Treated as stored; never an error | 〔测〕 |
| Orientation recorded outside JPEG EXIF (XMP only, a PNG `eXIf` chunk) | Not honoured: copied and thumbnailed as stored. Rare in practice; if the full-size view honours it, copy and thumbnail differ from that view | 〔缺〕 |
| Very large photo (tens of megapixels) | Copies completely; decoding and turning the full-resolution bitmap keeps the main process busy for up to a few hundred ms. Source: a cost stated in the orientation option the user chose, 2026-10-22; not confirmed separately | 〔人工〕 |
| Upright portrait taller than 4:3 (e.g. 9:16) | The thumbnail is generated 180 wide and shown at most 240 high, scaled down narrower — the existing display limits | 〔人工〕 |
| Image still waiting, transferring, rejected or failed | No thumbnail yet (the file row shows), so no image menu — unchanged | 〔人工〕 |
| Right-click before the thumbnail has loaded | The loading placeholder has no menu — unchanged | 〔人工〕 |
| Esc while the menu is open | Not handled: the menu stays until a click or a scroll — unchanged | 〔人工〕 |
| The app quits after copying | The image stays on the clipboard: the platform clipboard holds the data, not the app | 〔人工〕 |
| Image with transparency | Kept as far as the platform clipboard image allows; how the target app draws transparent areas is up to that app | 〔人工〕 |
| Pointer near the window's right or bottom edge | The menu opens to the left of / above the pointer and stays whole inside the window (transfer-chat::REQ-002). The smallest window (640×600) is always larger than the menu | 〔测〕 |
| Menu open, then the stream scrolls or the user clicks elsewhere | The menu closes — unchanged | 〔人工〕 |
| Right-click another image while the menu is open, or the same image again | One menu stays open, at the new pointer: any right-click closes the open menu first. (Before 2026-10-22 a second image's right-click left two menus open; fixed with this feature at the user's decision) | 〔测〕 |
| Language switched while the menu is open | Cannot happen: the language is changed in Settings, and the click that opens Settings closes the menu | — |
| Window resized while the menu is open | The menu keeps its place; any click or scroll closes it — unchanged | 〔人工〕 |
| Upgrading with earlier image messages | Their thumbnails are regenerated on display and show upright (transfer-chat::REQ-001/AC-02) | 〔测〕 |
| 保存图片 / 用系统程序打开 on a photo with an EXIF orientation | Unchanged: saving copies the original bytes (EXIF included), opening hands the file to the system | 〔人工〕 |
| Right-click in the full-size view | Nothing happens — no menu there (see 明确不做的) | 〔人工〕 |

## Implementation Decisions

Image copy and orientation (transfer-chat::US-001, transfer-chat::REQ-001 to REQ-003):

- **Copying runs in the main process behind a new command that takes a message id.** It looks up the stored file path, decodes the original with the platform image decoder — the same one the thumbnail uses, so every image that shows the menu decodes — and writes the result to the clipboard as an image only, through the same clipboard call as the screenshot's copy-to-clipboard exit. An empty decode returns before the clipboard is touched. The command returns nothing the interface uses: there is no feedback.
- **The platform decoder ignores EXIF orientation** (measured 2026-10-22 on Electron 35: a 200×100 JPEG tagged orientation 6 decodes as 200×100, while the full-size view's `<img>` shows it 100×200). So the main process reads the orientation from the JPEG's EXIF itself and turns the decoded bitmap accordingly, using two pure functions: one that reads the orientation from the file bytes (both byte orders; anything unreadable counts as the default) and one that rotates or mirrors a raw bitmap. No new dependency.
- **The thumbnail uses the same correction, applied after downscaling**, so its extra cost stays small. For the four orientations that turn the image a quarter turn, the stored image is downscaled to the thumbnail width along its height, so the upright result has the usual thumbnail width (transfer-chat::REQ-001/AC-01).
- **The menu is placed by a pure function** of the pointer position, the menu's measured size and the window size: flip left / up when crossing the right / bottom edge, then clamp to a 4px margin. The menu is measured where its width is not constrained, so it never wraps before being placed.
- **Copy text**: one new dictionary entry for the menu item and the reworded tooltip, each in zh and en.

## 测试决策

- **Image copy is tested end to end in a real Electron instance, through the menu** (seam chosen by the user, 2026-10-22). Quiet test instances run no discovery, so the test opens a chat itself: the app runs on a temporary user-data directory whose message store is seeded with image messages pointing at fixture files the test generates (a PNG, and a JPEG whose EXIF is shaped like a real phone photo's but tagged with a non-default orientation), and the main process then sends the renderer a device-list update — the channel discovery uses in the product — naming the peer of those messages. The test opens that chat, right-clicks a thumbnail, chooses 复制图片 and reads the system clipboard back from the main process: the image's size and orientation for a successful copy, a sentinel written beforehand still in place for a failing one. The same setup checks the menu's items and order, the tooltip (in both languages), the edge flip, and the thumbnail's orientation and width. The hidden test window takes no real pointer input, so right-clicks and clicks are dispatched as DOM events.
  **Failing and replaced-file copies await the copy command through the preload API instead of going through the menu** (deviation confirmed by the user, 2026-10-22): the menu runs the command without waiting for it, so after a menu click the test has nothing to wait on before asserting that the clipboard did not change, and a fixed wait would let a late wrong write pass. The menu's wiring to that command is proven by the successful copies, which go through the menu.
  **Cost accepted by the user**: run on a developer's machine, these tests overwrite the real system clipboard.
- **Pure functions get unit tests**, as the existing renderer and main-process pure modules do: every orientation value plus malformed and truncated EXIF, the bitmap turn for each orientation, and the menu placement (flip and clamp at each edge).

- **协商与传输的边界一律用真实的 HTTPS 服务 + 真实的流来驱动**,不 mock 自有模块。理由:本模块的失效集中在"两端时序对不上"和"流没走完",两者在 mock 下都不存在。
- **超时类边界用注入的小阈值 + 真实时钟**,不用假时钟。假时钟测不出背压与缓冲这类真实成因;而阈值是构造参数,缩小它不改变机制。**例外**是纯粹的计时器单元,那里用假时钟,因为它本来就只有时间这一个输入。
- **每条"不该发生"的断言都要配一条反向用例**。空闲判定就是典型:只写"长传输不被清掉",一个永不清理的实现照样全绿。
- **内存类断言断增长率,不断绝对值**。绝对值受垃圾回收时机左右,拿它当阈值卡的是回收器的脾气,不是实现。
- **门禁只守得住它查的那部分**:两端阈值的序关系有护栏,但"新增的收发字节路径要刷新计时器"没有——那是开放形态,靠 `CONTEXT.md` 的不变量约束人。

## 明确不做的

- **断点续传**:中断即整体重发。
- **独立的传输历史页面**:历史就是聊天流。
- **取消已落盘的文件**:取消只能删掉还没写完的。
- **一次性 token / 防重放**:同 token 重传已收文件按幂等处理;跨会话的 token 因绑定会话与来源 IP 而自然失效。
- **防主动冒充**:身份广播本身是明文,同网段的主动攻击者可以冒充任意对端(与官方 LocalSend 同级局限,见 ADR-0004)。**接收确认是唯一的人肉防线**,请在可信局域网使用。
- **PIN 校验**:只识别对端要求 PIN 并提示,不实现。
- **多播报文伪造 / 放大攻击**:属发现层,不在本模块处理。
- **总时长上限**:选了空闲语义就意味着放弃它;涓流可以让传输无限期挂着(ADR-0020 的代价节)。
- **不为"传输中用时在走"与"速度的渲染"补端到端测试**(2026-08-22 用户裁定)。两者的计算逻辑有纯函数单测、显示形态有真机渲染核对过;补齐它们需要能驱动渲染层连续多帧的 e2e 基建,投入与收益不成比例。**这是决定,不是遗漏** —— 后来者不必再把它当待办。
- **A file reference on the clipboard** (so that pasting in Finder or Explorer yields the file): rejected 2026-10-22. Electron has no API for it, each platform would need its own low-level clipboard format, and chat apps that see a file reference may attach a file instead of inserting the image.
- **Feedback after copying** (a "Copied" toast, or an error on failure): decided against, 2026-10-22. It matches the screenshot's copy exit and the image menu's other two items, which give none either.
- **An image menu in the full-size view**: not in this round (2026-10-22); right-clicking there does nothing.

## 已知缺口

按诚实原则记,不用"覆盖率"掩盖:

- **落盘前无磁盘空间预检**。空间不足表现为传到一半失败,而不是一开始就拒绝。
- **临时文件跨盘的约束靠约定而非检查**。目前临时文件与最终文件同目录,这个前提没有断言守着。
- **两端用真实常量值的联动没测**。生产是发送方 45 秒、接收方 30 秒 + 5 秒扫描,自动化测试全用注入的小值;真断线时"谁先放弃"只在推理层面成立。**补测条件**:一条独立于默认 CI 的长跑用例。
- **GB 级端到端没测**。自动化最大到 16MB 真实字节 / 320MB 稀疏文件;GB 级只有手工实测数据。
- **组批前的可发性校验对"发送后才出现的错误"无能为力**(比如组批后文件才被删)。
- **大文件计算校验值期间界面无反馈**(50GB 约 40 秒),用户会觉得点了没反应。**部分缓解**:计时从点发送算起,所以那段时间会计入用时——但传输中的用时靠进度帧驱动,而算摘要期间还没有帧,所以那几十秒里数字仍不动。

- **历史 schema 快照只有一条**,靠人在下次改表时记得追加。
- **That a failed copy shows nothing (transfer-chat::US-001/AC-03, its failure half) has no automated check.** The failing copies are driven through the copy command, not the menu (see 测试决策), so the menu's handling of a failure is not exercised; the menu handler gives no feedback by construction. The success half is checked: the page text is unchanged after a copy through the menu.
- **The image menu is driven by dispatched DOM events in the end-to-end tests**, not real pointer input (the hidden test window takes none): whether a real pointer reaches the thumbnail — nothing covering it — is checked by rendering, not by the tests.
- **Orientation outside JPEG EXIF is not honoured** (XMP-only, PNG `eXIf`); see boundary group I.
- **Whether nativeImage ignores the EXIF orientation on Windows is not measured.** macOS was measured directly and Linux is measured by the CI end-to-end run (its rotated-copy and thumbnail cases would fail if the tag were already applied, since the image would then be turned twice). Windows decodes through the same decoder, but no run has shown it.
