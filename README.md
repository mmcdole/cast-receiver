# cast-receiver

A Google Cast Web Receiver for a self-hosted media server. It is a static
page: GitHub Pages serves this repository's `main` branch as it is, with no
build. It holds no server address and no secret; each cast names its server.

## What it does

A sender's LOAD names the work, the server (its ID and the addresses to try)
and a short-lived cast token. The receiver picks the address that answers as
that server, measures what the device decodes, starts the play itself as the
token's user, and plays it. It sends the play's heartbeats, falls back once
when playback fails, starts a new play for a track, quality or boost change,
and runs up next, so a cast goes on when the phone that started it is gone.
The token goes only in the `Authorization` header; it never appears in a URL,
a log or the media status senders read.

## Files

- `index.html`, `receiver.css`: the page and its screens.
- `src/main.js`: starts the framework, with the debug log when asked.
- `src/receiver.js`: loads, plays, heartbeats, track changes, up next, errors.
- `src/api.js`, `src/capabilities.js`, `src/upnext.js`, `src/status.js`,
  `src/format.js`, `src/log.js`, `src/ui.js`, `src/config.js`: the parts.
- `test/`: the logic, under a stand-in for the Cast framework.

The page uses only relative URLs, so it works at any path on any host.

## Debugging

Add `?debug` to the receiver URL (on a registered test device, in the Cast
developer console) to log to the console, Google's CastDebugLogger and
senders on the debug namespace. Tokens and play IDs are left out.

## Tests

```sh
npm test
```

Node 20 or later; no dependencies.
