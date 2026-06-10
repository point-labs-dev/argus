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
Reolink Cameras (HTTP-FLV primary + RTSP fallback)
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
- [x] Snapshot caching service (go2rtc-backed cache module; not wired to HomeKit yet)
- [ ] Web UI with timeline
- [ ] Two-way audio
- [ ] PTZ controls
- [ ] Docker deployment

## Requirements

- Reolink IP camera(s)
- Apple Home Hub (Apple TV or HomePod) for HKSV
- Node.js 20+
- macOS or Linux

## Development

Install dependencies:

```bash
npm install
```

Print generated `go2rtc.yaml` to stdout from an Argus config:

```bash
npm run dev -- --config ./argus.yaml
```

Write generated `go2rtc.yaml` safely to disk:

```bash
npm run dev -- --config ./argus.yaml --out ./go2rtc.yaml
```

Overwrite an existing generated file intentionally:

```bash
npm run dev -- --config ./argus.yaml --out ./go2rtc.yaml --force
```

Build the ESM TypeScript scaffold:

```bash
npm run build
```

Run the Vitest suite:

```bash
npm test
```

### go2rtc Supervisor

Argus can now own a local `go2rtc` process from code: write the generated config, start `go2rtc`, wait for `GET /api/streams` to become healthy, query health, then shut the child down cleanly.

```ts
import { createGo2RtcSupervisor, loadArgusConfig } from "argus";

const config = await loadArgusConfig("./argus.yaml");
const supervisor = createGo2RtcSupervisor(config, {
  configPath: "./go2rtc.generated.yaml",
  forceConfigOverwrite: true,
});

await supervisor.start();
console.log(await supervisor.health());
await supervisor.stop();
```

By default the supervisor refuses to overwrite an existing generated config unless `forceConfigOverwrite` is set. The process is launched as `config.go2rtc.binary -config <generated-path>` and uses `go2rtc.api_port` for the local health check.

### Snapshot Cache

`SnapshotCache` keeps the latest successful JPEG per camera/profile by fetching go2rtc frames from `http://127.0.0.1:{api_port}/api/frame.jpeg?src={streamName}`. It defaults to the generated sub stream (`slug-sub`) for warm cached snapshots and can refresh main streams (`slug`) when requested.

`createSnapshotHttpServer(cache)` exposes the warm cache over a tiny local Node HTTP server. Once listening on `server.port`, cached snapshots are available at:

```text
GET http://127.0.0.1:{server.port}/cameras/{url-encoded-camera-name}/snapshot.jpg
```

For example, `Front Door` becomes `/cameras/Front%20Door/snapshot.jpg`. The endpoint returns the cached JPEG directly with `Content-Type: image/jpeg`, or `404` when no cached snapshot exists for that camera.

The cache validates JPEG headers before replacing an existing snapshot, so a failed or invalid refresh leaves the last good image in place. The module is currently internal/dev-facing and not yet exposed through HomeKit, HKSV, or recording.

## License

MIT

---

Built by [Point Labs](https://pointlabs.dev)
