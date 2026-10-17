# Camera aspect edits

`cameras[].aspect` is required before the next deploy of the aspect change. Home Manager makes these edits in `argus.yaml` on the Mini. This note does not deploy and does not restart anything.

The values below are the 2026-10-16 read-only `ffprobe` summary on the Mini (about 8:00 PM ET, Peter's OK). Credentials stay redacted. The record, with date, source, and method, is in `docs/camera-health.md`. That file has a placeholder for the redacted `ffprobe -show_streams` output. Home Manager will supply it. This note does not invent that output. Doorbell did not answer (DHCP). Its `4:3` is inferred and not measured. Backyard Right's frame size is not settled: the summary says 2560x1920 with a 640x480 sub, and `progress/attempt-005.md` plus `LEARNINGS.md` say an NVR add-on with an 896x512 sub and a 12MP HEVC main.

```yaml
- name: "Garage Door"
  aspect: "4:3"            # measured main 2560x1920 h264 High, AAC-LC 16k; sub 640x480
- name: "Backyard"
  aspect: "4:3"            # measured main 2560x1920 ~18.8fps; sub 640x480 15fps
- name: "Backyard Right"
  aspect: "4:3"            # summary only: 2560x1920 / 640x480. attempt-005 and LEARNINGS: NVR add-on, 896x512 sub, 12MP HEVC main. Size not settled.
- name: "Doorbell"
  aspect: "4:3"            # inferred, not measured
- name: "Backyard Left"
  aspect: "16:9"           # measured main 3840x2160 hevc Main (h265Preview); sub 640x360
- name: "Front L"
  aspect: "16:9"           # measured main 4512x2512 hevc Main 25fps; sub 896x512
- name: "Front R"
  aspect: "16:9"           # measured main 4512x2512 hevc Main 25fps; sub 896x512
```

Front L and Front R subs are 896x512 (1.75). The aspect value follows the main, which is about 16:9.

`argus.example.yaml` sets the same aspects: Backyard Left and Front L are `"16:9"`. The house file still needs every camera in the list above, including Front R and the unverified Doorbell line.
