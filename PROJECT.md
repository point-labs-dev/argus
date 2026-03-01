# Argus — Open-Source Camera Platform

> HomeKit + Local NVR for Reolink cameras. A focused Scrypted alternative by Point Labs.

## Vision

A reliable, open-source camera platform that does three things well:
1. **HomeKit integration** — Live streaming + HKSV recording in Apple Home
2. **Local NVR** — Continuous recording with timeline playback and retention policies
3. **Reolink-native** — Deep support for one camera brand instead of shallow support for hundreds

## Why This Exists

- **Scrypted** is a one-person project (bus factor of 1), NVR plugin is closed-source ($50/yr), and reliability issues stem from trying to support every camera brand
- **Frigate** is excellent but doesn't do HomeKit
- **Homebridge camera plugins** are unreliable for HKSV — snapshot blocking, FFmpeg crashes, no prebuffering
- No existing solution combines HomeKit + local NVR + deep Reolink support in one package

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Reolink Cameras                    │
│              (RTSP + Reolink HTTP API)               │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              go2rtc (Go binary)                       │
│  • Single RTSP connection per camera                  │
│  • Rebroadcast to N consumers                         │
│  • WebRTC for browser live view                       │
│  • Protocol conversion (RTSP→WebRTC, HLS, MP4)       │
│  • Zero-copy passthrough when codecs match            │
└──────────┬───────────┬───────────┬──────────────────┘
           │           │           │
    ┌──────▼──┐  ┌─────▼─────┐  ┌─▼────────────────┐
    │ HomeKit │  │ NVR       │  │ Web UI            │
    │ Bridge  │  │ Recorder  │  │ (live + timeline) │
    └─────────┘  └───────────┘  └───────────────────┘
```

### Component Breakdown

**go2rtc** (external Go binary)
- Stream proxy — one connection to camera, unlimited consumers
- Prebuffer for instant stream startup
- WebRTC server for browser live view
- H.265→H.264 transcoding when needed (via FFmpeg)
- Battle-tested (used by Frigate, Home Assistant, thousands of deployments)

**Argus Core** (TypeScript + Effect.ts)
- **Camera Manager** — Discovery, lifecycle, health monitoring, reconnection (Effect Fibers + retry/backoff)
- **HomeKit Bridge** — HAP-NodeJS for pairing, SRTP streaming, HKSV recording delivery. Each camera as standalone accessory (not bridged) to avoid request serialization bottleneck.
- **HKSV Pipeline** — Motion event → prebuffer capture → fragmented MP4 generation → HomeKit Data Stream delivery. Strict conformance: H.264 Main profile, AAC 48kHz, IDR-aligned fragments.
- **NVR Recorder** — Segment writer (raw stream → MP4 files, no re-encoding). SQLite for metadata/timeline. Tiered retention: continuous → motion → alerts.
- **Reolink Client** — HTTP API for camera-specific features: AI detection events (person/vehicle/pet), siren, spotlight, PTZ, two-way audio, firmware info, capability probing.
- **Snapshot Cache** — Periodically grab frames from prebuffer, serve instantly on HomeKit/web requests. Critical for Home app responsiveness.
- **Config & API** — YAML config, REST API, web dashboard.

### Why This Stack

| Choice | Rationale |
|---|---|
| **go2rtc** | Industry-standard stream proxy. Replaces Scrypted's 1500-line prebuffer plugin with a single binary. Already handles RTSP, WebRTC, HLS, codec negotiation. |
| **TypeScript** | HAP-NodeJS (only mature HKSV implementation) is Node.js. Staying in one language for everything above the stream layer. |
| **Effect.ts** | Typed errors for dozens of failure modes. Structured concurrency for camera lifecycle management. Resource safety (Scope) for stream cleanup. Retry/backoff/circuit breaker primitives. "Rust-like reliability in TypeScript." |
| **HAP-NodeJS** | Only library with working HomeKit camera streaming + HKSV. 10+ years of battle-testing via Homebridge ecosystem. |
| **SQLite** | Recording metadata, timeline queries, camera state. Same choice as Frigate and Moonfire NVR. |
| **YAML config** | Convention in the NVR space (Frigate, go2rtc). Familiar to target users. |

### What We Learned from Scrypted

**Patterns we're keeping:**
- Single upstream connection with multi-consumer rebroadcast (via go2rtc)
- Direct RTP forwarding when codecs match (go2rtc does this natively)
- Stream profile routing (4K local, 720p remote, recording, analysis)
- Prebuffer for instant stream startup

**Patterns we're simplifying:**
- No plugin system (Reolink-only, no need for extensibility overhead)
- No RPC proxy layer (single process, not multi-process isolation)
- No Dijkstra converter graph (direct conversion functions)
- No mixin system (simple middleware pipeline)

**Gaps we're filling:**
- Open-source NVR recording (Scrypted's is closed-source)
- Proper disk management with tiered retention
- Snapshot caching (Scrypted's bridge mode blocks on slow snapshots)
- Standalone accessory mode by default (avoids bridge serialization)

### What We Learned from Frigate

**Patterns we're adopting:**
- Segment-based recording: raw stream → MP4 files, no re-encoding
- Folder structure: `YYYY-MM-DD/HH/camera-name/MM.SS.mp4` (UTC)
- SQLite for recording metadata and timeline queries
- Tiered retention: continuous (days) → motion (days) → alerts/detections (days)
- Emergency pruning when disk space < threshold
- go2rtc as the stream proxy layer

**What we're adding that Frigate doesn't have:**
- HomeKit integration (live streaming + HKSV)
- Deep Reolink API integration (vs generic ONVIF/RTSP)

## Constraints

- **Reolink cameras only** for v1. Not ONVIF-generic, not "any RTSP camera." Deep integration > broad compatibility.
- **macOS + Linux** target platforms (Mac mini, Raspberry Pi, NAS, Docker)
- **Apple Home Hub required** for HKSV (Apple TV or HomePod on same subnet)
- **mDNS required** — HomeKit discovery relies on it. No VLAN isolation between Argus and Home Hub without mDNS reflector.
- **H.264 required for HomeKit** — Cameras should be configured for H.264 main stream, or go2rtc transcodes H.265→H.264.
- **No cloud dependency** — Everything runs locally. No accounts, no subscriptions, no phone-home.

## HKSV Specification (from reverse-engineering)

Based on the [unofficial HKSV spec](https://github.com/Supereg/secure-video-specification):

| Requirement | Value |
|---|---|
| Container | Fragmented MP4 |
| Video codec | H.264 (H.265 possibly supported) |
| Audio codec | AAC-LC or AAC-ELD |
| Mandatory resolutions | 1280×720, 1920×1080 |
| Mandatory frame rates | 15fps, one of 24/30fps |
| Prebuffer minimum | 4000ms (typical: 4000-8000ms) |
| Fragment alignment | Every fragment MUST begin with a keyframe (IDR) |
| Trigger types | Motion (0x01), Doorbell (0x02) |
| Transport | HomeKit Data Stream (not regular SRTP) |
| Required services | CameraEventRecordingManagement, MotionSensor, DataStreamManagement, CameraOperatingMode |
| States | Off, Detect Activity, Stream, Stream & Allow Recording |
| On-device analysis | Person/car/package detection done by Apple Home Hub — NOT by us |

## Reolink Camera Capabilities

Features to integrate via Reolink HTTP API + RTSP:

| Feature | API | HomeKit Mapping |
|---|---|---|
| Live streaming | RTSP (via go2rtc) | Camera RTP stream |
| Motion detection | Reolink API events | MotionSensor service |
| Person/vehicle/pet detection | Reolink AI events | HKSV event classification |
| Two-way audio | RTSP + Reolink audio API | HomeKit audio backchannel |
| Siren | Reolink HTTP API | Switch service |
| Spotlight | Reolink HTTP API | Lightbulb service |
| PTZ | Reolink HTTP API | Web UI only (no HomeKit PTZ) |
| Night vision | Reolink HTTP API | CameraOperatingMode.NightVision |
| Snapshots | Reolink HTTP API | Cached, served on demand |
| Firmware info | Reolink HTTP API | AccessoryInformation |
| SD card status | Reolink HTTP API | Health monitoring |

## Feature Roadmap

### MVP (v0.1)
Ship the core loop: cameras appear in Apple Home, streams work, HKSV records, local NVR saves footage.

- [ ] go2rtc integration (stream proxy + WebRTC)
- [ ] Reolink camera discovery and configuration
- [ ] HomeKit live streaming (SRTP via HAP-NodeJS)
- [ ] HKSV recording pipeline (motion → fMP4 → HomeKit Data Stream)
- [ ] Standalone accessory mode (one HAP instance per camera)
- [ ] Snapshot caching (warm frames from prebuffer)
- [ ] Motion event forwarding (Reolink → HomeKit MotionSensor)
- [ ] Local NVR recording (segment writer, no re-encoding)
- [ ] SQLite metadata + timeline
- [ ] Tiered retention (continuous/motion/alerts)
- [ ] Disk space monitoring + emergency pruning
- [ ] H.265→H.264 transcoding config (via go2rtc)
- [ ] Graceful reconnection + startup recovery
- [ ] YAML configuration
- [ ] CLI for setup and management

### v0.2
Reolink-native features + better UX.

- [ ] Two-way audio (HomeKit ↔ Reolink)
- [ ] Person/vehicle/pet event types (Reolink AI → HKSV)
- [ ] Web UI — live view (go2rtc WebRTC) + recording timeline
- [ ] PTZ controls in web UI
- [ ] Siren as HomeKit Switch
- [ ] Spotlight as HomeKit Lightbulb
- [ ] Doorbell support (Reolink PoE doorbell → HomeKit Doorbell service)
- [ ] Docker image (go2rtc + Argus in one container)
- [ ] Storage estimation tool

### v1.0
Production-ready with polish.

- [ ] Clip export (select time range → download MP4)
- [ ] Multi-camera choreography (PTZ follows detection from other cameras)
- [ ] Rich notifications (snapshot in push notification)
- [ ] Health dashboard (camera status, disk usage, stream stats)
- [ ] Backup/restore configuration
- [ ] Auto-update mechanism

### Future
- [ ] Additional camera brands (one at a time, deeply integrated)
- [ ] Home Assistant integration
- [ ] Google Home / Alexa support (via go2rtc)
- [ ] Object detection (local, via Coral TPU or CPU — not needed for MVP since Apple Home Hub does HKSV analysis)

## Project Structure

```
argus/
├── PROJECT.md              # This file
├── SPEC.md                 # Detailed MVP specification
├── LEARNINGS.md            # Iteration insights
├── package.json
├── tsconfig.json
├── go2rtc.yaml             # go2rtc configuration template
├── src/
│   ├── index.ts            # Entry point
│   ├── config/             # YAML config loading, validation
│   ├── camera/             # Camera manager, Reolink client
│   ├── homekit/            # HAP-NodeJS integration, HKSV pipeline
│   ├── recorder/           # NVR segment writer, retention engine
│   ├── snapshot/           # Snapshot cache
│   ├── stream/             # go2rtc client, stream management
│   ├── api/                # REST API + web server
│   └── lib/                # Effect layers, shared utilities
├── web/                    # Web UI (v0.2)
├── docker/                 # Dockerfile + compose
└── docs/                   # User documentation
```

## Key Design Decisions

1. **Standalone accessories over bridge mode** — HomeKit bridges serialize all requests. One slow camera blocks everything. Each camera gets its own HAP instance with its own mDNS advertisement and TCP port.

2. **go2rtc as external process** — Don't reinvent stream proxying. go2rtc is maintained, tested, and handles edge cases we'd spend months discovering. We manage it as a child process with health monitoring.

3. **Effect.ts for reliability** — Camera systems have dozens of concurrent failure modes. Effect gives us typed errors, structured concurrency (Fibers for camera lifecycles), resource safety (Scope for stream cleanup), and built-in retry/backoff. The "Rust-like reliability in TypeScript" argument is real for this use case.

4. **No re-encoding for NVR** — Record raw camera streams directly. H.264/H.265 as-is from the camera. Saves CPU, preserves quality. Only transcode for HomeKit if camera outputs H.265.

5. **Reolink-only scope** — Deep integration with one brand beats shallow integration with many. We can handle firmware quirks, model-specific capabilities, and API edge cases properly. Expand to other brands one at a time in the future.

6. **Snapshot caching** — The #1 UX improvement over Homebridge camera plugins. Warm snapshots served instantly instead of spawning FFmpeg on every Home app request.

7. **HKSV over local analysis** — Apple Home Hub (Apple TV/HomePod) does person/vehicle/package detection on-device. We don't need to run ML models. We just need to deliver clean fMP4 fragments with correct IDR alignment.

## References

- [Scrypted source analysis](../copy-scrypted/CLAUDE-ANALYSIS.md) — Deep dive into architecture, rebroadcast, HKSV, plugins
- [HKSV unofficial spec](https://github.com/Supereg/secure-video-specification) — Reverse-engineered protocol documentation
- [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) — HomeKit Accessory Protocol for Node.js
- [go2rtc](https://github.com/AlexxIT/go2rtc) — Stream proxy (RTSP, WebRTC, HLS)
- [Frigate](https://docs.frigate.video/) — NVR recording patterns, retention model
- [Moonfire NVR](https://github.com/scottlamb/moonfire-nvr) — Rust NVR, hybrid storage design
- [Reolink API](https://community.reolink.com/topic/4196/) — Camera HTTP API documentation
- [Apple HomeKit ADK](https://github.com/apple/HomeKitADK) — Official HAP reference (no HKSV)
- [Effect.ts](https://effect.website/) — TypeScript effect system

---

*Point Labs — pointlabs.dev*
