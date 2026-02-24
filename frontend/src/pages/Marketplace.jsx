import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, getUser } from '../auth'

const API = '/api'

export default function Marketplace() {
  const user = getUser()
  const isAdmin = user?.is_admin === true

  const [listings, setListings] = useState([])
  const [purchases, setPurchases] = useState([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('all') // 'all' | 'avatar' | 'integration' | 'role_pack'
  const [modalListing, setModalListing] = useState(null)
  const [buying, setBuying] = useState(null)
  const [showAdminForm, setShowAdminForm] = useState(false)
  const [editingListing, setEditingListing] = useState(null)
  const [form, setForm] = useState({ name: '', description: '', logo_url: '', price: '', mcp_server_url: '', listing_type: 'integration', role_prompt: '' })
  const [avatarFaceFile, setAvatarFaceFile] = useState(null)
  const [avatarVoiceFile, setAvatarVoiceFile] = useState(null)
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState(null)

  const loadAll = async () => {
    try {
      const [listRes, purRes] = await Promise.all([
        fetch(`${API}/marketplace`),
        apiFetch(`${API}/me/purchases`),
      ])
      const listData = await listRes.json()
      const purData = await purRes.json()
      setListings(listData.listings || [])
      setPurchases((purData.purchases || []).map((p) => p.id))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  const isOwned = (id) => purchases.includes(id)

  const handleBuy = async (listing) => {
    setBuying(listing.id)
    try {
      const res = await apiFetch(`${API}/marketplace/${listing.id}/purchase`, { method: 'POST' })
      if (res.ok) {
        setPurchases((prev) => prev.includes(listing.id) ? prev : [...prev, listing.id])
        setModalListing(null)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setBuying(null)
    }
  }

  const listingType = (l) => l.listing_type || 'integration'

  const filteredListings = typeFilter === 'all'
    ? listings
    : listings.filter((l) => listingType(l) === typeFilter)

  const openAdminNew = () => {
    setEditingListing(null)
    setForm({ name: '', description: '', logo_url: '', price: '', mcp_server_url: '', listing_type: 'integration', role_prompt: '' })
    setAvatarFaceFile(null)
    setAvatarVoiceFile(null)
    setFormError(null)
    setShowAdminForm(true)
  }

  const openAdminEdit = (l) => {
    setEditingListing(l)
    setForm({
      name: l.name,
      description: l.description || '',
      logo_url: l.logo_url || '',
      price: String(l.price || 0),
      mcp_server_url: l.mcp_server_url || '',
      listing_type: listingType(l),
      role_prompt: l.role_prompt || '',
    })
    setAvatarFaceFile(null)
    setAvatarVoiceFile(null)
    setFormError(null)
    setShowAdminForm(true)
  }

  const handleAdminDelete = async (id) => {
    if (!window.confirm('Delete this listing?')) return
    await apiFetch(`${API}/admin/marketplace/${id}`, { method: 'DELETE' })
    setListings((prev) => prev.filter((l) => l.id !== id))
  }

  const handleFormSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    const type = (form.listing_type || 'integration').trim()
    if (!form.name.trim()) { setFormError('Name is required'); return }
    if (type === 'integration' && !form.mcp_server_url.trim()) { setFormError('MCP server URL is required for integrations'); return }
    if (type === 'role_pack' && !form.role_prompt.trim()) { setFormError('Role prompt is required for role packs'); return }
    if (type === 'avatar' && !editingListing) {
      if (!avatarFaceFile || !avatarVoiceFile) { setFormError('Face image and voice sample are required for new avatars'); return }
    }
    setFormSaving(true)
    try {
      if (type === 'avatar' && !editingListing && avatarFaceFile && avatarVoiceFile) {
        const fd = new FormData()
        fd.set('name', form.name.trim())
        fd.set('description', form.description.trim())
        fd.set('price', String(parseFloat(form.price) || 0))
        fd.set('face', avatarFaceFile)
        fd.set('voice', avatarVoiceFile)
        const res = await apiFetch(`${API}/admin/marketplace/avatar`, { method: 'POST', body: fd })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Avatar creation failed') }
        const saved = await res.json()
        setListings((prev) => [...prev, saved])
        setShowAdminForm(false)
      } else {
        const body = {
          name: form.name.trim(),
          description: form.description.trim(),
          logo_url: form.logo_url.trim(),
          price: parseFloat(form.price) || 0,
          mcp_server_url: type === 'integration' ? form.mcp_server_url.trim() : '',
          listing_type: type,
          role_prompt: type === 'role_pack' ? form.role_prompt.trim() : '',
        }
        const res = editingListing
          ? await apiFetch(`${API}/admin/marketplace/${editingListing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          : await apiFetch(`${API}/admin/marketplace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Save failed') }
        const saved = await res.json()
        if (editingListing) {
          setListings((prev) => prev.map((l) => l.id === saved.id ? saved : l))
        } else {
          setListings((prev) => [...prev, saved])
        }
        setShowAdminForm(false)
      }
    } catch (err) {
      setFormError(err.message)
    } finally {
      setFormSaving(false)
    }
  }

  return (
    <div className="marketplace-page">
      <header className="marketplace-header">
        <div className="marketplace-header-left">
          <Link to="/app" className="marketplace-back">← Back to app</Link>
          <h1 className="marketplace-title">Marketplace</h1>
          <p className="marketplace-tagline">Skills and integrations for your digital twin</p>
        </div>
        {isAdmin && (
          <button className="marketplace-admin-btn" onClick={openAdminNew}>+ Add listing</button>
        )}
      </header>

      {loading ? (
        <p className="marketplace-loading">Loading…</p>
      ) : listings.length === 0 ? (
        <div className="marketplace-empty">
          <p>No tools in the marketplace yet{isAdmin ? '. Click "Add listing" to add one.' : '.'}</p>
        </div>
      ) : (
        <>
          <div className="marketplace-filters">
            {[
              { key: 'all', label: 'All' },
              { key: 'twyn', label: 'Twyns' },
              { key: 'avatar', label: 'Avatars' },
              { key: 'integration', label: 'Tools' },
              { key: 'role_pack', label: 'Roles' },
            ].map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`marketplace-filter-btn ${typeFilter === key ? 'active' : ''}`}
                onClick={() => setTypeFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="marketplace-grid">
            {filteredListings.map((listing) => (
              <div key={listing.id} className="marketplace-card-wrap">
                <button type="button" className="marketplace-card" onClick={() => setModalListing(listing)}>
                  <span className={`marketplace-card-type marketplace-card-type-${listingType(listing)}`}>{listingType(listing) === 'integration' ? 'Tool' : listingType(listing) === 'role_pack' ? 'Role' : listingType(listing) === 'twyn' ? 'Twyn' : 'Avatar'}</span>
                  <div className={`marketplace-card-thumb ${listingType(listing) === 'avatar' || listingType(listing) === 'twyn' ? 'marketplace-card-thumb-avatar' : ''}`}>
                  {listingType(listing) === 'avatar' || listingType(listing) === 'twyn'
                    ? <><img src={`${API}/marketplace/${listing.id}/preview`} alt="" onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling?.classList.add('show'); }} /><span className="marketplace-card-icon fallback">{listing.name[0]}</span></>
                    : listing.logo_url
                      ? <img src={listing.logo_url} alt="" />
                      : <span className="marketplace-card-icon">{listing.name[0]}</span>}
                </div>
                <span className="marketplace-card-name">{listing.name}</span>
                {listing.price > 0 && <span className="marketplace-card-price">${listing.price.toFixed(2)}/mo</span>}
                {isOwned(listing.id) && <span className="marketplace-card-owned">Owned</span>}
              </button>
              {isAdmin && (
                <div className="marketplace-card-admin">
                  <button className="mkt-admin-edit" onClick={() => openAdminEdit(listing)}>Edit</button>
                  <button className="mkt-admin-delete" onClick={() => handleAdminDelete(listing.id)}>Delete</button>
                </div>
              )}
            </div>
          ))}
          </div>
          {filteredListings.length === 0 && (
            <p className="marketplace-no-results">No {typeFilter === 'integration' ? 'tools' : typeFilter === 'role_pack' ? 'roles' : typeFilter === 'avatar' ? 'avatars' : typeFilter === 'twyn' ? 'twyns' : 'listings'} match this filter.</p>
          )}
        </>
      )}

      {/* Detail modal */}
      {modalListing && (
        <div className="marketplace-modal-overlay" onClick={() => setModalListing(null)}>
          <div className="marketplace-modal" onClick={(e) => e.stopPropagation()}>
            <div className="marketplace-modal-header">
              <div className={`marketplace-modal-thumb ${listingType(modalListing) === 'avatar' || listingType(modalListing) === 'twyn' ? 'marketplace-modal-thumb-avatar' : ''}`}>
                  {listingType(modalListing) === 'avatar' || listingType(modalListing) === 'twyn'
                    ? <><img src={`${API}/marketplace/${modalListing.id}/preview`} alt="" onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling?.classList.add('show'); }} /><span className="marketplace-card-icon fallback">{modalListing.name[0]}</span></>
                  : modalListing.logo_url
                    ? <img src={modalListing.logo_url} alt="" />
                    : <span className="marketplace-card-icon">{modalListing.name[0]}</span>}
              </div>
              <div>
                <h2 className="marketplace-modal-title">{modalListing.name}</h2>
                {modalListing.price > 0 && <p className="marketplace-modal-price">${modalListing.price.toFixed(2)} / month</p>}
              </div>
              <button type="button" className="marketplace-modal-close" onClick={() => setModalListing(null)} aria-label="Close">×</button>
            </div>
            <p className="marketplace-modal-desc">{modalListing.description || (listingType(modalListing) === 'role_pack' ? 'Role pack: prompt only (RAG + documents later).' : 'No description.')}</p>
            <div className="marketplace-modal-actions">
              {isOwned(modalListing.id) ? (
                <span className="marketplace-owned-badge">✓ Owned</span>
              ) : (
                <button
                  type="button"
                  className="btn-marketplace btn-buy"
                  disabled={buying === modalListing.id}
                  onClick={() => handleBuy(modalListing)}
                >
                  {buying === modalListing.id ? 'Processing…' : modalListing.price > 0 ? `Subscribe $${modalListing.price.toFixed(2)}/mo` : 'Add for free'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Admin form modal */}
      {showAdminForm && (
        <div className="marketplace-modal-overlay" onClick={() => setShowAdminForm(false)}>
          <div className="marketplace-modal marketplace-admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="marketplace-modal-header">
              <h2 className="marketplace-modal-title">{editingListing ? 'Edit listing' : 'Add listing'}</h2>
              <button type="button" className="marketplace-modal-close" onClick={() => setShowAdminForm(false)} aria-label="Close">×</button>
            </div>
            {formError && <p className="marketplace-form-error">{formError}</p>}
            <form onSubmit={handleFormSubmit} className="marketplace-admin-form">
              <label>Listing type
                <select value={form.listing_type} onChange={(e) => setForm((f) => ({ ...f, listing_type: e.target.value }))} disabled={!!editingListing}>
                  <option value="integration">Integration (MCP tools)</option>
                  <option value="role_pack">Role pack (prompt)</option>
                  <option value="avatar">Avatar (face + voice)</option>
                </select>
                {editingListing && <span className="form-hint">Type cannot be changed when editing.</span>}
              </label>
              <label>Name *
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="e.g. Excel / Sales coach / Alex" />
              </label>
              <label>Description
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="What this listing is for…" />
              </label>
              {form.listing_type !== 'avatar' && (
                <label>Logo URL
                  <input value={form.logo_url} onChange={(e) => setForm((f) => ({ ...f, logo_url: e.target.value }))} placeholder="https://…" />
                </label>
              )}
              <label>Price ($/mo, 0 = free)
                <input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="9.99" />
              </label>
              {form.listing_type === 'integration' && (
                <label>MCP server URL *
                  <input value={form.mcp_server_url} onChange={(e) => setForm((f) => ({ ...f, mcp_server_url: e.target.value }))} required={!editingListing} placeholder="http://74.161.41.130:8010/mcp" />
                </label>
              )}
              {form.listing_type === 'role_pack' && (
                <label>Role prompt * (well-written prompt for this role; RAG + documents later)
                  <textarea value={form.role_prompt} onChange={(e) => setForm((f) => ({ ...f, role_prompt: e.target.value }))} rows={6} required={!editingListing} placeholder="You are acting as a… Be concise. …" />
                </label>
              )}
              {form.listing_type === 'avatar' && !editingListing && (
                <>
                  <label>Face image *
                    <input type="file" accept="image/png,image/jpeg,image/jpg,image/webp" onChange={(e) => setAvatarFaceFile(e.target.files?.[0] || null)} />
                    {avatarFaceFile && <span className="form-hint">Selected: {avatarFaceFile.name}</span>}
                  </label>
                  <label>Voice sample * (WAV or other audio)
                    <input type="file" accept="audio/*,.wav" onChange={(e) => setAvatarVoiceFile(e.target.files?.[0] || null)} />
                    {avatarVoiceFile && <span className="form-hint">Selected: {avatarVoiceFile.name}</span>}
                  </label>
                </>
              )}
              {form.listing_type === 'avatar' && editingListing && (
                <p className="form-hint">Avatar image and voice cannot be changed. Edit name, description, or price only.</p>
              )}
              <button type="submit" className="marketplace-form-save" disabled={formSaving}>
                {formSaving ? 'Saving…' : editingListing ? 'Save changes' : 'Add listing'}
              </button>
            </form>
          </div>
        </div>
      )}

      <style>{`
        .marketplace-page { padding: 2rem; max-width: 1000px; margin: 0 auto; min-height: 100vh; background: var(--bg-page); }
        .marketplace-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 2rem; }
        .marketplace-header-left { flex: 1; min-width: 0; }
        .marketplace-back { display: inline-block; margin-bottom: 0.5rem; color: var(--primary); font-size: 0.95rem; }
        .marketplace-back:hover { text-decoration: none; }
        .marketplace-title { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; margin: 0 0 0.25rem; color: var(--text-primary); }
        .marketplace-tagline { font-size: 0.95rem; color: var(--text-muted); margin: 0; }
        .marketplace-admin-btn { padding: 0.5rem 1rem; background: var(--primary); color: #fff; border: none; border-radius: var(--radius); font-weight: 600; cursor: pointer; white-space: nowrap; font-size: 0.9rem; }
        .marketplace-admin-btn:hover { background: var(--primary-hover); }
        .marketplace-loading { color: var(--text-muted); padding: 2rem 0; }
        .marketplace-empty { text-align: center; padding: 3rem 1rem; color: var(--text-secondary); }
        .marketplace-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 1rem; }
        .marketplace-card-wrap { display: flex; flex-direction: column; gap: 0.25rem; height: 100%; }
        .marketplace-card { display: flex; flex-direction: column; align-items: center; padding: 1rem 0.75rem; border-radius: var(--radius-lg); border: 1px solid var(--border); background: var(--bg-card); cursor: pointer; transition: box-shadow 0.2s, transform 0.15s; text-align: center; width: 100%; min-height: 120px; flex: 1; }
        .marketplace-card:hover { box-shadow: var(--shadow); transform: translateY(-2px); }
        .marketplace-card-thumb { width: 48px; height: 48px; min-width: 48px; min-height: 48px; display: flex; align-items: center; justify-content: center; margin-bottom: 0.5rem; overflow: hidden; }
        .marketplace-card-thumb img { width: 100%; height: 100%; object-fit: contain; object-position: center; }
        .marketplace-card-thumb-avatar { border-radius: 50%; }
        .marketplace-card-thumb-avatar img { object-fit: cover; object-position: center; }
        .marketplace-card-icon { font-size: 1.5rem; font-weight: 700; color: var(--primary); }
        .marketplace-card-name { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); line-height: 1.2; }
        .marketplace-card-price { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.2rem; }
        .marketplace-card-owned { font-size: 0.7rem; font-weight: 700; color: #22c55e; margin-top: 0.15rem; background: rgba(34,197,94,0.1); padding: 0.1rem 0.4rem; border-radius: 999px; }
        .marketplace-card-admin { display: flex; gap: 0.25rem; justify-content: center; }
        .mkt-admin-edit, .mkt-admin-delete { font-size: 0.75rem; padding: 0.15rem 0.4rem; border: none; border-radius: var(--radius); cursor: pointer; }
        .mkt-admin-edit { background: var(--bg-card); color: var(--primary); border: 1px solid var(--border); }
        .mkt-admin-delete { background: none; color: var(--error, #c0392b); border: 1px solid transparent; }
        .mkt-admin-delete:hover { border-color: var(--error, #c0392b); }
        .marketplace-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 1rem; }
        .marketplace-modal { background: var(--bg-card); border-radius: var(--radius-lg); padding: 1.5rem; max-width: 440px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.15); position: relative; max-height: 90vh; overflow-y: auto; }
        .marketplace-modal-header { display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 1rem; }
        .marketplace-modal-thumb { width: 40px; height: 40px; min-width: 40px; min-height: 40px; flex-shrink: 0; overflow: hidden; }
        .marketplace-modal-thumb img { width: 100%; height: 100%; object-fit: contain; object-position: center; }
        .marketplace-modal-thumb-avatar { border-radius: 50%; }
        .marketplace-modal-thumb-avatar img { object-fit: cover; object-position: center; }
        .marketplace-modal-title { font-family: var(--font-heading); font-size: 1.2rem; font-weight: 600; margin: 0; color: var(--text-primary); flex: 1; }
        .marketplace-modal-price { font-size: 0.85rem; color: var(--text-muted); margin: 0.15rem 0 0; }
        .marketplace-modal-close { background: none; border: none; font-size: 1.5rem; color: var(--text-muted); cursor: pointer; padding: 0 0.25rem; line-height: 1; flex-shrink: 0; }
        .marketplace-modal-close:hover { color: var(--text-primary); }
        .marketplace-modal-desc { font-size: 0.95rem; color: var(--text-secondary); line-height: 1.5; margin: 0 0 1.25rem; }
        .marketplace-modal-actions { display: flex; gap: 0.75rem; align-items: center; }
        .marketplace-owned-badge { font-weight: 600; color: #22c55e; font-size: 0.95rem; }
        .btn-marketplace { padding: 0.6rem 1.2rem; border-radius: var(--radius); font-weight: 600; cursor: pointer; font-size: 0.95rem; border: none; }
        .btn-buy { background: var(--primary); color: #fff; }
        .btn-buy:disabled { opacity: 0.7; cursor: not-allowed; }
        .btn-buy:not(:disabled):hover { background: var(--primary-hover); }
        .marketplace-form-error { color: var(--error, #c00); font-size: 0.9rem; margin-bottom: 0.75rem; }
        .marketplace-admin-form { display: flex; flex-direction: column; gap: 0.85rem; }
        .marketplace-admin-form label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; font-weight: 500; color: var(--text-primary); }
        .marketplace-admin-form input, .marketplace-admin-form textarea { padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-page); color: var(--text-primary); font-size: 0.95rem; }
        .marketplace-admin-form input:focus, .marketplace-admin-form textarea:focus { outline: none; border-color: var(--primary); }
        .marketplace-form-save { padding: 0.65rem; background: var(--primary); color: #fff; border: none; border-radius: var(--radius); font-weight: 600; cursor: pointer; margin-top: 0.25rem; }
        .marketplace-form-save:disabled { opacity: 0.7; cursor: not-allowed; }
        .marketplace-form-save:not(:disabled):hover { background: var(--primary-hover); }
        .form-hint { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.2rem; }
        .marketplace-admin-form select { padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-page); color: var(--text-primary); font-size: 0.95rem; }
        .marketplace-filters { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
        .marketplace-filter-btn { padding: 0.4rem 0.9rem; font-size: 0.85rem; font-weight: 600; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; }
        .marketplace-filter-btn:hover { background: var(--bg-page); color: var(--text-primary); border-color: var(--border); }
        .marketplace-filter-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
        .marketplace-no-results { color: var(--text-muted); padding: 2rem 0; margin: 0; font-size: 0.95rem; }
        .marketplace-card-type { display: block; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; padding: 0.15rem 0.4rem; border-radius: 999px; background: var(--border); color: var(--text-muted); margin-bottom: 0.5rem; }
        .marketplace-card-type-role_pack { background: rgba(139, 92, 246, 0.2); color: #8b5cf6; }
        .marketplace-card-type-avatar { background: rgba(34, 197, 94, 0.2); color: #22c55e; }
        .marketplace-card-type-twyn { background: rgba(14, 165, 233, 0.15); color: #0284c7; }
        .marketplace-card-type-integration { background: rgba(100, 116, 139, 0.2); color: var(--text-secondary); }
        .marketplace-card-thumb .fallback { display: none; width: 100%; height: 100%; align-items: center; justify-content: center; }
        .marketplace-card-thumb .fallback.show { display: flex; }
        .marketplace-modal-thumb .fallback { display: none; width: 100%; height: 100%; align-items: center; justify-content: center; }
        .marketplace-modal-thumb .fallback.show { display: flex; }
      `}</style>
    </div>
  )
}
