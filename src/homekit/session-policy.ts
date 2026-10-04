/**
 * Session intent-policy separation (preserves pre-transformation values for policy decisions).
 * 
 * Purpose: Prevent post-cap policy bugs (MAIN unreachable under CAP, RECONFIGURE bypassed cap).
 * What it prevents (from 1.3.15 fix):
 * - MAIN source unreachable: checks pre-cap requestedWidth > 640, not post-cap
 * - RECONFIGURE bypassed cap: both START and RECONFIGURE call plan(), so cap+source can't drift
 * - Bitrate confusion: floor vs passthrough decision explicit with reasoning
 */

export interface SessionIntent {
  /** Original controller ask (pre-cap, pre-transformation). */
  readonly requested: {
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  };
  readonly controllerAddress: string;
}

export interface SessionPolicy {
  /** What we actually encode (post-cap, post-floor). */
  readonly encode: {
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
  };
  /** Which stream to source from. */
  readonly source: {
    streamUrl: string;
    tier: "main" | "sub";
  };
  /** Explanation of decisions (debugging, visible to agents). */
  readonly reasoning: string;
}

export interface SessionPlan {
  intent: SessionIntent;
  policy: SessionPolicy;
}

export interface PolicyEngineConfig {
  /** Maximum width before cap (ARGUS_LIVE_CAP, default 854). */
  capWidth: number;
  /** go2rtc restream of camera's sub stream (tiles and default). */
  subStreamUrl: string;
  /** go2rtc restream of camera's main stream (full-screen when granted). */
  mainStreamUrl?: string;
  /** "transcode" (default) or "copy" (experimental). */
  videoMode: "transcode" | "copy";
  /** Community-proven LAN floors: 600k tiles, 2000k 720p, 3000k 1080p (d094a53). */
  bitrateFloors: boolean;
  /** Controller addresses to pass through negotiated bitrate (hub relays). */
  hubAddresses: string[];
}

/**
 * Policy engine that preserves intent (pre-cap ask) and applies transformations
 * to produce final policy (cap, source selection, bitrate floors).
 * 
 * Used by both START and RECONFIGURE so they can't drift (1.3.15 fix).
 */
export class SessionPolicyEngine {
  public constructor(private readonly config: PolicyEngineConfig) {}

  /**
   * Plan a session: capture intent, apply policies, return both.
   * 
   * Policy checks use intent.requested (pre-cap), not intermediate values.
   * RECONFIGURE calls the same plan() as START → cap+source logic identical.
   */
  public plan(request: {
    width: number;
    height: number;
    fps: number;
    bitrateKbps: number;
    controllerAddress: string;
  }): SessionPlan {
    const intent: SessionIntent = {
      requested: {
        width: request.width,
        height: request.height,
        fps: request.fps,
        bitrateKbps: request.bitrateKbps,
      },
      controllerAddress: request.controllerAddress,
    };

    // Apply cap (WiFi safety, ARGUS_LIVE_CAP default 854)
    const capWidth = Math.min(request.width, this.config.capWidth);
    const capHeight = Math.min(request.height, Math.round((this.config.capWidth / 16) * 9));

    // Source selection: check PRE-CAP ask to detect full-screen intent
    // (1.3.15 fix: requestedWidth > 640, not post-cap width)
    const fullScreenAsk = request.width > 640;
    const canUseMain = this.config.videoMode === "transcode" && this.config.mainStreamUrl !== undefined;
    const useMain = canUseMain && fullScreenAsk;
    const streamUrl = useMain ? this.config.mainStreamUrl! : this.config.subStreamUrl;
    const tier: "main" | "sub" = useMain ? "main" : "sub";

    // Bitrate: apply floors unless controller is a hub relay
    const isHubRelay = this.config.hubAddresses.includes(request.controllerAddress);
    const shouldFloor = this.config.bitrateFloors && !isHubRelay;
    const bitrateKbps = shouldFloor
      ? this.applyBitrateFloor(capWidth, capHeight, request.bitrateKbps)
      : request.bitrateKbps;

    // Build policy object first, then add reasoning
    const policy: SessionPolicy = {
      encode: {
        width: capWidth,
        height: capHeight,
        fps: request.fps,
        bitrateKbps,
      },
      source: {
        streamUrl,
        tier,
      },
      reasoning: "", // Will be set below
    };

    // Generate reasoning after policy is constructed
    const reasoning = this.buildReasoning(intent, policy, {
      capped: request.width !== capWidth || request.height !== capHeight,
      floored: shouldFloor && bitrateKbps !== request.bitrateKbps,
      fullScreenAsk,
      isHubRelay,
    });

    // Return policy with reasoning
    return { 
      intent, 
      policy: { ...policy, reasoning } 
    };
  }

  private applyBitrateFloor(width: number, height: number, negotiated: number): number {
    // Community-proven LAN floors (d094a53): 600k tiles, 2000k 720p, 3000k 1080p
    const pixels = width * height;
    const floor =
      pixels >= 1920 * 1080 ? 3000 :
      pixels >= 1280 * 720 ? 2000 :
      pixels >= 640 * 360 ? 600 : 300;
    return Math.max(negotiated, floor);
  }

  private buildReasoning(
    intent: SessionIntent,
    policy: SessionPolicy,
    meta: { capped: boolean; floored: boolean; fullScreenAsk: boolean; isHubRelay: boolean },
  ): string {
    const parts: string[] = [];

    // Dimension cap
    if (meta.capped) {
      parts.push(
        `cap: ${intent.requested.width}x${intent.requested.height} → ` +
        `${policy.encode.width}x${policy.encode.height}`
      );
    } else {
      parts.push(`dims: ${policy.encode.width}x${policy.encode.height} (no cap)`);
    }

    // Source selection
    if (policy.source.tier === "main") {
      parts.push(
        `source: MAIN (asked ${intent.requested.width}x${intent.requested.height} = full-screen)`
      );
    } else {
      parts.push(
        meta.fullScreenAsk
          ? `source: sub (full-screen ask but no main grant)`
          : `source: sub (tile ask)`
      );
    }

    // Bitrate
    if (meta.floored) {
      parts.push(
        `bitrate: ${intent.requested.bitrateKbps}k floored→${policy.encode.bitrateKbps}k (LAN quality)`
      );
    } else if (meta.isHubRelay) {
      parts.push(
        `bitrate: ${policy.encode.bitrateKbps}k (hub relay passthrough)`
      );
    } else {
      parts.push(`bitrate: ${policy.encode.bitrateKbps}k (no floor)`);
    }

    return parts.join("; ");
  }
}
