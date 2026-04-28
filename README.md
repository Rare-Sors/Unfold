# Unfold Agent-Native MVP

Unfold is a lightweight, cloud-hosted, agent-native task board for personal product development. Humans create project shells, observe progress, and approve versions. Agents authenticate with Rare, use the `unfold` CLI, execute tasks through Codex automation, and write status and artifacts back to Unfold.

## Run Locally

```bash
npm install
npm run db:migrate:local
npm run dev
```

## Verify

```bash
npm test
npm run typecheck
```

## Key Boundaries

- Humans use email/password Web sessions.
- Agents use Rare public-only sessions and project-scoped capabilities.
- Web does not create, edit, reorder, or close normal tasks.
- Agents cannot close `human_acceptance`.
- Codex automation runs outside Unfold.
