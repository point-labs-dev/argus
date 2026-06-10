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

## 2026-04-25 — Current Best-Practice Refresh

### Reolink Stream Transport
- Keep go2rtc as the stream proxy, but make Reolink HTTP-FLV the default input path.
- Current Frigate Reolink guidance favors HTTP-FLV for many Reolink cameras and NVR channels because RTSP can be inconsistent across models/hardware generations.
- Keep RTSP as a first-class fallback and for cases where two-way audio needs go2rtc-native RTSP handling.
- Generate channel numbers carefully: HTTP-FLV uses zero-based `channel0_*`; RTSP URLs use one-based `Preview_01_*`.

### Implementation Order
- Do not start with HKSV. First prove the stream spine: one camera → go2rtc health → cached snapshots → raw 1-minute MP4 segments → SQLite metadata → `ffprobe` verification.
- HKSV remains the hardest integration point because it requires strict fMP4, IDR alignment, correct HomeKit services, and 4s+ prebuffer. It should sit on top of a stable stream/recording layer, not be the first milestone.

## 2026-06-10 — "Treat docs as legacy" verification pass (laptop run)

Peter asked to re-verify the stack against current practice before building more.
Web research (Frigate/go2rtc community, Scrypted docs, HAP-NodeJS) + a real-hardware
smoke. **The architecture holds; specific implementation details must change.**

### Architecture is still current (mid-2026) — keep it
- go2rtc is still THE universal camera proxy (latest v1.9.14, 2026-01-19; bundled in Frigate). No replacement.
- Frigate STILL has no native HKSV — only live view via go2rtc's HAP server. The HomeKit+NVR+HKSV-in-one gap Argus fills is real and unfilled.
- HAP-NodeJS (koush's HKSV PR #904) remains the only working HKSV implementation. No new alternative.
- Standalone-accessory-per-camera is still the community-recommended performance pattern (Scrypted "Accessory Mode"). Keep it.
- Incumbent to beat = Scrypted (Reolink plugin + HKSV plugin, now $19 one-time). Argus's reason to exist (bus-factor-1, closed-source NVR) is unchanged.

### Implementation details that must change (legacy code is wrong/dated)
All four verified on a real RLC-812A (4K H.265 main / H.264 sub) on 2026-06-10.

- **H.265 main belongs on RTSP, not HTTP-FLV — per-model.** The bare FLV main URL
  Argus generates hangs/goes audio-only on this 4K H.265 camera (the go2rtc #1938
  symptom). The community "fix" — an `ffmpeg:`-prefixed FLV source
  (`ffmpeg:http://...channel0_main.bcs...#video=copy#audio=copy#audio=opus`) — **also
  failed here** (timed out). What worked cleanly was **RTSP `h265Preview_01_main`**
  (HEVC 3840×2160 + AAC). Matches reports that some Reolink models don't do H.265
  over HTTP at all. So: `ffmpeg:`-FLV is the right *default* recipe, but the builder
  must fall through to RTSP for H.265-main models. Don't hardcode FLV-primary for main.
- **Sub stream is fine over bare HTTP-FLV.** `channel0_ext.bcs` → H.264 896×512 +
  AAC, no `ffmpeg:` prefix needed. Keep FLV-primary for sub (snapshots/prebuffer).
- **RTSP path style is per-device, not one format.** NVR channels use bare
  `Preview_0N_main`; **standalone cameras use codec-prefixed `h264Preview_0N_sub` /
  `h265Preview_0N_main`** (bare form 404s on the RLC-812A). The URL builder needs a
  per-source style (or probe both), exactly the model/firmware quirk table
  PROJECT.md anticipated. Argus currently emits only the bare NVR form.
- **Reserve RTSP for two-way audio too** — must be a native source (NOT
  `ffmpeg:`-prefixed) so go2rtc handles the backchannel.
- H.265 main confirmed in the wild (RLC-812A = HEVC 3840×2160) → the H.265→H.264
  transcode-for-HomeKit path is mandatory, not optional.

**Net:** keep the architecture; rework `go2rtc.ts` URL generation into a
per-device/per-codec strategy (FLV-sub always; main = `ffmpeg:`-FLV then RTSP
fallback; RTSP path style by device class) instead of today's one-size bare-URL output.
