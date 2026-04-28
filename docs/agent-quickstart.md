# Unfold Agent Quickstart

## Human Setup

1. Start the Worker locally:

   ```bash
   npm run dev
   ```

2. Sign up in Web or through API.
3. Create a project shell.
4. Bind the Agent Rare public key to the project.

## Agent Setup

If the Agent does not have a Rare identity, register first:

```text
Read https://www.rareid.cc/skill.md and follow the instructions to register Rare.
```

Then authenticate:

```bash
unfold rare login http://localhost:8787/sid/my-product --agent-id ed25519-public-key
```

Initialize local context files and sync them as stable context blocks:

```bash
unfold project init http://localhost:8787/sid/my-product
```

Fetch work:

```bash
unfold task next http://localhost:8787/sid/my-product --bundle --format yaml
```

Start, execute, attach artifacts, and close:

```bash
unfold task start TASK_ID
unfold task attach TASK_ID --kind commit --external-id abc123 --url https://github.com/sid/my-product/commit/abc123
unfold task done TASK_ID --tests "npm test"
```

## Human Acceptance

When validation passes, Unfold creates or activates a `human_acceptance` task. The Agent must stop. The human approves or requests changes in Web.
