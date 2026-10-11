/**
 * Local STT Provider
 *
 * Turn detection runs here (energy VAD over the 8kHz mu-law stream), and each
 * finished utterance is posted as a WAV to any OpenAI-compatible
 * /v1/audio/transcriptions endpoint - e.g. yap (Apple Speech), whisper.cpp,
 * faster-whisper-server. No cloud service involved.
 */

import type { RealtimeSTTProvider, RealtimeSTTSession, STTConfig } from './types.js';

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160;        // 20ms at 8kHz
const FRAME_MS = 20;
const PREFIX_FRAMES = 15;         // keep 300ms before speech onset
const ONSET_FRAMES = 3;           // 60ms of speech to start an utterance
const MIN_SPEECH_FRAMES = 10;     // ignore blips shorter than 200ms
const MAX_UTTERANCE_FRAMES = 3000; // force a cut at 60s

export interface LocalSTTOptions {
  apiUrl: string;
  model: string;
  language?: string;
  silenceDurationMs: number;
  vadThreshold: number;
}

export class LocalSTTProvider implements RealtimeSTTProvider {
  readonly name = 'local';
  private options: LocalSTTOptions | null = null;

  initialize(config: STTConfig & { language?: string; vadThreshold?: number }): void {
    if (!config.apiUrl) {
      throw new Error('CALLME_STT_URL required for local STT (an OpenAI-compatible /v1 base URL)');
    }
    this.options = {
      apiUrl: config.apiUrl.replace(/\/+$/, ''),
      model: config.model || 'whisper-1',
      language: config.language,
      silenceDurationMs: config.silenceDurationMs || 800,
      vadThreshold: config.vadThreshold || 400,
    };
    console.error(`STT provider: local (${this.options.apiUrl}, silence: ${this.options.silenceDurationMs}ms, vad: ${this.options.vadThreshold})`);
  }

  createSession(): RealtimeSTTSession {
    if (!this.options) throw new Error('Local STT not initialized');
    return new LocalSTTSession(this.options);
  }
}

// G.711 mu-law -> 16-bit linear
const MULAW_TABLE = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

export class LocalSTTSession implements RealtimeSTTSession {
  private options: LocalSTTOptions;
  private connected = false;
  private pending = new Int16Array(0);      // samples not yet forming a whole frame
  private prefix: Int16Array[] = [];        // recent non-speech frames
  private utterance: Int16Array[] = [];
  private inSpeech = false;
  private onsetCount = 0;
  private speechFrames = 0;
  private silenceFrames = 0;
  private noiseFloor = 0;
  private queue: Promise<void> = Promise.resolve();  // keeps transcripts in order
  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;

  constructor(options: LocalSTTOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) return;

    const decoded = new Int16Array(muLawData.length);
    for (let i = 0; i < muLawData.length; i++) decoded[i] = MULAW_TABLE[muLawData[i]];

    let samples = decoded;
    if (this.pending.length > 0) {
      samples = new Int16Array(this.pending.length + decoded.length);
      samples.set(this.pending);
      samples.set(decoded, this.pending.length);
    }

    let offset = 0;
    for (; offset + FRAME_SAMPLES <= samples.length; offset += FRAME_SAMPLES) {
      this.processFrame(samples.slice(offset, offset + FRAME_SAMPLES));
    }
    this.pending = samples.slice(offset);
  }

  private processFrame(frame: Int16Array): void {
    let sumSquares = 0;
    for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
    const rms = Math.sqrt(sumSquares / frame.length);

    // Speech must clear both the fixed threshold and 3x the line's noise floor
    const isSpeech = rms > Math.max(this.options.vadThreshold, this.noiseFloor * 3);

    if (!this.inSpeech) {
      // Track the noise floor only while nobody is talking
      this.noiseFloor = this.noiseFloor === 0 ? rms : this.noiseFloor * 0.95 + rms * 0.05;
      this.prefix.push(frame);
      if (this.prefix.length > PREFIX_FRAMES) this.prefix.shift();

      this.onsetCount = isSpeech ? this.onsetCount + 1 : 0;
      if (this.onsetCount >= ONSET_FRAMES) {
        this.inSpeech = true;
        this.utterance = this.prefix;
        this.prefix = [];
        this.speechFrames = this.onsetCount;
        this.silenceFrames = 0;
        console.error('[LocalSTT] Speech started');
      }
      return;
    }

    this.utterance.push(frame);
    if (isSpeech) {
      this.speechFrames++;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames++;
    }

    const silenceMs = this.silenceFrames * FRAME_MS;
    if (silenceMs >= this.options.silenceDurationMs || this.utterance.length >= MAX_UTTERANCE_FRAMES) {
      this.endUtterance();
    }
  }

  private endUtterance(): void {
    const frames = this.utterance;
    const speechFrames = this.speechFrames;
    this.inSpeech = false;
    this.utterance = [];
    this.onsetCount = 0;
    this.speechFrames = 0;
    this.silenceFrames = 0;

    if (speechFrames < MIN_SPEECH_FRAMES) {
      console.error('[LocalSTT] Discarding short noise burst');
      return;
    }
    console.error(`[LocalSTT] Speech stopped (${frames.length * FRAME_MS}ms), transcribing...`);

    const pcm = new Int16Array(frames.length * FRAME_SAMPLES);
    frames.forEach((f, i) => pcm.set(f, i * FRAME_SAMPLES));

    this.queue = this.queue.then(async () => {
      try {
        const text = (await this.transcribe(pcm)).trim();
        console.error(`[LocalSTT] Transcript: ${text}`);
        if (text) this.onTranscriptCallback?.(text);
      } catch (error) {
        console.error('[LocalSTT] Transcription failed:', error);
      }
    });
  }

  private async transcribe(pcm: Int16Array): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', this.options.model);
    form.append('response_format', 'json');
    if (this.options.language) form.append('language', this.options.language);

    const response = await fetch(`${this.options.apiUrl}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`STT endpoint returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const body = await response.json() as { text?: string };
    return body.text || '';
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  async waitForTranscript(timeoutMs: number = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onTranscriptCallback = null;
        reject(new Error('Transcript timeout'));
      }, timeoutMs);

      this.onTranscriptCallback = (transcript) => {
        clearTimeout(timeout);
        this.onTranscriptCallback = null;
        resolve(transcript);
      };
    });
  }

  close(): void {
    this.connected = false;
    this.onTranscriptCallback = null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function toWav(pcm: Int16Array): Buffer {
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}
