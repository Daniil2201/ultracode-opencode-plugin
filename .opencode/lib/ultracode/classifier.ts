// UC-005 — классификатор сложности. Чистый hint, без сайд-эффектов:
// не вызывает task, MCP или модель. Только regex над текстом.
//
// Правила (порядок важен):
// 1. ≥3 РАЗЛИЧНЫХ глагола действия → multi_step (повторы не считаются).
// 2. Сильные сигналы поломки (exception/stacktrace/crash/падает/упал) → bugfix.
// 3. Дизайн-лексика → design.
// 4. Слабые сигналы поломки (баг/ошибка/почини/не работает) → bugfix.
// 5. Исследование → research.
// 6. ≥2 РАЗЛИЧНЫЕ области + ≥1 глагол → multi_step (голое перечисление
//    без действия — не план: "список: сервер, клиент, тесты" остаётся simple).
// 7. Длинное перечисление шагов → multi_step.
// 8. Иначе simple. Одно действие = simple, каким бы большим оно ни было.
//
// Границы — lookaround по буквам обоих алфавитов: \b вокруг кириллицы
// не работает, а голые подстроки дают ложняки (add в padding, фол в дефолт).
// Hint ни на что не влияет сам: план создаётся только по явному /goal.
export type RequestKind = "simple" | "multi_step" | "design" | "research" | "bugfix"

const L = "A-Za-zА-Яа-яЁё"
// Флаги без /g/: .test() на regex с /g/ запоминает lastIndex и врёт
// через вызов. /g/ добавляется только в локальной копии для подсчёта.
const B = (inner: string): RegExp => new RegExp(`(?<![${L}])(${inner})(?![${L}])`, "iu")

// Глаголы действия: императив + инфинитив, RU + EN. Прошедшее время и
// существительные ("создатель", "deleted files") намеренно не ловим:
// это описание, а не приказ к действию.
const ACTIONS_RE = B(
  "создай|создать|найди|найти|измени|изменить|проверь|проверить|" +
  "настрой|настроить|реализуй|реализовать|добавь|добавить|обнови|обновить|" +
  "напиши|написать|сделай|сделать|исправь|исправить|почини|поправь|поправить|" +
  "перепиши|переписать|удали|удалить|удаляй|убери|убрать|перенеси|перенести|" +
  "переименуй|замени|заменить|запусти|запустить|выполни|выполнить|подними|поднять|" +
  "перезапусти|перезапустить|протестируй|протестировать|покрой|опубликуй|опубликовать|" +
  "выкати|выкатить|задокументируй|документируй|оптимизируй|оптимизировать|" +
  "мигрируй|мигрировать|собери|собрать|задеплой|" +
  "create|implement|update|fix|add|refactor|rewrite|recreate|delete|remove|" +
  "move|rename|replace|run|execute|deploy|publish|release|document|test|testing|" +
  "migrate|optimize|build|rebuild|setup|configure|restart|verify|check|modify|edit",
)

const BUGFIX_STRONG_RE = B(
  "exception|stacktrace|traceback|crash(?:es|ed|ing)?|failed|fails?|failing|" +
  "пада[а-яё]*|упа[а-яё]*|краш[а-яё]*|креш[а-яё]*",
)

const DESIGN_RE = B(
  "дизайн[а-яё]*|дизайн-систем|иконк[а-яё]*|макет[а-яё]*|прототип[а-яё]*|" +
  "лендинг[а-яё]*|landing|figma|фигм[ауые]|компонент[а-яё]*|цвет[а-яё]*|" +
  "ui|вёрстк[а-яё]*|верстк[а-яё]*|сверста[а-яё]*|шрифт[а-яё]*|логотип[а-яё]*|" +
  "баннер[а-яё]*|анимац[а-яё]*|тем[а-яё]*|тёмн[а-яё]*|" +
  "mockups?|wireframes?|design|components?|icons?|colors?|fonts?|banners?|logos?|prototypes?",
)

const BUGFIX_WEAK_RE = B(
  "баг[а-яё]*|ошибк[аиу]|почини|не работает|сломал[а-яё]*|фейл[а-яё]*|фол|flaky|broken",
)

const RESEARCH_RE = B(
  "исследуй|изучи|объясни|как работает|что делает|как устроен|анализ|аудит|" +
  "разбери(?:сь)?|сравни|обзор|research|investigate|explain|audit|compare",
)

// Области работ: две и больше разные области = план, даже с одним глаголом
// ("реализуй фичу, включая бэкенд, фронтенд и тесты").
const AREAS_RE = B(
  "бэкенд[а-яё]*|бекенд[а-яё]*|backends?|фронтенд[а-яё]*|frontends?|фронт[а-яё]*|" +
  "тест(?:ы|ов|а|ам|ами)?|tests?|документаци[а-яё]*|док(?:и|у|ов|а|ом|е)?|docs|" +
  "депло[а-яё]*|deploys?|миграци[а-яё]*|migrations?|api|" +
  "база данных|database[а-яё]*|клиент[а-яё]*|clients?|сервер[а-яё]*|servers?",
)

// Явная точка входа /goal решает, а не скрытые ключевые слова:
// обычный запрос никогда не создаёт план сам — это делает агент по /goal.
export function isExplicitGoalCommand(text: string): boolean {
  return /^\/goal\b/m.test(text.trim())
}

function distinctHits(t: string, re: RegExp): Set<string> {
  // match без /g невозможен для подсчёта — снимаем копию флага через новый проход.
  const found = t.match(new RegExp(re.source, "giu")) ?? []
  return new Set(found.map((s) => s.toLowerCase()))
}

export function classifyRequest(text: string): RequestKind {
  const t = String(text ?? "")
  const actions = distinctHits(t, ACTIONS_RE)
  if (actions.size >= 3) return "multi_step"
  if (BUGFIX_STRONG_RE.test(t)) return "bugfix"
  if (DESIGN_RE.test(t)) return "design"
  if (BUGFIX_WEAK_RE.test(t)) return "bugfix"
  if (RESEARCH_RE.test(t)) return "research"
  if (actions.size >= 1 && distinctHits(t, AREAS_RE).size >= 2) return "multi_step"
  // эвристика многошаговости: длинная цель с перечислением шагов
  const steps = t.split(/\n|;|→|->/).map((s) => s.trim()).filter(Boolean)
  if (steps.length >= 3 && t.length > 120) return "multi_step"
  return "simple"
}
