// Tiny dependency-free i18n. English source strings are the keys; locale files in
// src/locales/ map them to translations and are lazy-loaded (Vite code-splits each
// import.meta.glob entry). Arabic is the default language and ships in the first
// paint so RTL users never flash English.
// Exercise instructions come from separately generated packs in src/instr/ (one per
// language, from the upstream dataset) — also lazy-loaded on language switch.
import { useSyncExternalStore } from 'react'
import ar from '../locales/ar.js'
import { translateExName } from './exName.js'

// UI languages. Arabic is first: it is the product default and the only RTL pack.
export const LANGS = {
  ar: 'العربية',
  en: 'English', de: 'Deutsch', es: 'Español', fr: 'Français', it: 'Italiano',
  pt: 'Português', pl: 'Polski', tr: 'Türkçe', ru: 'Русский', zh: '中文',
  ko: '한국어', hi: 'हिन्दी'
}
export const RTL_LANGS = ['ar']
export const INSTR_LANGS = ['ar', 'en', 'es', 'fr', 'it', 'tr', 'ru', 'zh', 'hi', 'pl', 'ko']
const DATE_LOCALES = {
  ar: 'ar-EG',
  en: 'en-GB', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-PT',
  pl: 'pl-PL', tr: 'tr-TR', ru: 'ru-RU', zh: 'zh-CN', ko: 'ko-KR', hi: 'hi-IN'
}

const localePacks = import.meta.glob('../locales/*.js')
const instrPacks = import.meta.glob('../instr/*.js')

const TEST = import.meta.env.MODE === 'test'
let lang = TEST ? 'en' : 'ar'
let dict = TEST ? {} : ar
let instr = null            // { exId: [steps] } for the current language, null = English
let instrPending = !TEST    // Arabic default: wait for the pack before falling back to English
let version = 0
const subs = new Set()
const notify = () => { version++; subs.forEach(f => f()) }

export const getLang = () => lang
export const isRtl = (l = lang) => RTL_LANGS.includes(l)
export const dateLocale = () => DATE_LOCALES[lang] || 'ar-EG'

// Translate a source string; {0},{1}… are replaced with args (also on the English fallback).
export function t(s, ...args) {
  let v = dict[s] || s
  for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
  return v
}
// Instructions for an exercise in the current language (English steps as fallback).
export const instrFor = ex => {
  if (instr && instr[ex.id]) return instr[ex.id]
  if (instrPending) return []
  return ex.st || []
}

export const instrIsEnglish = ex => {
  const steps = instrFor(ex)
  return steps.length > 0 && !(instr && instr[ex.id])
}

export function exName(ex) {
  const n = (ex && ex.n) || ''
  return lang === 'ar' && n ? translateExName(n) : n
}

export function matchesEx(ex, q) {
  const ql = (q || '').toLowerCase().trim()
  if (!ql) return true
  if ((ex.n || '').toLowerCase().includes(ql)) return true
  if ((ex.tg || '').toLowerCase().includes(ql)) return true
  if ((ex.eq || '').toLowerCase().includes(ql)) return true
  if ((ex.desc || '').toLowerCase().includes(ql)) return true
  if (lang === 'ar') {
    const arName = translateExName(ex.n)
    if (arName.includes(q.trim())) return true
  }
  return false
}

export async function setLang(l) {
  if (!LANGS[l]) l = 'ar'
  if (l === lang && version > 0) return
  lang = l
  const wantInstr = INSTR_LANGS.includes(l) && l !== 'en'
  instrPending = wantInstr
  try {
    if (l === 'ar') dict = ar
    else if (l === 'en') dict = {}
    else dict = (await localePacks['../locales/' + l + '.js']()).default
    instr = !wantInstr ? null : (await instrPacks['../instr/' + l + '.js']()).default
  } catch (e) { dict = l === 'ar' ? ar : {}; instr = null }
  instrPending = false
  notify()
}

// Re-renders the subscribing component (and its children) whenever the language changes.
export function useLang() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, () => version)
}
