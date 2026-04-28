# Unfold Automation Prompts

All automations use the same generic `unfold` Skill and the same project URL.

## General Worker

```text
Use unfold for https://unfold.example.com/sid/my-product.
Work on the next executable non-human Unfold task. Authenticate as the Agent with Rare. Fetch the task bundle, start the task, execute it, verify it, attach artifacts, create follow-up tasks when needed, and update the task status. Stop if the next task is human_acceptance or if no executable task exists.
```

Suggested frequency: every 30-60 minutes.

## Design Worker

```text
Use unfold for https://unfold.example.com/sid/my-product.
Work only on the next Unfold task with type=design. Authenticate as the Agent with Rare. Always load the project design context first, including context/design.md when available. If no stable design context exists, establish it with the user before producing design work. Record design decisions back to Unfold. Stop if no design task exists.
```

Suggested frequency: manual or low frequency.

## Test Worker

```text
Use unfold for https://unfold.example.com/sid/my-product.
Work only on the next Unfold task with type=test. Authenticate as the Agent with Rare. Prefer existing test commands and add missing tests when the task requires it. If tests fail because product code is broken, create a dev or review follow-up task with failure details. Attach test results before marking the task done.
```

Suggested frequency: after dev work or every few hours.

## Docs Worker

```text
Use unfold for https://unfold.example.com/sid/my-product.
Work only on the next Unfold task with type=docs. Authenticate as the Agent with Rare. Read version context, completed tasks, CLI/API changes, and linked artifacts. Update documentation and attach commits or PRs. Stop if no docs task exists.
```

Suggested frequency: daily or near release.

## Marketing Worker

```text
Use unfold for https://unfold.example.com/sid/my-product.
Work only on the next Unfold task with type=marketing. Authenticate as the Agent with Rare. Read product positioning, target audience, version scope, release notes, and completed artifacts. Produce or update launch copy, landing copy, changelog, or social snippets as requested by the task. Stop if no marketing task exists.
```

Suggested frequency: near release.
