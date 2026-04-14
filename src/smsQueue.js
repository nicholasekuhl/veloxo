/**
 * smsQueue.js — Multi-lane SMS Queue
 *
 * Architecture: One independent queue lane per phone number.
 * Messages are distributed round-robin across a user's registered
 * sending numbers, so throughput scales linearly with number count.
 *
 * Throughput:
 *   1 number  = 3 msg/sec  (~11 min for 2,000 msg blast)
 *   5 numbers = 15 msg/sec (~2.5 min for 2,000 msg blast)
 *  10 numbers = 30 msg/sec (~1.1 min for 2,000 msg blast)
 *
 * Each lane runs independently — one user's blast never blocks another's.
 *
 * USAGE:
 *   const { smsQueue } = require('./smsQueue');
 *
 *   // Single message (existing behavior, auto-assigns number)
 *   smsQueue.add({
 *     userId,
 *     phone,
 *     message,
 *     leadId,
 *     conversationId,
 *     fromNumber,   // specific number, OR omit to auto round-robin
 *     sendFn,       // async (job) => void — your actual Telnyx/Twilio call
 *     onSuccess,    // optional async (job) => void
 *     onFailure,    // optional async (job, err) => void
 *   });
 *
 *   // Bulk campaign enqueue (recommended for blasts)
 *   smsQueue.addBulk(jobs, userId, availableNumbers);
 *
 *   // Get stats for health endpoint / UI
 *   smsQueue.getStats();
 *
 *   // Get per-lane stats for a user
 *   smsQueue.getUserStats(userId);
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const RATE_PER_SECOND_PER_LANE = 3;  // msgs/sec per phone number lane
const DRAIN_INTERVAL_MS        = 1000;
const MAX_RETRIES               = 3;
const BACKOFF_BASE_MS           = 2000; // 2s → 4s → 8s

// ─── Non-retryable errors ─────────────────────────────────────────────────────

const FATAL_PATTERNS = [
  'Authenticate',
  'invalid credentials',
  'Account suspended',
  'blacklisted',
  'is not a mobile number',
  'not a valid phone',
  'unsubscribed',
  'STOP',
];

function isFatal(errMsg = '') {
  return FATAL_PATTERNS.some(p => errMsg.toLowerCase().includes(p.toLowerCase()));
}

// ─── Lane registry ────────────────────────────────────────────────────────────
// Map of phoneNumber → { queue: [], intervalId, stats }

const lanes = new Map();

// Global stats
const globalStats = {
  sent: 0,
  failed: 0,
  retried: 0,
};

// ─── Round-robin state per user ───────────────────────────────────────────────
// Map of userId → current index into their numbers array
const rrIndex = new Map();

// ─── Lane management ──────────────────────────────────────────────────────────

function getLane(phoneNumber) {
  if (!lanes.has(phoneNumber)) {
    const lane = {
      queue: [],
      stats: { sent: 0, failed: 0, retried: 0, inQueue: 0 },
      intervalId: null,
    };
    lane.intervalId = setInterval(() => drainLane(phoneNumber, lane), DRAIN_INTERVAL_MS);
    lanes.set(phoneNumber, lane);
    console.log(`[smsQueue] Created lane for ${phoneNumber}`);
  }
  return lanes.get(phoneNumber);
}

function destroyLane(phoneNumber) {
  const lane = lanes.get(phoneNumber);
  if (lane) {
    clearInterval(lane.intervalId);
    lanes.delete(phoneNumber);
    console.log(`[smsQueue] Destroyed lane for ${phoneNumber}`);
  }
}

// ─── Drain a single lane ──────────────────────────────────────────────────────

async function drainLane(phoneNumber, lane) {
  const now = Date.now();
  const ready = [];
  const deferred = [];

  for (const job of lane.queue) {
    if (job.nextRunAt <= now && ready.length < RATE_PER_SECOND_PER_LANE) {
      ready.push(job);
    } else {
      deferred.push(job);
    }
  }

  lane.queue = deferred;
  lane.stats.inQueue = lane.queue.length;

  if (ready.length === 0) return;

  console.log(`[smsQueue] Lane ${phoneNumber}: draining ${ready.length} | ${lane.queue.length} remaining`);

  await Promise.allSettled(ready.map(job => processJob(job, lane)));
}

// ─── Process a single job ─────────────────────────────────────────────────────

async function processJob(job, lane) {
  try {
    await job.sendFn(job);

    lane.stats.sent++;
    globalStats.sent++;

    console.log(`[smsQueue] ✓ Sent to ${job.phone} via ${job.fromNumber} (lead: ${job.leadId})`);

    if (job.onSuccess) {
      try { await job.onSuccess(job); } catch (e) {
        console.error(`[smsQueue] onSuccess callback error:`, e.message);
      }
    }

  } catch (err) {
    const errMsg = err.message || '';
    job.attempts++;

    console.error(`[smsQueue] ✗ Failed attempt ${job.attempts}/${MAX_RETRIES} for ${job.phone}: ${errMsg}`);

    if (isFatal(errMsg) || job.attempts >= MAX_RETRIES) {
      // Give up
      lane.stats.failed++;
      globalStats.failed++;
      console.error(`[smsQueue] ✗✗ Permanently failed job for lead ${job.leadId}`);

      if (job.onFailure) {
        try { await job.onFailure(job, err); } catch (e) {
          console.error(`[smsQueue] onFailure callback error:`, e.message);
        }
      }
    } else {
      // Retry with backoff
      const backoff = BACKOFF_BASE_MS * Math.pow(2, job.attempts - 1);
      job.nextRunAt = Date.now() + backoff;
      lane.queue.push(job);
      lane.stats.inQueue = lane.queue.length;
      lane.stats.retried++;
      globalStats.retried++;
      console.log(`[smsQueue] ↻ Retrying lead ${job.leadId} in ${backoff}ms`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a single message to the queue.
 * If fromNumber is provided, uses that lane directly.
 * If not, falls back to a default single-lane behavior.
 */
function add(job) {
  if (!job.fromNumber) {
    throw new Error('[smsQueue] job.fromNumber is required. Pass a specific number or use addBulk.');
  }

  const lane = getLane(job.fromNumber);
  lane.queue.push({
    ...job,
    attempts: 0,
    nextRunAt: Date.now(),
    addedAt: Date.now(),
  });
  lane.stats.inQueue = lane.queue.length;

  console.log(`[smsQueue] Enqueued → ${job.fromNumber} | lane depth: ${lane.queue.length}`);
}

/**
 * Add a bulk campaign blast, distributing round-robin across user's numbers.
 *
 * @param {Array}  jobs             - Array of job objects (phone, message, leadId, etc.)
 * @param {string} userId           - User ID for round-robin tracking
 * @param {Array}  availableNumbers - Array of phone number strings the user owns
 * @param {Function} sendFn         - Shared sendFn for all jobs
 * @param {Function} [onSuccess]    - Shared onSuccess for all jobs
 * @param {Function} [onFailure]    - Shared onFailure for all jobs
 */
function addBulk(jobs, userId, availableNumbers, sendFn, onSuccess, onFailure) {
  if (!availableNumbers || availableNumbers.length === 0) {
    throw new Error('[smsQueue] No available numbers for user ' + userId);
  }

  // Initialize round-robin index for this user if needed
  if (!rrIndex.has(userId)) rrIndex.set(userId, 0);

  let idx = rrIndex.get(userId);

  for (const job of jobs) {
    const fromNumber = availableNumbers[idx % availableNumbers.length];
    idx++;

    const lane = getLane(fromNumber);
    lane.queue.push({
      ...job,
      userId,
      fromNumber,
      sendFn,
      onSuccess,
      onFailure,
      attempts: 0,
      nextRunAt: Date.now(),
      addedAt: Date.now(),
    });
    lane.stats.inQueue = lane.queue.length;
  }

  rrIndex.set(userId, idx);

  const totalQueued = jobs.length;
  const numbersUsed = Math.min(availableNumbers.length, totalQueued);
  console.log(`[smsQueue] Bulk enqueued ${totalQueued} jobs for user ${userId} across ${numbersUsed} numbers`);

  // Log estimated completion time
  const msgsPerSec = availableNumbers.length * RATE_PER_SECOND_PER_LANE;
  const estSeconds = Math.ceil(totalQueued / msgsPerSec);
  console.log(`[smsQueue] Estimated completion: ~${estSeconds}s at ${msgsPerSec} msgs/sec`);
}

/**
 * Get global stats + per-lane breakdown.
 */
function getStats() {
  const laneStats = {};
  let totalInQueue = 0;

  for (const [number, lane] of lanes.entries()) {
    laneStats[number] = { ...lane.stats };
    totalInQueue += lane.stats.inQueue;
  }

  return {
    ...globalStats,
    inQueue: totalInQueue,
    activeLanes: lanes.size,
    lanes: laneStats,
  };
}

/**
 * Get queue stats for a specific user's numbers.
 * Pass in the user's array of phone numbers.
 */
function getUserStats(userNumbers = []) {
  let inQueue = 0;
  let sent = 0;
  let failed = 0;

  for (const number of userNumbers) {
    const lane = lanes.get(number);
    if (lane) {
      inQueue += lane.stats.inQueue;
      sent    += lane.stats.sent;
      failed  += lane.stats.failed;
    }
  }

  const msgsPerSec = userNumbers.length * RATE_PER_SECOND_PER_LANE;
  const estSecondsRemaining = msgsPerSec > 0 ? Math.ceil(inQueue / msgsPerSec) : 0;

  return { inQueue, sent, failed, msgsPerSec, estSecondsRemaining };
}

/**
 * Graceful shutdown — wait for all lanes to drain (max 30s).
 */
async function shutdown(maxWaitMs = 30000) {
  console.log('[smsQueue] Shutdown requested — draining all lanes...');
  const start = Date.now();

  return new Promise(resolve => {
    const check = setInterval(() => {
      const stats = getStats();
      const elapsed = Date.now() - start;

      if (stats.inQueue === 0 || elapsed >= maxWaitMs) {
        clearInterval(check);
        for (const number of lanes.keys()) destroyLane(number);
        console.log(`[smsQueue] Shutdown complete. Remaining: ${stats.inQueue}`);
        resolve();
      }
    }, 500);
  });
}

// ─── Queue depth monitor ──────────────────────────────────────────────────────

setInterval(() => {
  const stats = getStats();
  if (stats.inQueue > 0) {
    console.log(`[smsQueue] 📊 Active lanes: ${stats.activeLanes} | In queue: ${stats.inQueue} | Sent: ${stats.sent} | Failed: ${stats.failed}`);
  }
}, 30000);

// ─── Export ───────────────────────────────────────────────────────────────────

const smsQueue = { add, addBulk, getStats, getUserStats, shutdown, destroyLane };

module.exports = { smsQueue };
