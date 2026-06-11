import { describe, expect, it } from "vitest";

import { parseArgusConfig } from "../src/config.js";
import {
  buildHttpFlvUrl,
  buildRtspUrl,
  buildTransportSources,
  generateGo2RtcConfig,
} from "../src/go2rtc.js";

function createCameraConfig(
  transport: "auto" | "http-flv" | "rtsp" = "auto",
  channel = 0,
  mainCodec: "h264" | "h265" = "h264",
) {
  return parseArgusConfig({
    cameras: [
      {
        name: "Front Door",
        host: "192.168.1.100",
        channel,
        mainCodec,
        username: "user+name@example.com",
        password: "pa:ss/wo?rd&1",
        transport,
        streams: {
          main: "main",
          sub: "sub",
        },
      },
    ],
    recording: {
      path: "./recordings",
      retention: {
        continuous: 3,
        motion: 7,
        alerts: 30,
      },
    },
    homekit: {
      pin: "123-45-678",
    },
    go2rtc: {
      binary: "./go2rtc",
      api_port: 1984,
    },
    server: {
      port: 8080,
    },
  });
}

describe("go2rtc generation", () => {
  it("uses zero-based HTTP-FLV channels and one-based, codec-prefixed RTSP preview channels", () => {
    const config = createCameraConfig("auto", 7);
    const camera = config.cameras[0]!;

    expect(buildHttpFlvUrl(camera, "main")).toContain("channel7_main.bcs");
    expect(buildHttpFlvUrl(camera, "sub")).toContain("channel7_ext.bcs");
    // RTSP paths are codec-prefixed (bare Preview_0N 404s on newer Reolink models);
    // sub is always H.264, main follows mainCodec (default h264 here).
    expect(buildRtspUrl(camera, "main")).toContain("/h264Preview_08_main");
    expect(buildRtspUrl(camera, "sub")).toContain("/h264Preview_08_sub");
  });

  it("prefixes the RTSP main path with the camera mainCodec and serves H.265 mains over RTSP only", () => {
    const camera = createCameraConfig("auto", 0, "h265").cameras[0]!;

    expect(buildRtspUrl(camera, "main")).toContain("/h265Preview_01_main");
    // Sub stays H.264 even on an H.265-main camera.
    expect(buildRtspUrl(camera, "sub")).toContain("/h264Preview_01_sub");
    // H.265 main can't use HTTP-FLV — auto mode must yield RTSP only.
    expect(buildTransportSources(camera, "main")).toEqual([buildRtspUrl(camera, "main")]);
    // The sub stream still leads with HTTP-FLV.
    expect(buildTransportSources(camera, "sub")).toEqual([
      buildHttpFlvUrl(camera, "sub"),
      buildRtspUrl(camera, "sub"),
    ]);
  });

  it("URL-encodes credentials in both transport URL formats", () => {
    const config = createCameraConfig();
    const camera = config.cameras[0]!;

    const httpFlvUrl = buildHttpFlvUrl(camera, "main");
    const rtspUrl = buildRtspUrl(camera, "main");

    expect(httpFlvUrl).toContain("user=user%2Bname%40example.com");
    expect(httpFlvUrl).toContain("password=pa%3Ass%2Fwo%3Frd%261");
    expect(rtspUrl).toContain("rtsp://user%2Bname%40example.com:pa%3Ass%2Fwo%3Frd%261@");
  });

  it("keeps HTTP-FLV first in auto mode and filters sources per transport", () => {
    const autoCamera = createCameraConfig("auto").cameras[0]!;
    const httpOnlyCamera = createCameraConfig("http-flv").cameras[0]!;
    const rtspOnlyCamera = createCameraConfig("rtsp").cameras[0]!;

    expect(buildTransportSources(autoCamera, "main")).toEqual([
      buildHttpFlvUrl(autoCamera, "main"),
      buildRtspUrl(autoCamera, "main"),
    ]);
    expect(buildTransportSources(httpOnlyCamera, "main")).toEqual([
      buildHttpFlvUrl(httpOnlyCamera, "main"),
    ]);
    expect(buildTransportSources(rtspOnlyCamera, "main")).toEqual([
      buildRtspUrl(rtspOnlyCamera, "main"),
    ]);
  });

  it("generates main and sub stream names for go2rtc", () => {
    const config = createCameraConfig();
    const go2rtcConfig = generateGo2RtcConfig(config);

    expect(go2rtcConfig.api.listen).toBe("127.0.0.1:1984");
    expect(go2rtcConfig.streams["front-door"]).toBeDefined();
    expect(go2rtcConfig.streams["front-door-sub"]).toBeDefined();
  });

  it("preloads every sub stream (warm producers for fast live starts) but not mains", () => {
    const config = createCameraConfig();
    const go2rtcConfig = generateGo2RtcConfig(config);

    expect(Object.keys(go2rtcConfig.preload)).toEqual(["front-door-sub"]);
    expect(go2rtcConfig.preload["front-door-sub"]).toBe("");
  });
});
