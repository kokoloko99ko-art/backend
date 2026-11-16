function getEarningStartAt(purchasedAt) {
  if (!(purchasedAt instanceof Date) || !Number.isFinite(purchasedAt.getTime())) return null;
  return new Date(purchasedAt.getTime());
}

function bakuDate(date) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Baku', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function getNextEarningDate(purchasedAt, lastEarningDate, now) {
  const earningStartAt = getEarningStartAt(purchasedAt);
  if (!earningStartAt || !(now instanceof Date) || !Number.isFinite(now.getTime()) || now < earningStartAt) {
    return null;
  }

  const firstEarningDate = bakuDate(earningStartAt);
  if (!lastEarningDate || lastEarningDate < firstEarningDate) return firstEarningDate;

  const nextDate = new Date(lastEarningDate + 'T00:00:00Z');
  if (!Number.isFinite(nextDate.getTime())) return firstEarningDate;
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return nextDate.toISOString().slice(0, 10);
}

module.exports = { bakuDate, getEarningStartAt, getNextEarningDate };
