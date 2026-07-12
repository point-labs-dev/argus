/**
 * Bounded forwarding of a child process's stderr into the Argus log.
 *
 * Why this exists: ffmpeg decode-errors freely when it joins a restream
 * mid-GOP, and HKSV recording sessions spawn a fresh ffmpeg per motion event.
 * On 2026-07-12 the unbounded passthrough grew the Mini's serve.err.log to
 * 42 GB and filled the disk. Forensics stay useful with the first lines of a
 * session plus a suppressed count at exit; the full firehose returns behind a
 * verbose flag.
 */

/** "1"/"true" → true; anything else (including unset) → false. */
export function envFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export interface StderrBudgetOptions {
  /** Complete lines forwarded before suppression kicks in. Ignored when verbose. */
  maxLines: number;
  /** Full passthrough — no budget, nothing suppressed. */
  verbose: boolean;
  /** Sink for each forwarded line (already trimmed, no trailing newline). */
  log: (line: string) => void;
}

export interface StderrBudget {
  /** Feed a raw stderr chunk; forwards complete lines until the budget is spent. */
  onChunk(chunk: Buffer | string): void;
  /** Forward any buffered partial line (call once, at child exit). */
  flush(): void;
  /** Lines swallowed after the budget was exhausted. */
  suppressedLines(): number;
  /** Session-end summary line, or undefined when nothing was suppressed. */
  summary(): string | undefined;
}

/**
 * Line-oriented on purpose: a stderr chunk can carry many lines (ffmpeg
 * bursts), and the old chunk-prefixed logging left continuation lines
 * unprefixed in the log. Splitting here gives every line its prefix and makes
 * the budget count real lines, not chunks.
 */
export function createStderrBudget(options: StderrBudgetOptions): StderrBudget {
  let carry = "";
  let forwarded = 0;
  let suppressed = 0;

  const emit = (line: string): void => {
    if (line.length === 0) return;
    if (options.verbose || forwarded < options.maxLines) {
      forwarded += 1;
      options.log(line);
    } else {
      suppressed += 1;
    }
  };

  return {
    onChunk(chunk: Buffer | string): void {
      carry += chunk.toString();
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) emit(line.trimEnd());
    },
    flush(): void {
      if (carry.length > 0) {
        emit(carry.trimEnd());
        carry = "";
      }
    },
    suppressedLines(): number {
      return suppressed;
    },
    summary(): string | undefined {
      return suppressed > 0 ? `suppressed ${suppressed} stderr lines (set the verbose flag for the full stream)` : undefined;
    },
  };
}
