#!/usr/bin/env node
/**
 * `checkin` — read today's Doubao check-in panel and print what the server said.
 *
 *   node lib/cli-checkin.js
 *   node lib/cli-checkin.js --json
 *   node lib/cli-checkin.js --claim   # opt-in: actually claims today's grant
 *
 * Read-only by default. This exists because "check-in doesn't work" has several
 * indistinguishable shapes from inside the card -- dead session, retired
 * campaign group, renamed task field -- and only the panel's own answer tells
 * them apart. No credential is ever printed: the output is an outcome, a code,
 * a message and the non-secret task labels.
 */
import { claimDoubaoCheckin, readDoubaoCheckin, type DoubaoCheckinView } from './doubao-checkin.ts'

function summary(view: DoubaoCheckinView): Record<string, unknown> {
  return {
    ok: view.ok,
    outcome: view.outcome,
    day: view.day,
    checkedInToday: view.checkedInToday,
    continuousDays: view.continuousDays,
    rewardAmount: view.rewardAmount,
    rewardType: view.rewardType,
    totalAmount: view.totalAmount,
    error: view.error,
  }
}

function line(view: DoubaoCheckinView): string {
  const parts = [
    `outcome=${view.outcome}`,
    `ok=${String(view.ok)}`,
    `day=${view.day}`,
  ]
  if (view.checkedInToday !== null) parts.push(`checkedInToday=${String(view.checkedInToday)}`)
  if (view.continuousDays !== null) parts.push(`streak=${String(view.continuousDays)}`)
  if (view.rewardAmount !== null) parts.push(`reward=${String(view.rewardAmount)}`)
  if (view.totalAmount !== null) parts.push(`total=${String(view.totalAmount)}`)
  if (view.error !== null) parts.push(`error=${view.error}`)
  return parts.join('  ')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const doClaim = argv.includes('--claim')

  const read = await readDoubaoCheckin({ force: true })
  const claimed = doClaim ? await claimDoubaoCheckin() : undefined

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ read: summary(read), claim: claimed === undefined ? null : summary(claimed) }, null, 2)}\n`)
    return
  }

  process.stdout.write(`豆包签到面板：${line(read)}\n`)
  if (claimed !== undefined) process.stdout.write(`领取结果：${line(claimed)}\n`)
  if (!doClaim) process.stdout.write('（只读。要真正领取，加 --claim。）\n')
}

void main()
