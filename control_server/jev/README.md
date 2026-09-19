# Jev fast decisions through MCP

`jev_decide` adds a TypeSafe fast path to the existing Codex/MCP workflow:

```text
iPad ReplayKit screenshot → local Apple Vision OCR → one Jev request
                                                        ↓
Codex ← screenshot + proposed action + confidence + timing
  ↓ verifies target and current pointer, or handles the visual fallback
existing issue_actions → calibrated USB input → iPad
```

The implementation follows the OCR + batched Choice pattern from
[awlevin/typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use).
It uses the current [TypeSafe HTTP API](https://docs.typesafe.ai/api.md) directly
with Node's built-in `fetch`; no additional npm or Python dependencies are needed.
Unlike the reference's Mac accessibility integration, this reads the **iPad's**
screenshot. It cannot inspect other iPad apps' accessibility trees or keyboard focus.

## Setup

Use a macOS control-server host with Xcode Command Line Tools, Node 20+, and the
existing calibrated iPad session. From the repository root:

```sh
npm ci
npm run jev:setup --workspace control_server
cp control_server/.env.example control_server/.env
```

Set `TYPESAFE_API_KEY` in the local `control_server/.env`, then start the MCP adapter
from the repository root:

```sh
node --env-file=control_server/.env control_server/mcp_server.js
```

The `--env-file` form needs Node 20.6+. Alternatively export `TYPESAFE_API_KEY` in
the server environment and run `npm run mcp --workspace control_server`. If an
adapter is already running, restart it with the key; `mcp:background` leaves an
existing process unchanged. The local env file is gitignored. Never put the key
in a tool argument or commit it.

Keep using the same MCP URL (`http://127.0.0.1:8780/mcp` by default). Reconnect
Codex's MCP connection to refresh the tool list. The control server and iPad
broadcast must also be running as described in the [main setup](../../README.md).
Setup compiles a small OCR helper under the ignored `.state/jev/` directory and
warms Apple's model using synthetic text. No host screen capture or Accessibility
permission is needed. Re-run setup after changing the helper's source.

## Use from Codex

Ask Codex: “Use `jev_decide` for the next text-labelled iPad action. Fall back to
your visual reasoning when it returns `needs_reasoning`.” The MCP initialization
instructions also describe this workflow.

Example tool arguments:

```json
{
  "goal": "Open Privacy & Security in Settings",
  "history": ["Opened Settings; its main list is visible"],
  "minConfidence": 0.7
}
```

For a field that needs known text, optionally pass
`"textCandidates": ["weather tomorrow", "weather this weekend"]`. Jev selects
from those exact strings. Codex supplies new text when composition is needed.
Typing inherits the hardware's ASCII/U.S. keyboard limitation. The returned
proposal doubles braces for the existing HID sequence codec; pass it unchanged.

Each response includes the source screenshot and one of:

- `proposed`: `proposal` is an `issue_actions` object. Verify the target and listed
  `requirements`. For a click, add `pointer: {x, y}` observed in the returned
  screenshot. Coordinates and OCR boxes use that image's pixel dimensions.
- `needs_reasoning`: there is no proposal. Continue with Codex's normal visual
  reasoning on the returned screenshot. Low confidence, no matching target,
  service errors, missing configuration, and stale frames all use this path.
- `done`: Jev judged the goal complete. Codex must check the visible evidence.

**This tool never executes input.** `issue_actions` retains the original session,
calibration and action validation. Obtain a new decision if the screen changes
before execution; a proposal is tied to its `frameID`, not a reusable command.
Include recent observed outcomes in `history`, especially ineffective actions.
There is no background agent or automatic replay.

## Calibration and pointer position

The first-time calibration described in the upstream README is still required.
Its saved profile maps relative USB mouse counts to movement on the screen. It
does **not** report where the pointer is now. This integration therefore preserves
the upstream requirement to observe the pointer before coordinate clicks. It
does not guess a center, assume a corner, or integrate movement indefinitely.
Tracking a known pointer between frames would be a separate optimization requiring
drift detection and recovery after manual movement, rotation, or session changes.

## Speed, limits, and privacy

The response reports `captureMs`, `ocrMs`, `jevMs`, and `totalMs`, plus TypeSafe
token usage and the resolved model. These cover the decision tool only; Codex
reasoning, tool transport, input execution and verification add latency. Measure
the same device tasks with and without Jev before claiming an end-to-end speedup.
No live Jev/device benchmark is bundled with this change.

A live API smoke test on a synthetic two-label screenshot with `jev-1.13.0`
selected Settings (confidence 0.99) and Privacy (0.98), and returned
`needs_reasoning` for an absent camera icon (0.94). Across those three calls,
Jev latency was 351–550 ms; full OCR took 202–213 ms after warm-up. One unchanged
image reused cached OCR. These small samples validate wiring, not general task
accuracy or physical-device speed.

- One request batches independent action, target and optional text questions.
  Only answers used by the selected action affect its confidence gate.
- Jev defaults to `jev-latest`; use `TYPESAFE_MODEL` to pin a tested version.
- OCR reuses its last result only when screenshot bytes match exactly. Screen
  capture and the Jev decision are always fresh; JPEG noise may prevent reuse.
- At most 254 text items are offered, plus an explicit no-match option. Truncation
  is reported. Oversized requests fall back rather than exceeding a conservative
  context budget. Icon-only controls and unclear focus need visual reasoning.
- OCR has a 10-second budget; Jev has a 5-second budget and no automatic retries.
  A response older than 15 seconds from receipt of its frame yields no proposal.
  The default confidence threshold, 0.7, is a starting setting to evaluate on your
  own tasks, not a calibrated correctness guarantee.
- Screenshots are sent only to the calling MCP agent. OCR text, goal, history,
  and supplied text choices are sent to TypeSafe. The helper does not save screen
  images or OCR to disk; its one-entry OCR cache lives in server memory.
- Other control-server hosts can still use all existing tools; local Jev OCR
  currently requires macOS and returns a fallback elsewhere.

## Verify

```sh
npm run jev:setup --workspace control_server
npm test
```

Tests cover HTTP request shape, batched decisions, confidence on the chosen branch,
invalid answers, literal text escaping, option limits, stale frames, exact-image
OCR caching, fallback behavior, and MCP read-only handoff. A native OCR test uses
synthetic labels and checks top-left coordinate conversion; it skips when the
helper has not been built or the host is not macOS. Live testing additionally
requires a TypeSafe key, a running control server, and connected hardware.
