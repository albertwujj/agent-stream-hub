# Security

## Reporting a vulnerability

Report vulnerabilities through [GitHub's private form](https://github.com/albertwujj/agent-stream-hub/security/advisories/new); keep details out of public issues. Include the affected commit, the potential impact, and steps to reproduce the issue. Do not include live hub secrets, run IDs, or terminal contents.

## Supported version

Fixes land on `main`, the only supported version. Update your deployed checkout and restart the hub to pick up fixes. Keep Node.js on a supported LTS release and keep optional FFmpeg and whisper-server installations updated; these tools are managed outside npm.

## Access and data

The hub relays terminal contents, first prompts, machine names, and replies. Anyone with the viewer secret can read every session and send input to its terminal. Use a dedicated hub for people and machines you trust together; there are no separate users or per-session permissions.

- Bind the hub to loopback behind an HTTPS tunnel or reverse proxy. Set a strong, random `STREAM_HUB_SECRET` before exposing it. Configured secrets apply to viewer endpoints even on loopback; proxy headers do not grant an authentication bypass.
- Source registration, snapshots, and heartbeats remain open so source machines do not need the viewer secret. A run ID acts as a capability: knowing it allows publishing to that run and draining its queued replies through heartbeat. Keep run IDs and request paths out of public logs. An anonymous client can also create new runs; apply appropriate access and rate limits at the proxy for your deployment.
- Terminal data and queued replies are held in memory and disappear on restart. Retention and input limits reduce resource exhaustion; they do not make this a service for untrusted tenants. See [the protocol limits](stream.md#resource-limits).
- The viewer stores the secret in browser `localStorage`. Protect that browser profile and clear its site data when you stop using it on a shared device. Enter secrets in the viewer prompt; optional seed links use a URL fragment (`#s=...`), never a query parameter that proxies can log.
- Optional voice input writes audio to a private temporary directory, decodes it with FFmpeg, and sends the decoded audio to `WHISPER_URL`. Use a trusted transcription service, preferably on loopback. Temporary audio is removed after processing; a process or machine crash can leave files for the host administrator to clean up.

Secret scanning, CodeQL, and dependency alerts provide automated checks. Dependency malware alerts cover known malicious packages in supported dependency ecosystems; they do not scan the deployed host, FFmpeg, whisper-server, or arbitrary downloaded code.
