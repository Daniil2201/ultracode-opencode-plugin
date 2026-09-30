// Pentest property test: 1000 случайных секретов в ~45 формах — ни один
// не проходит firewall. Seeded PRNG (mulberry32): детерминировано, без flake.
// Секреты синтетические — безопасно показывать в логах падений.
import { test } from "node:test"
import assert from "node:assert/strict"
import { redactConfidential } from "../lib/ultracode/confidential.ts"

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0xc0ffee)
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
function rs(alpha: string, min: number, max: number): string {
  const n = min + Math.floor(rand() * (max - min + 1))
  let s = ""
  for (let i = 0; i < n; i++) s += alpha[Math.floor(rand() * alpha.length)]
  return s
}
const HEX = "0123456789abcdef"
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const B64U = `${ALNUM}-_`
const hex = (a = 12, b = 48) => rs(HEX, a, b)
const alnum = (a = 12, b = 32) => rs(ALNUM, a, b)
const b64u = (a = 12, b = 32) => rs(B64U, a, b)
const UPPER16 = () => rs("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 16, 16)

interface Shape {
  name: string
  make: () => { input: string; secret: string }
}
const S = (name: string, make: (s: string) => string, gen: () => string = () => alnum()): Shape => ({
  name,
  make: () => {
    const secret = gen()
    return { input: make(secret), secret }
  },
})
const shapes: Shape[] = [
  S("env-eq", (s) => `API_HASH=${s}`),
  S("env-spaces", (s) => `BOT_TOKEN = ${s}`),
  S("env-colon", (s) => `password: ${s}`),
  S("json-dq", (s) => `{"api_key": "${s}"}`),
  S("json-dq-nospace", (s) => `{"secret":"${s}"}`),
  S("json-sq", (s) => `{'password' : '${s}'}`),
  S("arrow", (s) => `password => "${s}"`),
  S("export", (s) => `export TELEGRAM_TOKEN=${s}`),
  S("pass", (s) => `pass=${s}`),
  S("secret-key", (s) => `secret_key=${s}`),
  S("password-hash", (s) => `password_hash: ${s}`),
  S("token-secret", (s) => `token_secret=${s}`),
  S("camel-apikey", (s) => `apiKey=${s}`),
  S("camel-clientsecret", (s) => `clientSecret: ${s}`),
  S("camel-accesstoken", (s) => `accessToken = "${s}"`),
  S("dotted", (s) => `api.key=${s}`),
  S("spaced", (s) => `api key = ${s}`),
  S("bearer", (s) => `Authorization: Bearer ${s}`, () => b64u(20, 40)),
  S("bearer-colon", (s) => `Bearer: ${s}`, () => alnum(16, 24)),
  S("token-short", (s) => `Token=${s}`, () => alnum(5, 7)),
  S("basic-b64", (s) => `Authorization: Basic ${s}`, () => rs("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", 12, 24)),
  S("basic-plain", (s) => `Basic operator:${s}`),
  S("sk-live", (s) => `sk_live_${s}`, () => alnum(16, 20)),
  S("sk-proj", (s) => `sk-proj-${s}`, () => b64u(20, 30)),
  S("ghp", (s) => `${pick(["ghp_", "gho_", "ghs_"])}${s}`, () => alnum(16, 24)),
  S("github-pat", (s) => `github_pat_${s}`, () => rs(`${ALNUM}_`, 15, 25)),
  S("xox", (s) => `${pick(["xoxb-", "xoxo-", "xoxc-"])}${s}`, () => rs(`${ALNUM}-`, 12, 20)),
  S("akia", (s) => `AKIA${s}`, UPPER16),
  S("bot-nospace", (s) => `bot123456:${s}`, () => rs(`${ALNUM}-_`, 20, 35)),
  S("bot-space-upper", (s) => `BOT99: ${s}`, () => rs(`${ALNUM}-_`, 20, 35)),
  S("jwt", (s) => s, () => `eyJ${b64u(10, 20)}.${b64u(10, 20)}.${b64u(10, 20)}`),
  S("privkey", (s) => `-----BEGIN ${pick(["RSA ", "OPENSSH "])}PRIVATE KEY-----\n${s}\n-----END PRIVATE KEY-----`, () => rs(`${B64U}\n`, 60, 120)),
  S("redis-empty-user", (s) => `redis://:${s}@cache:6379`),
  S("postgres", (s) => `postgres://app:${s}@db:5432/main`),
  S("mongodb-srv", (s) => `mongodb+srv://u:${s}@cluster/x`),
  S("ssh", (s) => `ssh://git:${s}@host/x`),
  S("url-slash-pass", (s) => `https://u:${s}@host/`, () => `${alnum(4, 8)}/${alnum(4, 8)}`),
  S("cookie-php", (s) => `Cookie: PHPSESSID=${s}; theme=dark`),
  S("cookie-java", (s) => `Set-Cookie: JSESSIONID=${s}; Path=/`),
  S("cookie-asp", (s) => `ASPSESSIONID=${s}`),
  S("cookie-colon", (s) => `sid: ${s}`),
  S("cookie-connect", (s) => `connect.sid=${s}`),
  S("html-lower", (s) => `<input type="password" name="pw" value="${s}">`),
  S("html-upper", (s) => `<INPUT TYPE="PASSWORD" VALUE="${s}">`),
  S("html-value-first", (s) => `<input value="${s}" type="password">`),
  S("html-spaced-value", (s) => `<input type="password" value="my ${s} phrase">`),
  S("html-secret-name", (s) => `<input name="api_token" value="${s}">`),
  S("html-textarea", (s) => `<textarea name="secret">${s}</textarea>`),
  S("html-data", (s) => `<div data-token="${s}">x</div>`),
  S("email", (s) => `write to ${s}`, () => `${alnum(4, 10).toLowerCase()}@example.com`),
  S("email-cyr", (s) => `почта ${s}`, () => `${alnum(4, 8).toLowerCase()}@пример.рф`),
  S("email-encoded", (s) => `user${s}%40example.com`, () => alnum(4, 8).toLowerCase()),
  S("phone-plus", (s) => `тел ${s}`, () => `+7 (${rs("0123456789", 3, 3)}) ${rs("0123456789", 3, 3)}-${rs("0123456789", 2, 2)}-${rs("0123456789", 2, 2)}`),
  S("phone-8", (s) => `8${s}`, () => rs("0123456789", 10, 10)),
  S("phone-bare9", (s) => `${s}`, () => `9${rs("0123456789", 9, 9)}`),
  S("phone-dotted", (s) => `${s}`, () => `9.${rs("0123456789", 3, 3)}.${rs("0123456789", 3, 3)}.${rs("0123456789", 3, 3)}`),
  S("urlencoded", (s) => `password%3D${s}`),
  S("query", (s) => `https://app/x?api_key=${s}&y=1`),
  S("fragment", (s) => `https://app/cb#access_token=${s}`),
  S("wrapped", (s) => `password=\n${s}`),
  S("fullwidth-phone", (s) => `tel ${s}`, () => `＋７${rs("０１２３４５６７８９", 10, 10)}`),
]

test("1000 random secrets in ~60 shapes: none passes the firewall", () => {
  const N = 1000
  for (let i = 0; i < N; i++) {
    const sh = shapes[i % shapes.length]
    const { input, secret } = sh.make()
    const out = redactConfidential(input)
    // Сообщение без сырого секрета: иначе firewall зачистит его из лога
    // и место утечки станет невидимым. Синтетика воспроизводима по seed.
    assert.ok(
      !out.includes(secret),
      `LEAK shape=${sh.name} iter=${i} secretLen=${secret.length} inLen=${input.length} outLen=${out.length}`,
    )
    // Идемпотентность: повторный прогон ничего не меняет.
    assert.equal(redactConfidential(out), out, `not idempotent: ${sh.name} iter=${i}`)
  }
})

test("benign corpus: code and ids survive, fail-closed documented", () => {
  const same = [
    "канал YuliaAndBot, пост прошёл gate, score 72",
    "v1.18.29, chat -1004322131405, theme=dark",
    "session ses_f977772e, const sessionId = getSessionId()",
    "passport=AB123456, bypass=x",
    "mytoken counter, token abc",
  ]
  for (const t of same) assert.equal(redactConfidential(t), t, `over-redact: ${t}`)
  // Fail-closed: assignment to sid-like name hides even single-letter value.
  assert.equal(redactConfidential("const sid = x"), "const sid=[redacted]")
})
