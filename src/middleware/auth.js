const supabase = require('../db')
const jwt = require('jsonwebtoken')

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/'
}

const tryRefresh = async (refreshToken, res) => {
  if (!refreshToken) return null
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data?.session) return null
  res.cookie('session', data.session.access_token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 1000 })
  res.cookie('refresh', data.session.refresh_token, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 })
  return data.user
}

const jwksClient = require('jwks-rsa')

const jwks = jwksClient({
  jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86400000
})

const verifyToken = async (token) => {
  try {
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, (header, callback) => {
        jwks.getSigningKey(header.kid, (err, key) => {
          if (err) return callback(err)
          callback(null, key.getPublicKey())
        })
      }, { algorithms: ['ES256'] }, (err, result) => {
        if (err) reject(err)
        else resolve(result)
      })
    })
    return { id: decoded.sub, email: decoded.email }
  } catch (err) {
    console.log('JWT verify error:', err.message)
    return null
  }
}

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.cookies?.session
    const refreshToken = req.cookies?.refresh

    if (!token && !refreshToken) return res.status(401).json({ error: 'Not authenticated' })

    let userId = null
    let userEmail = null

    if (token) {
      const decoded = await verifyToken(token)
      if (decoded) {
        userId = decoded.id
        userEmail = decoded.email
      }
    }

    // Access token missing or expired — try refresh
    if (!userId) {
      const user = await tryRefresh(refreshToken, res)
      if (!user) return res.status(401).json({ error: 'Session expired. Please log in again.' })
      userId = user.id
      userEmail = user.email
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Profile not found. Please complete setup.' })
    }
    if (!profile.tos_agreed) {
      return res.status(403).json({ error: 'tos_required' })
    }
    if (profile.is_suspended) {
      res.clearCookie('session', { path: '/' })
      res.clearCookie('refresh', { path: '/' })
      return res.status(403).json({ error: 'suspended', message: 'Your account has been suspended. Contact support for assistance.' })
    }

    req.user = { id: userId, email: userEmail, profile }
    next()
  } catch (err) {
    console.error('Auth middleware error:', err.message)
    res.status(401).json({ error: 'Authentication failed' })
  }
}

// Same as authMiddleware but skips the tos_agreed check
const authMiddlewareNoTos = async (req, res, next) => {
  try {
    const token = req.cookies?.session
    const refreshToken = req.cookies?.refresh

    if (!token && !refreshToken) return res.status(401).json({ error: 'Not authenticated' })

    let userId = null
    let userEmail = null

    if (token) {
      const decoded = await verifyToken(token)
      if (decoded) {
        userId = decoded.id
        userEmail = decoded.email
      }
    }

    if (!userId) {
      const user = await tryRefresh(refreshToken, res)
      if (!user) return res.status(401).json({ error: 'Session expired. Please log in again.' })
      userId = user.id
      userEmail = user.email
    }

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (profileError || !profile) return res.status(401).json({ error: 'Profile not found. Please complete setup.' })

    req.user = { id: userId, email: userEmail, profile }
    next()
  } catch (err) {
    console.error('Auth middleware error:', err.message)
    res.status(401).json({ error: 'Authentication failed' })
  }
}

const adminMiddleware = async (req, res, next) => {
  if (!req.user?.profile?.is_admin) {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

module.exports = { authMiddleware, authMiddlewareNoTos, adminMiddleware }
