# Repo Cleanup Recommendations

## Current state

The repo root has a mix of production code, prototypes, AI brainstorm transcripts, and planning docs. This makes it hard to tell what's current and what's historical.

## Recommended changes

### 1. Move AI brainstorm files out of root

Move these to a `_research/` directory (underscore prefix signals "not part of the product"):

```
chatgpt.txt  → _research/chatgpt-initial-brainstorm.txt
claude.txt   → _research/claude-initial-brainstorm.txt
gemini.txt   → _research/gemini-initial-brainstorm.txt
command.txt  → _research/prompt-used.txt
```

### 2. Archive the Express prototype

Move the `files/` directory:

```
files/  → _archive/express-prototype/
```

Add a note in `_archive/README.md` explaining this was the initial proof-of-concept.

### 3. Consolidate planning docs

You have two roadmaps (`weekly-side-roadmap.md` and `weekly-mvp-roadmap-12-weeks.md`) that overlap significantly. Pick one as canonical and archive the other.

The `todoless-plan.md` at root (857 lines) overlaps with `todoless-outside-in-strategy.md` (287 lines). The strategy doc is better — it's sharper and more actionable. Consider archiving the plan or at least moving it into `docs/`.

Suggested docs structure:

```
docs/
  strategy.md                        (rename of todoless-outside-in-strategy.md)
  roadmap.md                         (pick one roadmap, archive the other)
  week-01-checklist.md               (keep as-is)
  decisions/
    licensing-strategy.md
    workers-for-platforms-evaluation.md
    d1-vs-postgres.md                 (new — document the decision)
```

### 4. Add missing files

```
LICENSE                               (Apache-2.0, as planned)
TRADEMARKS.md                        (reserve the name)
.github/workflows/ci.yml             (basic typecheck + lint)
apps/api/vitest.config.ts            (for future tests)
```

### 5. Update .gitignore

Add:
```
# SQLite (from prototype)
*.db

# Local testing
*.local

# IDE
.idea/
.vscode/
```

### 6. Clean up README.md

The current root README is good but still references `files/` as a current artifact. After the cleanup, update it to only reference `apps/api` and `docs/`.

## Proposed final structure

```
todoless/
  .github/
    workflows/
      ci.yml
  _archive/
    express-prototype/          (moved from files/)
    README.md
  _research/
    chatgpt-initial-brainstorm.txt
    claude-initial-brainstorm.txt
    gemini-initial-brainstorm.txt
    prompt-used.txt
  apps/
    api/
      migrations/
      src/
      package.json
      wrangler.toml
      README.md
  claude/                        (this folder — my review)
  docs/
    strategy.md
    roadmap.md
    week-01-checklist.md
    decisions/
      licensing-strategy.md
      workers-for-platforms-evaluation.md
  .gitignore
  LICENSE
  README.md
  TRADEMARKS.md
```

This structure separates concerns cleanly:
- `apps/` = production code
- `docs/` = canonical strategy and planning
- `claude/` = my analysis and suggestions
- `_archive/` = historical artifacts
- `_research/` = brainstorm inputs
