export type AnnexBCodec = "h264" | "hevc";

interface Nal {
  start: number;
  end: number;
  vcl: boolean;
}

function nalUnits(buf: Buffer, codec: AnnexBCodec): Nal[] {
  const starts: number[] = [];
  for (let i = 0; i < buf.length - 3; i += 1) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
      i += 2;
    }
  }
  starts.push(buf.length);
  const nals: Nal[] = [];
  for (let i = 0; i < starts.length - 1; i += 1) {
    const start = starts[i]!;
    const end = starts[i + 1]!;
    let offset = start;
    while (offset < end && buf[offset] === 0) offset += 1;
    if (buf[offset] === 1) offset += 1;
    const type = codec === "hevc" ? (buf[offset]! >> 1) & 0x3f : buf[offset]! & 0x1f;
    nals.push({ start, end, vcl: codec === "hevc" ? type < 32 : type >= 1 && type <= 5 });
  }
  return nals;
}

/** Drop the first picture and keep its parameter sets: a join one frame after a keyframe. */
export function sliceAfterFirstVcl(buf: Buffer, codec: AnnexBCodec): Buffer {
  const nals = nalUnits(buf, codec);
  const vcl = nals.filter((nal) => nal.vcl);
  const first = vcl[0];
  const second = vcl[1];
  if (!first || !second) throw new Error("bitstream has fewer than two video frames");
  const parts = nals.filter((nal) => nal.start < first.start).map((nal) => buf.subarray(nal.start, nal.end));
  parts.push(buf.subarray(second.start));
  return Buffer.concat(parts);
}

/** One buffer per picture, carrying the parameter sets and SEI that precede it. Assumes one slice per picture. */
export function accessUnits(buf: Buffer, codec: AnnexBCodec): Buffer[] {
  const units: Buffer[] = [];
  let from = 0;
  for (const nal of nalUnits(buf, codec)) {
    if (!nal.vcl) continue;
    units.push(buf.subarray(from, nal.end));
    from = nal.end;
  }
  return units;
}
