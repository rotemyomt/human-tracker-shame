# Troubleshooting

## Browser / page

| Symptom | Fix |
|---|---|
| Red "Web Serial is not available" banner | Use desktop **Chrome, Edge or Opera** (v89+). Firefox and Safari have no Web Serial. Open `web/index.html` by double-click or via `http://localhost:8000`. |
| Page shows but nothing works ("Waiting for camera permission…" forever, chips stay grey) | You have an old copy of `index.html` that loads separate script files. Use the current single-file `index.html`, or run the local server (README). If you edited `web/js/*.js`, rebuild with `node tools/build-standalone.mjs`. |
| MediaPipe chip red "Failed to load" | The library and model download from `cdn.jsdelivr.net` and `storage.googleapis.com`. Check the internet connection, firewall or ad-blocker. Reload. |
| Detection FPS low (< 15) | Pick the **Lite** model; close other GPU-heavy tabs; plug in the laptop. The MediaPipe chip shows `GPU` or `CPU`: if `CPU`, enable hardware acceleration in `chrome://settings/system`. Lower the camera resolution by choosing another camera, if available. |
| Tracking stops when the window is behind another one or minimized | Browsers throttle background tabs. Keep the tab visible (a dedicated full-screen window for installations). Tip: `chrome --kiosk http://localhost:8000`. |

## Camera

| Symptom | Fix |
|---|---|
| "Camera permission was denied" | Click the camera icon in the address bar → Allow, reload. On macOS also allow the browser in System Settings → Privacy & Security → Camera. On Windows: Settings → Privacy → Camera. |
| "Camera is in use by another application" | Close Zoom/Teams/OBS/other tabs that use it. |
| Wrong camera | Use the **Camera** dropdown; the choice is remembered. |

## Arduino / serial

| Symptom | Fix |
|---|---|
| Leonardo isn't in the port list | Use a **data** USB cable (many are charge-only). Try another port. On Windows, install the Arduino IDE once so the driver is installed. Unplug/replug: the Leonardo re-enumerates. |
| "Could not open serial port" | Another program owns the port: **close the Arduino IDE Serial Monitor/Plotter**, any other tab with this app, Cura, etc. |
| "No READY reply from the Arduino" | Firmware not uploaded, or wrong port picked. Upload `HumanTracker.ino` and pick the port named *Arduino Leonardo*. If you see a port named *Leonardo bootloader* that disappears after 8 s, the board was reset — wait and retry. |
| Disconnects whenever the servo moves | The servo is browning out the board: it's drawing from USB, or the grounds aren't common, or the supply is too weak. Follow `HARDWARE.md` — external 5–6 V ≥ 2 A supply, common ground. |
| "Arduino connection lost … timeout" | USB cable/hub problem, PC sleep, or brown-out (see above). Avoid unpowered hubs. Disable USB selective suspend (Windows power options). |
| Upload fails with the shield on | Leonardo uploads over native USB, so the shield's RUN/PROG switch doesn't matter. If the upload can't find the port, double-tap the Leonardo's reset button right as the IDE says "Uploading…". |

## Servo

| Symptom | Fix |
|---|---|
| Doesn't move at all, link OK | Servo power missing: measure D9 **V–G** (should be 4.8–6 V). Check the brown/red/orange orientation on **G/V/S**. Check the emergency stop banner. Check the servo chip shows an angle. |
| Jitters / twitches at rest | Missing common ground, long signal wire near the power wires, or a weak supply. Increase dead zone. A small amount of hum under load is normal for analog servos. |
| Buzzes continuously at one end | It's at its mechanical stop: reduce Max/Min angle (CALIBRATION step 1). |
| Moves the wrong way | Tick **Invert direction** (FOV/Linear modes) or redo Two-point calibration. |
| Points slightly off | Adjust **Center**, then **FOV** or **sensitivity**. If the servo is far from the camera, use Two-point mapping (CALIBRATION step 4). |
| Oscillates / hunts | Raise dead zone and smoothing, lower tracking speed. |
| Lags behind people | Lower smoothing, raise tracking speed, lower command interval to 30–40 ms. |
| Snaps to center at power-up | Expected: at boot the firmware has no idea where the servo is, so it drives it to the center angle. |

## Detection / sound

| Symptom | Fix |
|---|---|
| Detects nobody | Good lighting matters most; avoid strong backlight (windows behind people). Upper body should be in frame. Lower **detection confidence** and **landmark visibility threshold** slightly. |
| Ghost detections (posters, mannequins) | Raise detection confidence to 0.6–0.7 and the visibility threshold. |
| Sound plays repeatedly for one person | Increase **entry debounce** and **absence before "left"**, raise **cooldown**, or switch the trigger to **Empty → occupied**. |
| Sound doesn't play | The Audio chip will say why: *No sound loaded*, *Click page to enable* (browser autoplay rule — click anywhere once after loading the page), *Muted* or *Disabled*. Check "Play even when Arduino is not connected" if testing without hardware. |
| Uploaded sound is gone after reload | It's stored in the browser's IndexedDB for this site; clearing site data or using a private window removes it. |
| Same person gets a new ID after walking behind someone | Pose detection has no identity; IDs come from position continuity. Crossing people can swap IDs. Use *First detected* mode and a longer *absence* to minimise target swaps. |
