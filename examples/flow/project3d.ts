// The 3D modes' camera: turn the scene by yaw about the vertical axis, tilt it by pitch, then a
// perspective divide. z is up; positive depth is toward the camera.

export interface Camera {
  yaw: number;
  pitch: number;
}

export interface View {
  cy: number;
  sy: number;
  cp: number;
  sp: number;
  unit: number; // screen pixels per world unit at the centre
  eye: number; // camera distance in world units
  W: number;
  H: number;
}

export function view(camera: Camera, W: number, H: number, unit: number, eye: number): View {
  return {
    cy: Math.cos(camera.yaw),
    sy: Math.sin(camera.yaw),
    cp: Math.cos(camera.pitch),
    sp: Math.sin(camera.pitch),
    unit,
    eye,
    W,
    H,
  };
}

/** Projects (x, y, z) into copy i: screen position into `positions`, size times perspective into `scales`. */
export function project(
  v: View,
  positions: Float32Array,
  scales: Float32Array,
  i: number,
  x: number,
  y: number,
  z: number,
  size: number,
): void {
  const rx = x * v.cy - y * v.sy;
  const ry = x * v.sy + y * v.cy;
  const up = z * v.cp - ry * v.sp;
  const depth = ry * v.cp + z * v.sp;
  const f = v.eye / (v.eye - depth);
  positions[i * 2] = v.W / 2 + rx * f * v.unit;
  positions[i * 2 + 1] = v.H / 2 - up * f * v.unit;
  scales[i] = size * f;
}
