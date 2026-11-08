// Procedural medieval street scene, drawn on a 2D canvas with a true perspective projection.
// Static parts (sky, distant castle, building walls, cobbled road, far crowd) are pre-rendered
// once per resize; the near crowd, the bell-ringer, the people cut out of the webcam image and
// the light effects are drawn every frame.

const TAU = Math.PI * 2;
const GEO = {
  camH: 1.65,      // viewer eye height (m)
  wallX: 5.6,      // building facades at x = ±5.6 m
  roadX: 3.0,      // cobbled road between x = ±3.0 m
  zEnd: 118,       // street length
  wallTexH: 19,    // texture height (m)
  ppm: 32,         // wall texture pixels per metre
  gppm: 56,        // ground texture pixels per metre
  gTileM: 16,      // ground texture tile length (m)
  horizon: 0.42,   // horizon height as fraction of screen
  focal: 0.95,     // focal length as fraction of screen height
};
const HAZE = [216, 210, 198];

// ------------------------------------------------------------------ helpers
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
const mixc = (c, d, t) => [lerp(c[0], d[0], t), lerp(c[1], d[1], t), lerp(c[2], d[2], t)];
const mulc = (c, k) => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
function mips(c) {
  const out = [c]; let cur = c;
  while (cur.width > 16 && cur.height > 16 && out.length < 7) {
    const n = makeCanvas(cur.width >> 1, cur.height >> 1);
    const x = n.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, n.width, n.height);
    out.push(n); cur = n;
  }
  return out;
}
function pick(R, arr) { return arr[(R() * arr.length) | 0]; }

// ------------------------------------------------------------------ wall texture
function drawBuilding(g, R, x0, bw, TH, bh, P) {
  const top = TH - bh;
  const stucco = R() < 0.32;
  const hue = 30 + R() * 14, sat = 8 + R() * 16, lit = 60 + R() * 12;

  if (!stucco) {
    g.fillStyle = hsl(hue, Math.max(0, sat - 4), lit - 18); // mortar
    g.fillRect(x0, top, bw, bh);
    let y = TH, row = 0;
    while (y > top) {
      const ch = Math.max(6, Math.round((0.26 + R() * 0.14) * P));
      const yy = Math.max(top, y - ch);
      let bx = x0 - (row % 2 ? R() * 0.5 * P : 0);
      while (bx < x0 + bw) {
        const bwid = Math.round((0.4 + R() * 0.85) * P);
        const rx = Math.max(x0, bx), rw = Math.min(x0 + bw, bx + bwid) - rx;
        if (rw > 2) {
          g.fillStyle = hsl(hue + (R() - 0.5) * 8, sat + (R() - 0.5) * 7, lit + (R() - 0.5) * 11);
          g.fillRect(rx + 1, yy + 1, rw - 2, y - yy - 2);
          g.fillStyle = 'rgba(255,250,240,0.10)'; g.fillRect(rx + 1, yy + 1, rw - 2, 1);
          g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(rx + 1, y - 2, rw - 2, 1);
        }
        bx += bwid;
      }
      y = yy; row++;
    }
  } else {
    const ph = 34 + R() * 12, ps = 22 + R() * 22, pl = 66 + R() * 12;
    g.fillStyle = hsl(ph, ps, pl); g.fillRect(x0, top, bw, bh);
    for (let i = 0; i < bw * bh / 900; i++) {
      const r = (0.3 + R() * 1.6) * P;
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
      const c = R() < 0.5 ? `hsla(${ph},${ps}%,${pl - 12}%,0.18)` : `hsla(${ph},${ps}%,${pl + 8}%,0.16)`;
      gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.translate(x0 + R() * bw, top + R() * bh); g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); g.restore();
    }
    // patches of exposed stone
    for (let i = 0; i < 2 + R() * 3; i++) {
      const pw = (0.6 + R() * 1.6) * P, ph2 = (0.4 + R() * 1.0) * P;
      const px = x0 + R() * (bw - pw), py = top + R() * (bh - ph2);
      g.fillStyle = hsl(hue, sat, lit - 20); g.fillRect(px, py, pw, ph2);
      for (let k = 0; k < pw * ph2 / 90; k++) {
        g.fillStyle = hsl(hue, sat, lit - 6 + (R() - 0.5) * 12);
        g.fillRect(px + R() * pw, py + R() * ph2, 8 + R() * 14, 5 + R() * 4);
      }
    }
  }
  // speckle noise
  for (let i = 0; i < bw * bh / 45; i++) {
    g.fillStyle = R() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.06)';
    g.fillRect(x0 + R() * bw, top + R() * bh, 1 + R() * 2, 1 + R() * 2);
  }
  // rain streaks
  for (let i = 0; i < bw / P * 0.9; i++) {
    const sx = x0 + R() * bw, sw = 1 + R() * 5, sl = (1 + R() * 7) * P, sy = top + R() * bh * 0.7;
    const gr = g.createLinearGradient(0, sy, 0, sy + sl);
    gr.addColorStop(0, 'rgba(60,50,40,0.20)'); gr.addColorStop(1, 'rgba(60,50,40,0)');
    g.fillStyle = gr; g.fillRect(sx, sy, sw, sl);
  }
  // grime at street level
  const gg = g.createLinearGradient(0, TH - 1.5 * P, 0, TH);
  gg.addColorStop(0, 'rgba(50,42,34,0)'); gg.addColorStop(1, 'rgba(50,42,34,0.42)');
  g.fillStyle = gg; g.fillRect(x0, TH - 1.5 * P, bw, 1.5 * P);

  // ground-floor openings
  let ox = x0 + (0.7 + R() * 1.4) * P;
  while (ox < x0 + bw - 2.2 * P) {
    const t = R(), ow = (1.3 + R() * 0.9) * P, oh = (2.3 + R() * 0.7) * P;
    if (t < 0.5) drawArch(g, ox, TH, ow, oh, P, R, true);
    else if (t < 0.85) drawArch(g, ox, TH, ow * 0.8, oh * 0.92, P, R, false);
    else drawWindow(g, ox, TH - 2.4 * P, ow * 0.6, 1.0 * P, '#2a2620', P, R, true);
    ox += ow + (1.6 + R() * 2.8) * P;
  }
  // upper floors
  const floors = Math.max(0, Math.floor((bh / P - 3.8) / 3.2));
  const shutter = pick(R, ['#2f5a4e', '#36606e', '#4a3a28', '#3e5a3a', '#5b4630', '#2d4b5c', '#6a5a3a']);
  const spacing = (2.2 + R() * 1.1) * P, ww = (0.85 + R() * 0.25) * P, wh = (1.45 + R() * 0.45) * P;
  for (let f = 0; f < floors; f++) {
    const sill = TH - (3.6 + f * 3.2 + 0.9) * P;
    if (R() < 0.35) { g.fillStyle = 'rgba(240,232,214,0.30)'; g.fillRect(x0, sill + 0.5 * P, bw, 0.14 * P); }
    for (let wx = x0 + spacing * 0.55; wx + ww < x0 + bw - 0.4 * P; wx += spacing) {
      if (R() < 0.08) continue;
      drawWindow(g, wx, sill - wh, ww, wh, shutter, P, R, false);
    }
  }
  // cornice + roof tiles
  g.fillStyle = hsl(hue, sat, lit + 7); g.fillRect(x0, top + 0.45 * P, bw, 0.28 * P);
  g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x0, top + 0.73 * P, bw, 0.16 * P);
  g.fillStyle = '#6e3a24'; g.fillRect(x0, top, bw, 0.5 * P);
  for (let tx = x0; tx < x0 + bw; tx += 0.22 * P) {
    g.fillStyle = hsl(14 + R() * 10, 45 + R() * 15, 34 + R() * 12);
    g.beginPath(); g.ellipse(tx + 0.11 * P, top + 0.3 * P, 0.1 * P, 0.24 * P, 0, 0, TAU); g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x0, top + 0.46 * P, bw, 2);
  // ivy
  if (R() < 0.28) drawIvy(g, x0 + R() * bw, TH, (3 + R() * 8) * P, P, R);
  // laundry line / sign occasionally
  if (R() < 0.18) drawSign(g, x0 + (0.5 + R() * 0.4) * bw, TH - 3.4 * P, P, R);
  g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(x0, top, 2, bh);
}

function drawArch(g, x, base, w, h, P, R, open) {
  const r = w / 2, spring = base - h + r;
  // stone surround
  g.fillStyle = 'rgba(232,222,200,0.55)';
  g.beginPath(); g.moveTo(x - 0.14 * P, base); g.lineTo(x - 0.14 * P, spring); g.arc(x + r, spring, r + 0.14 * P, Math.PI, 0); g.lineTo(x + w + 0.14 * P, base); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(x, base); g.lineTo(x, spring); g.arc(x + r, spring, r, Math.PI, 0); g.lineTo(x + w, base); g.closePath();
  if (open) {
    const gr = g.createLinearGradient(0, base - h, 0, base);
    gr.addColorStop(0, '#0f0c0a'); gr.addColorStop(1, '#2a221b');
    g.fillStyle = gr; g.fill();
  } else {
    g.fillStyle = hsl(22 + R() * 10, 35, 18 + R() * 8); g.fill();
    g.save(); g.clip();
    for (let px = x; px < x + w; px += 0.16 * P) {
      g.fillStyle = `rgba(0,0,0,${0.15 + R() * 0.15})`; g.fillRect(px, base - h, 1.5, h);
    }
    g.fillStyle = 'rgba(30,24,18,0.9)';
    for (let k = 0; k < 3; k++) g.fillRect(x, base - h * (0.2 + k * 0.3), w, 0.06 * P);
    g.restore();
  }
  // voussoir lines
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
  for (let a = Math.PI; a <= TAU + 0.01; a += Math.PI / 7) {
    g.beginPath(); g.moveTo(x + r + Math.cos(a) * r, spring + Math.sin(a) * r);
    g.lineTo(x + r + Math.cos(a) * (r + 0.14 * P), spring + Math.sin(a) * (r + 0.14 * P)); g.stroke();
  }
}

function drawWindow(g, x, y, w, h, col, P, R, barred) {
  const fr = 0.12 * P;
  g.fillStyle = 'rgba(238,228,206,0.55)'; g.fillRect(x - fr, y - fr, w + 2 * fr, h + 2 * fr);
  g.fillStyle = 'rgba(0,0,0,0.30)'; g.fillRect(x - fr, y + h + fr, w + 2 * fr, 0.08 * P);
  const open = barred || R() < 0.35;
  if (open) {
    const gr = g.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, '#2b2a28'); gr.addColorStop(0.5, '#141210'); gr.addColorStop(1, '#22201c');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    if (barred) { g.fillStyle = '#0a0a0a'; for (let bx = x + w / 4; bx < x + w; bx += w / 4) g.fillRect(bx, y, 2, h); }
    else {
      g.fillStyle = 'rgba(255,240,210,0.06)'; g.fillRect(x + 2, y + 2, w * 0.3, h - 4);
      // folded-open shutters beside the window
      const sw = w * 0.42;
      [x - fr - sw, x + w + fr].forEach((sx) => { drawShutterLeaf(g, sx, y, sw, h, col, P, R); });
    }
  } else {
    drawShutterLeaf(g, x, y, w / 2, h, col, P, R);
    drawShutterLeaf(g, x + w / 2, y, w / 2, h, col, P, R);
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x + w / 2 - 1, y, 2, h);
  }
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, y, w, 0.08 * P);
}
function drawShutterLeaf(g, x, y, w, h, col, P, R) {
  g.fillStyle = col; g.fillRect(x, y, w, h);
  g.fillStyle = `rgba(255,255,255,${0.04 + R() * 0.08})`; g.fillRect(x, y, w, h); // sun-faded
  for (let ly = y + 0.06 * P; ly < y + h - 0.04 * P; ly += 0.07 * P) {
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x + 2, ly, w - 4, 1);
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x + 2, ly + 1, w - 4, 1);
  }
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
function drawIvy(g, x, base, height, P, R) {
  let cx = x, cy = base;
  const steps = height / (0.12 * P);
  for (let i = 0; i < steps; i++) {
    cx += (R() - 0.5) * 0.25 * P; cy -= 0.12 * P;
    const n = 6 + R() * 8;
    for (let k = 0; k < n; k++) {
      const lx = cx + (R() - 0.5) * 0.9 * P * (1 - i / steps * 0.5), ly = cy + (R() - 0.5) * 0.3 * P;
      g.fillStyle = hsl(80 + R() * 40, 30 + R() * 25, 18 + R() * 20, 0.9);
      g.beginPath(); g.ellipse(lx, ly, 0.06 * P + R() * 0.05 * P, 0.04 * P + R() * 0.04 * P, R() * Math.PI, 0, TAU); g.fill();
    }
  }
}
function drawSign(g, x, y, P, R) {
  g.strokeStyle = '#1a1714'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x + 0.9 * P, y); g.stroke();
  g.fillStyle = hsl(25 + R() * 15, 35, 25 + R() * 10);
  g.fillRect(x + 0.2 * P, y + 0.1 * P, 0.6 * P, 0.5 * P);
  g.fillStyle = 'rgba(210,180,110,0.6)'; g.fillRect(x + 0.32 * P, y + 0.24 * P, 0.36 * P, 0.22 * P);
}

function buildWall(seed, sunlit) {
  const R = rng(seed), P = GEO.ppm;
  const TW = Math.ceil((GEO.zEnd + 6) * P), TH = GEO.wallTexH * P;
  const c = makeCanvas(TW, TH), g = c.getContext('2d');
  let x = 0;
  while (x < TW) {
    const bw = Math.round((7 + R() * 9) * P), bh = Math.round((10.5 + R() * 7.5) * P);
    drawBuilding(g, R, x, bw, TH, bh, P);
    x += bw;
  }
  g.globalCompositeOperation = 'source-atop';
  if (sunlit) {
    const gr = g.createLinearGradient(0, 0, 0, TH);
    gr.addColorStop(0, 'rgba(255,214,160,0.20)'); gr.addColorStop(1, 'rgba(255,190,130,0.04)');
    g.fillStyle = gr; g.fillRect(0, 0, TW, TH);
  } else {
    g.fillStyle = 'rgba(26,36,58,0.45)'; g.fillRect(0, 0, TW, TH);
    const gr = g.createLinearGradient(0, 0, 0, TH);   // sky bounce on the upper floors
    gr.addColorStop(0, 'rgba(150,170,200,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, TW, TH);
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

// ------------------------------------------------------------------ ground texture
function buildGround(seed) {
  const R = rng(seed), P = GEO.gppm;
  const GW = Math.round(2 * GEO.wallX * P), GH = Math.round(GEO.gTileM * P);
  const c = makeCanvas(GW, GH), g = c.getContext('2d');
  g.fillStyle = '#3f3a33'; g.fillRect(0, 0, GW, GH);
  const roadL = (GEO.wallX - GEO.roadX) * P, roadR = (GEO.wallX + GEO.roadX) * P;

  // pavement slabs (both sides)
  const slabs = (u0, u1) => {
    for (let v = 0; v < GH;) {
      const sl = Math.round((0.6 + R() * 0.6) * P);
      for (let u = u0; u < u1;) {
        const sw = Math.min(u1 - u, Math.round((0.5 + R() * 0.5) * P));
        g.fillStyle = hsl(36 + R() * 8, 10 + R() * 8, 58 + R() * 14);
        g.fillRect(u + 1, v + 1, sw - 2, Math.min(sl, GH - v) - 2);
        g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(u + 1, v + 1, sw - 2, 2);
        if (R() < 0.3) { g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.beginPath(); g.moveTo(u + R() * sw, v); g.lineTo(u + R() * sw, v + sl); g.stroke(); }
        u += sw;
      }
      v += sl;
    }
  };
  slabs(0, roadL - 0.12 * P); slabs(roadR + 0.12 * P, GW);

  // cobbles (wrap vertically so the texture tiles seamlessly)
  const rowH = 0.16 * P;
  for (let v = 0; v < GH; v += rowH) {
    let u = roadL + (R() * 0.1 * P);
    while (u < roadR) {
      const sw = (0.11 + R() * 0.1) * P;
      const col = [hsl(28 + R() * 22, 5 + R() * 12, 38 + R() * 24)];
      for (const off of [0, GH, -GH]) {
        const ex = u + sw / 2, ey = v + rowH / 2 + off + (R() - 0.5) * 2;
        if (ey < -rowH || ey > GH + rowH) continue;
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath(); g.ellipse(ex + 1, ey + 1.5, sw / 2, rowH * 0.46, 0, 0, TAU); g.fill();
        g.fillStyle = col[0];
        g.beginPath(); g.ellipse(ex, ey, sw / 2 - 0.5, rowH * 0.44, 0, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,248,235,0.16)';
        g.beginPath(); g.ellipse(ex - sw * 0.1, ey - rowH * 0.14, sw * 0.28, rowH * 0.18, 0, 0, TAU); g.fill();
      }
      u += sw + 1;
    }
  }
  // gutters
  [roadL, roadR].forEach((u) => {
    const gr = g.createLinearGradient(u - 0.14 * P, 0, u + 0.14 * P, 0);
    gr.addColorStop(0, 'rgba(20,18,15,0)'); gr.addColorStop(0.5, 'rgba(20,18,15,0.65)'); gr.addColorStop(1, 'rgba(20,18,15,0)');
    g.fillStyle = gr; g.fillRect(u - 0.14 * P, 0, 0.28 * P, GH);
  });
  // worn, dusty centre line
  const gr = g.createLinearGradient(roadL, 0, roadR, 0);
  gr.addColorStop(0, 'rgba(0,0,0,0.12)'); gr.addColorStop(0.5, 'rgba(240,226,200,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = gr; g.fillRect(roadL, 0, roadR - roadL, GH);
  for (let i = 0; i < GW * GH / 60; i++) {
    g.fillStyle = R() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,240,220,0.06)';
    g.fillRect(R() * GW, R() * GH, 1 + R() * 2, 1 + R() * 2);
  }
  return c;
}

// ------------------------------------------------------------------ crowd figures
const ROBES = [[92, 70, 52], [120, 92, 60], [70, 58, 48], [112, 58, 42], [60, 64, 52], [140, 118, 86],
  [44, 40, 38], [96, 84, 70], [128, 100, 72], [82, 52, 40], [150, 132, 104], [58, 50, 62], [104, 96, 84], [74, 82, 66]];
const SKINS = [[226, 188, 154], [204, 156, 120], [178, 130, 96], [236, 202, 172], [152, 106, 76], [212, 168, 132]];
const HAIRS = [[40, 30, 22], [24, 20, 18], [96, 56, 30], [150, 118, 70], [120, 116, 110], [70, 46, 30]];
const SCARVES = [[196, 182, 150], [150, 70, 50], [170, 150, 110], [90, 96, 110], [210, 200, 180]];

function makeFigure(R, X, Z, side) {
  return {
    X, Z, side,
    h: 1.52 + R() * 0.34, w: 0.85 + R() * 0.35,
    robe: pick(R, ROBES), skin: pick(R, SKINS), hair: pick(R, HAIRS), scarf: pick(R, SCARVES),
    head: R() < 0.22 ? 1 : R() < 0.35 ? 2 : R() < 0.1 ? 3 : 0,
    belt: R() < 0.5, phase: R() * TAU, rowdy: R() < 0.3 ? 0.5 + R() * 0.5 : R() * 0.25,
    jeer: 0.35 + R() * 0.65, delay: R() * 0.3, armSide: R() < 0.7 ? 1 : -1,
  };
}

function drawFigure(g, sx, sy, s, fig, st) {
  const h = fig.h * s;
  if (h < 2) return;
  const hz = st.haze;
  const face = -fig.side; // +1 = facing right (toward the street centre)
  const robe = mixc(fig.robe, HAZE, hz), robeD = mixc(mulc(fig.robe, 0.55), HAZE, hz), robeL = mixc(mulc(fig.robe, 1.25), HAZE, hz);
  const skin = mixc(fig.skin, HAZE, hz), hair = mixc(fig.hair, HAZE, hz);
  const lean = st.act * 0.015 * h * face;
  const sway = Math.sin(st.t * 1.1 + fig.phase) * 0.012 * h + st.act * Math.sin(st.t * 7 + fig.phase) * 0.006 * h * fig.rowdy;
  const x = sx + sway, y = sy;
  const sw = 0.24 * h * fig.w, hw = 0.3 * h * fig.w, shY = y - 0.80 * h;

  if (h < 12) {
    g.fillStyle = rgb(robe); g.fillRect(x - sw / 2, shY, sw, 0.8 * h);
    g.fillStyle = rgb(fig.head === 1 ? robe : fig.head === 2 ? mixc(fig.scarf, HAZE, hz) : skin);
    g.fillRect(x - 0.06 * h + lean, y - 0.95 * h, 0.12 * h, 0.14 * h);
    return;
  }
  // contact shadow (sun from the right)
  g.fillStyle = `rgba(20,16,12,${0.30 * (1 - hz)})`;
  g.beginPath(); g.ellipse(x - 0.14 * h, y, 0.24 * h, 0.035 * h, 0, 0, TAU); g.fill();

  // robe
  const gr = g.createLinearGradient(x - hw, 0, x + hw, 0);
  gr.addColorStop(0, rgb(robeD)); gr.addColorStop(0.55, rgb(robe)); gr.addColorStop(1, rgb(robeL));
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(x - sw * 0.5 + lean, shY + 0.03 * h);
  g.quadraticCurveTo(x - sw * 0.55 + lean, shY - 0.02 * h, x - sw * 0.2 + lean, shY - 0.035 * h);
  g.lineTo(x + sw * 0.2 + lean, shY - 0.035 * h);
  g.quadraticCurveTo(x + sw * 0.55 + lean, shY - 0.02 * h, x + sw * 0.5 + lean, shY + 0.03 * h);
  g.quadraticCurveTo(x + hw * 0.56, y - 0.35 * h, x + hw * 0.5, y - 0.01 * h);
  g.quadraticCurveTo(x, y + 0.018 * h, x - hw * 0.5, y - 0.01 * h);
  g.quadraticCurveTo(x - hw * 0.56, y - 0.35 * h, x - sw * 0.5 + lean, shY + 0.03 * h);
  g.fill();
  if (h > 36) {
    g.strokeStyle = 'rgba(0,0,0,0.20)'; g.lineWidth = Math.max(1, h * 0.006);
    for (const k of [-0.28, 0.02, 0.3]) {
      g.beginPath(); g.moveTo(x + sw * k + lean, shY + 0.14 * h);
      g.quadraticCurveTo(x + hw * k * 0.9 + sway, y - 0.42 * h, x + hw * k * 1.12, y - 0.02 * h); g.stroke();
    }
  }
  if (fig.belt && h > 22) { g.fillStyle = rgb(mixc([48, 34, 22], HAZE, hz)); g.fillRect(x - sw * 0.52 + lean * 0.5, y - 0.5 * h, sw * 1.04, Math.max(1, 0.022 * h)); }

  // arms
  const up = clamp(st.arm, 0, 1);
  const lw = Math.max(1.5, 0.075 * h);
  g.lineCap = 'round';
  for (const k of [-1, 1]) {
    const isRaised = k === fig.armSide * face && up > 0.02;
    const shx = x + k * sw * 0.44 + lean, shy = shY + 0.03 * h;
    let ang = Math.PI / 2 - k * 0.12;
    // raise through the outside of the body: right arm via 0 rad, left arm via π
    if (isRaised) {
      const target = k > 0 ? -Math.PI / 2 + 0.35 : Math.PI * 1.5 - 0.35;
      ang = lerp(ang, target + Math.sin(st.t * 9 + fig.phase) * 0.18 * up, up);
    }
    const len = 0.36 * h;
    const hx = shx + Math.cos(ang) * len, hy = shy + Math.sin(ang) * len;
    g.strokeStyle = rgb(k > 0 ? robe : robeD); g.lineWidth = lw;
    g.beginPath(); g.moveTo(shx, shy); g.lineTo(hx, hy); g.stroke();
    if (h > 18) { g.fillStyle = rgb(skin); g.beginPath(); g.arc(hx, hy, lw * 0.42, 0, TAU); g.fill(); }
  }

  // head
  const hr = 0.068 * h, hx = x + lean * 1.4, hy = y - 0.885 * h;
  g.fillStyle = rgb(mulc(skin, 0.85)); g.fillRect(hx - hr * 0.35, hy + hr * 0.6, hr * 0.7, hr * 0.7); // neck
  if (fig.head === 1) {   // hood
    g.fillStyle = rgb(robeD);
    g.beginPath(); g.ellipse(hx - face * hr * 0.15, hy - hr * 0.1, hr * 1.3, hr * 1.4, 0, 0, TAU); g.fill();
    const fg = g.createLinearGradient(hx - face * hr, 0, hx + face * hr, 0);
    fg.addColorStop(0, rgb(mulc(skin, 0.45))); fg.addColorStop(1, rgb(skin));
    g.fillStyle = fg;
    g.beginPath(); g.ellipse(hx + face * hr * 0.42, hy + hr * 0.12, hr * 0.55, hr * 0.8, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.ellipse(hx + face * hr * 0.42, hy - hr * 0.45, hr * 0.6, hr * 0.25, 0, 0, TAU); g.fill();
  } else {
    const sg = g.createRadialGradient(hx + hr * 0.35, hy - hr * 0.3, hr * 0.1, hx, hy, hr * 1.1);
    sg.addColorStop(0, rgb(mulc(skin, 1.12))); sg.addColorStop(0.7, rgb(skin)); sg.addColorStop(1, rgb(mulc(skin, 0.7)));
    g.fillStyle = sg; g.beginPath(); g.ellipse(hx, hy, hr, hr * 1.12, 0, 0, TAU); g.fill();
    if (fig.head === 2) {   // headscarf
      g.fillStyle = rgb(mixc(fig.scarf, HAZE, hz));
      g.beginPath(); g.ellipse(hx - face * hr * 0.3, hy - hr * 0.15, hr * 1.18, hr * 1.25, 0, Math.PI * (face > 0 ? 0.55 : -0.45), Math.PI * (face > 0 ? 1.95 : 0.95)); g.fill();
      g.beginPath(); g.moveTo(hx - face * hr, hy); g.quadraticCurveTo(hx - face * hr * 1.3, hy + hr * 1.8, hx - face * hr * 0.2, hy + hr * 1.9); g.lineTo(hx, hy + hr); g.fill();
    } else if (fig.head === 0) {
      g.fillStyle = rgb(hair);
      g.beginPath(); g.ellipse(hx - face * hr * 0.28, hy - hr * 0.3, hr * 1.04, hr * 0.92, 0, Math.PI, TAU); g.fill();
      g.beginPath(); g.ellipse(hx - face * hr * 0.55, hy, hr * 0.55, hr * 0.95, 0, 0, TAU); g.fill();
    }
  }
  if (h > 90) {
    g.fillStyle = 'rgba(30,20,15,0.85)';
    g.beginPath(); g.arc(hx + face * hr * 0.5, hy - hr * 0.12, Math.max(1, hr * 0.09), 0, TAU); g.fill();
    const shout = up * st.pulse;
    if (shout > 0.25) { g.fillStyle = 'rgba(60,20,18,0.9)'; g.beginPath(); g.ellipse(hx + face * hr * 0.55, hy + hr * 0.5, hr * 0.17, hr * 0.12 + hr * 0.18 * shout, 0, 0, TAU); g.fill(); }
    else { g.strokeStyle = 'rgba(80,40,30,0.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(hx + face * hr * 0.35, hy + hr * 0.5); g.lineTo(hx + face * hr * 0.72, hy + hr * 0.48); g.stroke(); }
  }
}

// ------------------------------------------------------------------ the bell-ringer (original character)
// A town crier: oxblood cloak, forest-green kirtle, leather belt and pouch, felt hat with a feather,
// auburn braid, brass hand bell. Drawn in metres (feet at origin, y negative = up).
function drawCrier(g, sx, sy, s, st) {
  const { lift, swing, mouth, t } = st;
  g.save();
  g.translate(sx, sy); g.scale(s, s);
  const breathe = Math.sin(t * 1.6) * 0.004;

  // shadow
  g.fillStyle = 'rgba(25,18,12,0.38)';
  g.beginPath(); g.ellipse(-0.22, 0, 0.55, 0.07, 0, 0, TAU); g.fill();

  // cloak (back)
  let gr = g.createLinearGradient(-0.45, 0, 0.35, 0);
  gr.addColorStop(0, '#2a0d0b'); gr.addColorStop(0.5, '#561c17'); gr.addColorStop(1, '#7a2a20');
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(-0.22, -1.42 + breathe);
  g.bezierCurveTo(-0.34, -1.1, -0.44, -0.5, -0.46, -0.03);
  g.quadraticCurveTo(-0.1, 0.02, 0.30, -0.03);
  g.bezierCurveTo(0.30, -0.5, 0.26, -1.1, 0.2, -1.42 + breathe);
  g.closePath(); g.fill();

  // kirtle
  gr = g.createLinearGradient(-0.3, 0, 0.3, 0);
  gr.addColorStop(0, '#16261d'); gr.addColorStop(0.45, '#2c4636'); gr.addColorStop(1, '#4b6a52');
  g.fillStyle = gr;
  g.beginPath();
  g.moveTo(-0.16, -1.40 + breathe);
  g.quadraticCurveTo(-0.17, -1.15, -0.135, -0.98);
  g.bezierCurveTo(-0.2, -0.7, -0.3, -0.3, -0.31, -0.035);
  g.quadraticCurveTo(-0.03, 0.0, 0.26, -0.04);
  g.bezierCurveTo(0.24, -0.3, 0.2, -0.7, 0.15, -0.98);
  g.quadraticCurveTo(0.18, -1.15, 0.16, -1.40 + breathe);
  g.closePath(); g.fill();
  // folds
  g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.008;
  for (const [x0, x1] of [[-0.08, -0.2], [0.0, -0.04], [0.07, 0.12], [-0.03, -0.12]]) {
    g.beginPath(); g.moveTo(x0, -0.95); g.quadraticCurveTo((x0 + x1) / 2 + 0.02, -0.5, x1, -0.04); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 0.012;
  for (const x0 of [0.04, 0.16]) { g.beginPath(); g.moveTo(x0, -0.9); g.quadraticCurveTo(x0 + 0.03, -0.5, x0 + 0.05, -0.05); g.stroke(); }
  // hem embroidery
  g.fillStyle = '#9a7a34'; g.beginPath(); g.moveTo(-0.31, -0.035); g.quadraticCurveTo(-0.03, 0, 0.26, -0.04);
  g.lineTo(0.255, -0.09); g.quadraticCurveTo(-0.03, -0.05, -0.305, -0.085); g.closePath(); g.fill();
  g.fillStyle = '#5a3c14';
  for (let i = 0; i < 12; i++) { const u = -0.29 + i * 0.047; g.beginPath(); g.arc(u, -0.062 + Math.abs(u) * 0.02, 0.008, 0, TAU); g.fill(); }

  // bodice lacing + chemise
  g.fillStyle = '#e8dfcc'; g.beginPath(); g.moveTo(-0.07, -1.40); g.quadraticCurveTo(0.0, -1.34, 0.08, -1.40); g.lineTo(0.06, -1.36); g.quadraticCurveTo(0, -1.31, -0.05, -1.36); g.fill();
  g.strokeStyle = '#b08d4a'; g.lineWidth = 0.006;
  for (let i = 0; i < 5; i++) { const y0 = -1.33 + i * 0.065; g.beginPath(); g.moveTo(-0.035, y0); g.lineTo(0.04, y0 + 0.05); g.moveTo(0.04, y0); g.lineTo(-0.035, y0 + 0.05); g.stroke(); }

  // belt + pouch
  g.fillStyle = '#3a2414'; g.beginPath(); g.moveTo(-0.15, -1.0); g.quadraticCurveTo(0, -0.96, 0.16, -1.0); g.lineTo(0.16, -0.955); g.quadraticCurveTo(0, -0.915, -0.15, -0.955); g.fill();
  g.fillStyle = '#c9a24a'; g.fillRect(0.0, -0.99, 0.04, 0.035); g.fillStyle = '#3a2414'; g.fillRect(0.01, -0.982, 0.02, 0.02);
  gr = g.createLinearGradient(-0.2, -0.95, -0.08, -0.75); gr.addColorStop(0, '#6b4424'); gr.addColorStop(1, '#3a2312');
  g.fillStyle = gr; g.beginPath(); g.moveTo(-0.19, -0.95); g.lineTo(-0.08, -0.95); g.quadraticCurveTo(-0.07, -0.78, -0.13, -0.76); g.quadraticCurveTo(-0.2, -0.78, -0.19, -0.95); g.fill();
  g.strokeStyle = '#2a170a'; g.lineWidth = 0.005; g.stroke();

  // cloak front panels over the shoulders
  gr = g.createLinearGradient(-0.4, -1.4, -0.2, -0.3); gr.addColorStop(0, '#6a241d'); gr.addColorStop(1, '#3a120e');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(-0.23, -1.45); g.quadraticCurveTo(-0.16, -1.4, -0.17, -1.25); g.bezierCurveTo(-0.22, -0.9, -0.3, -0.5, -0.36, -0.12);
  g.lineTo(-0.44, -0.1); g.bezierCurveTo(-0.4, -0.6, -0.33, -1.1, -0.23, -1.45); g.fill();
  // hood bunched behind the neck
  g.fillStyle = '#4a1813'; g.beginPath(); g.ellipse(-0.06, -1.44, 0.16, 0.055, -0.1, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.008; g.beginPath(); g.ellipse(-0.06, -1.445, 0.12, 0.03, -0.1, Math.PI * 0.1, Math.PI * 0.9); g.stroke();

  // left arm (hand resting on the pouch)
  limb(g, [-0.17, -1.36], [-0.22, -1.08], [-0.15, -0.9], 0.085, '#24392c', '#3d5a46');
  g.fillStyle = '#e8dfcc'; g.beginPath(); g.ellipse(-0.155, -0.905, 0.035, 0.02, 0.8, 0, TAU); g.fill();
  skinBlob(g, -0.14, -0.875, 0.032, 0.04, 0.6);

  // right arm with the bell
  const e = lift;
  const upA = lerp(1.62, -0.25, e) + swing * 0.15 * e;             // upper-arm angle (rad, screen coords)
  const foA = lerp(1.45, -1.1, e) + swing * 0.35 * e;              // forearm angle
  const sh = [0.17, -1.37 + breathe];
  const el = [sh[0] + Math.cos(upA) * 0.29, sh[1] + Math.sin(upA) * 0.29];
  const hd = [el[0] + Math.cos(foA) * 0.26, el[1] + Math.sin(foA) * 0.26];
  limb(g, sh, el, hd, 0.09, '#2a4232', '#4b6a52');
  g.fillStyle = '#e8dfcc'; g.beginPath(); g.ellipse(hd[0] - Math.cos(foA) * 0.03, hd[1] - Math.sin(foA) * 0.03, 0.04, 0.022, foA + Math.PI / 2, 0, TAU); g.fill();
  drawBell(g, hd[0], hd[1], swing, e);
  skinBlob(g, hd[0], hd[1], 0.036, 0.04, foA);

  // neck
  g.fillStyle = '#c99476'; g.beginPath(); g.moveTo(-0.02, -1.47); g.lineTo(0.07, -1.47); g.lineTo(0.065, -1.40); g.lineTo(-0.025, -1.40); g.fill();

  // hair behind + braid
  g.fillStyle = '#5a2a14';
  g.beginPath(); g.ellipse(-0.01, -1.55, 0.1, 0.12, 0, 0, TAU); g.fill();
  for (let i = 0; i < 7; i++) {
    const bx = -0.07 + Math.sin(i * 0.5) * 0.01 + i * 0.006, by = -1.47 + i * 0.045;
    g.fillStyle = i % 2 ? '#6e3419' : '#7d3d1e';
    g.beginPath(); g.ellipse(bx, by, 0.028 - i * 0.002, 0.03, 0.3, 0, TAU); g.fill();
  }
  g.fillStyle = '#2c4636'; g.beginPath(); g.arc(-0.03, -1.165, 0.012, 0, TAU); g.fill();

  // head (three-quarter view facing right)
  gr = g.createRadialGradient(0.07, -1.58, 0.01, 0.03, -1.55, 0.12);
  gr.addColorStop(0, '#f0c8a8'); gr.addColorStop(0.6, '#dba98a'); gr.addColorStop(1, '#a8725a');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(-0.045, -1.62);
  g.bezierCurveTo(0.0, -1.67, 0.1, -1.66, 0.115, -1.58);
  g.bezierCurveTo(0.125, -1.545, 0.118, -1.535, 0.122, -1.525);   // nose bridge
  g.lineTo(0.108, -1.515);
  g.bezierCurveTo(0.11, -1.49, 0.1, -1.465, 0.065, -1.455);        // chin
  g.bezierCurveTo(0.02, -1.45, -0.03, -1.47, -0.05, -1.52);
  g.closePath(); g.fill();
  // cheek + jaw shading
  g.fillStyle = 'rgba(200,90,80,0.18)'; g.beginPath(); g.ellipse(0.065, -1.52, 0.022, 0.014, 0, 0, TAU); g.fill();
  g.fillStyle = 'rgba(90,40,25,0.20)'; g.beginPath(); g.ellipse(-0.02, -1.51, 0.03, 0.045, 0, 0, TAU); g.fill();
  // ear
  g.fillStyle = '#c98f72'; g.beginPath(); g.ellipse(-0.025, -1.55, 0.014, 0.022, 0, 0, TAU); g.fill();
  // eyes + brows
  g.fillStyle = '#f4efe6'; g.beginPath(); g.ellipse(0.075, -1.565, 0.013, 0.006, 0, 0, TAU); g.fill();
  g.fillStyle = '#3a2a1c'; g.beginPath(); g.arc(0.079, -1.565, 0.0055, 0, TAU); g.fill();
  g.fillStyle = '#f4efe6'; g.beginPath(); g.ellipse(0.025, -1.565, 0.009, 0.005, 0, 0, TAU); g.fill();
  g.fillStyle = '#3a2a1c'; g.beginPath(); g.arc(0.028, -1.565, 0.0045, 0, TAU); g.fill();
  g.strokeStyle = '#4a2614'; g.lineWidth = 0.006; g.lineCap = 'round';
  g.beginPath(); g.moveTo(0.058, -1.583); g.quadraticCurveTo(0.075, -1.592, 0.095, -1.585); g.stroke();
  g.beginPath(); g.moveTo(0.012, -1.582); g.quadraticCurveTo(0.025, -1.589, 0.04, -1.584); g.stroke();
  // nose shadow
  g.strokeStyle = 'rgba(120,60,40,0.45)'; g.lineWidth = 0.005; g.beginPath(); g.moveTo(0.1, -1.55); g.quadraticCurveTo(0.105, -1.525, 0.095, -1.517); g.stroke();
  // mouth
  if (mouth > 0.1) {
    g.fillStyle = '#4a1612'; g.beginPath(); g.ellipse(0.085, -1.488, 0.016, 0.006 + 0.012 * mouth, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(240,235,225,0.7)'; g.fillRect(0.073, -1.494 - 0.006 * mouth, 0.022, 0.004);
  } else {
    g.strokeStyle = '#8a3c30'; g.lineWidth = 0.006; g.beginPath(); g.moveTo(0.07, -1.488); g.quadraticCurveTo(0.085, -1.485, 0.1, -1.49); g.stroke();
  }
  // hair over forehead
  g.fillStyle = '#6a3018'; g.beginPath(); g.moveTo(-0.05, -1.6); g.quadraticCurveTo(0.03, -1.66, 0.11, -1.6); g.quadraticCurveTo(0.05, -1.625, -0.02, -1.58); g.fill();

  // felt hat + feather
  gr = g.createLinearGradient(-0.12, -1.75, 0.15, -1.6); gr.addColorStop(0, '#16281c'); gr.addColorStop(1, '#335240');
  g.fillStyle = gr;
  g.beginPath(); g.ellipse(0.02, -1.63, 0.15, 0.032, -0.08, 0, TAU); g.fill();
  g.beginPath(); g.moveTo(-0.07, -1.64); g.bezierCurveTo(-0.08, -1.73, 0.0, -1.76, 0.06, -1.74); g.bezierCurveTo(0.1, -1.72, 0.1, -1.66, 0.09, -1.645); g.closePath(); g.fill();
  g.fillStyle = '#3a2414'; g.beginPath(); g.moveTo(-0.072, -1.66); g.quadraticCurveTo(0.01, -1.675, 0.092, -1.665); g.lineTo(0.091, -1.648); g.quadraticCurveTo(0.01, -1.66, -0.07, -1.645); g.fill();
  g.save(); g.translate(-0.05, -1.69); g.rotate(-0.9 + Math.sin(t * 2.2) * 0.04);
  gr = g.createLinearGradient(0, 0, 0.3, 0); gr.addColorStop(0, '#5a4024'); gr.addColorStop(1, '#c8a46a');
  g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(0.15, -0.045, 0.32, -0.01); g.quadraticCurveTo(0.15, 0.03, 0, 0); g.fill();
  g.strokeStyle = 'rgba(40,25,10,0.6)'; g.lineWidth = 0.004;
  for (let k = 0.05; k < 0.3; k += 0.035) { g.beginPath(); g.moveTo(k, -0.02); g.lineTo(k + 0.01, 0.012); g.stroke(); }
  g.restore();
  g.restore();
}
function limb(g, a, b, c, w, dark, light) {
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = dark; g.lineWidth = w;
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.stroke();
  g.strokeStyle = light; g.lineWidth = w * 0.4; g.globalAlpha = 0.5;
  g.beginPath(); g.moveTo(a[0] + w * 0.15, a[1]); g.lineTo(b[0] + w * 0.15, b[1]); g.lineTo(c[0] + w * 0.12, c[1]); g.stroke();
  g.globalAlpha = 1;
}
function skinBlob(g, x, y, rx, ry, rot) {
  const gr = g.createRadialGradient(x + rx * 0.3, y - ry * 0.3, 0, x, y, Math.max(rx, ry));
  gr.addColorStop(0, '#eabd9e'); gr.addColorStop(1, '#a8725a');
  g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, TAU); g.fill();
}
function drawBell(g, x, y, swing, lift) {
  g.save(); g.translate(x, y); g.rotate(swing * 0.9 + (1 - lift) * 0.05);
  // handle
  g.fillStyle = '#3b2412'; g.beginPath(); g.roundRect(-0.016, -0.11, 0.032, 0.1, 0.01); g.fill();
  g.fillStyle = 'rgba(255,220,180,0.25)'; g.fillRect(-0.006, -0.105, 0.006, 0.09);
  // body
  const gr = g.createLinearGradient(-0.075, 0, 0.075, 0);
  gr.addColorStop(0, '#4a300e'); gr.addColorStop(0.3, '#a8792c'); gr.addColorStop(0.55, '#f2d28a'); gr.addColorStop(0.75, '#b4863a'); gr.addColorStop(1, '#5a3a12');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(-0.022, 0.0);
  g.bezierCurveTo(-0.045, 0.01, -0.05, 0.07, -0.078, 0.135);
  g.lineTo(0.078, 0.135);
  g.bezierCurveTo(0.05, 0.07, 0.045, 0.01, 0.022, 0.0); g.closePath(); g.fill();
  // lip + mouth
  g.fillStyle = '#8a6428'; g.beginPath(); g.ellipse(0, 0.135, 0.08, 0.016, 0, 0, TAU); g.fill();
  g.fillStyle = '#1e1408'; g.beginPath(); g.ellipse(0, 0.137, 0.068, 0.011, 0, 0, TAU); g.fill();
  // clapper (lags the swing)
  g.fillStyle = '#2a2016'; g.beginPath(); g.arc(-swing * 0.03, 0.146, 0.011, 0, TAU); g.fill();
  // specular glint
  g.fillStyle = 'rgba(255,248,220,0.55)'; g.beginPath(); g.ellipse(0.012, 0.06, 0.008, 0.04, 0.1, 0, TAU); g.fill();
  g.restore();
}

// ------------------------------------------------------------------ Scene
export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bg = null;
    this.t0 = performance.now();
    this.last = this.t0;
    this.act = 0;
    this.crier = { lift: 0, swing: 0, vel: 0, mouth: 0, kickDir: 1, lastBellAge: Infinity, nextFallback: 0 };
    this.placements = new Map();
    this.cut = makeCanvas(2, 2); this.cutCtx = this.cut.getContext('2d', { willReadFrequently: false });
    this.maskC = makeCanvas(2, 2); this.maskCtx = this.maskC.getContext('2d');
    this.tmp = makeCanvas(2, 2); this.tmpCtx = this.tmp.getContext('2d');
    this.hasMask = false; this.cutW = 0; this.cutH = 0;
    this.ready = false;
    this._buildTextures();
    this._buildCrowd();
    this._buildFx();
    this._resize();
    window.addEventListener('resize', () => { clearTimeout(this._rt); this._rt = setTimeout(() => this._resize(), 200); });
  }

  _buildTextures() {
    this.wallL = mips(buildWall(1337, true));
    this.wallR = mips(buildWall(4242, false));
    this.ground = mips(buildGround(99));
  }

  _buildCrowd() {
    const R = rng(7);
    this.near = []; this.far = [];
    for (const side of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        const X = side * (GEO.roadX + 0.35 + row * 0.72);
        for (let Z = 4.6 + R() * 0.4; Z < GEO.zEnd - 4; Z += 0.5 + R() * 0.35) {
          const fig = makeFigure(R, X + (R() - 0.5) * 0.3, Z, side);
          (Z < 34 ? this.near : this.far).push(fig);
        }
      }
    }
    for (let i = 0; i < 1100; i++) {   // dense mass at the end of the street
      const Z = 78 + R() * (GEO.zEnd - 80), X = (R() * 2 - 1) * (GEO.wallX - 0.3);
      this.far.push(makeFigure(R, X, Z, X < 0 ? -1 : 1));
    }
    this.near.sort((a, b) => b.Z - a.Z);
    this.far.sort((a, b) => b.Z - a.Z);
  }

  _buildFx() {
    const R = rng(3);
    this.grain = makeCanvas(256, 256);
    const g = this.grain.getContext('2d'), img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) { const v = R() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
    this.motes = Array.from({ length: 70 }, () => ({ x: R(), y: R(), r: 0.6 + R() * 1.8, sp: 0.004 + R() * 0.01, ph: R() * TAU }));
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
    const k = Math.min(1, 1920 / W, 1200 / H);
    W = Math.max(320, Math.round(W * k)); H = Math.max(200, Math.round(H * k));
    this.canvas.width = W; this.canvas.height = H;
    this.W = W; this.H = H;
    this.cx = W / 2; this.cy = H * GEO.horizon; this.f = H * GEO.focal;
    this._renderBackground();
    this.ready = true;
  }

  proj(X, Y, Z) { return [this.cx + this.f * X / Z, this.cy - this.f * (Y - GEO.camH) / Z]; }

  _renderBackground() {
    const { W, H, cx, cy, f } = this;
    this.bg = makeCanvas(W, H);
    const g = this.bg.getContext('2d');
    // sky
    let gr = g.createLinearGradient(0, 0, 0, cy);
    gr.addColorStop(0, '#8fa6ba'); gr.addColorStop(0.55, '#cfd1cb'); gr.addColorStop(1, '#efe5d2');
    g.fillStyle = gr; g.fillRect(0, 0, W, cy + 2);
    const R = rng(11);
    for (let i = 0; i < 14; i++) {
      const x = R() * W, y = R() * cy * 0.6, r = (0.1 + R() * 0.25) * W;
      const cg = g.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, 'rgba(255,252,245,0.22)'); cg.addColorStop(1, 'rgba(255,252,245,0)');
      g.fillStyle = cg; g.save(); g.translate(x, y); g.scale(1, 0.35); g.translate(-x, -y); g.fillRect(x - r, y - r, 2 * r, 2 * r); g.restore();
    }
    // distant hill with rooftops and a castle
    g.fillStyle = 'rgba(160,160,150,0.55)';
    g.beginPath(); g.moveTo(cx - W * 0.5, cy);
    g.bezierCurveTo(cx - W * 0.2, cy - H * 0.05, cx - W * 0.08, cy - H * 0.14, cx, cy - H * 0.15);
    g.bezierCurveTo(cx + W * 0.08, cy - H * 0.14, cx + W * 0.2, cy - H * 0.06, cx + W * 0.5, cy); g.fill();
    for (let i = 0; i < 160; i++) {
      const x = cx + (R() - 0.5) * W * 0.5, base = cy - H * 0.15 * Math.max(0, 1 - Math.abs(x - cx) / (W * 0.27)) + H * 0.01;
      const w = (4 + R() * 10) * H / 900, h = (3 + R() * 6) * H / 900;
      g.fillStyle = `rgba(${170 + R() * 20},${150 + R() * 15},${130 + R() * 15},0.7)`; g.fillRect(x, base - h, w, h);
      g.fillStyle = `rgba(${165 + R() * 15},${105 + R() * 15},${80 + R() * 10},0.75)`; g.fillRect(x - 1, base - h - 2, w + 2, 2.5);
    }
    const tower = (x, w, h, crenel) => {
      const y = cy - H * 0.13;
      g.fillStyle = 'rgba(178,172,160,0.92)'; g.fillRect(x - w / 2, y - h, w, h);
      g.fillStyle = 'rgba(140,138,132,0.5)'; g.fillRect(x - w / 2, y - h, w * 0.35, h);
      if (crenel) { for (let k = 0; k < 5; k++) if (k % 2 === 0) g.fillRect(x - w / 2 + (k / 5) * w, y - h - w * 0.15, w / 5, w * 0.15); }
      g.fillStyle = 'rgba(60,58,56,0.55)';
      for (let k = 1; k < 4; k++) g.fillRect(x - w * 0.08, y - h + (k / 4) * h * 0.8, w * 0.12, h * 0.05);
    };
    const u = H / 900;
    g.fillStyle = 'rgba(176,170,158,0.92)'; g.fillRect(cx - 70 * u, cy - H * 0.13 - 40 * u, 140 * u, 40 * u);
    tower(cx - 62 * u, 18 * u, 95 * u, true); tower(cx + 58 * u, 20 * u, 110 * u, true);
    tower(cx - 18 * u, 26 * u, 150 * u, true); tower(cx + 22 * u, 14 * u, 80 * u, true);
    g.fillStyle = 'rgba(176,170,158,0.92)';
    g.beginPath(); g.moveTo(cx - 24 * u, cy - H * 0.13 - 150 * u); g.lineTo(cx - 18 * u, cy - H * 0.13 - 195 * u); g.lineTo(cx - 12 * u, cy - H * 0.13 - 150 * u); g.fill();
    // haze over the far scenery
    gr = g.createLinearGradient(0, cy - H * 0.3, 0, cy);
    gr.addColorStop(0, 'rgba(225,220,208,0)'); gr.addColorStop(1, 'rgba(225,220,208,0.55)');
    g.fillStyle = gr; g.fillRect(0, cy - H * 0.3, W, H * 0.3 + 2);

    // building closing the far end of the street
    const zF = GEO.zEnd + 3;
    const [ex0, ey0] = this.proj(-GEO.wallX, 13, zF), [ex1, ey1] = this.proj(GEO.wallX, 0, zF);
    g.fillStyle = rgb(mixc([196, 186, 168], HAZE, 0.55)); g.fillRect(ex0, ey0, ex1 - ex0, ey1 - ey0);
    g.fillStyle = rgb(mixc([120, 80, 60], HAZE, 0.5)); g.fillRect(ex0, ey0 - 2, ex1 - ex0, 3);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      g.fillStyle = rgb(mixc([60, 70, 70], HAZE, 0.5));
      g.fillRect(ex0 + (c + 0.35) * (ex1 - ex0) / 4, ey0 + (r + 0.3) * (ey1 - ey0) / 3.4, (ex1 - ex0) / 10, (ey1 - ey0) / 8);
    }

    // walls (perspective columns sampled from the facade textures)
    const layer = makeCanvas(W, H), lg = layer.getContext('2d');
    lg.imageSmoothingEnabled = true; lg.imageSmoothingQuality = 'high';
    const P = GEO.ppm, TH = GEO.wallTexH;
    const drawWall = (tex, x0, x1, sign) => {
      for (let x = x0; x < x1; x++) {
        const d = sign < 0 ? (cx - (x + 0.5)) : ((x + 0.5) - cx);
        if (d <= 0.5) continue;
        const Z = f * GEO.wallX / d;
        if (Z > GEO.zEnd || Z < 0.4) continue;
        const yTop = cy - f * (TH - GEO.camH) / Z, yBot = cy + f * GEO.camH / Z;
        const tv = P * Z / f, th = P * Z * Z / (f * GEO.wallX);
        const lvl = clamp(Math.round(Math.log2(Math.max(1, Math.sqrt(tv * th)))), 0, tex.length - 1);
        const m = tex[lvl], sc = m.width / tex[0].width;
        const u = Math.min(m.width - 1, Z * P * sc);
        lg.drawImage(m, u, 0, Math.max(1, sc), m.height, x, yTop, 1, yBot - yTop);
      }
    };
    drawWall(this.wallL, 0, Math.ceil(cx), -1);
    drawWall(this.wallR, Math.floor(cx), W, 1);
    // distance haze, only on the painted wall pixels
    lg.globalCompositeOperation = 'source-atop';
    for (let x = 0; x < W; x++) {
      const d = Math.abs(x + 0.5 - cx); if (d <= 0.5) continue;
      const Z = f * GEO.wallX / d; if (Z > GEO.zEnd) continue;
      lg.fillStyle = rgb(HAZE, (1 - Math.exp(-Z / 80)) * 0.85);
      lg.fillRect(x, 0, 1, H);
    }
    lg.globalCompositeOperation = 'source-over';
    g.drawImage(layer, 0, 0);

    // ground rows
    const GP = GEO.gppm, GH = this.ground[0].height;
    const yStart = Math.ceil(cy + f * GEO.camH / GEO.zEnd);
    for (let y = yStart; y < H; y++) {
      const Z = f * GEO.camH / (y + 0.5 - cy);
      const xL = cx - f * GEO.wallX / Z, xR = cx + f * GEO.wallX / Z;
      const th = GP * Z / f, tv = GP * Z * Z / (f * GEO.camH);
      const lvl = clamp(Math.round(Math.log2(Math.max(1, Math.sqrt(th * tv)))), 0, this.ground.length - 1);
      const m = this.ground[lvl], sc = m.height / GH;
      const v = ((Z * GP) % GH) * sc;
      g.drawImage(m, 0, Math.min(m.height - 1, v), m.width, Math.max(1, sc), xL, y, xR - xL, 1);
      // shadow cast by the right-hand buildings
      const sx0 = cx + f * (GEO.wallX - 2.4) / Z;
      g.fillStyle = 'rgba(18,26,44,0.38)'; g.fillRect(sx0, y, xR - sx0, 1);
      g.fillStyle = 'rgba(18,26,44,0.25)'; g.fillRect(xL, y, f * 0.25 / Z, 1);   // contact shade at the left wall
      g.fillStyle = rgb(HAZE, (1 - Math.exp(-Z / 80)) * 0.85);
      g.fillRect(xL, y, xR - xL, 1);
    }

    // far crowd (static)
    const st = { t: 0, act: 0, arm: 0, pulse: 0, haze: 0 };
    for (const fig of this.far) {
      const [px, py] = this.proj(fig.X, 0, fig.Z);
      st.haze = (1 - Math.exp(-fig.Z / 80)) * 0.85;
      drawFigure(g, px, py, f / fig.Z, fig, st);
    }
  }

  // ---------------------------------------------------------------- webcam cut-out
  updateCutout(video, masks, mirror) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const sc = Math.min(1, 640 / vw);
    const cw = Math.round(vw * sc), ch = Math.round(vh * sc);
    if (this.cut.width !== cw || this.cut.height !== ch) { this.cut.width = cw; this.cut.height = ch; }
    const g = this.cutCtx;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'copy'; g.filter = 'none';
    if (mirror) g.setTransform(-1, 0, 0, 1, cw, 0);
    g.drawImage(video, 0, 0, cw, ch);
    this.hasMask = false;
    if (masks && masks.length) {
      const mw = masks[0].width, mh = masks[0].height;
      if (this.maskC.width !== mw || this.maskC.height !== mh) { this.maskC.width = mw; this.maskC.height = mh; this._maskImg = null; }
      if (!this._maskImg) this._maskImg = this.maskCtx.createImageData(mw, mh);
      const d = this._maskImg.data, n = mw * mh;
      let covered = 0;
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let k = 0; k < masks.length; k++) { const mv = masks[k].data[i]; if (mv > v) v = mv; }
        const a = clamp((v - 0.42) * 4.5, 0, 1) * 255;
        d[i * 4 + 3] = a;
        if (a > 128) covered++;
      }
      // A usable person mask covers a sensible share of the frame; otherwise fall back to a soft crop.
      const share = covered / n;
      if (share > 0.004 && share < 0.85) {
        this.maskCtx.putImageData(this._maskImg, 0, 0);
        g.globalCompositeOperation = 'destination-in'; g.filter = 'blur(1px)';
        g.drawImage(this.maskC, 0, 0, cw, ch);
        this.hasMask = true;
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.filter = 'none';
    this.cutW = cw; this.cutH = ch;
  }

  _place(p, dt) {
    const lm = p.landmarks || [];
    const vis = (i) => (lm[i] && (lm[i].visibility ?? 1)) || 0;
    const avgY = (a, b) => ((lm[a]?.y ?? 0) + (lm[b]?.y ?? 0)) / 2;
    if (!lm.length) return null;
    const shY = avgY(11, 12), noseY = lm[0].y;
    const hipY = vis(23) > 0.3 && vis(24) > 0.3 ? avgY(23, 24) : null;
    const ankY = vis(27) > 0.45 || vis(28) > 0.45 ? Math.max(lm[27].y, lm[28].y) + 0.02 : null;
    const headTop = noseY - Math.max(0.02, (shY - noseY)) * 0.9;
    let feet = ankY ?? (hipY !== null ? hipY + (hipY - shY) * 1.7 : shY + Math.max(0.05, shY - noseY) * 5.5);
    const hFull = Math.max(0.05, feet - headTop);
    const W = this.cutW, Hc = this.cutH;
    const feetPx = feet * Hc, hPx = hFull * Hc;

    let Z = clamp(4.8 / hFull, 3.4, 13);
    let X = clamp((p.center.x - 0.5) * 2 * GEO.roadX * 0.8, -2.3, 2.3);
    // If the legs are outside the camera frame, bring the person close enough that the cut edge falls below the screen.
    const fr = Math.max(0, (feetPx - Hc) / hPx);
    if (fr > 0) {
      const den = GEO.camH - 1.72 * fr;
      const zMax = den > 0.05 ? this.f * den / (this.H - this.cy) : 1.2;
      Z = Math.max(1.2, Math.min(Z, zMax * 0.97));
    }
    const prev = this.placements.get(p.id);
    const k = prev ? 1 - Math.exp(-dt / 0.25) : 1;
    const st = { X: prev ? lerp(prev.X, X, k) : X, Z: prev ? lerp(prev.Z, Z, k) : Z, seen: performance.now() };
    this.placements.set(p.id, st);
    const s = (this.f * 1.72 / st.Z) / hPx;
    const fx = this.cx + this.f * st.X / st.Z, fy = this.cy + this.f * GEO.camH / st.Z;
    const bx0 = clamp((p.bbox.x - p.bbox.w * 0.2) * W, 0, W), bx1 = clamp((p.bbox.x + p.bbox.w * 1.2) * W, 0, W);
    const by0 = clamp((headTop - 0.06) * Hc, 0, Hc);
    const cxCam = p.center.x * W;
    return {
      Z: st.Z, fx, fy, s, feetVisible: fr === 0,
      sx: bx0, sy: by0, sw: bx1 - bx0, sh: Hc - by0,
      dx: fx + (bx0 - cxCam) * s, dy: fy + (by0 - feetPx) * s,
    };
  }

  _drawPerson(g, pl) {
    if (pl.sw < 2 || pl.sh < 2) return;
    if (pl.feetVisible) {
      g.fillStyle = 'rgba(20,14,10,0.42)';
      g.beginPath(); g.ellipse(pl.fx - 0.12 * this.f / pl.Z, pl.fy, 0.34 * this.f / pl.Z, 0.05 * this.f / pl.Z, 0, 0, TAU); g.fill();
    }
    const dw = pl.sw * pl.s, dh = pl.sh * pl.s;
    g.filter = 'sepia(0.22) saturate(0.82) contrast(1.06) brightness(0.96)';
    if (this.hasMask) {
      g.drawImage(this.cut, pl.sx, pl.sy, pl.sw, pl.sh, pl.dx, pl.dy, dw, dh);
    } else {
      // no segmentation available: soft oval vignette around the person
      const tw = Math.ceil(pl.sw), th = Math.ceil(pl.sh);
      if (this.tmp.width !== tw || this.tmp.height !== th) { this.tmp.width = tw; this.tmp.height = th; }
      const t = this.tmpCtx;
      t.globalCompositeOperation = 'copy'; t.drawImage(this.cut, pl.sx, pl.sy, pl.sw, pl.sh, 0, 0, tw, th);
      t.globalCompositeOperation = 'destination-in';
      const rg = t.createRadialGradient(tw / 2, th * 0.45, Math.min(tw, th) * 0.2, tw / 2, th * 0.45, Math.max(tw, th) * 0.6);
      rg.addColorStop(0, 'rgba(0,0,0,1)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      t.fillStyle = rg; t.fillRect(0, 0, tw, th); t.globalCompositeOperation = 'source-over';
      g.drawImage(this.tmp, pl.dx, pl.dy, dw, dh);
    }
    g.filter = 'none';
  }

  /**
   * state: { active, bellAge, voiceAge, people: [{id, center, bbox, landmarks}] }
   * bellAge/voiceAge: seconds since the last bell / voice onset in the playing sound (null if not playing)
   */
  render(state) {
    if (!this.ready) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    const g = this.ctx, { W, H, f } = this;

    this.act += ((state.active ? 1 : 0) - this.act) * Math.min(1, dt * 2.2);
    this._updateCrier(dt, t, state);

    g.drawImage(this.bg, 0, 0);

    const pulse = state.active && state.voiceAge != null ? Math.exp(-Math.max(0, state.voiceAge) / 0.6) : (state.active ? 0.5 + 0.5 * Math.sin(t * 2.4) : 0);
    // people placements
    const placed = [];
    for (const p of state.people || []) { const pl = this._place(p, dt); if (pl) placed.push(pl); }
    for (const [id, st] of this.placements) if (now - st.seen > 3000) this.placements.delete(id);
    placed.sort((a, b) => b.Z - a.Z);

    const st = { t, act: this.act, arm: 0, pulse, haze: 0 };
    const crierZ = 3.4;
    let pi = 0, crierDrawn = false;
    const drawUpTo = (Z) => {
      while (pi < placed.length && placed[pi].Z > Z) this._drawPerson(g, placed[pi++]);
      if (!crierDrawn && crierZ > Z) { this._drawCrier(g, t); crierDrawn = true; }
    };
    for (const fig of this.near) {
      drawUpTo(fig.Z);
      const [px, py] = this.proj(fig.X, 0, fig.Z);
      if (px < -200 || px > W + 200) continue;
      st.haze = (1 - Math.exp(-fig.Z / 80)) * 0.85;
      const p2 = this.act > 0.01 ? Math.exp(-Math.max(0, (state.voiceAge ?? 9) - fig.delay) / 0.6) : 0;
      st.pulse = state.voiceAge != null ? p2 : pulse;
      const raw = clamp(Math.max(fig.rowdy > 0.6 ? 0.95 : 0, st.pulse * fig.jeer * 1.3), 0, 1);
      st.arm = this.act * raw * raw * (3 - 2 * raw);   // smoothstep: arms are mostly down or up, rarely half-way
      drawFigure(g, px, py, f / fig.Z, fig, st);
    }
    drawUpTo(-Infinity);

    this._drawFx(g, t);
  }

  _updateCrier(dt, t, state) {
    const c = this.crier;
    const ringing = !!state.active;
    c.lift += ((ringing ? 1 : 0) - c.lift) * Math.min(1, dt * (ringing ? 5 : 2));
    let kick = false;
    if (ringing) {
      if (state.bellAge != null && Number.isFinite(state.bellAge)) {
        if (state.bellAge < c.lastBellAge - 0.02) kick = true;
        c.lastBellAge = state.bellAge;
      } else if (t >= c.nextFallback) { kick = true; c.nextFallback = t + 0.42; }
    } else c.lastBellAge = Infinity;
    if (kick) { c.vel += 9 * c.kickDir; c.kickDir *= -1; }
    // damped spring for the bell swing
    const acc = -140 * c.swing - 7 * c.vel;
    c.vel += acc * dt; c.swing += c.vel * dt;
    c.swing = clamp(c.swing, -0.9, 0.9);
    const mouthTarget = ringing && state.voiceAge != null && state.voiceAge < 0.45 ? 1 : ringing && state.voiceAge == null ? 0.3 + 0.3 * Math.sin(t * 5) : 0;
    c.mouth += (mouthTarget - c.mouth) * Math.min(1, dt * 12);
  }

  _drawCrier(g, t) {
    const X = -2.45, Z = 3.4;
    const [px, py] = this.proj(X, 0, Z);
    const c = this.crier;
    drawCrier(g, px, py, this.f / Z, { lift: easeInOut(c.lift), swing: c.swing, mouth: c.mouth, t });
  }

  _drawFx(g, t) {
    const { W, H } = this;
    // sun shafts from the upper right
    g.save(); g.globalCompositeOperation = 'screen';
    for (let i = 0; i < 4; i++) {
      const a = 0.035 + 0.02 * Math.sin(t * 0.3 + i * 1.7);
      const x0 = W * (0.62 + i * 0.09), w0 = W * (0.05 + i * 0.015);
      const gr = g.createLinearGradient(x0, 0, x0 - W * 0.45, H);
      gr.addColorStop(0, `rgba(255,232,190,${a})`); gr.addColorStop(1, 'rgba(255,232,190,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(x0, -10); g.lineTo(x0 + w0, -10); g.lineTo(x0 + w0 - W * 0.55, H); g.lineTo(x0 - W * 0.6, H); g.fill();
    }
    // dust motes in the light
    for (const m of this.motes) {
      const x = ((m.x + t * m.sp * 0.3) % 1) * W * 0.8 + W * 0.1 + Math.sin(t * 0.7 + m.ph) * 8;
      const y = ((m.y + Math.sin(t * 0.2 + m.ph) * 0.02) % 1) * H * 0.8;
      g.fillStyle = `rgba(255,240,210,${0.18 + 0.12 * Math.sin(t + m.ph)})`;
      g.beginPath(); g.arc(x, y, m.r * H / 900, 0, TAU); g.fill();
    }
    g.restore();
    // warm grade + vignette
    g.fillStyle = 'rgba(255,200,140,0.05)'; g.fillRect(0, 0, W, H);
    const vg = g.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.35, W / 2, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,6,3,0.55)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    // film grain
    g.save(); g.globalAlpha = 0.045; g.globalCompositeOperation = 'overlay';
    const ox = (Math.random() * 256) | 0, oy = (Math.random() * 256) | 0;
    for (let y = -oy; y < H; y += 256) for (let x = -ox; x < W; x += 256) g.drawImage(this.grain, x, y);
    g.restore();
  }
}
function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
