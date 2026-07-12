import { useEffect, useState, useCallback } from 'react'
import type { RemoteDevice } from '@shared/types'
import type { IdentityInfo, IncomingPayload, ProgressPayload } from '@shared/ipc'

interface LogLine {
  ts: number
  text: string
}

export function App(): JSX.Element {
  const [identity, setIdentity] = useState<IdentityInfo | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [log, setLog] = useState<LogLine[]>([])
  const [busy, setBusy] = useState(false)

  const addLog = useCallback((text: string) => {
    setLog((l) => [{ ts: Date.now(), text }, ...l].slice(0, 50))
  }, [])

  useEffect(() => {
    window.transfer.getIdentity().then(setIdentity)
    window.transfer.listDevices().then(setDevices)

    const unsubs = [
      window.transfer.onDevicesUpdated((d) => setDevices(d as RemoteDevice[])),
      window.transfer.onIncoming((p) => {
        const i = p as IncomingPayload
        addLog(`📥 收到来自 ${i.fromAlias} 的 ${i.files.length} 个文件请求`)
      }),
      window.transfer.onProgress((p) => {
        const pr = p as ProgressPayload
        addLog(`${pr.direction === 'recv' ? '✅ 已接收' : '📤 已发送'}:${pr.fileName}`)
      }),
      window.transfer.onError((p) => addLog(`❌ ${(p as { message: string }).message}`))
    ]
    return () => unsubs.forEach((u) => u())
  }, [addLog])

  async function pick(): Promise<void> {
    const files = await window.transfer.pickFiles()
    if (files.length) setSelected(files)
  }

  async function sendTo(fingerprint: string): Promise<void> {
    if (!selected.length) {
      addLog('⚠️ 请先选择文件')
      return
    }
    setBusy(true)
    const res = await window.transfer.send({ fingerprint, filePaths: selected })
    setBusy(false)
    if (res.ok) addLog(`📤 发送成功(${selected.length} 个文件)`)
    else addLog(`❌ 发送失败:${res.message}`)
  }

  return (
    <div style={S.page}>
      <header style={S.header}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Transfer</h1>
        {identity && (
          <span style={{ color: '#888', fontSize: 13 }}>
            本机:{identity.alias} · {identity.fingerprint.slice(0, 8)}
          </span>
        )}
      </header>

      <section style={S.row}>
        <button onClick={pick} style={S.btn}>
          选择文件
        </button>
        <span style={{ color: '#666', fontSize: 13 }}>
          {selected.length ? `已选 ${selected.length} 个文件` : '未选择文件'}
        </span>
      </section>

      <section>
        <h2 style={S.h2}>附近设备</h2>
        {devices.length === 0 && <p style={{ color: '#999' }}>正在搜索局域网设备…</p>}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {devices.map((d) => (
            <li key={d.info.fingerprint} style={S.device}>
              <div>
                <strong>{d.info.alias}</strong>
                <div style={{ color: '#999', fontSize: 12 }}>
                  {d.info.deviceModel} · {d.address}:{d.port}
                </div>
              </div>
              <button
                onClick={() => sendTo(d.info.fingerprint)}
                disabled={busy || !selected.length}
                style={{ ...S.btn, opacity: busy || !selected.length ? 0.5 : 1 }}
              >
                发送
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 style={S.h2}>活动</h2>
        <div style={S.log}>
          {log.map((l) => (
            <div key={l.ts + l.text} style={{ fontSize: 13, padding: '2px 0' }}>
              {l.text}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: 'system-ui', padding: 24, maxWidth: 720, margin: '0 auto' },
  header: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 },
  row: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 },
  h2: { fontSize: 15, color: '#444', marginBottom: 8 },
  btn: {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid #ccc',
    background: '#f7f7f7',
    cursor: 'pointer'
  },
  device: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 12px',
    border: '1px solid #eee',
    borderRadius: 8,
    marginBottom: 8
  },
  log: {
    border: '1px solid #eee',
    borderRadius: 8,
    padding: 12,
    minHeight: 80,
    maxHeight: 200,
    overflowY: 'auto',
    background: '#fafafa'
  }
}
