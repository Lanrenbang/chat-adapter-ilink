# Cloudflare Agent integration

This document covers how to use the `@lanrenbang/chat-adapter-ilink` adapter inside a [Cloudflare Agent](https://developers.cloudflare.com/agents/) (Agents SDK). The adapter lives inside a single global Agent that owns the `Chat` instance. Login sessions use Sub-Agents for per-session state isolation and client-side `setState()` synchronization.

## Why Sub-Agents for login

Without Sub-Agents, the `setState()` state is shared across all WebSocket clients connected to the same Agent. If user A and user B both start login, they would see each other's QR codes, status, and session data — a security and UX problem.

Sub-Agents solve this by giving each login session its own:

- **Isolated SQLite storage** — each Sub-Agent's `this.sql` and `this.state` are fully separate
- **Isolated `setState()`** — only the WebSocket client connected to that Sub-Agent receives state updates
- **Direct client routing** — the frontend connects to the Sub-Agent at the correct URL

## How it works

The key insight: **the Sub-Agent's instance name is just a routing ID**, decoupled from the adapter's internal `sessionKey`. The frontend generates its own random ID (`subId`) and the backend auto-creates the Sub-Agent on first connection via `onBeforeSubAgent`. No HTTP response carries business data — QR code and sessionKey arrive via `setState()` push over WebSocket.

```
Browser                          MainAgent                        LoginSession(subId)
  │                                  │                                  │
  │── GET /login ──→                                                 │
  │←── static HTML (no dynamic data)                                  │
  │                                                                   │
  │── WebSocket /agents/main-agent/default/sub/login-session/{subId} ──→│
  │                                  │── onBeforeSubAgent ──────────→  │
  │                                  │   (auto-creates LoginSession)   │
  │                                  │   [onStart fires on first DO]   │
  │                                  │←── RPC: parent.startLogin(subId) │
  │                                  │── schedule(0, "runLogin", …)    │
  │                                  │←── allow ─────────────────────  │
  │←── WebSocket connected,          │                                  │
  │    state synced                  │                                  │
  │                                  │                                  │
  │                                  │── [alarm fires] runLogin()      │
  │                                  │   adapter.login({ onStatusChange })│
  │                                  │   1st cb: LoginResult            │
  │                                  │── RPC: onStatusUpdate(result)    │
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
- **`onBeforeSubAgent`** auto-creates LoginSession on the fly — no pre-registration or server-side session creation needed. `LoginSession.onStart()` fires once on first creation (not on WebSocket reconnect).
- **`adapter.login({ onStatusChange })`** handles all polling internally. MainAgent's `schedule(0, "runLogin")` initiates it, and the callback pushes each status transition to LoginSession via RPC.
- **Terminal cleanup** — on `confirmed`/`binded_redirect`/`expired`, a delayed `deleteSubAgent` removes the LoginSession's SQLite storage, preventing zombie Sub-Agent accumulation over time.
- **`setState()` → WebSocket push** — the frontend receives state changes automatically, no polling or manual notification needed.
- **Custom routing** (optional) — clean URLs like `/login` via a `fetch()` handler with `routeSubAgentRequest`.

## Worker entry point

```typescript
// Export ChatSdkStateAgent for createChatSdkState() sub-agent routing
export { ChatSdkStateAgent } from "agents/chat-sdk";

// MainAgent + LoginSession are discovered via ctx.exports (no DO binding needed for LoginSession)
export { MainAgent, LoginSession } from "./agents";

// Optional: custom HTTP routing for clean login URL
// import { getAgentByName, routeSubAgentRequest } from "agents";
//
// export default {
//   async fetch(request: Request, env: Env) {
//     const url = new URL(request.url);
//
//     // Serve the login page at a clean URL
//     if (url.pathname === "/login") {
//       const agent = await getAgentByName(env.MainAgent, "default");
//       return agent.fetch(request);
//     }
//
//     // routeSubAgentRequest parses fromPath, calls onBeforeSubAgent internally,
//     // and forwards the request to the Sub-Agent.
//     const subMatch = url.pathname.match(/^\/login\/([^/]+)(\/.*)$/);
//     if (subMatch) {
//       const [, subId, rest] = subMatch;
//       const parent = await getAgentByName(env.MainAgent, "default");
//       return routeSubAgentRequest(request, parent, {
//         fromPath: `/sub/login-session/${subId}${rest}`,
//       });
//     }
//
//     return new Response("Not found", { status: 404 });
//   },
// };
```

When using the custom routing approach above, `onBeforeSubAgent` is unnecessary because `routeSubAgentRequest` handles the sub-agent forwarding. If you prefer the simpler `routeAgentRequest` automatic routing instead, uncomment the `onBeforeSubAgent` hook in MainAgent below.

## MainAgent — login orchestrator

```typescript
import { Agent } from "agents";
import { Chat } from "chat";
import { createILinkAdapter, type ILinkAdapter, type LoginResult } from "@lanrenbang/chat-adapter-ilink";
import { createChatSdkState } from "agents/chat-sdk";

export class MainAgent extends Agent<Env> {
  private chat!: Chat;
  private adapter!: ILinkAdapter;

  onStart() {
    this.chat = new Chat({
      userName: "my-bot",
      adapters: { ilink: createILinkAdapter() },
      state: createChatSdkState(), // ← Sub-Agent backed storage
    });
    this.adapter = this.chat.getAdapter("ilink") as ILinkAdapter;
  }

  // HTTP entry — returns pure static HTML, no business data embedded
  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/login") return new Response("Not found", { status: 404 });
    return new Response(loginHtml, {
      headers: { "content-type": "text/html" },
    });
  }

  // 📌 Only needed when using default routeAgentRequest routing.
  // With custom routing (routeSubAgentRequest) this hook is skipped—
  // routeSubAgentRequest handles sub-agent forwarding automatically.
  //
  // override async onBeforeSubAgent(
  //   _request: Request,
  //   { className, name }: { className: string; name: string },
  // ) {
  //   if (className !== "LoginSession") return;
  //   if (!this.hasSubAgent(LoginSession, name)) {
  //     await this.subAgent(LoginSession, name);
  //   }
  // }

  // Called by LoginSession via parentAgent() RPC on first Sub-Agent creation
  async startLogin(subId: string) {
    // Schedule the alarm to keep the DO alive during the full login lifecycle.
    // Without schedule, a fire-and-forget promise may be suspended by DO hibernation.
    await this.schedule(0, "runLogin", { subId });
  }

  // Alarm handler — runs the full login lifecycle
  async runLogin({ subId }: { subId: string }) {
    // Directly start callback-based polling.
    // The callback receives a LoginResult on every status transition.
    // The first callback fires with status="wait", qrcodeUrl, and sessionKey
    // BEFORE entering the long-poll loop (see loginImpl in login.ts).
    //
    // For pairing code (need_verifycode): re-call adapter.login() with the
    // user-provided verifyCode + current sessionKey. See "Verify code flow"
    // in README.md for the complete pattern — omitted here for brevity.
    await this.adapter.login({
      onStatusChange: async (result: LoginResult) => {
        const s = await this.subAgent(LoginSession, subId);
        await s.onStatusUpdate(result);

        // Terminal states: Sub-Agent is no longer needed.
        // Schedule cleanup with a delay so the client has time to
        // receive the final setState() push over WebSocket.
        if (isTerminalLoginStatus(result.status)) {
          await this.schedule(10, "cleanupLoginSession", { subId });
        }
      },
    });
    // Login complete — adapter auto-registered the account on "confirmed"
  }

  // Delete a LoginSession Sub-Agent after login reaches a terminal state.
  // Without cleanup, zombie Sub-Agents (named by random UUID) accumulate
  // SQLite storage indefinitely — they are never reused.
  async cleanupLoginSession({ subId }: { subId: string }) {
    this.deleteSubAgent(LoginSession, subId);
  }
}

/** Login statuses after which the Sub-Agent is no longer useful. */
function isTerminalLoginStatus(status: string): boolean {
  return status === "confirmed" || status === "binded_redirect" || status === "expired";
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

The Sub-Agent acts as a dedicated state bridge: it receives RPC calls from the parent and pushes state to its WebSocket client. Its state type is the adapter's `LoginResult` — no custom type needed.

```typescript
import type { LoginResult } from "@lanrenbang/chat-adapter-ilink";

export class LoginSession extends Agent<Env, Partial<LoginResult>> {
  initialState: Partial<LoginResult> = {};

  // Only fires on first Sub-Agent creation (not on WebSocket reconnect
  // or DO rebuild after eviction). The sessionKey guard prevents
  // duplicate login initiation: once the first callback has fired,
  // sessionKey is set and onStart becomes a no-op.
  async onStart() {
    if (!this.state.sessionKey) {
      const parent = await this.parentAgent<MainAgent>(MainAgent);
      await parent.startLogin(this.name); // this.name === subId
    }
  }

  // Called by MainAgent via RPC — push each status transition.
  // The first call fires before the long-poll starts, immediately
  // delivering qrcodeUrl and sessionKey for QR rendering.
  // result is a LoginResult (status, qrcodeUrl, sessionKey, message).
  async onStatusUpdate(result: LoginResult) {
    this.setState(result);
  }
}
```

## Frontend — React

The frontend generates its own `subId`, connects to LoginSession via `useAgent({ sub })`, and renders based on the auto-synced state.

```tsx
import { useAgent } from "agents/react";
import { useState } from "react";

function LoginPage() {
  // subId is purely for routing — unrelated to adapter's sessionKey
  const [subId] = useState(() => crypto.randomUUID());
  const [state, setState] = useState({});

  // Connect to LoginSession Sub-Agent via sub-routing
  // The WebSocket URL becomes:
  //   /agents/main-agent/default/sub/login-session/{subId}
  const agent = useAgent({
    agent: "MainAgent",
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
```

## Wrangler configuration

Only the top-level parent needs a DO binding. `LoginSession` is a facet-only child class and is discovered automatically via `ctx.exports`:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "MainAgent", "class_name": "MainAgent" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MainAgent"] }
  ]
}
```

## Verify code flow (pairing code)

When WeChat requests a verify code (`need_verifycode`), the user needs to provide it. The callback-based `adapter.login()` resolves on `need_verifycode` (not just confirmed/expired). Your application then:

1. Frontend renders a verify code input
2. User submits code → calls a MainAgent RPC method
3. MainAgent calls `adapter.login({ sessionKey, verifyCode })` (single-shot) to submit the code
4. Resumes callback-based polling with `adapter.login({ sessionKey, onStatusChange })`
