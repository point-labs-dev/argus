import { EventEmitter } from "node:events";
import type { Socket } from "node:dgram";

/**
 * Observable RTCP socket (logs events without lifecycle timers).
 * 
 * Purpose: Make RTCP observable for debugging without watchdog timers that kill healthy sessions.
 * What it prevents (from 1.3.15 fix):
 * - Killing healthy sessions: no 30s watchdog (field: Home sends ONE RTCP at +0.5s, then silence)
 * - Process crashes: bind errors emit "error" event instead of throwing
 * - Lost debugging data: events emitted for external observers (tests, metrics)
 * 
 * Protocol contract: HAP-NodeJS manages session termination (STOP request, connection close
 * via Accessory.handleCloseConnection). Accessories log RTCP for observability but do NOT
 * use it for lifecycle decisions. Field evidence: Home paints for minutes with at most one
 * receiver report — silence is normal, not a failure signal.
 */

export interface RtcpPacketEvent {
  size: number;
  time: number;
}

/**
 * Wraps a dgram.Socket to emit observable events (packet, error, close) without lifecycle timers.
 * 
 * Events:
 * - "packet": RTCP data arrived (size, timestamp) — observable for debugging/telemetry
 * - "error": bind/send failed — logged and socket closed, no process crash
 * - "close": socket closed (normal teardown or error recovery)
 * 
 * No watchdog timer: HAP manages session lifecycle, not the accessory.
 */
export class ObservableRtcpSocket extends EventEmitter {
  private seen = false;

  public constructor(
    private readonly socket: Socket,
    private readonly label: string,
    private readonly log: (msg: string) => void,
  ) {
    super();

    // RTCP packets: log first arrival, emit events for all
    this.socket.on("message", (msg: Buffer) => {
      if (!this.seen) {
        this.seen = true;
        this.log(`RTCP arrived on ${this.label} return port (${msg.length} bytes)`);
      }
      this.emit("packet", { size: msg.length, time: Date.now() } as RtcpPacketEvent);
    });

    // Bind errors: log and close instead of crashing process
    // (unhandled dgram "error" events → uncaught exception → exit 1)
    this.socket.on("error", (error: Error) => {
      this.log(`RTCP ${this.label} return socket error: ${error.message} — continuing without it`);
      this.emit("error", error);
      this.close();
    });

    this.socket.on("close", () => {
      this.emit("close");
    });
  }

  /**
   * Bind the socket to a port (and optionally an address).
   * Errors arrive async as "error" events, handled by constructor listener.
   */
  public bind(port: number, address?: string): void {
    if (address) {
      this.socket.bind(port, address);
      this.log(`Bound ${this.label} return RTCP: port ${port} addr ${address}`);
    } else {
      this.socket.bind(port);
      this.log(`Bound ${this.label} return RTCP: port ${port}`);
    }
  }

  /**
   * Close the socket (idempotent — safe to call multiple times).
   */
  public close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }

  /**
   * Get the underlying dgram.Socket (for tests that need direct access).
   */
  public getSocket(): Socket {
    return this.socket;
  }
}
