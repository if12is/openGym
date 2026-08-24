import { describe, it, expect } from 'vitest'
import { isNewer, parseContentRange, resumeOffset, classifyUpdate } from './app-update.js'

describe('isNewer', () => {
  it('detects a higher remote versionCode', () => {
    expect(isNewer({ versionCode: 10 }, { versionCode: 9 })).toBe(true)
    expect(isNewer({ versionCode: 9 }, { versionCode: 9 })).toBe(false)
    expect(isNewer({ versionCode: 8 }, { versionCode: 9 })).toBe(false)
  })
})

describe('parseContentRange', () => {
  it('reads a 206 Content-Range header', () => {
    expect(parseContentRange('bytes 100-199/8000')).toEqual({ start: 100, end: 199, total: 8000 })
  })
  it('returns null for missing or junk headers', () => {
    expect(parseContentRange(null)).toBe(null)
    expect(parseContentRange('')).toBe(null)
  })
})

describe('resumeOffset', () => {
  const remote = { versionCode: 12, apkUrl: 'https://example/a.apk' }
  it('resumes when version and url match', () => {
    expect(resumeOffset({ versionCode: 12, url: remote.apkUrl, loaded: 4000, total: 8000 }, remote)).toBe(4000)
  })
  it('starts over when the version changed', () => {
    expect(resumeOffset({ versionCode: 11, url: remote.apkUrl, loaded: 4000 }, remote)).toBe(0)
  })
  it('starts over when the apk url changed', () => {
    expect(resumeOffset({ versionCode: 12, url: 'https://example/old.apk', loaded: 4000 }, remote)).toBe(0)
  })
})

describe('classifyUpdate', () => {
  const local = { versionCode: 9, versionName: '1.4.0' }
  const remote = { versionCode: 12, versionName: '1.5.0', apkUrl: 'https://example/a.apk' }

  it('is ready when a complete apk is waiting', () => {
    expect(classifyUpdate({ local, remote, pending: { versionCode: 12 }, partial: null })).toBe('ready')
  })
  it('resumes a matching partial download', () => {
    expect(classifyUpdate({
      local, remote, pending: null,
      partial: { versionCode: 12, url: remote.apkUrl, loaded: 100, total: 800 },
    })).toBe('resume')
  })
  it('flags a newer remote as available', () => {
    expect(classifyUpdate({ local, remote, pending: null, partial: null })).toBe('available')
  })
  it('treats a stale pending apk as available once remote is newer', () => {
    expect(classifyUpdate({ local, remote, pending: { versionCode: 10 }, partial: null })).toBe('available')
  })
  it('is latest when versionCodes match', () => {
    expect(classifyUpdate({ local, remote: { versionCode: 9 }, pending: null, partial: null })).toBe('latest')
  })
})
