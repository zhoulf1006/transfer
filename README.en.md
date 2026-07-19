# Transfer

[简体中文](README.md) | **English**

> Cross-platform (macOS / Windows) LAN tool: **file/text transfer + chat + screenshot annotation**, all in one.
> Direct LAN connection, **no server, no account, no cloud**. Built on Electron + TypeScript; discovery and transfer are compatible with the [LocalSend protocol v2](https://github.com/localsend/protocol).

---

## What is this

Two computers on the same Wi-Fi / LAN just open Transfer and **automatically discover each other**, then send files, text, and screenshots to one another like a chat — without going through any relay server. Data stays within the local network.

Good for:

- Moving files between two computers at hand (your own Mac + Windows) without a USB stick or cloud drive.
- Quickly sending a file or a snippet of text to a colleague on the same network.
- Taking a screenshot, annotating it, and sending it to the person you're chatting with in one click.

## Key features

| Feature | Description |
|------|------|
| **Auto discovery** | UDP multicast + subnet broadcast dual channels, zero config; devices on the same network appear in the list automatically. Compatible with the official LocalSend client's discovery broadcast. |
| **File transfer** | Pick files to send; the receiver confirms via a **dialog/bubble** before they land on disk; supports sending multiple files at once (parallel transfer) with built-in **SHA-256 integrity check**. |
| **Text messages** | Send text directly, shown instantly like an IM. |
| **Chat-style UI** | Text and files are unified into a message-bubble stream with local **SQLite history persistence**; unread badges + system-level new-message alerts (macOS Dock number badge / Windows taskbar flash). |
| **Screenshot annotation** | Global shortcut (default **F1**, customizable) to select a screenshot region, with a full annotation toolkit (rectangle / ellipse / arrow / pen / text / number / mosaic / gaussian blur, etc.) + a color-picker magnifier, and three outputs: **send to current chat / copy to clipboard / save to file**; the chat input area also has a screenshot button and supports **pasting images to send directly**. |
| **Auto-accept** | Optional: files below a size threshold are accepted automatically (text messages are always auto-accepted; by default all files require confirmation). |
| **Multi-language (follows system)** | The UI supports Chinese / English, showing automatically **according to the system language** by default, and can also be switched manually in Settings — switching takes effect instantly, no restart needed. Covers the main window, the screenshot annotation toolbar, and system dialogs. |

> **Security note**: Transfers run over **HTTPS** (self-signed certificate + fingerprint TOFU pinning), which prevents passive eavesdropping. But device fingerprints are broadcast over plaintext UDP, so **an active attacker on the same subnet can impersonate the peer** (same-level limitation as official LocalSend) — **the confirmation dialog before receiving is the human line of defense against impersonation**. Use it on a **trusted LAN**; sending sensitive content over public Wi-Fi is not recommended.

> **Known limitation · VPN / full tunnel blocks direct LAN connection**: Transfer relies on **connecting directly to the peer's LAN IP** (HTTPS) to send and receive messages. If **either side enables a VPN full-tunnel mode** (e.g. the default config of enterprise VPNs like F5 BIG-IP Edge Client), the OS routes traffic destined for LAN IPs into the VPN tunnel too, so the direct connection to the peer gets "hijacked" into the tunnel and can't be delivered — the symptom is **you can see the other device in the list, but messages won't send** (the connection will report "connection timed out, the peer may be on a VPN" after about 10 seconds). Fixes: **temporarily turn off the VPN**, or enable **Split Tunnel / Local Subnet Access** in the VPN client to allow the LAN subnet through. This is a limitation of the peer's network environment, not something Transfer can work around.

## How it works

```
┌──────── Device A ────────┐                      ┌──────── Device B ────────┐
│  Electron App            │   UDP multicast      │            Electron App  │
│  ┌────────────┐          │  224.0.0.167:53317   │          ┌────────────┐  │
│  │ Discovery  │◄─────────┼── + subnet broadcast ┼─────────►│ Discovery  │  │
│  │  (dgram)   │          │                      │          │  (dgram)   │  │
│  └────────────┘          │                      │          └────────────┘  │
│  ┌────────────┐          │       HTTPS :53317   │          ┌────────────┐  │
│  │  Fastify   │◄─────────┼── prepare-upload ────┼─────────►│  Fastify   │  │
│  │  (HTTPS)   │          │   / upload / cancel  │          │  (HTTPS)   │  │
│  └────────────┘          │                      │          └────────────┘  │
└──────────────────────────┘                      └──────────────────────────┘
```

- **Discovery**: each device periodically sends announce packets (UDP multicast `224.0.0.167:53317` + per-interface subnet broadcast); on receipt it responds with an HTTP directed register. Own packets are filtered out by `fingerprint`.
- **Transfer**: follows the LocalSend v2 handshake over **HTTPS** (self-signed certificate + fingerprint TOFU pinning) — `prepare-upload` (negotiate + confirm) → `upload` (raw binary streamed to disk, can be parallel) → SHA-256 verification on completion. Text goes in the `preview` field of `prepare-upload` and does not use `upload`.
- **Process split**: the main process handles all networking / file / system capabilities; the renderer only does UI and communicates via restricted IPC through `contextBridge`.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the detailed design; see [`docs/screenshot-feature.md`](docs/screenshot-feature.md) for the screenshot feature.

## Tech stack

- **Electron 35** + **TypeScript** + **React 18**
- **electron-vite** build (main window + screenshot overlay multi-entry)
- Discovery: Node's built-in **`dgram`** (native UDP multicast, not mDNS)
- Transfer: **Fastify (HTTPS)** + **`node:https` client** (self-signed cert + fingerprint pinning; `upload` uses `addContentTypeParser` to pipe `request.raw` straight to disk, never into memory)
- Certificate: **`selfsigned`** (pure JS, EC P-256 self-signed)
- History storage: **`node:sqlite`** (built into Electron 35, zero native dependencies)
- Package manager: **pnpm**

## Development

Prerequisites: Node 22.16+ (needs built-in `node:sqlite`), pnpm 9.

```bash
pnpm install

pnpm dev          # dev mode (HMR)
pnpm typecheck    # type check
pnpm test         # run tests (vitest)
pnpm build        # build
```

> To test "two devices" transferring on one machine: start two instances with different `userData` directories / different fingerprints (to avoid same-fingerprint self-detection). See DESIGN §9.

## Packaging

```bash
pnpm dist:mac         # macOS (universal: single arm64 + x64 dmg)
pnpm dist:mac:sign    # macOS sign + notarize (local, requires Developer ID)
pnpm dist:win         # Windows (NSIS installer + portable)
```

CI (GitHub Actions, `.github/workflows/build.yml`) builds macOS / Windows artifacts when a tag is pushed (or manually triggered). A clean macOS tag gets notarized into a release build.

> Unsigned builds show a one-time system security prompt on first open on another machine — this is normal.

## Project status

- ✅ LAN discovery, file/text transfer, SHA-256 verification, parallel transfer
- ✅ Chat-style UI, SQLite history, unread alerts, auto-accept
- ✅ Screenshot + full annotation + three outputs, custom shortcut, paste-to-send
- ✅ HTTPS encrypted transfer (self-signed cert + fingerprint TOFU pinning)
- ✅ Multi-language UI (Chinese / English), follows system or switch manually
- 🚧 Planned: PIN protection / out-of-band fingerprint verification, full interop with third-party LocalSend apps, transfer history cleanup, resumable transfer, notes (Markdown)

## Directory structure

```
src/
  main/          # main process: discovery / transfer / screenshot / chat service / SQLite / IPC
    discovery/   # UDP multicast + broadcast, device table
    transfer/    # Fastify server/client, session state machine, disk writes
    db/          # node:sqlite message table
    screenshot-service.ts
  preload/       # contextBridge restricted API
  renderer/      # React UI (main chat window + screenshot overlay)
  shared/        # shared across all three: protocol constants / types / IPC definitions / pure logic
docs/            # design docs and per-topic records
```

## License

[MIT](LICENSE) © loong_zhou
