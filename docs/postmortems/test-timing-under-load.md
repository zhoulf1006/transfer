# Tests that fail only under full-suite load

## Symptom

`pnpm test` was red about one run in two on a busy Mac, each time in a different mix of four files: the multicast integration tests (`waitFor timeout`), the app-core end-to-end tests and the file-hash memory test (vitest's 5000 ms test timeout), and the slow-upload idle test (`upload timeout`). Run alone, the same files always passed. Nothing in the code under test was wrong.

## Root causes (one per kind of budget)

| Test | Budget | What actually happened under load |
|---|---|---|
| multicast, app-core discovery | 3 s per wait / 5 s per test | The **first datagram on a freshly created multicast socket** arrives late: measured up to ~1.8 s from a standalone probe and ~3 s inside the tests, never lost. A long-lived socket on the same machine at the same time saw at most 67 ms. |
| file-hash memory test | vitest default 5 s | Hashing 384 MB twice is CPU-bound: 1–2 s alone, 3–16 s under one or two concurrent suites. The assertion is about memory, so the time limit had nothing to do with it. |
| upload-idle slow transfer | 500 ms idle threshold (production: 45 s) | The test's receiver throttled with one `setTimeout(chunk / rate)` per chunk. Each timer's lateness adds to the next, so the effective rate falls under load (the upload, ~1.3 s on an idle machine, took ~6 s) and the gap between progress touches grows toward the idle threshold. The process itself was never stalled: event-loop delay stayed under 200 ms. |

Also found: two negative checks slept a fixed 200 ms and then asserted that nothing had happened. When the first datagram takes longer than that, the assertion passes without the datagram ever having arrived.

## Dead ends

- **"Multicast is routed into the VPN tunnel."** The machine runs a proxy with a TUN interface that owns a `224.0.0/4` route. A probe sending every 500 ms recorded the routing interface and delivery for 8 minutes across the failing runs: always `en0`, 0 lost.
- **"The test worker is starved."** Measuring `monitorEventLoopDelay` during each wait showed 13–41 ms while the waits took 1.5–3.8 s. The process was running; the datagram was late.
- **Rejected without trying: raising the idle threshold of the upload test.** It would hide the drift rather than remove it; pacing against the clock keeps the 500 ms threshold and the test's meaning.

## What was done

- Wait helpers bound a hang (15 s), not a speed; the tests that wait carry a 30 s timeout, and the file-hash memory test 60 s (the convention in `transfer/`: per-test timeout as the third argument).
- Negative checks wait for a **witness**: a datagram that must be handled (sent after the one under test from the same socket, or the reply itself reaching `onDevice`) before asserting that something did not happen.
- Throttles in tests are **paced against the clock** (release each chunk when the bytes so far are due), never by summing per-chunk delays.

## How to measure it next time

- Repeat the full suite (`vitest run --reporter=json --outputFile=…`) ten times and compare per-test durations with the budgets; one green run says nothing.
- Widen the test timeout temporarily to see true durations instead of the cut-off.
- Inside a wait, record both the elapsed time and `perf_hooks.monitorEventLoopDelay().max`: a long wait with a small loop delay means the event is late, not the process.
- For multicast, compare a long-lived socket with freshly created ones on the same machine at the same time.
- Two suites on one machine collide on the fixed test ports (multicast 55317; app-core 56000, 56317–56321 and 57317); exclude those files from the second suite when generating load.
