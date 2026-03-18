const supabase = require('../db')

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.cookies?.session
    const refreshToken = req.cookies?.refresh

    if (!token) return res.status(401).json({ error: 'Not authenticated' })

    let user = null

    const { data: userData, error: userError } = await supabase.auth.getUser(token)

    if (userError) {
      if (!refreshToken) return res.status(401).json({ error: 'Session expired. Please log in again.' })

      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession({ refresh_token: refreshToken })
      if (refreshError || !refreshData?.session) {
        return res.status(401).json({ error: 'Session expired. Please log in again.' })
      }

      const cookieOpts = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
      }
      res.cookie('session', refreshData.session.access_token, { ...cookieOpts, maxAge: 60 * 60 * 1000 })
      res.cookie('refresh', refreshData.session.refresh_token, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60 * 1000 })
      user = refreshData.user
    } else {
      user = userData.user
    }

    if (!user) return res.status(401).json({ error: 'Invalid session' })

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Profile not found. Please complete setup.' })
    }

    req.user = { id: user.id, email: user.email, profile }
    next()
  } catch (err) {
    console.error('Auth middleware error:', err.message)
    res.status(401).json({ error: 'Authentication failed' })
  }
}

module.exports = { authMiddleware }
