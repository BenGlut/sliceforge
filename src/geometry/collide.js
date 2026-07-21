// Cylinder-vs-cylinder collision, conservative: each connector reservation
// is treated as a segment (its axis) with a radius. Two reservations collide
// when the segment-segment distance is under r1 + r2 + clearance.

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

// Minimum distance between segments P1+s*(Q1-P1) and P2+t*(Q2-P2), s,t in [0,1].
export function segmentDistance(p1, q1, p2, q2) {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]]
  const d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]]
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]]
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2]
  const e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2]
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2]
  let s, t
  if (a <= 1e-12 && e <= 1e-12) {
    s = t = 0
  } else if (a <= 1e-12) {
    s = 0
    t = clamp01(f / e)
  } else {
    const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2]
    if (e <= 1e-12) {
      t = 0
      s = clamp01(-c / a)
    } else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]
      const denom = a * e - b * b
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0
      t = clamp01((b * s + f) / e)
      s = clamp01((b * t - c) / a)
    }
  }
  const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s]
  const c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2])
}

// reservation: { a: [x,y,z], b: [x,y,z], r } — axis segment ends + radius.
export const PIN_CLEARANCE = 1
export function reservationsCollide(r1, r2) {
  return segmentDistance(r1.a, r1.b, r2.a, r2.b) < r1.r + r2.r + PIN_CLEARANCE
}
