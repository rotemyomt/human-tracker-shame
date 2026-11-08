# Serial Protocol (firmware v1.0.0)

- Transport: Leonardo native USB CDC serial, **115200 baud**, 8N1.
- **Never open the port at 1200 baud** — on a Leonardo that is the "reset into bootloader" signal.
- Commands: ASCII, one per line, terminated by `\n` (a `\r` is ignored). Case-insensitive. Max 48 characters.
- Every command gets exactly one reply line (except unsolicited `POS:` / `ARRIVED:` reports).
- Angles are degrees (0–180), sent with up to one decimal. The firmware always clamps to its soft limits, which are always within 0–180.
- The servo has no position sensor: `ANGLE`/`POS` values are what the firmware is *commanding*.

## Commands

| Command | Reply | Meaning |
|---|---|---|
| `HELLO` (alias `READY`) | `READY FW=1.0.0 PIN=9 ANGLE=90.0 MIN=10.0 MAX=170.0 CENTER=90.0 STOPPED=0` | Handshake. The browser sends this every 300 ms until it gets `READY` (up to 6 s). |
| `PING` | `PONG` | Liveness; the browser pings every 1 s and treats 3.5 s of silence as a lost link. |
| `STATUS` | `STATUS ANGLE=… TARGET=… MIN=… MAX=… CENTER=… SPEED=… PULSE=min,max STOPPED=0/1 MOVING=0/1` | Full state report. |
| `ANGLE:<deg>` | `OK ANGLE=<clamped>` · `ERR BAD_ANGLE` · `ERR STOPPED` | Set the target. The firmware slews to it at `SPEED`. |
| `CENTER` | `OK CENTER=<deg>` (then `ARRIVED:<deg>` when reached) · `ERR STOPPED` | Move to the configured center angle. |
| `SPEED:<deg/s>` | `OK SPEED=…` · `ERR BAD_SPEED` | Max slew rate, 1–720 °/s. |
| `LIMITS:<min>,<max>` | `OK LIMITS=min,max` · `ERR BAD_LIMITS` | Soft limits, 0 ≤ min < max ≤ 180. Center and any pending target are re-clamped. |
| `SETCENTER:<deg>` | `OK SETCENTER=…` · `ERR BAD_CENTER` | Must lie within the limits. |
| `PULSE:<us0>,<us180>` | `OK PULSE=…` · `ERR BAD_PULSE` | Pulse widths for 0° and 180°, each within 400–2600 µs. |
| `STOP` | `OK STOPPED` | **Emergency stop**: motion frozen, servo signal detached (no holding torque). All motion commands return `ERR STOPPED` until `RESUME`. Latched across browser reconnects; cleared by power-cycling or `RESUME`. |
| `RESUME` | `OK RESUMED ANGLE=<deg>` | Re-attaches the servo at the last commanded angle. |
| `SAVE` | `OK SAVED` | Store limits/center/pulse/speed in EEPROM (loaded at boot). |
| `DEFAULTS` | `OK DEFAULTS` | Restore and save factory defaults. |

Unknown commands reply `ERR UNKNOWN <cmd>`; lines over 48 chars reply `ERR OVERFLOW`.

## Unsolicited reports

| Line | When |
|---|---|
| `POS:<deg>` | Every 100 ms while the servo is slewing |
| `ARRIVED:<deg>` | Once, when a move completes |

## Defaults (until changed or saved)

Limits 10–170°, center 90°, pulse 600–2400 µs, speed 120 °/s. The browser pushes its own calibration (`LIMITS`, `SETCENTER`, `PULSE`, `SPEED`) on every connect, so the EEPROM values matter mainly for power-up behaviour.

## Browser behaviour

1. User clicks **Connect Arduino** → port picker → open at 115200, DTR asserted.
2. `HELLO` until `READY`. If the firmware reports `STOPPED=1`, the app stays in emergency stop until you press **Resume**.
3. Config push, `SPEED:60`, `CENTER`, wait for `ARRIVED:<center>` (timeout scales with distance), +300 ms settle.
4. Tracking starts. `ANGLE:` commands are rate-limited by the browser (tracking/return speed), sent at most every *command interval* (default 50 ms) and only when the change is ≥ *min step* (default 0.5°). Queued `ANGLE` commands are coalesced, so a slow link never builds a backlog.
5. On USB unplug, a read/write error or ping timeout, the app stops sending, shows a warning and goes to `DISCONNECTED`.
