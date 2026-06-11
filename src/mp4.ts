import type { Readable } from "node:stream";

// Parse FFmpeg's fragmented-MP4 output (movflags frag_keyframe+empty_moov+
// default_base_moof) into the pieces HomeKit Secure Video wants: a single init
// segment (ftyp + moov) followed by one segment per keyframe-aligned fragment
// (moof + mdat). HKSV delivers these as the RecordingPackets.

export interface Mp4Segment {
  /** ftyp+moov for the init segment; moof+mdat for a media fragment. */
  data: Buffer;
  isInit: boolean;
}

interface Mp4Box {
  type: string;
  data: Buffer;
}

/** Stream of top-level MP4 boxes. Assumes 32-bit box sizes (true for fMP4 fragments). */
async function* readBoxes(source: Readable): AsyncGenerator<Mp4Box> {
  let buffer: Buffer = Buffer.alloc(0);
  for await (const chunk of source as AsyncIterable<Uint8Array>) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(0);
      // size 0 = "to end of file" and size 1 = 64-bit length; neither occurs in
      // FFmpeg fragment output, so treat them as a stream error rather than guess.
      if (size < 8) {
        throw new Error(`Unexpected MP4 box size ${size}`);
      }
      if (buffer.length < size) {
        break; // need more bytes for this box
      }
      yield { type: buffer.toString("ascii", 4, 8), data: buffer.subarray(0, size) };
      buffer = buffer.subarray(size);
    }
  }
}

/**
 * Group boxes into HKSV segments: ftyp+moov => init segment, each moof+mdat => a
 * media fragment.
 */
export async function* readFragmentedMp4(source: Readable): AsyncGenerator<Mp4Segment> {
  let initBoxes: Buffer[] = [];
  let fragmentBoxes: Buffer[] = [];

  for await (const box of readBoxes(source)) {
    switch (box.type) {
      case "ftyp":
        initBoxes = [box.data];
        break;
      case "moov":
        initBoxes.push(box.data);
        yield { data: Buffer.concat(initBoxes), isInit: true };
        initBoxes = [];
        break;
      case "moof":
        fragmentBoxes = [box.data];
        break;
      case "mdat":
        fragmentBoxes.push(box.data);
        yield { data: Buffer.concat(fragmentBoxes), isInit: false };
        fragmentBoxes = [];
        break;
      default:
        // styp/sidx/mfra and friends — ignore; they aren't needed for HKSV delivery.
        break;
    }
  }
}
