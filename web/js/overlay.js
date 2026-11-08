// Canvas overlay: skeletons, boxes, IDs, confidence, target marker, frame guides.
// All inputs are in display coordinates (already mirrored if mirror view is on).

const COLORS = {
  other: 'rgba(148, 163, 184, 0.9)',
  pending: 'rgba(250, 204, 21, 0.9)',
  target: '#22d3ee',
  lost: '#f97316',
  guide: 'rgba(255,255,255,0.25)',
};

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.connections = [];
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  draw({ tracks, targetId, targetLost, aimX, showSkeleton = true }) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // center guide
    ctx.strokeStyle = COLORS.guide; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.setLineDash([]);

    const lw = Math.max(2, W / 400);
    for (const t of tracks) {
      if (!t.visible && t.id !== targetId) continue;
      const isTarget = t.id === targetId;
      const color = isTarget ? (targetLost ? COLORS.lost : COLORS.target) : (t.confirmed ? COLORS.other : COLORS.pending);
      ctx.globalAlpha = t.visible ? 1 : 0.45;

      if (showSkeleton && t.landmarks && t.visible) {
        ctx.strokeStyle = color; ctx.lineWidth = lw;
        ctx.beginPath();
        for (const { start, end } of this.connections) {
          const a = t.landmarks[start], b = t.landmarks[end];
          if (!a || !b || (a.visibility ?? 1) < 0.4 || (b.visibility ?? 1) < 0.4) continue;
          ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H);
        }
        ctx.stroke();
      }

      // box
      const { x, y, w, h } = t.bbox;
      ctx.strokeStyle = color; ctx.lineWidth = isTarget ? lw * 1.8 : lw;
      ctx.setLineDash(t.confirmed ? [] : [8, 6]);
      ctx.strokeRect(x * W, y * H, w * W, h * H);
      ctx.setLineDash([]);

      // label
      const label = `#${t.id} ${t.confirmed ? '' : '(confirming) '}${Math.round((t.confidence || 0) * 100)}%${isTarget ? (targetLost ? ' • LOST' : ' • TARGET') : ''}`;
      ctx.font = `600 ${Math.max(12, W / 70)}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 10, th = Math.max(18, W / 50);
      const lx = Math.min(Math.max(0, x * W), W - tw), ly = Math.max(0, y * H - th - 2);
      ctx.fillStyle = color; ctx.fillRect(lx, ly, tw, th);
      ctx.fillStyle = '#0b1220'; ctx.fillText(label, lx + 5, ly + th * 0.72);

      // tracking point
      if (isTarget) {
        const cx = t.center.x * W, cy = t.center.y * H, r = Math.max(10, W / 60);
        ctx.strokeStyle = color; ctx.lineWidth = lw * 1.5;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - r * 1.8, cy); ctx.lineTo(cx - r * 0.5, cy);
        ctx.moveTo(cx + r * 0.5, cy); ctx.lineTo(cx + r * 1.8, cy);
        ctx.moveTo(cx, cy - r * 1.8); ctx.lineTo(cx, cy - r * 0.5);
        ctx.moveTo(cx, cy + r * 0.5); ctx.lineTo(cx, cy + r * 1.8);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // filtered aim position (what the servo is steering to)
    if (Number.isFinite(aimX)) {
      ctx.strokeStyle = COLORS.target; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(aimX * W, H - 18); ctx.lineTo(aimX * W, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(aimX * W - 8, H - 18); ctx.lineTo(aimX * W + 8, H - 18); ctx.lineTo(aimX * W, H - 8); ctx.closePath();
      ctx.fillStyle = COLORS.target; ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}
