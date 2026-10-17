# Camera aspect edits

`cameras[].aspect` is required before the next deploy of the aspect change. Home Manager makes these edits in `argus.yaml` on the Mini. This note does not deploy and does not restart anything.

The values below are the 2026-10-16 read-only `ffprobe -show_streams` key fields from the Mini, with Peter's OK. Credentials stay redacted. The raw file is held by Home Manager. The record is in `docs/camera-health.md`. Doorbell was measured. Backyard Right's 2560x1920 h264 main and 640x480 sub are the D500 on `h264Preview_07` channel 6. The 4512x2512 HEVC main and 896x512 sub belong to Front L and Front R.

```yaml
- name: "Garage Door"
  aspect: "4:3"            # measured main 2560x1920; sub 640x480; AAC-LC 16k
- name: "Backyard"
  aspect: "4:3"            # RLC-520A. measured main 2560x1920; sub 640x480; AAC-LC 16k
- name: "Backyard Right"
  aspect: "4:3"            # D500, NVR h264Preview_07 ch6. measured main 2560x1920 h264 25fps; sub 640x480; AAC-LC 16k
- name: "Doorbell"
  aspect: "4:3"            # Reolink Video Doorbell PoE. measured main 2560x1920 h264 High 20fps; sub 640x480; AAC-LC 16k
- name: "Backyard Left"
  aspect: "16:9"           # measured main 3840x2160 HEVC; sub 640x360; AAC-LC 16k
- name: "Front L"
  aspect: "16:9"           # Preview_03. measured main 4512x2512 HEVC 25fps; sub 896x512; AAC-LC 16k
- name: "Front R"
  aspect: "16:9"           # Preview_04. measured main 4512x2512 HEVC 25fps; sub 896x512; AAC-LC 16k
```

Front L and Front R subs are 896x512. The aspect value follows the main. Front L `mainCodec` in `argus.example.yaml` is `h265` because that main is HEVC.

`argus.example.yaml` sets the same aspects: Backyard Left and Front L are `"16:9"`. The house file still needs every camera in the list above, including Front R and the measured Doorbell line.
