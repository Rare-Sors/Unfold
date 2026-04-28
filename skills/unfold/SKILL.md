---
name: unfold
description: Use when the user says "Use unfold for <board-url>" or asks Codex to operate an Unfold project board.
---

# Unfold Skill

Unfold is an agent-native task board. The human observes and approves versions in Web. The Agent uses the `unfold` CLI with a Rare identity to plan and execute work.

## Runtime Input

The user provides a board URL:

```text
Use unfold for https://unfold.example.com/sid/my-product
```

## Workflow

1. Ensure the `unfold` CLI is available.
2. Run `unfold project resolve <board-url>` and confirm the project slug.
3. Run `unfold rare status`.
4. If no Rare identity exists, tell the user:

   ```text
   Read https://www.rareid.cc/skill.md and follow the instructions to register Rare.
   ```

5. Authenticate with Unfold:

   ```bash
   unfold rare login <board-url>
   ```

6. Initialize the local project context when needed:

   ```bash
   unfold project init <board-url>
   ```

7. If no active version exists, brainstorm with the user and create version context, areas, functions, tasks, dependencies, and acceptance criteria through the CLI.
8. Fetch the next executable task bundle:

   ```bash
   unfold task next <board-url> --bundle --format yaml
   ```

9. Start the task before changing files:

   ```bash
   unfold task start <task-id>
   ```

10. Execute the work in the linked repository, reading only task bundle context unless more context is needed.
11. Run relevant verification.
12. Attach artifacts before closing the task:

   ```bash
   unfold task attach <task-id> --kind commit --external-id <sha> --url <commit-url>
   unfold task done <task-id> --tests "<test command>"
   ```

13. Create follow-up tasks when test, docs, ops, marketing, or review work remains.
14. Stop when the next task is `human_acceptance` or no executable task exists.

## Design Tasks

Design tasks must load `context/design.md` or the equivalent stable design context block before producing UI work. If no stable design context exists, establish it with the user before continuing.

## Boundaries

- Do not close `human_acceptance`; only the human can approve or request changes.
- Do not create project-specific Skills. The board URL selects the project.
- Do not run Agents inside Unfold. Codex automation executes externally and writes status back through CLI/API.
