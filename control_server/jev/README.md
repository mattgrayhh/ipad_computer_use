# Fast iPad workflows through MCP

## Local execution and native controls

Prefer `jev_run` for supported navigation. The Mac executes the complete loop,
so the calling agent receives one result instead of reviewing every keystroke.
With WebDriverAgent configured, the Slack workflow reads actual iPad accessibility
labels, roles, field values and identifiers. It sends only the relevant person
candidates to Jev, uses native controls for targeting, and verifies the resulting
conversation header in code. It skips OCR and relative-pointer calibration.

```json
{"workflow":"slack_open_conversation","query":"Exact Person Name"}
```

A visible one-to-one sidebar conversation is the shortest path. Otherwise it uses
the Slack conversation switcher, targets its native search field, and selects a
unique person result. This recipe targets the tested English Slack iPad layout
and exact ASCII person names, not arbitrary channel/group searches. New layouts or
ambiguous names may return `needs_reasoning`; inspect `get_ui` or `get_screen`.
The built-in workflow never types into the message composer or sends Return when
using native person-result selection. Existing drafts remain intact.

Known native facts (app identity, an empty search field, and the exact conversation
header) are checked in code. Jev supplies a focused Noul person-match judgment;
`minProbability` defaults to 0.85. This probability is not Choice confidence and
is not authorization. The caller must authorize the workflow's operations.

For other known keyboard workflows, use an explicit plan:

```json
{
  "workflow": "plan",
  "goal": "Search for the supplied term",
  "steps": [{
    "label": "Enter query",
    "when": "The intended search field is focused and empty",
    "actions": [{"type":"type_text","text":"example"}]
  }],
  "completion": "The intended search field visibly contains example"
}
```

Plans contain 1–12 stages with unique labels and literal keyboard actions. Jev
checks each stage's screen condition and a separate completion condition. Plans
do not infer text, pointer position or arbitrary coordinates. The default budget
is 30 seconds (`maxMs`, up to 60 seconds); it stops dispatching after the budget,
while an in-flight input operation or bounded screenshot request may finish later.
`jev_cancel` requests cancellation before the next operation. The MCP adapter
rejects competing input/screenshot calls while busy; status and cancellation remain
available. Separate clients using the raw control API are outside that MCP lock.
No failed/uncertain input is replayed. Repeated states, low probabilities, changed
observed device identity, stale evidence and errors return control to the caller.
The result includes a final screenshot, execution count and per-stage timings.

### Optional WebDriverAgent setup

This backend uses [Appium WebDriverAgent](https://github.com/appium/WebDriverAgent)
16.12.8, downloaded into the ignored `.state/wda` directory. It requires Xcode,
a paired iPad with Developer Mode, personal signing, and UI Automation approval
on the iPad. It does not replace or reinstall the screen-broadcast app.

```sh
export WDA_DEVICE_ID='YOUR_IPAD_UDID'
export WDA_BUNDLE_ID='com.yourname.WebDriverAgentRunner'
export DEVELOPMENT_TEAM='YOUR_TEAM_ID'
bash control_server/jev/wda_setup.sh
```

Keep that process running. Approve the iPad's **Enable UI Automation** Touch ID
prompt. If Xcode times out waiting, rerun the script after approval. Copy the
`ServerURLHere` address into `WDA_URL` in the ignored `control_server/.env`, and
restart MCP. This endpoint must belong to the same iPad as the broadcast. WDA has
no authentication: keep it on a trusted private network, never expose port 8100
publicly. Signing and automation authorization may need renewal after reboot or
provisioning expiry. The helper script also reads `ipad_app/.signing.env` when present.

`get_ui` returns compact native controls in **UIKit points**, not screenshot
pixels. Visibility is checked when acting; the cheaper tree snapshot can include
occluded elements. `ui_action` requires exactly one visible, enabled match:

```json
{"action":"activate","bundleId":"com.apple.Preferences"}
```

```json
{"action":"click","selector":{"identifier":"OBSERVED_IDENTIFIER","type":"Cell"}}
```

Use only identifiers or labels from a current observation. `type` narrows an
otherwise ambiguous selector. `action: "type"` appends literal Unicode to a native
editable field. Native operations have an 8-second request timeout and no replay.
A lost WDA session stops the operation; the next call can establish a new session.
Only one WDA session is active, so another Appium client can invalidate it.

Slack chooses native observations automatically when `WDA_URL` is set. Custom
plans use OCR unless `JEV_OBSERVATION=accessibility` is set. Without WDA, the
keyboard/OCR route and the existing reviewed mouse tools remain available.

### Physical measurements

On an iPad Air M3 with iPadOS 27 and WDA 16.12.8, three final trials started in
Settings, with Slack previously on a different conversation. A single `jev_run`
opened Slack, selected the requested visible DM, verified its exact native header,
and returned a fresh screenshot in **3.595, 3.630 and 3.653 seconds** (median 3.630).
Jev's single person-match request took 430–462 ms, with probabilities 0.96–0.97.
These are server-side workflow timings including capture, not a controlled
speedup comparison against the prior agent loop, and not an arbitrary-app benchmark.
The longer route from an empty Slack switcher through search, native result tap,
header verification and final screenshot also passed in 7.40 seconds while the
host was running regression tests. A five-image local OCR sample had medians of
164 ms for a separate process per image and 99 ms for the persistent worker;
these small samples are useful diagnostics, not distribution-wide guarantees.

Full accessibility snapshots with per-element visibility checks took 1.9–2.9
seconds during development. Omitting those expensive attributes reduced the
observations in the final trials to roughly 0.38–0.56 seconds. The selected
control is still checked for visibility and uniqueness before input. UI transitions
are re-observed without repeating actions or model requests on unchanged states.

Apple Vision now runs in a persistent, serialized worker instead of launching a
Swift process for every image. It retires after 60 seconds idle, bounds images and
queue size, and restarts cleanly after a failed image. Exact-image reuse in the
adviser remains; judgments are never cached. Rounded bounds and label-only Choice
criteria also reduce duplicate request data without replacing labels with opaque
index references.

## Screenshot adviser

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
with Node's built-in `fetch`; the OCR adviser needs no additional npm or Python dependencies.
Unlike the reference's Mac accessibility integration, this reads the **iPad's**
screenshot. The OCR adviser cannot infer native roles or keyboard focus; use the optional native backend above for those controls.

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
The measurements below are smoke tests, not comparative speed benchmarks.

A live API smoke test on a synthetic two-label screenshot with `jev-1.13.0`
selected Settings (confidence 0.99) and Privacy (0.98), and returned
`needs_reasoning` for an absent camera icon (0.94). Across those three calls,
Jev latency was 351–550 ms; full OCR took 202–213 ms after warm-up. One unchanged
image reused cached OCR. These small samples validate wiring, not general task
accuracy or physical-device speed.

On a connected iPad Air M3, native calibration hit all six verification targets
with a maximum error of 1.21 UIKit points. A live `jev_decide` call selected
"Edit Control Server" with confidence 0.97: capture 91 ms, OCR 172 ms, Jev
409 ms, total 672 ms. This verifies the physical screen-to-decision path;
agent review and input execution are additional steps. A physical Settings task
also reached Display & Brightness → Auto-Lock → Never and verified the selected
checkmark. Jev decisions for those rows took 751–847 ms including capture and OCR.
Long pointer moves required screenshot feedback and correction before clicking;
the saved calibration does not guarantee exact open-loop positioning. OCR labels
can also be noninteractive (for example, a disclosure label whose arrow is the
click target), so visual verification and fallback remain necessary.

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
