import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch, getUser, getToken } from '../auth'

const API = '/api'
const KNOWLEDGE_PACK_MAX_DOCS = 5
const PROMO_HINT = 'Paid items: enter promo code twins to redeem for free (beta).'

export default function Marketplace() {
  const user = getUser()
  const isAdmin = user?.is_admin === true

  const [listings, setListings] = useState([])
  const [purchases, setPurchases] = useState([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState('all')
  const [modalListing, setModalListing] = useState(null)
  const [modalPromo, setModalPromo] = useState('')
  const [buying, setBuying] = useState(null)
  const [buyError, setBuyError] = useState(null)
  const [showAdminForm, setShowAdminForm] = useState(false)
  const [editingListing, setEditingListing] = useState(null)
  const [form, setForm] = useState({
    name: '',
    description: '',
    price: '',
    listing_type: 'knowledge_pack',
  })
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(null)
  const [knowledgePackFiles, setKnowledgePackFiles] = useState([])
  const [mcpBinaryFile, setMcpBinaryFile] = useState(null)
  const [mcpSetupInstructions, setMcpSetupInstructions] = useState('')
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

  useEffect(() => () => {
    if (logoPreviewUrl) URL.revokeObjectURL(logoPreviewUrl)
  }, [logoPreviewUrl])

  const clearLogoPick = useCallback(() => {
    setLogoFile(null)
    setLogoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }, [])

  const onLogoFileChange = (e) => {
    const f = e.target.files?.[0] || null
    setLogoFile(f)
    setLogoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return f ? URL.createObjectURL(f) : null
    })
  }

  const isOwned = (id) => purchases.includes(id)

  const listingType = (l) => l.listing_type || 'integration'

  const listingTypeLabel = (l) => (listingType(l) === 'mcp' ? 'Capability' : 'Knowledge')

  const filteredListings = typeFilter === 'all'
    ? listings
    : listings.filter((l) => listingType(l) === typeFilter)

  const handleBuy = async (listing) => {
    setBuyError(null)
    setBuying(listing.id)
    try {
      const res = await apiFetch(`${API}/marketplace/${listing.id}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promo_code: modalPromo.trim() || undefined }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(typeof data.detail === 'string' ? data.detail : (data.detail?.[0]?.msg || 'Purchase failed'))
      }
      setPurchases((prev) => (prev.includes(listing.id) ? prev : [...prev, listing.id]))
      setModalListing(null)
      setModalPromo('')
    } catch (e) {
      setBuyError(e.message || 'Purchase failed')
    } finally {
      setBuying(null)
    }
  }

  const openAdminNew = () => {
    setEditingListing(null)
    clearLogoPick()
    setForm({ name: '', description: '', price: '', listing_type: 'knowledge_pack' })
    setKnowledgePackFiles([])
    setMcpBinaryFile(null)
    setMcpSetupInstructions('')
    setFormError(null)
    setShowAdminForm(true)
  }

  const openAdminEdit = (l) => {
    setEditingListing(l)
    clearLogoPick()
    setForm({
      name: l.name,
      description: l.description || '',
      price: String(l.price || 0),
      listing_type: listingType(l),
    })
    setKnowledgePackFiles([])
    setMcpBinaryFile(null)
    setMcpSetupInstructions(l.setup_instructions || '')
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
    const type = (form.listing_type || 'knowledge_pack').trim()
    if (!form.name.trim()) { setFormError('Name is required'); return }
    if (type === 'knowledge_pack' && !editingListing) {
      if (!knowledgePackFiles.length) { setFormError('Add at least one PDF or TXT file for a knowledge pack'); return }
      if (knowledgePackFiles.length > KNOWLEDGE_PACK_MAX_DOCS) {
        setFormError(`A knowledge pack can include at most ${KNOWLEDGE_PACK_MAX_DOCS} documents`)
        return
      }
    }
    if (type === 'mcp' && !editingListing && !mcpBinaryFile) {
      setFormError('Binary file is required for a new capability')
      return
    }
    setFormSaving(true)
    try {
      if (type === 'knowledge_pack' && !editingListing && knowledgePackFiles.length > 0) {
        const fd = new FormData()
        fd.set('name', form.name.trim())
        fd.set('description', form.description.trim())
        fd.set('price', String(parseFloat(form.price) || 0))
        if (logoFile) fd.set('logo', logoFile)
        knowledgePackFiles.forEach((file) => fd.append('files', file))
        const res = await apiFetch(`${API}/admin/marketplace/knowledge-pack`, { method: 'POST', body: fd })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Knowledge pack creation failed') }
        const saved = await res.json()
        setListings((prev) => [...prev, saved])
        clearLogoPick()
        setShowAdminForm(false)
      } else if (type === 'mcp' && !editingListing && mcpBinaryFile) {
        const fd = new FormData()
        fd.set('name', form.name.trim())
        fd.set('description', form.description.trim())
        fd.set('price', String(parseFloat(form.price) || 0))
        if (logoFile) fd.set('logo', logoFile)
        fd.set('setup_instructions', mcpSetupInstructions.trim())
        fd.set('required_env_keys', '[]')
        fd.set('binary', mcpBinaryFile)
        const res = await apiFetch(`${API}/admin/marketplace/mcp`, { method: 'POST', body: fd })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Capability creation failed') }
        const saved = await res.json()
        setListings((prev) => [...prev, saved])
        clearLogoPick()
        setShowAdminForm(false)
      } else if (editingListing) {
        const body = {
          name: form.name.trim(),
          description: form.description.trim(),
          price: parseFloat(form.price) || 0,
          mcp_server_url: '',
          listing_type: type,
          role_prompt: '',
        }
        const res = await apiFetch(`${API}/admin/marketplace/${editingListing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Save failed') }
        let saved = await res.json()
        if (logoFile) {
          const lfd = new FormData()
          lfd.set('logo', logoFile)
          const logoRes = await apiFetch(`${API}/admin/marketplace/${editingListing.id}/logo`, { method: 'POST', body: lfd })
          if (!logoRes.ok) {
            const d = await logoRes.json().catch(() => ({}))
            throw new Error(typeof d.detail === 'string' ? d.detail : (d.detail?.[0]?.msg || 'Logo upload failed'))
          }
          saved = await logoRes.json()
        }
        setListings((prev) => prev.map((l) => (l.id === saved.id ? saved : l)))
        clearLogoPick()
        setShowAdminForm(false)
      }
    } catch (err) {
      setFormError(err.message)
    } finally {
      setFormSaving(false)
    }
  }

  const filterEmptyLabel = typeFilter === 'knowledge_pack' ? 'knowledge packs' : typeFilter === 'mcp' ? 'capabilities' : 'listings'

  return (
    <div className="marketplace-page">
      <header className="marketplace-header">
        <div className="marketplace-header-left">
          <Link to="/app" className="marketplace-back">← Back to app</Link>
          <h1 className="marketplace-title">Marketplace</h1>
          <p className="marketplace-tagline">Capabilities and knowledge packs for your twyns</p>
        </div>
        {isAdmin && (
          <button type="button" className="marketplace-admin-btn" onClick={openAdminNew}>+ Add listing</button>
        )}
      </header>

      <p className="marketplace-promo-banner">{PROMO_HINT}</p>

      {loading ? (
        <p className="marketplace-loading">Loading…</p>
      ) : listings.length === 0 ? (
        <div className="marketplace-empty">
          <p>No listings yet{isAdmin ? '. Add a capability or knowledge pack.' : '.'}</p>
        </div>
      ) : (
        <>
          <div className="marketplace-filters">
            {[
              { key: 'all', label: 'All' },
              { key: 'mcp', label: 'Capabilities' },
              { key: 'knowledge_pack', label: 'Knowledge' },
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
                <button type="button" className="marketplace-card" onClick={() => { setModalListing(listing); setModalPromo(''); setBuyError(null) }}>
                  <span className={`marketplace-card-type marketplace-card-type-${listingType(listing)}`}>{listingTypeLabel(listing)}</span>
                  <div className="marketplace-card-thumb">
                    {listing.logo_url
                      ? <img src={listing.logo_url} alt="" />
                      : <span className="marketplace-card-icon">{listing.name[0]}</span>}
                  </div>
                  <span className="marketplace-card-name">{listing.name}</span>
                  {listing.price > 0 && <span className="marketplace-card-price">${listing.price.toFixed(2)}/mo</span>}
                  {isOwned(listing.id) && <span className="marketplace-card-owned">Owned</span>}
                </button>
                {isAdmin && (
                  <div className="marketplace-card-admin">
                    <button type="button" className="mkt-admin-edit" onClick={() => openAdminEdit(listing)}>Edit</button>
                    <button type="button" className="mkt-admin-delete" onClick={() => handleAdminDelete(listing.id)}>Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {filteredListings.length === 0 && (
            <p className="marketplace-no-results">No {filterEmptyLabel} match this filter.</p>
          )}
        </>
      )}

      {modalListing && (
        <div className="marketplace-modal-overlay" onClick={() => setModalListing(null)}>
          <div className="marketplace-modal" onClick={(e) => e.stopPropagation()}>
            <div className="marketplace-modal-header">
              <div className="marketplace-modal-thumb">
                {modalListing.logo_url
                  ? <img src={modalListing.logo_url} alt="" />
                  : <span className="marketplace-card-icon">{modalListing.name[0]}</span>}
              </div>
              <div>
                <h2 className="marketplace-modal-title">{modalListing.name}</h2>
                {modalListing.price > 0 && <p className="marketplace-modal-price">${modalListing.price.toFixed(2)} / month</p>}
              </div>
              <button type="button" className="marketplace-modal-close" onClick={() => setModalListing(null)} aria-label="Close">×</button>
            </div>
            <p className="marketplace-modal-desc">
              {modalListing.description
                || (listingType(modalListing) === 'knowledge_pack'
                  ? `Knowledge pack: ${modalListing.knowledge_pack_file_count ?? '?'} document(s). Copied into your twyn’s knowledge base when attached.`
                  : 'Self-hosted capability: download the binary, run with your license key, then add the MCP URL when editing your twyn.')}
            </p>
            {listingType(modalListing) === 'mcp' && modalListing.setup_instructions && (
              <pre className="marketplace-mcp-setup">{modalListing.setup_instructions}</pre>
            )}
            {!isOwned(modalListing.id) && modalListing.price > 0 && (
              <label className="marketplace-modal-promo">
                Promo code
                <input
                  type="text"
                  value={modalPromo}
                  onChange={(e) => setModalPromo(e.target.value)}
                  placeholder="twins"
                  autoComplete="off"
                />
              </label>
            )}
            {buyError && <p className="marketplace-buy-error">{buyError}</p>}
            <div className="marketplace-modal-actions">
              {isOwned(modalListing.id) ? (
                <>
                  {listingType(modalListing) === 'mcp' && (
                    <a
                      className="btn-marketplace btn-buy"
                      href={`${API}/marketplace/${modalListing.id}/binary?token=${encodeURIComponent(getToken() || '')}`}
                      download
                    >
                      Download binary
                    </a>
                  )}
                  <span className="marketplace-owned-badge">✓ Owned</span>
                </>
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
                <select
                  value={form.listing_type}
                  onChange={(e) => setForm((f) => ({ ...f, listing_type: e.target.value }))}
                  disabled={!!editingListing}
                >
                  <option value="knowledge_pack">Knowledge pack (PDF/TXT bundle)</option>
                  <option value="mcp">Capability (self-hosted binary)</option>
                </select>
                {editingListing && <span className="form-hint">Type cannot be changed when editing.</span>}
              </label>
              <label>Name *
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required placeholder="Name" />
              </label>
              <label>Description
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="What this listing is for…" />
              </label>
              <label className="marketplace-logo-field">Logo (optional)
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
                  onChange={onLogoFileChange}
                />
                {(logoPreviewUrl || editingListing?.logo_url) && (
                  <div className="marketplace-logo-preview-wrap">
                    <img
                      src={logoPreviewUrl || editingListing.logo_url}
                      alt=""
                      className="marketplace-logo-preview"
                    />
                  </div>
                )}
                <span className="form-hint">PNG, JPG, WebP, or GIF — max 2MB. Leave empty to keep the current logo when editing.</span>
              </label>
              <label>Price ($/mo, 0 = free)
                <input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="9.99" />
              </label>
              <p className="form-hint admin-price-hint">Buyers use promo code <strong>twins</strong> to redeem paid listings for free during beta.</p>
              {form.listing_type === 'mcp' && !editingListing && (
                <>
                  <label>Binary file *
                    <input type="file" onChange={(e) => setMcpBinaryFile(e.target.files?.[0] || null)} />
                    {mcpBinaryFile && <span className="form-hint">Selected: {mcpBinaryFile.name}</span>}
                  </label>
                  <label>Setup instructions
                    <textarea value={mcpSetupInstructions} onChange={(e) => setMcpSetupInstructions(e.target.value)} rows={4} placeholder="How to run the binary, license flag, port, …" />
                  </label>
                </>
              )}
              {form.listing_type === 'mcp' && editingListing && (
                <p className="form-hint">Binary is fixed after creation. Edit name, description, logo, and price.</p>
              )}
              {form.listing_type === 'knowledge_pack' && !editingListing && (
                <label>Documents * (PDF or TXT, 1–{KNOWLEDGE_PACK_MAX_DOCS} files)
                  <input
                    type="file"
                    accept=".pdf,.txt,application/pdf,text/plain"
                    multiple
                    onChange={(e) => {
                      const list = Array.from(e.target.files || [])
                      if (list.length > KNOWLEDGE_PACK_MAX_DOCS) {
                        setFormError(`Only the first ${KNOWLEDGE_PACK_MAX_DOCS} files are kept (max ${KNOWLEDGE_PACK_MAX_DOCS} per pack).`)
                        setKnowledgePackFiles(list.slice(0, KNOWLEDGE_PACK_MAX_DOCS))
                      } else {
                        setFormError(null)
                        setKnowledgePackFiles(list)
                      }
                    }}
                  />
                  {knowledgePackFiles.length > 0 && (
                    <span className="form-hint">{knowledgePackFiles.length} / {KNOWLEDGE_PACK_MAX_DOCS} file(s) selected</span>
                  )}
                </label>
              )}
              {form.listing_type === 'knowledge_pack' && editingListing && (
                <p className="form-hint">Files are fixed after creation. Edit name, description, logo, or price only.</p>
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
        .marketplace-promo-banner { font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 1.25rem; padding: 0.65rem 0.9rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-card); }
        .marketplace-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
        .marketplace-header-left { flex: 1; min-width: 0; }
        .marketplace-back { display: inline-block; margin-bottom: 0.5rem; color: var(--primary); font-size: 0.95rem; }
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
        .marketplace-modal-thumb { width: 40px; height: 40px; min-width: 40px; min-height: 40px; flex-shrink: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
        .marketplace-modal-thumb img { width: 100%; height: 100%; object-fit: contain; object-position: center; }
        .marketplace-modal-title { font-family: var(--font-heading); font-size: 1.2rem; font-weight: 600; margin: 0; color: var(--text-primary); flex: 1; }
        .marketplace-modal-price { font-size: 0.85rem; color: var(--text-muted); margin: 0.15rem 0 0; }
        .marketplace-modal-close { background: none; border: none; font-size: 1.5rem; color: var(--text-muted); cursor: pointer; padding: 0 0.25rem; line-height: 1; flex-shrink: 0; }
        .marketplace-modal-close:hover { color: var(--text-primary); }
        .marketplace-modal-desc { font-size: 0.95rem; color: var(--text-secondary); line-height: 1.5; margin: 0 0 1.25rem; }
        .marketplace-modal-promo { display: flex; flex-direction: column; gap: 0.35rem; font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-primary); }
        .marketplace-modal-promo input { padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); color: var(--text-primary); }
        .marketplace-buy-error { color: var(--error, #c00); font-size: 0.88rem; margin: 0 0 0.75rem; }
        .marketplace-modal-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
        .marketplace-owned-badge { font-weight: 600; color: #22c55e; font-size: 0.95rem; }
        .btn-marketplace { padding: 0.6rem 1.2rem; border-radius: var(--radius); font-weight: 600; cursor: pointer; font-size: 0.95rem; border: none; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
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
        .admin-price-hint { margin: -0.25rem 0 0; }
        .marketplace-admin-form select { padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-page); color: var(--text-primary); font-size: 0.95rem; }
        .marketplace-filters { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
        .marketplace-filter-btn { padding: 0.4rem 0.9rem; font-size: 0.85rem; font-weight: 600; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; }
        .marketplace-filter-btn:hover { background: var(--bg-page); color: var(--text-primary); border-color: var(--border); }
        .marketplace-filter-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
        .marketplace-no-results { color: var(--text-muted); padding: 2rem 0; margin: 0; font-size: 0.95rem; }
        .marketplace-card-type { display: block; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; padding: 0.15rem 0.4rem; border-radius: 999px; background: var(--border); color: var(--text-muted); margin-bottom: 0.5rem; }
        .marketplace-card-type-knowledge_pack { background: rgba(245, 158, 11, 0.2); color: #d97706; }
        .marketplace-card-type-mcp { background: rgba(59, 130, 246, 0.2); color: #2563eb; }
        .marketplace-mcp-setup { font-size: 0.85rem; white-space: pre-wrap; background: var(--bg-page); border: 1px solid var(--border); border-radius: var(--radius); padding: 0.75rem; max-height: 200px; overflow-y: auto; margin: 0 0 0.75rem; color: var(--text-secondary); }
        .marketplace-logo-field input[type="file"] { font-size: 0.85rem; }
        .marketplace-logo-preview-wrap { margin-top: 0.35rem; }
        .marketplace-logo-preview { width: 64px; height: 64px; object-fit: contain; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-page); }
      `}</style>
    </div>
  )
}
