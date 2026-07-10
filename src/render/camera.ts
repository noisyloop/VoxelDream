// Orbit camera. Pure math, no DOM — input wiring lives in main.ts.
//
// The tracer wants a position and an orthonormal basis; the picker wants a
// world-space ray through a screen point. Both come from here. `version`
// increments on any change so the renderer knows to reset accumulation.

export class OrbitCamera {
  // The Dream 01 room is sealed; the camera lives INSIDE it, orbiting the
  // room's heart. Dolly is clamped so you can never back through a wall.
  yaw = 0.8;
  pitch = 0.12;
  distance = 19;
  target: [number, number, number] = [32, 24, 32];
  /** Vertical field of view in radians. */
  fov = (55 * Math.PI) / 180;
  /** Bumped on every mutation; consumers compare to detect motion. */
  version = 0;

  orbit(dyaw: number, dpitch: number): void {
    this.yaw += dyaw;
    // Clamped so the orbit sphere stays clear of floor, ceiling and pillars.
    this.pitch = Math.max(-0.95, Math.min(0.95, this.pitch + dpitch));
    this.version++;
  }

  dolly(factor: number): void {
    this.distance = Math.max(4, Math.min(20, this.distance * factor));
    this.version++;
  }

  get position(): [number, number, number] {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  /** Right/up/forward unit vectors (forward points at the target). */
  get basis(): { right: [number, number, number]; up: [number, number, number]; forward: [number, number, number] } {
    const p = this.position;
    const f = norm([this.target[0] - p[0], this.target[1] - p[1], this.target[2] - p[2]]);
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    return { right: r, up: u, forward: f };
  }

  /** World-space ray through a screen point (px, py in CSS pixels). */
  ray(px: number, py: number, width: number, height: number): { origin: [number, number, number]; dir: [number, number, number] } {
    const { right, up, forward } = this.basis;
    const tanF = Math.tan(this.fov / 2);
    const aspect = width / height;
    const ndcX = ((px / width) * 2 - 1) * tanF * aspect;
    const ndcY = (1 - (py / height) * 2) * tanF;
    return {
      origin: this.position,
      dir: norm([
        forward[0] + right[0] * ndcX + up[0] * ndcY,
        forward[1] + right[1] * ndcX + up[1] * ndcY,
        forward[2] + right[2] * ndcX + up[2] * ndcY,
      ]),
    };
  }
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
