// Turns NASA's Meteorite_Landings.csv into meteorites.bin for the lens example.
// Usage: node convert.mjs path/to/Meteorite_Landings.csv
// Source: https://data.nasa.gov/docs/legacy/meteorite_landings/Meteorite_Landings.csv
//
// Layout (little-endian): uint32 count, then count int16 longitudes (x100), count int16
// latitudes (x100), count uint16 (log10(mass in grams) + 2) x1000, count uint16 years,
// count uint8 fell (1) or found (0).
import { readFileSync, writeFileSync } from "node:fs";

const csv = readFileSync(process.argv[2], "utf8");
const rows = [];
for (const line of csv.split(/\r?\n/).slice(1)) {
  if (!line) continue;
  // The name and GeoLocation columns can hold quoted commas.
  const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ""));
  const [, , , , massCol, fall, yearCol, latCol, lonCol] = cols;
  const mass = Number(massCol);
  const year = Number(yearCol);
  const lat = Number(latCol);
  const lon = Number(lonCol);
  // Drop rows with no mass, year or position, the 0, 0 placeholders and impossible years.
  if (!massCol || !yearCol || !latCol || !lonCol || !(mass > 0)) continue;
  if (lat === 0 && lon === 0) continue;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
  if (!(year > 0 && year <= 2013)) continue;
  rows.push({ lon, lat, mass, year, fell: fall === "Fell" ? 1 : 0 });
}

const n = rows.length;
const buf = Buffer.alloc(4 + n * 9);
buf.writeUInt32LE(n, 0);
rows.forEach((r, i) => {
  buf.writeInt16LE(Math.round(r.lon * 100), 4 + i * 2);
  buf.writeInt16LE(Math.round(r.lat * 100), 4 + n * 2 + i * 2);
  buf.writeUInt16LE(Math.max(0, Math.round((Math.log10(r.mass) + 2) * 1000)), 4 + n * 4 + i * 2);
  buf.writeUInt16LE(r.year, 4 + n * 6 + i * 2);
  buf.writeUInt8(r.fell, 4 + n * 8 + i);
});
writeFileSync(new URL("./meteorites.bin", import.meta.url), buf);
console.log(`${n} meteorites, ${buf.length} bytes`);
