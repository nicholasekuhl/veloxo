/*
 RAILWAY SETUP — add a second service:

 1. Go to Railway dashboard
 2. Click "+ New" inside your project
 3. Select "GitHub Repo" and pick textapp
 4. In the new service Settings:
    - Change Start Command to:
      node src/worker.js
    - Add all the same environment variables
      as the web server service
 5. Deploy the worker service
 6. The web server (server.js) no longer
    runs the scheduler — only the worker does
*/

require('dotenv').config()

const { startScheduler } = require('./scheduler')
const { smsQueue } = require('./smsQueue')

console.log('Veloxo Worker starting...')



// Start the scheduler
startScheduler()
console.log('Scheduler started')

// Health check endpoint for Railway
const http = require('http')
const supabase = require('./db')

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    try {
      const { data } = await supabase
        .from('scheduler_health')
        .select('last_heartbeat')
        .eq('id', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
        .single()

      const age = data?.last_heartbeat
        ? Date.now() - new Date(data.last_heartbeat).getTime()
        : null

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        last_heartbeat: data?.last_heartbeat,
        age_seconds: age ? Math.round(age / 1000) : null
      }))
    } catch (err) {
      res.writeHead(500)
      res.end(JSON.stringify({ status: 'error', error: err.message }))
    }
  } else {
    res.writeHead(404)
    res.end()
  }
})

const PORT = process.env.WORKER_PORT || 3001
server.listen(PORT, () => {
  console.log('Worker health endpoint on port', PORT)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Worker SIGTERM — draining queue')
  server.close()

  let waited = 0
  const check = setInterval(() => {
    const { inQueue } = smsQueue.getStats()
    waited += 500
    if (inQueue === 0 || waited >= 30000) {
      clearInterval(check)
      console.log('Worker shutdown complete')
      process.exit(0)
    }
  }, 500)
})
