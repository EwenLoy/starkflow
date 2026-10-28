import * as THREE from 'three';

const TAU = Math.PI * 2;

const ivoryMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xf1e6cf,
  roughness: 0.34,
  metalness: 0.02,
  clearcoat: 0.62,
  clearcoatRoughness: 0.32,
  sheen: 0.18,
  sheenColor: 0xfff3d4,
  envMapIntensity: 0.72,
});

const ivoryShade = new THREE.MeshPhysicalMaterial({
  color: 0xd7c8aa,
  roughness: 0.4,
  metalness: 0.03,
  clearcoat: 0.4,
  envMapIntensity: 0.58,
});

const onyxMaterial = new THREE.MeshPhysicalMaterial({
  color: 0x15251f,
  roughness: 0.26,
  metalness: 0.28,
  clearcoat: 0.9,
  clearcoatRoughness: 0.24,
  sheen: 0.25,
  sheenColor: 0x73a68f,
  envMapIntensity: 0.95,
});

const onyxShade = new THREE.MeshPhysicalMaterial({
  color: 0x0b1713,
  roughness: 0.34,
  metalness: 0.22,
  clearcoat: 0.65,
  envMapIntensity: 0.8,
});

const brass = new THREE.MeshStandardMaterial({
  color: 0xc9a15d,
  roughness: 0.26,
  metalness: 0.9,
  envMapIntensity: 1.1,
});

const darkBrass = new THREE.MeshStandardMaterial({
  color: 0x8a6637,
  roughness: 0.38,
  metalness: 0.82,
  envMapIntensity: 0.8,
});

const felt = new THREE.MeshStandardMaterial({ color: 0x07100c, roughness: 0.95, metalness: 0 });
const eyeMaterial = new THREE.MeshStandardMaterial({
  color: 0x1a1009,
  roughness: 0.22,
  metalness: 0.4,
  emissive: 0x2a1b0c,
  emissiveIntensity: 0.3,
});

function points(list) {
  return list.map(([x, y]) => new THREE.Vector2(x, y));
}

function lathe(list, segments = 56) {
  const geometry = new THREE.LatheGeometry(points(list), segments);
  geometry.computeVertexNormals();
  return geometry;
}

function mesh(geometry, material) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function band(radius, y, tube = 0.012, material = brass) {
  const m = mesh(new THREE.TorusGeometry(radius, tube, 8, 48), material);
  m.rotation.x = Math.PI / 2;
  m.position.y = y;
  return m;
}

function addBase(group, radius, material) {
  const base = mesh(new THREE.CylinderGeometry(radius, radius * 1.02, 0.018, 48), felt);
  base.position.y = 0.008;
  base.castShadow = false;
  group.add(base);
  const inner = mesh(new THREE.CylinderGeometry(radius * 0.82, radius * 0.88, 0.01, 48), material);
  inner.position.y = 0.022;
  group.add(inner);
}

function addKnob(group, y, radius, material) {
  const knob = mesh(new THREE.SphereGeometry(radius, 24, 18), material);
  knob.position.y = y;
  knob.scale.y = 0.9;
  group.add(knob);
}

function decorate(group, material, y = 0.075) {
  group.add(band(0.255, y, 0.013, material));
  group.add(band(0.225, y + 0.035, 0.008, material));
}

function createPawn(material, accent) {
  const group = new THREE.Group();
  addBase(group, 0.31, accent);
  group.add(
    mesh(
      lathe([
        [0.001, 0.02], [0.285, 0.02], [0.3, 0.045], [0.285, 0.075], [0.235, 0.105],
        [0.2, 0.15], [0.17, 0.22], [0.148, 0.34], [0.142, 0.43], [0.18, 0.475],
        [0.228, 0.5], [0.19, 0.535], [0.15, 0.575], [0.14, 0.63], [0.155, 0.675],
        [0.19, 0.73], [0.18, 0.78], [0.12, 0.82], [0.001, 0.835],
      ]),
      material,
    ),
  );
  group.add(band(0.155, 0.59, 0.009, accent));
  addKnob(group, 0.82, 0.105, material);
  decorate(group, accent);
  group.userData.height = 0.92;
  return group;
}

function createRook(material, accent) {
  const group = new THREE.Group();
  addBase(group, 0.335, accent);
  group.add(
    mesh(
      lathe([
        [0.001, 0.02], [0.315, 0.02], [0.33, 0.052], [0.31, 0.085], [0.255, 0.115],
        [0.225, 0.16], [0.21, 0.21], [0.205, 0.42], [0.2, 0.55], [0.235, 0.58],
        [0.285, 0.61], [0.292, 0.655], [0.255, 0.685], [0.255, 0.735], [0.29, 0.76],
        [0.295, 0.81], [0.26, 0.84], [0.26, 0.9], [0.001, 0.9],
      ]),
      material,
    ),
  );
  group.add(band(0.255, 0.61, 0.011, accent));
  group.add(band(0.263, 0.82, 0.008, accent));
  const crenels = mesh(new THREE.BoxGeometry(0.14, 0.11, 0.145), material);
  for (let i = 0; i < 4; i += 1) {
    const copy = crenels.clone();
    const a = (i / 4) * TAU + Math.PI / 4;
    copy.position.set(Math.cos(a) * 0.16, 0.945, Math.sin(a) * 0.16);
    copy.rotation.y = -a;
    group.add(copy);
  }
  addKnob(group, 0.9, 0.015, accent);
  decorate(group, accent);
  group.userData.height = 1.0;
  return group;
}

function createBishop(material, accent) {
  const group = new THREE.Group();
  addBase(group, 0.32, accent);
  group.add(
    mesh(
      lathe([
        [0.001, 0.02], [0.3, 0.02], [0.315, 0.05], [0.295, 0.082], [0.24, 0.112],
        [0.205, 0.16], [0.178, 0.23], [0.16, 0.35], [0.155, 0.46], [0.19, 0.5],
        [0.235, 0.525], [0.195, 0.555], [0.155, 0.59], [0.145, 0.64], [0.16, 0.69],
        [0.19, 0.74], [0.235, 0.79], [0.26, 0.84], [0.238, 0.9], [0.17, 0.95],
        [0.1, 0.985], [0.048, 1.01], [0.001, 1.02],
      ]),
      material,
    ),
  );
  group.add(band(0.158, 0.6, 0.009, accent));
  group.add(band(0.238, 0.89, 0.007, accent));
  // The traditional slit on the bishop's mitre.
  const slit = mesh(new THREE.BoxGeometry(0.035, 0.19, 0.018), accent);
  slit.position.set(0, 0.865, 0.245);
  slit.rotation.x = -0.24;
  group.add(slit);
  addKnob(group, 1.015, 0.047, accent);
  decorate(group, accent);
  group.userData.height = 1.1;
  return group;
}

function createQueen(material, accent) {
  const group = new THREE.Group();
  addBase(group, 0.36, accent);
  group.add(
    mesh(
      lathe([
        [0.001, 0.02], [0.34, 0.02], [0.358, 0.052], [0.335, 0.088], [0.275, 0.12],
        [0.235, 0.17], [0.205, 0.25], [0.18, 0.35], [0.166, 0.44], [0.18, 0.48],
        [0.245, 0.51], [0.277, 0.55], [0.235, 0.585], [0.19, 0.62], [0.172, 0.67],
        [0.19, 0.72], [0.235, 0.76], [0.28, 0.81], [0.3, 0.86], [0.276, 0.91],
        [0.21, 0.95], [0.17, 0.99], [0.185, 1.04], [0.235, 1.08], [0.27, 1.12],
        [0.235, 1.16], [0.19, 1.2], [0.17, 1.26], [0.185, 1.32], [0.215, 1.36],
        [0.18, 1.4], [0.12, 1.425], [0.001, 1.44],
      ]),
      material,
    ),
  );
  group.add(band(0.17, 0.6, 0.009, accent));
  group.add(band(0.22, 1.19, 0.008, accent));
  // A crown of eight points and small pearls.
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * TAU;
    const spike = mesh(new THREE.ConeGeometry(0.035, 0.16, 8), material);
    spike.position.set(Math.cos(a) * 0.18, 1.4, Math.sin(a) * 0.18);
    spike.rotation.z = Math.cos(a) * -0.16;
    spike.rotation.x = Math.sin(a) * 0.16;
    group.add(spike);
    const pearl = mesh(new THREE.SphereGeometry(0.025, 12, 8), accent);
    pearl.position.set(Math.cos(a) * 0.185, 1.487, Math.sin(a) * 0.185);
    group.add(pearl);
  }
  addKnob(group, 1.51, 0.045, accent);
  decorate(group, accent);
  group.userData.height = 1.58;
  return group;
}

function createKing(material, accent) {
  const group = new THREE.Group();
  addBase(group, 0.37, accent);
  group.add(
    mesh(
      lathe([
        [0.001, 0.02], [0.35, 0.02], [0.368, 0.052], [0.345, 0.09], [0.285, 0.122],
        [0.242, 0.17], [0.212, 0.25], [0.188, 0.35], [0.174, 0.46], [0.19, 0.5],
        [0.255, 0.53], [0.288, 0.57], [0.245, 0.605], [0.2, 0.64], [0.182, 0.69],
        [0.2, 0.74], [0.25, 0.78], [0.296, 0.83], [0.315, 0.88], [0.29, 0.93],
        [0.22, 0.98], [0.18, 1.03], [0.196, 1.09], [0.25, 1.14], [0.283, 1.19],
        [0.248, 1.23], [0.2, 1.28], [0.18, 1.34], [0.195, 1.4], [0.225, 1.45],
        [0.19, 1.49], [0.13, 1.515], [0.001, 1.53],
      ]),
      material,
    ),
  );
  group.add(band(0.174, 0.62, 0.01, accent));
  group.add(band(0.235, 1.24, 0.009, accent));
  // Cross.
  const vertical = mesh(new THREE.BoxGeometry(0.075, 0.31, 0.075), accent);
  vertical.position.y = 1.69;
  vertical.rotation.y = Math.PI / 4;
  group.add(vertical);
  const horizontal = mesh(new THREE.BoxGeometry(0.23, 0.073, 0.073), accent);
  horizontal.position.y = 1.72;
  horizontal.rotation.y = Math.PI / 4;
  group.add(horizontal);
  addKnob(group, 1.53, 0.055, material);
  decorate(group, accent);
  group.userData.height = 1.86;
  return group;
}

function createKnight(material, accent) {
  const group = new THREE.Group();
  addBase(group, 0.325, accent);
  group.add(
    mesh(
      lathe([
        [0.001, 0.02], [0.305, 0.02], [0.32, 0.05], [0.3, 0.085], [0.245, 0.115],
        [0.22, 0.16], [0.21, 0.21], [0.205, 0.3], [0.2, 0.38], [0.225, 0.42],
        [0.265, 0.45], [0.235, 0.48], [0.195, 0.51], [0.18, 0.55], [0.001, 0.56],
      ]),
      material,
    ),
  );
  group.add(band(0.2, 0.47, 0.009, accent));

  const neck = mesh(new THREE.CylinderGeometry(0.155, 0.205, 0.48, 24), material);
  neck.position.set(0, 0.77, 0.015);
  neck.rotation.x = -0.16;
  group.add(neck);

  const head = mesh(new THREE.SphereGeometry(0.22, 32, 24), material);
  head.scale.set(0.78, 1.05, 1.18);
  head.position.set(0, 1.08, 0.09);
  head.rotation.x = -0.12;
  group.add(head);

  const muzzle = mesh(new THREE.CylinderGeometry(0.105, 0.15, 0.3, 20), material);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.set(0, 1.015, 0.33);
  group.add(muzzle);

  const nose = mesh(new THREE.SphereGeometry(0.1, 20, 16), material);
  nose.scale.set(0.9, 0.75, 0.75);
  nose.position.set(0, 0.995, 0.47);
  group.add(nose);

  // Ears.
  for (const side of [-1, 1]) {
    const ear = mesh(new THREE.ConeGeometry(0.06, 0.18, 10), material);
    ear.position.set(side * 0.095, 1.29, 0.01);
    ear.rotation.z = side * -0.14;
    ear.rotation.x = -0.05;
    group.add(ear);
  }

  // The mane is a row of small, slightly flattened forms down the neck.
  for (let i = 0; i < 5; i += 1) {
    const mane = mesh(new THREE.SphereGeometry(0.085 - i * 0.006, 12, 8), accent);
    mane.scale.set(0.65, 1.35, 0.9);
    mane.position.set(0, 1.23 - i * 0.09, -0.105 - i * 0.014);
    mane.rotation.x = 0.25;
    group.add(mane);
  }

  // Eyes and a small bridle band.
  for (const side of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.024, 10, 8), eyeMaterial);
    eye.position.set(side * 0.125, 1.13, 0.245);
    group.add(eye);
  }
  group.add(band(0.15, 0.985, 0.008, accent));

  decorate(group, accent);
  group.userData.height = 1.4;
  return group;
}

const factories = {
  p: createPawn,
  r: createRook,
  b: createBishop,
  n: createKnight,
  q: createQueen,
  k: createKing,
};

const cache = new Map();

export function createPiece(type, color) {
  const key = `${type}${color}`;
  if (!cache.has(key)) {
    const isWhite = color === 'w';
    const material = isWhite ? ivoryMaterial : onyxMaterial;
    const accent = isWhite ? brass : darkBrass;
    const factory = factories[type] || createPawn;
    const group = factory(material, accent);
    group.name = `piece-${key}`;
    group.userData.type = type;
    group.userData.color = color;
    group.userData.radius = type === 'p' ? 0.31 : type === 'k' || type === 'q' ? 0.37 : 0.33;
    group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    cache.set(key, group);
  }
  const copy = cache.get(key).clone(true);
  copy.userData.type = type;
  copy.userData.color = color;
  copy.userData.radius = type === 'p' ? 0.31 : type === 'k' || type === 'q' ? 0.37 : 0.33;
  return copy;
}

export function createPieceMaterials() {
  return { ivoryMaterial, ivoryShade, onyxMaterial, onyxShade, brass, darkBrass };
}

export function pieceGlyph(type, color) {
  const white = { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' };
  const black = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  return (color === 'w' ? white : black)[type] || '?';
}
