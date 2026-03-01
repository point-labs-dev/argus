# Learnings

## 2026-02-28 — Research & Architecture

### Scrypted Deep Dive
- Rebroadcast/prebuffer layer is the most critical component — decouples unstable camera transports from consumers
- HKSV reliability comes from strict stream conformance (IDR cadence, packet timing, fragmented MP4 correctness)
- Reolink support requires model/firmware quirk tables — generic ONVIF alone won't cut it
- Mixin system creates ordering headaches — a simple pipeline is better
- Dijkstra converter graph is over-engineered for a focused project
- NVR recording is closed-source — this is the gap we fill

### go2rtc is the Answer
- Don't build rebroadcast layer — use go2rtc (Go binary, battle-tested, used by Frigate)
- go2rtc handles: RTSP proxy, WebRTC, HLS, codec negotiation, zero-copy passthrough
- One binary replaces Scrypted's 1500-line prebuffer plugin

### Stack Decision: TypeScript + Effect.ts + go2rtc
- Rust was considered (Moonfire NVR proves it works) but HKSV has no Rust implementation
- HAP-NodeJS is the only library with working HKSV — locks us to Node.js
- Effect.ts provides "Rust-like" typed errors, structured concurrency, resource safety
- Hybrid (Rust recorder + Node HomeKit) adds complexity without enough benefit
- Two processes (go2rtc + Argus) is simpler than three

### HomeKit Bridge Bottleneck
- HomeKit bridges serialize ALL requests — one slow camera blocks everything
- Solution: standalone accessory per camera (own HAP instance, own port, own mDNS)
- Scrypted docs explicitly recommend this for cameras

### Snapshot Performance
- HomeKit constantly requests snapshots (Home app grid, notifications, widgets)
- Spawning FFmpeg per request = slow, blocks bridge
- Solution: cache frames from prebuffer every 5s, serve instantly

### HKSV Has No Official SDK
- Apple's open-source ADK (HomeKitADK) has NO camera/HKSV support — it's for sensors/lightbulbs
- Full HKSV spec is behind MFi NDA
- Everyone uses the reverse-engineered unofficial spec (github.com/Supereg/secure-video-specification)
- HAP-NodeJS has working implementation built from this

### Frigate's Recording Model
- Segment-based: raw stream → 1-min MP4 files, no re-encoding
- SQLite for metadata, folder structure by date/hour/camera
- Tiered retention: continuous → motion → alerts (separate day counts)
- Emergency pruning when disk < 1hr remaining
- This is the proven pattern — we adopt it directly
