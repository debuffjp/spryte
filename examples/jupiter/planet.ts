// What both threads need to know about the planet: its size, the measured jets, the belts and zones
// they make, lookup tables and the storm shape.

// Jet peaks, planetographic latitude in degrees and System III wind in m/s, east positive: the average
// of the Voyager, Hubble, Cassini and New Horizons values in John Rogers' table for the BAA Jupiter
// Section (britastro.org, "Latitudes and speeds of jets on Jupiter").
const JETS: [number, number][] = [
  [68.4, 31.1],
  [63.8, 19.6],
  [55.8, 20.6],
  [47.4, 21.3],
  [42.7, 22.3],
  [39.3, -17.8],
  [35.1, 37.3],
  [31.1, -26.8],
  [23.7, 148.5],
  [17.0, -21.5],
  [7.2, 108.7],
  [-0.4, 75.9],
  [-7.2, 139.7],
  [-19.5, -58.6],
  [-26.5, 49.0],
  [-32.3, -16.4],
  [-36.3, 38.2],
  [-43.1, 42.7],
  [-52.7, 41.1],
  [-61.0, 25.3],
  [-66.9, 29.4],
];
export const RADIUS_KM = 71_492; // equatorial
export const LAT_MAX = 88; // the map's edge
// The table stops at about 67°. Past that the wind here eases to calm at 88°: an assumption, not data.
const CALM: [number, number][] = [
  [LAT_MAX, 0],
  [-LAT_MAX, 0],
];
export const FLAT = 66_854 / 71_492; // polar over equatorial radius: Jupiter is visibly squashed
export const ROW = 0.05; // degrees per row in the lookup tables
export const ROWS = Math.round((2 * LAT_MAX) / ROW) + 1;
export const CAP = 300_000;
export const EDDIES = 40;
// How fast time runs, in simulated seconds per second: the slider's ends and its labelled stops.
export const SLOWEST = 60;
export const FASTEST = 30 * 86_400;
export const PRESETS = [600, 3600, 6 * 3600, 86_400, 4 * 86_400, 14 * 86_400] as const;
/** A span of simulated time in words: "10 minutes", "6 hours", "2 weeks". */
export function span(s: number): string {
  const [unit, size] =
    s >= 13.5 * 86_400 ? ["week", 7 * 86_400] : s >= 86_400 ? ["day", 86_400] : s >= 3600 ? ["hour", 3600] : ["minute", 60];
  const k = s / Number(size);
  const shown = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${shown} ${unit}${shown === 1 ? "" : "s"}`;
}

// Wind between two neighbouring jets eases from one peak to the other, so each peak is a true extremum.
export const wind = new Float32Array(ROWS);
export const belt = new Uint8Array(ROWS); // 1 where the shear is cyclonic: Jupiter's dark belts
{
  const jets = [...JETS, ...CALM].sort((a, b) => a[0] - b[0]);
  for (let r = 0; r < ROWS; r++) {
    const lat = -LAT_MAX + r * ROW;
    let k = 0;
    while (k < jets.length - 2 && jets[k + 1][0] < lat) k++;
    const [la, ua] = jets[k];
    const [lb, ub] = jets[k + 1];
    const t = Math.max(0, Math.min(1, (lat - la) / (lb - la)));
    wind[r] = ua + (ub - ua) * (1 - Math.cos(Math.PI * t)) * 0.5;
  }
  // Relative vorticity of a zonal flow is -du/dy: cyclonic where it has the sign of the latitude.
  for (let r = 1; r < ROWS - 1; r++) {
    const lat = -LAT_MAX + r * ROW;
    const shear = wind[r + 1] - wind[r - 1];
    belt[r] = Math.sign(lat || 1) * -shear > 0 ? 1 : 0;
  }
  belt[0] = belt[1];
  belt[ROWS - 1] = belt[ROWS - 2];
}
export const cosOf = new Float32Array(ROWS);
export const sinOf = new Float32Array(ROWS);
for (let r = 0; r < ROWS; r++) {
  cosOf[r] = Math.cos(((-LAT_MAX + r * ROW) * Math.PI) / 180);
  sinOf[r] = Math.sin(((-LAT_MAX + r * ROW) * Math.PI) / 180);
}
// Sine by longitude in ROW steps, a quarter turn longer so cosines can read it too.
export const LON_STEPS = Math.round(360 / ROW);
export const sinLon = new Float32Array(LON_STEPS + LON_STEPS / 4);
for (let k = 0; k < sinLon.length; k++) sinLon[k] = Math.sin(k * ROW * (Math.PI / 180));
export const rowOf = (lat: number): number => Math.max(0, Math.min(ROWS - 1, Math.round((lat + LAT_MAX) / ROW)));

/** A storm: a Gaussian vortex, `a` and `b` its east-west and north-south half-widths in km. */
export interface Storm {
  lon: number;
  lat: number;
  a: number;
  b: number;
  vmax: number; // peak wind around it, m/s
  spin: 1 | -1; // 1 counterclockwise seen from above
  life: number; // simulated seconds left; Infinity for the long-lived ones
  age: number; // simulated seconds since it formed
  name?: string;
  eddy?: boolean;
}
// Anticyclones turn clockwise in the north and counterclockwise in the south.
export const anticyclone = (lat: number): 1 | -1 => (lat < 0 ? 1 : -1);

/** Whether a point lies within `k` half-widths of a storm's centre. */
export function inside(s: Pick<Storm, "lon" | "lat" | "a" | "b">, x: number, y: number, k: number): boolean {
  let dl = x - s.lon;
  if (dl > 180) dl -= 360;
  else if (dl < -180) dl += 360;
  const ex = ((dl * Math.PI) / 180) * RADIUS_KM * Math.cos((s.lat * Math.PI) / 180);
  const ey = (((y - s.lat) * Math.PI) / 180) * RADIUS_KM;
  return (ex * ex) / (s.a * s.a) + (ey * ey) / (s.b * s.b) < k * k;
}

/** One frame of tracers from the worker. Its buffers go back to the worker once a newer one arrives. */
export interface Snapshot {
  lon: Float32Array;
  lat: Float32Array;
  colors: Uint32Array;
  n: number;
  days: number;
  catchingUp: boolean;
  stepMs: number;
  rate: number; // simulated seconds per second the worker actually managed, jumps aside
  named: Pick<Storm, "lon" | "lat" | "a" | "b" | "name">[];
}
