// UC-005 — классификатор: только hint, без внешних вызовов.
// Гарантия двухуровневая: (1) hint ни на что не влияет сам — план создаёт
// только явный /goal; (2) сам hint покрыт edge-кейсами ниже, включая ловушки
// подстрок (add в padding, фол в дефолт), повторы, инфинитивы и приоритеты.
import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyRequest, isExplicitGoalCommand } from "../lib/ultracode/classifier.ts"

test("ordinary request does not create multi_step plan", () => {
  assert.equal(classifyRequest("привет, как дела?"), "simple")
  assert.equal(classifyRequest("покажи файл README"), "simple")
})

test("/goal is explicit entrypoint", () => {
  assert.equal(isExplicitGoalCommand("/goal реализуй API, тесты и документацию"), true)
  assert.equal(isExplicitGoalCommand("реализуй API"), false)
})

test("multi_step needs 3+ actions", () => {
  assert.equal(classifyRequest("создай проверь настрой реализуй API"), "multi_step")
})

test("design hint without side effects", () => {
  assert.equal(classifyRequest("сделай дизайн карточки товара"), "design")
  // классификатор — чистая функция: повторный вызов тот же результат, без I/O
  assert.equal(classifyRequest("сделай дизайн карточки товара"), "design")
})

test("bugfix and research hints", () => {
  assert.equal(classifyRequest("почини баг: падает с exception при запуске"), "bugfix")
  assert.equal(classifyRequest("исследуй как работает store и объясни"), "research")
})

// --- simple: одно действие или пустой запрос, что бы ни обещал размер ---

test("simple: single action stays simple", () => {
  const cases: Array<[string, string]> = [
    ["одно действие", "Перепиши этот файл"],
    ["одно действие EN", "delete this file"],
    ["один глагол", "создай файл"],
    ["один глагол 2", "обнови статус"],
    ["повтор не множит", "проверь проверь проверь"],
    ["greeting", "привет, как дела?"],
    ["пустой вопрос", "что такое CI?"],
    ["пустой вопрос 2", "сколько времени?"],
    ["показ файла", "покажи файл README"],
    ["lookup, не research", "найди где хранится конфиг"],
    ["перечисление без глаголов", "список: сервер, клиент, тесты"],
    ["просьба без действия", "помоги разобраться"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "simple", name)
  }
})

test("simple: substring traps do not fire", () => {
  const cases: Array<[string, string]> = [
    ["add в padding", "add padding to the button"],
    ["download чист", "download the assets and add padding"],
    ["add в download", "download the assets"],
    ["fix в prefix/suffix", "fix the prefix handling"],
    ["фол в дефолт", "используй дефолт"],
    ["audit в audition", "prepare for audition"],
    ["edit в credit", "credit the author"],
    ["test в latest", "check the latest build"],
    ["remove в removed", "remove the removed files"],
    ["past tense не приказ", "the deleted files are gone"],
    ["существительное не глагол", "создатель API"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "simple", name)
  }
})

// --- multi_step: 3+ различных действия, области или перечисление ---

test("multi_step: three distinct verbs", () => {
  const cases: Array<[string, string]> = [
    ["база", "создай проверь настрой реализуй API"],
    ["инфинитивы", "создать API, написать тесты и обновить документацию"],
    ["EN инфинитивы", "create the endpoint, write tests and update docs"],
    ["баг-план раньше bugfix", "найди баг, исправь его и покрой тестами"],
    ["удали+почини+обнови", "удали файл, почини импорт и обнови доку"],
    ["EN rewrite", "rewrite the component, add tests and update docs"],
    ["деплой-цикл", "настрой CI, задеплой на прод и проверь логи"],
    ["миграция", "создай миграцию, обнови схему и перезапусти сервер"],
    ["релиз-цикл", "протестируй, задокументируй и выкати релиз"],
    ["два повтора + третье", "проверь логи, обнови доку и перезапусти сервер"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "multi_step", name)
  }
})

test("multi_step: areas and enumerated plans", () => {
  const cases: Array<[string, string]> = [
    ["канон: бэк+фронт+тесты", "реализуй фичу, включая бэкенд, фронтенд и тесты"],
    ["канон EN", "implement backend, frontend and tests"],
    ["глагол+2 области", "напиши тесты и обнови доки"],
    ["повтор глагола + 2 области", "создай файл, создай тест, создай доку"],
    ["перечисление 3 шагов", "план такой:\n1. сначала внимательно прочитать весь существующий код модуля авторизации пользователей\n2. затем аккуратно перенести всю логику в новую структуру пакетов приложения\n3. в конце показать итоговый diff всех изменений для ревью"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "multi_step", name)
  }
})

// --- design ---

test("design: RU/EN, регистр, плюралы", () => {
  const cases: Array<[string, string]> = [
    ["база", "сделай дизайн карточки товара"],
    ["идемпотентность", "сделай дизайн карточки товара"],
    ["иконка", "нарисуй иконку корзины"],
    ["цвета", "подбери цветовую схему"],
    ["лендинг", "сверстай лендинг"],
    ["CAPS", "СВЕРСТАЙ ЛЕНДИНГ"],
    ["макет+фигма", "посмотри макет в фигме"],
    ["анимация", "добавь анимацию появления"],
    ["шрифт", "выбери шрифт для заголовков"],
    ["EN", "create a landing mockup"],
    ["EN страница", "design the login page"],
    ["тёмная тема", "сделай тёмную тему"],
    ["логотип", "нарисуй логотип"],
    ["приоритет над слабым фиксом", "почини дизайн кнопки"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "design", name)
  }
})

// --- research ---

test("research: вопросы понимания, не поломки", () => {
  const cases: Array<[string, string]> = [
    ["база", "исследуй как работает store и объясни"],
    ["устройство", "разберись как устроен стор"],
    ["разбери без сь", "разбери код авторизации"],
    ["объясни", "объясни разницу между X и Y"],
    ["сравни", "сравни два подхода"],
    ["аудит кириллицей", "проведи аудит зависимостей"],
    ["audit EN", "audit the codebase"],
    ["explain EN", "explain how auth works"],
    ["обзор", "сделай обзор архитектуры"],
    ["что делает", "что делает этот модуль"],
    ["области не перебивают", "сравни бэкенд и фронтенд"],
    ["изучи", "изучи документацию API"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "research", name)
  }
})

// --- bugfix ---

test("bugfix: сильные и слабые сигналы", () => {
  const cases: Array<[string, string]> = [
    ["база", "почини баг: падает с exception при запуске"],
    ["упал+traceback", "тест упал с traceback"],
    ["failed", "build failed на шаге тестов"],
    ["flaky+крашится", "флаки-тест крашится"],
    ["крашит", "Chrome крашит вкладку"],
    ["почини краш", "почини краш при старте"],
    ["broken EN", "prod is broken after deploy"],
    ["crashes EN", "app crashes on launch"],
    ["приоритет над research", "разберись почему падает прод"],
    ["stacktrace", "test failed with stacktrace"],
    ["не работает", "не работает кнопка отправки"],
    ["exception", "exception in worker thread"],
    ["фейл", "фейл на CI"],
    ["ошибку (аккузатив)", "выдаёт ошибку при входе"],
    ["сильный раньше дизайна", "it fails on launch, show the design screen"],
  ]
  for (const [name, text] of cases) {
    assert.equal(classifyRequest(text), "bugfix", name)
  }
})
