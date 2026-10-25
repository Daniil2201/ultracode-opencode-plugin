// UC-025 — единый контракт «работающий проект»: один интерфейс,
// разные реализации (Node/Rust/Python/Php/Go). Агент спрашивает
// contract.test() и не думает про npm vs cargo vs pytest.
//
// Два слоя, не путать:
// - DetectedStack (stack-detect.ts) — lenient hint: дефолтная команда есть
//   всегда, даже без scripts.test (с note). Нужен для acceptance-дефолта.
// - StackContract (этот файл) — strict promise: команда возвращается, только
//   если ей есть подтверждение в проекте (скрипт/конвенция стека), иначе null.
//   test() берёт уже разрешённую UC-023 команду кандидата (scripts.test >
//   Makefile/justfile > workflow > дефолт), остальное — конвенции стека.
// Ponytail: stdlib only, чистые функции + тонкий fs-слой, никогда не бросает.
import * as path from "node:path"
import type { StackKind } from "./stack-detect.ts"
import { detectStack, readScripts } from "./stack-detect.ts"

export interface StackCommands {
  test: string | null
  build: string | null
  lint: string | null
  typecheck: string | null
  run: string | null
}

export interface StackContract {
  readonly stack: Exclude<StackKind, "unknown">
  readonly dir: string
  readonly source: string
  test(): string | null
  build(): string | null
  lint(): string | null
  typecheck(): string | null
  run(): string | null
  commands(): StackCommands
}

function snapshot(c: StackContract): StackCommands {
  return { test: c.test(), build: c.build(), lint: c.lint(), typecheck: c.typecheck(), run: c.run() }
}

class NodeContract implements StackContract {
  readonly stack = "node" as const
  readonly dir: string
  readonly source: string
  private readonly testCmd: string
  private readonly scripts: Record<string, string>
  constructor(dir: string, source: string, testCmd: string, scripts: Record<string, string>) {
    this.dir = dir
    this.source = source
    this.testCmd = testCmd
    this.scripts = scripts
  }
  test(): string | null {
    return this.testCmd
  }
  build(): string | null {
    return this.scripts["build"] ? "npm run build" : null
  }
  lint(): string | null {
    return this.scripts["lint"] ? "npm run lint" : null
  }
  typecheck(): string | null {
    return this.scripts["typecheck"] ? "npm run typecheck" : null
  }
  run(): string | null {
    if (this.scripts["start"]) return "npm start"
    return this.scripts["dev"] ? "npm run dev" : null
  }
  commands(): StackCommands {
    return snapshot(this)
  }
}

class RustContract implements StackContract {
  readonly stack = "rust" as const
  readonly dir: string
  readonly source: string
  private readonly testCmd: string
  constructor(dir: string, source: string, testCmd: string) {
    this.dir = dir
    this.source = source
    this.testCmd = testCmd
  }
  test(): string | null {
    return this.testCmd
  }
  build(): string | null {
    return "cargo build"
  }
  lint(): string | null {
    return "cargo clippy"
  }
  typecheck(): string | null {
    return "cargo check"
  }
  // run(): бинарь vs библиотека по манифесту не различить честно — null.
  run(): string | null {
    return null
  }
  commands(): StackCommands {
    return snapshot(this)
  }
}

class PythonContract implements StackContract {
  readonly stack = "python" as const
  readonly dir: string
  readonly source: string
  private readonly testCmd: string
  constructor(dir: string, source: string, testCmd: string) {
    this.dir = dir
    this.source = source
    this.testCmd = testCmd
  }
  test(): string | null {
    return this.testCmd
  }
  // build/lint/typecheck/run: универсальных entrypoints нет
  // (ruff/mypy/tox/tox varies) — честный null вместо угадайки.
  build(): string | null {
    return null
  }
  lint(): string | null {
    return null
  }
  typecheck(): string | null {
    return null
  }
  run(): string | null {
    return null
  }
  commands(): StackCommands {
    return snapshot(this)
  }
}

class PhpContract implements StackContract {
  readonly stack = "php" as const
  readonly dir: string
  readonly source: string
  private readonly testCmd: string
  constructor(dir: string, source: string, testCmd: string) {
    this.dir = dir
    this.source = source
    this.testCmd = testCmd
  }
  test(): string | null {
    return this.testCmd
  }
  // У composer нет универсальных имён build/lint/typecheck/run — null.
  build(): string | null {
    return null
  }
  lint(): string | null {
    return null
  }
  typecheck(): string | null {
    return null
  }
  run(): string | null {
    return null
  }
  commands(): StackCommands {
    return snapshot(this)
  }
}

class GoContract implements StackContract {
  readonly stack = "go" as const
  readonly dir: string
  readonly source: string
  private readonly testCmd: string
  constructor(dir: string, source: string, testCmd: string) {
    this.dir = dir
    this.source = source
    this.testCmd = testCmd
  }
  test(): string | null {
    return this.testCmd
  }
  build(): string | null {
    return "go build ./..."
  }
  lint(): string | null {
    return null
  }
  typecheck(): string | null {
    return "go vet ./..."
  }
  run(): string | null {
    return null
  }
  commands(): StackCommands {
    return snapshot(this)
  }
}

// Фабрика: null = стек неизвестен (не выдумываем), никогда не бросает.
export function detectContract(projectRoot: string): StackContract | null {
  try {
    const detected = detectStack(projectRoot)
    if (!detected) return null
    const absDir = detected.dir ? path.join(path.resolve(projectRoot), detected.dir) : path.resolve(projectRoot)
    switch (detected.stack) {
      case "node":
        return new NodeContract(detected.dir, detected.source, detected.testCommand, readScripts(absDir, "package.json"))
      case "rust":
        return new RustContract(detected.dir, detected.source, detected.testCommand)
      case "python":
        return new PythonContract(detected.dir, detected.source, detected.testCommand)
      case "php":
        return new PhpContract(detected.dir, detected.source, detected.testCommand)
      case "go":
        return new GoContract(detected.dir, detected.source, detected.testCommand)
      default:
        return null
    }
  } catch {
    return null
  }
}
