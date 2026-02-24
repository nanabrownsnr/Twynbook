import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

export default function Payment() {
  const location = useLocation()
  const navigate = useNavigate()
  const item = location.state?.item
  const [cardNumber, setCardNumber] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cvc, setCvc] = useState('')
  const [name, setName] = useState('')
  const [processing, setProcessing] = useState(false)
  const [done, setDone] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    setProcessing(true)
    setTimeout(() => {
      setProcessing(false)
      setDone(true)
      setTimeout(() => navigate('/marketplace'), 2000)
    }, 1500)
  }

  if (done) {
    return (
      <div className="payment-page">
        <div className="payment-done">
          <p className="payment-done-title">Payment successful</p>
          <p className="payment-done-msg">Redirecting you back to the marketplace…</p>
        </div>
        <style>{`
          .payment-page { padding: 2rem; max-width: 440px; margin: 0 auto; min-height: 100vh; background: var(--bg-page); display: flex; align-items: center; justify-content: center; }
          .payment-done { text-align: center; }
          .payment-done-title { font-family: var(--font-heading); font-size: 1.25rem; font-weight: 600; color: var(--text-primary); margin: 0 0 0.5rem; }
          .payment-done-msg { font-size: 0.95rem; color: var(--text-muted); margin: 0; }
        `}</style>
      </div>
    )
  }

  return (
    <div className="payment-page">
      <header className="payment-header">
        <Link to="/marketplace" className="payment-back">← Back to marketplace</Link>
        <h1 className="payment-title">Checkout</h1>
        {item && (
          <p className="payment-item">Paying for: <strong>{item.name}</strong></p>
        )}
      </header>

      <form onSubmit={handleSubmit} className="payment-form">
        <p className="payment-note">This is a mock payment page. No real charges will be made.</p>
        <label>
          Card number
          <input
            type="text"
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            placeholder="4242 4242 4242 4242"
            maxLength={19}
          />
        </label>
        <div className="payment-row">
          <label>
            Expiry
            <input
              type="text"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              placeholder="MM/YY"
              maxLength={5}
            />
          </label>
          <label>
            CVC
            <input
              type="text"
              value={cvc}
              onChange={(e) => setCvc(e.target.value)}
              placeholder="123"
              maxLength={4}
            />
          </label>
        </div>
        <label>
          Name on card
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
          />
        </label>
        <button type="submit" className="payment-submit" disabled={processing}>
          {processing ? 'Processing…' : 'Pay now'}
        </button>
      </form>

      <style>{`
        .payment-page { padding: 2rem; max-width: 440px; margin: 0 auto; min-height: 100vh; background: var(--bg-page); }
        .payment-header { margin-bottom: 1.5rem; }
        .payment-back { display: inline-block; margin-bottom: 0.5rem; color: var(--primary); font-size: 0.95rem; }
        .payment-back:hover { text-decoration: none; }
        .payment-title { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; margin: 0 0 0.25rem; color: var(--text-primary); }
        .payment-item { font-size: 0.95rem; color: var(--text-secondary); margin: 0; }
        .payment-note { font-size: 0.85rem; color: var(--text-muted); margin: 0 0 1rem; padding: 0.5rem 0.75rem; background: var(--primary-muted); border-radius: var(--radius); }
        .payment-form label { display: block; margin-bottom: 1rem; color: var(--text-primary); }
        .payment-form input { width: 100%; padding: 0.5rem 0.75rem; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); margin-top: 0.25rem; }
        .payment-form input:focus { outline: none; border-color: var(--border-focus); box-shadow: 0 0 0 2px var(--primary-muted); }
        .payment-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        .payment-submit { width: 100%; padding: 0.75rem 1.25rem; border-radius: var(--radius); border: none; background: var(--primary); color: #fff; font-weight: 600; cursor: pointer; margin-top: 0.5rem; }
        .payment-submit:hover:not(:disabled) { background: var(--primary-hover); }
        .payment-submit:disabled { opacity: 0.7; cursor: not-allowed; }
      `}</style>
    </div>
  )
}
