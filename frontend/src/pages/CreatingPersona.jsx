import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../auth'

const API = '/api'

export default function CreatingPersona() {
  const location = useLocation()
  const navigate = useNavigate()
  const creatingPersonaId = location.state?.creatingPersonaId

  useEffect(() => {
    if (!creatingPersonaId) {
      navigate('/create', { replace: true })
      return
    }
  }, [creatingPersonaId, navigate])

  useEffect(() => {
    if (!creatingPersonaId) return
    const poll = () => {
      apiFetch(`${API}/personas/create/status/${creatingPersonaId}`)
        .then((r) => r.json())
        .then((status) => {
          if (status.status === 'ready') {
            navigate(`/persona/${creatingPersonaId}`, { replace: true })
            return
          }
          if (status.status === 'failed') {
            navigate('/create', { state: { creationError: status.error || 'Creation failed' }, replace: true })
          }
        })
        .catch(() => {})
    }
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [creatingPersonaId, navigate])

  if (!creatingPersonaId) return null

  return (
    <div className="creating-page">
      <div className="creating-spinner" />
      <p className="creating-title">Creating your digital twin…</p>
      <p className="creating-hint">This usually takes under a minute.</p>
      <style>{`
        .creating-page {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: var(--bg-page);
          z-index: 50;
        }
        .creating-spinner {
          width: 56px;
          height: 56px;
          border: 4px solid var(--border);
          border-top-color: var(--primary);
          border-radius: 50%;
          animation: creating-spin 0.9s linear infinite;
        }
        .creating-title {
          margin: 1.5rem 0 0;
          font-family: var(--font-heading);
          font-size: 1.25rem;
          font-weight: 600;
          color: var(--text-primary);
        }
        .creating-hint {
          margin: 0.5rem 0 0;
          font-size: 0.95rem;
          color: var(--text-muted);
        }
        @keyframes creating-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
