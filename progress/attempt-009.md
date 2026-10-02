# Attempt 009 — Garage Door "offline/online" flapping is a HOST NETWORK issue, not Argus (2026-06-21)

Peter reported frequent Home-app notifications: Garage Door going offline then
online, repeatedly. Diagnosed to the dev MacBook's WiFi link, NOT Argus code and
NOT the attempt-008 AAC-ELD change. Adds an `ARGUS_HAP_BIND` mitigation.

## Evidence (ruled causes in/out)

- **Daemon is stable** — pid up 1d14h, `runs=1`, never exited, 1.4% CPU. So the
  flapping is HAP-accessory reachability, not the process restarting.
- **Snapshots fine** (0 failures); **AAC-ELD audio not erroring** (sessions
  negotiate `AAC-eld 16kHz`, no libfdk/ELD errors) and **live sessions are rare**
  (~5 on 06-20) — so AAC-ELD is NOT the "happens a lot" flapping.
- **Root cause = WiFi latency jitter on the host.** Route to both the hub
  (10.0.0.15) and cameras is via **en0 (WiFi)**. Signal is excellent (-39 dBm,
  5GHz, 802.11ax) but latency is wildly unstable: 20-ping to the hub = **0% loss,
  min 4 / avg 18 / max 83 / stddev 23 ms** (LAN should be <2ms flat). Those ~80ms
  spikes (classic laptop WiFi power-save buffering) intermittently exceed
  HomeKit's hub→accessory reachability window → "No Response" → recover.
- **Same jitter explains the fleet-wide motion-poll ECONNRESET storm** (3222 hits,
  spread EVENLY across all 7 cameras — Garage Door not over-represented). The Mac
  intermittently can't reach the cameras either. Only Garage Door is *visible*
  because it's the only paired camera (the other 6 were unpaired during debugging).
- **Aggravators:** a dead `en4` ("Ethernet Adapter") stuck on self-assigned
  `169.254.6.169` (failed DHCP, no network-service entry) — HAP/mDNS binds ALL
  interfaces by default, so the accessory may be advertised on that unreachable
  address too. Plus VPN tunnels `utun0`/`utun1` (the ipsec interfaces the goal
  prompt already flagged for self-route trouble).

## Fixes

1. **Durable: wire the MacBook to Ethernet, or deploy to the always-on Mini
   (goal-prompt item 5).** Wired kills the WiFi jitter and the flapping. Only Peter
   can do the physical part.
2. **`ARGUS_HAP_BIND` (NEW, this attempt):** restricts HAP/mDNS advertisement to
   given interface(s)/IP(s), comma-separated (HAP-NodeJS `publish({bind})` accepts
   interface names like `en0`). Unset = all interfaces (prior behavior). Set
   `ARGUS_HAP_BIND=en0` so the accessory is never advertised on en4/169.254 or the
   VPN tunnels. Wired into `serve.ts` + installer forward-list. Build + 56 tests green.
3. **Disable the dead en4:** `sudo ifconfig en4 down` (needs sudo; not persistent
   across reboot — the en0 bind is the durable equivalent). Belt-and-suspenders
   once #2 is active.

## Important caveat for attempt-008

**Do NOT run the AAC-ELD on-device test until the link is stable.** Over a flapping
WiFi link a live view can hang for network reasons that look identical to the
codec problem — the test would be inconclusive. Stabilize the network (wired or
ARGUS_HAP_BIND=en0 + en4 down) first, THEN test AAC-ELD on Garage Door.

## To activate the bind

`ARGUS_HUB_ADDRESSES=10.0.0.15 ARGUS_LIVE_LADDER=compat ARGUS_FFMPEG=~/.local/bin/ffmpeg-homebridge ARGUS_LIVE_AAC_ELD=1 ARGUS_HAP_BIND=en0 bash scripts/install-launchd.sh`
(re-run with the transient `5: Input/output error` recovery if it appears).
