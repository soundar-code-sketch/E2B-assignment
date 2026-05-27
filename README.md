# E2B Integration Brief

## Part 1: Integration Brief - A short integration brief for moving an AI coding assistant from one Docker/ECS - one container per user session to E2B sandboxes.

# What Changes

The execution runtime layer moves from ECS/Docker to E2B sandboxes.

| Current ECS/Docker Flow        | E2B Equivalent                          |
| ------------------------------ | --------------------------------------- |
| Start ECS task/container       | `Sandbox.create({ timeoutMs })`         |
| container/task ID              | `sandboxId`                             |
| Reconnect to running container | `Sandbox.connect(sandboxId)`            |
| Execute commands in container  | `sandbox.commands.run(...)`             |
| Idle cleanup jobs              | `sandbox.setTimeout(...)`               |
| Stop container                 | `sandbox.kill()`                        |

## Updated Runtime Flow

* New conversation → create sandbox
* Follow-up turn → reconnect using `sandboxId`
* Execute generated code inside sandbox
* Stream stdout/stderr back to existing backend
* Extend idle timeout on activity
* Kill sandbox on inactivity or conversation end

---

# What Stays the Same

No need to rewrite the app flow.

The following remain unchanged:

* Auth and request authorization
* Frontend UX
* Conversation/session model
* Existing backend APIs
* LLM/code-generation flow
* Database and persistence layer
* Logging/observability conventions

This migration only replaces the execution runtime layer.

---

# Recommended Migration Approach

I would recommend to avoid a big cutover.

1. Implement E2B for select teams first
    
    The first proof should validate:( the major features you are looking for )

      * sandbox reuse across conversation turns
      * filesystem persistence within a session
      * isolation across conversations
      * stdout/stderr streaming
      * graceful handling of bad code/timeouts

2. Run ECS and E2B side-by-side behind a feature flag 

3. Compare:

   * cold start latency
   * execution failures
   * timeout behavior
   * streaming reliability
   * cleanup/leak rates

4. Gradually roll out by user 

5. Retire ECS lifecycle logic after ensuring development and  stabilize

---

# Questions Before Integration

1. What defines “session state” today?

   * files
   * installed packages
   * env vars
   * long-running processes

2. How are dependencies handled today?

   * prebuilt into Docker images
   * dynamically installed
   * allowlisted/restricted

3. What are the production constraints?

   * max concurrent sessions
   * execution timeouts
   * memory/CPU limits
   * network restrictions
   * audit/compliance requirements

The info on these will help me guide through the migration

---

# Dependency Handling in E2B

I would split dependencies into two layers:

| Dependency Type                          | Recommended Handling                 |
| ---------------------------------------- | ------------------------------------ |
| Common runtime packages                  | Prebuilt into E2B template           |
| Per-session/user packages                | Dynamically installed inside sandbox |

* Python → `pip` / `uv`
* JavaScript/TypeScript → `npm` / `pnpm` / `yarn`
* Preinstall `node`, `typescript`, and common runtime packages in the base template

For migration, I would first mirror the existing Docker image dependency set inside an E2B template before introducing dynamic installs.

## Part 2: Working Code - A TypeScript `SandboxSessionManager` that creates, reuses, executes in, and cleans up E2B sandboxes per conversation.

### Files

- `src/session-manager.ts`: reusable E2B session manager.
- `src/demo.ts`: simulated multi-turn conversation.
- `.env.example`: expected E2B API key format.

### Run It

```bash
npm install
cp .env.example .env
# edit .env and set E2B_API_KEY
npm run demo
```

The demo executes:

1. Python in a new `conv-1` sandbox.
2. Python again in `conv-1`, verifying the same sandbox and persisted files.
3. JavaScript in `conv-2`, verifying a separate sandbox.
4. Bad Python code, verifying the process returns a failed result instead of crashing.
5. Timeout and memory-failure cases, verifying structured error handling.
