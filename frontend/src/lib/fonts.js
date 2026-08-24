// Popular OFL/Apache Arabic UI typefaces, self-hosted so the picker works offline.

export const FONTS = {
  cairo: {
    id: 'cairo',
    family: 'Cairo',
    label: 'Cairo — القاهرة',
    subtitle: 'Modern Egyptian sans — the default',
    load: () => Promise.all([
      import('@fontsource/cairo/arabic-400.css'),
      import('@fontsource/cairo/arabic-700.css'),
      import('@fontsource/cairo/latin-400.css'),
      import('@fontsource/cairo/latin-700.css'),
    ]),
  },
  tajawal: {
    id: 'tajawal',
    family: 'Tajawal',
    label: 'Tajawal — تجوال',
    subtitle: 'Clean Arabic UI sans',
    load: () => Promise.all([
      import('@fontsource/tajawal/arabic-400.css'),
      import('@fontsource/tajawal/arabic-700.css'),
      import('@fontsource/tajawal/latin-400.css'),
      import('@fontsource/tajawal/latin-700.css'),
    ]),
  },
  almarai: {
    id: 'almarai',
    family: 'Almarai',
    label: 'Almarai — المرعي',
    subtitle: 'Highly readable, newspaper-clear',
    load: () => Promise.all([
      import('@fontsource/almarai/arabic-400.css'),
      import('@fontsource/almarai/arabic-700.css'),
      import('@fontsource/almarai/latin-400.css'),
      import('@fontsource/almarai/latin-700.css'),
    ]),
  },
  ibmPlex: {
    id: 'ibmPlex',
    family: 'IBM Plex Sans Arabic',
    label: 'IBM Plex Sans Arabic',
    subtitle: 'Technical, even metrics',
    load: () => Promise.all([
      import('@fontsource/ibm-plex-sans-arabic/arabic-400.css'),
      import('@fontsource/ibm-plex-sans-arabic/arabic-700.css'),
      import('@fontsource/ibm-plex-sans-arabic/latin-400.css'),
      import('@fontsource/ibm-plex-sans-arabic/latin-700.css'),
    ]),
  },
  notoKufi: {
    id: 'notoKufi',
    family: 'Noto Kufi Arabic',
    label: 'Noto Kufi Arabic — كوفي',
    subtitle: 'Geometric Kufi, strong titles',
    load: () => Promise.all([
      import('@fontsource/noto-kufi-arabic/arabic-400.css'),
      import('@fontsource/noto-kufi-arabic/arabic-700.css'),
    ]),
  },
  notoNaskh: {
    id: 'notoNaskh',
    family: 'Noto Naskh Arabic',
    label: 'Noto Naskh Arabic — نسخ',
    subtitle: 'Classic Naskh, book-like',
    load: () => Promise.all([
      import('@fontsource/noto-naskh-arabic/arabic-400.css'),
      import('@fontsource/noto-naskh-arabic/arabic-700.css'),
      import('@fontsource/noto-naskh-arabic/latin-400.css'),
      import('@fontsource/noto-naskh-arabic/latin-700.css'),
    ]),
  },
  changa: {
    id: 'changa',
    family: 'Changa',
    label: 'Changa — تشانجا',
    subtitle: 'Soft, slightly rounded',
    load: () => Promise.all([
      import('@fontsource/changa/arabic-400.css'),
      import('@fontsource/changa/arabic-700.css'),
      import('@fontsource/changa/latin-400.css'),
      import('@fontsource/changa/latin-700.css'),
    ]),
  },
  elMessiri: {
    id: 'elMessiri',
    family: 'El Messiri',
    label: 'El Messiri — المسيري',
    subtitle: 'Kufi-inspired, distinctive',
    load: () => Promise.all([
      import('@fontsource/el-messiri/arabic-400.css'),
      import('@fontsource/el-messiri/arabic-700.css'),
      import('@fontsource/el-messiri/latin-400.css'),
      import('@fontsource/el-messiri/latin-700.css'),
    ]),
  },
  amiri: {
    id: 'amiri',
    family: 'Amiri',
    label: 'Amiri — أميري',
    subtitle: 'Traditional Naskh, literary',
    load: () => Promise.all([
      import('@fontsource/amiri/arabic-400.css'),
      import('@fontsource/amiri/arabic-700.css'),
      import('@fontsource/amiri/latin-400.css'),
      import('@fontsource/amiri/latin-700.css'),
    ]),
  },
}

export const FONT_IDS = Object.keys(FONTS)
export const DEFAULT_FONT = 'cairo'

export function fontOf(id) {
  return FONTS[id] || FONTS[DEFAULT_FONT]
}

export function fontFamilyCss(id) {
  const f = fontOf(id)
  return `'${f.family}', 'Segoe UI', Tahoma, sans-serif`
}

const loaded = new Set(['cairo'])

export async function ensureFont(id) {
  const f = fontOf(id)
  if (loaded.has(f.id)) return f
  await f.load()
  loaded.add(f.id)
  return f
}

export function applyFont(id) {
  const f = fontOf(id)
  document.documentElement.dataset.font = f.id
  document.documentElement.style.setProperty('--font', fontFamilyCss(f.id))
  ensureFont(f.id)
  return f
}
