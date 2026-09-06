/** Sprint 7 — G.711 mu-law <-> PCM16 conversion at the Twilio Media Streams codec boundary.
 *
 * Twilio Media Streams send/receive 8kHz mono mu-law, base64-encoded per 20ms frame. Everything above
 * this file (VoiceSessionEngine, realtime providers) works exclusively in NormalizedAudioFrame (PCM16) —
 * mu-law never leaks past voice-audio-codec.ts / twilio-voice.provider.ts. Hand-implemented (the
 * standard ITU-T G.711 mu-law algorithm is ~10 lines each direction) rather than pulling in a dependency
 * for it.
 */
import type { NormalizedAudioFrame } from "./voice.types";

export const TWILIO_MEDIA_SAMPLE_RATE_HZ = 8000;

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** One 16-bit PCM sample -> one mu-law byte. */
function pcm16SampleToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, sample));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulawByte;
}

const MULAW_DECODE_TABLE = buildMulawDecodeTable();

function buildMulawDecodeTable(): Int16Array {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const byte = ~i & 0xff;
    const sign = byte & 0x80;
    const exponent = (byte >> 4) & 0x07;
    const mantissa = byte & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    table[i] = sign ? -sample : sample;
  }
  return table;
}

export function pcm16ToMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm16SampleToMulaw(pcm[i] ?? 0);
  return out;
}

export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = MULAW_DECODE_TABLE[mulaw[i] ?? 0] ?? 0;
  return out;
}

export function normalizedFrameFromMulawBase64(base64: string): NormalizedAudioFrame {
  const mulaw = new Uint8Array(Buffer.from(base64, "base64"));
  return { pcm16: mulawToPcm16(mulaw), sampleRateHz: TWILIO_MEDIA_SAMPLE_RATE_HZ };
}

export function mulawBase64FromNormalizedFrame(frame: NormalizedAudioFrame): string {
  if (frame.sampleRateHz !== TWILIO_MEDIA_SAMPLE_RATE_HZ)
    throw new Error(
      `AUDIO_CODEC_ERROR: expected ${TWILIO_MEDIA_SAMPLE_RATE_HZ}Hz for Twilio media, got ${frame.sampleRateHz}Hz`
    );
  return Buffer.from(pcm16ToMulaw(frame.pcm16)).toString("base64");
}
