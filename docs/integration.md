# Cloudflare Agent integration

This document covers how to use the `@lanrenbang/chat-adapter-ilink` adapter inside a [Cloudflare Agent](https://developers.cloudflare.com/agents/) (Agents SDK). The adapter lives inside a single global Agent that owns the `Chat` instance. Login sessions use Sub-Agents for per-session state isolation and client-side `setState()` synchronization.

## Why Sub-Agents for login

Without Sub-Agents, the `setState()` state is shared across all WebSocket clients connected to the same Agent. If user A and user B both start login, they would see each other's QR codes, status, and session data — a security and UX problem.

Sub-Agents solve this by giving each login session its own:

- **Isolated SQLite storage** — each Sub-Agent's `this.sql` and `this.state` are fully separate
- **Isolated `setState()`** — only the WebSocket client connected to that Sub-Agent receives state updates
- **Direct client routing** — the frontend connects to the Sub-Agent at the correct URL

## How it works

The key insight: **the Sub-Agent's instance name is just a routing ID**, decoupled from the adapter's internal `sessionKey`. The frontend generates its own random ID (`subId`) and the Sub-Agent auto-creates via `onBeforeSubAgent` or custom routing. No HTTP response carries business data — QR code and sessionKey arrive via `setState()` push over WebSocket.

```
Browser                         MainAgent                        LoginSession(subId)
  │                                  │                                  │
  │── GET /login ──→                                                 │
  │←── static HTML (no dynamic data)                                  │
  │                                                                   │
  │── WebSocket {basePath}/sub/login-session/{subId} ────────────────→│
  │                                  │── [DO created, onStart fires]  │
  │                                  │←── RPC: parent.startLogin({    │
  │                                  │         subId })               │
  │                                  │── schedule(0, "runLogin", …)  │
  │                                                                   │
  │←── WebSocket connected,          │                                  │
  │    state synced                  │                                  │
  │                                  │── [alarm fires] runLogin()      │
  │                                  │   adapter.login({               │
  │                                  │     onStatusChange })           │
  │                                  │   1st cb: LoginResult           │
  │                                  │── RPC: onStatusUpdate(result)   │
  │←── setState(LoginResult) ────────│                                  │
  │   render QR code                 │                                  │
  │                                  │                                  │
  │                                  │   adapter login polling loop     │
  │                                  │   (callback-based)               │
  │                                  │── RPC: onStatusUpdate(result)   │
  │←── setState(LoginResult) ────────│                                  │
  │   update UI                      │                                  │
```

**Key design points:**

- **`subId`** (frontend-generated UUID) is the Sub-Agent's instance name — purely for WebSocket routing. It has no relationship to the adapter's `sessionKey`.
- **`sessionKey`** (adapter-internal) is opaque to the frontend. It arrives via `setState()` in the `LoginResult` payload.
- **`adapter.login({ onStatusChange })`** handles all polling internally. MainAgent's `schedule(0, "runLogin")` initiates it, and the callback pushes each status transition to LoginSession via RPC.
- **Cleanup** — stale Sub-Agents are cleaned up by a periodic task (24-hour interval), covering all scenarios (completed login, closed page, unexpected interruption).
- **`setState()` → WebSocket push** — the frontend receives state changes automatically, no polling or manual notification needed.
- **Custom routing** — clean URLs via a `fetch()` handler with `routeSubAgentRequest`.

## Worker entry point

The Worker uses custom routing with a `BASE_PATH` prefix. Sub-Agent requests (WebSocket) and BotAgent requests (HTTP) are dispatched manually:

```typescript
// Export ChatSdkStateAgent for createChatSdkState() sub-agent routing
export { ChatSdkStateAgent } from "agents/chat-sdk";

// BotAgent + LoginSession are discovered via ctx.exports (no DO binding needed for LoginSession)
export { BotAgent, LoginSession } from "./agents";

import { getAgentByName, routeSubAgentRequest } from "agents";

const BASE_PATH = "bot-agent";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Match paths under /{BASE_PATH}/
    const basePattern = new RegExp(`^/${BASE_PATH}(/.*)?$`);
    const baseMatch = path.match(basePattern);
    if (!baseMatch) {
      return new Response("Not found", { status: 404 });
    }

    const rest = baseMatch[1] ?? "";

    // Sub-Agent WebSocket routing: /{BASE_PATH}/sub/login-session/{uuid}
    if (rest.startsWith("/sub/")) {
      const parent = await getAgentByName(env.BotAgent, "default");
      return routeSubAgentRequest(request, parent, { fromPath: rest });
    }

    // BotAgent HTTP routing: /{BASE_PATH} or /{BASE_PATH}/login
    if (rest === "" || rest === "/" || rest === "/login") {
      const agent = getAgentByName(env.BotAgent, "default");
      return agent.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

## BotAgent — login orchestrator

The BotAgent owns the `Chat` instance and manages the login lifecycle. It receives login requests from Sub-Agents and runs them via `schedule(0)` to avoid blocking the caller.

```typescript
import { Agent } from "agents";
import { Chat } from "chat";
import { createILinkAdapter, type ILinkAdapter, type LoginResult } from "@lanrenbang/chat-adapter-ilink";
import { createChatSdkState } from "agents/chat-sdk";

export class BotAgent extends Agent<Env> {
  private chat!: Chat;
  private adapter!: ILinkAdapter;

  async onStart() {
    this.chat = new Chat({
      userName: "my-bot",
      adapters: { ilink: createILinkAdapter() },
      state: createChatSdkState(), // ← Sub-Agent backed storage
    });
    this.adapter = this.chat.getAdapter("ilink") as ILinkAdapter;

    // Must manually initialize for non-webhook adapters
    await this.chat.initialize();

    // Register event handlers
    this.chat.onNewMention(async (thread, message) => {
      await thread.subscribe();
      await thread.post({ text: `收到消息: ${message.text}` });
    });

    // Daily cleanup: remove stale Sub-Agents older than 24h
    await this.scheduleEvery(86400, "cleanupStaleSubAgents");
  }

  // HTTP entry — returns pure static HTML, no business data embedded
  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/login")) {
      return new Response(loginHtml, {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * Start a login session (called by LoginSession Sub-Agent).
   *
   * @param subId - LoginSession instance name
   * @param verifyCode - Optional pairing code for need_verifycode flow
   */
  async startLogin({ subId, verifyCode }: { subId: string; verifyCode?: string }) {
    await this.schedule(0, "runLogin", { subId, verifyCode });
  }

  // Alarm handler — runs the full login lifecycle
  async runLogin({ subId, verifyCode }: { subId: string; verifyCode?: string }) {
    const s = await this.subAgent(LoginSession, subId);

    await this.adapter.login({
      sessionKey: s.state.sessionKey,
      verifyCode,
      onStatusChange: async (result: LoginResult) => {
        await s.onStatusUpdate(result);

        // On need_verifycode: the frontend calls LoginSession.submitVerifyCode()
        // which triggers startLogin({ subId, verifyCode }) again.
        // Terminal states are handled by the 24h cleanup task.
      },
    });
  }

  // Periodic cleanup: delete Sub-Agents older than 24 hours
  async cleanupStaleSubAgents() {
    const cutoff = Date.now() - 86_400_000;
    const sessions = this.listSubAgents(LoginSession);
    for (const session of sessions) {
      if (session.createdAt < cutoff) {
        this.deleteSubAgent(LoginSession, session.name);
      }
    }
  }
}

const loginHtml = `<!DOCTYPE html>
<html><body><div id="root"></div>
<script type="module">
import { AgentClient } from "agents/client";
const subId = crypto.randomUUID();
// Your SPA uses subId with useAgent({ sub: [{ agent: "LoginSession", name: subId }] })
</script></body></html>`;
```

## LoginSession — per-session state container

The Sub-Agent acts as a dedicated state bridge: it receives RPC calls from the parent and pushes state to its WebSocket client. It also exposes a `@callable` method for verify code submission.

```typescript
import { Agent, callable } from "agents";
import type { LoginResult } from "@lanrenbang/chat-adapter-ilink";

export class LoginSession extends Agent<Env, Partial<LoginResult>> {
  initialState: Partial<LoginResult> = {};

  // Only fires on first Sub-Agent creation (not on WebSocket reconnect).
  // The sessionKey guard prevents duplicate login initiation.
  async onStart() {
    if (!this.state.sessionKey) {
      const parent = await this.parentAgent<BotAgent>(BotAgent);
      await parent.startLogin({ subId: this.name });
    }
  }

  // Called by BotAgent via RPC — push each status transition via setState()
  async onStatusUpdate(result: LoginResult) {
    this.setState(result);
  }

  /**
   * Submit a pairing/verify code (called by frontend via AgentClient RPC).
   *
   * When WeChat detects risk, the login flow enters need_verifycode state.
   * The frontend captures the code from the phone screen and calls this method.
   */
  @callable
  async submitVerifyCode({ verifyCode }: { verifyCode: string }) {
    if (!this.state.sessionKey) {
      throw new Error("No active login session for verify code");
    }
    const parent = await this.parentAgent<BotAgent>(BotAgent);
    await parent.startLogin({ subId: this.name, verifyCode });
  }
}
```

## Frontend — React

The frontend generates its own `subId`, connects to LoginSession via `useAgent({ sub })`, and renders based on the auto-synced state.

```tsx
import { useAgent } from "agents/react";
import { useState } from "react";

function LoginPage() {
  const [subId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState({});

  const agent = useAgent({
    agent: "BotAgent",
    name: "default",
    sub: [{ agent: "LoginSession", name: subId }],
    onStateUpdate: setState,
  });

  if (state.status === "wait" && state.qrcodeUrl) {
    return <img src={state.qrcodeUrl} alt="Scan with WeChat" />;
  }
  if (state.status === "scaned") return <div>Scan detected, waiting for confirmation...</div>;
  if (state.status === "confirmed") return <div>Connected</div>;
  if (state.status === "expired") return <div>Expired, refresh to retry</div>;
  if (state.status === "need_verifycode") return <VerifyCodeInput />;
  return <div>Connecting...</div>;
}

function VerifyCodeInput() {
  const [code, setCode] = useState("");
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      agent.call("submitVerifyCode", { verifyCode: code });
    }}>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter code from phone" />
      <button type="submit">Submit</button>
    </form>
  );
}
```

## Wrangler configuration

Only the top-level parent needs a DO binding. `LoginSession` is a facet-only child class and is discovered automatically via `ctx.exports`:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "BotAgent", "class_name": "BotAgent" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["BotAgent"] }
  ]
}
```

Note: `ChatSdkStateAgent` (from `agents/chat-sdk`) does not need a wrangler DO binding either — Agents SDK discovers it via the code export automatically.

## Verify code flow (pairing code)

When WeChat requires a verify code (`status === "need_verifycode"`):

1. The `adapter.login()` callback fires with `{ status: "need_verifycode", message, sessionKey }`
2. BotAgent's `runLogin` returns — the login loop pauses waiting for user input
3. Frontend renders a verify code input (see `VerifyCodeInput` component above)
4. User submits the code → `LoginSession.submitVerifyCode({ verifyCode })` is called
5. `submitVerifyCode` calls `parent.startLogin({ subId, verifyCode })` → `schedule(0, "runLogin", ...)`
6. `runLogin` calls `adapter.login({ sessionKey, verifyCode, onStatusChange })` with the session key and verify code
7. Login resumes from where it left off
