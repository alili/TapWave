import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolvePythonBin(): string {
  const venvPy = path.join(ROOT_DIR, '.venv', 'bin', 'python');
  return fs.existsSync(venvPy) ? venvPy : 'python3';
}

function resolveFfmpegBin(): string {
  for (const c of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

function inferAudioMime(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.ogg') || lower.endsWith('.opus')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'audio/wav';
}

function needsPlaybackWavTranscode(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('.flac') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.opus') ||
    lower.endsWith('.wma')
  );
}

function transcodeToCachedProxyWav(inputPath: string): string {
  const stat = fs.statSync(inputPath);
  const hash = crypto
    .createHash('sha1')
    .update(`${inputPath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  const cacheDir = '/tmp/podcraft_playback_cache';
  fs.mkdirSync(cacheDir, { recursive: true });
  const outWav = path.join(cacheDir, `px_${hash}.wav`);
  if (fs.existsSync(outWav) && fs.statSync(outWav).size > 44) {
    return outWav;
  }
  const tmpWav = path.join(cacheDir, `px_${hash}_${process.pid}.tmp.wav`);
  const res = spawnSync(
    resolveFfmpegBin(),
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-threads',
      '0',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-sample_fmt',
      's16',
      tmpWav,
    ],
    { stdio: 'ignore' }
  );
  if (res.status === 0 && fs.existsSync(tmpWav)) {
    fs.renameSync(tmpWav, outWav);
    return outWav;
  }
  if (fs.existsSync(tmpWav)) {
    fs.unlinkSync(tmpWav);
  }
  return inputPath;
}

function transcodeToCachedPlaybackWav(inputPath: string): string {
  const stat = fs.statSync(inputPath);
  const hash = crypto
    .createHash('sha1')
    .update(`${inputPath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  const cacheDir = '/tmp/podcraft_playback_cache';
  fs.mkdirSync(cacheDir, { recursive: true });
  const outWav = path.join(cacheDir, `pb_${hash}.wav`);
  if (fs.existsSync(outWav) && fs.statSync(outWav).size > 44) {
    return outWav;
  }
  const tmpWav = path.join(cacheDir, `pb_${hash}_${process.pid}.tmp.wav`);
  const res = spawnSync(
    resolveFfmpegBin(),
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-threads',
      '0',
      '-i',
      inputPath,
      '-vn',
      '-ar',
      '48000',
      '-sample_fmt',
      's16',
      tmpWav,
    ],
    { stdio: 'ignore' }
  );
  if (res.status === 0 && fs.existsSync(tmpWav)) {
    fs.renameSync(tmpWav, outWav);
    return outWav;
  }
  if (fs.existsSync(tmpWav)) {
    fs.unlinkSync(tmpWav);
  }
  return inputPath;
}

interface NodeWavHeader {
  dataOffset: number;
  dataSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
  blockAlign: number;
  totalFrames: number;
}

function probeWavHeaderNode(filePath: string): NodeWavHeader | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size < 44) return null;
      const head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
        return null;
      }
      let pos = 12;
      let fmtFound = false;
      let formatTag = 1;
      let channels = 1;
      let sampleRate = 48000;
      let blockAlign = 2;
      let bitsPerSample = 16;
      let isFloat = false;
      let dataOffset = 0;
      let dataSize = 0;
      let dataFound = false;
      const chHdr = Buffer.alloc(8);
      while (pos + 8 <= stat.size) {
        if (fs.readSync(fd, chHdr, 0, 8, pos) < 8) break;
        const id = chHdr.toString('ascii', 0, 4);
        const sz = chHdr.readUInt32LE(4);
        const payload = pos + 8;
        if (id === 'fmt ' && sz >= 16) {
          const toRead = Math.min(sz, 64);
          const fmt = Buffer.alloc(toRead);
          fs.readSync(fd, fmt, 0, toRead, payload);
          formatTag = fmt.readUInt16LE(0);
          channels = Math.max(1, fmt.readUInt16LE(2));
          sampleRate = Math.max(8000, fmt.readUInt32LE(4));
          blockAlign = fmt.readUInt16LE(12);
          bitsPerSample = fmt.readUInt16LE(14);
          if (formatTag === 0xfffe && fmt.length >= 26) {
            formatTag = fmt.readUInt16LE(24);
          }
          isFloat = formatTag === 3;
          if (formatTag !== 1 && formatTag !== 3) return null;
          fmtFound = true;
        } else if (id === 'data') {
          dataOffset = payload;
          dataSize = Math.min(sz, Math.max(0, stat.size - payload));
          dataFound = true;
          if (fmtFound) break;
        }
        const nextPos = payload + sz + (sz % 2);
        if (nextPos <= pos) break;
        pos = nextPos;
      }
      if (!fmtFound || !dataFound || blockAlign <= 0) return null;
      if (sampleRate !== 48000 || (!isFloat && bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32)) {
        return null;
      }
      if (isFloat && bitsPerSample !== 32) return null;
      return {
        dataOffset,
        dataSize,
        sampleRate,
        channels,
        bitsPerSample,
        isFloat,
        blockAlign,
        totalFrames: Math.floor(dataSize / blockAlign),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function buildWav48kMonoHeader(totalPcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const clamped = Math.min(totalPcmBytes, 0xffffffff - 36);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + clamped, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(clamped, 40);
  return header;
}

interface NodePreparedTrack {
  id: string;
  wavPath: string;
  hdr: NodeWavHeader;
  offsetFrames: number;
  baseGain: number;
  mutedOrUnsoloed: boolean;
  activeIntervals: Array<[number, number]>;
  primaryIntervals: Array<[number, number]>;
  trackMutes: Array<[number, number]>;
  mouthClickRanges: Array<[number, number]>;
}

interface NodePreparedAux {
  wavPath: string;
  hdr: NodeWavHeader;
  frames48k: number;
}

type NodeRegion =
  | { kind: 'idle'; startF: number; endF: number }
  | { kind: 'hl'; startF: number; endF: number; srcStartF: number; sliceFrames: number }
  | { kind: 'intro_vo'; startF: number; endF: number }
  | { kind: 'span'; startF: number; endF: number; srcStartF: number; prevSrcEndF: number | null; xfadeFrames: number };

interface NodePreparedMix {
  rev: number;
  totalFrames: number;
  totalWavLen: number;
  wavHeader: Buffer;
  autoSoloMode: string;
  duckLinear: number;
  deClickEnabled: boolean;
  deClickStrong: boolean;
  bgmDuckLinear: number;
  introEndFrame: number;
  outroStartFrame: number;
  tracks: NodePreparedTrack[];
  introVo: NodePreparedAux | null;
  introBgm: NodePreparedAux | null;
  outroBgm: NodePreparedAux | null;
  regions: NodeRegion[];
  laughterRanges: Array<[number, number]>;
  bleepRanges: Array<[number, number]>;
}

function mergeNodeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [s, eRaw] of ranges) {
    const e = Math.max(s, eRaw);
    const last = out[out.length - 1];
    if (last && s <= last[1] + 10) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

function nodeRangeHas(ranges: Array<[number, number]>, tMs: number, padBefore: number, padAfter: number): boolean {
  if (ranges.length === 0) return false;
  let lo = 0;
  let hi = ranges.length;
  const target = tMs + padBefore;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid][0] <= target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const r = ranges[lo - 1];
    return tMs <= r[1] + padAfter && tMs >= r[0] - padBefore;
  }
  return false;
}

function resolveNodePcm48k(rawPath: string): { wavPath: string; hdr: NodeWavHeader } {
  if (!rawPath || !fs.existsSync(rawPath)) {
    throw new Error(`音频文件不存在: ${rawPath}`);
  }
  if (!needsPlaybackWavTranscode(rawPath)) {
    const direct = probeWavHeaderNode(rawPath);
    if (direct) return { wavPath: rawPath, hdr: direct };
  }
  const transcoded = transcodeToCachedPlaybackWav(rawPath);
  const hdr = probeWavHeaderNode(transcoded);
  if (!hdr) throw new Error(`无法读取 WAV 头: ${transcoded}`);
  return { wavPath: transcoded, hdr };
}

function readMono48kFramesNode(
  fd: number,
  hdr: NodeWavHeader,
  startFrame: number,
  out: Float32Array
): void {
  out.fill(0);
  if (startFrame < 0 || startFrame >= hdr.totalFrames || out.length === 0) return;
  const avail = Math.min(out.length, hdr.totalFrames - startFrame);
  const needBytes = avail * hdr.blockAlign;
  const buf = Buffer.allocUnsafe(needBytes);
  const got = fs.readSync(fd, buf, 0, needBytes, hdr.dataOffset + startFrame * hdr.blockAlign);
  const frames = Math.floor(got / hdr.blockAlign);
  if (hdr.channels === 1 && !hdr.isFloat && hdr.bitsPerSample === 16) {
    for (let i = 0; i < frames; i++) {
      out[i] = buf.readInt16LE(i * 2) / 32768;
    }
    return;
  }
  const bps = hdr.bitsPerSample >> 3;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const base = i * hdr.blockAlign;
    for (let c = 0; c < hdr.channels; c++) {
      const off = base + c * bps;
      if (hdr.isFloat && bps === 4) sum += buf.readFloatLE(off);
      else if (bps === 2) sum += buf.readInt16LE(off) / 32768;
      else if (bps === 3) {
        const val = (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16));
        sum += ((val & 0x800000 ? val | ~0xffffff : val)) / 8388608;
      } else if (bps === 4) sum += buf.readInt32LE(off) / 2147483648;
    }
    out[i] = sum / hdr.channels;
  }
}

const nodeLiveMixRevisions: NodePreparedMix[] = [];
let nodeLiveMixNextRev = 1;

function findWavDataChunk(buf: Buffer): { offset: number; length: number } {
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'data') {
      return { offset: pos + 8, length: Math.min(size, buf.length - (pos + 8)) };
    }
    pos += 8 + size + (size % 2);
  }
  return { offset: Math.min(44, buf.length), length: Math.max(0, buf.length - 44) };
}

function buildWav48kStereoBuffer(pcmData: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // 2 channels
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

function sliceEdlStereoWav48k(
  mixWavPath: string,
  outEdlWavPath: string,
  keepSegments: Array<{ sourceStartMs: number; sourceEndMs: number; pauseAfterMs?: number }>,
  muteRanges: Array<{ startMs: number; endMs: number }> = []
): void {
  const raw = Buffer.from(fs.readFileSync(mixWavPath));
  const { offset, length } = findWavDataChunk(raw);
  const bytesPerFrame = 4; // stereo s16le
  const totalFrames = Math.floor(length / bytesPerFrame);

  // Smoothly zero out cleaned mouth-click silence ranges before slicing EDL
  for (const mr of muteRanges) {
    const mStart = Math.max(0, Math.min(totalFrames, Math.round((mr.startMs / 1000) * 48000)));
    const mEnd = Math.max(mStart, Math.min(totalFrames, Math.round((mr.endMs / 1000) * 48000)));
    const mLen = mEnd - mStart;
    if (mLen <= 0) continue;
    const ramp = Math.min(240, Math.floor(mLen / 3));
    for (let f = 0; f < mLen; f++) {
      let gain = 0;
      if (f < ramp) gain = 1 - f / ramp;
      else if (f >= mLen - ramp) gain = (f - (mLen - ramp)) / Math.max(1, ramp);
      const byteIdx = offset + (mStart + f) * bytesPerFrame;
      raw.writeInt16LE(Math.round(raw.readInt16LE(byteIdx) * gain), byteIdx);
      raw.writeInt16LE(Math.round(raw.readInt16LE(byteIdx + 2) * gain), byteIdx + 2);
    }
  }

  if (!Array.isArray(keepSegments) || keepSegments.length === 0 || totalFrames <= 0) {
    fs.writeFileSync(outEdlWavPath, raw);
    return;
  }

  const pieces: Buffer[] = [];
  const fadeFramesMax = 240; // 5ms @ 48kHz anti-click micro-fade

  for (const seg of keepSegments) {
    const sFrame = Math.max(0, Math.min(totalFrames, Math.round((seg.sourceStartMs / 1000) * 48000)));
    const eFrame = Math.max(sFrame, Math.min(totalFrames, Math.round((seg.sourceEndMs / 1000) * 48000)));
    const frameCount = eFrame - sFrame;
    if (frameCount > 0) {
      const segBuf = Buffer.from(
        raw.subarray(offset + sFrame * bytesPerFrame, offset + eFrame * bytesPerFrame)
      );
      const fadeLen = Math.min(fadeFramesMax, Math.floor(frameCount / 3));
      for (let f = 0; f < fadeLen; f++) {
        const gainIn = f / fadeLen;
        const gainOut = f / fadeLen;
        const inIdx = f * 4;
        segBuf.writeInt16LE(Math.round(segBuf.readInt16LE(inIdx) * gainIn), inIdx);
        segBuf.writeInt16LE(Math.round(segBuf.readInt16LE(inIdx + 2) * gainIn), inIdx + 2);
        const outIdx = (frameCount - 1 - f) * 4;
        segBuf.writeInt16LE(Math.round(segBuf.readInt16LE(outIdx) * gainOut), outIdx);
        segBuf.writeInt16LE(Math.round(segBuf.readInt16LE(outIdx + 2) * gainOut), outIdx + 2);
      }
      pieces.push(segBuf);
    }
    const pauseFrames = Math.max(0, Math.round(((seg.pauseAfterMs || 0) / 1000) * 48000));
    if (pauseFrames > 0) {
      pieces.push(Buffer.alloc(pauseFrames * bytesPerFrame));
    }
  }

  const combinedPcm = pieces.length > 0 ? Buffer.concat(pieces) : Buffer.alloc(48000 * bytesPerFrame);
  fs.writeFileSync(outEdlWavPath, buildWav48kStereoBuffer(combinedPcm));
}

const inFlightWaveformEnv = new Map<string, Promise<string>>();

function getOrBuildNodeWaveformEnvelopeBin(inputPath: string): Promise<string> {
  const stat = fs.statSync(inputPath);
  if (!stat.isFile()) {
    return Promise.reject(new Error(`音频路径不是有效文件: ${inputPath}`));
  }
  const hash = crypto
    .createHash('sha1')
    .update(`${inputPath}|${stat.size}|${stat.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  const cacheDir = '/tmp/podcraft_playback_cache';
  fs.mkdirSync(cacheDir, { recursive: true });
  const outBin = path.join(cacheDir, `wenv_v1_${hash}.bin`);
  if (fs.existsSync(outBin) && fs.statSync(outBin).size >= 22) {
    return Promise.resolve(outBin);
  }
  const existing = inFlightWaveformEnv.get(outBin);
  if (existing) return existing;

  const job = new Promise<string>((resolve, reject) => {
    const child = spawn(
      resolveFfmpegBin(),
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-threads',
        '0',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const BIN_SAMPLES = 80; // 5ms at 16,000 Hz
    const triples: number[] = [];
    let posMax = 0;
    let negMax = 0;
    let sumSq = 0;
    let cnt = 0;
    let leftoverByte: number | null = null;
    let finished = false;

    const pushSample = (rawInt16: number) => {
      const s = rawInt16 / 32768;
      if (s > posMax) posMax = s;
      if (-s > negMax) negMax = -s;
      sumSq += s * s;
      cnt++;
      if (cnt >= BIN_SAMPLES) {
        const rms = Math.sqrt(sumSq / cnt);
        triples.push(
          Math.min(65535, Math.max(0, Math.round(posMax * 65535))),
          Math.min(65535, Math.max(0, Math.round(negMax * 65535))),
          Math.min(65535, Math.max(0, Math.round(rms * 65535)))
        );
        posMax = 0;
        negMax = 0;
        sumSq = 0;
        cnt = 0;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (!chunk || chunk.length === 0) return;
      let offset = 0;
      if (leftoverByte !== null) {
        const low = leftoverByte & 0xff;
        const high = chunk[0] & 0xff;
        let val = (high << 8) | low;
        if (val >= 0x8000) val -= 0x10000;
        pushSample(val);
        leftoverByte = null;
        offset = 1;
      }
      const rem = chunk.length - offset;
      const evenEnd = offset + (rem & ~1);
      for (let i = offset; i < evenEnd; i += 2) {
        pushSample(chunk.readInt16LE(i));
      }
      if (evenEnd < chunk.length) {
        leftoverByte = chunk[chunk.length - 1];
      }
    });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      reject(err);
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (cnt > 0) {
        const rms = Math.sqrt(sumSq / cnt);
        triples.push(
          Math.min(65535, Math.max(0, Math.round(posMax * 65535))),
          Math.min(65535, Math.max(0, Math.round(negMax * 65535))),
          Math.min(65535, Math.max(0, Math.round(rms * 65535)))
        );
      }
      const numBins = Math.floor(triples.length / 3);
      if (code !== 0 && numBins === 0) {
        reject(new Error(`ffmpeg 波形包络提取失败 (exit=${code})`));
        return;
      }
      try {
        const outBuf = Buffer.allocUnsafe(16 + numBins * 6);
        outBuf.write('WENV', 0, 4, 'ascii');
        outBuf.writeUInt32LE(1, 4);
        outBuf.writeUInt32LE(5, 8);
        outBuf.writeUInt32LE(numBins, 12);
        for (let i = 0; i < numBins; i++) {
          const base = 16 + i * 6;
          outBuf.writeUInt16LE(triples[i * 3], base);
          outBuf.writeUInt16LE(triples[i * 3 + 1], base + 2);
          outBuf.writeUInt16LE(triples[i * 3 + 2], base + 4);
        }
        const tmpBin = path.join(
          cacheDir,
          `wenv_v1_${hash}_${process.pid}_${Date.now()}.tmp`
        );
        fs.writeFileSync(tmpBin, outBuf);
        fs.renameSync(tmpBin, outBin);
        resolve(outBin);
      } catch (writeErr) {
        reject(writeErr);
      }
    });
  }).finally(() => {
    inFlightWaveformEnv.delete(outBin);
  });

  inFlightWaveformEnv.set(outBin, job);
  return job;
}

function podcraftLocalSidecarPlugin(): Plugin {
  const configure = (middlewares: {
    use: (
      route: string,
      fn: (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
        next: () => void
      ) => void
    ) => void;
  }) => {
    // 1. Save browser-selected audio File to /tmp/podcraft_web_uploads for local neural ASR & streaming
    middlewares.use('/api/upload-track', (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }
      const reqUrl = new URL(req.url ?? '/api/upload-track', 'http://localhost');
      const rawName = reqUrl.searchParams.get('name') || 'track.wav';
      const safeName = rawName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_');
      const uploadDir = '/tmp/podcraft_web_uploads';
      fs.mkdirSync(uploadDir, { recursive: true });
      const targetPath = path.join(
        uploadDir,
        `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safeName}`
      );

      const writeStream = fs.createWriteStream(targetPath);
      req.pipe(writeStream);
      writeStream.on('finish', () => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, filePath: targetPath }));
      });
      writeStream.on('error', (err) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      });
    });

    // 1b. High-resolution 5ms (200Hz) bipolar + RMS waveform envelope endpoint (cached binary WENV v1)
    middlewares.use('/api/waveform-envelope', async (req, res, next) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const reqUrl = new URL(req.url ?? '/api/waveform-envelope', 'http://localhost');
      const rawPath = reqUrl.searchParams.get('path') || '';
      if (!rawPath || !fs.existsSync(rawPath) || !fs.statSync(rawPath).isFile()) {
        res.statusCode = 404;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end('Audio file not found');
        return;
      }
      try {
        const binPath = await getOrBuildNodeWaveformEnvelopeBin(rawPath);
        const stat = fs.statSync(binPath);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(binPath, { highWaterMark: 131072 }).pipe(res);
        }
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(String(err));
        }
      }
    });

    // 2. HTTP 206 Byte-Range local audio streaming endpoint for smooth seeking & reopened .podcraft files
    middlewares.use('/api/audio-stream', (req, res, next) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        });
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const reqUrl = new URL(req.url ?? '/api/audio-stream', 'http://localhost');
      const rawPath = reqUrl.searchParams.get('path') || '';
      const forceTranscode = reqUrl.searchParams.get('transcode') === 'wav';
      const useProxy = reqUrl.searchParams.get('proxy') === '1' || reqUrl.searchParams.get('proxy') === 'true';
      const chunkParam = reqUrl.searchParams.get('chunk');
      if (!rawPath || !fs.existsSync(rawPath)) {
        res.statusCode = 404;
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end('Audio file not found');
        return;
      }

      const servePath = useProxy
        ? transcodeToCachedProxyWav(rawPath)
        : forceTranscode || needsPlaybackWavTranscode(rawPath)
          ? transcodeToCachedPlaybackWav(rawPath)
          : rawPath;

      if (useProxy && chunkParam !== null) {
        const chunkIdx = Math.max(0, parseInt(chunkParam, 10) || 0);
        const hdrInfo = probeWavHeaderNode(servePath);
        if (hdrInfo) {
          const bytesPerSec = hdrInfo.sampleRate * hdrInfo.blockAlign;
          const startByte = hdrInfo.dataOffset + chunkIdx * 30 * bytesPerSec;
          const fileStat = fs.statSync(servePath);
          if (startByte < fileStat.size) {
            const avail = Math.min(fileStat.size - startByte, 32 * bytesPerSec);
            const pcmBuf = Buffer.allocUnsafe(avail);
            const fd = fs.openSync(servePath, 'r');
            try {
              fs.readSync(fd, pcmBuf, 0, avail, startByte);
            } finally {
              fs.closeSync(fd);
            }
            const wavHdr = Buffer.alloc(44);
            wavHdr.write('RIFF', 0);
            wavHdr.writeUInt32LE(36 + avail, 4);
            wavHdr.write('WAVE', 8);
            wavHdr.write('fmt ', 12);
            wavHdr.writeUInt32LE(16, 16);
            wavHdr.writeUInt16LE(1, 20);
            wavHdr.writeUInt16LE(hdrInfo.channels, 22);
            wavHdr.writeUInt32LE(hdrInfo.sampleRate, 24);
            wavHdr.writeUInt32LE(bytesPerSec, 28);
            wavHdr.writeUInt16LE(hdrInfo.blockAlign, 32);
            wavHdr.writeUInt16LE(hdrInfo.bitsPerSample, 34);
            wavHdr.write('data', 36);
            wavHdr.writeUInt32LE(avail, 40);
            const outBuf = Buffer.concat([wavHdr, pcmBuf]);
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', String(outBuf.length));
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.end(outBuf);
            return;
          }
        }
      }

      const stat = fs.statSync(servePath);
      const total = stat.size;
      const mime = inferAudioMime(servePath);
      const range = req.headers.range;
      const isHead = req.method === 'HEAD';

      if (range && total > 0) {
        const firstRange = range.replace(/bytes=/, '').split(',')[0] || '';
        const parts = firstRange.split('-');
        const start = parts[0]
          ? Math.max(0, parseInt(parts[0], 10) || 0)
          : Math.max(0, total - (parseInt(parts[1], 10) || 0));
        const end =
          parts[0] && parts[1]
            ? Math.min(total - 1, parseInt(parts[1], 10))
            : total - 1;
        if (start >= total || start > end) {
          res.writeHead(416, {
            'Access-Control-Allow-Origin': '*',
            'Content-Range': `bytes */${total}`,
          });
          res.end();
          return;
        }
        const chunkSize = Math.max(0, end - start + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
          'Cache-Control': 'public, max-age=3600',
        });
        if (isHead) {
          res.end();
        } else {
          fs.createReadStream(servePath, { start, end, highWaterMark: 131072 }).pipe(res);
        }
      } else {
        res.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': total,
          'Content-Type': mime,
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
          'Cache-Control': 'public, max-age=3600',
        });
        if (isHead) {
          res.end();
        } else {
          fs.createReadStream(servePath, { highWaterMark: 131072 }).pipe(res);
        }
      }
    });

    // 2b. Unified Sample-Accurate Virtual Mix Config & Byte-Range Stream (Vite dev parity)
    middlewares.use('/api/audio-mix-config', (req, res, next) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        next();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const spec = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
            recordingMode?: string;
            loudnessAligned?: boolean;
            autoSoloMode?: string;
            duckAttenuationDb?: number;
            deClickEnabled?: boolean;
            deClickStrength?: string;
            bgmDuckDb?: number;
            coldOpenEnabled?: boolean;
            coldOpenDurationSec?: number;
            introVoiceoverDurationSec?: number;
            totalEditedDurationSec?: number;
            tracks?: Array<{
              id: string;
              filePath: string;
              syncOffsetMs?: number;
              autoGainDb?: number;
              muted?: boolean;
              solo?: boolean;
            }>;
            playbackSpans?: Array<{
              editedStartSec: number;
              editedEndSec: number;
              sourceStartSec: number;
              sourceEndSec: number;
            }>;
            highlights?: Array<{ sourceStartMs: number; durationSec: number }>;
            introVoiceover?: { filePath: string; durationSec?: number; enabled?: boolean } | null;
            introBgm?: { filePath: string; durationSec?: number; enabled?: boolean } | null;
            outroBgm?: { filePath: string; durationSec?: number; enabled?: boolean } | null;
            activeIntervals?: Array<{ trackId: string; startMs: number; endMs: number }>;
            primaryIntervals?: Array<{ trackId: string; startMs: number; endMs: number }>;
            laughterRanges?: Array<{ startMs: number; endMs: number }>;
            trackMutes?: Array<{ trackId: string; startMs: number; endMs: number }>;
            mouthClickRanges?: Array<{ trackId: string; startMs: number; endMs: number }>;
            bleepRanges?: Array<{ startMs: number; endMs: number }>;
          };

          const rawTracks = spec.tracks ?? [];
          const anySolo = rawTracks.some((t) => Boolean(t.solo));
          const activeById = new Map<string, Array<[number, number]>>();
          for (const iv of spec.activeIntervals ?? []) {
            const arr = activeById.get(iv.trackId) ?? [];
            arr.push([iv.startMs, iv.endMs]);
            activeById.set(iv.trackId, arr);
          }
          const primaryById = new Map<string, Array<[number, number]>>();
          for (const iv of spec.primaryIntervals ?? []) {
            const arr = primaryById.get(iv.trackId) ?? [];
            arr.push([iv.startMs, iv.endMs]);
            primaryById.set(iv.trackId, arr);
          }
          const mutesById = new Map<string, Array<[number, number]>>();
          for (const iv of spec.trackMutes ?? []) {
            const arr = mutesById.get(iv.trackId) ?? [];
            arr.push([iv.startMs, iv.endMs]);
            mutesById.set(iv.trackId, arr);
          }
          const clicksById = new Map<string, Array<[number, number]>>();
          for (const iv of spec.mouthClickRanges ?? []) {
            const arr = clicksById.get(iv.trackId) ?? [];
            arr.push([iv.startMs, iv.endMs]);
            clicksById.set(iv.trackId, arr);
          }

          const preparedTracks: NodePreparedTrack[] = rawTracks.map((tr) => {
            const { wavPath, hdr } = resolveNodePcm48k(tr.filePath);
            const offsetMs = spec.recordingMode === 'same_room_sync' ? 0 : (tr.syncOffsetMs || 0);
            const mutedOrUnsoloed = Boolean(tr.muted) || (anySolo && !tr.solo);
            const baseGain = mutedOrUnsoloed
              ? 0
              : spec.loudnessAligned !== false
              ? Math.min(1.65, 0.9 * Math.pow(10, Math.max(-12, Math.min(8, tr.autoGainDb || 0)) / 20))
              : 0.9;
            return {
              id: tr.id,
              wavPath,
              hdr,
              offsetFrames: Math.round((offsetMs * 48000) / 1000),
              baseGain,
              mutedOrUnsoloed,
              activeIntervals: mergeNodeRanges(activeById.get(tr.id) ?? []),
              primaryIntervals: mergeNodeRanges(primaryById.get(tr.id) ?? []),
              trackMutes: mergeNodeRanges(mutesById.get(tr.id) ?? []),
              mouthClickRanges: mergeNodeRanges(clicksById.get(tr.id) ?? []),
            };
          });

          const resolveAuxNode = (
            aux?: { filePath: string; durationSec?: number; enabled?: boolean } | null
          ): NodePreparedAux | null => {
            if (!aux || !aux.enabled || !aux.filePath) return null;
            try {
              const { wavPath, hdr } = resolveNodePcm48k(aux.filePath);
              const frames48k =
                aux.durationSec && aux.durationSec > 0.05
                  ? Math.round(aux.durationSec * 48000)
                  : hdr.totalFrames;
              return { wavPath, hdr, frames48k: Math.max(1, frames48k) };
            } catch {
              return null;
            }
          };

          const regions: NodeRegion[] = [];
          const coldEndFrame = Math.round(Math.max(0, spec.coldOpenDurationSec || 0) * 48000);
          const introVoFrames = Math.round(Math.max(0, spec.introVoiceoverDurationSec || 0) * 48000);
          const prefixEndFrame = coldEndFrame + introVoFrames;

          const hls = spec.highlights ?? [];
          if (spec.coldOpenEnabled && hls.length > 0 && coldEndFrame > 0) {
            let cursorSec = 2.0;
            regions.push({ kind: 'idle', startF: 0, endF: 96000 });
            for (let idx = 0; idx < hls.length; idx++) {
              const hl = hls[idx];
              const sF = Math.round(cursorSec * 48000);
              const eF = Math.round((cursorSec + Math.max(0, hl.durationSec)) * 48000);
              const srcStartF = Math.round((Math.max(0, hl.sourceStartMs) * 48000) / 1000);
              if (eF > sF) {
                regions.push({
                  kind: 'hl',
                  startF: Math.min(sF, coldEndFrame),
                  endF: Math.min(eF, coldEndFrame),
                  srcStartF,
                  sliceFrames: eF - sF,
                });
              }
              cursorSec += Math.max(0, hl.durationSec);
              if (idx + 1 < hls.length) {
                const gs = Math.round(cursorSec * 48000);
                cursorSec += 0.65;
                const ge = Math.min(Math.round(cursorSec * 48000), coldEndFrame);
                if (ge > gs) regions.push({ kind: 'idle', startF: gs, endF: ge });
              }
            }
            const tailStart = Math.min(Math.round(cursorSec * 48000), coldEndFrame);
            if (coldEndFrame > tailStart) {
              regions.push({ kind: 'idle', startF: tailStart, endF: coldEndFrame });
            }
          }

          if (introVoFrames > 0) {
            regions.push({ kind: 'intro_vo', startF: coldEndFrame, endF: prefixEndFrame });
          }

          let lastSpanEndF = prefixEndFrame;
          const spans = spec.playbackSpans ?? [];
          for (let i = 0; i < spans.length; i++) {
            const sp = spans[i];
            const es = Math.round(Math.max(0, sp.editedStartSec) * 48000);
            const ee = Math.round(Math.max(sp.editedStartSec, sp.editedEndSec) * 48000);
            if (ee <= es) continue;
            if (es > lastSpanEndF) {
              regions.push({ kind: 'idle', startF: lastSpanEndF, endF: es });
            }
            const prevSrcEndF = i > 0 ? Math.round(Math.max(0, spans[i - 1].sourceEndSec) * 48000) : null;
            const xfadeFrames = i > 0 ? Math.min(1728, Math.floor((ee - es) / 3)) : 0;
            regions.push({
              kind: 'span',
              startF: es,
              endF: ee,
              srcStartF: Math.round(Math.max(0, sp.sourceStartSec) * 48000),
              prevSrcEndF,
              xfadeFrames,
            });
            lastSpanEndF = Math.max(lastSpanEndF, ee);
          }

          const totalFrames = Math.max(
            1,
            lastSpanEndF,
            Math.round(Math.max(0, spec.totalEditedDurationSec || 0) * 48000)
          );
          if (totalFrames > lastSpanEndF) {
            regions.push({ kind: 'idle', startF: lastSpanEndF, endF: totalFrames });
          }

          const totalDurSec = totalFrames / 48000;
          const prefixSec = prefixEndFrame / 48000;
          const introEndSec = prefixSec > 0 ? prefixSec : Math.min(10, totalDurSec * 0.35);
          const outroWin = Math.min(12, Math.max(4, totalDurSec * 0.25));
          const outroStartSec =
            totalDurSec > 4 ? Math.max(introEndSec + 0.5, totalDurSec - outroWin) : totalDurSec + 1;

          const rev = nodeLiveMixNextRev++;
          const totalPcmBytes = totalFrames * 2;
          const autoSoloMode = spec.autoSoloMode || 'natural_ducking';
          const rawDuck = Math.pow(10, (spec.duckAttenuationDb ?? -16) / 20);
          const duckLinear =
            autoSoloMode === 'natural_ducking' ? Math.min(0.55, Math.max(0.10, rawDuck)) : 0.06;

          const prepared: NodePreparedMix = {
            rev,
            totalFrames,
            totalWavLen: 44 + totalPcmBytes,
            wavHeader: buildWav48kMonoHeader(totalPcmBytes),
            autoSoloMode,
            duckLinear,
            deClickEnabled: spec.deClickEnabled !== false,
            deClickStrong: spec.deClickStrength === 'strong',
            bgmDuckLinear: Math.min(0.85, Math.max(0.04, Math.pow(10, (spec.bgmDuckDb ?? -18) / 20))),
            introEndFrame: Math.round(introEndSec * 48000),
            outroStartFrame: Math.round(outroStartSec * 48000),
            tracks: preparedTracks,
            introVo: introVoFrames > 0 ? resolveAuxNode(spec.introVoiceover) : null,
            introBgm: resolveAuxNode(spec.introBgm),
            outroBgm: resolveAuxNode(spec.outroBgm),
            regions,
            laughterRanges: mergeNodeRanges((spec.laughterRanges ?? []).map((r) => [r.startMs, r.endMs])),
            bleepRanges: mergeNodeRanges((spec.bleepRanges ?? []).map((r) => [r.startMs, r.endMs])),
          };
          nodeLiveMixRevisions.push(prepared);
          if (nodeLiveMixRevisions.length > 4) nodeLiveMixRevisions.shift();

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(
            JSON.stringify({
              ok: true,
              rev,
              totalFrames,
              durationSec: totalFrames / 48000,
            })
          );
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
    });

    middlewares.use('/api/audio-mix', (req, res, next) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type',
          'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        });
        res.end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      const reqUrl = new URL(req.url ?? '/api/audio-mix', 'http://localhost');
      const revParam = Number(reqUrl.searchParams.get('rev') || 0);
      const mix =
        (revParam > 0 ? [...nodeLiveMixRevisions].reverse().find((m) => m.rev === revParam) : null) ??
        nodeLiveMixRevisions[nodeLiveMixRevisions.length - 1];
      if (!mix) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*', 'Content-Length': 0 });
        res.end();
        return;
      }

      const total = mix.totalWavLen;
      const range = req.headers.range;
      let start = 0;
      let end = total - 1;
      let isPartial = false;

      if (range && total > 0) {
        const firstRange = range.replace(/bytes=/, '').split(',')[0] || '';
        const parts = firstRange.split('-');
        start = parts[0]
          ? Math.max(0, parseInt(parts[0], 10) || 0)
          : Math.max(0, total - (parseInt(parts[1], 10) || 0));
        end = parts[0] && parts[1] ? Math.min(total - 1, parseInt(parts[1], 10)) : total - 1;
        if (start >= total || start > end) {
          res.writeHead(416, { 'Access-Control-Allow-Origin': '*', 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        isPartial = true;
      }

      const chunkSize = Math.max(0, end - start + 1);
      res.writeHead(isPartial ? 206 : 200, {
        ...(isPartial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/wav',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
        'Cache-Control': 'public, max-age=3600',
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const trackFds = mix.tracks.map((t) =>
        t.mutedOrUnsoloed ? -1 : fs.openSync(t.wavPath, 'r')
      );
      const introVoFd = mix.introVo ? fs.openSync(mix.introVo.wavPath, 'r') : -1;
      const introBgmFd = mix.introBgm ? fs.openSync(mix.introBgm.wavPath, 'r') : -1;
      const outroBgmFd = mix.outroBgm ? fs.openSync(mix.outroBgm.wavPath, 'r') : -1;
      let closed = false;
      const closeFds = () => {
        if (closed) return;
        closed = true;
        for (const fd of trackFds) if (fd >= 0) try { fs.closeSync(fd); } catch {}
        for (const fd of [introVoFd, introBgmFd, outroBgmFd]) if (fd >= 0) try { fs.closeSync(fd); } catch {}
      };
      req.on('close', closeFds);
      res.on('close', closeFds);

      let cursor = start;
      if (cursor < 44) {
        const hdrEnd = Math.min(44, end + 1);
        res.write(mix.wavHeader.subarray(cursor, hdrEnd));
        cursor = hdrEnd;
      }

      const findRegion = (f: number): NodeRegion | null => {
        let lo = 0;
        let hi = mix.regions.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (mix.regions[mid].endF <= f) lo = mid + 1;
          else hi = mid;
        }
        return mix.regions[Math.min(lo, Math.max(0, mix.regions.length - 1))] ?? null;
      };

      const pumpNext = () => {
        if (closed || cursor > end) {
          closeFds();
          if (!res.writableEnded) res.end();
          return;
        }
        const pcmOff = cursor - 44;
        const frameStart = Math.floor(pcmOff / 2);
        if (frameStart >= mix.totalFrames) {
          closeFds();
          if (!res.writableEnded) res.end();
          return;
        }
        const remBytes = end - cursor + 1;
        const framesNeeded = Math.min(
          16384,
          mix.totalFrames - frameStart,
          Math.ceil(((pcmOff % 2) + remBytes) / 2)
        );
        const evalStart = Math.floor(Math.max(0, frameStart - 7200) / 480) * 480;
        const evalEnd = Math.min(mix.totalFrames, frameStart + framesNeeded);
        const totalEval = evalEnd - evalStart;
        const skipPre = frameStart - evalStart;
        const voiceEval = new Float32Array(totalEval);
        const voiceActive = new Uint8Array(totalEval);
        const bgmEval = new Float32Array(totalEval);
        const gateG = new Float32Array(mix.tracks.length).fill(-1);
        const preGateG = new Float32Array(mix.tracks.length).fill(1);
        const hpX1 = new Float32Array(mix.tracks.length);
        const hpY1 = new Float32Array(mix.tracks.length);
        const tailHpX1 = new Float32Array(mix.tracks.length);
        const tailHpY1 = new Float32Array(mix.tracks.length);
        const noiseFloor = new Float32Array(mix.tracks.length).fill(0.0025);
        const holdRem = new Int32Array(mix.tracks.length);
        const trBufs = mix.tracks.map(() => new Float32Array(16384));
        const xfBuf = new Float32Array(1728);
        const hpfAlpha = 0.988996;
        const coeffAtt = 1 / (0.0025 * 48000);
        const coeffRel = 1 / (0.045 * 48000);
        const activeCount = mix.tracks.filter((t) => !t.mutedOrUnsoloed).length;
        const useAutomix = activeCount > 1 && mix.autoSoloMode !== 'off';
        const overlapDuckLinear =
          mix.autoSoloMode === 'hard_mute'
            ? mix.duckLinear
            : Math.min(0.38, Math.max(0.22, mix.duckLinear * 2.0));
        const singleBleedGain =
          mix.autoSoloMode === 'hard_mute'
            ? 0.02
            : Math.min(0.095, Math.max(0.045, mix.duckLinear * 0.45));
        const idleNoiseGain = mix.autoSoloMode === 'hard_mute' ? 0.18 : 0.28;

        const mixRun = (srcStartF: number, len: number, outOff: number) => {
          for (let ti = 0; ti < mix.tracks.length; ti++) {
            if (trackFds[ti] >= 0) {
              const adj = Math.max(0, srcStartF - mix.tracks[ti].offsetFrames);
              const b = trBufs[ti].subarray(0, len);
              readMono48kFramesNode(trackFds[ti], mix.tracks[ti].hdr, adj, b);
              let x1 = hpX1[ti];
              let y1 = hpY1[ti];
              for (let k = 0; k < len; k++) {
                const x = b[k];
                const y = hpfAlpha * (y1 + x - x1);
                x1 = x;
                y1 = y;
                b[k] = y;
              }
              hpX1[ti] = x1;
              hpY1[ti] = y1;
            } else {
              trBufs[ti].fill(0, 0, len);
            }
          }
          for (let pos = 0; pos < len; pos += 480) {
            const subEnd = Math.min(len, pos + 480);
            const subLen = subEnd - pos;
            const lookEnd = Math.min(len, subEnd + 240);
            const rmsArr = new Float32Array(mix.tracks.length);
            const isPriArr = new Uint8Array(mix.tracks.length);
            let anyPrimary = false;
            let maxRms = 0;
            if (useAutomix) {
              for (let ti = 0; ti < mix.tracks.length; ti++) {
                const tr = mix.tracks[ti];
                if (tr.mutedOrUnsoloed) continue;
                let sq = 0;
                const b = trBufs[ti];
                for (let j = pos; j < subEnd; j++) {
                  const gs = b[j] * tr.baseGain;
                  sq += gs * gs;
                }
                const rmsCur = Math.sqrt(sq / Math.max(1, subLen));
                let sqLook = 0;
                for (let j = subEnd; j < lookEnd; j++) {
                  const gs = b[j] * tr.baseGain;
                  sqLook += gs * gs;
                }
                const lTail = Math.max(0, lookEnd - subEnd);
                const rmsEff = lTail > 0 ? Math.max(rmsCur, Math.sqrt(sqLook / lTail)) : rmsCur;
                rmsArr[ti] = rmsEff;
                if (rmsEff > maxRms) maxRms = rmsEff;
                if (rmsCur < noiseFloor[ti]) {
                  noiseFloor[ti] = Math.max(0.0002, 0.75 * noiseFloor[ti] + 0.25 * rmsCur);
                } else if (rmsCur < 0.016) {
                  noiseFloor[ti] = Math.min(0.008, 0.992 * noiseFloor[ti] + 0.008 * rmsCur);
                }
                const trMs = Math.floor((Math.max(0, srcStartF + pos - tr.offsetFrames) * 1000) / 48000);
                if (nodeRangeHas(tr.primaryIntervals, trMs, 120, 260)) {
                  isPriArr[ti] = 1;
                  anyPrimary = true;
                }
              }
            }
            for (let ti = 0; ti < mix.tracks.length; ti++) {
              const tr = mix.tracks[ti];
              if (tr.mutedOrUnsoloed) continue;
              const trMs = Math.floor((Math.max(0, srcStartF + pos - tr.offsetFrames) * 1000) / 48000);
              let tgt = 1;
              if (useAutomix) {
                const eff = rmsArr[ti];
                const floorThr = Math.max(0.011, noiseFloor[ti] * 3.1);
                const domRatio = maxRms > 1e-6 ? eff / maxRms : 1;
                const trActive = nodeRangeHas(tr.activeIntervals, trMs, 80, 180);
                const indepSpeech = eff >= floorThr && (maxRms < 0.018 || domRatio >= 0.35);
                if (anyPrimary) {
                  if (isPriArr[ti]) {
                    tgt = eff >= floorThr * 0.7 || trActive ? 1 : Math.max(0.45, idleNoiseGain);
                  } else if (maxRms >= 0.016 && domRatio < 0.35) {
                    tgt = singleBleedGain;
                  } else if (eff >= 0.014 || trActive) {
                    tgt = overlapDuckLinear;
                  } else {
                    tgt = singleBleedGain;
                  }
                } else if (maxRms >= 0.014) {
                  if (domRatio >= 0.7 || indepSpeech) {
                    holdRem[ti] = 7680;
                    tgt = 1;
                  } else if (holdRem[ti] > 0 && domRatio >= 0.22) {
                    holdRem[ti] = Math.max(0, holdRem[ti] - subLen);
                    tgt = 1;
                  } else {
                    holdRem[ti] = 0;
                    tgt = singleBleedGain;
                  }
                } else {
                  holdRem[ti] = Math.max(0, holdRem[ti] - subLen);
                  tgt = holdRem[ti] > 0 ? 1 : idleNoiseGain;
                }
              }
              let muteG = 1;
              if (nodeRangeHas(tr.trackMutes, trMs, 0, 0)) muteG = 0;
              let g = gateG[ti] < 0 ? tgt : gateG[ti];
              const c = tgt > g ? coeffAtt : coeffRel;
              const stat = tr.baseGain * muteG;
              const srcB = trBufs[ti];
              for (let j = pos; j < subEnd; j++) {
                g += c * (tgt - g);
                voiceEval[outOff + j] += srcB[j] * stat * g;
              }
              gateG[ti] = g;
            }
          }
        };

        let cf = evalStart;
        while (cf < evalEnd) {
          const reg = findRegion(cf);
          if (!reg) break;
          const segEnd = Math.min(evalEnd, reg.endF);
          if (segEnd <= cf) {
            cf++;
            continue;
          }
          const segLen = segEnd - cf;
          const evOff = cf - evalStart;
          if (reg.kind === 'intro_vo' && introVoFd >= 0 && mix.introVo) {
            const auxTmp = new Float32Array(segLen);
            readMono48kFramesNode(introVoFd, mix.introVo.hdr, cf - reg.startF, auxTmp);
            for (let k = 0; k < segLen; k++) {
              voiceEval[evOff + k] = auxTmp[k] * 0.94;
              voiceActive[evOff + k] = 1;
            }
          } else if (reg.kind === 'hl') {
            const ls = cf - reg.startF;
            const ff = Math.min(1152, Math.floor(reg.sliceFrames / 4));
            for (let done = 0; done < segLen; done += 16384) {
              const ch = Math.min(16384, segLen - done);
              mixRun(reg.srcStartF + ls + done, ch, evOff + done);
              for (let j = 0; j < ch; j++) {
                const lf = ls + done + j;
                let env = 1;
                if (ff > 0 && lf < ff) env = Math.sin((lf / ff) * (Math.PI / 2));
                else if (ff > 0 && lf >= reg.sliceFrames - ff) env = Math.sin(((reg.sliceFrames - lf) / ff) * (Math.PI / 2));
                voiceEval[evOff + done + j] *= env;
                voiceActive[evOff + done + j] = 1;
              }
            }
          } else if (reg.kind === 'span') {
            const ls = cf - reg.startF;
            for (let done = 0; done < segLen; done += 16384) {
              const ch = Math.min(16384, segLen - done);
              const lfStart = ls + done;
              const inXf = reg.prevSrcEndF !== null && reg.xfadeFrames > 0 && lfStart < reg.xfadeFrames;
              if (inXf) {
                preGateG.set(gateG);
                tailHpX1.set(hpX1);
                tailHpY1.set(hpY1);
              }
              mixRun(reg.srcStartF + lfStart, ch, evOff + done);
              if (reg.prevSrcEndF !== null && inXf) {
                const xfAvail = Math.min(ch, reg.xfadeFrames - lfStart);
                const outTail = new Float32Array(xfAvail);
                for (let ti = 0; ti < mix.tracks.length; ti++) {
                  if (trackFds[ti] >= 0) {
                    const adj = Math.max(0, reg.prevSrcEndF + lfStart - mix.tracks[ti].offsetFrames);
                    readMono48kFramesNode(trackFds[ti], mix.tracks[ti].hdr, adj, xfBuf.subarray(0, xfAvail));
                    const g = mix.tracks[ti].baseGain * (preGateG[ti] < 0 ? 1 : preGateG[ti]);
                    let tx1 = tailHpX1[ti];
                    let ty1 = tailHpY1[ti];
                    for (let j = 0; j < xfAvail; j++) {
                      const tx = xfBuf[j];
                      const ty = hpfAlpha * (ty1 + tx - tx1);
                      tx1 = tx;
                      ty1 = ty;
                      outTail[j] += ty * g;
                    }
                  }
                }
                for (let j = 0; j < xfAvail; j++) {
                  const theta = ((lfStart + j + 0.5) / reg.xfadeFrames) * (Math.PI / 2);
                  voiceEval[evOff + done + j] =
                    outTail[j] * Math.cos(theta) + voiceEval[evOff + done + j] * Math.sin(theta);
                }
              }
              voiceActive.fill(1, evOff + done, evOff + done + ch);
            }
          }
          cf = segEnd;
        }

        if (introBgmFd >= 0 && mix.introBgm && evalStart <= mix.introEndFrame) {
          const ovEnd = Math.min(evalEnd, mix.introEndFrame);
          const cnt = ovEnd - evalStart;
          if (cnt > 0) {
            const bgmTmp = new Float32Array(cnt);
            const modS = evalStart % mix.introBgm.frames48k;
            const firstP = Math.min(cnt, mix.introBgm.frames48k - modS);
            readMono48kFramesNode(introBgmFd, mix.introBgm.hdr, modS, bgmTmp.subarray(0, firstP));
            if (firstP < cnt) readMono48kFramesNode(introBgmFd, mix.introBgm.hdr, 0, bgmTmp.subarray(firstP));
            for (let i = 0; i < cnt; i++) {
              const voiceOn = voiceActive[i] && Math.abs(voiceEval[i]) > 0.012;
              bgmEval[i] += bgmTmp[i] * 0.45 * (voiceOn ? mix.bgmDuckLinear : 1);
            }
          }
        }
        if (outroBgmFd >= 0 && mix.outroBgm && evalEnd > mix.outroStartFrame) {
          const ovStart = Math.max(evalStart, mix.outroStartFrame);
          const cnt = evalEnd - ovStart;
          if (cnt > 0) {
            const bgmTmp = new Float32Array(cnt);
            const relS = ovStart - mix.outroStartFrame;
            const modS = relS % mix.outroBgm.frames48k;
            const firstP = Math.min(cnt, mix.outroBgm.frames48k - modS);
            readMono48kFramesNode(outroBgmFd, mix.outroBgm.hdr, modS, bgmTmp.subarray(0, firstP));
            if (firstP < cnt) readMono48kFramesNode(outroBgmFd, mix.outroBgm.hdr, 0, bgmTmp.subarray(firstP));
            const evBase = ovStart - evalStart;
            for (let i = 0; i < cnt; i++) {
              const voiceOn = voiceActive[evBase + i] && Math.abs(voiceEval[evBase + i]) > 0.012;
              bgmEval[evBase + i] += bgmTmp[i] * 0.45 * (voiceOn ? mix.bgmDuckLinear : 1);
            }
          }
        }

        const copyFrames = Math.min(framesNeeded, Math.max(0, totalEval - skipPre));
        const pcmChunk = Buffer.allocUnsafe(copyFrames * 2);
        for (let i = 0; i < copyFrames; i++) {
          let s = voiceEval[skipPre + i] + bgmEval[skipPre + i];
          if (Math.abs(s) > 0.85) {
            s = Math.sign(s) * (0.85 + 0.15 * Math.tanh((Math.abs(s) - 0.85) / 0.15));
          }
          pcmChunk.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
        }

        const skipB = pcmOff % 2;
        const availB = Math.max(0, pcmChunk.length - skipB);
        const sendB = Math.min(availB, remBytes);
        if (sendB <= 0) {
          closeFds();
          if (!res.writableEnded) res.end();
          return;
        }
        const ok = res.write(pcmChunk.subarray(skipB, skipB + sendB));
        cursor += sendB;
        if (ok) setImmediate(pumpNext);
        else res.once('drain', pumpNext);
      };

      pumpNext();
    });

    // 3. Real-time streaming NDJSON sidecar endpoint (streams PROGRESS:{...} lines immediately!)
    middlewares.use('/api/sidecar', (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }
      const reqUrl = new URL(req.url ?? '/api/sidecar', 'http://localhost');
      const streamMode = reqUrl.searchParams.get('stream') === '1';

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const payloadStr = Buffer.concat(chunks).toString('utf-8');
        const pyBin = resolvePythonBin();
        const scriptPath = path.join(ROOT_DIR, 'sidecar', 'podcraft_ai.py');

        const child = spawn(pyBin, ['-u', scriptPath], {
          cwd: ROOT_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (streamMode) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders?.();
        }

        let stdoutBuf = '';
        let stderrBuf = '';
        child.stdout.on('data', (d: Buffer) => {
          const text = d.toString('utf-8');
          stdoutBuf += text;
          if (streamMode) {
            res.write(text);
          }
        });
        child.stderr.on('data', (d: Buffer) => {
          stderrBuf += d.toString('utf-8');
        });
        child.on('error', (err) => {
          const errJson = JSON.stringify({ ok: false, error: String(err) });
          if (streamMode) {
            res.end(`\n${errJson}\n`);
          } else {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(errJson);
          }
        });
        child.on('close', () => {
          const lines = stdoutBuf
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('PROGRESS:'));
          const finalJson = lines[lines.length - 1];

          if (streamMode) {
            if (!finalJson) {
              res.write(
                `\n${JSON.stringify({
                  ok: false,
                  error: stderrBuf.trim() || 'Python AI Sidecar 未返回 JSON 结果',
                })}\n`
              );
            }
            res.end();
            return;
          }

          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          if (finalJson) {
            res.statusCode = 200;
            res.end(finalJson);
          } else {
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                ok: false,
                error: stderrBuf.trim() || 'Python AI Sidecar 未返回 JSON 结果',
              })
            );
          }
        });

        child.stdin.write(payloadStr);
        child.stdin.end();
      });
    });

    // 4. Browser-mode Mastered MP3 Export endpoint (FFmpeg multi-track mix + EDL cut + -16 LUFS 192k MP3)
    middlewares.use('/api/export-mp3', (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const exportDir = '/tmp/podcraft_exports';
        fs.mkdirSync(exportDir, { recursive: true });
        const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const mixWavPath = path.join(exportDir, `mix_${jobId}.wav`);
        const edlWavPath = path.join(exportDir, `edl_${jobId}.wav`);
        const outMp3Path = path.join(exportDir, `master_${jobId}.mp3`);

        const cleanupTemp = () => {
          for (const p of [mixWavPath, edlWavPath, outMp3Path]) {
            try {
              if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch {
              // ignore cleanup errors
            }
          }
        };

        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
            tracks?: Array<{ filePath: string; syncOffsetMs?: number; autoGainDb?: number }>;
            keepSegments?: Array<{
              sourceStartMs: number;
              sourceEndMs: number;
              pauseAfterMs?: number;
            }>;
            muteRanges?: Array<{ startMs: number; endMs: number }>;
            loudnessAligned?: boolean;
            deClickEnabled?: boolean;
            deClickStrength?: 'medium' | 'strong';
            introVoiceoverPath?: string;
          };

          const validTracks = (payload.tracks ?? []).filter(
            (t) => t.filePath && fs.existsSync(t.filePath)
          );
          if (validTracks.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: '未找到有效的本地音轨文件，请重新导入音频' }));
            return;
          }

          const ffmpegBin = resolveFfmpegBin();
          const mixArgs: string[] = ['-nostdin', '-loglevel', 'error', '-y'];
          const filterParts: string[] = [];

          validTracks.forEach((tr, idx) => {
            mixArgs.push('-i', tr.filePath);
            const chain: string[] = [
              'aresample=48000',
              'aformat=sample_fmts=fltp:channel_layouts=stereo',
            ];
            if (payload.deClickEnabled !== false) {
              if (payload.deClickStrength === 'strong') {
                chain.push(
                  'highpass=f=85',
                  'adeclick=w=55:o=75:a=2:t=1.6:b=2',
                  'equalizer=f=6200:t=q:w=2.4:g=-3.5'
                );
              } else {
                chain.push('highpass=f=80', 'adeclick=w=45:o=75:a=2:t=2.2:b=2');
              }
            }
            const offsetMs = Math.round(tr.syncOffsetMs || 0);
            if (offsetMs > 0) {
              chain.push(`adelay=${offsetMs}|${offsetMs}`);
            } else if (offsetMs < 0) {
              chain.push(`atrim=start=${(-offsetMs / 1000).toFixed(3)}`, 'asetpts=PTS-STARTPTS');
            }
            const gainDb = Number(tr.autoGainDb || 0);
            if (Math.abs(gainDb) > 0.05) {
              chain.push(`volume=${gainDb.toFixed(2)}dB`);
            }
            filterParts.push(`[${idx}:a]${chain.join(',')}[t${idx}]`);
          });

          if (validTracks.length === 1) {
            mixArgs.push('-filter_complex', filterParts[0], '-map', '[t0]');
          } else {
            const inputsTag = validTracks.map((_, idx) => `[t${idx}]`).join('');
            filterParts.push(
              `${inputsTag}amix=inputs=${validTracks.length}:duration=longest:normalize=0[mixout]`
            );
            mixArgs.push('-filter_complex', filterParts.join(';'), '-map', '[mixout]');
          }
          mixArgs.push('-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', mixWavPath);

          const mixRes = spawnSync(ffmpegBin, mixArgs, { encoding: 'utf-8' });
          if (mixRes.status !== 0 || !fs.existsSync(mixWavPath)) {
            throw new Error(`FFmpeg 混音失败: ${mixRes.stderr || 'unknown error'}`);
          }

          sliceEdlStereoWav48k(
            mixWavPath,
            edlWavPath,
            payload.keepSegments ?? [],
            payload.muteRanges ?? []
          );

          const hasIntroVo = Boolean(
            payload.introVoiceoverPath && fs.existsSync(payload.introVoiceoverPath)
          );
          const mp3Args: string[] = ['-nostdin', '-loglevel', 'error', '-y'];
          if (hasIntroVo && payload.introVoiceoverPath) {
            mp3Args.push('-i', payload.introVoiceoverPath, '-i', edlWavPath);
            const postFilter =
              payload.loudnessAligned !== false
                ? ',loudnorm=I=-16:TP=-1.5:LRA=11'
                : '';
            mp3Args.push(
              '-filter_complex',
              `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[vo];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[body];[vo][body]concat=n=2:v=0:a=1${postFilter}[outa]`,
              '-map',
              '[outa]'
            );
          } else {
            mp3Args.push('-i', edlWavPath);
            if (payload.loudnessAligned !== false) {
              mp3Args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
            }
          }
          mp3Args.push('-ar', '48000', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '192k', outMp3Path);

          const mp3Res = spawnSync(ffmpegBin, mp3Args, { encoding: 'utf-8' });
          if (mp3Res.status !== 0 || !fs.existsSync(outMp3Path)) {
            throw new Error(`FFmpeg MP3 编码失败: ${mp3Res.stderr || 'unknown error'}`);
          }

          const stat = fs.statSync(outMp3Path);
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
          });
          const readStream = fs.createReadStream(outMp3Path);
          readStream.on('close', cleanupTemp);
          readStream.on('error', cleanupTemp);
          readStream.pipe(res);
        } catch (err) {
          cleanupTemp();
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
    });
  };

  return {
    name: 'podcraft-local-sidecar-bridge',
    configureServer(server) {
      configure(server.middlewares);
    },
    configurePreviewServer(server) {
      configure(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), podcraftLocalSidecarPlugin()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('lucide-react')) return 'icons-vendor';
            if (id.includes('@tauri-apps')) return 'tauri-vendor';
            if (
              id.includes('react-dom') ||
              id.includes('/react/') ||
              id.includes('scheduler')
            ) {
              return 'react-vendor';
            }
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/.venv/**', '**/models/**'],
    },
  },
});
