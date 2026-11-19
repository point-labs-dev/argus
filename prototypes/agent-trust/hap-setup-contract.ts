// Prototype. Not the change to merge.
import { readFileSync } from "node:fs";

import type { PrepareStreamRequest, PrepareStreamResponse } from "hap-nodejs";

import { parseArgusConfig } from "../../src/config.js";
import {
  ArgusStreamingDelegate,
  buildLiveFfmpegArgs,
  getHapBindAddress,
  type LiveFfmpegInput,
} from "../../src/homekit.js";
import { SessionStateMachine } from "../../src/homekit/session-state-machine.js";
import { SnapshotCache } from "../../src/snapshot-cache.js";

const videoKey = Buffer.alloc(16, 0x11);
const videoSalt = Buffer.alloc(14, 0x22);
const audioKey = Buffer.alloc(16, 0x33);
const audioSalt = Buffer.alloc(14, 0x44);

function cache(): SnapshotCache {
  const config = parseArgusConfig({
    cameras: [
      {
        name: "Garage Door",
        host: "10.0.0.7",
        channel: 0,
        mainCodec: "h264",
        username: "admin",
        password: "x",
        transport: "auto",
        streams: { main: "main", sub: "sub" },
      },
    ],
    recording: { path: "./rec", retention: { continuous: 3, motion: 7, alerts: 30 } },
    homekit: { pin: "123-45-678" },
    go2rtc: { binary: "./go2rtc", api_port: 1984 },
    server: { port: 8080 },
  });
  const jpeg = Buffer.from([0xff, 0xd8]);
  const fetchFn = (async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength),
  })) as unknown as typeof fetch;
  return new SnapshotCache(config, { fetch: fetchFn });
}

function request(): PrepareStreamRequest {
  return {
    sessionID: "prototype-session",
    sourceAddress: "10.0.0.8",
    targetAddress: "10.0.0.41",
    addressVersion: "ipv4",
    video: {
      port: 50000,
      srtpCryptoSuite: 0,
      srtp_key: videoKey,
      srtp_salt: videoSalt,
    },
    audio: {
      port: 50002,
      srtpCryptoSuite: 0,
      srtp_key: audioKey,
      srtp_salt: audioSalt,
    },
  } as PrepareStreamRequest;
}

async function prepare(includeAudio: boolean): Promise<{ calls: number; response?: PrepareStreamResponse; error?: Error }> {
  const delegate = new ArgusStreamingDelegate(
    "Garage Door",
    "rtsp://127.0.0.1:8554/garage-door-sub",
    cache(),
    { includeAudio, verbose: false },
  );
  let calls = 0;
  let response: PrepareStreamResponse | undefined;
  let error: Error | undefined;
  await new Promise<void>((resolve) => {
    delegate.prepareStream(request(), (err, res) => {
      calls += 1;
      error = err;
      response = res;
      resolve();
    });
  });
  return { calls, response, error };
}

function filterFor(cropToFill: boolean): string {
  const input: LiveFfmpegInput = {
    inputUrl: "rtsp://127.0.0.1:8554/garage-door",
    targetAddress: "10.0.0.41",
    videoMode: "transcode",
    cropToFill,
    video: {
      port: 50000,
      localRtcpPort: 60000,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: 2000,
      fps: 30,
      width: 1280,
      height: 720,
      mtu: 1378,
      profile: "baseline",
      level: "4.0",
      srtpParams: "VIDEOKEY==",
    },
    audio: {
      port: 50002,
      localRtcpPort: 60002,
      ssrc: 2,
      payloadType: 110,
      codec: "AAC-eld",
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: "AUDIOKEY==",
    },
  };
  const args = buildLiveFfmpegArgs(input, true);
  return args[args.indexOf("-vf") + 1] ?? "";
}

function doubleCallbackTestCalls(): number {
  const source = readFileSync(new URL("../../tests/homekit.test.ts", import.meta.url), "utf8");
  const start = source.indexOf('it("prevents double-callback crash');
  const end = source.indexOf('it("guarantees prepareStream callback fires on success path"');
  const body = source.slice(start, end);
  return body.split("delegate.prepareStream").length - 1;
}

function bindResult(value: string | undefined): string {
  const previous = process.env.ARGUS_HAP_BIND;
  if (value === undefined) delete process.env.ARGUS_HAP_BIND;
  else process.env.ARGUS_HAP_BIND = value;
  const found = getHapBindAddress();
  if (previous === undefined) delete process.env.ARGUS_HAP_BIND;
  else process.env.ARGUS_HAP_BIND = previous;
  return found ?? "undefined";
}

const machine = new SessionStateMachine("prototype-session");
machine.prepare({
  targetAddress: "10.0.0.41",
  video: { port: 1, localRtcpPort: 2, ssrc: 3, srtpParams: "v" },
  audio: { port: 4, localRtcpPort: 5, ssrc: 6, srtpParams: "a" },
});
const firstAnswer = machine.answerPrepareCallback();
const secondAnswer = machine.answerPrepareCallback();

const withAudio = await prepare(true);
const withoutAudio = await prepare(false);
const audioOffArgs = buildLiveFfmpegArgs(
  {
    inputUrl: "rtsp://127.0.0.1:8554/garage-door",
    targetAddress: "10.0.0.41",
    videoMode: "transcode",
    video: {
      port: 50000,
      localRtcpPort: 60000,
      ssrc: 1,
      payloadType: 99,
      maxBitrateKbps: 2000,
      fps: 30,
      width: 640,
      height: 480,
      mtu: 1378,
      profile: "baseline",
      level: "3.1",
      srtpParams: "VIDEOKEY==",
    },
    audio: {
      port: 50002,
      localRtcpPort: 60002,
      ssrc: 2,
      payloadType: 110,
      codec: "AAC-eld",
      sampleRateKhz: 24,
      maxBitrateKbps: 24,
      srtpParams: "AUDIOKEY==",
    },
  },
  false,
);
const echoed =
  withAudio.response?.video.srtp_key.equals(videoKey) === true &&
  withAudio.response.video.srtp_salt.equals(videoSalt) &&
  withAudio.response.audio?.srtp_key.equals(audioKey) === true &&
  withAudio.response.audio.srtp_salt.equals(audioSalt);

const report = {
  prototype: true,
  audio_on_callback_calls: withAudio.calls,
  audio_on_error: withAudio.error?.message ?? null,
  audio_on_key_echo: echoed,
  audio_on_has_audio: withAudio.response?.audio !== undefined,
  audio_off_callback_calls: withoutAudio.calls,
  audio_off_has_audio: withoutAudio.response?.audio !== undefined,
  audio_off_ffmpeg_has_audio_codec: audioOffArgs.includes("-c:a"),
  state_machine_first_answer: firstAnswer,
  state_machine_second_answer: secondAnswer,
  double_callback_test_prepare_calls: doubleCallbackTestCalls(),
  filter_crop: filterFor(true),
  filter_default_pad: filterFor(false),
  bind_not_an_iface: bindResult("not-an-iface"),
  bind_dotted: bindResult("10.0.0.46"),
};

console.log(JSON.stringify(report, null, 2));
