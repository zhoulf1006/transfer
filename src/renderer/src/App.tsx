import { useEffect, useState, useRef, useCallback } from 'react'
import { shouldStickToBottom, shouldAutoScrollOnNewMessage } from './scroll-stick'
import type { RemoteDevice } from '@shared/types'
import { isImageFile } from '@shared/ipc'
import { pickImageItemIndices } from '@shared/clipboard-image'
import { eventToAccelerator, acceleratorRejectReason } from '@shared/accelerator'
import { shouldCountUnread } from '@shared/unread'
import { OFFLINE_KEEP_PRESETS } from '@shared/offline-keep'
import { isTerminal, isTransferring, canRespond } from '@shared/message'
import type { ErrorReason } from '@shared/message'
import { failedLabelKey } from '@shared/i18n/failed-label'
import type {
  IdentityInfo,
  UiMessage,
  AutoAcceptSettings,
  ProgressPayload,
  StorageDirs,
  LangPref
} from '@shared/ipc'
import { ErrorBoundary } from './ErrorBoundary'
import { useI18n } from './i18n'
import type { TFn } from '@shared/i18n/t'
import type { TKey } from '@shared/i18n/dict'
import {
  SunMoonIcon,
  SunIcon,
  MoonIcon,
  SettingsIcon,
  CameraIcon,
  PaperclipIcon,
  InboxIcon,
  FolderOpenIcon,
  FileImageIcon,
  FileVideoIcon,
  FileAudioIcon,
  FileTextIcon,
  FileArchiveIcon,
  FileSheetIcon,
  FileIcon,
  RadarIcon,
  MessageCircleIcon,
  SendIcon, ChevronDownIcon } from './icons'
import { fmtDuration, fmtSpeed, nextSpeed, type SpeedSample } from './transfer-stats'

/** 传输进度快照:messageId → 已传/总字节 + 实时速度(不落库,仅内存)。bps 为 null = 还算不出 */
type ProgressMap = Record<string, { sent: number; total: number; bps: number | null; elapsedMs: number | null }>

type ThemePref = 'system' | 'light' | 'dark'

/**
 * 主题:跟随系统 / 手动浅 / 手动深。持久化走 **main 侧**(settings.json + IPC),
 * 不用 localStorage —— 打包版 file:// 下 localStorage 首次访问会卡数秒(阻塞首屏)。
 * 手动时在 <html> 上打 data-theme(CSS 里 :root[data-theme] 覆盖 @media)。
 */
function useTheme(): { pref: ThemePref; cycle: () => void } {
  // 初值 system(默认):不阻塞首屏;真实偏好由 IPC 异步拉回后应用。
  const [pref, setPref] = useState<ThemePref>('system')

  // 首次:从 main 拉持久化的主题偏好
  useEffect(() => {
    window.transfer.getTheme().then((t) => setPref(t))
  }, [])

  // pref 变化 → 应用到 DOM + 写回 main 持久化
  useEffect(() => {
    const root = document.documentElement
    if (pref === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', pref)
    void window.transfer.setTheme(pref)
  }, [pref])

  // 循环:system → light → dark → system
  const cycle = (): void =>
    setPref((p) => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'))
  return { pref, cycle }
}

export function App(): JSX.Element {
  const { pref: themePref, cycle: cycleTheme } = useTheme()
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [peer, setPeer] = useState<string | null>(null) // 选中对端 fingerprint
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [progress, setProgress] = useState<ProgressMap>({})
  /** 上一帧的进度采样(算速度用)。存 ref 不存 state:它只是计算的中间量,不该驱动重渲染。 */
  const speedRef = useRef<Map<string, SpeedSample>>(new Map())

  /**
   * 清掉一笔传输的**全部**残留状态。
   *
   * 两处状态(进度条数据与速度采样)分开存是对的 —— 后者进 state 会白白触发重渲染。
   * 但它们必须**同进同出**:清理路径不止一条(收到完成帧 / 消息转终态,将来还可能有取消),
   * 每条都靠人记得清两处的话迟早漏一处 —— 已经漏过一次(终态那条只清了进度,速度采样
   * 在每笔失败的传输后越积越多)。所以清理只留这一个入口。
   */
  const clearTransferState = useCallback((msgId: string) => {
    speedRef.current.delete(msgId)
    setProgress((prev) => {
      if (!(msgId in prev)) return prev
      const { [msgId]: _drop, ...rest } = prev
      return rest
    })
  }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [view, setView] = useState<'chat' | 'downloads'>('chat')
  const [auto, setAuto] = useState<AutoAcceptSettings>({ enabled: false, maxBytes: 100 * 1024 * 1024 })
  // 每个对端的未读数(app 内角标 + 总数驱动 Dock)。正在看该会话时清零。
  const [unread, setUnread] = useState<Record<string, number>>({})
  // 窗口聚焦态用 **state**(驱动清零 effect),同时镜像到 ref(供消息回调闭包读最新值)。
  const [focused, setFocused] = useState(true)

  // 消息订阅 effect 依赖数组为空(见下),闭包会捕获初始 peer/view/focused。
  // 用 ref 存最新值,effect 内读 ref.current 判断"是否正在看该会话"。
  const peerRef = useRef(peer)
  const viewRef = useRef(view)
  const focusedRef = useRef(focused)
  peerRef.current = peer
  viewRef.current = view
  focusedRef.current = focused
  // 已见过的消息 id(幂等判定"是否新消息",用于未读累加;不受 StrictMode 双调影响)
  const seenIdsRef = useRef<Set<string>>(new Set())

  // 初始化
  useEffect(() => {
    window.transfer.getIdentity().then(setIdentity)
    window.transfer.listDevices().then(setDevices)
    // 历史消息入列并登记 id,避免后续同 id upsert 被误判为"新消息"计未读
    window.transfer.listMessages().then((ms) => {
      ms.forEach((m) => seenIdsRef.current.add(m.id))
      setMessages(ms)
    })
    window.transfer.getAutoAccept().then(setAuto)

    const unsubs = [
      window.transfer.onDevicesUpdated((d) => setDevices(d)),
      window.transfer.onMessageUpserted((m) => {
        // 未读累加放在 updater **之外**:updater 必须是纯函数,React(尤其 StrictMode)会
        // 双调它 → 若在里面 setUnread 会累加两次("发 1 条显示 2"的 bug)。
        // 用 seenIdsRef 幂等判定"是否首次见到该 id",不受调用次数影响。
        const isNew = !seenIdsRef.current.has(m.id)
        if (isNew) {
          seenIdsRef.current.add(m.id)
          if (
            shouldCountUnread({
              direction: m.direction,
              isNew: true,
              windowFocused: focusedRef.current,
              view: viewRef.current,
              currentPeer: peerRef.current,
              msgPeer: m.peerFp
            })
          ) {
            setUnread((u) => ({ ...u, [m.peerFp]: (u[m.peerFp] ?? 0) + 1 }))
          }
        }
        setMessages((prev) => {
          const i = prev.findIndex((x) => x.id === m.id)
          if (i >= 0) {
            const next = prev.slice()
            next[i] = m
            return next
          }
          return [...prev, m].sort((a, b) => a.createdAt - b.createdAt)
        })
        // 消息进入终态 → 清理残留状态(失败/拒绝/超时不会有完成进度帧)
        if (isTerminal(m.status)) clearTransferState(m.id)
      }),
      window.transfer.onProgress((p: ProgressPayload) => {
        // 完成即清理(气泡改由 status 显示"已送达/已接收")。判断放在 updater 外,
        // 才能与终态那条走同一个清理入口。
        if (p.total > 0 && p.sent >= p.total) {
          clearTransferState(p.messageId)
          return
        }
        // 速度靠两帧之间的字节增量算 —— 进度事件本身不带时间戳
        const last = speedRef.current.get(p.messageId)
        const at = Date.now()
        const bps = nextSpeed(last, { sent: p.sent, at })
        speedRef.current.set(p.messageId, { sent: p.sent, at, bps })
        setProgress((prev) => ({
          ...prev,
          [p.messageId]: { sent: p.sent, total: p.total, bps, elapsedMs: p.elapsedMs }
        }))
      }),
      window.transfer.onWindowFocus((f) => {
        focusedRef.current = f // 立即更新 ref(供消息回调读)
        setFocused(f) // 驱动清零 effect(聚焦到正在看的会话时清未读)
      })
    ]
    return () => unsubs.forEach((u) => u())
    // clearTransferState 是 useCallback([]),引用恒定 —— 列进来只为依赖完整,不会让本 effect 重跑
    // (重跑意味着退订再订阅一遍全部 IPC 监听)
  }, [clearTransferState])

  // 同步"当前聊天对象"给 main(决定截图"发聊天"可用性,§4.3)。
  // 仅聊天视图下的选中 peer 才算活跃对象;下载页/未选设备时为 null。
  useEffect(() => {
    window.transfer.setShotActivePeer(view === 'chat' ? peer : null)
  }, [peer, view])

  // 正在看某会话(chat 视图 + 选中 peer + 窗口聚焦)→ 清该 peer 未读。
  // 依赖含 focused 和该 peer 未读数:覆盖"切进会话""聚焦回来""已在会话上又来新未读"三种情形
  // ——只靠 [peer,view] 会漏掉后两种(后台收消息时已停在该会话,呼出后 peer/view 不变,不清零的 bug)。
  const peerUnread = peer ? (unread[peer] ?? 0) : 0
  useEffect(() => {
    if (view === 'chat' && peer && focused && peerUnread > 0) {
      setUnread((u) => (u[peer] ? { ...u, [peer]: 0 } : u))
    }
  }, [peer, view, focused, peerUnread])

  // 未读变化 → 把总未读同步给 main(驱动 mac Dock 数字角标)。
  useEffect(() => {
    const total = Object.values(unread).reduce((a, b) => a + b, 0)
    window.transfer.setUnread(total)
  }, [unread])

  // 选中对端的消息(按对端 fingerprint 过滤)
  const peerMessages = peer ? messages.filter((m) => m.peerFp === peer) : []

  return (
    <div style={S.app}>
      {/* 侧栏与主区各自包错误边界:一块崩溃不影响另一块(用户诉求) */}
      <ErrorBoundary labelKey="sidebar.boundaryDevices">
        <Sidebar
          identity={identity}
          devices={devices}
          peer={peer}
          view={view}
          unread={unread}
          themePref={themePref}
          onCycleTheme={cycleTheme}
          onPick={(fp) => {
            setPeer(fp)
            setView('chat')
          }}
          onShowDownloads={() => setView('downloads')}
          onOpenSettings={() => setShowSettings(true)}
        />
      </ErrorBoundary>
      <div style={S.main}>
        <ErrorBoundary labelKey="sidebar.boundaryChat" key={view + (peer ?? '')}>
          {view === 'downloads' ? (
            <Downloads />
          ) : peer ? (
            <Chat
              peer={peer}
              peerAlias={peerAliasOf(devices, peer)}
              online={devices.find((d) => d.info.fingerprint === peer)?.status !== 'offline'}
              messages={peerMessages}
              progress={progress}
            />
          ) : (
            <Empty devices={devices} />
          )}
        </ErrorBoundary>
      </div>
      {showSettings && (
        <SettingsModal
          value={auto}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            const next = await window.transfer.setAutoAccept(s)
            setAuto(next)
            setShowSettings(false)
          }}
        />
      )}
    </div>
  )
}

function peerAliasOf(devices: RemoteDevice[], fp: string): string {
  return devices.find((d) => d.info.fingerprint === fp)?.info.alias ?? fp.slice(0, 8)
}

function Sidebar(props: {
  identity: IdentityInfo | null
  devices: RemoteDevice[]
  peer: string | null
  view: 'chat' | 'downloads'
  unread: Record<string, number>
  themePref: ThemePref
  onCycleTheme: () => void
  onPick: (fp: string) => void
  onShowDownloads: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const { identity, devices, peer, view, unread, themePref, onCycleTheme, onPick, onShowDownloads, onOpenSettings } = props
  const { t } = useI18n()
  const online = devices.filter((d) => d.status !== 'offline')
  const offline = devices.filter((d) => d.status === 'offline')
  const themeIcon =
    themePref === 'system' ? <SunMoonIcon /> : themePref === 'light' ? <SunIcon /> : <MoonIcon />
  const themeLabel =
    themePref === 'system' ? t('theme.system') : themePref === 'light' ? t('theme.light') : t('theme.dark')

  // ── 设备备注:右键菜单 + 行内编辑(见 docs/features/device-alias.md)──
  const [menuFp, setMenuFp] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [menuClearError, setMenuClearError] = useState(false) // 「清除备注」失败(Bug#2)
  const [editingFp, setEditingFp] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const openMenu = (e: React.MouseEvent, fp: string): void => {
    e.preventDefault() // 阻原生右键菜单
    e.stopPropagation() // 不冒泡到行 onClick(选中)——memory 冒泡坑
    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuFp(fp)
    setMenuClearError(false)
  }
  const closeMenu = (): void => {
    setMenuFp(null)
    setMenuClearError(false)
  }
  const startEdit = (fp: string, currentAlias: string): void => {
    // Bug#2 修:若正在编辑**另一台**设备 → 先用其当前草稿提交它(不丢输入),再切到新设备。
    // 传显式 value(而非依赖 draft 闭包),避免下面 setDraft 覆盖后提交到错的值。
    if (editingFp && editingFp !== fp) void commitEdit(editingFp, draft)
    setEditingFp(fp)
    setDraft(currentAlias)
    setSaveError(false)
    closeMenu()
  }
  const commitEdit = async (fp: string, value: string): Promise<void> => {
    const { ok } = await window.transfer.setRemoteAlias(fp, value) // main 侧 trim+空判删
    if (ok) {
      // 只在"仍在编辑刚提交的这台"时才关编辑态:防切换设备后,旧提交的 await 迟到清掉新编辑(race)
      setEditingFp((cur) => (cur === fp ? null : cur))
      setSaveError(false)
    } else {
      setSaveError(true) // 失败:编辑态不关,标红
    }
  }
  const cancelEdit = (): void => {
    setEditingFp(null)
    setSaveError(false)
  }
  const clearAlias = async (fp: string): Promise<void> => {
    const { ok } = await window.transfer.setRemoteAlias(fp, '') // 空串=删备注
    if (ok) closeMenu()
    else setMenuClearError(true) // 失败:不关菜单+红字
  }

  // 编辑框自动 focus+全选
  useEffect(() => {
    if (editingFp && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingFp])

  // 兜底:正在编辑的设备从列表消失(offline 超 keep 真删)→ 提交(不丢输入,§5.4)
  useEffect(() => {
    if (editingFp && !devices.some((d) => d.info.fingerprint === editingFp)) {
      void commitEdit(editingFp, draft)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices])

  // Bug#1 修:右键菜单针对的设备从列表消失 → 关菜单(否则悬挂,指向已不存在的设备)
  useEffect(() => {
    if (menuFp && !devices.some((d) => d.info.fingerprint === menuFp)) closeMenu()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices])

  const DeviceRow = (d: RemoteDevice): JSX.Element => {
    const off = d.status === 'offline'
    const active = view === 'chat' && peer === d.info.fingerprint
    const n = unread[d.info.fingerprint] ?? 0
    const editing = editingFp === d.info.fingerprint
    return (
      <div
        key={d.info.fingerprint}
        className="tf-row"
        onClick={() => !editing && onPick(d.info.fingerprint)}
        onContextMenu={(e) => openMenu(e, d.info.fingerprint)}
        style={{ ...S.devItem, ...(active ? S.devItemActive : {}), ...(off ? S.devItemOffline : {}) }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 550, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ ...S.dot, background: off ? 'var(--offline)' : 'var(--online)' }} />
              {editing ? (
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    setSaveError(false)
                  }}
                  onClick={(e) => e.stopPropagation()} // 点输入框不触发行选中
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitEdit(d.info.fingerprint, draft)
                    else if (e.key === 'Escape') cancelEdit()
                  }}
                  onBlur={() => {
                    // 仅当仍在编辑该行才提交:Esc 已置 null → blur 被忽略(§5.2)
                    if (editingFp === d.info.fingerprint) void commitEdit(d.info.fingerprint, draft)
                  }}
                  style={{ ...S.aliasInput, ...(saveError ? S.aliasInputError : {}) }}
                />
              ) : (
                <span style={S.devName} title={d.info.alias}>
                  {d.info.alias}
                </span>
              )}
            </div>
            {editing && saveError ? (
              <div style={S.aliasErr}>{t('sidebar.aliasSaveFail')}</div>
            ) : (
              <div
                style={S.devSub}
                title={`${d.info.deviceModel} · ${off ? t('sidebar.deviceOffline') : d.address}`}
              >
                {d.info.deviceModel} · {off ? t('sidebar.deviceOffline') : d.address}
              </div>
            )}
          </div>
          {n > 0 && !editing && <span style={S.unreadBadge}>{n > 99 ? '99+' : n}</span>}
        </div>
      </div>
    )
  }

  return (
    <div style={S.sidebar}>
      <div style={S.brand}>
        <strong style={S.brandName}>Transfer</strong>
        <div style={{ display: 'flex', gap: 2 }}>
          {/* data-testid:给 e2e 用的语言无关定位锚。界面语言跟随系统,按 title 文案定位会随
              运行机器的语言变红,不是被测行为的问题。不可见,不影响用户。 */}
          <button
            className="tf-icon-btn"
            data-testid="btn-theme"
            onClick={onCycleTheme}
            title={t('theme.tooltip', { label: themeLabel })}
            style={S.iconBtn}
          >
            {themeIcon}
          </button>
          <button
            className="tf-icon-btn"
            data-testid="btn-settings"
            onClick={onOpenSettings}
            title={t('common.settings')}
            style={S.iconBtn}
          >
            <SettingsIcon />
          </button>
        </div>
      </div>
      {identity && <div style={S.self}>{t('sidebar.self', { alias: identity.alias })}</div>}

      <div
        className="tf-row"
        onClick={onShowDownloads}
        style={{ ...S.downloadsEntry, ...(view === 'downloads' ? S.devItemActive : {}) }}
      >
        <InboxIcon size={16} />
        {t('sidebar.received')}
      </div>

      <div style={S.devHeader}>{t('sidebar.online', { count: online.length })}</div>
      {online.length === 0 && <div style={S.hint}>{t('sidebar.searching')}</div>}
      {online.map(DeviceRow)}

      {offline.length > 0 && (
        <>
          <div style={S.devHeader}>{t('sidebar.offlineGroup', { count: offline.length })}</div>
          {offline.map(DeviceRow)}
        </>
      )}

      {menuFp && (
        <DeviceContextMenu
          pos={menuPos}
          hasCustomAlias={
            devices.find((d) => d.info.fingerprint === menuFp)?.info.hasCustomAlias ?? false
          }
          clearError={menuClearError}
          onEdit={() => {
            const dev = devices.find((d) => d.info.fingerprint === menuFp)
            if (dev) startEdit(menuFp, dev.info.alias)
          }}
          onClear={() => void clearAlias(menuFp)}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

/** 自绘右键菜单:改/清除备注。定位在鼠标处,超出视口回弹;点外/Esc 关闭。见 docs/features/device-alias.md。 */
function DeviceContextMenu(props: {
  pos: { x: number; y: number }
  hasCustomAlias: boolean
  clearError: boolean
  onEdit: () => void
  onClear: () => void
  onClose: () => void
}): JSX.Element {
  const { pos, hasCustomAlias, clearError, onEdit, onClear, onClose } = props
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement | null>(null)
  const [adj, setAdj] = useState(pos)

  // 定位回弹:渲染后测量,超出右/下边则回移
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let { x, y } = pos
    if (x + r.width > window.innerWidth) x = Math.max(4, window.innerWidth - r.width - 4)
    if (y + r.height > window.innerHeight) y = Math.max(4, window.innerHeight - r.height - 4)
    setAdj({ x, y })
  }, [pos])

  // 点菜单外 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      style={{ ...S.ctxMenu, left: adj.x, top: adj.y }}
      onClick={(e) => e.stopPropagation()} // 不冒泡到行/root(memory 冒泡坑)
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="tf-row" style={S.ctxItem} onClick={onEdit}>
        {t('sidebar.ctxRenameAlias')}
      </div>
      {hasCustomAlias && (
        <div className="tf-row" style={S.ctxItem} onClick={onClear}>
          {t('sidebar.ctxClearAlias')}
        </div>
      )}
      {clearError && <div style={S.ctxErr}>{t('sidebar.aliasClearFail')}</div>}
    </div>
  )
}

/** 空状态插画的尺寸。显式给,不靠 font-size —— 见 icons.tsx 顶部注释 */
const EMPTY_ICON = 40

function Empty({ devices }: { devices: RemoteDevice[] }): JSX.Element {
  const { t } = useI18n()
  const found = devices.length > 0
  // 图标与文案走同一个条件:没发现设备时是"还在找"(雷达),发现了才是"挑一个聊"(气泡)
  return (
    <div style={S.empty} data-testid="chat-empty">
      {found ? <MessageCircleIcon size={EMPTY_ICON} /> : <RadarIcon size={EMPTY_ICON} />}
      <p>{found ? t('chat.emptyPickDevice') : t('chat.emptySearching')}</p>
    </div>
  )
}

function Chat(props: {
  peer: string
  peerAlias: string
  online: boolean
  messages: UiMessage[]
  progress: ProgressMap
}): JSX.Element {
  const { peer, peerAlias, online, messages, progress } = props
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // 滚到最新。**不能只在消息条数变化时滚一次**:滚完之后气泡还会继续长高——图片气泡
  // 要等缩略图加载完(占位 div 换成 <img>、像素到位)、文件气泡要渲出进度条。那样滚到的
  // 是"旧的底部",新内容留在视口下方(即"发文件和图片时不滚到最新";文本气泡高度当场
  // 确定,所以一直正常)。
  //
  // 关键:"用户是否在底部"必须在**内容长高之前**记录。若等观察到长高再算,那时正因为
  // 这次长高而离底部很远,守卫会把自己否掉——第一版就栽在这里,实测不生效。
  // 故用 ref 记状态,只由**用户的滚动动作**更新:内容长高不触发 scroll 事件(scrollTop
  // 未变),所以不会污染该状态。
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [hasNewBelow, setHasNewBelow] = useState(false)

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setAtBottom(true)
    setHasNewBelow(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = (): void => {
      const stuck = shouldStickToBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
      stickRef.current = stuck
      setAtBottom(stuck)
      if (stuck) setHasNewBelow(false) // 滚回底部即视为已看到
    }
    const repin = (): void => {
      if (stickRef.current) el.scrollTo({ top: el.scrollHeight })
    }
    el.addEventListener('scroll', sync, { passive: true })
    // MutationObserver 覆盖"占位换成 img""进度条出现"这类 DOM 变化;
    // capture 阶段的 load 覆盖 <img> 像素到位(load 事件不冒泡,必须用捕获)。
    const mo = new MutationObserver(repin)
    mo.observe(el, { childList: true, subtree: true, attributes: true })
    el.addEventListener('load', repin, true)
    return () => {
      el.removeEventListener('scroll', sync)
      el.removeEventListener('load', repin, true)
      mo.disconnect()
    }
  }, [])

  // 新消息到达:自己发的无条件滚;收到的只在已贴底时滚,否则只亮"有新消息"圆点,
  // 不打断正在翻历史的用户(判据见 shouldAutoScrollOnNewMessage)。
  const lastDirection = messages.length ? messages[messages.length - 1].direction : null
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !lastDirection) return
    if (shouldAutoScrollOnNewMessage(lastDirection, stickRef.current)) {
      stickRef.current = true
      setAtBottom(true)
      setHasNewBelow(false)
      el.scrollTo({ top: el.scrollHeight })
    } else {
      setHasNewBelow(true)
    }
    // 依赖只取条数:同一条消息的状态更新(pending→done)不该再次触发滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  const sendText = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    await window.transfer.sendText({ peerFp: peer, text: trimmed })
  }, [text, peer])

  const sendPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length) await window.transfer.sendFiles({ peerFp: peer, filePaths: paths })
    },
    [peer]
  )

  const pickAndSend = useCallback(async () => {
    sendPaths(await window.transfer.pickFiles())
  }, [sendPaths])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      // §12.4:必须传原始 File 给 preload 的 getDroppedPaths(不能克隆/过 IPC)
      const files = Array.from(e.dataTransfer.files)
      if (files.length) sendPaths(window.transfer.getDroppedPaths(files))
    },
    [sendPaths]
  )

  // 粘贴剪贴板图片直接发送:仅当粘贴内容含图片时接管(preventDefault),否则放行正常文本粘贴。
  // 剪贴板可能含多张图 → 全部发送。图片经 File→ArrayBuffer→Uint8Array 过 IPC(同 overlay 导出范例)。
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items)
      const imgs = pickImageItemIndices(items)
        .map((i) => items[i].getAsFile())
        .filter((f): f is File => f !== null)
      if (imgs.length === 0) return // 非图片:放行默认文本粘贴
      e.preventDefault()
      for (const file of imgs) {
        void file
          .arrayBuffer()
          .then((buf) => window.transfer.sendImage({ peerFp: peer, png: new Uint8Array(buf) }))
          .catch((err) => console.error('[paste] 发送粘贴图片失败', err))
      }
    },
    [peer]
  )

  return (
    <div style={S.chat}>
      <div style={S.chatHeader}>
        {peerAlias}
        {!online && <span style={S.offlineTag}>{t('chat.offlineTag')}</span>}
      </div>
      <div
        ref={scrollRef}
        style={{ ...S.stream, ...(dragging ? S.streamDragging : {}) }}
        onDragOver={(e) => {
          e.preventDefault() // 必须,否则不触发 drop
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(e) => {
          // 仅当离开整个区域(而非子元素间移动)才取消高亮
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={onDrop}
      >
        {messages.length === 0 && <div style={S.hint}>{t('chat.noMessages')}</div>}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} prog={progress[m.id]} />
        ))}
        {dragging && <div style={S.dropHint}>{t('chat.dropHint')}</div>}
        {!atBottom && (
          <button
            className="tf-jump-btn"
            onClick={jumpToBottom}
            style={S.jumpBtn}
            title={t('chat.jumpToLatest')}
            aria-label={t('chat.jumpToLatest')}
          >
            <ChevronDownIcon size={18} />
            {hasNewBelow && <span style={S.jumpDot} />}
          </button>
        )}
      </div>
      <div style={S.inputBar}>
        <button
          onClick={() => window.transfer.beginShot()}
          style={S.inputIconBtn}
          title={t('chat.captureTitle')}
        >
          <CameraIcon size={19} />
        </button>
        <button
          onClick={pickAndSend}
          style={{ ...S.inputIconBtn, marginLeft: -6 }}
          title={t('chat.sendFileTitle')}
        >
          <PaperclipIcon size={19} />
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // 中文输入法组字中按 Enter 是"确认选词",不是发送。
            // e.nativeEvent.isComposing 在 IME 组字期间为 true,此时不发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              sendText()
            }
          }}
          placeholder={t('chat.inputPlaceholder')}
          rows={1}
          style={S.textarea}
        />
        <button className="tf-btn" onClick={sendText} disabled={!text.trim()} style={S.sendBtn}>
          <SendIcon size={16} />
        </button>
      </div>
    </div>
  )
}

/** 已接收文件下载列表(§12.5) */
function Downloads(): JSX.Element {
  const { t } = useI18n()
  const [files, setFiles] = useState<UiMessage[]>([])
  useEffect(() => {
    window.transfer.listReceivedFiles().then(setFiles)
    // 仅当"接收文件落盘完成"(recv+file+done)才重拉,避免任意 upsert 刷爆 IPC/查询(3-B)
    return window.transfer.onMessageUpserted((m) => {
      if (m.direction === 'recv' && m.type === 'file' && m.status === 'done') {
        window.transfer.listReceivedFiles().then(setFiles)
      }
    })
  }, [])
  return (
    <div style={S.chat}>
      <div style={S.chatHeader}>{t('downloads.title')}</div>
      <div style={{ ...S.stream, gap: 0 }}>
        {files.length === 0 && <div style={S.hint}>{t('downloads.empty')}</div>}
        {files.map((f) => (
          <div key={f.id} className="tf-row" style={S.dlRow}>
            <div style={S.fileIcon}>{fileTypeIcon(f.fileName)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.dlName} title={f.fileName ?? ''}>
                {f.fileName}
              </div>
              <div style={S.dlMeta}>
                {f.fileSize != null ? fmtSize(f.fileSize) : ''} ·{' '}
                {t('downloads.from', { alias: f.peerAlias ?? '' })} · {fmtDateTime(f.createdAt)}
              </div>
            </div>
            <button
              className="tf-btn"
              style={S.openBtn}
              onClick={() => window.transfer.showInFolder(f.id)}
            >
              {t('common.openFolder')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function Bubble({ msg, prog }: { msg: UiMessage; prog?: ProgressMap[string] }): JSX.Element {
  const { t } = useI18n()
  const own = msg.direction === 'sent'
  return (
    <div style={{ ...S.bubbleRow, justifyContent: own ? 'flex-end' : 'flex-start' }}>
      <div style={{ ...S.bubble, ...(own ? S.bubbleOwn : S.bubbleOther) }}>
        {msg.type === 'text' ? (
          <div style={S.text}>{msg.content}</div>
        ) : (
          <FileBubble msg={msg} prog={prog} own={own} />
        )}
        <div style={S.meta}>
          {statusLabel(t, msg)} · {fmtTime(msg.createdAt)}
        </div>
      </div>
    </div>
  )
}

/** 文件类型图标尺寸(px):承载它的 30×30 圆角块见 S.fileIcon / S.fileIconOwn */
const FILE_ICON = 17

/**
 * 按文件扩展名给个贴切的图标(纯装饰,识别不了就用通用文件图标)。
 *
 * 全部取 Lucide 的 `file-*` 家族(A 案,2026-08-21 用户选定):同一个"纸张+折角"轮廓,
 * 一列文件读下来整齐。**扩展名分类规则一字未动**,本次只换表现层。
 *
 * PDF 与文档共用 `file-text`:Lucide 无 PDF 专用字形(1776 个图标全名单已穷举,`pdf` 零命中),
 * 而统一家族里没有第二个合适的替代。代价是丢掉了 emoji 时代 📕 与 📝 的区分——
 * 这是 A 案的已知取舍,不是漏改;要找回区分需跨家族借 `book`,那会破坏家族统一。
 */
function fileTypeIcon(name: string | null): JSX.Element {
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? ''
  if (/^(png|jpg|jpeg|gif|webp|heic|bmp|svg)$/.test(ext)) return <FileImageIcon size={FILE_ICON} />
  if (/^(mp4|mov|avi|mkv|webm)$/.test(ext)) return <FileVideoIcon size={FILE_ICON} />
  if (/^(mp3|wav|flac|aac|m4a)$/.test(ext)) return <FileAudioIcon size={FILE_ICON} />
  if (/^(pdf)$/.test(ext)) return <FileTextIcon size={FILE_ICON} />
  if (/^(zip|rar|7z|tar|gz|dmg|pkg|exe|msi)$/.test(ext)) return <FileArchiveIcon size={FILE_ICON} />
  if (/^(doc|docx|txt|md|rtf)$/.test(ext)) return <FileTextIcon size={FILE_ICON} />
  if (/^(xls|xlsx|csv)$/.test(ext)) return <FileSheetIcon size={FILE_ICON} />
  return <FileIcon size={FILE_ICON} />
}

function FileBubble({
  msg,
  prog,
  own
}: {
  msg: UiMessage
  prog?: ProgressMap[string]
  own: boolean
}): JSX.Element {
  const { t } = useI18n()
  const respondable = canRespond(msg)
  const canOpen = msg.status === 'done' && msg.filePath
  // 传输中(pending/accepted)且有进度 → 百分比进度条(§12.3)
  const transferring = isTransferring(msg.status)
  const pct = prog && prog.total > 0 ? Math.min(100, Math.round((prog.sent / prog.total) * 100)) : null
  const speed = prog ? fmtSpeed(prog.bps) : null
  // 图片消息(已完成落盘)尝试缩略图;拿不到(GIF/WEBP/失败)由 ImageThumb 回退文件行
  const showThumb = canOpen && isImageFile(msg.fileName)
  /**
   * 用时。**图片消息不显示** —— 它传完变缩略图,那一支整个没有文件行,没有依附的位置;
   * 为它单独造一行不值得(2026-08-22 用户裁定)。失败照常显示:花掉的时间是事实。
   * 拿不到时长(升级前的老消息、重启后失去起点的)时 fmtDuration 返回 null,整个右端不出现。
   */
  // 传输中用进度帧带来的已用时间(每帧刷新,所以它会走);终态用落库定格的时长。
  // 两者同源(都是"从点发送/点接收算起"),所以传完的瞬间数字不会跳。
  const took = showThumb ? null : fmtDuration(prog ? prog.elapsedMs : msg.durationMs)
  return (
    <div>
      {showThumb ? (
        <ImageThumb msg={msg} />
      ) : (
        <div style={S.fileLine}>
          <div style={own ? S.fileIconOwn : S.fileIcon}>{fileTypeIcon(msg.fileName)}</div>
          {/* flex:1 让这块撑到气泡内容区右边缘 —— 用时因此与进度条、速度的右端对齐成一条竖线。
              用时必须放在**这块内部**:挂到文件行那一层会让它的宽度叠加在文件名的完整宽度之上
              (文件名 nowrap,按 max-content 撑开),把气泡额外撑长(实测 44px),且文件名越长框越长。 */}
          <div style={S.fileMeta}>
            <div style={S.fileName}>{msg.fileName}</div>
            <div style={S.sizeRow}>
              <span>{msg.fileSize != null ? fmtSize(msg.fileSize) : ''}</span>
              {took && <span style={S.took}>{took}</span>}
            </div>
          </div>
        </div>
      )}
      {transferring && pct !== null && (
        <>
          <div style={own ? S.progWrapOwn : S.progWrap}>
            <div style={{ ...(own ? S.progBarOwn : S.progBar), width: `${pct}%` }} />
          </div>
          <div style={S.progRow}>
            <span>{pct}%</span>
            {/* 速度算不出来时该位留空(第一帧还没有可比的前帧),不显示 0 MB/s 误导 */}
            {speed && <span>{speed}</span>}
          </div>
        </>
      )}
      {/* 接收确认按钮只出现在 recv(对方=灰底气泡),用中性描边按钮 */}
      {respondable && (
        <div style={S.actions}>
          <button
            className="tf-btn"
            style={S.acceptBtn}
            onClick={() =>
              msg.transferId && window.transfer.respond({ transferId: msg.transferId, accept: true })
            }
          >
            {t('common.accept')}
          </button>
          <button
            className="tf-btn"
            style={S.rejectBtn}
            onClick={() =>
              msg.transferId && window.transfer.respond({ transferId: msg.transferId, accept: false })
            }
          >
            {t('common.reject')}
          </button>
        </div>
      )}
      {canOpen && !showThumb && (
        <button
          className="tf-btn"
          style={S.openBtn}
          onClick={() => window.transfer.showInFolder(msg.id)}
        >
          {t('common.openFolder')}
        </button>
      )}
    </div>
  )
}

/**
 * 图片缩略图气泡:向 main 拉缩略图 dataURL(nativeImage 生成)。
 * 拿到 → 显示缩略图,点击调 openFile 用系统查看器看原图;
 * 拿不到(GIF/WEBP/读失败)→ 回退文件图标行(与非图片一致)。
 */
function ImageThumb({ msg }: { msg: UiMessage }): JSX.Element {
  const { t } = useI18n()
  const [thumb, setThumb] = useState<string | null | undefined>(undefined) // undefined=加载中
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null) // 右键菜单位置
  const [viewer, setViewer] = useState<string | null>(null) // 原图 dataURL(居中弹层打开中)

  // 点击缩略图 → 拉原图 dataURL,打开居中弹层看大图
  const openViewer = (): void => {
    window.transfer.getImageDataUrl(msg.id).then((d) => {
      if (d) setViewer(d)
    })
  }

  // 弹层打开时 Esc 关闭
  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewer(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  useEffect(() => {
    let alive = true
    window.transfer.getThumbnail(msg.id).then((d) => {
      if (alive) setThumb(d)
    })
    return () => {
      alive = false
    }
  }, [msg.id])

  // 右键菜单打开时,点别处/滚动关闭
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  // 拿不到缩略图 → 回退文件行
  if (thumb === null) {
    return (
      <div style={S.fileLine}>
        <div style={S.fileIcon}>{fileTypeIcon(msg.fileName)}</div>
        <div style={{ minWidth: 0 }}>
          <div style={S.fileName}>{msg.fileName}</div>
          {msg.fileSize != null && <div style={S.fileSize}>{fmtSize(msg.fileSize)}</div>}
        </div>
      </div>
    )
  }
  // 加载中:占位(保持文件名,避免闪)
  if (thumb === undefined) {
    return <div style={S.thumbLoading}>{msg.fileName}</div>
  }
  return (
    <>
      <img
        src={thumb}
        style={S.thumb}
        onClick={openViewer}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        title={t('image.thumbTitle')}
        alt={msg.fileName ?? ''}
      />
      {viewer && (
        <div style={S.lightbox} onClick={() => setViewer(null)}>
          <img src={viewer} style={S.lightboxImg} alt={msg.fileName ?? ''} />
        </div>
      )}
      {menu && (
        <div style={{ ...S.imgMenu, left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <div
            className="tf-row"
            style={S.imgMenuItem}
            onClick={() => {
              setMenu(null)
              void window.transfer.saveImageAs(msg.id)
            }}
          >
            {t('image.saveImage')}
          </div>
          <div
            className="tf-row"
            style={S.imgMenuItem}
            onClick={() => {
              setMenu(null)
              void window.transfer.openFile(msg.id)
            }}
          >
            {t('image.openWithSystem')}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * 截图快捷键录制:显示当前键;点输入框进"按下快捷键…"态,捕获组合键。
 * 捕获到合法 accelerator 即调 setShortcut 立即生效(成功即显示,失败红字提示,无需额外保存)。
 * Esc / 失焦退出录制,不改键。
 */
function ShortcutRecorder(): JSX.Element {
  const { t } = useI18n()
  const [accel, setAccel] = useState<string | null>(null) // 当前生效的键(null=加载中)
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState<string | null>(null) // 提示(录制引导 / 冲突 / 非法)
  const [hintErr, setHintErr] = useState(false) // hint 是否红字(错误)

  useEffect(() => {
    window.transfer.getShortcut().then(setAccel)
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(false)
      setHint(null)
      return
    }
    const info = {
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      key: e.key
    }
    const next = eventToAccelerator(info)
    if (!next) {
      // 未构成合法快捷键:给引导,继续等
      const reason = acceleratorRejectReason(info)
      setHintErr(false)
      setHint(
        reason === 'need-modifier'
          ? t('shortcut.hintNeedModifier')
          : reason === 'unsupported'
            ? t('shortcut.hintUnsupported')
            : t('shortcut.hintContinue')
      )
      return
    }
    // 合法 → 立即试生效
    setRecording(false)
    setHint(t('shortcut.saving'))
    setHintErr(false)
    window.transfer.setShortcut(next).then((r) => {
      if (r.ok) {
        setAccel(r.accel)
        setHint(null)
      } else {
        setHintErr(true)
        setHint(r.reason === 'conflict' ? t('shortcut.errConflict') : t('shortcut.errInvalid'))
      }
    })
  }

  return (
    <div style={S.settingRow}>
      <span style={{ flexShrink: 0 }}>{t('shortcut.captureLabel')}</span>
      <button
        className="tf-btn"
        style={{ ...S.shortcutBox, ...(recording ? S.shortcutBoxRec : {}) }}
        onClick={() => {
          setRecording(true)
          setHint(t('shortcut.recordGuideEsc'))
          setHintErr(false)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // 仅在"仍处录制态"时因失焦取消(清引导提示);已捕获后 setShortcut 的
          // 成功/冲突结果不能被 blur 清掉(捕获时已 setRecording(false),故用它区分)。
          if (recording) {
            setRecording(false)
            setHint(null)
          }
        }}
      >
        {recording ? t('shortcut.recordGuide') : (accel ?? '…')}
      </button>
      {hint && (
        <span style={{ ...S.shortcutHint, color: hintErr ? 'var(--danger)' : 'var(--muted)' }}>
          {hint}
        </span>
      )}
    </div>
  )
}

function SettingsModal(props: {
  value: AutoAcceptSettings
  onClose: () => void
  onSave: (s: Partial<AutoAcceptSettings>) => void
}): JSX.Element {
  const { t, pref: langPref, setPref: setLangPref } = useI18n()
  const [enabled, setEnabled] = useState(props.value.enabled)
  const [mb, setMb] = useState(Math.round(props.value.maxBytes / (1024 * 1024)))
  const [dirs, setDirs] = useState<StorageDirs | null>(null)
  const [offlineKeep, setOfflineKeep] = useState<number | null>(null)
  useEffect(() => {
    window.transfer.getStorageDirs().then(setDirs)
    window.transfer.getOfflineKeep().then(setOfflineKeep)
  }, [])
  return (
    <div style={S.modalMask} onClick={props.onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t('settings.title')}</h3>

        <div style={S.settingSectionTitle}>{t('settings.sectionReceive')}</div>
        <label style={S.settingRow}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('settings.autoAcceptLabel')}
        </label>
        <label style={{ ...S.settingRow, opacity: enabled ? 1 : 0.5 }}>
          {t('settings.maxSizeLabel')}
          <input
            type="number"
            value={mb}
            disabled={!enabled}
            onChange={(e) => setMb(Math.max(0, Number(e.target.value)))}
            style={S.numInput}
          />
          MB
        </label>

        <div style={S.settingSectionTitle}>{t('settings.sectionStorage')}</div>
        <div style={S.storageRow}>
          <span style={S.storageLabel}>{t('settings.fileLabel')}</span>
          <span style={S.storagePath} title={dirs?.downloads ?? ''}>
            {dirs?.downloads ?? '…'}
          </span>
          <button
            className="tf-icon-btn"
            data-testid="btn-open-downloads"
            style={S.storageIconBtn}
            title={t('settings.openFolderTitle')}
            onClick={() => window.transfer.openDownloadsDir()}
          >
            <FolderOpenIcon size={15} />
          </button>
        </div>

        <div style={S.settingSectionTitle}>{t('settings.sectionShortcut')}</div>
        <ShortcutRecorder />

        <div style={S.settingSectionTitle}>{t('settings.sectionDiscovery')}</div>
        <div style={S.settingRow}>
          <span style={S.storageLabel}>{t('settings.offlineKeepLabel')}</span>
          <select
            value={offlineKeep ?? ''}
            disabled={offlineKeep === null}
            onChange={(e) => {
              const minutes = Number(e.target.value)
              setOfflineKeep(minutes)
              void window.transfer.setOfflineKeep(minutes).then(setOfflineKeep)
            }}
            style={S.langSelect}
          >
            {OFFLINE_KEEP_PRESETS.map((p) => (
              <option key={p.minutes} value={p.minutes}>
                {t(p.labelKey as TKey)}
              </option>
            ))}
          </select>
        </div>
        <div style={S.langHint}>{t('settings.offlineKeepHint')}</div>

        <div style={S.settingSectionTitle}>{t('settings.sectionLanguage')}</div>
        <div style={S.settingRow}>
          <select
            value={langPref}
            onChange={(e) => setLangPref(e.target.value as LangPref)}
            style={S.langSelect}
          >
            <option value="system">{t('settings.lang.system')}</option>
            <option value="zh">{t('settings.lang.zh')}</option>
            <option value="en">{t('settings.lang.en')}</option>
          </select>
        </div>
        {langPref === 'system' && <div style={S.langHint}>{t('settings.lang.systemHint')}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={props.onClose} style={S.btn}>
            {t('common.cancel')}
          </button>
          <button
            onClick={() => props.onSave({ enabled, maxBytes: mb * 1024 * 1024 })}
            style={{ ...S.btn, ...S.btnPrimary }}
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── helpers ──
/** failed 消息按 errorReason 给明确文案(映射表与兜底见 @shared/i18n/failed-label)。 */
function failedLabel(t: TFn<TKey>, reason: ErrorReason | null): string {
  return t(failedLabelKey(reason))
}
function statusLabel(t: TFn<TKey>, m: UiMessage): string {
  switch (m.status) {
    case 'pending':
      return m.direction === 'sent' ? t('chat.status.pendingSent') : t('chat.status.pendingRecv')
    case 'accepted':
      return t('chat.status.accepting')
    case 'sent':
      return t('chat.status.sent')
    case 'done':
      return m.direction === 'sent' ? t('chat.status.delivered') : t('chat.status.received')
    case 'rejected':
      return t('chat.status.rejected')
    case 'expired':
      return t('chat.status.expired')
    case 'failed':
      return failedLabel(t, m.errorReason)
    default: {
      // 无 default 兜底:MessageStatus 新增成员时此处编译报错,
      // 强制补上对应文案,而不是把状态原始字符串("paused" 之类)漏到界面上。
      const exhaustive: never = m.status
      return exhaustive
    }
  }
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 静谧石墨中性 + Notion 紫:所有颜色走 CSS 变量(见 theme.css),字号小一档、边框细、留白从容。
const S: Record<string, React.CSSProperties> = {
  app: { display: 'flex', height: '100vh', color: 'var(--ink)', fontSize: 13 },
  sidebar: { width: 220, flexShrink: 0, borderRight: '1px solid var(--line)', background: 'var(--side)', display: 'flex', flexDirection: 'column', padding: '14px 12px', boxSizing: 'border-box', overflowY: 'auto' },
  brand: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  brandName: { fontSize: 15, fontWeight: 640, letterSpacing: '-0.01em' },
  // background 不写在这里:它由 .tf-icon-btn 给(内联会压死该 class 的 :hover,见 theme.css)
  iconBtn: { border: 'none', fontSize: 14, cursor: 'pointer', color: 'var(--muted)', width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center' },
  self: { fontSize: 11, color: 'var(--muted)', margin: '3px 0 14px' },
  devHeader: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--muted)', margin: '12px 4px 5px' },
  hint: { color: 'var(--muted)', fontSize: 12.5, padding: 8, lineHeight: 1.5 },
  devItem: { padding: '7px 9px', borderRadius: 8, cursor: 'pointer', marginBottom: 1 },
  devItemActive: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  devItemOffline: { opacity: 0.5 },
  devName: { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  devSub: { fontSize: 10.5, color: 'var(--muted)', marginTop: 1, paddingLeft: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dot: { width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  unreadBadge: { flexShrink: 0, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontVariantNumeric: 'tabular-nums' },
  // 设备备注:行内编辑输入框 + 右键菜单(theme.css 变量,深浅色自适配)
  aliasInput: { flex: 1, minWidth: 0, font: 'inherit', fontWeight: 550, color: 'var(--ink)', background: 'var(--card)', border: '1px solid var(--line-strong)', borderRadius: 5, padding: '1px 5px', outline: 'none' },
  aliasInputError: { borderColor: 'var(--danger)' },
  aliasErr: { fontSize: 10.5, color: 'var(--danger)', marginTop: 2, paddingLeft: 14 },
  ctxMenu: { position: 'fixed', zIndex: 50, minWidth: 120, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: 4 },
  ctxItem: { padding: '6px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 13, color: 'var(--ink)' },
  ctxErr: { padding: '4px 10px', fontSize: 11, color: 'var(--danger)' },
  downloadsEntry: { padding: '7px 9px', borderRadius: 8, cursor: 'pointer', marginBottom: 8, fontSize: 12.5, fontWeight: 550, display: 'flex', alignItems: 'center', gap: 7 },
  main: { flex: 1, display: 'flex', minWidth: 0, background: 'var(--card)' },
  empty: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', gap: 8 },
  chat: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
  chatHeader: { padding: '13px 18px', borderBottom: '1px solid var(--line)', fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 },
  offlineTag: { fontSize: 10.5, fontWeight: 450, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 5, padding: '1px 7px' },
  stream: { flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 9, position: 'relative' },
  streamDragging: { outline: '2px dashed var(--accent)', outlineOffset: -8, background: 'var(--accent-soft)' },
  // 此处只放几何与定位;染色玻璃的底色/模糊/阴影/hover 在 theme.css 的 .tf-jump-btn
  // (内联样式优先级高于 class,底色若写这里会把 :hover 压住)。三处易踩的坑:
  // ① sticky 而非 absolute——absolute 的子元素在**可滚动容器内**相对内容盒定位,会跟着内容
  //    滚走(实测:往上翻后按钮消失在视口下方);sticky 才钉在视口。dropHint 同法。
  // ② 负 marginBottom 抵消自身高度,使它不在流中占位、纯浮于内容之上。
  // ③ flexShrink: 0 不能省——消息流是 flex column,内容溢出时会把按钮的高压扁成椭圆。
  jumpBtn: { position: 'sticky', bottom: 14, alignSelf: 'flex-end', flexShrink: 0, marginBottom: -36, marginRight: 4, width: 36, height: 36, borderRadius: '50%', display: 'grid', placeItems: 'center', color: 'var(--accent)', border: 0, cursor: 'pointer', padding: 0 },
  jumpDot: { position: 'absolute', top: 0, right: 0, width: 9, height: 9, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 2px var(--bg)' },
  dropHint: { position: 'sticky', bottom: 8, alignSelf: 'center', background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent)', padding: '6px 16px', borderRadius: 18, fontSize: 12.5, pointerEvents: 'none', boxShadow: 'var(--shadow-md)' },
  bubbleRow: { display: 'flex' },
  bubble: { maxWidth: '74%', padding: '8px 12px', borderRadius: 14 },
  bubbleOwn: { background: 'var(--bubble-me)', color: 'var(--bubble-me-ink)', borderBottomRightRadius: 5 },
  bubbleOther: { background: 'var(--bubble-you)', color: 'var(--bubble-you-ink)', borderBottomLeftRadius: 5 },
  text: { fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  meta: { fontSize: 9.5, opacity: 0.7, marginTop: 4 },
  fileLine: { display: 'flex', alignItems: 'center', gap: 9 },
  // color 必须显式给:emoji 自带颜色,换成 SVG 后走 currentColor,不给会继承 --ink 变墨色
  // (theme.css 的既有配对:accent-soft 柔底 + accent 紫图标)。fontSize 是撑 emoji 用的,已失效。
  fileIcon: { width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0, background: 'var(--accent-soft)', color: 'var(--accent)' },
  // me 气泡是柔紫底,图标底不能再用同支柔紫(会糊),改用紫墨半透明:比气泡深一档、浅深底都可见
  fileIconOwn: { width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', flexShrink: 0, background: 'var(--own-wash)', color: 'var(--accent)' },
  fileName: { fontWeight: 560, fontSize: 12.5 },
  fileSize: { fontSize: 10.5, opacity: 0.65, marginTop: 1 },
  // flex:1 让这块撑到气泡内容区右边缘,用时的右端因此与进度条、速度对齐(见 FileBubble 注释)
  fileMeta: { flex: 1, minWidth: 0 },
  sizeRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 14,
    fontSize: 10.5,
    opacity: 0.65,
    marginTop: 1,
    fontVariantNumeric: 'tabular-nums'
  },
  // 等宽数字 + 不折行:时长每秒都在变,宽度一抖右端就左右摆
  took: { whiteSpace: 'nowrap', flexShrink: 0 },
  thumb: {
    display: 'block',
    maxWidth: 180,
    maxHeight: 240,
    borderRadius: 8,
    cursor: 'pointer',
    objectFit: 'cover'
  },
  thumbLoading: {
    minWidth: 100,
    padding: '18px 12px',
    fontSize: 11.5,
    color: 'var(--muted)',
    background: 'var(--track)',
    borderRadius: 8,
    textAlign: 'center'
  },
  imgMenu: {
    position: 'fixed',
    zIndex: 1000,
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    padding: 4,
    boxShadow: 'var(--shadow-md)',
    minWidth: 132
  },
  imgMenuItem: {
    padding: '7px 10px',
    fontSize: 12.5,
    borderRadius: 5,
    cursor: 'pointer',
    color: 'var(--ink)'
  },
  lightbox: {
    position: 'fixed',
    inset: 0,
    zIndex: 2000,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'zoom-out',
    padding: 32,
    boxSizing: 'border-box'
  },
  lightboxImg: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: 4,
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)'
  },
  progWrap: { position: 'relative', height: 5, background: 'var(--track)', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  progWrapOwn: { position: 'relative', height: 5, background: 'var(--own-wash)', borderRadius: 3, marginTop: 8, overflow: 'hidden' },
  progBar: { position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--accent)', borderRadius: 3, transition: 'width 0.12s linear' },
  // 全柔紫方案:me 气泡里的填充条也用中等紫(和非 own 一致),柔底上够清楚
  progBarOwn: { position: 'absolute', left: 0, top: 0, bottom: 0, background: 'var(--accent)', borderRadius: 3, transition: 'width 0.12s linear' },
  // 左端百分比、右端速度。两端分居而不是串排:速度位数一变,串排会把百分比也推得左右晃
  progRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
    fontSize: 9.5,
    marginTop: 3,
    opacity: 0.85,
    fontVariantNumeric: 'tabular-nums'
  },
  dlRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', borderBottom: '1px solid var(--line)' },
  dlName: { fontWeight: 550, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  dlMeta: { fontSize: 10.5, color: 'var(--muted)', marginTop: 2, fontVariantNumeric: 'tabular-nums' },
  actions: { display: 'flex', gap: 7, marginTop: 8 },
  acceptBtn: { padding: '4px 13px', border: '1px solid var(--accent-soft)', borderRadius: 6, background: 'var(--accent-soft)', color: 'var(--accent)', cursor: 'pointer', fontSize: 11.5 },
  rejectBtn: { padding: '4px 13px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontSize: 11.5 },
  openBtn: { marginTop: 8, padding: '4px 13px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontSize: 11.5 },
  inputBar: { display: 'flex', gap: 8, padding: '11px 14px', borderTop: '1px solid var(--line)', alignItems: 'flex-end' },
  // 截图/附件按钮:固定 34×34 盒子与输入框首行等高,grid 居中 SVG。inputBar 的 flex-end 下
  // 按钮盒底与 textarea 底对齐,图标又在盒内垂直居中 → 视觉上与输入框首行对齐。
  inputIconBtn: { width: 34, height: 34, border: 'none', background: 'none', cursor: 'pointer', opacity: 0.55, display: 'grid', placeItems: 'center', padding: 0, color: 'var(--ink)', flexShrink: 0 },
  textarea: { flex: 1, border: '1px solid var(--line-strong)', borderRadius: 10, padding: '8px 12px', fontSize: 13, resize: 'none', fontFamily: 'inherit', maxHeight: 120, background: 'var(--bg)', color: 'var(--ink)', outline: 'none' },
  sendBtn: { width: 34, height: 34, border: 'none', borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', cursor: 'pointer', fontSize: 14, display: 'grid', placeItems: 'center', flexShrink: 0 },
  modalMask: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' },
  modal: { background: 'var(--card)', color: 'var(--ink)', borderRadius: 14, padding: 24, width: 380, border: '1px solid var(--line)', boxShadow: 'var(--shadow-md)' },
  settingRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0', fontSize: 13 },
  settingSectionTitle: { fontSize: 12, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.03em', margin: '16px 0 4px' },
  storageRow: { display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0', fontSize: 12 },
  storageLabel: { flexShrink: 0, color: 'var(--ink)' },
  storagePath: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted)', direction: 'rtl', textAlign: 'left' },
  // 同 iconBtn:background 归 .tf-icon-btn 管
  storageIconBtn: { flexShrink: 0, border: 'none', cursor: 'pointer', color: 'var(--muted)', width: 22, height: 22, borderRadius: 6, padding: 0, display: 'grid', placeItems: 'center' },
  shortcutBox: { minWidth: 120, padding: '4px 12px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', cursor: 'pointer', fontSize: 12, fontFamily: 'ui-monospace, monospace', textAlign: 'center' },
  shortcutBoxRec: { borderColor: 'var(--accent)', color: 'var(--accent)' },
  shortcutHint: { fontSize: 11, flex: 1, minWidth: 0 },
  langSelect: { padding: '4px 10px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', cursor: 'pointer', fontSize: 12.5 },
  langHint: { fontSize: 11, color: 'var(--muted)', margin: '-2px 0 4px' },
  numInput: { width: 80, padding: '4px 8px', border: '1px solid var(--line-strong)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)' },
  btn: { padding: '6px 16px', border: '1px solid var(--line-strong)', borderRadius: 8, background: 'var(--card)', color: 'var(--ink)', cursor: 'pointer', fontSize: 13 },
  btnPrimary: { border: '1px solid var(--accent-soft)', background: 'var(--accent-soft)', color: 'var(--accent)' }
}
