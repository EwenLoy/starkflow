import * as THREE from 'three';

const TAU = Math.PI * 2;
// A lathe profile may touch the axis but never cross it: a zero radius makes
// degenerate triangles and, worse, NaN normals that show up as black specks.
const AXIS = 0.0009;

/* ------------------------------------------------------------------ material */

function seeded(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Marble and onyx for the pieces. A flat colour made them read as plastic; a
 * few veins and a bump map are what turn the set into carved stone — and the
 * veins also give the eye something to follow along a turned profile.
 */
function stoneTexture({ base, vein, fleck, seed = 7, repeat = 1.5 }) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = seeded(seed);

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const wash = ctx.createRadialGradient(size * 0.3, size * 0.2, 12, size * 0.6, size * 0.7, size * 0.95);
  wash.addColorStop(0, 'rgba(255,255,255,0.16)');
  wash.addColorStop(0.6, 'rgba(255,255,255,0)');
  wash.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 22; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const length = 90 + rand() * 380;
    const angle = (rand() - 0.5) * 1.1 + (i % 4 === 0 ? 1.2 : 0);
    ctx.beginPath();
    ctx.moveTo(x, y);
    let px = x;
    let py = y;
    for (let j = 0; j < 8; j += 1) {
      px += Math.cos(angle + (rand() - 0.5) * 0.45) * (length / 8);
      py += Math.sin(angle + (rand() - 0.5) * 0.45) * (length / 8);
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = vein;
    ctx.globalAlpha = 0.12 + rand() * 0.26;
    ctx.lineWidth = 0.6 + rand() * 2.6;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < 700; i += 1) {
    ctx.fillStyle = rand() > 0.45 ? fleck : 'rgba(0,0,0,0.14)';
    ctx.globalAlpha = 0.03 + rand() * 0.12;
    ctx.fillRect(rand() * size, rand() * size, 0.5 + rand() * 1.6, 0.5 + rand() * 1.6);
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  return texture;
}

const ivoryStone = stoneTexture({
  base: '#f4ecd9',
  vein: '#b6a488',
  fleck: 'rgba(255,252,240,.8)',
  seed: 13,
  repeat: 1.4,
});

const onyxStone = stoneTexture({
  base: '#232a30',
  vein: '#4a5a66',
  fleck: 'rgba(150,175,190,.35)',
  seed: 29,
  repeat: 1.4,
});

// Polished marble, not plastic: a clearcoat picks up the candle flames, and the
// bump map gives the veins something to catch.
const ivoryMaterial = new THREE.MeshPhysicalMaterial({
  map: ivoryStone,
  bumpMap: ivoryStone,
  bumpScale: 0.004,
  color: 0xffffff,
  roughness: 0.3,
  metalness: 0.03,
  clearcoat: 0.45,
  clearcoatRoughness: 0.32,
  sheen: 0.2,
  sheenColor: 0xfff6e4,
  envMapIntensity: 0.55,
});

// Graphite, not black. The old value (0x0a0c0e) was darker than the dark
// squares, so on a phone every black piece collapsed into one silhouette.
const onyxMaterial = new THREE.MeshPhysicalMaterial({
  map: onyxStone,
  bumpMap: onyxStone,
  bumpScale: 0.005,
  color: 0xffffff,
  roughness: 0.26,
  metalness: 0.12,
  clearcoat: 0.55,
  clearcoatRoughness: 0.3,
  sheen: 0.35,
  sheenColor: 0x93aabc,
  emissive: 0x0d1216,
  emissiveIntensity: 0.45,
  envMapIntensity: 0.8,
});

// Gold has to fight for contrast in two directions: on ivory it must be deeper
// and warmer, on graphite it must be bright. One brass for both sets was a
// compromise that made the white trim vanish.
const brass = new THREE.MeshStandardMaterial({
  color: 0xa8813f,
  roughness: 0.28,
  metalness: 0.92,
  emissive: 0x1d1102,
  emissiveIntensity: 0.3,
  envMapIntensity: 1.05,
});

const darkBrass = new THREE.MeshStandardMaterial({
  color: 0xd8b26a,
  roughness: 0.2,
  metalness: 0.95,
  emissive: 0x2c1c06,
  emissiveIntensity: 0.45,
  envMapIntensity: 1.3,
});

// The sculpted knight has its own baked texture, which read as silver plastic
// next to the turned set and made both sides look white. These two keep it in
// the same palette: no map, same clearcoat, same value.
const sculptIvory = new THREE.MeshPhysicalMaterial({
  color: 0xf1e7d2,
  roughness: 0.34,
  metalness: 0.03,
  clearcoat: 0.4,
  clearcoatRoughness: 0.34,
  sheen: 0.2,
  sheenColor: 0xfff6e4,
  envMapIntensity: 0.5,
});

const sculptOnyx = new THREE.MeshPhysicalMaterial({
  color: 0x232a30,
  roughness: 0.28,
  metalness: 0.1,
  clearcoat: 0.5,
  clearcoatRoughness: 0.3,
  sheen: 0.35,
  sheenColor: 0x93aabc,
  emissive: 0x0d1216,
  emissiveIntensity: 0.4,
  envMapIntensity: 0.8,
});

// Eyes have to survive a 26 px silhouette: dark on ivory, warm on graphite.
const eyeDark = new THREE.MeshStandardMaterial({ color: 0x211509, roughness: 0.24, metalness: 0.3 });
const eyeWarm = new THREE.MeshStandardMaterial({
  color: 0x9a7745,
  roughness: 0.3,
  metalness: 0.5,
  emissive: 0x241a0c,
  emissiveIntensity: 0.4,
});

/* ------------------------------------------------------------------- helpers */

/** A lathe profile smoothed into a turned, hand-made shape instead of a stack of discs. */
function smooth(list, divisions = 28) {
  const points = list.map(([x, y]) => new THREE.Vector2(Math.max(x, AXIS), Math.max(y, 0)));
  const curve = new THREE.SplineCurve(points);
  const out = curve.getPoints(divisions).map((p) => new THREE.Vector2(Math.max(p.x, AXIS), p.y));
  // Pin the ends on the axis so the solid closes without a pinch.
  out[0].x = AXIS;
  out[out.length - 1].x = AXIS;
  for (const p of out) {
    p.x = Math.max(p.x, AXIS);
    p.y = Math.max(p.y, 0);
  }
  return out;
}

/**
 * A turned solid. The profile is written in normalised units (radius 0..1,
 * height 0..1) and scaled per piece, which keeps every silhouette comparable
 * while the actual radii and heights stay explicit at the call site.
 */
function turned(profile, radius, height, segments = 36) {
  const points = smooth(profile).map((p) => new THREE.Vector2(p.x * radius, p.y * height));
  const geometry = new THREE.LatheGeometry(points, segments);
  geometry.computeVertexNormals();
  return geometry;
}

/** Concatenate transformed parts into one buffer: one draw call per material. */
function mergeParts(entries) {
  let total = 0;
  const prepared = entries.map(({ geometry, matrix }) => {
    const piece = geometry.index ? geometry.toNonIndexed() : geometry;
    if (piece !== geometry) geometry.dispose();
    if (matrix) piece.applyMatrix4(matrix);
    if (!piece.attributes.uv) {
      const count = piece.attributes.position.count;
      piece.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    total += piece.attributes.position.count;
    return piece;
  });

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let offset = 0;
  for (const piece of prepared) {
    position.set(piece.attributes.position.array, offset * 3);
    normal.set(piece.attributes.normal.array, offset * 3);
    uv.set(piece.attributes.uv.array, offset * 2);
    offset += piece.attributes.position.count;
    piece.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** Collects primitives per material, then bakes them into a couple of meshes. */
class Parts {
  constructor() {
    this.groups = new Map();
  }

  add(material, geometry, { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] } = {}) {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(position[0], position[1], position[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
      new THREE.Vector3(scale[0], scale[1], scale[2]),
    );
    const list = this.groups.get(material);
    if (list) list.push({ geometry, matrix });
    else this.groups.set(material, [{ geometry, matrix }]);
    return this;
  }

  attach(group) {
    for (const [material, entries] of this.groups) {
      const mesh = new THREE.Mesh(mergeParts(entries), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

/**
 * A lofted solid: a spine of elliptical cross-sections stitched into one skin.
 * An extruded profile has two flat cheeks, so from the front it is a plank; a
 * loft has volume from every angle, which is what a horse's head needs.
 */
function loft(sections, segments = 26) {
  const rings = [];
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    const prev = sections[Math.max(0, i - 1)];
    const next = sections[Math.min(sections.length - 1, i + 1)];
    const tangent = new THREE.Vector3(0, next.y - prev.y, next.z - prev.z).normalize();
    // The ring lives in the plane perpendicular to the spine; its "side" is
    // always the board's X axis, so the piece stays symmetric.
    const side = new THREE.Vector3(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(side, tangent).normalize();
    const ring = [];
    for (let j = 0; j < segments; j += 1) {
      const a = (j / segments) * TAU;
      ring.push(
        new THREE.Vector3(
          Math.cos(a) * s.rx,
          s.y + Math.sin(a) * s.ry * up.y,
          s.z + Math.sin(a) * s.ry * up.z,
        ),
      );
    }
    rings.push(ring);
  }

  const positions = [];
  const indices = [];
  for (const ring of rings) {
    for (const point of ring) positions.push(point.x, point.y, point.z);
  }
  for (let i = 0; i < rings.length - 1; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = (i + 1) * segments + j;
      const d = (i + 1) * segments + ((j + 1) % segments);
      indices.push(a, c, b, b, c, d);
    }
  }

  // Caps, so the muzzle is not an open tube.
  for (const [index, flip] of [
    [0, true],
    [rings.length - 1, false],
  ]) {
    const section = sections[index];
    const center = positions.length / 3;
    positions.push(0, section.y, section.z);
    for (let j = 0; j < segments; j += 1) {
      const a = index * segments + j;
      const b = index * segments + ((j + 1) % segments);
      if (flip) indices.push(center, b, a);
      else indices.push(center, a, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/* --------------------------------------------------------------- gold marks */

/**
 * A thin gold line. The set has one above every foot, and then a mark of its own
 * on the top third — which is the part a player actually sees from above.
 */
function addRing(parts, accent, radius, y, tube = 0.008) {
  parts.add(accent, new THREE.TorusGeometry(radius, tube, 6, 36), {
    position: [0, y, 0],
    rotation: [Math.PI / 2, 0, 0],
  });
}

/* ----------------------------------------------------------- contact shadow */

let contactTexture = null;
let contactGeometry = null;
let contactMaterial = null;

/**
 * The single strongest readability cue on a dark board is not another light: it
 * is the dark ring where a piece meets the wood. It also plants the piece, so a
 * knight no longer looks like it is hovering.
 */
function contactShadow(radius) {
  if (!contactTexture) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.06, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(0,0,0,0.62)');
    gradient.addColorStop(0.42, 'rgba(0,0,0,0.4)');
    gradient.addColorStop(0.72, 'rgba(0,0,0,0.12)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    contactTexture = new THREE.CanvasTexture(canvas);
    contactTexture.colorSpace = THREE.SRGBColorSpace;
    contactGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    contactMaterial = new THREE.MeshBasicMaterial({
      map: contactTexture,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      toneMapped: false,
    });
  }
  const mesh = new THREE.Mesh(contactGeometry, contactMaterial);
  mesh.scale.setScalar(radius * 2.15);
  mesh.position.y = 0.0016;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 1;
  // Marked so createPiece's traverse does not switch its shadow back on: a
  // 0.8-unit plane casting a shadow is a black square on the table.
  mesh.userData.shadowBlob = true;
  // A shadow is not a hit target: the pointer must keep picking the square.
  mesh.raycast = () => {};
  return mesh;
}

/* ------------------------------------------------------------------ profiles */

// A pawn has exactly one job on a small screen: be the only piece with a ball
// on top and no collar rings. Wide foot, narrow waist, a real head — the old
// profile was a peg with a bead on it.
const PAWN = [
  [1, 0], [1, 0.022], [0.97, 0.045], [0.9, 0.062], [0.8, 0.078],
  [0.68, 0.1], [0.6, 0.13], [0.55, 0.18], [0.52, 0.26], [0.5, 0.34], [0.49, 0.4],
  [0.56, 0.44], [0.6, 0.47], [0.54, 0.5], [0.46, 0.53],
  [0.43, 0.57], [0.42, 0.61],
  [0.47, 0.65], [0.56, 0.72], [0.6, 0.79], [0.55, 0.87], [0.42, 0.94], [0.24, 0.985], [0.02, 1],
];

// A rook is the only flat-topped piece: a wide drum with a rim and merlons.
const ROOK = [
  [1, 0], [1, 0.02], [0.96, 0.04], [0.87, 0.058], [0.78, 0.075],
  [0.7, 0.1], [0.66, 0.15], [0.64, 0.25], [0.635, 0.4], [0.65, 0.52],
  [0.76, 0.56], [0.86, 0.6], [0.88, 0.65], [0.86, 0.69],
  [0.82, 0.72], [0.82, 0.8], [0.78, 0.84], [0.7, 0.85], [0.5, 0.855], [0.02, 0.86],
];

// A bishop: narrow waist, tall mitre, a point instead of a ball.
const BISHOP = [
  [1, 0], [1, 0.02], [0.96, 0.04], [0.86, 0.058], [0.76, 0.075],
  [0.66, 0.1], [0.6, 0.15], [0.56, 0.22], [0.53, 0.3], [0.52, 0.38],
  [0.57, 0.42], [0.62, 0.45], [0.58, 0.48], [0.5, 0.51], [0.47, 0.55],
  [0.5, 0.6], [0.6, 0.66], [0.64, 0.72], [0.6, 0.78], [0.5, 0.84], [0.36, 0.9], [0.22, 0.95], [0.1, 0.985], [0.02, 1],
];

const QUEEN = [
  [1, 0], [1, 0.016], [0.96, 0.032], [0.86, 0.05], [0.76, 0.066], [0.68, 0.09],
  [0.62, 0.14], [0.58, 0.21], [0.55, 0.29], [0.53, 0.37],
  [0.6, 0.42], [0.64, 0.45], [0.58, 0.49], [0.5, 0.53], [0.48, 0.58],
  [0.52, 0.64], [0.57, 0.7], [0.59, 0.76], [0.55, 0.82], [0.5, 0.87],
  [0.52, 0.92], [0.56, 0.96], [0.5, 1],
];

const KING = [
  [1, 0], [1, 0.015], [0.96, 0.03], [0.86, 0.048], [0.76, 0.064], [0.68, 0.088],
  [0.62, 0.135], [0.58, 0.2], [0.55, 0.28], [0.53, 0.36],
  [0.6, 0.41], [0.64, 0.44], [0.58, 0.48], [0.5, 0.52], [0.48, 0.57],
  [0.52, 0.63], [0.57, 0.69], [0.59, 0.75], [0.55, 0.81], [0.5, 0.86],
  [0.52, 0.91], [0.56, 0.95], [0.5, 1],
];

/* -------------------------------------------------------------------- pieces */

function createPawn(material, accent) {
  const radius = 0.3;
  const height = 0.84;
  const parts = new Parts();
  parts.add(material, turned(PAWN, radius, height));
  addRing(parts, accent, radius * 0.9, 0.062, 0.012);
  // One gold line under the ball: from above a pawn is the piece with a dot.
  addRing(parts, accent, radius * 0.43, height * 0.62, 0.009);
  const group = parts.attach(new THREE.Group());
  group.add(contactShadow(radius));
  group.userData.height = height;
  group.userData.radius = radius;
  return group;
}

function createRook(material, accent) {
  const radius = 0.355;
  // The profile tops out at 0.86 of the height; the merlons finish the piece.
  const height = 1.06;
  const parts = new Parts();
  parts.add(material, turned(ROOK, radius, height));

  // Chunky merlons: thin slabs read as a fence, not as a rook.
  const merlon = new THREE.BoxGeometry(0.09, 0.13, 0.075);
  const cap = new THREE.BoxGeometry(0.095, 0.024, 0.08);
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * TAU;
    parts.add(material, merlon.clone(), {
      position: [Math.cos(angle) * 0.245, 0.975, Math.sin(angle) * 0.245],
      rotation: [0, -angle, 0],
    });
    // Gold caps: from above a rook is a gold hexagon.
    parts.add(accent, cap.clone(), {
      position: [Math.cos(angle) * 0.245, 1.045, Math.sin(angle) * 0.245],
      rotation: [0, -angle, 0],
    });
  }
  merlon.dispose();
  cap.dispose();

  addRing(parts, accent, radius * 0.9, 0.06, 0.012);
  addRing(parts, accent, 0.312, 0.7, 0.01);
  
  const group = parts.attach(new THREE.Group());
  group.add(contactShadow(radius));
  group.userData.height = 1.06;
  group.userData.radius = radius;
  return group;
}

function createBishop(material, accent) {
  const radius = 0.325;
  const height = 1.18;
  const parts = new Parts();
  parts.add(material, turned(BISHOP, radius, height));

  // Collar: a single ring, low, so it separates the stem from the mitre.
  addRing(parts, accent, 0.202, 0.45 * height, 0.013);
  addRing(parts, accent, radius * 0.9, 0.07, 0.012);

  // The traditional slit. It is small, but it is the difference between "pawn
  // with a spike" and "bishop" when the camera comes close.
  const slit = new THREE.BoxGeometry(0.03, 0.22, 0.024);
  slit.rotateX(-0.34);
  parts.add(accent, slit, { position: [0, 0.85 * height, 0.155] });

  // A gold point on the mitre: that is the mark you see from above.
  parts.add(accent, new THREE.SphereGeometry(0.032, 12, 10), { position: [0, height + 0.005, 0] });

  const group = parts.attach(new THREE.Group());
  group.add(contactShadow(radius));
  group.userData.height = height;
  group.userData.radius = radius;
  return group;
}

// The knight is a silhouette: a legless horse's head on a turned neck. The old
// one was an extruded profile, which is two flat cheeks and a beak: from the
// front and from behind it read as a plank. This spine has volume in every
// direction — ellipse, ellipse, ellipse, and the head turns as it rises.
const KNIGHT_SPINE = [
  { y: 0.36, z: 0.0, rx: 0.19, ry: 0.21 },
  { y: 0.58, z: 0.016, rx: 0.165, ry: 0.185 },
  { y: 0.78, z: 0.04, rx: 0.15, ry: 0.17 },
  { y: 0.92, z: 0.072, rx: 0.165, ry: 0.185 },
  { y: 1.02, z: 0.12, rx: 0.2, ry: 0.215 },
  { y: 1.12, z: 0.176, rx: 0.185, ry: 0.195 },
  { y: 1.19, z: 0.232, rx: 0.145, ry: 0.165 },
  { y: 1.17, z: 0.296, rx: 0.112, ry: 0.13 },
  { y: 1.08, z: 0.368, rx: 0.09, ry: 0.11 },
  { y: 0.98, z: 0.424, rx: 0.076, ry: 0.088 },
  { y: 0.93, z: 0.448, rx: 0.055, ry: 0.06 },
];

function createKnight(material, accent, eye) {
  // The turned fallback for the knight: createPiece swaps in the sculpt when
  // assets/knight.glb has loaded (see setSculpt).
  const radius = 0.335;
  const parts = new Parts();

  // Base and chest: a wide foot that narrows into a proper chest.
  parts.add(material, turned([
    [1, 0], [1, 0.018], [0.96, 0.036], [0.87, 0.055], [0.78, 0.075], [0.72, 0.11],
    [0.69, 0.18], [0.67, 0.26], [0.66, 0.34], [0.62, 0.44], [0.5, 0.52], [0.26, 0.55], [0.02, 0.56],
  ], radius, 1));

  // Neck, throat, cheek, brow, muzzle: one skin from the chest to the nose.
  parts.add(material, loft(KNIGHT_SPINE, 28));

  // Mane: locks carved down the nape, sitting on the back of the neck.
  const mane = [
    [1.1, 0.016],
    [1.0, -0.048],
    [0.9, -0.08],
    [0.78, -0.104],
  ];
  mane.forEach(([y, z], i) => {
    parts.add(material, new THREE.SphereGeometry(0.062 - i * 0.004, 12, 8), {
      position: [0, y, z - 0.014],
      scale: [0.3, 0.95, 0.62],
      rotation: [0.4, 0, 0],
    });
  });

  // Ears: two short cones on top of the skull.
  for (const side of [-1, 1]) {
    parts.add(material, new THREE.ConeGeometry(0.042, 0.12, 8), {
      position: [side * 0.05, 1.3, 0.16],
      rotation: [-0.24, 0, side * -0.12],
    });
  }

  // Eye and nostril, mirrored, sitting just inside the skin.
  for (const side of [-1, 1]) {
    parts.add(eye, new THREE.SphereGeometry(0.022, 10, 8), {
      position: [side * 0.152, 1.14, 0.188],
    });
    parts.add(material, new THREE.SphereGeometry(0.017, 10, 8), {
      position: [side * 0.042, 1.01, 0.4],
      scale: [0.7, 0.8, 0.6],
    });
  }

  // Gold marks: a ring above the foot, a bridle across the muzzle and gold tips
  // on the ears — three dots that read as a knight from above.
  addRing(parts, accent, radius * 0.9, 0.06, 0.012);
  const bridleGeometry = new THREE.TorusGeometry(0.06, 0.009, 6, 28);
  parts.add(accent, bridleGeometry, {
    position: [0, 1.02, 0.376],
    rotation: [0.32, 0, 0],
    scale: [1, 0.85, 1],
  });
  for (const side of [-1, 1]) {
    parts.add(accent, new THREE.ConeGeometry(0.026, 0.045, 8), {
      position: [side * 0.05, 1.352, 0.16],
      rotation: [-0.24, 0, side * -0.12],
    });
  }

  const group = parts.attach(new THREE.Group());
  group.add(contactShadow(radius));
  group.userData.height = 1.37;
  group.userData.radius = radius;
  return group;
}

function createQueen(material, accent) {
  const radius = 0.385;
  const height = 1.48;
  const parts = new Parts();
  parts.add(material, turned(QUEEN, radius, height));

  // Crown ring: a flared cup with eight points.
  parts.add(material, turned([
    [1, 0], [0.97, 0.02], [0.92, 0.06], [0.86, 0.12], [0.9, 0.2], [1, 0.28],
    [0.98, 0.34], [0.86, 0.38], [0.62, 0.4], [0.02, 0.4],
  ], 0.2, 0.3), { position: [0, height - 0.13, 0] });

  const spike = new THREE.ConeGeometry(0.032, 0.12, 6);
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * TAU;
    parts.add(material, spike.clone(), {
      position: [Math.cos(angle) * 0.175, height + 0.03, Math.sin(angle) * 0.175],
      rotation: [Math.sin(angle) * 0.14, 0, -Math.cos(angle) * 0.14],
    });
    parts.add(accent, new THREE.SphereGeometry(0.021, 8, 6), {
      position: [Math.cos(angle) * 0.19, height + 0.095, Math.sin(angle) * 0.19],
    });
  }
  spike.dispose();

  addRing(parts, accent, radius * 0.9, 0.058, 0.012);
  addRing(parts, accent, 0.201, height - 0.045, 0.012);
  parts.add(accent, new THREE.SphereGeometry(0.032, 10, 8), { position: [0, height + 0.13, 0] });

  const group = parts.attach(new THREE.Group());
  group.add(contactShadow(radius));
  group.userData.height = height + 0.16;
  group.userData.radius = radius;
  return group;
}

function createKing(material, accent) {
  const radius = 0.4;
  const height = 1.66;
  const parts = new Parts();
  parts.add(material, turned(KING, radius, height));

  // The crown cup.
  parts.add(material, turned([
    [1, 0], [0.97, 0.02], [0.92, 0.06], [0.87, 0.12], [0.92, 0.2], [0.99, 0.26],
    [0.95, 0.31], [0.82, 0.34], [0.6, 0.36], [0.02, 0.36],
  ], 0.21, 0.28), { position: [0, height - 0.1, 0] });

  // Cross: the one shape no other piece owns.
  parts.add(accent, new THREE.BoxGeometry(0.062, 0.24, 0.062), {
    position: [0, height + 0.1, 0],
    rotation: [0, Math.PI / 4, 0],
  });
  parts.add(accent, new THREE.BoxGeometry(0.19, 0.06, 0.06), {
    position: [0, height + 0.16, 0],
    rotation: [0, Math.PI / 4, 0],
  });

  addRing(parts, accent, radius * 0.9, 0.055, 0.012);
  addRing(parts, accent, 0.212, height - 0.026, 0.012);

  const group = parts.attach(new THREE.Group());
  group.add(contactShadow(radius));
  group.userData.height = height + 0.22;
  group.userData.radius = radius;
  return group;
}

const builders = {
  p: createPawn,
  r: createRook,
  b: createBishop,
  n: createKnight,
  q: createQueen,
  k: createKing,
};

/* --------------------------------------------------------- sculpted pieces */

// Sculpts that replace a turned piece when their GLB is available. `height` and
// `rings` are in game units: the segment radius was measured off each sculpt's
// own profile so the gold sits in its mouldings instead of floating.
const SCULPT_SPECS = {
  n: {
    height: 1.37,
    radius: 0.36,
    rings: [{ r: 0.357, y: 0.1, tube: 0.012 }],
  },
  q: {
    height: 1.64,
    radius: 0.42,
    // Gold on the pearls and on the top ball only. The little cup between them
    // (1.48-1.54) stays ivory, exactly where the sculpt has a step, so the cut
    // lands on an edge instead of across a face.
    goldTop: 1.4,
    goldBands: [[1.4, 1.478, 0.22], [1.545, 2]],
    rings: [
      { r: 0.386, y: 0.1, tube: 0.013 },
      { r: 0.172, y: 0.745, tube: 0.011 },
    ],
  },
  b: {
    height: 1.22,
    radius: 0.3,
    // The point above the collar is a separate finial on this sculpt.
    goldTop: 1.15,
    rings: [
      { r: 0.284, y: 0.05, tube: 0.012 },
      { r: 0.139, y: 0.7, tube: 0.01 },
    ],
  },
  p: {
    height: 0.84,
    radius: 0.28,
    // Three bands, exactly like the reference: the foot's rim, the band above
    // it, and the collar under the ball.
    rings: [
      { r: 0.265, y: 0.03, tube: 0.011 },
      { r: 0.253, y: 0.1, tube: 0.011 },
      { r: 0.138, y: 0.5, tube: 0.009 },
    ],
  },
  r: {
    height: 1.06,
    radius: 0.33,
    rings: [
      { r: 0.32, y: 0.06, tube: 0.013 },
      { r: 0.185, y: 0.72, tube: 0.011 },
      { r: 0.232, y: 0.78, tube: 0.011 },
    ],
  },
  k: {
    height: 1.88,
    radius: 0.46,
    // Everything above the crown cap is the cross: paint it gold.
    goldTop: 1.55,
    rings: [
      { r: 0.436, y: 0.07, tube: 0.014 },
      { r: 0.224, y: 0.895, tube: 0.011 },
      { r: 0.254, y: 1.48, tube: 0.012 },
    ],
  },
};

const sculpts = new Map();

/** Hand the scene a parsed GLB for a piece type; existing pieces are rebuilt. */
export function setSculpt(type, model) {
  if (model) sculpts.set(type, model);
  else sculpts.delete(type);
  cache.delete(`${type}w`);
  cache.delete(`${type}b`);
}

/**
 * Splits one sculpt into two index sets, so part of it can wear another
 * material. Attributes are shared; only the index differs.
 *
 * `goldBands` are height ranges that turn gold, and `goldInside` keeps the cup's
 * inner wall ivory. Both boundaries fall on the sculpt's own horizontal edges,
 * which is what stops the gold line from looking torn: a per-triangle radius cut
 * in the middle of a band saws across faces and leaves a ragged edge.
 */
function splitByHeight(geometry, threshold, spec = {}) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const index = geometry.index?.array;
  if (!index) return { low: geometry, high: null };

  const bands = spec.goldBands || null;
  const insideY = spec.goldInside ?? -Infinity;

  const low = [];
  const high = [];
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3;
    if (y < threshold) {
      low.push(a, b, c);
      continue;
    }
    if (!bands) {
      high.push(a, b, c);
      continue;
    }
    const gy = spec.mapY ? spec.mapY(y) : y;
    // A band may also demand a minimum radius: the pearls sit on the crown's
    // outer ring, while the finial's base hides inside at the same height.
    let inBand = false;
    for (const [from, to, rMin] of bands) {
      if (gy < from || gy > to) continue;
      if (rMin) {
        const cx0 = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
        const cz0 = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
        const r0 = Math.hypot(cx0, cz0);
        if ((spec.mapR ? spec.mapR(r0) : r0) < rMin) continue;
      }
      inBand = true;
      break;
    }
    if (!inBand) {
      low.push(a, b, c);
      continue;
    }
    if (normal && gy < insideY) {
      // Radial component of the face normal: negative means the surface looks
      // back towards the piece's axis — the inner wall of the cup.
      const cx = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;
      const cz = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
      const len = Math.hypot(cx, cz) || 1;
      const nx = (normal.getX(a) + normal.getX(b) + normal.getX(c)) / 3;
      const nz = (normal.getZ(a) + normal.getZ(b) + normal.getZ(c)) / 3;
      const radial = (nx * cx + nz * cz) / len;
      if (radial < -0.35) {
        low.push(a, b, c);
        continue;
      }
    }
    high.push(a, b, c);
  }

  const build = (indices) => {
    if (!indices.length) return null;
    const part = new THREE.BufferGeometry();
    for (const [name, attribute] of Object.entries(geometry.attributes)) part.setAttribute(name, attribute);
    part.setIndex(indices);
    part.computeBoundingSphere();
    return part;
  };
  return { low: build(low) || geometry, high: build(high) };
}

/**
 * Normalises a sculpt into a chess piece: target height, centred on the square,
 * base on the board. Its own material is replaced with the set's ivory or
 * graphite, the gold marks are added as real rings, and anything above
 * `goldTop` (a cross, a finial) is painted with the accent.
 */
function pieceFromSculpt(type, white, accent) {
  const model = sculpts.get(type);
  const spec = SCULPT_SPECS[type] || { height: 1.4, radius: 0.4, rings: [] };
  const { geometry, box } = model;
  const height = box.max.y - box.min.y;
  const scale = spec.height / (height || 1);
  const group = new THREE.Group();

  let body = geometry;
  let cap = null;
  if (spec.goldTop) {
    const threshold = box.min.y + (spec.goldTop / spec.height) * height;
    // Bands are written in game units; the geometry is still in model units.
    const mapY = (y) => ((y - box.min.y) / height) * spec.height;
    ({ low: body, high: cap } = splitByHeight(geometry, threshold, { ...spec, mapY, mapR: (r) => r * (spec.height / height) }));
  }

  const chassis = new THREE.Group();
  chassis.add(new THREE.Mesh(body, white ? sculptIvory : sculptOnyx));
  if (cap) chassis.add(new THREE.Mesh(cap, accent));
  chassis.scale.setScalar(scale);
  chassis.position.set(
    -((box.min.x + box.max.x) / 2) * scale,
    -box.min.y * scale,
    -((box.min.z + box.max.z) / 2) * scale,
  );
  group.add(chassis);

  if (spec.rings.length) {
    const parts = new Parts();
    for (const ring of spec.rings) addRing(parts, accent, ring.r, ring.y, ring.tube);
    parts.attach(group);
  }

  group.add(contactShadow(spec.radius));
  group.userData.height = spec.height;
  group.userData.radius = spec.radius;
  return group;
}

const cache = new Map();

export function createPiece(type, color) {
  const key = `${type}${color}`;
  if (!cache.has(key)) {
    const isWhite = color === 'w';
    const group = sculpts.has(type)
      ? pieceFromSculpt(type, isWhite, isWhite ? brass : darkBrass)
      : (builders[type] || createPawn)(
          isWhite ? ivoryMaterial : onyxMaterial,
          isWhite ? brass : darkBrass,
          isWhite ? eyeDark : eyeWarm,
        );
    group.name = `piece-${key}`;
    group.userData.type = type;
    group.userData.color = color;
    group.traverse((child) => {
      if (child.isMesh && !child.userData.shadowBlob) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    cache.set(key, group);
  }
  const copy = cache.get(key).clone(true);
  copy.userData.type = type;
  copy.userData.color = color;
  copy.userData.height = cache.get(key).userData.height;
  copy.userData.radius = cache.get(key).userData.radius;
  return copy;
}

export function createPieceMaterials() {
  return { ivoryMaterial, onyxMaterial, brass, darkBrass, eyeDark, eyeWarm };
}

export function pieceGlyph(type, color) {
  // White pieces are U+2654..U+2659, black are U+265A..U+265F, in the order
  // king, queen, rook, bishop, knight, pawn. Built from code points on purpose:
  // literal glyphs in the source survived exactly one encoding round-trip.
  const order = { k: 0, q: 1, r: 2, b: 3, n: 4, p: 5 };
  const index = order[type];
  if (index === undefined) return '?';
  return String.fromCodePoint((color === 'w' ? 0x2654 : 0x265a) + index);
}

export { TAU };



