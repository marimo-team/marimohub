# Documentation style

marimohub docs are operator-first. Write for someone evaluating, configuring,
deploying, operating, or troubleshooting a self-hosted notebook hub.

## Page types

Use one clear page type.

| Type        | Use for                               | Pattern                                      |
| ----------- | ------------------------------------- | -------------------------------------------- |
| Tutorial    | First success                         | Goal, prerequisites, steps, expected result  |
| How-to      | A specific operator task              | Task, config, command, validate, next link   |
| Reference   | Complete facts                        | Tables, defaults, generated content, anchors |
| Explanation | Why the system works the way it works | Concepts, trade-offs, links to references    |

Do not mix long explanation into a task page. Link to architecture or reference
material instead.

## Voice

- Prefer direct, present-tense sentences.
- Address the reader as "you" when giving instructions.
- Use active voice unless passive voice is clearer.
- Keep paragraphs short. Start with the point.
- Avoid "easy", "simple", "just", and similar words that can minimize operator
  effort.
- Avoid idioms and culture-specific phrases.
- Spell out acronyms on first use when they are not common in infrastructure
  docs.

## Examples

- Use `example.com`, `hub.example.com`, and `sandboxes.example.net` for sample
  domains.
- Use placeholders such as `<bucket-name>` when the reader must supply a value.
- Never include real tokens, cookies, keys, personal emails, or private hostnames.
- Mark secret values as secret and explain where to store them.

## Structure

- Keep existing URLs stable. Add redirects before renaming public docs pages.
- Put operator workflows in `docs/`.
- Put implementation rationale and internal design in `development_docs/`.
- Keep generated reference pages generated. For configuration docs, edit
  `packages/config/src/spec.ts` and run:

```bash
pnpm --filter @marimo-hub/config docs:generate
```

## Verification

For docs-only changes, run:

```bash
pnpm --filter @marimo-hub/docs test
pnpm --filter @marimo-hub/docs build
```

Before finishing, remove comments and prose that only narrate the change or
repeat what the surrounding heading, code, or command already says. Keep comments
that explain a maintenance rule, source of truth, or non-obvious constraint.
