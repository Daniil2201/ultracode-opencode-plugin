import type { Plugin } from "@opencode-ai/plugin"

type Rule = {
  name: string
  reason: string
  pattern: RegExp
}

const rules: Rule[] = [
  {
    name: "recursive rm of system path",
    reason: "recursive forced removal of root, home, or a critical system directory",
    pattern:
      /\brm\s+(?=[^;&|]*-[^\s;&|]*r)(?=[^;&|]*-[^\s;&|]*f)[^;&|]*(?:\s+["']?(?:\/|\/\*|~(?:\/|\s|$)|\$HOME|\$\{HOME\}|\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|sys|usr|var)(?:\/|\*|\s|$)))/i,
  },
  {
    name: "filesystem formatting or partitioning",
    reason: "formatting, partitioning, or wiping block devices can destroy local disks or remote hosts",
    pattern: /\b(?:mkfs(?:\.\w+)?|mke2fs|fdisk|parted|sgdisk|wipefs)\b/i,
  },
  {
    name: "raw block-device write",
    reason: "writing raw bytes to /dev devices can corrupt disks",
    pattern: /\bdd\s+[^;&|]*\bof=\/dev\//i,
  },
  {
    name: "block-device shredding",
    reason: "shredding or discarding /dev devices is destructive",
    pattern: /\b(?:shred|blkdiscard)\s+[^;&|]*\/dev\//i,
  },
  {
    name: "fork bomb",
    reason: "fork bombs can make the machine unusable",
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    name: "unsafe recursive chmod",
    reason: "recursively opening permissions on root or home is unsafe",
    pattern: /\bchmod\s+-R\s+777\s+(?:\/|\/\*|~|\$HOME|\$\{HOME\})(?:\s|$)/i,
  },
  {
    name: "unsafe recursive chown",
    reason: "recursively changing ownership of root or home is unsafe",
    pattern: /\bchown\s+-R\s+[^;&|]+\s+(?:\/|\/\*|~|\$HOME|\$\{HOME\})(?:\s|$)/i,
  },
  {
    name: "machine shutdown",
    reason: "shutdown, reboot, poweroff, and halt can interrupt local or remote environments",
    pattern: /\b(?:sudo\s+)?(?:shutdown|reboot|poweroff|halt)\b/i,
  },
  {
    name: "destructive git cleanup",
    reason: "hard resets, forced cleans, and force pushes can permanently discard work",
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s;&|]*[fxd]|push\b[^;&|]*\s--force(?:\s|$))/i,
  },
  {
    name: "destructive docker cleanup",
    reason: "docker prune, volume removal, and down -v can delete local data volumes",
    pattern:
      /\b(?:docker\s+(?:system\s+prune\b|volume\s+(?:rm|prune)\b|compose\s+down\b[^;&|]*\s-v\b)|docker-compose\s+down\b[^;&|]*\s-v\b)/i,
  },
  {
    name: "infrastructure destroy",
    reason: "destroy commands can remove connected environments",
    pattern: /\b(?:terraform|tofu|pulumi)\s+destroy\b/i,
  },
  {
    name: "mass kubernetes delete",
    reason: "cluster-wide deletes can remove connected environments",
    pattern:
      /\bkubectl\s+delete\s+(?:namespace|ns|all|pvc|pv|crd)\b[^;&|]*(?:--all|-A|--all-namespaces)/i,
  },
]

function commandFromArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args
  if (!args || typeof args !== "object") return undefined

  const record = args as Record<string, unknown>
  const command = record.command ?? record.cmd ?? record.script

  return typeof command === "string" ? command : undefined
}

function blockedRule(command: string): Rule | undefined {
  const normalized = command.replace(/\s+/g, " ").trim()

  return rules.find((rule) => rule.pattern.test(normalized))
}

export default (async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return

      const command = commandFromArgs(output.args)
      if (!command) return

      const rule = blockedRule(command)
      if (!rule) return

      throw new Error(
        `[opencode guardrail] Blocked bash command (${rule.name}): ${rule.reason}.`,
      )
    },
  }
}) satisfies Plugin
