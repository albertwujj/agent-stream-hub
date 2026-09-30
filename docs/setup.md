# Set up agent-stream-hub

The hub runs on a host that stays online. It can be separate from every machine running AgentTerm. Clone this repository directly on that host, or clone it locally and deploy the files there; the commands below run on the hub host.

## Run locally

Requires Node.js 20 or later. There are no npm dependencies to install. From the repository root:

```bash
node server.js
# [hub] listening on http://127.0.0.1:9000
```

Open `http://127.0.0.1:9000/` on the hub host for the viewer. In another shell:

```bash
curl http://127.0.0.1:9000/runs
```

The hub binds to `127.0.0.1` only. All session state and snapshot history are kept in memory and lost when the hub restarts.

## Exposing it publicly

Give the hub a stable HTTPS URL that forwards to `127.0.0.1:9000`. A Cloudflare named tunnel is the existing deployment path. Machines running AgentTerm only need outbound HTTPS access to that URL; they do not need inbound ports.

Set `STREAM_HUB_SECRET` in the hub process's environment before exposing it. The viewer asks for this secret and stores it in the browser. With the secret unset, the hub performs no authentication.

The built-in authentication check relies on the `CF-Connecting-IP` header supplied by Cloudflare. If you use another reverse proxy, configure it to set this header on every forwarded request, overwriting any client-supplied value. Requests without it bypass the secret check, as they are treated as local debugging requests. Keep the hub bound to loopback behind the proxy.

Source registration, snapshot, and heartbeat POSTs remain open by design; the secret gates viewer reads, replies, voice input, and deletions. See the [authentication model](../stream.md#auth-model) for the endpoint rules. Before connecting sessions, verify that the public `/runs` endpoint returns `401` without `X-Hub-Secret` and `200` with the matching secret.

Run the hub and tunnel or proxy under a service manager, such as systemd or a launchd LaunchDaemon, so they start at boot and recover after a headless reboot. Put the environment variables in that service's configuration.

## Connect AgentTerm

On each machine running AgentTerm, add `hubUrl` to `~/.agent-term/config.json`, preserving any other settings:

```json
{
  "hubUrl": "https://your-hub.example.com"
}
```

On Windows, this file is inside the WSL distro's home directory. Open a new AgentTerm window after changing it. Streaming starts with the first prompt submitted to the agent; shell activity before that prompt is not streamed.

The terminal only needs the URL, not a hub clone or the hub secret. Plain HTTP is accepted only for a local address such as `http://127.0.0.1:9000`; remote URLs must use HTTPS.

## Open the viewer

Open the hub's HTTPS URL on your phone or laptop and enter the hub secret when asked. You can add the page to your phone's home screen as a web app. Sessions continue running on their original machines; those machines must stay online to stream and receive replies.

See AgentTerm's [phone guide](https://github.com/albertwujj/agent-term/blob/main/docs/phone.md) for using the viewer.

## Optional voice input

Viewing and typed replies work without voice setup. To enable voice:

1. Make `ffmpeg` available on the hub service's `PATH`.
2. Run a resident `whisper-server` as described in [voice input](../voice.md), and set the hub's `WHISPER_URL` to its inference endpoint, for example `http://127.0.0.1:8091/inference`.
3. On each machine running AgentTerm, install [voice-to-agent](https://github.com/albertwujj/voice-to-agent) following its README. Its guide tells the agent how to interpret transcription errors using the session context.

## Configuration

These environment variables belong to the hub process, on the hub host:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `9000` | Listen port; always bound to `127.0.0.1`. |
| `STREAM_HUB_SECRET` | unset | Shared secret for proxied viewer requests under the authentication rules above. Unset disables authentication. |
| `WHISPER_URL` | unset | The whisper-server inference endpoint. Unset disables voice transcription. |

[Back to the README](../README.md).
