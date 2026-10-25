// UC-021 — confidential-data firewall: модель видит вёрстку/структуру,
// секреты — никогда. Единая точка для storage, evidence, metrics и tool output.
// Ponytail: stdlib only, чистые regex, без \b вокруг кириллицы.
// Fail-closed: лучше перескрыть, чем пропустить. Bare `session` убран из KV:
// sessionId/sessionID живут в коде чаще, чем в секретах (куки покрывает COOKIE_RE).

// Маркер замены (экспорт первым: node --check включает type-stripping,
// увидев export до первой аннотации типов).
export const REDACTED = "[redacted]"

// Ключи вида KEY=VALUE / "KEY": "VALUE" / KEY => VALUE (.env, конфиги, JSON, логи).
// Значение скрывается, имя ключа остаётся — видна структура, не секрет.
const KV_KEYS = [
  "api[\\s._-]?id", "api[\\s._-]?hash", "apiKey", "apiHash", "apiId",
  "password", "passwd", "pwd", "\\bpass\\b", "password[\\s._-]?hash",
  "secret", "secret[\\s._-]?key",
  "client[\\s._-]?secret", "clientSecret",
  "api[\\s._-]?secret", "apiSecret",
  "token", "bot[\\s._-]?token",
  "api[\\s._-]?key", "apikey",
  "access[\\s._-]?token", "accessToken",
  "refresh[\\s._-]?token", "auth[\\s._-]?token", "authToken",
  "private[\\s._-]?key", "privateKey",
  "token[\\s._-]?(?:secret|value)", "api[\\s._-]?key[\\s._-]?(?:secret|value)",
  "authorization", "x-api-key",
  "login", "username", "user[\\s._-]?name",
  "phone", "tel(?:ephone)?", "email", "e-?mail",
].join("|")
const KV_RE = new RegExp(`(["']?)(${KV_KEYS})(["']?)\\s*(?:=>|[:=]|%3D|%3A)\\s*("[^"]*"|'[^']*'|\\[[^\\]]*\\]|[^\\s"',}&]+)`, "gi")

// Plaintext Basic раньше scheme: иначе scheme съест "alice", оставив ":hunter2".
const BASIC_PLAINTEXT_RE = /(\bbasic)\s+([^:\s]+:[^\s]+)/gi
const AUTH_SCHEME_RE = /\b(bearer|basic|token|apikey|api[_-]?key)\s*[:=]?\s+([A-Za-z0-9._~+\/=,-]{4,}=?)/gi
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/-]+=?/gi
const BASIC_RE = /(basic\s+)[A-Za-z0-9+/=]{8,}/gi
const PROVIDER_TOKEN_RE = /\b(sk-[A-Za-z0-9-_]{8,}|sk_live_[A-Za-z0-9]{8,}|gh[pours]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{11,}|xox[oabpcrsd]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{20,})\b/g
const BOT_URL_RE = /bot\d+\s*:\s*[A-Za-z0-9_-]{20,}/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PRIVATE_KEY_RE = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*-----/g
const CRED_URL_RE = /(https?|wss?|ftp|ssh|redis|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/([^/\s:@]*):([^\s@]+)@/gi
// Куки: JSESSIONID/ASPSESSIONID/PHPSESSID/sid/Auth — значения скрыть, имена оставить.
// Значение с parens/backtick — это код (getSessionId()), а не секрет: не трогаем.
const COOKIE_RE = /\b((?:JSESSIONID|ASPSESSIONID|PHPSESSID|session[_.-]?id|sess[_.-]?id|connect[_.-]?sid|sid|auth[_.-]?token))\s*((?:[:=]|%3D|%3A))\s*([^;\s,]+)/gi

// Ключи, у которых значение — почти всегда секрет. Для них exempt-правило
// максимально узкое: только примитив TS или типовая пунктуация. Иначе фаззер
// находит утечку вида `export TELEGRAM_TOKEN=<12 символов>`.
// sessid ловит PHPSESSID/JSESSIONID/ASPSESSIONID/sessId, но НЕ sessionId
// (в нём между «sess» и «id» стоит «ion») — ради него exempt-правило остаётся широким.
const HARD_SECRET_KEY = /pass|secret|token|key|hash|pwd|auth|credential|cookie|bearer|basic|sessid/i
const HARD_SECRET_KEY_EXACT = /^(?:sid|connect[_.-]?sid)$/i
// Примитивы TypeScript: их значение в коде — тип, а не секрет.
const TS_PRIMITIVE = /^(string|number|boolean|any|unknown|never|void|null|undefined|object|symbol|bigint)$/

// Значение похоже на ТИП или код, а не на секрет — не редактируем.
// UC-035: предикат ужесточён. Раньше «короче 8» и «начинается с заглавной»
// пропускали настоящие секреты (api_hash=ABCDEF, BOT_TOKEN=Abcdefghij…) —
// это была утечка, а не защита кода.
//   • значение в кавычках — литерал, даже из 5 символов → это секрет;
//   • у hard-ключа (token/password/key/…) exempt только примитив TS;
//   • у прочих ключей (sessionId, id, userId) — lowercase-слово ≤12, PascalCase ≤12
//     с хотя бы одной строчной, либо типовая пунктуация.
// ponytail: потолок — у не-секретного ключа (sessionId) значение вида `Abcdefghij`
// не отличить от имени типа. Такие ключи секретами не являются.
function looksLikeTypeOrCode(val: string, key?: string): boolean {
  // Экранирование снимаем ДО замера: `string\n` — это 6 символов, а не 8.
  const un = String(val ?? "").replace(/\\(["'\\nrt])/g, "$1").replace(/\\+$/, "").trim()
  if (/^(['"]).*\1$/s.test(un)) return false            // кавычки → секрет
  // UC-034: точка с запятой — часть синтаксиса, не значение
  const v = un.replace(/[;,]+$/, "").replace(/^["']|["']$/g, "")   // кавычки по краям
  if (/[`()[\]<>{}]/.test(v)) return true               // вызов/шаблон/тип (& и | убраны: ими
                                                        // заканчиваются URL-запросы и YAML-ключи)
  const k = String(key ?? "")
  // Fail-closed: у hard-ключа exempt только примитив TS. PascalCase-имя типа
  // (`apiKey: Session`) тоже редактируется — это ложное срабатывание, но
  // обратное (пропустить секрет) невосстановимо. 1000×60 фаззер это требует.
  if (HARD_SECRET_KEY.test(k) || HARD_SECRET_KEY_EXACT.test(k)) return TS_PRIMITIVE.test(v)
  if (/^[a-z]{3,12}$/.test(v)) return true               // только буквы: string, number
  if (/^[A-Z][A-Za-z0-9_]*$/.test(v) && /[a-z]/.test(v) && v.length <= 12) return true
  return false
}

function redactCookie(m: string, name: string, _sep: string, val: string): string {
  if (looksLikeTypeOrCode(val, name)) return m
  return `${name}=${REDACTED}`
}
// hidden/password инпуты в любом порядке атрибутов и регистре: тег виден, value скрыт.
const HTML_PASS_RE = /(<input\b(?=[^>]{0,500}?\btype\s*=\s*["']?(?:password|hidden)\b)[^>]{0,500}?\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi
const HTML_SECRET_NAME_RE = /(<input\b(?=[^>]{0,500}?\b(?:name|id)\s*=\s*["']?[^"' >]{0,100}(?:token|session|csrf|auth|password|secret|passwd|pass|pwd|key)[^"' >]{0,100}["']?)[^>]{0,500}?\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi
const TEXTAREA_RE = /(<textarea\b(?=[^>]{0,500}?\b(?:name|id)\s*=\s*["']?[^"' >]{0,100}(?:token|secret|password|auth|key)[^"' >]{0,100}["']?)[^>]{0,500}?>)[\s\S]{0,20000}?(<\/textarea\s*>)/gi
const DATA_SECRET_RE = /(\bdata-(?:token|secret|password|auth|key)\b[^=<>]{0,100}=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi
const EMAIL_RE = /[A-Za-z0-9._%+\u0430-\u044F\u0410-\u042F\u0451\u0401-]+(?:@|%40)[A-Za-z0-9.\u0430-\u044F\u0410-\u042F\u0451\u0401-]+\.[A-Za-z\u0430-\u044F\u0410-\u042F\u0451\u0401]{2,}/g
const PHONE_CANDIDATE_RE = /[+\uFF0B]?[\d\uFF10-\uFF19][\d\s\-().\uFF10-\uFF19\uFF0B\u3000]{7,}[\d\uFF10-\uFF19]/g

function redactPhones(s: string): string {
  return s.replace(PHONE_CANDIDATE_RE, (m) => {
    const norm = m.normalize("NFKC")
    const digits = norm.replace(/\D/g, "")
    if (digits.length < 10 || digits.length > 15) return m
    // Требуем явный признак телефона (+/разделитель/7-9 в начале),
    // иначе длинные id (чат, версии) останутся как есть.
    if (!/^[+\s(]/.test(norm) && !/[\s.\-(]/.test(norm) && !/^[789]/.test(digits)) return m
    return "[redacted-phone]"
  })
}

// Рекурсивная зачистка tool-ответа любой формы (C2): мутирует на месте,
// глубина ограничена — циклы безопасны.
export function deepRedact(x: unknown, depth = 0): void {
  if (x === null || x === undefined || depth > 5) return
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      if (typeof x[i] === "string") x[i] = redactConfidential(x[i])
      else deepRedact(x[i], depth + 1)
    }
    return
  }
  if (typeof x === "object") {
    const o = x as Record<string, unknown>
    for (const k of Object.keys(o)) {
      if (typeof o[k] === "string") o[k] = redactConfidential(o[k] as string)
      else deepRedact(o[k], depth + 1)
    }
  }
}

// Главный firewall: сначала токены узнаваемой формы (иначе generic KV
// съест их префикс и оставит голое значение), затем KV, затем остальное.
// Маркеры [redacted*] ни одному паттерну не соответствуют (идемпотентно).
export function redactConfidential(text: string): string {
  // Склейка перенесённых секретов: backslash-перевод (shell) убираем полностью,
  // а "=\n" (log-wrap после разделителя) склеиваем ВМЕСТЕ с "=" — иначе KV
  // потеряет разделитель и значение уйдёт голым. Ограда (?<![=])/(?![=]):
  // серии "====" (pytest-заголовки и т.п.) склеивать нельзя — иначе заголовок
  // сольётся со следующей строкой и сломает построчный парсинг.
  let s = String(text ?? "").replace(/\\\r?\n/g, "").replace(/(?<![=])=(?![=])[ \t]*\r?\n/g, "=")
  s = s.replace(PRIVATE_KEY_RE, "[redacted-private-key]")
  s = s.replace(CRED_URL_RE, "$1://[redacted]@")
  s = s.replace(BASIC_PLAINTEXT_RE, "$1 [redacted]")
  s = s.replace(AUTH_SCHEME_RE, (m: string, scheme: string, val: string) =>
    looksLikeTypeOrCode(val, scheme) ? m : `${scheme} [redacted]`)
  s = s.replace(PROVIDER_TOKEN_RE, REDACTED)
  s = s.replace(BOT_URL_RE, REDACTED)
  s = s.replace(JWT_RE, "[redacted-jwt]")
  s = s.replace(COOKIE_RE, redactCookie)
  s = s.replace(KV_RE, (_m: string, open: string, key: string, close: string, val: string) =>
    looksLikeTypeOrCode(val, key) ? _m : `${open}${key}${close}=${REDACTED}`)
  s = s.replace(BEARER_RE, `$1${REDACTED}`).replace(BASIC_RE, `$1${REDACTED}`)
  s = s.replace(HTML_PASS_RE, `$1${REDACTED}`)
  s = s.replace(HTML_SECRET_NAME_RE, `$1${REDACTED}`)
  s = s.replace(TEXTAREA_RE, `$1[redacted]$2`)
  s = s.replace(DATA_SECRET_RE, `$1${REDACTED}`)
  s = s.replace(EMAIL_RE, "[redacted-email]")
  s = redactPhones(s)
  return s
}
