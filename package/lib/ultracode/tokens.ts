// Токены: реальный cl100k_base (js-tiktoken, CJS) + fallback-эвристика при сбое загрузки.
// Ponytail: один модуль, sync API. Загрузка ленивая и однократная; отсутствие
// пакета не роняет плагин — включается estimated-режим.
import { createRequire } from "node:module"

export interface CountResult {
  n: number
  estimated: boolean
}

type Encoder = { encode(text: string): ArrayLike<number> }

let enc: Encoder | null = null
let loadFailed = false

function ensure(): void {
  if (enc || loadFailed) return
  try {
    const req = createRequire(import.meta.url)
    const mod = req("js-tiktoken") as { getEncoding(name: string): Encoder }
    enc = mod.getEncoding("cl100k_base")
  } catch {
    loadFailed = true
    enc = null
  }
}

// Загружен ли настоящий токенизатор (false = все цифры ниже помечены est).
export function isRealTokenizer(): boolean {
  ensure()
  return enc !== null
}

// Языкозависимый fallback: latin/4, cyrillic/2, CJK/1.5, прочее/3.
// Старый len/4 недоучитывал русский в ~2x ("привет мир": 3 вместо 6).
export function heuristicTokens(text: string): number {
  if (!text) return 1
  let latin = 0
  let cyr = 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x250) latin++
    else if (c >= 0x400 && c < 0x530) cyr++
    else if ((c >= 0x4e00 && c < 0xa000) || (c >= 0x3040 && c < 0x3100) || (c >= 0xac00 && c < 0xd800)) cjk++
    else other++
  }
  return Math.max(1, Math.ceil(latin / 4 + cyr / 2 + cjk / 1.5 + other / 3))
}

export function countTokens(text: string): CountResult {
  const s = text ?? ""
  ensure()
  if (enc) {
    try {
      return encodeReal(s)
    } catch {
      // ниже — fallback
    }
  }
  return { n: heuristicTokens(s), estimated: true }
}

// Реальный подсчёт чанками: BPE-слияния через границу чанка дают погрешность
// ~+0.3% (замер: 6037 vs 6020 на 24k смешанного текста), зато нет суперлинейного
// клиффа на сериях одинаковых символов ('x'*5000 — 4.8с одним вызовом).
// Дедлайн: патологический вход обрываем экстраполяцией с estimated:true.
const CHUNK = 2000
const BUDGET_MS = 50

function encodeReal(text: string): CountResult {
  if (!text) return { n: 1, estimated: false }
  const chunks: string[] = []
  for (const line of text.split("\n")) {
    if (line.length <= CHUNK) {
      const last = chunks[chunks.length - 1]
      if (last !== undefined && last.length + line.length + 1 <= CHUNK) {
        chunks[chunks.length - 1] = last + "\n" + line
      } else {
        chunks.push(line)
      }
    } else {
      for (let i = 0; i < line.length; i += CHUNK) chunks.push(line.slice(i, i + CHUNK))
    }
  }
  let n = 0
  let done = 0
  const t0 = Date.now()
  for (const c of chunks) {
    n += (enc as Encoder).encode(c).length || 0
    done += c.length
    if (Date.now() - t0 > BUDGET_MS && done < text.length) {
      const rate = done > 0 ? n / done : 1 / 4
      n += Math.ceil(rate * (text.length - done))
      return { n: Math.max(1, n), estimated: true }
    }
  }
  return { n: Math.max(1, n), estimated: false }
}

// Совместимость: прежняя сигнатура tokens(text): number (14+ мест вызова).
export function tokens(text: string): number {
  return countTokens(text).n
}
