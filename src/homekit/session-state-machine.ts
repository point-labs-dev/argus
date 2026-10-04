import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:dgram";
import type { LiveFfmpegInput } from "../homekit.js";

/**
 * Session lifecycle states (explicit FSM for agent legibility).
 * 
 * Transitions:
 * - PREPARING → PREPARED (prepareStream allocates ports/SRTP params)
 * - PREPARED → STREAMING (startStream spawns FFmpeg)
 * - STREAMING → STREAMING (reconfigureStream respawns FFmpeg)
 * - * → STOPPED (stopStream or error cleanup)
 */
export type SessionState =
  | { tag: "PREPARING"; sessionID: string }
  | { tag: "PREPARED"; prepared: PreparedData; callback_answered: boolean }
  | { tag: "STREAMING"; streaming: StreamingData }
  | { tag: "STOPPED" };

export interface PreparedData {
  targetAddress: string;
  video: {
    port: number;
    localRtcpPort: number;
    ssrc: number;
    srtpParams: string;
  };
  audio: {
    port: number;
    localRtcpPort: number;
    ssrc: number;
    srtpParams: string;
  };
}

export interface StreamingData {
  ffmpeg: ChildProcess;
  liveInput: LiveFfmpegInput;
  videoReturnSocket?: Socket;
  audioReturnSocket?: Socket;
}

/**
 * Session state machine enforces lifecycle transitions and prevents double-callback.
 * 
 * Purpose: Make callback guard + cleanup explicit (visible to agents editing session logic).
 * What it prevents (from 1.3.7-1.3.10 convergence):
 * - Double-callback crash (prepareStream called twice → process exit 1)
 * - Resource leaks (ffmpeg/sockets not closed on error paths)
 * - Invalid transitions (can't start() unless PREPARED)
 */
export class SessionStateMachine extends EventEmitter {
  private state: SessionState;

  public constructor(sessionID: string) {
    super();
    this.state = { tag: "PREPARING", sessionID };
    this.emit("transition", this.state);
  }

  public getState(): SessionState {
    return this.state;
  }

  public getSessionID(): string {
    switch (this.state.tag) {
      case "PREPARING":
        return this.state.sessionID;
      case "PREPARED":
      case "STREAMING":
      case "STOPPED":
        // Session ID preserved across transitions but not stored separately after PREPARING
        throw new Error("Session ID only available in PREPARING state");
    }
  }

  /**
   * Transition PREPARING → PREPARED.
   * Returns true if transition succeeded, false if already PREPARED/STREAMING/STOPPED.
   */
  public prepare(prepared: PreparedData): boolean {
    if (this.state.tag !== "PREPARING") {
      return false;
    }
    this.state = { tag: "PREPARED", prepared, callback_answered: false };
    this.emit("transition", this.state);
    return true;
  }

  /**
   * Mark prepareStream callback as answered (prevents double-call).
   * Returns true if callback should be invoked, false if already answered.
   * 
   * Guards against the 1.3.7-1.3.10 race: async error after successful callback
   * → catch block tries to call callback again → HAP-NodeJS "already called" guard
   * → process crash.
   */
  public answerPrepareCallback(): boolean {
    if (this.state.tag !== "PREPARED") {
      return false;
    }
    if (this.state.callback_answered) {
      this.emit("callback_already_answered");
      return false;
    }
    this.state = { ...this.state, callback_answered: true };
    return true;
  }

  /**
   * Transition PREPARED → STREAMING.
   * Throws if not in PREPARED state (type safety: can't start before prepare).
   */
  public start(streaming: StreamingData): void {
    if (this.state.tag !== "PREPARED") {
      throw new Error(`Cannot start from state ${this.state.tag}`);
    }
    this.state = { tag: "STREAMING", streaming };
    this.emit("transition", this.state);
  }

  /**
   * Update STREAMING data (used by RECONFIGURE to respawn FFmpeg).
   * Throws if not in STREAMING state.
   */
  public reconfigure(liveInput: LiveFfmpegInput, ffmpeg: ChildProcess): void {
    if (this.state.tag !== "STREAMING") {
      throw new Error(`Cannot reconfigure from state ${this.state.tag}`);
    }
    this.state = {
      tag: "STREAMING",
      streaming: {
        ...this.state.streaming,
        liveInput,
        ffmpeg,
      },
    };
    this.emit("transition", this.state);
  }

  /**
   * Transition * → STOPPED (idempotent cleanup).
   * Returns cleanup resources (ffmpeg, sockets) for the caller to close.
   * Multiple stops are safe (returns undefined after first call).
   */
  public stop(): StreamingData | undefined {
    if (this.state.tag === "STOPPED") {
      return undefined;
    }
    if (this.state.tag === "STREAMING") {
      const resources = this.state.streaming;
      this.state = { tag: "STOPPED" };
      this.emit("transition", this.state);
      return resources;
    }
    this.state = { tag: "STOPPED" };
    this.emit("transition", this.state);
    return undefined;
  }

  /**
   * Get prepared data (for startStream to build LiveFfmpegInput).
   * Returns undefined if not in PREPARED or STREAMING state.
   */
  public getPrepared(): PreparedData | undefined {
    if (this.state.tag === "PREPARED") {
      return this.state.prepared;
    }
    if (this.state.tag === "STREAMING") {
      // Prepared data is consumed by start(), not preserved in STREAMING state
      return undefined;
    }
    return undefined;
  }

  /**
   * Get live input (for RECONFIGURE to rebuild with new video params).
   * Returns undefined if not in STREAMING state.
   */
  public getLiveInput(): LiveFfmpegInput | undefined {
    if (this.state.tag === "STREAMING") {
      return this.state.streaming.liveInput;
    }
    return undefined;
  }
}
