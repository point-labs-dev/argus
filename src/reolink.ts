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

  /** True if the channel currently reports motion. Re-logs in once on token expiry. */
  public async getMotionState(channel: number): Promise<boolean> {
    let token = await this.ensureToken();
    let result = await this.call("GetMdState", { channel }, token);

    // "please login first" (rspCode -6): token died early — force a fresh login and retry once.
    if (result.code !== 0 && result.error?.rspCode === -6) {
      this.token = undefined;
      token = await this.ensureToken();
      result = await this.call("GetMdState", { channel }, token);
    }
    if (result.code !== 0 || !result.value) {
      throw new ReolinkError(`GetMdState ch${channel} on ${this.options.host} failed: ${result.error?.detail ?? `code ${result.code}`}`);
    }
    return result.value["state"] === 1;
  }
}
