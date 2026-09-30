---
name: quality-gate
description: Post-quality gate for the my-manager Telegram farm — run this before publishing anything. Verifies a post passes both the automated quality_check (tg-manager MCP) and a manual neural-slop review, so the channel doesn't post content that reads like AI slop. Covers: emoji overload, admin-clichés (канцелярит), excessive smoothing, over-structured lists, false crispness, and the quality_check threshold from farm knowledge. Trigger phrases — "check quality", "quality-gate", "проверь качество", "/check", "neural slop", "нейрослоп", "это не как человек", any time a post is about to be published. Skip for — posts already verified this session with a passing score and no edits after the check (edited text must be re-checked).
license: MIT
compatibility: opencode
metadata:
  source: "Built for my-manager farm; pairs with farm/skills/quality-checker + quality-check.md"
  requires_codegraph: false
---

> **Tool mapping (OpenCode):**
> - `quality_check` and `get_knowledge` come from the `tg-manager` MCP server
> - `question` for asking the user to decide on a borderline post
> - `bash`/`webfetch` fallback if the farm MCP is unavailable (then replicate the checklist by hand)

# Quality Gate

A post must pass TWO gates before it may be published:

1. **Automated**: `quality_check` score ≥ farm threshold.
2. **Manual**: no neural-slop markers in the list below.

If either fails, do NOT publish. Rewrite and re-run.

## Gate 1 — Automated

1. Call `quality_check` with the post text.
2. Read `get_knowledge state` to get the threshold (`min_human_like`, default 70).
3. Pass = `human_like_score >= threshold`. Show the score and slop score.
4. If below threshold: list the issues and rewrite, then re-run the check. Loop until pass or give up (don't lower the threshold).

## Gate 2 — Manual neural-slop review

Read the text like a native reader. Check for:

### Emoji overload
- More than ~3 emoji per post, or emoji used as bullet points, or emoji that don't add meaning (✅🔥💯 as decoration) → fail.
- One intentional emoji at the end is fine (matches typical human channel style).
- Emoji frequency must match the active donor style (from `get_knowledge style`).

### Admin-clichés (канцелярит / corporate voice)
- "Мы рады сообщить", "команда подготовила", "в рамках", "данный сервис", "осуществляется", "является", "следует отметить", "безусловно", "в свою очередь", "представляем вашему вниманию" → fail.
- Passive robotic "было принято решение", "производится оплата".
- Officialese that a person in a chat wouldn't write.

### Excessive smoothing (all-positive, no rough edges)
- Zero criticism, zero doubt, everyone/everything perfect, every sentence ends "!" → fail.
- Humans hedge: "наверное", "мне кажется", "но вообще", "поправь если что". A post with zero hedges reads robotic.
- Total lack of personal opinion or "I".

### Over-structured lists
- More than 2-3 bullet lists, or a post that looks like a noun phrase slide deck ("✅ Возможности: / 🔄 Интеграция:") where a person would write flowing prose → fail.
- Headers/sections with emoji icons that no human channel uses.

### False crispness
- Every sentence the same length, monotone rhythm, no anaphore/variation → fail.
- Perfectly "polished" copy with no personality (no jokes, no metaphor, no relatable detail).
- AI-flavored transitions ("важно отметить", "стоит сказать", "подводя итог").

### Concrete facts / rounding mania
- Invented percentages, or hayвcate nominal "gamification", "синергия", "оптимизация", "инновация", weasel words → fail.

### Hook / first line
- First line must grab attention (specific claim, question, provable number). Vague generic "Сегодня расскажем про..." → fail. Humans open on the payoff.
- Post must be understandable as a forward out-of-context (someone shares it — does it stand alone?).

### One CTA, not five
- >1 call-to-action (ask to react + ask to comment + ask to subscribe) → fail. One clear CTA max; often zero with the value going first.

### Simulated engagement
- "Напишите в комментариях", "поставь 🔥 если согласен" on EVERY post, fake-poll flavor, scripted "какой у вас опыт?" that the author wouldn't actually read → fail. Real authors occasionally ask; they don't beg every post.

## Decide

- **Pass both gates** → OK to publish.
- **Fail any marker** → identify the worst offenders, rewrite the affected sentences (preserve meaning, donor voice), re-run Gate 1. Loop max 3; if still failing, show the post to the user with `question`.
- **Borderline** → ask the user (one question, show why it's borderline).

## Finish
Report: score, slop, which manual markers were checked clean, and the publish verdict (post it / rewrite / ask).

## Benchmarks (from 2026 Telegram channel research)
Use as context for the "would a human publish this" judgment, not as hard gates:
- Posting rhythm: 1-3 posts/day for most channels; expert/coach channels sustainable floor is 3/week. Consistency beats intensity.
- Pillar mix: ~70% core value, ~20% engagement (polls/questions), ~10% promo (7 value posts before a money ask).
- Formats that earn shares: hook posts, case studies/breakdowns, opinion with a defensible take, checklists/save-worthy lists, behind-the-scenes.
- Post peak windows: morning 8-11 and evening 18-21 local → +20-40% views.
- Healthy engagement (view based): 40-60% views/subscribers, 1-3% forward rate, ~5% reactions+comments/views. A post that is "fine" but would get zero forwards is probably too generic — rewrite the hook.