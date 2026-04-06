/**
 * smsQueue.js
 * 
 * A lightweight, in-process SMS send queue.
 * Replaces fire-all-at-once blasts with a controlled rate-limited drain.
 * 
 * HOW IT WORKS:
 *   - Jobs are pushed onto a queue array (non-blocking, instant)
 *   - A single interval drains the queue at RATE_PER_SECOND (default: 3/sec)
 *   - Failed jobs retry up to MAX_RETRIES with exponential backoff
 *   - Auth/credential errors are NOT retried (they won't self-heal)
 *   - The event loop is never blocked — your API stays responsive no matter what
 * 
 * USAGE IN YOUR ENROLL ROUTE:
 *   const { smsQueue } = require('./smsQueue');
 *   // Instead of: await sendSMS(phone, message)
 *   // Do:         smsQueue.add({ phone, message, leadId, conversationId, userId })
 */

const RATE_PER_SECOND = 10;      // SMS sends per second (safe for 10DLC A2P registered numbers)
const DRAIN_INTERVAL_MS = 1000;  // Check queue every 1 second
const MAX_RETRIES = 3;           // Max attempts per job before giving up
const BACKOFF_BASE_MS = 2000;    // 2s, 4s, 8s backoff between retries

// ─── Queue state ─────────────────────────────────────────────────────────────
const queue = [];
let isRunning = false;
let stats = { sent: 0, failed: 0, retried: 0, inQueue: 0 };

// ─── Non-retryable error patterns ────────────────────────────────────────────
const FATAL_ERRORS = [
  'Authenticate',       // Twilio auth failure — won't fix itself
  'invalid credentials',
  'Account suspended',
  'blacklisted',
  'is not a mobile number',
  'not a valid phone',
  'Invalid To Phone Number',        // Twilio: number doesn't exist or is malformed
  "Invalid 'To' Phone Number",      // Twilio: alternate error wording
  'unsubscribed recipient',         // Carrier-level opt-out — retrying violates TCPA
  'has opted out',                  // Twilio opt-out registry
];

function isFatalError(errMsg) {
  return FATAL_ERRORS.some(pat => errMsg && errMsg.includes(pat));
}

// ─── Add a job to the queue ───────────────────────────────────────────────────
/**
 * @param {object} job
 * @param {string} job.phone         - Recipient phone number e.g. '+15551234567'
 * @param {string} job.message       - Message body
 * @param {string} job.leadId        - UUID of the lead
 * @param {string} job.conversationId- UUID of the conversation
 * @param {string} job.userId        - UUID of the user (for multi-tenant)
 * @param {Function} job.sendFn      - Async function (job) => void — your actual Twilio call
 * @param {Function} [job.onSuccess] - Optional callback after successful send
 * @param {Function} [job.onFailure] - Optional callback after all retries exhausted
 */
function add(job) {
  queue.push({
    ...job,
    attempts: 0,
    nextRunAt: Date.now(),
    addedAt: Date.now(),
  });
  stats.inQueue = queue.length;
  console.log(`[smsQueue] Enqueued job for lead ${job.leadId} | queue depth: ${queue.length}`);
}

// ─── Drain loop ───────────────────────────────────────────────────────────────
async function drain() {
  const now = Date.now();
  // Pull up to RATE_PER_SECOND jobs that are ready to run
  const ready = [];
  const remaining = [];

  for (const job of queue) {
    if (job.nextRunAt <= now && ready.length < RATE_PER_SECOND) {
      ready.push(job);
    } else {
      remaining.push(job);
    }
  }

  // Replace queue with what's left
  queue.length = 0;
  queue.push(...remaining);
  stats.inQueue = queue.length;

  if (ready.length === 0) return;

  console.log(`[smsQueue] Draining ${ready.length} jobs | ${queue.length} remaining`);

  // Fire all ready jobs concurrently (they're already rate-limited by the batch size)
  await Promise.allSettled(ready.map(async (job) => {
    job.attempts++;
    try {
      await job.sendFn(job);
      stats.sent++;
      console.log(`[smsQueue] ✓ Sent to ${job.phone} (lead: ${job.leadId})`);
      if (job.onSuccess) await job.onSuccess(job).catch(() => {});
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error(`[smsQueue] ✗ Failed for ${job.phone}: ${errMsg} (attempt ${job.attempts}/${MAX_RETRIES})`);

      if (isFatalError(errMsg)) {
        // Don't retry auth/credential errors — they won't self-heal
        stats.failed++;
        console.error(`[smsQueue] ✗ Fatal error for ${job.phone} — not retrying`);
        if (job.onFailure) await job.onFailure(job, err).catch(() => {});
        return;
      }

      if (job.attempts < MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s
        const backoff = BACKOFF_BASE_MS * Math.pow(2, job.attempts - 1);
        job.nextRunAt = Date.now() + backoff;
        queue.push(job);
        stats.retried++;
        console.log(`[smsQueue] ↻ Retry ${job.attempts}/${MAX_RETRIES} for ${job.phone} in ${backoff}ms`);
      } else {
        stats.failed++;
        console.error(`[smsQueue] ✗ Gave up on ${job.phone} after ${MAX_RETRIES} attempts`);
        if (job.onFailure) await job.onFailure(job, err).catch(() => {});
      }
    }
  }));
}

// ─── Start the drain loop (call once at app startup) ─────────────────────────
function start() {
  if (isRunning) return;
  isRunning = true;
  setInterval(drain, DRAIN_INTERVAL_MS);
  // Log queue depth every 30s when non-empty so Railway logs show blast progress
  setInterval(() => {
    if (queue.length > 0) {
      console.log(`[smsQueue] Queue depth: ${queue.length} | Stats: ${JSON.stringify(stats)}`);
    }
  }, 30000);
  console.log(`[smsQueue] Started — draining at ${RATE_PER_SECOND} SMS/sec`);
}

// ─── Status (for admin/health endpoints) ─────────────────────────────────────
function getStats() {
  return { ...stats, inQueue: queue.length, isRunning };
}

module.exports = { smsQueue: { add, start, getStats } };
