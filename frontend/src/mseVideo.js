/**
 * Safari / iOS: pick a muxed H.264 + AAC codec string that MediaSource accepts.
 * Ditto outputs H.264 baseline; we try common baseline/main profiles in order.
 */
export function pickMuxedCodecString() {
  if (typeof MediaSource === 'undefined') return null
  const candidates = [
    'video/mp4; codecs="avc1.42E01E,mp4a.40.2"', // Baseline 3.0 — strict Safari
    'video/mp4; codecs="avc1.42401E,mp4a.40.2"', // Same profile, alt notation (Chrome)
    'video/mp4; codecs="avc1.4d401e,mp4a.40.2"', // Main
    'video/mp4; codecs="avc1.640028,mp4a.40.2"', // High
  ]
  for (const c of candidates) {
    try {
      if (MediaSource.isTypeSupported(c)) return c
    } catch (_) {
      /* ignore */
    }
  }
  return null
}

/** True when fMP4 MSE playback is possible (env allows + browser supports a muxed codec). */
export function isVideoMseAvailable() {
  if (
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_DITTO_STREAMING === '0'
  ) {
    return false
  }
  return pickMuxedCodecString() != null
}
