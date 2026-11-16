const path = require('node:path');

const BLOCKED = [
  /^\/backend(?:\/|$)/i,
  /\.(?:db|db-shm|db-wal)$/i
];

function normalizeStaticPath(requestPath) {
  try {
    return path.posix.normalize(
      decodeURIComponent(requestPath).replace(/\\/g, '/')
    ).toLowerCase();
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function getStaticPathStatus(requestPath) {
  const normalizedPath = normalizeStaticPath(requestPath);
  if (normalizedPath === null) return 'malformed';
  return BLOCKED.some(function (pattern) {
    return pattern.test(normalizedPath);
  }) ? 'blocked' : 'allowed';
}

module.exports = { getStaticPathStatus, normalizeStaticPath };
