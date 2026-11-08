# Testing Checklist

## What has and hasn't been tested

**Done during development (no hardware):**
- Firmware compiles for the ATmega32u4 (Leonardo) with avr-gcc 7.3, Arduino AVR core and the Servo library: ~14.7 KB flash of 28 KB, no warnings in the sketch.
- All JavaScript modules pass syntax checks.
- Unit tests of the pure logic: angle mapping (FOV, linear, two-point, invert, clamping), filters, dead zone, rate limit, settings validation, tracker (single entry event, short-gap tolerance, exit after absence, re-entry, debounce of flickers, no target switching), state-machine transition rules.
- The browser serial/servo code was exercised against a stand-in port that replies with the firmware's protocol: handshake, config push, wait-for-center, rate-limited and clamped `ANGLE` stream, silence after settling, emergency stop, disconnect.
- The full dashboard was loaded in headless Chrome with a synthetic camera feed (a photo of a person sliding across the frame) and the stand-in port: camera start, MediaPipe 0.10.21 loading with the GPU delegate, people being detected, state transitions and servo commands all ran without page errors. That environment only reached about 1 detection frame per second (software GPU), so it says nothing about smoothness or tuning, and an older pose model had to be substituted because the official model URL wasn't reachable from it.

**Not done — you need to do these:** nothing has been tested on a real Leonardo, shield, SG5010 or webcam, and the official pose model hasn't been run at a real frame rate. Work through the list below and tick each item yourself.

## Stage 1 — hardware communication
- [ ] Supply measured at 5–6 V on D9 V–G before connecting the servo (HARDWARE step 4)
- [ ] Firmware uploads; on power-up the servo moves to center and holds
- [ ] Arduino IDE Serial Monitor (115200, "Newline"): `HELLO` → `READY FW=1.0.0 …`; `ANGLE:45` moves the servo and prints `OK ANGLE=45.0`, `POS:` lines, `ARRIVED:45.0`
- [ ] `ANGLE:200` replies `OK ANGLE=170.0` (clamped to the default soft limit); `ANGLE:abc` → `ERR BAD_ANGLE`
- [ ] `STOP` → servo goes limp, `ANGLE:90` → `ERR STOPPED`; `RESUME` → holds again
- [ ] Close the Serial Monitor before using the web app

## Stage 2 — camera & MediaPipe
- [ ] Page opens at `http://localhost:8000`, camera permission prompt appears, live video shows
- [ ] MediaPipe chip shows `Pose lite · GPU` (or CPU)
- [ ] One person: skeleton + box + `#1` label + confidence; People = 1; Detect FPS ≥ 20
- [ ] Nobody in view: People = 0, no boxes (nothing invented)
- [ ] A poster/photo of a person is or isn't detected — note the result and adjust confidence
- [ ] Two people: two boxes, one cyan TARGET

## Stage 3 — servo tracking
- [ ] Connect Arduino → state goes `INITIALIZING` → `READY` → `SEARCHING`; servo goes to 90° before any tracking
- [ ] Walk left ↔ right slowly: servo follows smoothly, points at you (adjust Center/FOV/Invert per CALIBRATION)
- [ ] Stand still: servo settles without hunting
- [ ] Walk fast: follows without jerks (rate-limited)
- [ ] Each mapping mode behaves as documented
- [ ] Servo never goes beyond Min/Max (test by standing at both frame edges with Linear mode)
- [ ] Unplug USB while tracking: red "connection lost" warning, state `DISCONNECTED`, no errors piling up; replug + Connect recovers
- [ ] Emergency stop (button and Esc) stops motion instantly; Resume works; tracking stays off until Start tracking

## Stage 4 — audio events
- [ ] Upload MP3 → "Loaded: name (x.x s)"; Preview plays; volume and mute work
- [ ] Upload WAV works too; a non-audio file is rejected with a message
- [ ] Reload page: sound restored; audio chip says "Click page to enable" until you click
- [ ] Person enters → sound plays **once**, servo starts turning at the same moment
- [ ] Person stays 30 s → no repeats
- [ ] Brief occlusion (< absence interval) → no repeat
- [ ] Leave, wait > absence interval, re-enter → plays again (respecting cooldown)
- [ ] "Each new person": a second person entering triggers it; "Empty → occupied": it doesn't
- [ ] Sound disabled → never plays

## Stage 5 — dashboard & targets
- [ ] All five status chips show correct states through connect/disconnect
- [ ] Gauge needles: cyan = firmware angle, amber dashed = target
- [ ] Target modes: First (sticks with the first person), Closest to center (switches only after the hold time), Largest, Manual (click a box)
- [ ] When the target leaves, another visible person is picked
- [ ] Settings persist after reload; "Reset all settings" restores defaults

## Stage 6 — acceptance run (full system)
- [ ] Open site → connect Leonardo → servo centers at 90° → detection runs
- [ ] Person enters → sound once + servo turns to them
- [ ] Follows left/right smoothly and stably
- [ ] Person leaves → after ~3 s servo returns slowly to center
- [ ] Next person enters → sound again
- [ ] 30-minute soak test: no disconnects, no servo overheating (touch test), FPS stable
