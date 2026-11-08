# Human Tracker — Arduino Leonardo + MediaPipe + SG5010 servo

A browser dashboard detects people in your webcam feed with Google MediaPipe Pose Landmarker and drives a physical TowerPro SG5010 servo (via an Arduino Leonardo and DFRobot IO Expansion Shield) so it points at and follows the selected person. A custom sound plays once when someone enters.

```
human-tracker/
├── firmware/HumanTracker/HumanTracker.ino   Leonardo firmware (Servo + EEPROM libraries)
├── web/
│   ├── index.html                            Dashboard (GENERATED single file — works by double-click)
│   ├── src.html                              Dashboard source markup
│   ├── media/presence.mp4                    built-in sound (looped while someone is in view)
│   ├── css/styles.css
│   └── js/
│       ├── main.js          app wiring, UI, state/motion planning loop
│       ├── serial.js        Web Serial transport (handshake, queue, heartbeat, cleanup)
│       ├── servo.js         firmware protocol + rate-limited, throttled ANGLE commands
│       ├── detector.js      MediaPipe Pose Landmarker (GPU→CPU fallback), tracking point
│       ├── tracker.js       persistent IDs, entry debounce, exits, target selection
│       ├── mapping.js       x→angle mapping (FOV / linear / two-point), filters
│       ├── audio.js         MP3/WAV upload, playback, autoplay unlock, IndexedDB storage
│       ├── stateMachine.js  DISCONNECTED … STOPPED transition table
│       ├── camera.js        webcam + device selection
│       ├── overlay.js       skeleton/box/marker drawing (camera preview in Settings)
│       ├── scene.js         the street scene: perspective walls/road, crowd, bell-ringer, webcam cut-out
│       └── settings.js      defaults, validation, persistence
├── docs/  HARDWARE.md · CALIBRATION.md · PROTOCOL.md · TROUBLESHOOTING.md · TESTING.md
├── tools/build-standalone.mjs              rebuilds web/index.html after editing js/ or src.html (`node tools/build-standalone.mjs`)
├── start-server.sh / start-server.bat
```

## Requirements

- **Browser:** desktop **Google Chrome, Microsoft Edge or Opera, version 89 or newer**. Web Serial is not available in Firefox, Safari, or mobile browsers. Open `web/index.html` directly, or serve it from `http://localhost`.
- **Internet on first load:** the MediaPipe library (`cdn.jsdelivr.net`, pinned to `@mediapipe/tasks-vision@0.10.21`) and pose model (`storage.googleapis.com`) are downloaded by the browser.
- **Python 3** (or Node.js) to run a tiny local web server.
- **Arduino IDE 2.x** (or arduino-cli) to upload the firmware.
- Hardware: see `docs/HARDWARE.md`, **including the external 5–6 V servo supply**.

## Installation

### 1. Wire the hardware
Follow **`docs/HARDWARE.md`**: servo on shield pin **D9**, servo powered from an external regulated 5–6 V (≥ 2 A) supply, common ground, and the safe power-up order. Never power the servo from USB.

### 2. Upload the firmware
1. Open `firmware/HumanTracker/HumanTracker.ino` in the Arduino IDE.
2. **Tools → Board → Arduino AVR Boards → Arduino Leonardo**; **Tools → Port →** the Leonardo's port.
3. Click **Upload**. (Servo and EEPROM libraries are built in.) Keep the servo supply off during the first upload.
4. Optional check: Serial Monitor at 115200 baud with "Newline", type `HELLO` → you should see `READY FW=1.0.0 …`. **Close the Serial Monitor afterwards**, or the browser can't open the port.

### 3. Run the web app
**Easiest:** double-click `web/index.html` — it opens in your default browser (make it Chrome or Edge). It's a single self-contained file, so it works straight from disk.

Alternatively, serve it locally from the project folder:

```bash
# macOS / Linux
./start-server.sh          # or:  cd web && python3 -m http.server 8000
```
```bat
:: Windows
start-server.bat           :: or:  cd web  &&  py -m http.server 8000
```
Then open **http://localhost:8000** in Chrome or Edge.

(Node alternative: `npx serve web -l 8000`.)

## The scene

The page opens full-screen on an original medieval street: stone buildings, a cobbled road, a crowd lining both sides and a town crier with a brass hand bell in the left foreground.

- **When a person walks into the camera's view** (after the entry debounce), your sound starts and **loops for as long as someone is in view**, then fades out after everyone has left (absence interval + fade-out). The crier raises her bell and rings it in time with the bell hits detected in the sound, and the crowd jeers on the voice parts.
- **You appear in the street:** MediaPipe's segmentation mask cuts you out of the webcam image and places you on the road; your left/right position and distance follow your movement. Turn this off with *Show me in the scene* in Settings.
- **Click once** on the "Click anywhere to begin" screen when the page opens — browsers only allow sound after a click.
- **Settings** are behind the **gear button in the top-left corner** (the dot on it: green = Arduino connected, amber = not connected, red = emergency stop). Close the window with ✕, by clicking outside it, or with **Esc**. With settings closed, **Esc = emergency stop**.
- The built-in sound is `web/media/presence.mp4` (embedded into `index.html` by the build). Use *Replace sound…* in Settings → Audio to use another MP3/WAV; *Restore built-in sound* goes back.
- After the Arduino has been connected once, the page reconnects to it automatically on the next visit and when it is plugged back in.

## Using it

1. The dashboard opens and asks for **camera permission** → allow. The live feed appears and MediaPipe loads (chips at the top show status).
2. Click **Connect Arduino**, pick the *Arduino Leonardo* port.
3. The app verifies the firmware (`HELLO`/`READY`), pushes calibration, moves the servo to **90°** and waits for it to arrive. Only then does tracking start (state: `INITIALIZING` → `READY` → `SEARCHING`).
4. **Upload your sound** (MP3/WAV) in the Audio panel. It's remembered in the browser. Click anywhere once after loading the page so the browser allows audio.
5. Walk into view: after a short debounce the person is confirmed, the sound plays once, and the servo turns toward them (`PERSON_DETECTED` → `TRACKING`).
6. Walk out: after the absence interval and a 3 s no-person timeout, the servo slowly returns to center (`SEARCHING`).

**Before real use, calibrate** (`docs/CALIBRATION.md`): safe limits, center, direction, camera FOV — or two-point calibration if the servo isn't next to the camera.

### Controls
- **Start / Stop tracking**, **Reset to center**, **EMERGENCY STOP** (also the **Esc** key) — E-stop detaches the servo signal in firmware and blocks all motion until **Resume**.
- Moving the **manual slider** or pressing **Center** turns auto tracking off so manual and automatic control never fight; press **Start tracking** to resume.
- **Target selection:** first detected (default), closest to center, largest/nearest, or manual (click a box on the video).
- **Sound trigger:** each new person, or only when the frame goes from empty to occupied; with cooldown.

## How it works (short)

`camera → MediaPipe Pose (≤ 5 people) → torso-center tracking point → tracker (IDs, debounce, exits) → target selection with hysteresis → low-pass filter → x→angle mapping → dead zone → browser rate limit (°/s) → throttled ANGLE:<deg> over Web Serial → firmware clamp + non-blocking slew → servo`.

Safety layers: soft limits enforced in the browser **and** firmware (plus hard 0–180° bounds in firmware), emergency stop latched in firmware, heartbeat with 3.5 s timeout, automatic stop of all commands on disconnect, and no motion before initialization completes.

## Honest limitations
- **Not yet tested on real hardware.** The firmware compiles for the Leonardo and the browser logic is unit-tested, but the full system hasn't been run with a real Leonardo, shield, SG5010 and webcam. Use `docs/TESTING.md` to verify each stage.
- A hobby servo has **no position feedback**; displayed "firmware angle" is the commanded angle.
- The camera must be **stationary**. With a separately mounted servo, aiming is exact only near the calibration distance (parallax — see CALIBRATION).
- MediaPipe Pose provides no identity; IDs come from position continuity and can swap when people cross.
- Browsers throttle hidden tabs; keep the dashboard visible.
