import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch, getUser, clearSession } from '../auth'

const API = '/api'

export default function Home() {
  const navigate = useNavigate()
  const [personas, setPersonas] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const [licenseKey, setLicenseKey] = useState(null)
  const [licenseLoading, setLicenseLoading] = useState(false)
  const [licenseShown, setLicenseShown] = useState(false)
  // Publish modal state
  const [publishTarget, setPublishTarget] = useState(null) // persona being published
  const [publishPrice, setPublishPrice] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState(null)
  const [shareStatus, setShareStatus] = useState({})
  const [shareModal, setShareModal] = useState({ open: false, url: '', copied: false })
  const user = getUser()

  const loadPersonas = () => {
    return apiFetch(`${API}/personas`)
      .then((r) => r.json())
      .then((data) => setPersonas(data.personas || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadPersonas() }, [])

  const handleDelete = (e, p) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm(`Delete "${p.name}"? This cannot be undone.`)) return
    setDeletingId(p.id)
    apiFetch(`${API}/personas/${p.id}`, { method: 'DELETE' })
      .then((r) => {
        if (!r.ok) throw new Error('Delete failed')
        setError(null)
        setPersonas((prev) => prev.filter((x) => x.id !== p.id))
      })
      .catch((err) => setError(err.message))
      .finally(() => setDeletingId(null))
  }

  const handleLogout = () => {
    clearSession()
    navigate('/', { replace: true })
  }

  const loadLicenseKey = () => {
    setLicenseLoading(true)
    apiFetch(`${API}/auth/license-key`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        setLicenseKey(d.license_key || '')
        setLicenseShown(true)
      })
      .catch(() => {})
      .finally(() => setLicenseLoading(false))
  }

  const openPublishModal = (p) => {
    setPublishTarget(p)
    setPublishPrice(p.marketplace_price != null ? String(p.marketplace_price) : '')
    setPublishError(null)
  }

  const handlePublish = () => {
    if (!publishTarget) return
    const price = parseFloat(publishPrice)
    if (isNaN(price) || price < 0) { setPublishError('Please enter a valid price (0 for free).'); return }
    setPublishing(true)
    setPublishError(null)
    apiFetch(`${API}/personas/${publishTarget.id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price }),
    })
      .then((r) => r.ok ? r.json() : r.json().then((d) => Promise.reject(new Error(d.detail || 'Publish failed'))))
      .then((updated) => {
        setPersonas((prev) => prev.map((p) => p.id === updated.id ? updated : p))
        setPublishTarget(null)
      })
      .catch((err) => setPublishError(err.message))
      .finally(() => setPublishing(false))
  }

  const handleUnpublish = (e, p) => {
    e.stopPropagation()
    if (!window.confirm(`Remove "${p.name}" from the marketplace?`)) return
    apiFetch(`${API}/personas/${p.id}/unpublish`, { method: 'POST' })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((updated) => setPersonas((prev) => prev.map((x) => x.id === updated.id ? updated : x)))
      .catch(() => {})
  }

  const handleShare = (e, p) => {
    e.stopPropagation()
    setShareStatus((prev) => ({ ...prev, [p.id]: { state: 'loading' } }))
    apiFetch(`${API}/personas/${p.id}/share`, { method: 'POST' })
      .then((r) => r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t))))
      .then((d) => {
        const url = d.url || ''
        setShareModal({ open: true, url, copied: false })
        setShareStatus((prev) => ({ ...prev, [p.id]: { state: 'copied', url } }))
        setTimeout(() => {
          setShareStatus((prev) => {
            if (!prev[p.id] || prev[p.id].state !== 'copied') return prev
            return { ...prev, [p.id]: { state: 'idle', url } }
          })
        }, 2000)
      })
      .catch(() => setShareStatus((prev) => ({ ...prev, [p.id]: { state: 'error' } })))
  }

  const copyShareUrl = () => {
    const url = shareModal.url
    if (!url) return
    const markCopied = () => setShareModal((prev) => ({ ...prev, copied: true }))
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(markCopied).catch(() => {
        const input = document.querySelector('.share-input')
        if (input) {
          input.focus()
          input.select()
          try { document.execCommand('copy'); markCopied() } catch {}
        }
      })
      return
    }
    const input = document.querySelector('.share-input')
    if (input) {
      input.focus()
      input.select()
      try { document.execCommand('copy'); markCopied() } catch {}
    }
  }

  useEffect(() => {
    if (!showAccountMenu) return
    const close = (e) => { if (!e.target.closest('.account-wrap')) setShowAccountMenu(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showAccountMenu])

  if (loading) return <div className="home"><p className="home-loading">Loading…</p></div>
  if (error) return <div className="home"><p className="error">Error: {error}</p></div>

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-left">
          <Link to="/" className="home-logo">TwynBook</Link>
          <p className="home-tagline">Your digital twins</p>
          {personas.length > 0 && (
            <p className="home-subtitle">Select one to chat or create another.</p>
          )}
        </div>
        <div className="home-header-actions">
          <Link to="/marketplace" className="home-marketplace-btn">Go to marketplace</Link>
          {user?.is_admin === true && (
            <Link to="/admin" className="home-admin-btn">Admin</Link>
          )}
          <div className="account-wrap">
            <button
              className="account-btn"
              onClick={() => setShowAccountMenu((v) => !v)}
              aria-label="Account menu"
              title={user?.name || user?.email || 'Account'}
            >
              <span className="account-avatar">{(user?.name || user?.email || '?')[0].toUpperCase()}</span>
            </button>
            {showAccountMenu && (
              <div className="account-menu">
                <div className="account-menu-info">
                  <span className="account-menu-name">{user?.name}</span>
                  <span className="account-menu-email">{user?.email}</span>
                </div>
                <div className="account-license-block">
                  {!licenseShown ? (
                    <button type="button" className="account-license-show" onClick={loadLicenseKey} disabled={licenseLoading}>
                      {licenseLoading ? 'Loading…' : 'Show license key'}
                    </button>
                  ) : (
                    <div className="account-license-inner">
                      <span className="account-license-label">License key</span>
                      <code className="account-license-value" title={licenseKey || ''}>{licenseKey}</code>
                      <button
                        type="button"
                        className="account-license-copy"
                        onClick={() => licenseKey && navigator.clipboard?.writeText(licenseKey)}
                      >
                        Copy
                      </button>
                    </div>
                  )}
                </div>
                <hr className="account-menu-divider" />
                <button className="account-menu-item account-menu-logout" onClick={handleLogout}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {personas.length === 0 ? (
        <div className="home-empty">
          <p className="home-empty-text">You don&apos;t have any digital twins yet.</p>
          <p className="home-empty-hint">Create your first twyn to get started.</p>
          <Link to="/create" className="home-empty-cta">Create your first twyn</Link>
        </div>
      ) : (
        <div className="home-grid-wrap">
          <h2 className="home-section-title">Your twyns</h2>
          <div className="persona-list">
            {personas.map((p) => (
              <div key={p.id} className="persona-row">
                {/* Thumbnail */}
                <Link to={`/persona/${p.id}`} className="persona-row-media">
                  <div className="persona-thumb">
                    {p.idle_video_path ? (
                      <video
                        src={`${API}/personas/${p.id}/idle-video`}
                        muted loop playsInline preload="metadata"
                        poster={`${API}/personas/${p.id}/preview`}
                      />
                    ) : (
                      <img src={`${API}/personas/${p.id}/preview`} alt="" />
                    )}
                  </div>
                </Link>

                {/* Name + About + actions */}
                <div className="persona-row-main">
                  <Link to={`/persona/${p.id}`} className="persona-row-name">{p.name}</Link>
                  {p.system_prompt && (
                    <p className="persona-row-about">{p.system_prompt}</p>
                  )}
                  <div className="persona-actions">
                    <Link to={`/persona/${p.id}/edit`} className="btn-edit" onClick={(e) => e.stopPropagation()}>Edit</Link>
                    <button type="button" className="btn-delete" onClick={(e) => handleDelete(e, p)} disabled={deletingId === p.id}>
                      {deletingId === p.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>

                {/* Marketplace panel */}
                <div className="persona-profile">
                  {p.published ? (
                    <>
                      <span className="profile-badge-published">&#10003; On marketplace</span>
                      <span className="persona-price">
                        {p.marketplace_price > 0 ? `$${Number(p.marketplace_price).toFixed(2)}/mo` : 'Free'}
                      </span>
                      <div className="persona-actions-grid">
                        <button className="btn-share" onClick={(e) => handleShare(e, p)}>
                          {shareStatus[p.id]?.state === 'loading' ? 'Sharing…' :
                            shareStatus[p.id]?.state === 'copied' ? 'Copied' :
                            shareStatus[p.id]?.state === 'error' ? 'Try again' : 'Share'}
                        </button>
                        <button className="btn-unpublish" onClick={(e) => handleUnpublish(e, p)}>Unpublish</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="persona-actions-grid">
                        <button className="btn-publish" onClick={() => openPublishModal(p)}>
                          Publish
                        </button>
                        <button className="btn-share" onClick={(e) => handleShare(e, p)}>
                          {shareStatus[p.id]?.state === 'loading' ? 'Sharing…' :
                            shareStatus[p.id]?.state === 'copied' ? 'Copied' :
                            shareStatus[p.id]?.state === 'error' ? 'Try again' : 'Share'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}

            <Link to="/create" className="persona-row persona-row-add">
              <div className="persona-thumb add-placeholder">+</div>
              <span className="persona-row-add-label">Add new twyn</span>
            </Link>
          </div>
        </div>
      )}

      {/* Publish price modal */}
      {publishTarget && (
        <div className="modal-overlay" onClick={() => setPublishTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setPublishTarget(null)} aria-label="Close">×</button>
            <h2 className="modal-title">Publish "{publishTarget.name}"</h2>
            <p className="modal-hint">Set a monthly price for your twyn on the marketplace. Enter 0 to list it for free.</p>
            <label className="modal-label">
              Price ($/mo)
              <div className="modal-price-wrap">
                <span className="modal-price-prefix">$</span>
                <input
                  className="modal-price-input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={publishPrice}
                  onChange={(e) => setPublishPrice(e.target.value)}
                  autoFocus
                />
              </div>
            </label>
            {publishError && <p className="modal-error">{publishError}</p>}
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setPublishTarget(null)}>Cancel</button>
              <button className="modal-confirm" onClick={handlePublish} disabled={publishing}>
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {shareModal.open && (
        <div className="modal-overlay" onClick={() => setShareModal({ open: false, url: '', copied: false })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShareModal({ open: false, url: '', copied: false })} aria-label="Close">×</button>
            <h2 className="modal-title">Share link</h2>
            <p className="modal-hint">Anyone with this link can view and chat with your persona.</p>
            <div className="share-row">
              <input className="share-input" readOnly value={shareModal.url} onFocus={(e) => e.target.select()} />
              <button className="share-copy" onClick={copyShareUrl} aria-label="Copy link" title="Copy link">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 9a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V9zm-5 5a2 2 0 0 0 2 2h1v-2H6V6h8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9z"/>
                </svg>
              </button>
            </div>
            {shareModal.copied && <p className="share-copied">Copied to clipboard.</p>}
          </div>
        </div>
      )}

      <style>{`
        .home { padding: 2rem; max-width: 960px; margin: 0 auto; min-height: 100vh; background: var(--bg-page); }
        .home-loading { padding: 2rem; color: var(--text-secondary); }
        .home-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 2rem; }
        .home-header-left { flex: 1; min-width: 0; }
        .home-logo { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; color: var(--text-primary); text-decoration: none; }
        .home-logo:hover { color: var(--primary); }
        .home-tagline { margin: 0.25rem 0 0; font-size: 0.95rem; color: var(--text-muted); }
        .home-subtitle { margin: 0.25rem 0 0; font-size: 0.9rem; color: var(--text-secondary); }
        .home-header-actions { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
        .home-marketplace-btn { padding: 0.5rem 1rem; border-radius: var(--radius); border: 1px solid var(--primary); background: transparent; color: var(--primary); font-weight: 600; font-size: 0.9rem; text-decoration: none; white-space: nowrap; }
        .home-marketplace-btn:hover { background: var(--primary-muted); }
        .home-admin-btn { padding: 0.5rem 1rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); font-weight: 600; font-size: 0.9rem; text-decoration: none; white-space: nowrap; }
        .home-admin-btn:hover { background: var(--border); color: var(--text-primary); }
        .account-wrap { position: relative; }
        .account-btn { width: 38px; height: 38px; border-radius: 50%; background: var(--primary); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
        .account-avatar { font-size: 1rem; font-weight: 700; color: #fff; line-height: 1; pointer-events: none; }
        .account-menu { position: absolute; right: 0; top: calc(100% + 0.5rem); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); min-width: 200px; box-shadow: var(--shadow); z-index: 100; overflow: hidden; }
        .account-menu-info { padding: 0.75rem 1rem; }
        .account-menu-name { display: block; font-weight: 600; color: var(--text-primary); font-size: 0.95rem; margin-bottom: 0.1rem; }
        .account-menu-email { display: block; font-size: 0.8rem; color: var(--text-muted); }
        .account-license-block { padding: 0 1rem 0.65rem; }
        .account-license-show { width: 100%; padding: 0.4rem 0.5rem; font-size: 0.8rem; font-weight: 600; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); color: var(--primary); cursor: pointer; }
        .account-license-show:hover:not(:disabled) { border-color: var(--primary); }
        .account-license-show:disabled { opacity: 0.6; cursor: not-allowed; }
        .account-license-inner { display: flex; flex-direction: column; gap: 0.35rem; }
        .account-license-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }
        .account-license-value { display: block; font-size: 0.7rem; word-break: break-all; padding: 0.35rem 0.45rem; background: var(--bg-page); border-radius: var(--radius); border: 1px solid var(--border); color: var(--text-primary); max-height: 4.5rem; overflow-y: auto; }
        .account-license-copy { align-self: flex-start; padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 600; border: none; border-radius: var(--radius); background: var(--primary); color: #fff; cursor: pointer; }
        .account-license-copy:hover { opacity: 0.92; }
        .account-menu-divider { margin: 0; border: none; border-top: 1px solid var(--border); }
        .account-menu-item { display: block; width: 100%; padding: 0.65rem 1rem; text-align: left; background: none; border: none; cursor: pointer; font-size: 0.9rem; color: var(--text-primary); }
        .account-menu-item:hover { background: var(--bg-page); }
        .account-menu-logout { color: var(--error, #c0392b); }
        .home-empty { text-align: center; padding: 3rem 2rem; background: var(--bg-card); border-radius: var(--radius-lg); border: 1px solid var(--border); max-width: 400px; margin: 0 auto; }
        .home-empty-text { font-family: var(--font-heading); font-size: 1.1rem; font-weight: 600; color: var(--text-primary); margin: 0 0 0.5rem; }
        .home-empty-hint { font-size: 0.95rem; color: var(--text-secondary); margin: 0 0 1.5rem; }
        .home-empty-cta { display: inline-block; padding: 0.75rem 1.5rem; border-radius: var(--radius); background: var(--primary); color: #fff; font-weight: 600; text-decoration: none; }
        .home-empty-cta:hover { background: var(--primary-hover); }
        .home-grid-wrap { background: var(--bg-card); border-radius: var(--radius-lg); border: 1px solid var(--border); padding: 1.5rem; }
        .home-section-title { font-family: var(--font-heading); font-size: 1.1rem; font-weight: 600; color: var(--text-primary); margin: 0 0 1rem; }

        /* Vertical list */
        .persona-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.9rem; }

        /* Row card */
        .persona-row { display: flex; flex-direction: column; align-items: stretch; background: var(--bg-page); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; transition: box-shadow 0.2s, transform 0.15s; height: 100%; }
        .persona-row:not(.persona-row-add):hover { box-shadow: var(--shadow); transform: translateY(-1px); }

        /* Thumbnail */
        .persona-row-media { display: block; width: 100%; text-decoration: none; }
        .persona-thumb { width: 100%; height: 200px; background: var(--border); display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .persona-thumb img, .persona-thumb video { width: 100%; height: 100%; object-fit: cover; }
        .persona-thumb.add-placeholder { font-size: 2.5rem; color: var(--text-muted); }

        /* Name + About + actions */
        .persona-row-main { display: flex; flex-direction: column; justify-content: center; padding: 0.9rem 0.95rem 0.75rem; min-width: 0; gap: 0.35rem; }
        .persona-row-name { font-family: var(--font-heading); font-size: 1rem; font-weight: 700; color: var(--text-primary); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .persona-row-name:hover { color: var(--primary); }
        .persona-row-about { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.45; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .persona-actions { display: flex; gap: 0.75rem; margin-top: 0.2rem; }
        .persona-actions .btn-edit { color: var(--primary); font-size: 0.82rem; text-decoration: none; }
        .persona-actions .btn-edit:hover { text-decoration: underline; }
        .persona-actions .btn-delete { background: none; border: none; color: var(--error); font-size: 0.82rem; cursor: pointer; padding: 0; }
        .persona-actions .btn-delete:hover:not(:disabled) { text-decoration: underline; }
        .persona-actions .btn-delete:disabled { opacity: 0.6; cursor: not-allowed; }

        /* Marketplace panel */
        .persona-profile { border-top: 1px solid var(--border); padding: 0.75rem 0.95rem; display: flex; flex-direction: column; justify-content: space-between; align-items: stretch; gap: 0.4rem; background: var(--bg-card); }
        .btn-publish { padding: 0.45rem 0.6rem; border-radius: var(--radius); border: 1px solid var(--primary); background: transparent; color: var(--primary); font-size: 0.78rem; font-weight: 600; cursor: pointer; white-space: normal; line-height: 1.2; text-align: center; width: 100%; }
        .btn-publish:hover { background: var(--primary-muted); }
        .profile-badge-published { font-size: 0.78rem; font-weight: 700; color: #065f46; background: #d1fae5; padding: 0.2rem 0.55rem; border-radius: 999px; }
        .persona-price { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
        .persona-actions-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
        .btn-share { padding: 0.45rem 0.6rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); color: var(--text-primary); font-size: 0.78rem; font-weight: 600; cursor: pointer; width: 100%; }
        .btn-share:hover { border-color: var(--primary); color: var(--primary); }
        .btn-unpublish { font-size: 0.78rem; color: var(--text-muted); background: none; border: none; cursor: pointer; padding: 0; text-decoration: underline; }
        .btn-unpublish:hover { color: var(--error); }

        /* Add new row */
        .persona-row-add { align-items: center; text-decoration: none; color: var(--text-muted); border-style: dashed; gap: 1rem; padding: 0.75rem 1rem; }
        .persona-row-add:hover { color: var(--primary); border-color: var(--primary); }
        .persona-row-add .persona-thumb { border: none; background: none; width: 52px; height: 52px; font-size: 1.75rem; }
        .persona-row-add-label { font-weight: 600; font-size: 0.95rem; }

        /* Publish modal */
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 1rem; }
        .modal { background: var(--bg-card); border-radius: var(--radius-lg); padding: 1.75rem; max-width: 380px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.18); position: relative; }
        .modal-close { position: absolute; top: 0.75rem; right: 0.9rem; background: none; border: none; font-size: 1.4rem; color: var(--text-muted); cursor: pointer; line-height: 1; }
        .modal-close:hover { color: var(--text-primary); }
        .modal-title { font-family: var(--font-heading); font-size: 1.1rem; font-weight: 700; color: var(--text-primary); margin: 0 0 0.5rem; }
        .modal-hint { font-size: 0.875rem; color: var(--text-secondary); margin: 0 0 1.25rem; line-height: 1.45; }
        .modal-label { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.875rem; font-weight: 500; color: var(--text-primary); margin-bottom: 1rem; }
        .modal-price-wrap { display: flex; align-items: center; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--bg-page); }
        .modal-price-prefix { padding: 0.5rem 0.6rem; font-size: 0.9rem; color: var(--text-muted); background: var(--border); border-right: 1px solid var(--border); }
        .modal-price-input { flex: 1; padding: 0.5rem 0.75rem; border: none; background: transparent; color: var(--text-primary); font-size: 0.95rem; outline: none; }
        .modal-error { font-size: 0.85rem; color: var(--error); margin: 0 0 0.75rem; }
        .modal-actions { display: flex; gap: 0.75rem; justify-content: flex-end; }
        .modal-cancel { padding: 0.55rem 1rem; border-radius: var(--radius); border: 1px solid var(--border); background: transparent; color: var(--text-secondary); font-weight: 600; font-size: 0.9rem; cursor: pointer; }
        .modal-cancel:hover { background: var(--border); }
        .modal-confirm { padding: 0.55rem 1.2rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 600; font-size: 0.9rem; cursor: pointer; }
        .modal-confirm:hover:not(:disabled) { background: var(--primary-hover); }
        .modal-confirm:disabled { opacity: 0.65; cursor: not-allowed; }
        .share-row { display: flex; gap: 0.6rem; align-items: center; }
        .share-input { flex: 1; padding: 0.55rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); color: var(--text-primary); }
        .share-copy { width: 40px; height: 40px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
        .share-copy:hover { border-color: var(--primary); color: var(--primary); }
        .share-copy svg { width: 18px; height: 18px; fill: currentColor; }
        .share-copied { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--text-muted); }

        .error { color: var(--error); }

        @media (max-width: 980px) {
          .persona-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }

        @media (max-width: 720px) {
          .home { padding: 1rem; }
          .home-header { gap: 0.75rem; }
          .home-header-actions { width: 100%; flex-wrap: wrap; }
          .home-marketplace-btn, .home-admin-btn { width: 100%; text-align: center; }
          .persona-list { grid-template-columns: 1fr; }
          .persona-row { flex-direction: column; }
          .persona-row-media { width: 100%; }
          .persona-thumb { width: 100%; height: 180px; }
          .persona-row-main { padding: 0.85rem; }
          .persona-profile { width: 100%; border-left: none; border-top: 1px solid var(--border); }
          .persona-actions { flex-wrap: wrap; gap: 0.5rem; }
        }
      `}</style>
    </div>
  )
}
