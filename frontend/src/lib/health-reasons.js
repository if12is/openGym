// Named reasons the native Health plugin can return. Kept out of health-store
// so tests do not have to boot localStorage / Capacitor.

export function mapAvailabilityReason(reason, fallback = 'unavailable') {
  if (reason === 'update-required') return 'update'
  if (reason === 'not-installed') return 'unavailable'
  const known = [
    'timeout', 'unavailable', 'update', 'no-plugin', 'no-hms',
    'no-health-app', 'not-configured', 'auth-cancel', 'denied', 'no-picker',
    'no-bind', 'need-permission',
  ]
  if (known.includes(reason)) return reason
  return fallback
}
