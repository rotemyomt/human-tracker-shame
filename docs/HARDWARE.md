# Hardware & Wiring Guide

## Parts

| Part | Notes |
|---|---|
| Arduino Leonardo (ATmega32u4, 5 V logic) | Native USB serial — no separate USB-serial chip |
| DFRobot IO Expansion Shield | Sold today as **Gravity IO Expansion Shield V7.1, SKU DFR0265** (see "Which shield version?" below) |
| TowerPro SG5010 standard (positional) servo | 180° nominal travel, 4.8–6.0 V |
| Regulated **5 V (or 6 V) DC supply, ≥ 2 A** | For the servo. A 5 V 2 A wall adapter or bench supply is ideal |
| USB cable (micro-USB) | Computer ↔ Leonardo |
| Multimeter | Strongly recommended for the power check below |

## What was verified, and what is uncertain

**DFRobot shield (DFR0265 V7.1)** — from DFRobot's wiki and product listings:
- Each digital pin D0–D13 is broken out as a 3-pin **G / V / S** header (Ground / Voltage / Signal).
- The **V** pins of the digital headers are fed from the **SERVO_PWR** terminal. Power on SERVO_PWR feeds *only* those digital-pin V headers; it does **not** power the Arduino board.
- **PWR_IN** goes to the Arduino's VIN (6–12 V). You don't need it here — the Leonardo runs from USB.
- A 3.3 V / 5 V jumper selects the module voltage on the VCC pins; DFRobot notes the VCC pins read 0 V if that jumper cap is missing.
- SERVO_PWR includes a protective diode.
- ⚠ **Conflicting spec:** the product page lists SERVO_PWR as **4.8–6 V**, the wiki lists **5–12 V**. The shield may tolerate 12 V, but **the SG5010 does not** — never feed the servo rail more than 6 V.
- ⚠ **Uncertain:** how the 3.3/5 V jumper interacts with the digital V rail when SERVO_PWR is (or isn't) connected is not spelled out in DFRobot's documentation. **Measure it** (step 4 below) instead of assuming.

**Which shield version?** The `product-68` link you gave couldn't be opened directly. DFRobot's current IO Expansion Shield for Arduino is V7.1 (DFR0265); the older V5 (DFR0088) is retired. Look at the silkscreen: V7.1 has a **RUN/PROG** switch and a terminal labelled **SERVO_PWR**. If yours is a V5/V6, its servo-power arrangement may differ — use the "direct power" wiring below, which works with any shield.

**Arduino Leonardo with this shield:** the shield uses the standard Uno R3 header layout, which the Leonardo shares, so D0–D13 line up. Things that differ from an Uno (none affect this project):
- SPI is **not** on D11–D13 on the Leonardo (only on the ICSP header), so ignore the shield's SPI labels.
- I²C is on **D2 (SDA) / D3 (SCL)** on the Leonardo, not A4/A5.
- D0/D1 are `Serial1` (hardware UART), separate from the USB serial. The RUN/PROG switch only affects D0/D1, so it doesn't matter for uploading to a Leonardo; leave it on **RUN**.

**SG5010** — data sheets from different sellers disagree (clones are common). Consistent values: **4.8–6.0 V**, ~0.16–0.20 s/60°, ~180° travel. Pulse width ranges quoted vary (600–2400 µs on one sheet; others say 1–2 ms may not reach the full 180°). Stall current is not published by TowerPro; one supplier measured about 0.6 A, and similar standard servos can briefly draw more than 1 A. **That is why the USB port must not power the servo:** a PC port is typically limited to 500 mA, and the Leonardo has a 500 mA resettable fuse on USB power. Brown-outs reset the Leonardo and drop the USB connection.

## Pin choice: D9

The firmware uses **D9** (`SERVO_PIN` in `HumanTracker.ino`). The Arduino Servo library can drive any digital pin; D9 was chosen because it avoids:
- D0/D1 (`Serial1`, also the shield's XBee/RUN-PROG pins),
- D2/D3 (I²C on the Leonardo),
- D13 (on-board LED, and the shield's LED).

On the ATmega32u4 the Servo library uses Timer1, which disables `analogWrite()` on D9/D10 — irrelevant here.

## Wiring

SG5010 lead colours: **brown = GND (–)**, **red = +V**, **orange/yellow = signal**.

### Option A — through the shield's servo rail (recommended for V7.1)

```
 External 5–6 V supply                DFRobot shield on Leonardo
 ┌──────────────┐                     ┌─────────────────────────────┐
 │        +5V ──┼─────────────────────┼─ SERVO_PWR  +               │
 │        GND ──┼─────────────────────┼─ SERVO_PWR  –   (GND)       │
 └──────────────┘                     │                             │
                                      │  D9 header:  G   V   S      │
 SG5010 servo                         │              │   │   │      │
   brown ─────────────────────────────┼──────────────┘   │   │      │
   red   ─────────────────────────────┼──────────────────┘   │      │
   orange────────────────────────────-┼──────────────────────┘      │
                                      └──────────────┬──────────────┘
                                                     │ USB to computer
```

The servo plugs straight into the D9 G/V/S header (brown on **G**, red on **V**, orange on **S**). The supply's ground connects to the shield's SERVO_PWR (–) terminal, which is the common ground with the Arduino. Check the polarity marks on your board's terminal.

### Option B — direct power (works with any shield version)

Use this if the measurement in step 4 shows the D9 **V** pin isn't fed by your external supply, or if you're unsure of your shield's power routing.

- Servo **orange** → shield **D9 S** pin
- Servo **red** → external supply **+5–6 V** (not to the shield)
- Servo **brown** → external supply **GND**
- External supply **GND** → any shield **G** pin (**common ground — essential**; without it the signal has no reference and the servo jitters or ignores commands)
- Leave the D9 **V** pin unconnected.

## Safe power-up procedure

1. **Mechanics first.** Mount the servo firmly. Before attaching any pointer or load, make sure the horn can swing through its whole range without hitting anything. On power-up the firmware immediately drives the servo to its center angle (90° by default), because a servo's real position is unknown until it is commanded.
2. **Upload with the servo unpowered.** Connect the Leonardo by USB with the servo supply **off**, then upload `firmware/HumanTracker/HumanTracker.ino` (see README).
3. **Set the external supply** to 5.0 V (6.0 V absolute maximum) with nothing connected. Turn it off.
4. **Measure before plugging the servo in** (Option A): connect the supply to SERVO_PWR, turn it on, and measure between D9 **G** and D9 **V**. It should read your supply voltage (minus up to about 0.7 V if the shield routes it through its protective diode). If you read about 5 V with the external supply *off* as well, or anything over 6 V, stop and use Option B.
5. Turn the supply off, plug in the servo, then turn on: **servo supply first, then USB**. The servo moves to center and holds.
6. **Power-down:** close the web page (or press Disconnect), turn off the servo supply, then unplug USB.

The servo draws its current from the external supply, never from USB. Keep the servo leads short and away from the webcam cable. If the servo twitches when the Leonardo resets, that's normal: the signal floats briefly during boot.

## Mounting

- The camera must stay **fixed** (not carried by the servo). This software maps the person's position in a stationary camera image to an absolute servo angle; a camera that turns with the servo would need a different, closed-loop design.
- **Best:** place the servo's pivot **directly above or below the camera lens**, a few centimetres away, with servo center pointing along the camera's view. Then **"Camera FOV" mapping** is geometrically correct at any distance.
- **Separate mounting** (camera fixed, servo elsewhere) also works, but read the limitations in `CALIBRATION.md` and use **Two-point** mapping.
- Mount so that servo 90° points the same way as the camera's optical axis, or set the **Center** angle to whatever servo angle does point along the camera axis.
