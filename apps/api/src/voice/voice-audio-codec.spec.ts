import { describe, expect, it } from "vitest";
import {
  mulawBase64FromNormalizedFrame,
  mulawToPcm16,
  normalizedFrameFromMulawBase64,
  pcm16ToMulaw,
  TWILIO_MEDIA_SAMPLE_RATE_HZ
} from "./voice-audio-codec";

describe("voice-audio-codec", () => {
  it("round-trips PCM16 -> mu-law -> PCM16 within the codec's lossy tolerance", () => {
    const original = Int16Array.from([0, 100, -100, 1000, -1000, 16000, -16000, 32000, -32000]);
    const decoded = mulawToPcm16(pcm16ToMulaw(original));
    for (let i = 0; i < original.length; i++) {
      const originalSample = original[i] ?? 0;
      const decodedSample = decoded[i] ?? 0;
      const error = Math.abs(decodedSample - originalSample);
      // mu-law is a lossy, logarithmic codec — bounded relative error, not exact round-trip.
      expect(error).toBeLessThan(Math.max(300, Math.abs(originalSample) * 0.05));
    }
  });

  it("silence encodes/decodes to exact silence", () => {
    const silence = new Int16Array(160); // 20ms @ 8kHz
    const decoded = mulawToPcm16(pcm16ToMulaw(silence));
    for (const sample of decoded) expect(Math.abs(sample)).toBeLessThan(10);
  });

  it("converts base64 mu-law frames to normalized PCM16 frames and back", () => {
    const pcm = Int16Array.from({ length: 160 }, (_, i) => Math.round(5000 * Math.sin(i / 5)));
    const base64 = mulawBase64FromNormalizedFrame({ pcm16: pcm, sampleRateHz: TWILIO_MEDIA_SAMPLE_RATE_HZ });
    expect(typeof base64).toBe("string");
    const frame = normalizedFrameFromMulawBase64(base64);
    expect(frame.sampleRateHz).toBe(TWILIO_MEDIA_SAMPLE_RATE_HZ);
    expect(frame.pcm16.length).toBe(pcm.length);
  });

  it("rejects encoding a frame at the wrong sample rate rather than silently mis-encoding it", () => {
    expect(() =>
      mulawBase64FromNormalizedFrame({ pcm16: new Int16Array(10), sampleRateHz: 16000 })
    ).toThrow("AUDIO_CODEC_ERROR");
  });
});
