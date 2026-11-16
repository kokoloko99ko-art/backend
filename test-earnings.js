const assert = require('node:assert/strict');
const test = require('node:test');
const { getEarningStartAt, getNextEarningDate } = require('./earnings');

const purchasedAt = new Date('2026-01-01T10:00:00.000Z');

test('earnings start at payment approval', () => {
  const startsAt = getEarningStartAt(purchasedAt);
  assert.equal(startsAt.toISOString(), purchasedAt.toISOString());
  assert.equal(getNextEarningDate(purchasedAt, null, new Date('2026-01-01T09:59:59.999Z')), null);
  assert.equal(getNextEarningDate(purchasedAt, null, startsAt), '2026-01-01');
});

test('continues daily credits after the most recent credited day', () => {
  assert.equal(
    getNextEarningDate(purchasedAt, '2026-01-10', new Date('2026-01-16T10:00:00.000Z')),
    '2026-01-11'
  );
  assert.equal(
    getNextEarningDate(purchasedAt, '2026-01-15', new Date('2026-01-16T10:00:00.000Z')),
    '2026-01-16'
  );
});
