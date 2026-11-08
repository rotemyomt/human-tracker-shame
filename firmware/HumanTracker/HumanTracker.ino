/*
 * HumanTracker firmware — Arduino Leonardo (ATmega32u4) + DFRobot IO Expansion Shield
 * Drives a TowerPro SG5010 positional servo from commands sent by the browser
 * over the Leonardo's native USB serial (Web Serial API).
 *
 * Wiring (see docs/HARDWARE.md):
 *   Servo signal (orange/yellow) -> shield D9  "S" pin
 *   Servo +V     (red)           -> shield D9  "V" pin  (rail fed by SERVO_PWR, 5-6 V)
 *   Servo GND    (brown/black)   -> shield D9  "G" pin
 *
 * Serial: 115200 baud, newline-terminated ASCII commands (see docs/PROTOCOL.md).
 * NEVER open the port at 1200 baud: on the Leonardo that triggers the bootloader.
 *
 * Note: a hobby servo has no position feedback. "ANGLE" reported here is the
 * angle the firmware is currently *commanding*, not a measured shaft angle.
 */

#include <Servo.h>
#include <EEPROM.h>

// ---------------------------------------------------------------- constants
#define FW_VERSION        "1.0.0"
const uint8_t  SERVO_PIN        = 9;      // D9: not Serial1 (D0/D1), not I2C (D2/D3), not LED (D13)
const uint32_t BAUD             = 115200;
const uint16_t UPDATE_MS        = 10;     // slew update period (100 Hz)
const uint16_t POS_REPORT_MS    = 100;    // position report period while moving
const uint8_t  LINE_MAX         = 48;

// Hard absolute bounds — nothing can ever command outside these.
const float    HARD_MIN_ANGLE   = 0.0;
const float    HARD_MAX_ANGLE   = 180.0;
const uint16_t HARD_MIN_US      = 400;
const uint16_t HARD_MAX_US      = 2600;

const uint16_t CFG_MAGIC        = 0x5A11;
const int      CFG_ADDR         = 0;

struct Config {
  uint16_t magic;
  float    minAngle;     // safe soft limit
  float    maxAngle;     // safe soft limit
  float    centerAngle;  // default/home angle
  uint16_t minUs;        // pulse width at 0 degrees
  uint16_t maxUs;        // pulse width at 180 degrees
  float    speed;        // max slew rate, degrees per second
};

// Defaults: conservative soft limits until you calibrate the real end stops.
// Pulse 600-2400 us is the range on one SG5010 data sheet; sellers' sheets disagree,
// so verify on YOUR servo (docs/CALIBRATION.md) before widening limits.
const Config DEFAULT_CFG = { CFG_MAGIC, 10.0, 170.0, 90.0, 600, 2400, 120.0 };

// ---------------------------------------------------------------- state
Servo   servo;
Config  cfg;
float   currentAngle = 90.0;   // angle currently being written to the servo
float   targetAngle  = 90.0;   // where we are slewing to
bool    stopped      = false;  // emergency stop latched
bool    moving       = false;
unsigned long lastUpdate = 0;
unsigned long lastPosReport = 0;
uint16_t lastWrittenUs = 0;

char    line[LINE_MAX + 1];
uint8_t lineLen = 0;
bool    lineOverflow = false;

// ---------------------------------------------------------------- helpers
float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

float clampToLimits(float a) {
  a = clampf(a, HARD_MIN_ANGLE, HARD_MAX_ANGLE);
  return clampf(a, cfg.minAngle, cfg.maxAngle);
}

uint16_t angleToUs(float a) {
  float us = cfg.minUs + (a / 180.0) * (float)(cfg.maxUs - cfg.minUs);
  return (uint16_t)(us + 0.5);
}

void writeServo(float a, bool force) {
  if (stopped || !servo.attached()) return;
  uint16_t us = angleToUs(a);
  if (force || us != lastWrittenUs) {   // avoid redundant writes
    servo.writeMicroseconds(us);
    lastWrittenUs = us;
  }
}

bool validConfig(const Config &c) {
  return c.magic == CFG_MAGIC &&
         c.minAngle >= HARD_MIN_ANGLE && c.maxAngle <= HARD_MAX_ANGLE && c.minAngle < c.maxAngle &&
         c.centerAngle >= c.minAngle && c.centerAngle <= c.maxAngle &&
         c.minUs >= HARD_MIN_US && c.maxUs <= HARD_MAX_US && c.minUs < c.maxUs &&
         c.speed >= 1.0 && c.speed <= 720.0;
}

// Parse a float; returns false on junk. Accepts "120", "45.5", "-0".
bool parseFloat(const char *s, float &out) {
  if (!s || !*s) return false;
  char *end;
  double v = strtod(s, &end);
  while (*end == ' ') end++;
  if (end == s || *end != '\0') return false;
  if (v != v) return false; // NaN
  out = (float)v;
  return true;
}

// Parse "a,b" into two floats.
bool parsePair(char *s, float &a, float &b) {
  char *comma = strchr(s, ',');
  if (!comma) return false;
  *comma = '\0';
  return parseFloat(s, a) && parseFloat(comma + 1, b);
}

void printStatus() {
  Serial.print(F("STATUS ANGLE="));   Serial.print(currentAngle, 1);
  Serial.print(F(" TARGET="));        Serial.print(targetAngle, 1);
  Serial.print(F(" MIN="));           Serial.print(cfg.minAngle, 1);
  Serial.print(F(" MAX="));           Serial.print(cfg.maxAngle, 1);
  Serial.print(F(" CENTER="));        Serial.print(cfg.centerAngle, 1);
  Serial.print(F(" SPEED="));         Serial.print(cfg.speed, 1);
  Serial.print(F(" PULSE="));         Serial.print(cfg.minUs); Serial.print(','); Serial.print(cfg.maxUs);
  Serial.print(F(" STOPPED="));       Serial.print(stopped ? 1 : 0);
  Serial.print(F(" MOVING="));        Serial.println(moving ? 1 : 0);
}

void printReady() {
  Serial.print(F("READY FW=" FW_VERSION " PIN="));
  Serial.print(SERVO_PIN);
  Serial.print(F(" ANGLE="));  Serial.print(currentAngle, 1);
  Serial.print(F(" MIN="));    Serial.print(cfg.minAngle, 1);
  Serial.print(F(" MAX="));    Serial.print(cfg.maxAngle, 1);
  Serial.print(F(" CENTER=")); Serial.print(cfg.centerAngle, 1);
  Serial.print(F(" STOPPED="));Serial.println(stopped ? 1 : 0);
}

void setTarget(float a) {
  targetAngle = clampToLimits(a);
  if (targetAngle != currentAngle) moving = true;
}

void attachServo() {
  servo.attach(SERVO_PIN, cfg.minUs, cfg.maxUs);
  writeServo(currentAngle, true);
}

// ---------------------------------------------------------------- commands
void handleCommand(char *cmd) {
  // uppercase + trim
  for (char *p = cmd; *p; p++) if (*p >= 'a' && *p <= 'z') *p -= 32;
  while (*cmd == ' ') cmd++;
  int n = strlen(cmd);
  while (n > 0 && (cmd[n - 1] == ' ' || cmd[n - 1] == '\r')) cmd[--n] = '\0';
  if (n == 0) return;

  char *arg = strchr(cmd, ':');
  if (arg) { *arg = '\0'; arg++; }

  if (!strcmp(cmd, "HELLO") || !strcmp(cmd, "READY")) {
    printReady();
  } else if (!strcmp(cmd, "PING")) {
    Serial.println(F("PONG"));
  } else if (!strcmp(cmd, "STATUS")) {
    printStatus();
  } else if (!strcmp(cmd, "ANGLE")) {
    float a;
    if (stopped)                 { Serial.println(F("ERR STOPPED")); return; }
    if (!arg || !parseFloat(arg, a)) { Serial.println(F("ERR BAD_ANGLE")); return; }
    setTarget(a);
    Serial.print(F("OK ANGLE=")); Serial.println(targetAngle, 1);
  } else if (!strcmp(cmd, "CENTER")) {
    if (stopped) { Serial.println(F("ERR STOPPED")); return; }
    setTarget(cfg.centerAngle);
    Serial.print(F("OK CENTER=")); Serial.println(targetAngle, 1);
    if (!moving) { Serial.print(F("ARRIVED:")); Serial.println(currentAngle, 1); }
  } else if (!strcmp(cmd, "SPEED")) {
    float s;
    if (!arg || !parseFloat(arg, s) || s < 1.0 || s > 720.0) { Serial.println(F("ERR BAD_SPEED")); return; }
    cfg.speed = s;
    Serial.print(F("OK SPEED=")); Serial.println(cfg.speed, 1);
  } else if (!strcmp(cmd, "LIMITS")) {
    float lo, hi;
    if (!arg || !parsePair(arg, lo, hi) || lo < HARD_MIN_ANGLE || hi > HARD_MAX_ANGLE || lo >= hi) {
      Serial.println(F("ERR BAD_LIMITS")); return;
    }
    cfg.minAngle = lo; cfg.maxAngle = hi;
    cfg.centerAngle = clampf(cfg.centerAngle, lo, hi);
    setTarget(targetAngle);                       // re-clamp any pending motion
    Serial.print(F("OK LIMITS=")); Serial.print(lo, 1); Serial.print(','); Serial.println(hi, 1);
  } else if (!strcmp(cmd, "SETCENTER")) {
    float c;
    if (!arg || !parseFloat(arg, c) || c < cfg.minAngle || c > cfg.maxAngle) { Serial.println(F("ERR BAD_CENTER")); return; }
    cfg.centerAngle = c;
    Serial.print(F("OK SETCENTER=")); Serial.println(c, 1);
  } else if (!strcmp(cmd, "PULSE")) {
    float lo, hi;
    if (!arg || !parsePair(arg, lo, hi) || lo < HARD_MIN_US || hi > HARD_MAX_US || lo >= hi) {
      Serial.println(F("ERR BAD_PULSE")); return;
    }
    cfg.minUs = (uint16_t)lo; cfg.maxUs = (uint16_t)hi;
    if (servo.attached()) { servo.detach(); attachServo(); }
    Serial.print(F("OK PULSE=")); Serial.print(cfg.minUs); Serial.print(','); Serial.println(cfg.maxUs);
  } else if (!strcmp(cmd, "STOP")) {
    // Emergency stop: freeze motion and remove the control signal.
    targetAngle = currentAngle;
    moving = false;
    stopped = true;
    servo.detach();
    Serial.println(F("OK STOPPED"));
  } else if (!strcmp(cmd, "RESUME")) {
    if (stopped) {
      stopped = false;
      attachServo();        // re-attach at the last commanded angle
    }
    Serial.print(F("OK RESUMED ANGLE=")); Serial.println(currentAngle, 1);
  } else if (!strcmp(cmd, "SAVE")) {
    EEPROM.put(CFG_ADDR, cfg);
    Serial.println(F("OK SAVED"));
  } else if (!strcmp(cmd, "DEFAULTS")) {
    cfg = DEFAULT_CFG;
    EEPROM.put(CFG_ADDR, cfg);
    if (servo.attached()) { servo.detach(); attachServo(); }
    setTarget(targetAngle);
    Serial.println(F("OK DEFAULTS"));
  } else {
    Serial.print(F("ERR UNKNOWN ")); Serial.println(cmd);
  }
}

void readSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n') {
      if (lineOverflow) Serial.println(F("ERR OVERFLOW"));
      else { line[lineLen] = '\0'; handleCommand(line); }
      lineLen = 0; lineOverflow = false;
    } else if (c != '\r') {
      if (lineLen < LINE_MAX) line[lineLen++] = c;
      else lineOverflow = true;
    }
  }
}

// ---------------------------------------------------------------- motion
void updateMotion() {
  unsigned long now = millis();
  unsigned long dtMs = now - lastUpdate;
  if (dtMs < UPDATE_MS) return;
  lastUpdate = now;
  if (stopped || !moving) return;

  float maxStep = cfg.speed * (dtMs / 1000.0);
  float diff = targetAngle - currentAngle;
  if (fabs(diff) <= maxStep) {
    currentAngle = targetAngle;
    moving = false;
  } else {
    currentAngle += (diff > 0 ? maxStep : -maxStep);
  }
  writeServo(currentAngle, false);

  if (!moving) {
    Serial.print(F("ARRIVED:")); Serial.println(currentAngle, 1);
  } else if (now - lastPosReport >= POS_REPORT_MS) {
    lastPosReport = now;
    Serial.print(F("POS:")); Serial.println(currentAngle, 1);
  }
}

// ---------------------------------------------------------------- setup/loop
void setup() {
  EEPROM.get(CFG_ADDR, cfg);
  if (!validConfig(cfg)) cfg = DEFAULT_CFG;

  // Power-up: the servo's real position is unknown, so it moves straight to
  // the center angle here. Mount the pointer so that a jump to center is safe.
  currentAngle = cfg.centerAngle;
  targetAngle  = cfg.centerAngle;
  attachServo();

  Serial.begin(BAUD);
  // Do NOT block on while(!Serial): the servo must hold center even with no host.
  lastUpdate = millis();
}

void loop() {
  readSerial();
  updateMotion();
}
