import { useParams, Link } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, getToken } from '../auth'

const API = '/api'

// WebRTC media server URL. When unset we use same origin + /webrtc (app serves it on same host).
// Set VITE_MEDIA_SERVER_WS_URL to override (e.g. ws://other:8765). Set to empty string to disable WebRTC.
function getMediaServerWsBase() {
  const env = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MEDIA_SERVER_WS_URL
  const v = env != null ? String(env).trim() : null
  if (v === '') return ''
  if (v) return v.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/webrtc`
  }
  return '/webrtc'
}

function chatStreamWebSocketUrl(personaId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const token = getToken()
  const path = `/api/personas/${personaId}/chat/stream`
  return token ? `${proto}//${host}${path}?token=${encodeURIComponent(token)}` : `${proto}//${host}${path}`
}

function mediaServerSignalingUrl() {
  const base = getMediaServerWsBase()
  if (!base) return null
  const b = base.replace(/\/$/, '')
  return `${b}/signaling`
}

export default function Conversation() {
  const { personaId } = useParams()
  const [persona, setPersona] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const idleUrl = personaId ? `${API}/personas/${personaId}/idle-video` : null
  const previewUrl = personaId ? `${API}/personas/${personaId}/preview` : null
  const [replyState, setReplyState] = useState({ current: null, queue: [], streamDone: false })
  const [showReply, setShowReply] = useState(false)
  const [idleVideoError, setIdleVideoError] = useState(false)
  const [streamError, setStreamError] = useState(null)
  const idleVideoRef = useRef(null)
  const replyVideoRef = useRef(null)
  const clearReplyTimeoutRef = useRef(null)
  const clearReplyPendingRef = useRef(false)
  const longWaitTimeoutRef = useRef(null)
  const gotFirstClipRef = useRef(false)
  const lastClipLongFallbackRef = useRef(null)
  const RECOVERY_SEC = 90
  // Chat WebSocket lives in ref so it is NOT recreated on re-render (e.g. when setShowReply(true) fires)
  const chatWsRef = useRef(null)
  const signalingWsRef = useRef(null)
  // When true, WebRTC ontrack has set srcObject — skip the blob-URL useEffect so it won't clobber the stream.
  const webrtcActiveRef = useRef(false)
  // Phase 2 MSE: per-clip MediaSource state and segment queues
  const mseRef = useRef({
    byIndex: {},       // index -> { mediaSource, sourceBuffer, blobUrl, segmentQueue, appending }
    revoke: () => { },
  })
  const replyPlayingUrl = replyState.current
  const isStreaming = sending || ((replyState.current != null || replyState.queue.length > 0) && !replyState.streamDone)
  const isGenerating = sending && !replyState.current && replyState.queue.length === 0

  // When clip ended before next was queued, queue gets filled later — advance so we don't stay frozen
  useEffect(() => {
    const v = replyVideoRef.current
    if (!v || !replyState.current || replyState.queue.length === 0) return
    if (!v.ended || v.src !== replyState.current) return
    setReplyState((prev) => {
      if (prev.queue.length === 0) return prev
      console.info('[reply] catch-up advance (clip had ended before next was queued)')
      return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
    })
  }, [replyState.current, replyState.queue.length])

  useEffect(() => {
    if (!personaId) return
    apiFetch(`${API}/personas/${personaId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setPersona)
      .catch(() => setPersona(null))
  }, [personaId])

  // Do NOT close chat/signaling WebSockets in a useEffect cleanup. In React 18 Strict Mode
  // the component unmounts and remounts, which would run cleanup and close the WS right
  // after "started", killing the stream. Only close explicitly: in onclose handler, or
  // in fallbackToMSE. If user navigates away, the WS will eventually be GC'd or we can
  // close on route change elsewhere.

  const prevUrlRef = useRef(null)
  useEffect(() => {
    const v = replyVideoRef.current
    if (!v) return
    if (!replyPlayingUrl) {
      prevUrlRef.current = null
      return
    }
    // When WebRTC ontrack has set srcObject, don't overwrite it with a blob-URL src.
    if (webrtcActiveRef.current) {
      console.info('[reply] skipping src switch — WebRTC srcObject is active')
      return
    }
    const prevUrl = prevUrlRef.current
    prevUrlRef.current = replyPlayingUrl
    v.muted = true
    v.src = replyPlayingUrl
    // Ensure clip switch starts playback even if no further MSE updateend fires.
    try {
      v.load()
    } catch (_) { }
    console.info('[reply] switch src', {
      from: prevUrl,
      to: replyPlayingUrl,
      paused: v.paused,
      readyState: v.readyState,
    })
    v.play()
      .then(() => {
        console.info('[reply] play() resolved after src switch', {
          src: replyPlayingUrl,
          readyState: v.readyState,
        })
      })
      .catch((err) => {
        console.warn('[reply] play() failed after src switch', err)
      })
  }, [replyPlayingUrl])

  function transitionToIdle() {
    if (lastClipLongFallbackRef.current) {
      clearTimeout(lastClipLongFallbackRef.current)
      lastClipLongFallbackRef.current = null
    }
    // Clear WebRTC active flag and detach srcObject so the video element is clean for next use.
    webrtcActiveRef.current = false
    const rv = replyVideoRef.current
    if (rv && rv.srcObject) {
      rv.srcObject = null
    }
    clearReplyPendingRef.current = true
    idleVideoRef.current?.play().catch(() => {
      clearReplyPendingRef.current = false
      setShowReply(false)
    })
    // 1) Hide reply layer immediately so idle video shows (no 900ms wait on a possibly black frame)
    setShowReply(false)
    if (clearReplyPendingRef.current) clearReplyPendingRef.current = false
    // 2) After the reply-layer fade-out transition (~350ms), clear state and revoke blob URLs.
    //    Doing this after the fade prevents a black flash from the reply video when its blob is revoked.
    const FADE_MS = 400
    clearReplyTimeoutRef.current = setTimeout(() => {
      clearReplyTimeoutRef.current = null
      setReplyState({ current: null, queue: [], streamDone: false })
      const revoke = mseRef.current.revoke
      if (revoke) setTimeout(revoke, 100)
      setSending(false)
    }, FADE_MS)
  }

  const sendMessage = (e) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || sending || !personaId) return
    if (clearReplyTimeoutRef.current) {
      clearTimeout(clearReplyTimeoutRef.current)
      clearReplyTimeoutRef.current = null
    }
    if (longWaitTimeoutRef.current) {
      clearTimeout(longWaitTimeoutRef.current)
      longWaitTimeoutRef.current = null
    }
    setInput('')
    setSending(true)
    setStreamError(null)
    gotFirstClipRef.current = false
    webrtcActiveRef.current = false
    setReplyState({ current: null, queue: [], streamDone: false })
    longWaitTimeoutRef.current = setTimeout(() => {
      longWaitTimeoutRef.current = null
      if (gotFirstClipRef.current) return
      setStreamError('Response is taking too long. Please try again.')
      setShowReply(false)
      setSending(false)
      setReplyState((prev) => ({ ...prev, streamDone: true }))
    }, RECOVERY_SEC * 1000)
    const revokeNow = mseRef.current.revoke
    mseRef.current = { byIndex: {}, revoke: () => { } }
    if (revokeNow) setTimeout(revokeNow, 150)

    const CODECS = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"'
    const blobUrlsToRevoke = []

    // One continuous MSE for whole reply (Phase 1)
    function getOrCreateContinuousMSE() {
      const key = 0
      if (mseRef.current.byIndex[key]) return mseRef.current.byIndex[key]
      const mediaSource = new MediaSource()
      const blobUrl = URL.createObjectURL(mediaSource)
      blobUrlsToRevoke.push(blobUrl)
      const segmentQueue = []
      let appending = false
      let pendingEndOfStream = false
      const entry = { mediaSource, blobUrl, segmentQueue, setPendingEndOfStream: (v) => { pendingEndOfStream = v }, tryAppend: () => { } }
      mseRef.current.byIndex[key] = entry
      mediaSource.addEventListener('sourceopen', () => {
        try {
          const sb = mediaSource.addSourceBuffer(CODECS)
          entry.sourceBuffer = sb
          entry.tryAppend = function () {
            if (mediaSource.readyState !== 'open') return
            if (appending || segmentQueue.length === 0) {
              if (segmentQueue.length === 0 && pendingEndOfStream && !appending && mediaSource.readyState === 'open' && !sb.updating) {
                try { mediaSource.endOfStream() } catch (err) { console.warn('MSE endOfStream error', err) }
              }
              return
            }
            const buf = segmentQueue.shift()
            if (!buf) return
            appending = true
            try { sb.appendBuffer(buf) } catch (err) { appending = false; console.warn('MSE appendBuffer error', err) }
          }
          sb.addEventListener('updateend', () => {
            appending = false
            const v = replyVideoRef.current
            if (v && v.paused && v.src && v.src.startsWith('blob:')) {
              let bufferedAhead = 0
              try { if (v.buffered && v.buffered.length > 0) bufferedAhead = Math.max(0, v.buffered.end(v.buffered.length - 1) - (v.currentTime || 0)) } catch (_) { }
              if (bufferedAhead >= 0.75 || pendingEndOfStream) v.play().catch(() => { })
            }
            entry.tryAppend()
          })
          entry.tryAppend()
        } catch (e) { console.warn('MSE sourceopen error', e) }
      })
      return entry
    }

    function appendToContinuous(data) {
      const entry = mseRef.current.byIndex[0]
      if (!entry) return
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      entry.segmentQueue.push(bytes)
      if (entry.tryAppend) entry.tryAppend()
    }

    function handleStreamEvent(event, data) {
      if (event === 'started' || event === 'video_start' || event === 'done' || event === 'error') {
        console.info('[TwynBook] handleStreamEvent (MSE)', event, data)
      }
      // Never close or end stream on "started". Only "done" or "error" mean stream end.
      if (event === 'video_start') {
        gotFirstClipRef.current = true
        if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
        const { blobUrl } = getOrCreateContinuousMSE()
        setReplyState((prev) => (prev.current === null ? { ...prev, current: blobUrl } : prev))
      } else if (event === 'video_segment' && data.base64) {
        const binary = atob(data.base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        appendToContinuous(bytes)
      } else if (event === 'clip') { /* continuous: no per-clip endOfStream */ } else if (event === 'done') {
        setReplyState((prev) => ({ ...prev, streamDone: true }))
        if (lastClipLongFallbackRef.current) { clearTimeout(lastClipLongFallbackRef.current); lastClipLongFallbackRef.current = null }
        const entry = mseRef.current.byIndex[0]
        if (entry?.setPendingEndOfStream) { entry.setPendingEndOfStream(true); entry.tryAppend?.() }
        lastClipLongFallbackRef.current = setTimeout(() => {
          lastClipLongFallbackRef.current = null
          setReplyState((prev) => (prev.current != null && prev.queue.length === 0 && prev.streamDone ? (transitionToIdle(), prev) : prev))
        }, 30000)
      } else if (event === 'error') {
        setStreamError(data.error || 'Clip failed')
        setReplyState((prev) => ({ ...prev, current: null, queue: [], streamDone: true }))
        setShowReply(false)
        setSending(false)
      }
    }

    function finishStream() {
      mseRef.current.revoke = () => blobUrlsToRevoke.forEach((u) => URL.revokeObjectURL(u))
      if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
    }

    function tryWebRTCFirst() {
      return new Promise((resolve) => {
        const url = mediaServerSignalingUrl()
        console.info('[TwynBook] tryWebRTCFirst url=', url)
        if (!url) {
          console.info('[TwynBook] tryWebRTCFirst no url, using MSE')
          resolve(null)
          return
        }
        const ws = new WebSocket(url)
        const t = setTimeout(() => { console.info('[TwynBook] tryWebRTCFirst 3s timeout'); ws.close(); resolve(null) }, 3000)
        ws.onopen = () => { console.info('[TwynBook] signaling WS open'); ws.send(JSON.stringify({ action: 'create_session' })) }
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data)
            if (msg.session_id && msg.offer) {
              clearTimeout(t)
              console.info('[TwynBook] tryWebRTCFirst got session_id=', msg.session_id)
              resolve({ session_id: msg.session_id, offer: msg.offer, ws })
              return
            }
          } catch (_) { }
        }
        ws.onerror = () => { console.info('[TwynBook] signaling WS error'); clearTimeout(t); resolve(null) }
        ws.onclose = () => { console.info('[TwynBook] signaling WS close'); resolve(null) }
      })
    }

    function runWebRTCChat(webrtc, msgText) {
      console.info('[TwynBook] runWebRTCChat session_id=', webrtc.session_id)
      if (chatWsRef.current) {
        try { chatWsRef.current.close() } catch (_) { }
        chatWsRef.current = null
      }
      signalingWsRef.current = webrtc.ws
      const { session_id, offer, ws: signalingWs } = webrtc
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pc.ontrack = (e) => {
        console.info('[TwynBook] WebRTC ontrack streams=', e.streams?.length)
        const v = replyVideoRef.current
        if (v && e.streams?.[0]) {
          // Mark WebRTC as active so the blob-URL useEffect won't overwrite srcObject.
          webrtcActiveRef.current = true
          v.srcObject = e.streams[0]
          setShowReply(true)
          v.play().catch(() => { })
        }
      }
      pc.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => {
          console.info('[TwynBook] WebRTC sent answer')
          signalingWs.send(JSON.stringify({ action: 'answer', session_id, answer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } }))
        })
        .catch((err) => {
          console.info('[TwynBook] WebRTC setRemoteDescription/answer failed', err)
          setStreamError(err?.message || 'WebRTC failed')
          setReplyState({ current: null, queue: [], streamDone: true })
          setSending(false)
        })
      pc.onicecandidate = (e) => {
        if (e.candidate) signalingWs.send(JSON.stringify({ action: 'ice', session_id, candidate: e.candidate }))
      }

      let webrtcFallbackDone = false
      function fallbackToMSE() {
        if (webrtcFallbackDone) return
        webrtcFallbackDone = true
        console.info('[TwynBook] WebRTC ICE failed -> fallback to MSE, closing chat + signaling WS')
        webrtcActiveRef.current = false
        if (chatWsRef.current) { try { chatWsRef.current.close() } catch (_) { } chatWsRef.current = null }
        if (signalingWsRef.current) { try { signalingWsRef.current.close() } catch (_) { } signalingWsRef.current = null }
        runMSEFlow()
      }
      pc.oniceconnectionstatechange = () => {
        console.info('[TwynBook] WebRTC iceConnectionState=', pc.iceConnectionState)
        if (pc.iceConnectionState === 'failed') fallbackToMSE()
      }

      const chatWsUrl = chatStreamWebSocketUrl(personaId)
      const chatWs = new WebSocket(chatWsUrl)
      chatWsRef.current = chatWs
      console.info('[TwynBook] Chat WS (WebRTC) connecting url=', chatWsUrl)
      chatWs.onopen = () => {
        const payload = { message: msgText, webrtc_session_id: session_id }
        console.info('[TwynBook] Chat WS (WebRTC) open, SENDING:', JSON.stringify(payload))
        console.info('[TwynBook] payload.message length=', typeof payload.message === 'string' ? payload.message.length : 'not-string', 'first50=', typeof payload.message === 'string' ? payload.message.slice(0, 50) : payload.message)
        chatWs.send(JSON.stringify(payload))
      }
      chatWs.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        try {
          const msg = JSON.parse(ev.data)
          const event = msg.event
          const data = msg.data || {}
          if (event === 'started' || event === 'video_start' || event === 'done' || event === 'error') {
            console.info('[TwynBook] Chat WS (WebRTC) event=', event, data)
          }
          // Never close or end stream on "started". "started" is stream beginning; total may be 0.
          // Only "done" or "error" mean stream end. Never use !data.total (0 is falsy in JS).
          if (event === 'video_start') {
            gotFirstClipRef.current = true
            if (longWaitTimeoutRef.current) { clearTimeout(longWaitTimeoutRef.current); longWaitTimeoutRef.current = null }
          } else if (event === 'keepalive') {
            // Connection alive; keepalive resets long-wait so we don't show "taking too long" while backend is working
            if (longWaitTimeoutRef.current) {
              clearTimeout(longWaitTimeoutRef.current)
              longWaitTimeoutRef.current = setTimeout(() => {
                longWaitTimeoutRef.current = null
                if (gotFirstClipRef.current) return
                setStreamError('Response is taking too long. Please try again.')
                setShowReply(false)
                setSending(false)
                setReplyState((prev) => ({ ...prev, streamDone: true }))
              }, RECOVERY_SEC * 1000)
            }
          } else if (event === 'done') {
            setReplyState((prev) => ({ ...prev, streamDone: true }))
            if (lastClipLongFallbackRef.current) { clearTimeout(lastClipLongFallbackRef.current); lastClipLongFallbackRef.current = null }
            setTimeout(() => transitionToIdle(), 2000)
          } else if (event === 'error') {
            setStreamError(data.error || 'Clip failed')
            setReplyState((prev) => ({ ...prev, current: null, queue: [], streamDone: true }))
            setShowReply(false)
            setSending(false)
          }
        } catch (_) { }
      }
      chatWs.onerror = () => { setStreamError('Connection error'); setReplyState({ current: null, queue: [], streamDone: true }); setSending(false) }
      chatWs.onclose = (e) => {
        console.log('WS CLOSED BY:', e.code, e.reason || '(none)')
        console.info('[TwynBook] Chat WS (WebRTC) closed', { code: e.code, reason: e.reason || '(none)', clean: e.wasClean })
        chatWsRef.current = null
        finishStream()
        if (signalingWsRef.current) { try { signalingWsRef.current.close() } catch (_) { } signalingWsRef.current = null }
      }
    }

    let sseFallbackRun = false

    function runMSEFlow() {
      console.info('[TwynBook] runMSEFlow starting (no webrtc_session_id)')
      if (chatWsRef.current) {
        try { chatWsRef.current.close() } catch (_) { }
        chatWsRef.current = null
      }
      const wsUrl = chatStreamWebSocketUrl(personaId)
      const ws = new WebSocket(wsUrl)
      chatWsRef.current = ws
      const wsTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) { console.info('[TwynBook] MSE WS still connecting after 5s, fallback to SSE'); ws.close(); if (!sseFallbackRun) { sseFallbackRun = true; runSSEFallback() } }
      }, 5000)
      ws.onopen = () => {
        clearTimeout(wsTimeout)
        const payload = { message: text }
        console.info('[TwynBook] MSE WS open, SENDING:', JSON.stringify(payload))
        console.info('[TwynBook] payload.message length=', typeof text === 'string' ? text.length : 'n/a')
        ws.send(JSON.stringify(payload))
      }
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try { const msg = JSON.parse(ev.data); handleStreamEvent(msg.event, msg.data || {}) } catch (_) { }
        } else {
          if (ev.data instanceof ArrayBuffer) appendToContinuous(ev.data)
          else if (ev.data?.arrayBuffer) ev.data.arrayBuffer().then((ab) => appendToContinuous(ab))
        }
      }
      ws.onerror = () => {
        clearTimeout(wsTimeout)
        if ((ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) && !sseFallbackRun) { sseFallbackRun = true; runSSEFallback() }
      }
      ws.onclose = (e) => {
        clearTimeout(wsTimeout)
        console.log('WS CLOSED BY:', e.code, e.reason || '(none)')
        console.info('[TwynBook] MSE WS closed', { code: e.code, reason: e.reason || '(none)', clean: e.wasClean })
        chatWsRef.current = null
        if (!sseFallbackRun && !e.wasClean && !gotFirstClipRef.current) { sseFallbackRun = true; runSSEFallback() }
        else if (!sseFallbackRun) finishStream()
      }

      function runSSEFallback() {
        const form = new FormData()
        form.set('message', text)
        apiFetch(`${API}/personas/${personaId}/chat`, { method: 'POST', body: form })
          .then(async (response) => {
            if (!response.ok) {
              const t = await response.text()
              let msg = t
              try { const j = JSON.parse(t); if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail) } catch (_) { }
              throw new Error(msg)
            }
            const reader = response.body.getReader()
            const decoder = new TextDecoder('utf-8', { fatal: false })
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value?.length) buffer += decoder.decode(value, { stream: true })
                const parts = buffer.split('\n\n')
                buffer = parts.pop() || ''
                for (const part of parts) {
                  if (!part.trim()) continue
                  const eventMatch = part.match(/event:\s*(\S+)/)
                  const dataLine = part.match(/data:\s*([\s\S]*)/)
                  const event = eventMatch ? eventMatch[1].trim() : 'message'
                  let data = {}
                  if (dataLine) try { data = JSON.parse(dataLine[1].trim()) } catch (_) { }
                  handleStreamEvent(event, data)
                }
              }
            } catch (streamErr) {
              const msg = streamErr?.message || String(streamErr)
              setStreamError(msg.includes('input stream') ? 'Connection interrupted. Try again.' : msg)
              setReplyState((prev) => ({ ...prev, current: null, queue: [], streamDone: true }))
              setShowReply(false)
              setSending(false)
            }
            finishStream()
          })
          .catch((err) => {
            setStreamError(err?.message || 'Request failed')
            setReplyState({ current: null, queue: [], streamDone: true })
            setShowReply(false)
            setSending(false)
            finishStream()
          })
      }
    }

    Promise.resolve(tryWebRTCFirst()).then((webrtc) => {
      if (webrtc) runWebRTCChat(webrtc, text)
      else runMSEFlow()
    }).catch(() => runMSEFlow())
  }

  const handleReplyEnded = () => {
    setReplyState((prev) => {
      console.info('[reply] onEnded', {
        current: prev.current,
        queueLen: prev.queue.length,
        streamDone: prev.streamDone,
      })
      if (prev.queue.length > 0) {
        // Advance to next clip: keep reply layer visible, no gap/flash (next clip is preloaded)
        console.info('[reply] advancing to next clip')
        return { ...prev, current: prev.queue[0], queue: prev.queue.slice(1) }
      }
      // No more clips in queue: only switch to idle when stream is done (avoids speak → idle → speak when clip 1 is still loading)
      if (!prev.streamDone) {
        console.info('[reply] ended but waiting for stream to finish')
        return prev
      }
      // Stream done and no more clips — transition to idle (clears fallback timers)
      console.info('[reply] transition to idle')
      transitionToIdle()
      return prev
    })
  }

  if (!persona && personaId) {
    return (
      <div className="conv">
        <p>Loading…</p>
      </div>
    )
  }
  if (!persona) {
    return (
      <div className="conv">
        <p>Persona not found.</p>
        <Link to="/app">Back to list</Link>
      </div>
    )
  }

  return (
    <div className="conv">
      <header className="conv-header">
        <Link to="/app">← Back</Link>
        <h1>{persona.name}</h1>
        <Link to={`/persona/${personaId}/edit`} className="edit-link">Edit</Link>
      </header>
      <div className="video-wrap" aria-hidden="true">
        {isGenerating && (
          <div className="streaming-status generating">Generating reply…</div>
        )}
        {isStreaming && !isGenerating && replyState.queue.length > 0 && (
          <div className="streaming-status next">Next clip ready</div>
        )}
        {idleVideoError && previewUrl && (
          <img src={previewUrl} alt="" className="video-layer poster-fallback" style={{ opacity: showReply ? 0 : 1 }} />
        )}
        <video
          ref={idleVideoRef}
          src={idleUrl && !idleVideoError ? idleUrl : undefined}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          poster={previewUrl || undefined}
          className="video-layer"
          style={{ opacity: showReply ? 0 : 1 }}
          onError={() => setIdleVideoError(true)}
          onPlaying={() => {
            if (clearReplyPendingRef.current) {
              clearReplyPendingRef.current = false
              setShowReply(false)
            }
          }}
        />
        <video
          ref={replyVideoRef}
          muted
          autoPlay
          loop={false}
          playsInline
          preload="auto"
          className={`video-layer reply-layer${!showReply ? ' reply-hiding' : ''}`}
          style={{ opacity: showReply ? 1 : 0, pointerEvents: 'none' }}
          onPlaying={() => {
            console.info('[reply] onPlaying', {
              src: replyVideoRef.current?.src,
              readyState: replyVideoRef.current?.readyState,
            })
            setShowReply(true)
            const v = replyVideoRef.current
            if (v) {
              try { v.muted = false } catch (_) { }
            }
          }}
          onTimeUpdate={() => {
            if (!showReply && replyVideoRef.current && !replyVideoRef.current.paused) {
              setShowReply(true)
              try { replyVideoRef.current.muted = false } catch (_) { }
            }
          }}
          onEnded={handleReplyEnded}
          onError={(e) => {
            if (!replyVideoRef.current?.src) return
            console.warn('[reply] video error', {
              src: replyVideoRef.current?.src,
              readyState: replyVideoRef.current?.readyState,
              networkState: replyVideoRef.current?.networkState,
              mediaError: replyVideoRef.current?.error?.message || replyVideoRef.current?.error?.code || null,
            })
            console.warn('Reply video error (may recover when MSE buffers data)', e.nativeEvent)
          }}
        />
      </div>
      <div className="conv-bottom">
        {streamError && <p className="stream-error">{streamError}</p>}
        <form onSubmit={sendMessage} className="input-form">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            disabled={sending}
          />
          <button type="submit" disabled={sending || !input.trim()}>Send</button>
        </form>
      </div>
      <style>{`
        .conv { position: fixed; inset: 0; display: flex; flex-direction: column; background: #000; color: #e4e4e7; }
        .conv a { color: #a78bfa; }
        .conv-header { position: relative; z-index: 20; flex-shrink: 0; padding: 0.5rem 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; background: rgba(0,0,0,0.85); border-bottom: 1px solid rgba(255,255,255,0.1); }
        .conv-header a { margin-right: 0; color: #a78bfa; }
        .conv h1 { font-family: var(--font-heading); font-size: 0.95rem; font-weight: 600; margin: 0; flex: 1; color: #fff; }
        .conv-header .edit-link { color: #a78bfa; font-size: 0.85rem; }
        .video-wrap { position: relative; z-index: 0; flex: 1; min-height: 0; width: 100%; background: #000; overflow: hidden; pointer-events: none; }
        .video-wrap .video-layer { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; transition: opacity 0.35s ease-out; pointer-events: none; }
        .video-wrap .video-layer.poster-fallback { z-index: 0; }
        .video-wrap .video-layer.reply-layer { z-index: 1; transition: none; }
        .video-wrap .video-layer.reply-layer.reply-hiding { transition: opacity 0.35s ease-out; }
        .conv-bottom { position: relative; z-index: 20; flex-shrink: 0; background: rgba(0,0,0,0.9); border-top: 1px solid rgba(255,255,255,0.1); }
        .input-form { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; width: 100%; }
        .input-form input { flex: 1; padding: 0.6rem 0.75rem; border-radius: var(--radius); border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; }
        .input-form input::placeholder { color: rgba(255,255,255,0.5); }
        .input-form input:focus { outline: none; border-color: var(--primary); }
        .input-form button { padding: 0.6rem 1rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 500; cursor: pointer; }
        .input-form button:hover:not(:disabled) { background: var(--primary-hover); }
        .input-form button:disabled { opacity: 0.5; cursor: not-allowed; }
        .stream-error { color: #f87171; font-size: 0.85rem; padding: 0 1rem; margin: 0 0 0.25rem; }
        .streaming-status { position: absolute; bottom: 0.75rem; left: 50%; transform: translateX(-50%); z-index: 2; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.8rem; background: rgba(0,0,0,0.75); color: rgba(255,255,255,0.9); pointer-events: none; }
        .streaming-status.generating { animation: pulse 1.5s ease-in-out infinite; }
        .streaming-status.next { opacity: 0.85; }
        @keyframes pulse { 50% { opacity: 0.7; } }
      `}</style>
    </div>
  )
}
