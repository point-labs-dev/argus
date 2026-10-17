import type { PrepareStreamResponse } from "hap-nodejs";

interface PrepareAnswerLeg {
  port: number;
  ssrc: number;
  srtp_key: Buffer;
  srtp_salt: Buffer;
}

export type PrepareAnswerInput =
  | { includeAudio: true; video: PrepareAnswerLeg; audio: PrepareAnswerLeg }
  | { includeAudio: false; video: PrepareAnswerLeg };

export function prepareAnswer(input: PrepareAnswerInput): PrepareStreamResponse {
  const video = {
    port: input.video.port,
    ssrc: input.video.ssrc,
    srtp_key: input.video.srtp_key,
    srtp_salt: input.video.srtp_salt,
  };
  if (!input.includeAudio) {
    return { video };
  }
  return {
    video,
    audio: {
      port: input.audio.port,
      ssrc: input.audio.ssrc,
      srtp_key: input.audio.srtp_key,
      srtp_salt: input.audio.srtp_salt,
    },
  };
}
