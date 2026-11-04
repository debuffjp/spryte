// Turns the RCSB entry 7N1P (an E. coli 70S ribosome caught mid-elongation, with tRNAs in the A and P
// sites) into atoms.dat for the ribosome example.
// Usage: node convert.mjs path/to/7N1P.cif
// Source: https://files.rcsb.org/download/7N1P.cif
//
// Keeps every polymer heavy atom and drops ions, water and small molecules. The A-site tRNA (chain Pt)
// is dropped too: the demo draws every tRNA as a copy of the P-site one (chain Dt), moved between sites.
//
// atoms.dat is gzipped, because the site serves binary files uncompressed. Inside (little-endian):
// uint32 count, 15 float32 markers in angstroms (A-site tRNA centre, P-site tRNA centre, peptidyl
// transferase centre, tunnel exit, one codon step along the mRNA), then the coordinates in tenths of an
// angstrom as int16 differences from the atom before, all x, then all y, then all z, stored as a plane
// of low bytes then a plane of high bytes. Neighbouring atoms in the file are neighbours in space, so the
// differences are small and compress well. Then count uint8 elements (0 C, 1 N, 2 O, 3 P, 4 S, 5 other)
// and count uint8 groups (0 23S rRNA, 1 5S rRNA, 2 16S rRNA, 3 large-subunit protein, 4 small-subunit
// protein, 5 mRNA, 6 tRNA). Everything is centred on the ribosome.
//
// Also writes amino.json: one example of each of the 20 amino acids, taken from the ribosomal proteins,
// as [element, x, y, z] atoms in the residue's own frame (CA at the origin, x along N to C, y toward
// CA), and the sequence of protein L23, which the demo's ribosome builds.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const lines = readFileSync(process.argv[2], "utf8").split("\n");
const header = [];
let first = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith("_atom_site.")) {
    if (first < 0) first = i;
    header.push(lines[i].trim().slice(11));
  } else if (first >= 0) break;
}
const col = Object.fromEntries(header.map((name, i) => [name, i]));
const ELEMENTS = ["C", "N", "O", "P", "S"];

function groupOf(chain) {
  if (chain === "23") return 0;
  if (chain === "5") return 1;
  if (chain === "16") return 2;
  if (chain === "mR") return 5;
  if (chain === "Dt") return 6;
  if (chain[0] === "L") return 3;
  if (chain[0] === "S") return 4;
  return -1;
}

const atoms = [];
const residues = new Map(); // "chain:seq" -> { name, atoms: Map(atom name -> [element, x, y, z]) }
const L23 = [];
const marks = { A: [], P: [], ptc: [], exit: [], codonA: [], codonP: [] };
for (let i = first + header.length; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith("#")) break;
  const f = line.split(/\s+/);
  if (f[col.label_seq_id] === ".") continue; // ions, water and ligands
  const element = f[col.type_symbol];
  if (element === "H") continue;
  const chain = f[col.auth_asym_id];
  const seq = Number(f[col.auth_seq_id]);
  const p = [Number(f[col.Cartn_x]), Number(f[col.Cartn_y]), Number(f[col.Cartn_z])];
  if (chain === "Pt") marks.A.push(p);
  if (chain === "Dt") marks.P.push(p);
  if (chain === "Dt" && seq === 76) marks.ptc.push(p); // the CCA end, which reaches into the PTC
  if (chain === "LW" || chain === "LX") marks.exit.push(p); // L23 and L24 ring the tunnel exit
  // Codons 44-46 and 41-43 pair with the A- and P-site anticodons in this entry.
  if (chain === "mR" && seq >= 44 && seq <= 46) marks.codonA.push(p);
  if (chain === "mR" && seq >= 41 && seq <= 43) marks.codonP.push(p);
  // Standard amino acids in the proteins: keep each residue's atoms to pick templates from.
  if (f[0] === "ATOM" && (chain[0] === "L" || chain[0] === "S") && chain.length === 2) {
    const key = `${chain}:${seq}`;
    let r = residues.get(key);
    if (!r) {
      r = { name: f[col.label_comp_id], atoms: new Map() };
      residues.set(key, r);
      if (chain === "LW") L23.push(r.name);
    }
    // OXT only exists on a chain's last residue; inside a chain that oxygen is the next peptide bond.
    if (f[col.label_atom_id] !== "OXT") r.atoms.set(f[col.label_atom_id], [ELEMENTS.indexOf(element), ...p]);
  }
  const group = groupOf(chain);
  if (group < 0) continue;
  const e = ELEMENTS.indexOf(element);
  atoms.push({ p, element: e < 0 ? 5 : e, group });
}

const n = atoms.length;
const mid = [0, 1, 2].map((k) => atoms.reduce((s, a) => s + a.p[k], 0) / n);
const centre = (ps) => [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / ps.length - mid[k]);
const codonA = centre(marks.codonA);
const codonP = centre(marks.codonP);
const markers = [
  ...centre(marks.A),
  ...centre(marks.P),
  ...centre(marks.ptc),
  ...centre(marks.exit),
  ...[0, 1, 2].map((k) => codonP[k] - codonA[k]),
];

const buf = Buffer.alloc(4 + 60 + n * 8);
buf.writeUInt32LE(n, 0);
markers.forEach((v, k) => {
  buf.writeFloatLE(v, 4 + k * 4);
});
const base = 64;
for (const k of [0, 1, 2]) {
  let prev = 0;
  for (const [i, a] of atoms.entries()) {
    const v = Math.round((a.p[k] - mid[k]) * 10);
    const d = v - prev;
    if (d < -32768 || d > 32767) throw new Error(`a step of ${d / 10} angstroms is past int16`);
    prev = v;
    buf.writeUInt8(d & 255, base + k * n + i);
    buf.writeUInt8((d >> 8) & 255, base + 3 * n + k * n + i);
  }
}
for (const [i, a] of atoms.entries()) {
  buf.writeUInt8(a.element, base + n * 6 + i);
  buf.writeUInt8(a.group, base + n * 7 + i);
}
const packed = gzipSync(buf, { level: 9 });
writeFileSync(new URL("./atoms.dat", import.meta.url), packed);
console.log(`${n} atoms, ${packed.length} bytes gzipped`);
console.log("markers", markers.map((v) => v.toFixed(1)).join(" "));

// For each amino acid, the most complete residue (the most atoms) becomes its template.
const best = new Map();
for (const r of residues.values()) {
  if (!r.atoms.has("N") || !r.atoms.has("CA") || !r.atoms.has("C")) continue;
  if ((best.get(r.name)?.atoms.size ?? 0) < r.atoms.size) best.set(r.name, r);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const templates = {};
for (const [name, r] of [...best].sort()) {
  const [n, ca, c] = ["N", "CA", "C"].map((k) => r.atoms.get(k).slice(1));
  const x = norm(sub(c, n));
  const toCa = sub(ca, n);
  const y = norm(
    sub(
      toCa,
      x.map((v) => v * dot(toCa, x)),
    ),
  );
  const z = cross(x, y);
  templates[name] = [...r.atoms.values()].map(([e, ...p]) => {
    const d = sub(p, ca);
    return [e < 0 ? 5 : e, ...[x, y, z].map((axis) => Math.round(dot(d, axis) * 100) / 100)];
  });
}
writeFileSync(
  new URL("./amino.json", import.meta.url),
  `${JSON.stringify({ templates, sequence: L23 })}
`,
);
console.log(`${Object.keys(templates).length} amino acid templates, L23 is ${L23.length} residues`);
