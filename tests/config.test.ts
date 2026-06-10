import { describe, expect, it } from "vitest";

import { ConfigError, parseArgusConfig } from "../src/config.js";

function createValidConfig() {
  return {
    cameras: [
      {
        name: "Front Door",
        host: "192.168.1.100",
        channel: 0,
        username: "admin",
        password: "secret",
        transport: "auto",
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
  };
}

describe("parseArgusConfig", () => {
  it("accepts a valid SPEC-shaped config", () => {
    const config = parseArgusConfig(createValidConfig());

    expect(config.go2rtc.api_port).toBe(1984);
    expect(config.cameras[0]?.transport).toBe("auto");
  });

  it("rejects a negative zero-based camera channel", () => {
    const invalidConfig = createValidConfig();
    invalidConfig.cameras[0]!.channel = -1;

    expect(() => parseArgusConfig(invalidConfig)).toThrowError(ConfigError);
    expect(() => parseArgusConfig(invalidConfig)).toThrow(/channel must be zero or greater/i);
  });

  it("rejects a missing required SPEC field", () => {
    const invalidConfig = createValidConfig();
    delete (invalidConfig as { homekit?: unknown }).homekit;

    expect(() => parseArgusConfig(invalidConfig)).toThrowError(ConfigError);
    expect(() => parseArgusConfig(invalidConfig)).toThrow(/homekit/i);
  });
});
