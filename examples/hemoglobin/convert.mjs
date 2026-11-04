// Turns the RCSB entry 4HHB (human deoxyhemoglobin) into atoms.bin for the hemoglobin example.
// Usage: node convert.mjs path/to/4HHB.pdb
// Source: https://files.rcsb.org/download/4HHB.pdb
//
// Keeps every heavy atom of the four chains and their haem groups, and drops water.
// Layout (little-endian): uint32 count, then count int16 x, y, z triples (angstroms x100, centred on
// the molecule), count uint8 elements (0 C, 1 N, 2 O, 3 S, 4 Fe, 5 other), count uint8 chains
// (0 A, 1 B, 2 C, 3 D) and count uint8 flags (1 = part of a haem group).
import { readFileSync, writeFileSync } from "node:fs";

const ELEMENTS = ["C", "N", "O", "S", "FE"];
const atoms = [];
for (const line of readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const record = line.slice(0, 6).trim();
  if (record !== "ATOM" && record !== "HETATM") continue;
  const residue = line.slice(17, 20).trim();
  const element = line.slice(76, 78).trim();
  if (residue === "HOH" || element === "H") continue;
  const chain = "ABCD".indexOf(line[21]);
  if (chain < 0) continue;
  const e = ELEMENTS.indexOf(element);
  atoms.push({
    x: Number(line.slice(30, 38)),
    y: Number(line.slice(38, 46)),
    z: Number(line.slice(46, 54)),
    element: e < 0 ? 5 : e,
    chain,
    haem: residue === "HEM" ? 1 : 0,
  });
}

const n = atoms.length;
const mid = ["x", "y", "z"].map((k) => atoms.reduce((s, a) => s + a[k], 0) / n);
const buf = Buffer.alloc(4 + n * 9);
buf.writeUInt32LE(n, 0);
atoms.forEach((a, i) => {
  for (const [j, k] of ["x", "y", "z"].entries()) buf.writeInt16LE(Math.round((a[k] - mid[j]) * 100), 4 + (i * 3 + j) * 2);
  buf.writeUInt8(a.element, 4 + n * 6 + i);
  buf.writeUInt8(a.chain, 4 + n * 7 + i);
  buf.writeUInt8(a.haem, 4 + n * 8 + i);
});
writeFileSync(new URL("./atoms.bin", import.meta.url), buf);
console.log(`${n} atoms, ${buf.length} bytes`);
