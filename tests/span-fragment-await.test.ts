import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/telemetry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/telemetry.js")>();
  return {
    ...actual,
    emitSpan: (...args: Parameters<typeof actual.emitSpan>) => {
      actual.emitSpan(...args);
      return new Promise<void>(() => {});
    },
  };
});

import { ArgusRecordingDelegate } from "../src/recording.js";

function mp4Box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

describe("fragment span", () => {
  it("yields the media fragment without awaiting the span or a timer turn", async () => {
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), kill: vi.fn() });
    const delegate = new ArgusRecordingDelegate("Cam", "rtsp://127.0.0.1/main", {
      spawnFn: (() => proc) as unknown as typeof import("node:child_process").spawn,
      verbose: false,
      aspect: "16:9",
    });
    delegate.updateRecordingConfiguration({
      prebufferLength: 4000,
      eventTriggerTypes: [1],
      mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
      videoCodec: {
        type: 0,
        parameters: { profile: 2, level: 2, bitRate: 2000, iFrameInterval: 4000 },
        resolution: [1280, 720, 30],
      },
      audioCodec: { type: 0, bitrate: 64, samplerate: 3, audioChannels: 1 },
    } as never);
    const generator = delegate.handleRecordingStreamRequest(6);
    stdout.write(mp4Box("ftyp", Buffer.from("isom")));
    stdout.write(mp4Box("moov", Buffer.from("moovdata")));
    await generator.next();
    stdout.write(mp4Box("moof", Buffer.from("moof")));
    stdout.write(mp4Box("mdat", Buffer.from("media")));
    let settled = false;
    const pending = generator.next().then((packet) => {
      settled = true;
      return packet;
    });
    for (let step = 0; step < 40; step += 1) await Promise.resolve();
    expect(settled).toBe(true);
    await pending;
    await generator.return(undefined);
  });
});
