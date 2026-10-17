// Minimal Reolink HTTP API client — just what motion detection needs. Works
// uniformly for standalone cameras (host = camera IP, channel 0) and NVR-fronted
// cameras (host = NVR IP, channel N). Verified against both on 2026-06-10.

/** One stalled camera must not hold the motion poll for every other camera. */
const REQUEST_TIMEOUT_MS = 5_000;
/** Failed Login waits this long before another attempt. Then the delay doubles. */
const LOGIN_BACKOFF_START_MS = 5_000;
const LOGIN_BACKOFF_MAX_MS = 60_000;

/**
 * Drop URL userinfo so a host string cannot carry a password into a log line.
 * `user:password@host` and `scheme://userinfo@host` are stripped.
 * A bare `user@host` (an email, or `x@y`) is left alone.
 */
export function redactCredentialHosts(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1")
    .replace(/(^|[^A-Za-z0-9])([^\s/:@]+):([^\s/@]*)@/g, "$1");
}

export interface ReolinkClientOptions {
  host: string;
  username: string;
  password: string;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Clock injectable for tests. */
  now?: () => number;
  /** Per-request AbortSignal timeout in ms. Defaults to 5 seconds. Injectable for tests. */
  requestTimeoutMs?: number;
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

export type ReolinkClock = {
  year: number;
  mon: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
};

export class ReolinkClient {
  private token: string | undefined;
  private tokenExpiresAt = 0;
  /** Delay before another Login may be attempted. 0 means the next one is immediate. */
  private loginBackoffMs = 0;
  /** Earliest `now()` at which Login may run again. 0 means it is not backing off. */
  private nextLoginAt = 0;
  /** undefined = not probed; false = GetAiState unsupported here (e.g. via the NVR). */
  private aiSupported: boolean | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  public constructor(private readonly options: ReolinkClientOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  private fail(message: string): never {
    throw new ReolinkError(redactCredentialHosts(message));
  }

  private async call(cmd: string, param: Record<string, unknown>, token?: string): Promise<ReolinkResponse> {
    const query = token ? `?cmd=${cmd}&token=${token}` : `?cmd=${cmd}`;
    const url = `http://${this.options.host}/cgi-bin/api.cgi${query}`;
    const body = JSON.stringify([{ cmd, action: 0, param }]);
    const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // undici reports transport failures as a generic "fetch failed" — surface
      // the cause (ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT…) or debugging is blind.
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
      this.fail(`${cmd} on ${this.options.host} fetch failed: ${detail}`);
    }
    if (!response.ok) {
      this.fail(`${cmd} on ${this.options.host} failed: HTTP ${response.status}`);
    }
    const parsed = (await response.json()) as ReolinkResponse[];
    const first = parsed[0];
    if (!first) {
      this.fail(`${cmd} on ${this.options.host}: empty response`);
    }
    return first;
  }

  /** Log in (or reuse a still-valid token) and return it. Repeated Login failures back off. */
  public async ensureToken(): Promise<string> {
    if (this.token && this.now() < this.tokenExpiresAt) {
      return this.token;
    }
    if (this.nextLoginAt !== 0 && this.now() < this.nextLoginAt) {
      this.fail(`Login on ${this.options.host} failed: backing off`);
    }
    try {
      const token = await this.requestToken();
      this.loginBackoffMs = 0;
      this.nextLoginAt = 0;
      return token;
    } catch (error) {
      this.scheduleLoginBackoff();
      throw error;
    }
  }

  private async requestToken(): Promise<string> {
    const result = await this.call("Login", {
      User: { userName: this.options.username, password: this.options.password },
    });
    if (result.code !== 0 || !result.value) {
      this.fail(`Login on ${this.options.host} failed: ${result.error?.detail ?? `code ${result.code}`}`);
    }
    const tokenInfo = result.value["Token"] as { name?: string; leaseTime?: number } | undefined;
    if (!tokenInfo?.name) {
      this.fail(`Login on ${this.options.host}: no token in response`);
    }
    this.token = tokenInfo.name;
    // Refresh a minute before the lease actually expires.
    const leaseMs = (tokenInfo.leaseTime ?? 3600) * 1000;
    this.tokenExpiresAt = this.now() + Math.max(leaseMs - 60_000, 30_000);
    return this.token;
  }

  private scheduleLoginBackoff(): void {
    const delay = this.loginBackoffMs === 0
      ? LOGIN_BACKOFF_START_MS
      : Math.min(this.loginBackoffMs * 2, LOGIN_BACKOFF_MAX_MS);
    this.loginBackoffMs = delay;
    this.nextLoginAt = this.now() + delay;
  }

  /**
   * Basic motion (GetMdState). Re-logs in once on token expiry (rspCode -6).
   */
  public async getMdState(channel: number): Promise<boolean> {
    let token = await this.ensureToken();
    let md = await this.call("GetMdState", { channel }, token);

    // "please login first" (rspCode -6): token died early — force a fresh login and retry once.
    if (md.code !== 0 && md.error?.rspCode === -6) {
      this.token = undefined;
      token = await this.ensureToken();
      md = await this.call("GetMdState", { channel }, token);
    }
    if (md.code !== 0 || !md.value) {
      this.fail(`GetMdState ch${channel} on ${this.options.host} failed: ${md.error?.detail ?? `code ${md.code}`}`);
    }
    return md.value["state"] === 1;
  }

  /**
   * AI person/vehicle/animal alarm (GetAiState).
   * rspCode -6 (expired token): log in again and retry this request once.
   * rspCode -99: this host does not support GetAiState; later calls skip the request.
   * Any other failure is thrown so the poll can surface it.
   */
  public async getAiState(channel: number): Promise<boolean> {
    if (this.aiSupported === false) {
      return false;
    }
    let token = await this.ensureToken();
    let ai = await this.call("GetAiState", { channel }, token);
    if (ai.code !== 0 && ai.error?.rspCode === -6) {
      this.token = undefined;
      token = await this.ensureToken();
      ai = await this.call("GetAiState", { channel }, token);
    }
    if (ai.code !== 0 && ai.error?.rspCode === -99) {
      this.aiSupported = false;
      return false;
    }
    if (ai.code !== 0 || !ai.value) {
      this.fail(`GetAiState ch${channel} on ${this.options.host} failed: ${ai.error?.detail ?? `code ${ai.code}`}`);
    }
    this.aiSupported = true;
    return (["people", "vehicle", "dog_cat"] as const).some((type) => {
      const detection = ai.value?.[type] as { alarm_state?: number; support?: number } | undefined;
      return detection?.alarm_state === 1;
    });
  }

  /**
   * True if the channel currently reports motion via EITHER basic motion detection
   * (GetMdState) OR AI person/vehicle/animal detection (GetAiState) on this same host.
   * Many Reolink cameras run in AI mode where GetMdState stays 0 but the AI alarm fires.
   */
  public async getMotionState(channel: number): Promise<boolean> {
    if (await this.getMdState(channel)) {
      return true;
    }
    return this.getAiState(channel);
  }

  public async getHddInfo(): Promise<unknown> {
    return this.readCommand("GetHddInfo", {});
  }

  public async getRec(channel: number): Promise<unknown> {
    return this.readCommand("GetRec", { channel });
  }

  public async searchRecordings(channel: number, start: ReolinkClock, end: ReolinkClock): Promise<unknown> {
    return this.readCommand("Search", {
      Search: {
        channel,
        onlyStatus: 0,
        streamType: "main",
        StartTime: start,
        EndTime: end,
      },
    });
  }

  private async readCommand(cmd: "GetHddInfo" | "GetRec" | "Search", param: Record<string, unknown>): Promise<unknown> {
    const token = await this.ensureToken();
    const result = await this.call(cmd, param, token);
    if (result.code !== 0 || result.value === undefined) {
      this.fail(`${cmd} on ${this.options.host} failed: ${result.error?.detail ?? `code ${result.code}`}`);
    }
    return result.value;
  }
}
