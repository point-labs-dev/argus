# Argus

Open-source camera platform for Reolink cameras with HomeKit integration and local NVR recording.

> ⚠️ **Early Development** — Not yet functional. See [PROJECT.md](PROJECT.md) for the full design.

## What Is This?

Argus brings your Reolink cameras into Apple HomeKit with reliable live streaming, HomeKit Secure Video (HKSV) recording, and a local NVR — all running on your own hardware with zero cloud dependency.

## Why?

- **Scrypted** works but is a one-person project with a closed-source NVR plugin
- **Frigate** is great for NVR but doesn't do HomeKit
- **Homebridge camera plugins** are unreliable for HKSV

Argus combines the best of all three: HomeKit + local NVR + deep Reolink support.

## Architecture

```
Reolink Cameras (RTSP)
        │
        ▼
   go2rtc (stream proxy)
        │
   ┌────┼────────────┐
   ▼    ▼            ▼
HomeKit  NVR       Web UI
(HKSV)  Recorder  (timeline)
```

- **go2rtc** — Battle-tested stream proxy (one camera connection, unlimited consumers)
- **Argus Core** — TypeScript + Effect.ts for HomeKit, recording, and camera management
- **HAP-NodeJS** — HomeKit Accessory Protocol with HKSV support

## Features (Planned)

- [x] Project design & architecture
- [ ] HomeKit live streaming
- [ ] HomeKit Secure Video recording
- [ ] Local NVR with tiered retention
- [ ] Reolink camera discovery
- [ ] Motion/person/vehicle detection forwarding
- [ ] Snapshot caching
- [ ] Web UI with timeline
- [ ] Two-way audio
- [ ] PTZ controls
- [ ] Docker deployment

## Requirements

- Reolink IP camera(s)
- Apple Home Hub (Apple TV or HomePod) for HKSV
- Node.js 20+
- macOS or Linux

## License

MIT

---

Built by [Point Labs](https://pointlabs.dev)
