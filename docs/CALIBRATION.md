# Calibration

Do these steps in order, with **Auto tracking off** (the manual slider and Go-to buttons switch it off automatically). Keep a hand near **EMERGENCY STOP** (or the **Esc** key) the first time.

## 1. Find the servo's real end stops (safe limits)

The defaults (10°–170°, pulse 600–2400 µs) are deliberately conservative because SG5010 data sheets disagree about pulse range.

1. Connect, let the servo center.
2. Open **Calibration & motion**. Drag the **Manual position** slider slowly toward the minimum.
3. Listen and watch: if the servo **buzzes, hums continuously or stops moving** before the slider does, you have reached the mechanical end stop. Back off immediately. Holding a servo against its stop overheats it.
4. Set **Min angle** a few degrees inside the last angle that moved freely. Repeat for **Max angle**.
5. If you want more travel and the servo never buzzed at 10°/170°, you may widen the pulse range in small steps (e.g. 600 → 550 µs, 2400 → 2450 µs), re-test, and stop at the first sign of buzzing. Don't go outside about 500–2500 µs.
6. Press **Save calibration to Arduino EEPROM** so the firmware uses the same limits from power-up.

The browser and the firmware both clamp every command to these limits, so the servo is never commanded outside them.

## 2. Set the center angle

Center is the "home" angle the servo goes to on connect and when nobody is in view. Drive the servo with the slider until it points **straight along the camera's view direction**, and type that value into **Center**. 90° is the default; mounting rarely makes it exact.

## 3. Set the direction

Stand at the **left edge of the on-screen image** with tracking on. If the servo turns **away** from you, tick **Invert direction**.

Note: **Mirror** (selfie view) flips the picture and the coordinates the tracker uses, so after changing Mirror, re-check the direction.

## 4. Choose a mapping mode

### Camera FOV (default) — servo pivot at the camera
Converts the person's pixel offset into a true bearing using the camera's **horizontal field of view**:

`angle = center ± atan(offset × tan(FOV/2))`

- Find your webcam's horizontal FOV in its spec sheet. Typical values: 55–65° for laptop cameras, ~70–78° for many USB webcams (often quoted as a *diagonal* FOV — horizontal is smaller).
- **To measure it:** stand 2 m from the camera and mark where the left and right edges of the image fall on the wall. With `W` = distance between the marks and `D` = camera-to-wall distance: `FOV = 2 × atan(W / (2D))`.
- Check: stand at the image's left edge. The pointer should point at you. If it undershoots, increase FOV (or **sensitivity**); if it overshoots, decrease.

### Linear — frame edges map to the limits
Left edge → Min angle, center → Center, right edge → Max angle. This matches the "0° / 90° / 180°" example and is useful for an effect where the servo sweeps the full range across the frame, but **it does not point at people accurately** unless your FOV happens to equal the servo range.

### Two-point — camera and servo mounted apart
Use this when the servo is not at the camera.

**Why simple screen mapping is limited here:** the camera only sees *direction from the camera*, not distance. When the servo is offset from the camera (say 50 cm to the side), a person at 1 m and a person at 4 m can appear at the same pixel but require different servo angles (parallax). No single mapping is correct at all distances. Two-point calibration is exact at the distance you calibrate at and reasonably close nearby; the error grows the more the servo–camera offset is large relative to the person's distance.

Procedure:
1. Turn **Auto tracking off**. Choose the distance where people usually stand (e.g. 2 m from the camera).
2. Stand near the **left** part of the image (about 20% in from the edge) so you're detected (the box turns cyan = target).
3. Use the **Manual position** slider to aim the pointer at your chest. Click **Record A**.
4. Move to the **right** part of the image (about 80%), aim again, click **Record B**.
5. Mapping switches to **Two-point** automatically. Turn tracking back on and walk across. **Sensitivity** scales around the center angle if you need fine-tuning. Two-point already encodes direction; the Invert toggle has no effect in this mode.

Tips: mount the servo as close to the camera as practical, ideally vertically above or below it. Even a 10–20 cm offset is negligible beyond ~2 m.

## 5. Tune the motion

| Setting | Effect | Start at |
|---|---|---|
| **Low-pass smoothing (s)** | Time constant of the filter on the person's position. Higher = calmer but laggier. | 0.25 s |
| **Dead zone (°)** | The target angle must change by more than this before the servo moves. Stops hunting when someone stands still. | 2° |
| **Tracking speed (°/s)** | Max speed when following. | 90 °/s |
| **Return speed (°/s)** | Speed of the slow return to center. | 20 °/s |
| **Command interval (ms)** | Minimum gap between serial commands. | 50 ms (20 Hz) |
| **Min step to send (°)** | Smaller changes aren't sent. | 0.5° |
| **Sensitivity** | Gain on the offset from center. | 1.0 |

If the servo oscillates when someone stands still: increase dead zone (3–4°), then smoothing. If it lags a walking person: lower smoothing to 0.1–0.15 s and raise tracking speed. The SG5010 can do roughly 300 °/s unloaded (0.16–0.2 s per 60°), so speeds above ~250 °/s gain nothing.

## 6. Presence settings

- **Entry debounce** (400 ms): a person must be detected this long (and in ≥ 3 frames) before they count as having entered. This is what prevents false triggers and sound on flickers.
- **Absence before "left"** (1500 ms): how long a person may disappear before their track is dropped. Short occlusions don't re-trigger the sound.
- **No-person timeout** (3000 ms) + **When nobody is visible** (return / hold).
- **Target switch hold** (1000 ms): in *closest to center* / *largest* modes, another person must stay clearly better for this long before the target switches.
