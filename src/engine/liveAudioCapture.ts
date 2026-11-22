export interface AudioInputDeviceOption {
  deviceId: string;
  label: string;
}

export interface LiveAudioCaptureHandle {
  stop: () => Promise<void>;
  pause: () => void;
  resume: () => void;
}

export interface Downsampler {
  push: (input: Float32Array) => Int16Array;
  reset: () => void;
}

/**
 * Pure box-averaging fractional downsampler (e.g. 48kHz / 44.1kHz -> 16kHz Int16).
 */
export function createDownsampler(inRate: number, outRate = 16000): Downsampler {
  const safeIn = Math.max(8000, inRate);
  const ratio = safeIn / outRate;
  let pos = 0;
  let carry = new Float32Array(0);

  return {
    push(input: Float32Array): Int16Array {
      if (input.length === 0) return new Int16Array(0);
      const buf = new Float32Array(carry.length + input.length);
      buf.set(carry, 0);
      buf.set(input, carry.length);

      const maxOut = Math.floor((buf.length - pos) / ratio);
      if (maxOut <= 0) {
        carry = buf;
        return new Int16Array(0);
      }

      const out = new Int16Array(maxOut);
      let cursor = pos;
      for (let i = 0; i < maxOut; i++) {
        const nextCursor = cursor + ratio;
        const startIdx = Math.floor(cursor);
        const endIdx = Math.min(buf.length, Math.max(startIdx + 1, Math.floor(nextCursor)));
        let sum = 0;
        for (let k = startIdx; k < endIdx; k++) {
          sum += buf[k];
        }
        const sample = sum / (endIdx - startIdx);
        const clamped = Math.max(-1, Math.min(1, sample));
        out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
        cursor = nextCursor;
      }

      const consumed = Math.floor(cursor);
      pos = cursor - consumed;
      carry = buf.slice(consumed);
      return out;
    },
    reset() {
      pos = 0;
      carry = new Float32Array(0);
    },
  };
}

export function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export async function listAudioInputDevices(): Promise<AudioInputDeviceOption[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `麦克风 ${idx + 1}`,
    }));
}

const WORKLET_CODE = `
class TapWaveCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const outRate = (options.processorOptions && options.processorOptions.outRate) || 16000;
    this.ratio = sampleRate / outRate;
    this.pos = 0;
    this.carry = [];
    this.outBuf = new Int16Array(1600);
    this.outLen = 0;
    this.rmsSum = 0;
    this.rmsCnt = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    const buf = this.carry.length ? new Float32Array(this.carry.length + ch.length) : ch;
    if (this.carry.length) {
      buf.set(this.carry, 0);
      buf.set(ch, this.carry.length);
    }
    let cursor = this.pos;
    while (cursor + this.ratio <= buf.length) {
      const next = cursor + this.ratio;
      const s0 = Math.floor(cursor);
      const s1 = Math.min(buf.length, Math.max(s0 + 1, Math.floor(next)));
      let sum = 0;
      for (let k = s0; k < s1; k++) sum += buf[k];
      const v = Math.max(-1, Math.min(1, sum / (s1 - s0)));
      this.rmsSum += v * v;
      this.rmsCnt += 1;
      this.outBuf[this.outLen++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
      if (this.outLen >= 1600) {
        const copy = new Int16Array(this.outBuf);
        const rms = Math.sqrt(this.rmsSum / Math.max(1, this.rmsCnt));
        this.port.postMessage({ pcm: copy.buffer, rms }, [copy.buffer]);
        this.outLen = 0;
        this.rmsSum = 0;
        this.rmsCnt = 0;
      }
      cursor = next;
    }
    const consumed = Math.floor(cursor);
    this.pos = cursor - consumed;
    this.carry = Array.from(buf.subarray(consumed));
    return true;
  }
}
registerProcessor('tapwave-capture-processor', TapWaveCaptureProcessor);
`;

export async function startLiveAudioCapture(opts: {
  deviceId?: string;
  onChunk: (pcm: Int16Array) => void;
  onLevel: (rms: number) => void;
}): Promise<LiveAudioCaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境不支持麦克风采集 (getUserMedia)');
  }

  const audioConstraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (opts.deviceId) {
    audioConstraints.deviceId = { exact: opts.deviceId };
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  const source = ctx.createMediaStreamSource(stream);
  let paused = false;
  let stopped = false;
  let cleanupNode: () => void = () => {};

  if (ctx.audioWorklet) {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'tapwave-capture-processor', {
        processorOptions: { outRate: 16000 },
      });
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      node.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (paused || stopped) return;
        const pcm = new Int16Array(ev.data.pcm);
        opts.onLevel(ev.data.rms);
        opts.onChunk(pcm);
      };
      source.connect(node);
      node.connect(silentGain);
      silentGain.connect(ctx.destination);
      cleanupNode = () => {
        node.port.onmessage = null;
        try {
          source.disconnect();
          node.disconnect();
          silentGain.disconnect();
        } catch {
          // ignore
        }
      };
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
  } else {
    // Fallback for environments without AudioWorklet
    const downsampler = createDownsampler(ctx.sampleRate, 16000);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    let accum: number[] = [];
    proc.onaudioprocess = (ev) => {
      if (paused || stopped) return;
      const input = ev.inputBuffer.getChannelData(0);
      const resampled = downsampler.push(input);
      for (let i = 0; i < resampled.length; i++) {
        accum.push(resampled[i]);
      }
      while (accum.length >= 1600) {
        const chunk = new Int16Array(accum.slice(0, 1600));
        accum = accum.slice(1600);
        let sumSq = 0;
        for (let i = 0; i < chunk.length; i++) {
          const f = chunk[i] / 32768;
          sumSq += f * f;
        }
        opts.onLevel(Math.sqrt(sumSq / chunk.length));
        opts.onChunk(chunk);
      }
    };
    source.connect(proc);
    proc.connect(silentGain);
    silentGain.connect(ctx.destination);
    cleanupNode = () => {
      proc.onaudioprocess = null;
      try {
        source.disconnect();
        proc.disconnect();
        silentGain.disconnect();
      } catch {
        // ignore
      }
    };
  }

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      cleanupNode();
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    },
  };
}
