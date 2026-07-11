# agent-stream-hub

Streaming bridge that lets you peek at AI-CLI sessions running in
[`agent-term`](https://github.com/albertwujj/agent-term) instances from a browser or
installed PWA — even when the machine running the session can only make outbound
HTTPS.

A source pushes terminal-viewport snapshots to the hub; the hub keeps a short
in-memory history per run and serves a viewer SPA that stitches snapshots into a
continuous, live-updating view. Schema-agnostic relay, ~300 LOC.

- **[stream.md](stream.md)** — design, data model, endpoints, auth, roadmap.
- **[voice.md](voice.md)** — voice input: transcription on the hub, `/voice` API,
  injection contract, gate. Phone-side states: [voice-ux.md](voice-ux.md). The
  agent-facing guide lives in [voice-to-agent](https://github.com/albertwujj/voice-to-agent).

## Run locally

Requires Node 20+.

```bash
node server.js
# [hub] listening on http://127.0.0.1:9000

# in another shell:
curl http://127.0.0.1:9000/         # viewer SPA
curl http://127.0.0.1:9000/runs     # list runs (JSON)
```

The hub binds to `127.0.0.1` only and keeps all state in memory.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `9000` | Listen port (always bound to `127.0.0.1`). |
| `STREAM_HUB_SECRET` | unset | If set, tunneled reads + destructive writes require a matching `X-Hub-Secret`. If unset, the hub is fully open (dev/local). |

Source POSTs (`/runs`, `/snapshot`, `/heartbeat`) are always auth-open so
locked-down source machines need no shared secret. See
[stream.md](stream.md) for the full auth model.

## Exposing it publicly

The hub listens on loopback and is unaware of how it's reached — put any HTTPS
reverse proxy in front of `127.0.0.1:9000`. A Cloudflare named tunnel, an SSH
reverse tunnel, Tailscale, or an nginx/caddy origin all work. Prefer something
that gives a **stable** public URL, and run it under a supervisor that starts at
boot (systemd / a launchd LaunchDaemon) so it survives a headless reboot.

## Tests

```bash
node --test
```
