/**
 * credits.js — SMS credit balance and transaction ledger
 *
 * All monetary values are stored in USD with 4 decimal places.
 * SMS rate: $0.0075 per outbound message
 * AI rate:  actual Claude API cost × 3 markup
 */

const supabase = require('../db')

const SMS_CREDIT_COST = 0.0075
const AI_MARKUP = 3

// Claude pricing (USD per token)
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004 },
  'claude-sonnet-4-6':         { input: 0.000003,  output: 0.000015 },
}

class InsufficientCreditsError extends Error {
  constructor(balance, required) {
    super(`Insufficient credits: balance $${balance.toFixed(4)}, required $${required.toFixed(4)}`)
    this.name = 'InsufficientCreditsError'
    this.balance = balance
    this.required = required
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────────

async function getRow(userId) {
  const { data } = await supabase
    .from('user_credits')
    .select('balance, lifetime_purchased, lifetime_used')
    .eq('user_id', userId)
    .single()
  return data
}

async function upsertBalance(userId, newBalance, lifetimePurchased, lifetimeUsed) {
  await supabase
    .from('user_credits')
    .upsert(
      { user_id: userId, balance: newBalance, lifetime_purchased: lifetimePurchased, lifetime_used: lifetimeUsed, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
}

async function insertTransaction(userId, amount, type, description, balanceAfter) {
  await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount,
    type,
    description: description || null,
    balance_after: balanceAfter
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns current credit balance. Returns 0 if no row exists yet.
 */
async function getBalance(userId) {
  const row = await getRow(userId)
  return row ? parseFloat(row.balance) : 0
}

/**
 * Deduct $0.0075 per SMS segment for one outbound message.
 * `segments` is Twilio's numSegments (160 chars GSM-7, 70 chars UCS-2).
 * Default of 1 keeps old callers working, but under-bills multi-segment
 * messages — always pass result.segments from the sendSMS return value.
 * Throws InsufficientCreditsError if balance would go negative.
 * Returns new balance.
 */
async function deductSmsCredit(userId, fromNumber, toPhone, messageId, segments = 1) {
  const cost = parseFloat((SMS_CREDIT_COST * segments).toFixed(4))
  const desc = `SMS outbound${toPhone ? ' to ' + toPhone : ''}${fromNumber ? ' via ' + fromNumber : ''}${segments > 1 ? ` (${segments} segments)` : ''}${messageId ? ' (' + messageId + ')' : ''}`
  const { data, error } = await supabase.rpc('deduct_credit', {
    p_user_id: userId,
    p_amount: cost,
    p_type: 'sms_outbound',
    p_description: desc
  })
  if (error) throw error
  const row = data?.[0]
  if (!row?.success) throw new InsufficientCreditsError(row?.balance_after ?? 0, cost)
  return row.balance_after
}

/**
 * Deduct AI cost (actual API cost × AI_MARKUP).
 * Pass inputTokens, outputTokens, and model name.
 * Returns new balance, or null if userId is falsy (non-fatal).
 */
async function deductAiCredit(userId, inputTokens, outputTokens, model) {
  if (!userId) return null
  const pricing = PRICING[model] || PRICING['claude-sonnet-4-6']
  const rawCost = (inputTokens * pricing.input) + (outputTokens * pricing.output)
  const cost = parseFloat((rawCost * AI_MARKUP).toFixed(4))
  if (cost <= 0) return null
  const desc = `AI reply — ${model} (${inputTokens}in / ${outputTokens}out tokens)`
  const { data, error } = await supabase.rpc('deduct_credit', {
    p_user_id: userId,
    p_amount: cost,
    p_type: 'ai_reply',
    p_description: desc
  })
  if (error) {
    console.error('[credits] deductAiCredit error:', error.message)
    return null
  }
  return data?.[0]?.balance_after ?? null
}

/**
 * Add credits to a user's balance (admin top-up or purchase).
 * Returns new balance.
 */
async function addCredits(userId, amount, description) {
  if (!amount || amount <= 0) throw new Error('Amount must be positive')

  const row = await getRow(userId)
  const currentBalance     = row ? parseFloat(row.balance) : 0
  const lifetimeUsed       = row ? parseFloat(row.lifetime_used) : 0
  const lifetimePurchased  = parseFloat(((row ? parseFloat(row.lifetime_purchased) : 0) + amount).toFixed(4))
  const newBalance         = parseFloat((currentBalance + amount).toFixed(4))

  await upsertBalance(userId, newBalance, lifetimePurchased, lifetimeUsed)
  await insertTransaction(userId, amount, 'purchase', description || 'Credit top-up', newBalance)

  return newBalance
}

/**
 * Calculate USD cost from Anthropic API usage object.
 * usage = { input_tokens, output_tokens }
 */
function calcAiCost(usage, model) {
  const pricing = PRICING[model] || PRICING['claude-sonnet-4-6']
  return (usage.input_tokens * pricing.input) + (usage.output_tokens * pricing.output)
}

module.exports = { getBalance, deductSmsCredit, deductAiCredit, addCredits, calcAiCost, InsufficientCreditsError, SMS_CREDIT_COST }
