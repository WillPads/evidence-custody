// Fixes the duration of a fragmented MP4 written by a browser's MediaRecorder.
//
// MediaRecorder writes the video in fragments as it records, so the header
// ("moov" box) is written before the total length is known. Browsers then show
// a wrong length and seeking breaks. This adds up every sample's duration from
// the fragments and writes the real total into the header (mvhd, tkhd, mdhd)
// plus an "mehd" box, which is how fragmented MP4s declare their full length.
//
// Usage: node scripts/fix-mp4-duration.mjs <file.mp4>

import { readFileSync, writeFileSync } from "node:fs";

function boxes(buf, start, end) {
  const list = [];
  for (let p = start; p + 8 <= end;) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    if (size === 0) size = end - p;
    list.push({ type, start: p, size, body: p + header, end: p + size });
    p += size;
  }
  return list;
}
const child = (buf, box, type) => boxes(buf, box.body, box.end).find((b) => b.type === type);

/** Sum of all sample durations across every fragment, in the track's timescale. */
function mediaDuration(buf, top) {
  let total = 0;
  for (const moof of top.filter((b) => b.type === "moof")) {
    for (const traf of boxes(buf, moof.body, moof.end).filter((b) => b.type === "traf")) {
      const tfhd = child(buf, traf, "tfhd");
      const tfhdFlags = buf.readUInt32BE(tfhd.body) & 0xffffff;
      let defaultDuration = 0;
      let q = tfhd.body + 8;                 // after version/flags + track_ID
      if (tfhdFlags & 0x01) q += 8;          // base_data_offset
      if (tfhdFlags & 0x02) q += 4;          // sample_description_index
      if (tfhdFlags & 0x08) defaultDuration = buf.readUInt32BE(q);
      for (const trun of boxes(buf, traf.body, traf.end).filter((b) => b.type === "trun")) {
        const flags = buf.readUInt32BE(trun.body) & 0xffffff;
        const count = buf.readUInt32BE(trun.body + 4);
        let r = trun.body + 8;
        if (flags & 0x001) r += 4;           // data_offset
        if (flags & 0x004) r += 4;           // first_sample_flags
        for (let i = 0; i < count; i++) {
          if (flags & 0x100) { total += buf.readUInt32BE(r); r += 4; } else total += defaultDuration;
          if (flags & 0x200) r += 4;
          if (flags & 0x400) r += 4;
          if (flags & 0x800) r += 4;
        }
      }
    }
  }
  return total;
}

/** Writes a duration field whose position depends on the box version (0 = 32-bit, 1 = 64-bit). */
function setDuration(buf, box, offsetV0, offsetV1, value) {
  if (buf[box.body] === 1) buf.writeBigUInt64BE(BigInt(value), box.body + offsetV1);
  else buf.writeUInt32BE(value, box.body + offsetV0);
}

export function fixMp4Duration(input) {
  const buf = Buffer.from(input);
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov || !top.some((b) => b.type === "moof")) return { buffer: buf, seconds: null }; // not fragmented
  const mvhd = child(buf, moov, "mvhd");
  const trak = child(buf, moov, "trak");
  const tkhd = child(buf, trak, "tkhd");
  const mdia = child(buf, trak, "mdia");
  const mdhd = child(buf, mdia, "mdhd");

  const movieScale = buf[mvhd.body] === 1 ? buf.readUInt32BE(mvhd.body + 20) : buf.readUInt32BE(mvhd.body + 12);
  const mediaScale = buf[mdhd.body] === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
  const media = mediaDuration(buf, top);
  const movie = Math.round((media / mediaScale) * movieScale);

  setDuration(buf, mvhd, 16, 24, movie);  // mvhd: version/flags, times, timescale, duration
  setDuration(buf, tkhd, 20, 28, movie);  // tkhd: version/flags, times, track_ID, reserved, duration
  setDuration(buf, mdhd, 16, 24, media);  // mdhd: same layout as mvhd

  // Add (or update) mehd inside mvex. Offsets inside fragments are relative to
  // each moof, so growing the moov box doesn't break anything after it.
  const mvex = child(buf, moov, "mvex");
  if (!mvex) return { buffer: buf, seconds: media / mediaScale };
  const mehd = child(buf, mvex, "mehd");
  if (mehd) {
    setDuration(buf, mehd, 4, 4, movie);
    return { buffer: buf, seconds: media / mediaScale };
  }
  const newBox = Buffer.alloc(20);
  newBox.writeUInt32BE(20, 0); newBox.write("mehd", 4, "latin1");
  newBox.writeUInt32BE(0x01000000, 8);                // version 1, flags 0
  newBox.writeBigUInt64BE(BigInt(movie), 12);
  const out = Buffer.concat([buf.subarray(0, mvex.body), newBox, buf.subarray(mvex.body)]);
  out.writeUInt32BE(moov.size + 20, moov.start);       // grow moov
  out.writeUInt32BE(mvex.size + 20, mvex.start);       // grow mvex
  return { buffer: out, seconds: media / mediaScale };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const file = process.argv[2];
  const { buffer, seconds } = fixMp4Duration(readFileSync(file));
  writeFileSync(file, buffer);
  console.log(seconds == null ? "Not a fragmented MP4; nothing to fix." : `Duration set to ${seconds.toFixed(2)} s`);
}
