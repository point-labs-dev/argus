// Minimal Reolink HTTP API client — just what motion detection needs. Works
// uniformly for standalone cameras (host = camera IP, channel 0) and NVR-fronted
// cameras (host = NVR IP, channel N). Verified against both on 2026-06-10.

export interface ReolinkClientOptions {
  host: string;
  username: string;
  password: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Clock injectable for tests. */
  now?: () => number;
}

interface ReolinkResponse {
  cmd: string;
  code: number;
  value?: Record<string, unknown>;
  error?: { detail?: string; rspCode?: number };
}

export class ReolinkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReolinkError";
  }
}

export class ReolinkClient {
  private token: string | undefined;
  private tokenExpiresAt = 0;
  /** undefined = not probed; false = GetAiState unsupported here (e.g. via the NVR). */
  private aiSupported: boolean | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  public constructor(private readonly options: ReolinkClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  private async call(cmd: string, param: Record<string, unknown>, token?: string): Promise<ReolinkResponse> {
    const query = token ? `?cmd=${cmd}&token=${token}` : `?cmd=${cmd}`;
    const url = `http://${this.options.host}/cgi-bin/api.cgi${query}`;
    const body = JSON.stringify([{ cmd, action: 0, param }]);
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new ReolinkError(`${cmd} on ${this.options.host} failed: HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as ReolinkResponse[];
    const first = parsed[0];
    if (!first) {
      throw new ReolinkError(`${cmd} on ${this.options.host}: empty response`);
    }
    return first;
  }

  /** Log in (or reuse a still-valid token) and return it. */
  public async ensureToken(): Promise<string> {
    if (this.token && this.now() < this.tokenExpiresAt) {
      return this.token;
    }
    const result = await this.call("Login", {
      User: { userName: this.options.username, password: this.options.password },
    });
    if (result.code !== 0 || !result.value) {
      throw new ReolinkError(`Login on ${this.options.host} failed: ${result.error?.detail ?? `code ${result.code}`}`);
    }
    const tokenInfo = result.value["Token"] as { name?: string; leaseTime?: number } | undefined;
    if (!tokenInfo?.name) {
      throw new ReolinkError(`Login on ${this.options.host}: no token in response`);
    }
    this.token = tokenInfo.name;
    // Refresh a minute before the lease actually expires.
    const leaseMs = (tokenInfo.leaseTime ?? 3600) * 1000;
    this.tokenExpiresAt = this.now() + Math.max(leaseMs - 60_000, 30_000);
    return this.token;
  }

  /**
   * True if the channel currently reports motion via EITHER basic motion detection
   * (GetMdState) OR AI person/vehicle/animal detection (GetAiState). Many Reolink
   * cameras run in AI mode where GetMdState stays 0 but the AI alarm fires.
   * Re-logs in once on token expiry. GetAiState isn't available via the NVR, so it's
   * probed once and then skipped if unsupported.
   */
  public async getMotionState(channel: number): Promise<boolean> {
    let token = await this.ensureToken();
    let md = await this.call("GetMdState", { channel }, token);

    // "please login first" (rspCode -6): token died early — force a fresh login and retry once.
    if (md.code !== 0 && md.error?.rspCode === -6) {
      this.token = undefined;
      token = await this.ensureToken();
      md = await this.call("GetMdState", { channel }, token);
    }
    if (md.code !== 0 || !md.value) {
      throw new ReolinkError(`GetMdState ch${channel} on ${this.options.host} failed: ${md.error?.detail ?? `code ${md.code}`}`);
    }
    if (md.value["state"] === 1) {
      return true;
    }

    if (this.aiSupported === false) {
      return false;
    }
    const ai = await this.call("GetAiState", { channel }, token);
    if (ai.code !== 0 || !ai.value) {
      this.aiSupported = false; // e.g. NVR-fronted channel — fall back to MD only
      return false;
    }
    this.aiSupported = true;
    return (["people", "vehicle", "dog_cat"] as const).some((type) => {
      const detection = ai.value?.[type] as { alarm_state?: number; support?: number } | undefined;
      return detection?.alarm_state === 1;
    });
  }
}
