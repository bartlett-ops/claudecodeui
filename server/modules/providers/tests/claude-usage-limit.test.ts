import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageLimitTracker } from '@/modules/providers/list/claude/claude-usage-limit.js';

const rejected = (resetsAt?: number, extra: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', ...(resetsAt === undefined ? {} : { resetsAt }), ...extra },
});
const rateLimitError = { type: 'assistant', error: 'rate_limit' };
const erroredResult = { type: 'result', is_error: true };

test('a rejected event alone schedules nothing', () => {
  assert.equal(createUsageLimitTracker().observe(rejected(1_800_000_000)), null);
});

test('rejected then rate_limit assistant error returns the reset in ms', () => {
  const seconds = createUsageLimitTracker();
  seconds.observe(rejected(1_800_000_000));
  assert.deepEqual(seconds.observe(rateLimitError), { resetsAtMs: 1_800_000_000_000 });

  const ms = createUsageLimitTracker();
  ms.observe(rejected(1_800_000_000_000));
  assert.deepEqual(ms.observe(rateLimitError), { resetsAtMs: 1_800_000_000_000 });
});

test('rejected then an errored result confirms', () => {
  const tracker = createUsageLimitTracker();
  tracker.observe(rejected(1_800_000_000));
  assert.deepEqual(tracker.observe(erroredResult), { resetsAtMs: 1_800_000_000_000 });
});

test('overage allowed or in use is ignored', () => {
  const allowed = createUsageLimitTracker();
  allowed.observe(rejected(1_800_000_000, { overageStatus: 'allowed' }));
  assert.equal(allowed.observe(erroredResult), null);

  const using = createUsageLimitTracker();
  using.observe(rejected(1_800_000_000, { isUsingOverage: true }));
  assert.equal(using.observe(erroredResult), null);
});

test('missing resetsAt yields a hit with null', () => {
  const tracker = createUsageLimitTracker();
  tracker.observe(rejected());
  assert.deepEqual(tracker.observe(rateLimitError), { resetsAtMs: null });
});

test('legacy text form yields the embedded timestamp', () => {
  const tracker = createUsageLimitTracker();
  const hit = tracker.observe({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Claude AI usage limit reached|1800000000' }] },
  });
  assert.deepEqual(hit, { resetsAtMs: 1_800_000_000_000 });
});

test('a hit is reported once per tracker', () => {
  const tracker = createUsageLimitTracker();
  tracker.observe(rejected(1_800_000_000));
  assert.notEqual(tracker.observe(rateLimitError), null);
  assert.equal(tracker.observe(rateLimitError), null);
  assert.equal(tracker.observe(erroredResult), null);
});

test('allowed_warning never confirms', () => {
  const tracker = createUsageLimitTracker();
  tracker.observe({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1_800_000_000 } });
  assert.equal(tracker.observe(rateLimitError), null);
  assert.equal(tracker.observe(erroredResult), null);
});
