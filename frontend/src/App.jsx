import { Routes, Route, Navigate } from 'react-router-dom'
import Landing from './pages/Landing'
import Home from './pages/Home'
import CreatePersona from './pages/CreatePersona'
import CreatingPersona from './pages/CreatingPersona'
import Conversation from './pages/Conversation'
import EditPersona from './pages/EditPersona'
import Marketplace from './pages/Marketplace'
import Admin from './pages/Admin'
import Payment from './pages/Payment'
import Login from './pages/Login'
import Signup from './pages/Signup'
import { getToken } from './auth'

function ProtectedRoute({ children }) {
  return getToken() ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/app" element={<ProtectedRoute><Home /></ProtectedRoute>} />
      <Route path="/create" element={<ProtectedRoute><CreatePersona /></ProtectedRoute>} />
      <Route path="/creating" element={<ProtectedRoute><CreatingPersona /></ProtectedRoute>} />
      <Route path="/persona/:personaId" element={<ProtectedRoute><Conversation /></ProtectedRoute>} />
      <Route path="/persona/:personaId/edit" element={<ProtectedRoute><EditPersona /></ProtectedRoute>} />
      <Route path="/marketplace" element={<ProtectedRoute><Marketplace /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
      <Route path="/payment" element={<ProtectedRoute><Payment /></ProtectedRoute>} />
    </Routes>
  )
}
