/**
 * credits.js — Credit balances and transaction ledger (per-type)
 *
 * All monetary values are stored in USD with 4 decimal places.
 * SMS rate: $0.0075 per segment (160 chars GSM-7, 70 chars UCS-2)
 * AI rate:  actual Claude API cost × AI_MARKUP
 * DNC rate: $0.05 per lookup (placeholder — adjust when DNC vendor is wired)
 *
 * Three independent balance buckets on user_credits:
 *   sms_balance / ai_balance / dnc_balance
 *
 * All writes go through Postgres RPCs (deduct_credit, refund_credit) to keep
 * per-type and aggregate columns in sync. NEVER do direct UPDATEs on
 * user_credits from Node — that's how drift happens.
 */

const supabase = require('../db')

const SMS_CREDIT_COST = 0.0075
const DNC_CREDIT_COST = 0.05   // placeholder; confirm with vendor
const AI_MARKUP = 3

const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004 },
  'claude-sonnet-4-6':         { input: 0.000003,  output: 0.000015 },
}

const CREDIT_TYPES = ['sms', 'ai', 'dnc']

class InsufficientCreditsError extends Error {
  constructor(creditType, balance, required) {
    super(`Insufficient ${creditType} credits: balance $${balance.toFixed(4)}, required $${required.toFixed(4)}`)
    this.name = 'InsufficientCreditsError'
    this.creditType = creditType
    this.balance = balance
    this.required = required
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

async function getBalances(userId) {
  const { data } = await supabase
    .from('user_credits')
    .select('sms_balance, ai_balance, dnc_balance, lifetime_sms_used, lifetime_ai_used, lifetime_dnc_used, lifetime_purchased, lifetime_used, updated_at')
    .eq('user_id', userId)
    .single()

  if (!data) {
    return {
      sms: 0, ai: 0, dnc: 0,
      lifetime_sms_used: 0, lifetime_ai_used: 0, lifetime_dnc_used: 0,
      lifetime_purchased: 0, lifetime_used: 0,
      updated_at: null
    }
  }

  return {
    sms: parseFloat(data.sms_balance),
    ai:  parseFloat(data.ai_balance),
    dnc: parseFloat(data.dnc_balance),
    lifetime_sms_used: parseFloat(data.lifetime_sms_used),
    lifetime_ai_used:  parseFloat(data.lifetime_ai_used),
    lifetime_dnc_used: parseFloat(data.lifetime_dnc_used),
    lifetime_purchased: parseFloat(data.lifetime_purchased),
    lifetime_used:      parseFloat(data.lifetime_used),
    updated_at: data.updated_at
  }
}

// ─── Deductions ──────────────────────────────────────────────────────────────

async function deductSmsCredit(userId, fromNumber, toPhone, messageId, segments = 1) {
  const cost = parseFloat((SMS_CREDIT_COST * segments).toFixed(4))
  const desc = `SMS outbound${toPhone ? ' to ' + toPhone : ''}${fromNumber ? ' via ' + fromNumber : ''}${segments > 1 ? ` (${segments} segments)` : ''}${messageId ? ' (' + messageId + ')' : ''}`
  const { data, error } = await supabase.rpc('deduct_credit', {
    p_user_id: userId,
    p_amount: cost,
    p_credit_type: 'sms',
    p_type: 'sms_outbound',
    p_description: desc
  })
  if (error) throw error
  const row = data?.[0]
  if (!row?.success) throw new InsufficientCreditsError('sms', parseFloat(row?.balance_after ?? 0), cost)
  return parseFloat(row.balance_after)
}

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
    p_credit_type: 'ai',
    p_type: 'ai_reply',
    p_description: desc
  })
  if (error) {
    console.error('[credits] deductAiCredit error:', error.message)
    return null
  }
  const row = data?.[0]
  if (!row?.success) {
    console.warn(`[credits] deductAiCredit insufficient for user ${userId}: balance $${row?.balance_after}`)
    return null
  }
  return parseFloat(row.balance_after)
}

async function deductDncCredit(userId, phone, cost = DNC_CREDIT_COST) {
  if (!userId) return null
  const amt = parseFloat(cost.toFixed(4))
  const desc = `DNC lookup${phone ? ' for ' + phone : ''}`
  const { data, error } = await supabase.rpc('deduct_credit', {
    p_user_id: userId,
    p_amount: amt,
    p_credit_type: 'dnc',
    p_type: 'dnc_check',
    p_description: desc
  })
  if (error) throw error
  const row = data?.[0]
  if (!row?.success) throw new InsufficientCreditsError('dnc', parseFloat(row?.balance_after ?? 0), amt)
  return parseFloat(row.balance_after)
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

async function refundSmsCredit(userId, amount, description) {
  return _refund(userId, amount, 'sms', description || 'SMS send failed — refund')
}

async function refundAiCredit(userId, amount, description) {
  return _refund(userId, amount, 'ai', description || 'AI reply failed — refund')
}

async function refundDncCredit(userId, amount, description) {
  return _refund(userId, amount, 'dnc', description || 'DNC lookup failed — refund')
}

async function _refund(userId, amount, creditType, description) {
  if (!userId || !amount || amount <= 0) return null
  const { data, error } = await supabase.rpc('refund_credit', {
    p_user_id: userId,
    p_amount: parseFloat(amount.toFixed(4)),
    p_credit_type: creditType,
    p_description: description
  })
  if (error) {
    console.error(`[credits] refund (${creditType}) error:`, error.message)
    return null
  }
  return parseFloat(data?.[0]?.balance_after ?? 0)
}

// ─── Top-ups (admin) ─────────────────────────────────────────────────────────

/**
 * Admin top-up. creditType must be 'sms', 'ai', or 'dnc'.
 * Routes through refund_credit with transaction_type='purchase' to keep the
 * per-type lifetime columns in sync and produce a proper audit row.
 */
async function addCredits(userId, amount, creditType, description) {
  if (!amount || amount <= 0) throw new Error('Amount must be positive')
  if (!CREDIT_TYPES.includes(creditType)) {
    throw new Error(`Invalid credit_type: ${creditType}`)
  }

  const { data, error } = await supabase.rpc('refund_credit', {
    p_user_id: userId,
    p_amount: parseFloat(amount.toFixed(4)),
    p_credit_type: creditType,
    p_description: description || 'Credit top-up',
    p_type: 'purchase'
  })
  if (error) throw error

  // Bump lifetime_purchased separately (refund_credit doesn't touch it)
  const currentLifetime = await _getLifetimePurchased(userId)
  await supabase
    .from('user_credits')
    .update({
      lifetime_purchased: parseFloat((currentLifetime + amount).toFixed(4))
    })
    .eq('user_id', userId)

  return parseFloat(data?.[0]?.balance_after ?? 0)
}

async function _getLifetimePurchased(userId) {
  const { data } = await supabase
    .from('user_credits')
    .select('lifetime_purchased')
    .eq('user_id', userId)
    .single()
  return data ? parseFloat(data.lifetime_purchased) : 0
}

// ─── AI cost helper ──────────────────────────────────────────────────────────

function calcAiCost(usage, model) {
  const pricing = PRICING[model] || PRICING['claude-sonnet-4-6']
  return (usage.input_tokens * pricing.input) + (usage.output_tokens * pricing.output)
}

// ─── Low-balance warning ─────────────────────────────────────────────────────

async function checkLowBalanceWarning(userId, creditType) {
  if (!userId || !CREDIT_TYPES.includes(creditType)) return false
  const { data, error } = await supabase.rpc('check_low_balance_warning', {
    p_user_id: userId,
    p_credit_type: creditType
  })
  if (error) {
    console.error('[credits] checkLowBalanceWarning error:', error.message)
    return false
  }
  return data === true
}

module.exports = {
  getBalances,
  deductSmsCredit,
  deductAiCredit,
  deductDncCredit,
  addCredits,
  refundSmsCredit,
  refundAiCredit,
  refundDncCredit,
  checkLowBalanceWarning,
  calcAiCost,
  InsufficientCreditsError,
  SMS_CREDIT_COST,
  DNC_CREDIT_COST,
}
