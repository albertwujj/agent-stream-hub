# agent-stream-hub

A self-hosted relay and browser viewer for [AgentTerm](https://github.com/albertwujj/agent-term). See which agents need you across your machines, open their live terminal sessions, and reply from your phone or laptop.

<a name="run-locally"></a>
<a name="configuration"></a>
<a name="exposing-it-publicly"></a>

## Setting it up

Run the hub on a host that stays online. Clone the repository there, or clone locally and deploy remotely. Each machine running AgentTerm connects to the hub's URL; it does not need a hub clone.

Ask your agent:

```text
Deploy the repository below to <hub host>, following its docs/setup.md,
and connect my AgentTerm sessions to it.
https://github.com/albertwujj/agent-stream-hub
```

The [setup guide](docs/setup.md) covers hosting, authentication, connecting AgentTerm, and optional voice input.

## Using it

Open the hub's URL in your browser, or add it to your phone's home screen as a web app. You can type replies, operate terminal menus, and speak to the agent when voice input is configured. See [the phone guide](https://github.com/albertwujj/agent-term/blob/main/docs/phone.md) for examples.

## The mechanics

See the [streaming protocol](stream.md) for architecture, data, and endpoints; [voice input](voice.md) for transcription and delivery; and [voice interaction](voice-ux.md) for the phone's recording and review behavior.

See [Security](SECURITY.md) for access boundaries, data handling, and private vulnerability reports.

## Tests

```bash
node --test
```

Install FFmpeg to include the voice tests. CI runs the full suite, including voice decoding and security regression tests.

## License

[MIT](LICENSE).
