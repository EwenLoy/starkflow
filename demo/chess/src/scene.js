import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createPiece, pieceGlyph } from './pieces.js?v=20261028-14';

const FILES = 'abcdefgh';
const PIECE_Y = 0.105;
const TAU = Math.PI * 2;
const TRAIL_POINTS = 25;

const easeOut = (t) => 1 - (1 - t) ** 3;
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * One profile for the whole demo: a phone has a fraction of the fill rate of a
 * desktop GPU, so the pixel ratio, the shadow map, the bloom and the number of
 * particles are set once at startup instead of being discovered per frame.
 */
function qualityProfile() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  const mobile = window.matchMedia?.('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) <= 820;
  const weak = mobile || cores <= 4 || memory <= 4;
  const hardware = window.devicePixelRatio || 1;
  return {
    mobile,
    weak,
    maxPixelRatio: mobile ? Math.min(hardware, 1.5) : Math.min(hardware, 2),
    pixelRatio: mobile ? Math.min(hardware, 1.25) : Math.min(hardware, 1.75),
    antialias: !mobile,
    shadowMap: mobile ? 1024 : 2048,
    dust: mobile ? 84 : 180,
    fx: mobile ? 0.55 : 1,
    bloom: !mobile && !weak,
    shards: mobile ? 4 : 7,
    ringSegments: mobile ? 28 : 44,
  };
}

function squarePos(square, y = PIECE_Y) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return new THREE.Vector3(file - 3.5, y, 3.5 - (rank - 1));
}

function squareAt(x, z) {
  const file = Math.floor(x + 4);
  const rank = 8 - Math.floor(z + 4);
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;
  return `${FILES[file]}${rank}`;
}

function parseFen(fen) {
  const map = new Map();
  const rows = String(fen).split(' ')[0].split('/');
  if (rows.length !== 8) return map;
  const types = { p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k' };
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      const type = types[ch.toLowerCase()];
      if (type && file < 8) map.set(`${FILES[file]}${8 - r}`, { type, color });
      file += 1;
    }
  });
  return map;
}

function seeded(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function marbleTexture({ base, vein, fleck, seed = 7, dark = false }) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = seeded(seed);

  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  const wash = ctx.createRadialGradient(size * 0.25, size * 0.2, 10, size * 0.6, size * 0.65, size * 0.9);
  wash.addColorStop(0, dark ? 'rgba(70,130,105,.16)' : 'rgba(255,255,255,.22)');
  wash.addColorStop(0.55, 'rgba(0,0,0,0)');
  wash.addColorStop(1, dark ? 'rgba(0,0,0,.34)' : 'rgba(120,86,38,.08)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 26; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const length = 70 + rand() * 420;
    const angle = (rand() - 0.5) * 1.2 + (i % 3 === 0 ? 0.8 : 0);
    ctx.beginPath();
    ctx.moveTo(x, y);
    let px = x;
    let py = y;
    for (let j = 0; j < 8; j += 1) {
      px += Math.cos(angle + (rand() - 0.5) * 0.42) * (length / 8);
      py += Math.sin(angle + (rand() - 0.5) * 0.42) * (length / 8);
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = vein;
    ctx.globalAlpha = 0.08 + rand() * 0.22;
    ctx.lineWidth = 0.55 + rand() * 2.4;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let i = 0; i < 900; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = rand() > 0.45 ? fleck : 'rgba(0,0,0,.16)';
    ctx.globalAlpha = 0.035 + rand() * 0.14;
    ctx.fillRect(x, y, 0.5 + rand() * 1.5, 0.5 + rand() * 1.5);
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

function labelTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(218,184,119,.82)';
  ctx.font = '500 62px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 67);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function radialTexture(inner = 'rgba(230,196,124,.34)', outer = 'rgba(0,0,0,0)') {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.16)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A primitive with its transform baked in, so a whole hall of columns, arches
 * and chairs can collapse into one draw call per material instead of a hundred.
 */
function dressed(geometry, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
  let piece = geometry;
  if (geometry.index) {
    piece = geometry.toNonIndexed();
    geometry.dispose();
  }
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(position[0], position[1], position[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2])),
    new THREE.Vector3(scale[0], scale[1], scale[2]),
  );
  piece.applyMatrix4(matrix);
  return piece;
}

function mergeAll(pieces) {
  let total = 0;
  for (const piece of pieces) total += piece.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let offset = 0;
  for (const piece of pieces) {
    const count = piece.attributes.position.count;
    position.set(piece.attributes.position.array, offset * 3);
    normal.set(piece.attributes.normal.array, offset * 3);
    if (piece.attributes.uv) uv.set(piece.attributes.uv.array, offset * 2);
    offset += count;
    piece.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingSphere();
  return merged;
}

export class ChessScene {
  constructor(canvas, { onSquareClick } = {}) {
    this.canvas = canvas;
    this.onSquareClick = onSquareClick || (() => {});
    this.quality = qualityProfile();
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x050c09, 0.022);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x050c09, 0);

    this.camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.copy(this.#lobbyPosition());

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.35, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.7;
    this.controls.zoomSpeed = 0.9;
    this.controls.minDistance = 6.6;
    this.controls.maxDistance = 20;
    this.controls.minPolarAngle = 0.22;
    this.controls.maxPolarAngle = 1.45;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.update();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDown = null;
    this.hoverSquare = null;
    this.interactive = false;
    this.viewSide = 'w';
    this.topViewActive = false;
    this.mode = 'lobby';
    this.pieces = new Map();
    this.animating = false;
    this.moveAnims = [];
    this.spawnAnims = [];
    this.cameraTween = null;
    this.particles = [];
    this.trails = [];
    this.ripples = [];
    this.flares = [];
    this.burstAssets = new Map();
    this.shards = [];
    this.glows = [];
    this.checkGlow = null;
    this.pulses = [];
    this.pendingBoard = null;
    this.disposed = false;
    this.moveToken = 0;
    this.hintTimer = null;
    this.clock = new THREE.Clock();
    this.time = 0;
    this._raf = 0;
    this.pixelRatio = this.quality.pixelRatio;
    this.frameTime = 1 / 60;
    this.qualityClock = 0;
    this.dustClock = 0;

    this.#initPools();
    this.#applyLens();
    this.#applyFraming();
    this.#setupEnvironment();
    this.#setupLights();
    this.#buildBoard();
    this.#buildRoom();
    this.#buildOverlays();
    this.#setupPost();
    this.#bindEvents();
    this.#loop();
  }

  /* ----------------------------------------------------------- quality */
  /**
   * The camera has to frame a square board inside any viewport, and a portrait
   * phone is the worst case: a 36 degree lens sees four squares of a nine unit
   * board. The lens widens and the distance grows with the aspect ratio, so the
   * whole board is on screen and the HUD no longer sits on top of it.
   */
  #applyLens() {
    const aspect = this.camera.aspect || 1;
    this.camera.fov = aspect < 1 ? clamp(36 / (aspect + 0.34), 42, 62) : 36;
    this.camera.updateProjectionMatrix();
  }

  #fitDistance() {
    const aspect = this.camera.aspect || 1;
    const halfFov = ((this.camera.fov || 36) * Math.PI) / 360;
    const byWidth = 6.7 / (Math.tan(halfFov) * Math.min(aspect, 2.2));
    const span = window.innerHeight <= 520 ? 10.2 : 9.2;
    const byDepth = span / (2 * Math.tan(halfFov));
    return clamp(Math.max(byWidth, byDepth), 7.8, 42);
  }

  #applyFraming() {
    this.fitDistance = this.#fitDistance();
    this.controls.minDistance = Math.max(6, this.fitDistance * 0.62);
    this.controls.maxDistance = this.fitDistance * 1.4;
    // The haze is a look, not a ruler: a phone pulls the camera back, so the
    // density follows, otherwise the board would drown in fog.
    if (this.scene.fog) this.scene.fog.density = 0.025 * clamp(13.4 / this.fitDistance, 0.42, 1);
  }

  #lobbyPosition() {
    return new THREE.Vector3(0.52, 0.48, 0.72).normalize().multiplyScalar(this.#fitDistance() * 1.18);
  }

  /* --------------------------------------------------------------- pools */
  #initPools() {
    this.shardPool = [];
    this.shardFree = [];
    this.ripplePool = [];
    this.rippleFree = [];
    this.flarePool = [];
    this.flareFree = [];
    this.trailPool = [];
    this.trailFree = [];
    this.glowPool = [];
    this.glowFree = [];
    this.glowTexture = radialTexture('rgba(255,236,196,.95)', 'rgba(255,176,86,0)');
  }

  #lease(free, make) {
    const item = free.pop() || make();
    item.mesh.visible = true;
    return item;
  }

  #release(free, item) {
    item.mesh.visible = false;
    free.push(item);
  }

  /* ------------------------------------------------------------ build */
  #setupEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envMap = pmrem.fromScene(room, 0.04).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.1;
    room.dispose?.();
    pmrem.dispose();
  }

  #setupLights() {
    // The hall is lit by candles: a low cold wash so shapes exist, warm pools
    // on the table, and only as much key light as the board needs to be read.
    this.scene.add(new THREE.HemisphereLight(0x6d8894, 0x040906, 0.15));

    const key = new THREE.SpotLight(0xffc98c, 62, 24, 0.62, 0.86, 2);
    key.position.set(-2.2, 11.8, 5.4);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(this.quality.shadowMap, this.quality.shadowMap);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 24;
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.018;
    this.scene.add(key, key.target);
    this.keyLight = key;
    this.keyLightBase = key.intensity;

    const rim = new THREE.SpotLight(0x578b78, 22, 26, 0.82, 0.92, 2);
    rim.position.set(8.5, 7.6, -7);
    rim.target.position.set(0, 0.2, 0);
    this.scene.add(rim, rim.target);

    const fill = new THREE.PointLight(0xff9c4e, 4, 16, 2);
    fill.position.set(-8.6, 1.8, 3.4);
    this.scene.add(fill);

    const under = new THREE.PointLight(0x2f6f57, 1.8, 9, 2);
    under.position.set(2.4, 0.4, 1.8);
    this.scene.add(under);

    // Two candle pools on the near table corners carry the scene.
    this.brazierLights = [];
    for (const x of [-7.4, 7.4]) {
      const flame = new THREE.PointLight(0xffab5c, 15, 13, 2);
      flame.position.set(x, 1.1, 6.1);
      this.scene.add(flame);
      this.brazierLights.push(flame);
    }
  }

  #buildBoard() {
    const lightTex = marbleTexture({
      base: '#e9dfc7',
      vein: '#988a70',
      fleck: 'rgba(255,248,223,.7)',
      seed: 11,
    });
    const darkTex = marbleTexture({
      base: '#103c2e',
      vein: '#04130e',
      fleck: 'rgba(174,218,187,.35)',
      seed: 31,
      dark: true,
    });

    const lightMat = new THREE.MeshPhysicalMaterial({
      map: lightTex,
      bumpMap: lightTex,
      bumpScale: 0.012,
      roughness: 0.37,
      metalness: 0.02,
      clearcoat: 0.22,
      clearcoatRoughness: 0.55,
      envMapIntensity: 0.55,
    });
    const darkMat = new THREE.MeshPhysicalMaterial({
      map: darkTex,
      bumpMap: darkTex,
      bumpScale: 0.015,
      roughness: 0.3,
      metalness: 0.08,
      clearcoat: 0.4,
      clearcoatRoughness: 0.42,
      envMapIntensity: 0.7,
    });
    this.squareMaterials = { light: lightMat, dark: darkMat };

    const wood = new THREE.MeshPhysicalMaterial({
      color: 0x142720,
      roughness: 0.29,
      metalness: 0.24,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.6,
    });
    const stone = new THREE.MeshPhysicalMaterial({
      color: 0x0a1511,
      roughness: 0.35,
      metalness: 0.16,
      clearcoat: 0.35,
      envMapIntensity: 0.42,
    });
    const brass = new THREE.MeshStandardMaterial({
      color: 0xb78e4f,
      roughness: 0.27,
      metalness: 0.92,
      envMapIntensity: 1.1,
    });
    const brassDim = new THREE.MeshStandardMaterial({
      color: 0x6f5330,
      roughness: 0.4,
      metalness: 0.8,
      envMapIntensity: 0.7,
    });
    this.brassMaterial = brass;

    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);

    const plinth = new THREE.Mesh(new RoundedBoxGeometry(9.65, 0.5, 9.65, 4, 0.12), stone);
    plinth.position.y = -0.41;
    plinth.receiveShadow = true;
    plinth.castShadow = true;
    this.boardGroup.add(plinth);

    const frame = new THREE.Mesh(new RoundedBoxGeometry(9.1, 0.33, 9.1, 4, 0.075), wood);
    frame.position.y = -0.12;
    frame.receiveShadow = true;
    frame.castShadow = true;
    this.boardGroup.add(frame);

    const brassFrame = new THREE.Mesh(new THREE.BoxGeometry(9.18, 0.035, 9.18), brass);
    brassFrame.position.y = 0.015;
    brassFrame.receiveShadow = true;
    this.boardGroup.add(brassFrame);

    const innerFrame = new THREE.Mesh(new THREE.BoxGeometry(8.22, 0.038, 8.22), stone);
    innerFrame.position.y = 0.027;
    innerFrame.receiveShadow = true;
    this.boardGroup.add(innerFrame);

    const squareGeometry = new RoundedBoxGeometry(0.965, 0.065, 0.965, 3, 0.018);
    for (let rank = 1; rank <= 8; rank += 1) {
      for (let file = 0; file < 8; file += 1) {
        const light = (file + rank) % 2 === 0;
        const tile = new THREE.Mesh(squareGeometry, light ? lightMat : darkMat);
        tile.position.set(file - 3.5, 0.047, 3.5 - (rank - 1));
        tile.receiveShadow = true;
        this.boardGroup.add(tile);
      }
    }

    // Thin brass separators around the playing field.
    for (const offset of [-4.08, 4.08]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(8.18, 0.018, 0.028), brass);
      h.position.set(0, 0.084, offset);
      this.boardGroup.add(h);
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.018, 8.18), brass);
      v.position.set(offset, 0.084, 0);
      this.boardGroup.add(v);
    }

    // Engraved corner ornaments.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const ornament = new THREE.Group();
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.012, 6, 24, Math.PI / 2), brass);
        arc.rotation.x = Math.PI / 2;
        arc.rotation.z = sx * sz > 0 ? Math.PI : Math.PI / 2;
        arc.position.set(sx * 4.22, 0.083, sz * 4.22);
        ornament.add(arc);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), brassDim);
        dot.position.set(sx * 4.39, 0.087, sz * 4.39);
        ornament.add(dot);
        this.boardGroup.add(ornament);
      }
    }

    this.#buildLabels();
    this.#buildTable();

    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(8.24, 8.24),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hit.rotation.x = -Math.PI / 2;
    hit.position.y = 0.088;
    this.boardGroup.add(hit);
    this.hitPlane = hit;
  }

  #buildLabels() {
    const labelGroup = new THREE.Group();
    const mat = (text) =>
      new THREE.MeshBasicMaterial({
        map: labelTexture(text),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    const geom = new THREE.PlaneGeometry(0.45, 0.45);

    for (let i = 0; i < 8; i += 1) {
      const letter = FILES[i];
      const x = i - 3.5;
      for (const [z, rot] of [
        [4.47, 0],
        [-4.47, Math.PI],
      ]) {
        const m = new THREE.Mesh(geom, mat(letter));
        m.rotation.set(-Math.PI / 2, 0, rot);
        m.position.set(x, 0.086, z);
        labelGroup.add(m);
      }
    }
    for (let rank = 1; rank <= 8; rank += 1) {
      const z = 3.5 - (rank - 1);
      for (const [x, rot] of [
        [-4.47, -Math.PI / 2],
        [4.47, Math.PI / 2],
      ]) {
        const m = new THREE.Mesh(geom, mat(String(rank)));
        m.rotation.set(-Math.PI / 2, 0, rot);
        m.position.set(x, 0.086, z);
        labelGroup.add(m);
      }
    }
    this.boardGroup.add(labelGroup);
  }

  #buildTable() {
    const floorY = -2.35;
    this.floorY = floorY;

    const wood = new THREE.MeshPhysicalMaterial({
      color: 0x1c1109,
      roughness: 0.42,
      metalness: 0.14,
      clearcoat: 0.34,
      clearcoatRoughness: 0.45,
      envMapIntensity: 0.24,
    });
    const stone = new THREE.MeshStandardMaterial({
      color: 0x09140f,
      roughness: 0.5,
      metalness: 0.26,
      envMapIntensity: 0.3,
    });
    const velvet = new THREE.MeshStandardMaterial({
      color: 0x14322a,
      roughness: 0.96,
      metalness: 0.01,
      envMapIntensity: 0.18,
    });
    this.hallMaterials = { wood, stone, velvet };

    const woodParts = [];
    const stoneParts = [];
    const velvetParts = [];
    const brassParts = [];
    const put = (list, geometry, position, rotation) => list.push(dressed(geometry, position, rotation));

    // Floor: polished stone that keeps going until the fog swallows it.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(120, 120),
      new THREE.MeshStandardMaterial({
        color: 0x06100c,
        roughness: 0.42,
        metalness: 0.42,
        envMapIntensity: 0.22,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = floorY;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Two steps up to the royal table.
    put(stoneParts, new RoundedBoxGeometry(23, 0.3, 21.4, 3, 0.08), [0, floorY + 0.16, 0]);
    put(stoneParts, new RoundedBoxGeometry(19.8, 0.3, 18.4, 3, 0.08), [0, floorY + 0.46, 0]);

    // The table: a carved slab wide enough for the board and the candlesticks,
    // with a wooden top face the board actually rests on.
    put(woodParts, new RoundedBoxGeometry(16.4, 1.04, 15.4, 4, 0.18), [0, -1.18, 0]);
    put(stoneParts, new RoundedBoxGeometry(17.2, 0.34, 16.2, 3, 0.1), [0, -1.84, 0]);
    put(woodParts, new RoundedBoxGeometry(16.6, 0.16, 15.6, 3, 0.06), [0, -0.74, 0]);
    for (const s of [-1, 1]) {
      put(brassParts, new THREE.BoxGeometry(16.7, 0.06, 0.12), [0, -0.68, s * 7.76]);
      put(brassParts, new THREE.BoxGeometry(0.12, 0.06, 15.7), [s * 8.26, -0.68, 0]);
      put(brassParts, new THREE.BoxGeometry(10.7, 0.03, 0.06), [0, -0.662, s * 5.33]);
      put(brassParts, new THREE.BoxGeometry(0.06, 0.03, 10.7), [s * 5.33, -0.662, 0]);
    }

    // Two thrones flank the table, facing it: a stone step, a tall carved back,
    // green velvet, brass finials and scrolls. They stand to the sides so the
    // camera never ends up behind one of them.
    const throne = (sign) => {
      const cx = sign * 11.6;
      const ry = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
      const cos = Math.cos(ry);
      const sin = Math.sin(ry);
      const at = (lx, y, lz) => [cx + lx * cos + lz * sin, floorY + y, -lx * sin + lz * cos];
      const add = (list, geometry, lx, y, lz, rx = 0) => put(list, geometry, at(lx, y, lz), [rx, ry, 0]);

      add(stoneParts, new RoundedBoxGeometry(4.6, 0.26, 4.2, 3, 0.08), 0, 0.13, 0, 0);
      for (const [lx, lz] of [[-1.5, -1.15], [1.5, -1.15], [-1.5, 1.15], [1.5, 1.15]]) {
        add(woodParts, new THREE.CylinderGeometry(0.13, 0.18, 1.1, 10), lx, 0.78, lz);
        add(brassParts, new THREE.CylinderGeometry(0.2, 0.2, 0.08, 12), lx, 0.3, lz);
      }
      add(woodParts, new RoundedBoxGeometry(3.5, 0.3, 2.9, 3, 0.09), 0, 1.5, 0);
      add(velvetParts, new RoundedBoxGeometry(3.05, 0.24, 2.45, 3, 0.09), 0, 1.75, 0);
      for (const s of [-1, 1]) {
        add(woodParts, new THREE.CylinderGeometry(0.12, 0.15, 2.9, 10), s * 1.62, 2.98, -1.3);
        add(brassParts, new THREE.SphereGeometry(0.2, 12, 10), s * 1.62, 4.53, -1.3);
        add(brassParts, new THREE.TorusGeometry(0.15, 0.03, 6, 14), s * 1.62, 4.32, -1.3, Math.PI / 2);
        add(woodParts, new THREE.BoxGeometry(0.18, 0.16, 1.7), s * 1.62, 2.2, -0.42);
        add(velvetParts, new THREE.BoxGeometry(0.2, 0.07, 1.6), s * 1.62, 2.3, -0.42);
        add(woodParts, new THREE.CylinderGeometry(0.1, 0.11, 0.8, 8), s * 1.62, 1.86, 0.44);
        add(brassParts, new THREE.SphereGeometry(0.12, 10, 8), s * 1.62, 2.2, 0.46);
      }
      add(woodParts, new RoundedBoxGeometry(3.3, 3, 0.24, 3, 0.08), 0, 3.08, -1.38, -0.04);
      add(velvetParts, new RoundedBoxGeometry(2.75, 2.4, 0.14, 3, 0.06), 0, 3.04, -1.24, -0.04);
      add(brassParts, new THREE.TorusGeometry(0.42, 0.06, 8, 20), 0, 4.72, -1.34);
      add(brassParts, new THREE.SphereGeometry(0.11, 10, 8), 0, 4.28, -1.3);
    };
    throne(1);
    throne(-1);

    for (const [radius, opacity] of [
      [12.6, 0.2],
      [15.4, 0.11],
      [18.6, 0.055],
    ]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.02, 6, 128),
        new THREE.MeshBasicMaterial({ color: 0xb18b52, transparent: true, opacity, blending: THREE.AdditiveBlending }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = floorY + 0.012;
      this.scene.add(ring);
    }

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(36, 36),
      new THREE.MeshBasicMaterial({
        map: radialTexture('rgba(255,172,92,.1)', 'rgba(0,0,0,0)'),
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = floorY + 0.01;
    this.scene.add(glow);

    const merged = (parts, material, cast = false) => {
      if (!parts.length) return;
      const mesh = new THREE.Mesh(mergeAll(parts), material);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };
    merged(stoneParts, stone);
    merged(woodParts, wood);
    merged(velvetParts, velvet);
    merged(brassParts, this.brassMaterial);
  }

  #buildRoom() {
    const floorY = this.floorY ?? -2.35;
    const stone = new THREE.MeshStandardMaterial({
      color: 0x0a1712,
      roughness: 0.64,
      metalness: 0.22,
      envMapIntensity: 0.32,
    });
    const wax = new THREE.MeshStandardMaterial({
      color: 0xe6d8b6,
      roughness: 0.55,
      metalness: 0.02,
      emissive: 0x3a2a12,
      emissiveIntensity: 0.55,
    });
    const shelfWood = new THREE.MeshStandardMaterial({
      color: 0x140d08,
      roughness: 0.82,
      metalness: 0.06,
      envMapIntensity: 0.14,
    });

    const columnParts = [];
    const brassParts = [];
    const waxParts = [];
    const flames = [];
    const put = (list, geometry, position, rotation) => list.push(dressed(geometry, position, rotation));

    // A round hall: tall columns carry a ring of arches, bookcases fill the bays
    // behind them, and a curved wall closes the room so the fog has an edge to
    // fade into instead of an open void.
    const R = 14.4;
    const bays = 16;
    const archRadius = R * Math.sin(Math.PI / bays);
    for (let i = 0; i < bays; i += 1) {
      const a = (i / bays) * Math.PI * 2;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      put(columnParts, new THREE.CylinderGeometry(0.88, 1.06, 0.4, 12), [x, floorY + 0.2, z]);
      put(columnParts, new THREE.CylinderGeometry(0.54, 0.68, 7.9, 14), [x, floorY + 4.35, z]);
      put(columnParts, new THREE.CylinderGeometry(0.84, 0.58, 0.36, 12), [x, floorY + 8.48, z]);
      put(columnParts, new RoundedBoxGeometry(1.7, 0.26, 1.7, 2, 0.06), [x, floorY + 8.79, z], [0, -a, 0]);
      put(brassParts, new THREE.TorusGeometry(0.64, 0.05, 6, 18), [x, floorY + 8.3, z], [Math.PI / 2, 0, 0]);
    }
    for (let i = 0; i < bays; i += 1) {
      const a = ((i + 0.5) / bays) * Math.PI * 2;
      put(
        columnParts,
        new THREE.TorusGeometry(archRadius, 0.12, 6, 18, Math.PI),
        [Math.cos(a) * R, floorY + 8.86, Math.sin(a) * R],
        [0, -a - Math.PI / 2, 0],
      );
    }
    put(columnParts, new THREE.TorusGeometry(R, 0.3, 6, 96), [0, floorY + 9.6, 0], [Math.PI / 2, 0, 0]);

    // Bookcases in the bays: tall dark cases with shelves and a hint of gilded
    // spines, so the room reads as a library rather than a void.
    const shelfParts = [];
    for (let i = 0; i < bays; i += 1) {
      const a = ((i + 0.5) / bays) * Math.PI * 2;
      const x = Math.cos(a) * (R + 1.6);
      const z = Math.sin(a) * (R + 1.6);
      const ry = -a - Math.PI / 2;
      const cos = Math.cos(ry);
      const sin = Math.sin(ry);
      put(shelfParts, new RoundedBoxGeometry(4.2, 7, 0.6, 2, 0.05), [x, floorY + 3.7, z], [0, ry, 0]);
      for (const level of [1.6, 3.2, 4.8, 6.2]) {
        put(shelfParts, new RoundedBoxGeometry(3.7, 0.14, 0.52, 2, 0.03), [x, floorY + level, z], [0, ry, 0]);
        for (let b = 0; b < 6; b += 1) {
          const off = -1.4 + b * 0.56;
          put(
            brassParts,
            new THREE.BoxGeometry(0.1, 1.06, 0.3),
            [x + cos * off, floorY + level + 0.6, z - sin * off],
            [0, ry, 0],
          );
        }
      }
    }

    // The curved wall behind the shelves.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 5, R + 5, 28, 40, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x050d0a,
        roughness: 0.96,
        metalness: 0.04,
        side: THREE.BackSide,
      }),
    );
    wall.position.y = floorY + 10;
    this.scene.add(wall);

    // Sconces on every fourth column, and candlesticks on the table.
    for (let i = 0; i < bays; i += 4) {
      const a = (i / bays) * Math.PI * 2;
      const x = Math.cos(a) * (R - 0.95);
      const z = Math.sin(a) * (R - 0.95);
      const y = floorY + 5.3;
      put(brassParts, new THREE.BoxGeometry(0.66, 0.12, 0.12), [x, y, z], [0, -a, 0]);
      put(brassParts, new THREE.CylinderGeometry(0.3, 0.17, 0.18, 10), [x, y + 0.07, z]);
      put(waxParts, new THREE.CylinderGeometry(0.1, 0.12, 0.72, 8), [x, y + 0.52, z]);
      flames.push(x, y + 0.98, z);
    }
    for (const x of [-6.9, 6.9]) {
      for (const z of [-6.5, 6.5]) {
        put(brassParts, new THREE.CylinderGeometry(0.3, 0.44, 0.12, 12), [x, -0.6, z]);
        put(brassParts, new THREE.CylinderGeometry(0.09, 0.15, 0.52, 10), [x, -0.3, z]);
        put(brassParts, new THREE.CylinderGeometry(0.22, 0.12, 0.1, 12), [x, -0.02, z]);
        put(waxParts, new THREE.CylinderGeometry(0.11, 0.13, 0.92, 10), [x, 0.49, z]);
        flames.push(x, 1.02, z);
      }
    }
    // Braziers between the thrones and the colonnade keep the ring alive.
    for (const a of [Math.PI * 0.25, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
      const x = Math.cos(a) * 11.9;
      const z = Math.sin(a) * 11.9;
      put(brassParts, new THREE.CylinderGeometry(0.11, 0.26, 2.4, 12), [x, floorY + 1.2, z]);
      put(brassParts, new THREE.CylinderGeometry(0.56, 0.26, 0.36, 16), [x, floorY + 2.5, z]);
      flames.push(x, floorY + 2.84, z);
    }

    const flameTexture = radialTexture('rgba(255,216,150,.95)', 'rgba(255,110,30,0)');
    const flameGeometry = new THREE.BufferGeometry();
    flameGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flames), 3));
    this.flameMaterial = new THREE.PointsMaterial({
      map: flameTexture,
      color: 0xffcd94,
      size: 0.9,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.scene.add(new THREE.Points(flameGeometry, this.flameMaterial));

    this.flameHaloMaterial = new THREE.PointsMaterial({
      map: flameTexture,
      color: 0xff9a4a,
      size: 3.4,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.scene.add(new THREE.Points(flameGeometry, this.flameHaloMaterial));

    const addMerged = (parts, material) => {
      if (!parts.length) return;
      const mesh = new THREE.Mesh(mergeAll(parts), material);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };
    addMerged(columnParts, stone);
    addMerged(shelfParts, shelfWood);
    addMerged(brassParts, this.brassMaterial);
    addMerged(waxParts, wax);

    // Fine suspended dust.
    const count = this.quality.dust;
    const positions = new Float32Array(count * 3);
    this.dustBase = new Float32Array(count * 3);
    const rand = seeded(97);
    for (let i = 0; i < count; i += 1) {
      const x = (rand() - 0.5) * 26;
      const y = rand() * 10 - 1;
      const z = (rand() - 0.5) * 34 - 4;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      this.dustBase[i * 3] = x;
      this.dustBase[i * 3 + 1] = y;
      this.dustBase[i * 3 + 2] = z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const dust = new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        color: 0xe7cf9d,
        size: 0.032,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.dust = dust;
    this.scene.add(dust);
  }

  #buildOverlays() {
    this.selectionGroup = new THREE.Group();
    this.legalGroup = new THREE.Group();
    this.lastMoveGroup = new THREE.Group();
    this.checkGroup = new THREE.Group();
    this.hintGroup = new THREE.Group();
    this.scene.add(this.selectionGroup, this.legalGroup, this.lastMoveGroup, this.checkGroup, this.hintGroup);

    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.38, 0.43, 48),
      new THREE.MeshBasicMaterial({
        color: 0xf3d99d,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.position.y = 0.086;
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);
  }

  #setupPost() {
    this.usePost = this.quality.bloom;
    if (!this.usePost) return;
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.12,
      0.5,
      1,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  #bindEvents() {
    this._onResize = () => this.resize();
    this._onMove = (e) => this.#onPointerMove(e);
    this._onDown = (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = 'grabbing';
    };
    this._onUp = (e) => {
      const start = this.pointerDown;
      this.pointerDown = null;
      this.canvas.style.cursor = this.hoverSquare ? 'pointer' : 'grab';
      if (!start) return;
      const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (dist > (e.pointerType === 'touch' ? 14 : 7)) return;
      const square = this.#pickSquare(e.clientX, e.clientY);
      if (square) this.onSquareClick(square);
    };
    this._onLeave = () => {
      this.hoverSquare = null;
      this.hoverRing.visible = false;
      this.canvas.style.cursor = 'default';
    };

    window.addEventListener('resize', this._onResize);
    this._onVisibility = () => this.#onVisibility();
    document.addEventListener('visibilitychange', this._onVisibility);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    this.controls.addEventListener('start', () => {
      this.cameraTween = null;
      this.controls.autoRotate = false;
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const aspect = w / h;
    const changed = Math.abs(aspect - this.camera.aspect) > 0.04;
    this.camera.aspect = aspect;
    this.#applyLens();
    this.#applyFraming();
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    if (changed && this.mode === 'game' && !this.topViewActive && !this.cameraTween) {
      this.camera.position.copy(this.#sidePosition(this.viewSide));
      this.controls.target.set(0, 0.42, 0);
      this.controls.update();
    }
  }

  /* ------------------------------------------------------- camera / mode */
  setMode(mode) {
    this.mode = mode;
    if (mode === 'lobby') {
      this.setInteractive(false);
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 0.55;
      this.#animateCamera(this.#lobbyPosition(), new THREE.Vector3(0, 0.55, 0), 1.8);
    } else {
      this.controls.autoRotate = false;
      this.#animateCamera(this.#sidePosition(this.viewSide), new THREE.Vector3(0, 0.42, 0), 1.4);
    }
  }

  #sidePosition(side) {
    const dir = side === 'b' ? new THREE.Vector3(-0.03, 0.58, -0.81) : new THREE.Vector3(0.03, 0.58, 0.81);
    return dir.normalize().multiplyScalar(this.fitDistance || this.#fitDistance());
  }

  topView() {
    this.controls.autoRotate = false;
    if (this.topViewActive) {
      this.topViewActive = false;
      this.setViewSide(this.viewSide, true);
      return;
    }
    this.topViewActive = true;
    const distance = (this.fitDistance || this.#fitDistance()) * 0.95;
    this.#animateCamera(
      new THREE.Vector3(0.01, distance, distance * 0.26),
      new THREE.Vector3(0, 0.3, 0.5),
      1.05,
    );
  }

  setViewSide(side, animate = true) {
    this.viewSide = side === 'b' ? 'b' : 'w';
    this.topViewActive = false;
    if (this.mode !== 'game') return;
    this.controls.autoRotate = false;
    if (animate) this.#animateCamera(this.#sidePosition(this.viewSide), new THREE.Vector3(0, 0.42, 0), 1.35);
    else {
      this.camera.position.copy(this.#sidePosition(this.viewSide));
      this.controls.target.set(0, 0.42, 0);
      this.controls.update();
    }
  }

  flipView() {
    this.setViewSide(this.viewSide === 'w' ? 'b' : 'w');
  }

  resetCamera() {
    this.setViewSide(this.viewSide, true);
  }

  orbitBy(theta, phi = 0) {
    this.cameraTween = null;
    this.controls.enabled = true;
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += theta;
    spherical.phi = clamp(spherical.phi + phi, this.controls.minPolarAngle, this.controls.maxPolarAngle);
    offset.setFromSpherical(spherical);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.controls.update();
  }

  zoomBy(factor) {
    this.cameraTween = null;
    this.controls.enabled = true;
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    offset.setLength(distance);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.controls.update();
  }

  #animateCamera(toPos, toTarget, duration) {
    this.cameraTween = {
      t: 0,
      duration,
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: this.controls.target.clone(),
      toTarget: toTarget.clone(),
    };
    this.controls.enabled = false;
  }

  setInteractive(value) {
    this.interactive = !!value;
    this.canvas.style.cursor = value ? 'grab' : 'default';
    if (!value) {
      this.hoverSquare = null;
      this.hoverRing.visible = false;
    }
  }

  /* ---------------------------------------------------------- position */
  setPosition(fen, { animate = false, lastMove = null, initial = false, duration = 0.42 } = {}) {
    const nextBoard = parseFen(fen);
    if (!this.pieces.size || initial) {
      this.#rebuild(nextBoard, { drop: true });
      this.#updateLastMove(lastMove);
      return;
    }
    if (!animate || !lastMove) {
      this.#rebuild(nextBoard, { drop: false });
      this.#updateLastMove(lastMove);
      return;
    }
    this.#animateMove(nextBoard, lastMove, duration);
  }

  #animateMove(nextBoard, lastMove, duration) {
    this.#flushMoves();
    const { from, to } = lastMove;
    const moving = this.pieces.get(from);
    if (!moving) {
      this.#rebuild(nextBoard, { drop: false });
      this.#updateLastMove(lastMove);
      return;
    }

    const start = moving.position.clone();
    const end = squarePos(to);
    const isKnight = moving.userData.type === 'n';
    const isPromotion = !!lastMove.promotion;
    const moveDuration = isPromotion ? duration * 1.3 : duration;
    this.moveToken += 1;
    this.animating = true;
    this.moveAnims = [
      {
        mesh: moving,
        start,
        end,
        t: 0,
        duration: moveDuration,
        arc: isKnight ? 0.72 : isPromotion ? 0.48 : 0.24,
        color: moving.userData.color,
        spin: isPromotion ? TAU : 0,
      },
    ];
    this.#moveTrail(start, end, isKnight, moving.userData.color);
    if (isPromotion) this.#promoteFlare(to, moving.userData.color);

    const captureSquare = lastMove.enPassant ? `${to[0]}${from[1]}` : to;
    const captured = this.pieces.get(captureSquare);
    if (captured && captured !== moving) {
      this.pieces.delete(captureSquare);
      this.moveAnims.push({
        mesh: captured,
        start: captured.position.clone(),
        end: captured.position.clone().add(new THREE.Vector3(0, -0.34, 0)),
        t: 0,
        duration: duration * 0.78,
        sink: true,
        spin: (Math.random() - 0.5) * 1.6,
      });
      this.#captureEffect(captured.position.clone(), captured.userData.color, moving.userData.color);
      this.pulses.push({ mesh: moving, t: 0, duration: 0.5 });
    }

    // Castling: move the rook together with the king.
    let castlingRook = null;
    if (moving.userData.type === 'k' && Math.abs(FILES.indexOf(to[0]) - FILES.indexOf(from[0])) === 2) {
      const rank = from[1];
      const rookFrom = to[0] === 'g' ? `h${rank}` : `a${rank}`;
      const rookTo = to[0] === 'g' ? `f${rank}` : `d${rank}`;
      const rook = this.pieces.get(rookFrom);
      if (rook) {
        castlingRook = { rook, from: rookFrom, to: rookTo };
        this.animating = true;
        this.moveAnims.push({
          mesh: rook,
          start: rook.position.clone(),
          end: squarePos(rookTo),
          t: 0,
          duration,
          arc: 0.1,
        });
      }
    }

    this.pieces.delete(from);
    moving.userData.square = to;
    this.pieces.set(to, moving);
    if (castlingRook) {
      castlingRook.rook.userData.square = castlingRook.to;
      this.pieces.delete(castlingRook.from);
      this.pieces.set(castlingRook.to, castlingRook.rook);
    }

    this.#updateLastMove(lastMove);
    this.#clearSelection();
    this.pendingBoard = nextBoard;
  }

  #flushMoves() {
    if (!this.moveAnims.length) {
      this.animating = false;
      return;
    }
    for (const anim of this.moveAnims) {
      if (anim.done) continue;
      anim.done = true;
      if (anim.sink) {
        this.boardGroup.remove(anim.mesh);
      } else {
        anim.mesh.position.copy(anim.end);
        anim.mesh.rotation.set(0, anim.mesh.rotation.y, 0);
        anim.mesh.scale.setScalar(1);
      }
    }
    this.moveAnims = [];
    this.animating = false;
  }

  #rebuild(nextBoard, { drop = false } = {}) {
    for (const [square, group] of this.pieces.entries()) group.userData.square = square;
    for (const [square, group] of [...this.pieces.entries()]) {
      const piece = nextBoard.get(square);
      if (!piece || piece.type !== group.userData.type || piece.color !== group.userData.color) {
        this.boardGroup.remove(group);
        this.pieces.delete(square);
      }
    }
    const busy = new Set();
    for (const anim of this.moveAnims) {
      if (!anim.done) busy.add(anim.mesh);
    }
    for (const spawn of this.spawnAnims) busy.add(spawn.group);
    for (const [square, group] of this.pieces.entries()) {
      if (busy.has(group)) continue;
      group.position.copy(squarePos(square));
      group.rotation.x = 0;
      group.rotation.z = 0;
      group.scale.setScalar(1);
    }

    let index = 0;
    for (const [square, piece] of nextBoard.entries()) {
      if (this.pieces.has(square)) continue;
      const group = createPiece(piece.type, piece.color);
      group.position.copy(squarePos(square));
      group.rotation.y = piece.type === 'n' ? (piece.color === 'w' ? Math.PI : 0) : 0;
      group.userData.square = square;
      this.boardGroup.add(group);
      this.pieces.set(square, group);
      if (drop) this.#queueDrop(group, index * 26 + 80);
      index += 1;
    }
  }

  #queueDrop(group, delay) {
    const target = group.position.clone();
    group.position.y = target.y + 1.8;
    group.scale.setScalar(0.82);
    this.spawnAnims.push({ group, target, t: -delay / 1000, duration: 0.72 });
  }

  clearBoard() {
    this.#flushMoves();
    this.pendingBoard = null;
    for (const group of this.pieces.values()) this.boardGroup.remove(group);
    this.pieces.clear();
    this.#clearSelection();
  }

  /* ------------------------------------------------------------ markers */
  #clearGroup(group, dispose = true) {
    while (group.children.length) {
      const child = group.children.pop();
      if (dispose) {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
        else child.material?.dispose?.();
      }
      group.remove(child);
    }
  }

  /**
   * Markers of selection, legal moves and the last move are the same handful of
   * shapes for the whole game: build them once instead of allocating a material
   * per click (a fresh material can drag a shader compile in with it).
   */
  #markerAssets() {
    if (this.markers) return this.markers;
    const additive = (color, opacity, side = THREE.DoubleSide) =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side,
      });
    const border = (color) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
    const glowGeometry = new THREE.PlaneGeometry(0.88, 0.88);
    const borderGeometry = new THREE.RingGeometry(0.4, 0.42, 4, 1);
    this.markers = {
      tile: { geometry: new THREE.PlaneGeometry(0.98, 0.98), material: additive(0xf0cd86, 0.16) },
      ring: { geometry: new THREE.TorusGeometry(0.4, 0.026, 10, 52), material: additive(0xf5d692, 0.95) },
      capture: { geometry: new THREE.TorusGeometry(0.36, 0.026, 8, 40), material: additive(0xe7ad74, 0.72) },
      dot: { geometry: new THREE.CircleGeometry(0.11, 24), material: additive(0xcfe3c2, 0.58) },
      lastGlowW: { geometry: glowGeometry, material: additive(0xd6b371, 0.13) },
      lastGlowB: { geometry: glowGeometry, material: additive(0x72b596, 0.13) },
      lastBorderW: { geometry: borderGeometry, material: border(0xefd196) },
      lastBorderB: { geometry: borderGeometry, material: border(0x8bd0ac) },
    };
    return this.markers;
  }

  clearSelection() {
    this.#clearSelection();
  }

  #clearSelection() {
    this.#clearGroup(this.selectionGroup, false);
    this.#clearGroup(this.legalGroup, false);
  }

  selectSquare(square, moves = []) {
    this.#clearSelection();
    const assets = this.#markerAssets();
    const pos = squarePos(square, 0.09);
    const tile = new THREE.Mesh(assets.tile.geometry, assets.tile.material);
    tile.rotation.x = -Math.PI / 2;
    tile.position.copy(pos);
    this.selectionGroup.add(tile);
    const ring = new THREE.Mesh(assets.ring.geometry, assets.ring.material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos);
    this.selectionGroup.add(ring);

    for (const [i, move] of moves.entries()) {
      const target = squarePos(move.to, 0.092);
      const capture = !!move.captured;
      const asset = capture ? assets.capture : assets.dot;
      const marker = new THREE.Mesh(asset.geometry, asset.material);
      marker.rotation.x = -Math.PI / 2;
      marker.position.copy(target);
      marker.userData.phase = i * 0.35;
      marker.userData.baseScale = 1;
      this.legalGroup.add(marker);
    }
  }

  #updateLastMove(lastMove) {
    this.#clearGroup(this.lastMoveGroup, false);
    if (!lastMove?.from || !lastMove?.to) return;
    const assets = this.#markerAssets();
    const glowAsset = lastMove.color === 'b' ? assets.lastGlowB : assets.lastGlowW;
    const borderAsset = lastMove.color === 'b' ? assets.lastBorderB : assets.lastBorderW;
    for (const square of [lastMove.from, lastMove.to]) {
      const glow = new THREE.Mesh(glowAsset.geometry, glowAsset.material);
      glow.rotation.x = -Math.PI / 2;
      glow.position.copy(squarePos(square, 0.083));
      this.lastMoveGroup.add(glow);
      const marker = new THREE.Mesh(borderAsset.geometry, borderAsset.material);
      marker.rotation.x = -Math.PI / 2;
      marker.rotation.z = Math.PI / 4;
      marker.position.copy(squarePos(square, 0.085));
      this.lastMoveGroup.add(marker);
    }
  }

  setCheck(square) {
    this.#clearGroup(this.checkGroup);
    if (!this.checkGlow) this.checkGlow = this.#makeGlow();
    if (!square) {
      this.checkGlow.mesh.visible = false;
      return;
    }
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.41, 0.03, 10, 48),
      new THREE.MeshBasicMaterial({
        color: 0xff6b57,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(squarePos(square, 0.094));
    this.checkGroup.add(ring);
    this.checkGlow.mesh.material.color.setHex(0xff5a44);
    this.checkGlow.mesh.material.opacity = 0.3;
    this.checkGlow.mesh.position.copy(squarePos(square, 0.72));
    this.checkGlow.mesh.scale.setScalar(1.9);
    this.checkGlow.mesh.visible = true;
  }

  setHint(move, duration = 4200) {
    clearTimeout(this.hintTimer);
    this.#clearGroup(this.hintGroup);
    if (!move?.from || !move?.to) return;
    for (const [square, color] of [
      [move.from, 0x8cd9b2],
      [move.to, 0xf1cd84],
    ]) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.4, 0.022, 8, 48),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(squarePos(square, 0.096));
      ring.userData.baseOpacity = 0.9;
      this.hintGroup.add(ring);
    }
    const a = squarePos(move.from, 0.12);
    const b = squarePos(move.to, 0.12);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, len, 8),
      new THREE.MeshBasicMaterial({
        color: 0xe7c98d,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    shaft.position.copy(mid);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    shaft.userData.baseOpacity = 0.6;
    this.hintGroup.add(shaft);
    this.hintTimer = setTimeout(() => this.#clearGroup(this.hintGroup), duration);
  }

  #makeTrail() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xf2d69a,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.visible = false;
    line.frustumCulled = false;
    this.scene.add(line);
    return { mesh: line, life: 0, maxLife: 0.55 };
  }

  #moveTrail(start, end, isKnight, color) {
    const trail = this.#lease(this.trailFree, () => this.#makeTrail());
    trail.life = 0;
    trail.maxLife = 0.55;
    trail.mesh.material.color.setHex(color === 'b' ? 0x9bd4b7 : 0xf2d69a);
    trail.mesh.material.opacity = 0.55;
    const attr = trail.mesh.geometry.attributes.position;
    const ax = start.x;
    const az = start.z;
    const bx = end.x;
    const bz = end.z;
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    const my = 0.22 + (isKnight ? 1.05 : 0.4);
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const t = i / (TRAIL_POINTS - 1);
      const u = 1 - t;
      attr.array[i * 3] = u * u * ax + 2 * u * t * mx + t * t * bx;
      attr.array[i * 3 + 1] = u * u * 0.22 + 2 * u * t * my + t * t * 0.22;
      attr.array[i * 3 + 2] = u * u * az + 2 * u * t * mz + t * t * bz;
    }
    attr.needsUpdate = true;
    this.trails.push(trail);
  }

  /**
   * One geometry and one material per colour, kept alive for the whole session.
   * Creating a material per burst and disposing it a second later forced the
   * renderer to compile the shader again on every capture — that was the freeze.
   */
  #burstAsset(color) {
    let asset = this.burstAssets.get(color);
    if (!asset) {
      asset = {
        geometry: new THREE.SphereGeometry(0.018, 5, 4),
        material: new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      };
      this.burstAssets.set(color, asset);
    }
    return asset;
  }

  #burst(origin, color = 0xe2c487, count = 24) {
    const total = Math.max(4, Math.round(count * this.quality.fx));
    const asset = this.#burstAsset(color);
    for (let i = 0; i < total; i += 1) {
      const mesh = new THREE.Mesh(asset.geometry, asset.material);
      mesh.position.copy(origin);
      const angle = Math.random() * TAU;
      const speed = 0.4 + Math.random() * 1.2;
      this.scene.add(mesh);
      this.particles.push({
        mesh,
        asset,
        velocity: new THREE.Vector3(Math.cos(angle) * speed * 0.55, 0.6 + Math.random() * 1.1, Math.sin(angle) * speed * 0.55),
        life: 0,
        maxLife: 0.65 + Math.random() * 0.55,
      });
    }
  }

  #makeRipple() {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.34, this.quality.ringSegments),
      new THREE.MeshBasicMaterial({
        color: 0xf2d69a,
        transparent: true,
        opacity: 0.62,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, t: 0, duration: 0.62 };
  }

  #ripple(position, color) {
    const ripple = this.#lease(this.rippleFree, () => this.#makeRipple());
    ripple.t = 0;
    ripple.duration = 0.62;
    ripple.mesh.material.color.setHex(color === 'b' ? 0x9bd4b7 : 0xf2d69a);
    ripple.mesh.material.opacity = 0.62;
    ripple.mesh.scale.setScalar(1);
    ripple.mesh.position.copy(position).setY(0.1);
    this.ripples.push(ripple);
  }

  #makeFlare() {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.32, 1.9, 18, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xf6dda2,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, t: 0, duration: 0.95, baseY: 1 };
  }

  #promoteFlare(square, color) {
    const flare = this.#lease(this.flareFree, () => this.#makeFlare());
    flare.t = 0;
    flare.duration = 0.95;
    flare.baseY = 1.0;
    flare.mesh.material.color.setHex(color === 'b' ? 0x8fd7b4 : 0xf6dda2);
    flare.mesh.material.opacity = 0.5;
    flare.mesh.scale.setScalar(1);
    flare.mesh.position.copy(squarePos(square, 1.0));
    this.flares.push(flare);
    this.#burst(squarePos(square, 0.5), 0xffe8b6, 26);
  }

  #makeGlow() {
    const mesh = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xffd7a0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, t: 0, duration: 0.45 };
  }

  /**
   * A flash used to be a PointLight: adding one changed the light count, so the
   * renderer rebuilt every shader twice per capture. An additive sprite glows
   * the same and costs nothing.
   */
  #flash(position, color) {
    const glow = this.#lease(this.glowFree, () => this.#makeGlow());
    glow.t = 0;
    glow.duration = 0.45;
    glow.mesh.material.color.setHex(color);
    glow.mesh.material.opacity = 0.7;
    glow.mesh.position.copy(position);
    glow.mesh.scale.setScalar(2.2);
    this.glows.push(glow);
  }

  #captureEffect(position, victimColor, captorColor) {
    const accent = victimColor === 'b' ? 0x9bd4b7 : 0xf2d69a;
    this.#burst(position.clone().setY(position.y + 0.46), accent, 22);
    this.#burst(position.clone().setY(position.y + 0.22), 0xffe9bd, 12);
    this.#ripple(position.clone(), victimColor);
    this.#shards(position.clone().setY(position.y + 0.42), this.quality.shards);
    this.#flash(position.clone().setY(0.85), captorColor === 'b' ? 0x8fd7b4 : 0xffd7a0);
  }

  #makeShard() {
    const mesh = new THREE.Mesh(
      new THREE.TetrahedronGeometry(0.05),
      new THREE.MeshStandardMaterial({
        color: 0xe9d9b8,
        roughness: 0.32,
        metalness: 0.3,
        transparent: true,
        opacity: 1,
      }),
    );
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, velocity: new THREE.Vector3(), spin: new THREE.Vector3(), t: 0, duration: 1 };
  }

  #shards(origin, count) {
    const total = Math.max(2, Math.round(count * (this.quality.mobile ? 0.7 : 1)));
    for (let i = 0; i < total; i += 1) {
      const shard = this.#lease(this.shardFree, () => this.#makeShard());
      shard.t = 0;
      shard.duration = 0.9 + Math.random() * 0.45;
      shard.mesh.position.copy(origin);
      shard.mesh.scale.setScalar(0.7 + Math.random() * 0.75);
      shard.mesh.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
      shard.mesh.material.opacity = 1;
      const angle = Math.random() * TAU;
      const speed = 0.9 + Math.random() * 1.5;
      shard.velocity.set(Math.cos(angle) * speed * 0.55, 1.2 + Math.random() * 1.4, Math.sin(angle) * speed * 0.55);
      shard.spin.set(Math.random() * 7, Math.random() * 7, Math.random() * 7);
      this.shards.push(shard);
    }
  }

  #updateEffects(dt) {
    if (this.ripples.length) {
      let live = 0;
      for (let i = 0; i < this.ripples.length; i += 1) {
        const ripple = this.ripples[i];
        ripple.t += dt;
        if (ripple.t >= ripple.duration) {
          this.#release(this.rippleFree, ripple);
          continue;
        }
        const k = clamp(ripple.t / ripple.duration, 0, 1);
        ripple.mesh.scale.setScalar(1 + k * 2.7);
        ripple.mesh.material.opacity = 0.62 * (1 - k);
        this.ripples[live] = ripple;
        live += 1;
      }
      this.ripples.length = live;
    }
    if (this.flares.length) {
      let live = 0;
      for (let i = 0; i < this.flares.length; i += 1) {
        const flare = this.flares[i];
        flare.t += dt;
        if (flare.t >= flare.duration) {
          this.#release(this.flareFree, flare);
          continue;
        }
        const k = clamp(flare.t / flare.duration, 0, 1);
        flare.mesh.material.opacity = 0.5 * (1 - k);
        flare.mesh.scale.set(1 + k * 0.45, 1 + k * 0.6, 1 + k * 0.45);
        flare.mesh.position.y = flare.baseY + k * 0.75;
        this.flares[live] = flare;
        live += 1;
      }
      this.flares.length = live;
    }
    if (this.shards.length) {
      let live = 0;
      for (let i = 0; i < this.shards.length; i += 1) {
        const shard = this.shards[i];
        shard.t += dt;
        if (shard.t >= shard.duration) {
          this.#release(this.shardFree, shard);
          continue;
        }
        shard.velocity.y -= 9.4 * dt;
        shard.mesh.position.addScaledVector(shard.velocity, dt);
        shard.mesh.rotation.x += shard.spin.x * dt;
        shard.mesh.rotation.y += shard.spin.y * dt;
        shard.mesh.rotation.z += shard.spin.z * dt;
        shard.mesh.material.opacity = clamp(1 - shard.t / shard.duration, 0, 1);
        this.shards[live] = shard;
        live += 1;
      }
      this.shards.length = live;
    }
    if (this.glows.length) {
      let live = 0;
      for (let i = 0; i < this.glows.length; i += 1) {
        const glow = this.glows[i];
        glow.t += dt;
        if (glow.t >= glow.duration) {
          this.#release(this.glowFree, glow);
          continue;
        }
        const k = clamp(glow.t / glow.duration, 0, 1);
        glow.mesh.material.opacity = 0.7 * (1 - k) ** 2;
        glow.mesh.scale.setScalar(1.4 + k * 1.9);
        this.glows[live] = glow;
        live += 1;
      }
      this.glows.length = live;
    }
    if (this.pulses.length) {
      let live = 0;
      for (let i = 0; i < this.pulses.length; i += 1) {
        const pulse = this.pulses[i];
        pulse.t += dt;
        if (pulse.t >= pulse.duration) {
          pulse.mesh.scale.setScalar(1);
          continue;
        }
        const k = clamp(pulse.t / pulse.duration, 0, 1);
        pulse.mesh.scale.setScalar(1 + Math.sin(k * Math.PI) * 0.14);
        this.pulses[live] = pulse;
        live += 1;
      }
      this.pulses.length = live;
    }
  }

  celebrate(winner) {
    const accent = winner === 'b' ? 0x8bd5b2 : 0xf0cf8b;
    const origin = new THREE.Vector3(0, 0.8, winner === 'b' ? -2 : 2);
    this.#burst(origin, accent, 60);
    this.#burst(origin.clone().add(new THREE.Vector3(0, 0.7, 0)), 0xffe6b0, 35);
    for (let i = -2; i <= 2; i += 1) {
      this.#ripple(new THREE.Vector3(i * 1.1, 0, winner === 'b' ? -2.4 : 2.4), winner === 'b' ? 'b' : 'w');
    }
    for (let i = 0; i < 5; i += 1) {
      setTimeout(() => {
        if (this.disposed) return;
        const spot = new THREE.Vector3((Math.random() - 0.5) * 7.5, 0.7 + Math.random() * 0.9, (Math.random() - 0.5) * 6.5);
        this.#burst(spot, i % 2 ? 0xffe6b0 : accent, 24);
        this.#ripple(spot.clone().setY(0), winner === 'b' ? 'b' : 'w');
      }, 180 + i * 170);
    }
    if (this.keyLight) {
      this.keyLight.color.set(winner === 'b' ? 0x9fe3c0 : 0xffd995);
      this.keyLight.intensity = this.keyLightBase * 1.55;
      setTimeout(() => {
        if (!this.keyLight) return;
        this.keyLight.color.set(0xffd9a3);
        this.keyLight.intensity = this.keyLightBase;
      }, 1900);
    }
  }

  /* -------------------------------------------------------------- input */
  #pickSquare(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Tall pieces hide the board plane. If a piece is under the cursor,
    // its own square wins: otherwise clicking the top of a king would map
    // to the empty square in front of it.
    const hits = this.raycaster.intersectObjects([...this.pieces.values()], true);
    for (const hit of hits) {
      let node = hit.object;
      while (node && !node.userData?.square) node = node.parent;
      if (node?.userData?.square) return node.userData.square;
    }

    const boardHits = this.raycaster.intersectObject(this.hitPlane, false);
    if (!boardHits.length) return null;
    const p = boardHits[0].point;
    return squareAt(p.x, p.z);
  }

  squareFromPoint(clientX, clientY) {
    return this.#pickSquare(clientX, clientY);
  }

  #onPointerMove(e) {
    if (!this.interactive || this.pointerDown) {
      if (this.hoverRing) this.hoverRing.visible = false;
      return;
    }
    const square = this.#pickSquare(e.clientX, e.clientY);
    if (square !== this.hoverSquare) {
      this.hoverSquare = square;
      this.canvas.style.cursor = square ? 'pointer' : 'grab';
      if (square) {
        this.hoverRing.visible = true;
        this.hoverRing.position.copy(squarePos(square, 0.086));
      } else {
        this.hoverRing.visible = false;
      }
    }
  }

  /* ------------------------------------------------------------- update */
  #loop() {
    this._raf = requestAnimationFrame(() => this.#loop());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this.#adaptQuality(dt);

    this.controls.update();
    this.#updateCamera(dt);
    this.#updatePieces(dt);
    this.#updateMarkers(dt);
    this.#updateDust(dt);
    this.#updateParticles(dt);
    this.#updateTrails(dt);
    this.#updateEffects(dt);

    if (this.flameMaterial) {
      const flicker = 0.9 + Math.sin(this.time * 7.3) * 0.07 + Math.sin(this.time * 13.1 + 1.7) * 0.04;
      this.flameMaterial.opacity = 0.95 * flicker;
      if (this.flameHaloMaterial) this.flameHaloMaterial.opacity = 0.22 * (0.82 + flicker * 0.22);
      // The two warm lamps behind the table breathe with the candles.
      if (this.brazierLights?.length) {
        this.brazierLights[0].intensity = 13 + flicker * 5;
        if (this.brazierLights[1]) this.brazierLights[1].intensity = 13 + (1.06 - flicker) * 5;
      }
    }

    if (this.usePost && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  #updateCamera(dt) {
    if (!this.cameraTween) return;
    this.cameraTween.t += dt;
    const raw = clamp(this.cameraTween.t / this.cameraTween.duration, 0, 1);
    const k = easeInOut(raw);
    this.camera.position.lerpVectors(this.cameraTween.fromPos, this.cameraTween.toPos, k);
    this.controls.target.lerpVectors(this.cameraTween.fromTarget, this.cameraTween.toTarget, k);
    if (raw >= 1) {
      this.cameraTween = null;
      this.controls.enabled = true;
    }
  }

  #updatePieces(dt) {
    if (!this.moveAnims.length && !this.spawnAnims.length) return;
    for (const anim of this.moveAnims) {
      if (anim.done) continue;
      anim.t += dt / anim.duration;
      const k = clamp(anim.t, 0, 1);
      const e = easeOut(k);
      anim.mesh.position.lerpVectors(anim.start, anim.end, e);
      if (anim.arc) anim.mesh.position.y += Math.sin(Math.PI * k) * anim.arc;
      if (anim.sink) {
        anim.mesh.scale.setScalar(1 - e * 0.62);
        anim.mesh.rotation.z = anim.spin * e;
        anim.mesh.rotation.x = e * 0.7;
      } else {
        const lift = Math.sin(Math.PI * k);
        anim.mesh.rotation.z = lift * (anim.start.x >= anim.end.x ? -0.08 : 0.08);
        anim.mesh.rotation.x = lift * 0.045;
        if (anim.spin) anim.mesh.rotation.y = anim.spin * e;
      }
      if (k >= 1) {
        anim.done = true;
        if (anim.sink) {
          this.boardGroup.remove(anim.mesh);
        } else {
          anim.mesh.rotation.z = 0;
          anim.mesh.rotation.x = 0;
          this.#burst(anim.end.clone().setY(0.16), anim.color === 'b' ? 0x9bd4b7 : 0xf2d69a, 6);
          this.#ripple(anim.end.clone(), anim.color);
        }
      }
    }

    for (const spawn of this.spawnAnims) {
      spawn.t += dt;
      if (spawn.t < 0) continue;
      const k = clamp(spawn.t / spawn.duration, 0, 1);
      const e = easeOutBack(k);
      spawn.group.position.y = spawn.target.y + (1 - e) * 1.8;
      spawn.group.scale.setScalar(clamp(0.82 + e * 0.18, 0.7, 1.08));
      if (k >= 1) {
        spawn.group.position.copy(spawn.target);
        spawn.group.scale.setScalar(1);
        spawn.done = true;
      }
    }
    let liveSpawns = 0;
    for (let i = 0; i < this.spawnAnims.length; i += 1) {
      if (this.spawnAnims[i].done) continue;
      this.spawnAnims[liveSpawns] = this.spawnAnims[i];
      liveSpawns += 1;
    }
    this.spawnAnims.length = liveSpawns;

    if (this.animating && this.moveAnims.length && this.moveAnims.every((anim) => anim.done)) {
      this.animating = false;
      this.moveAnims = [];
      if (this.pendingBoard) {
        const board = this.pendingBoard;
        this.pendingBoard = null;
        this.#rebuild(board, { drop: false });
      }
    }
  }

  #updateMarkers(dt) {
    for (const marker of this.legalGroup.children) {
      const phase = marker.userData.phase || 0;
      const pulse = 1 + Math.sin(this.time * 2.6 + phase) * 0.09;
      marker.scale.setScalar(pulse);
    }
    for (const child of this.selectionGroup.children) {
      const pulse = 1 + Math.sin(this.time * 3.2) * 0.025;
      child.scale.setScalar(pulse);
    }
    if (this.hoverRing) {
      this.hoverRing.material.opacity = 0.42 + Math.sin(this.time * 3.4) * 0.12;
    }
    if (this.hintGroup.children.length) {
      const glow = 0.65 + Math.sin(this.time * 4.4) * 0.35;
      for (const child of this.hintGroup.children) {
        child.material.opacity = (child.userData.baseOpacity || 0.6) * glow;
      }
    }
    if (this.checkGroup.children[0]) {
      const ring = this.checkGroup.children[0];
      const pulse = 1 + Math.sin(this.time * 4.4) * 0.06;
      ring.scale.setScalar(pulse);
    }
  }

  #updateDust(dt) {
    if (!this.dust) return;
    this.dustClock = (this.dustClock + 1) % 2;
    if (this.quality.mobile && this.dustClock) return;
    const attr = this.dust.geometry.attributes.position;
    for (let i = 0; i < attr.count; i += 1) {
      const baseY = this.dustBase[i * 3 + 1];
      attr.array[i * 3 + 1] = baseY + Math.sin(this.time * 0.35 + i) * 0.16;
      attr.array[i * 3] = this.dustBase[i * 3] + Math.sin(this.time * 0.12 + i * 0.7) * 0.2;
    }
    attr.needsUpdate = true;
    this.dust.rotation.y = this.time * 0.005;
  }

  #updateParticles(dt) {
    if (!this.particles.length) return;
    let live = 0;
    for (let i = 0; i < this.particles.length; i += 1) {
      const p = this.particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.scene.remove(p.mesh);
        continue;
      }
      p.velocity.y -= 1.5 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.scale.setScalar(1 - p.life / p.maxLife);
      this.particles[live] = p;
      live += 1;
    }
    this.particles.length = live;
  }

  #updateTrails(dt) {
    if (!this.trails.length) return;
    let live = 0;
    for (let i = 0; i < this.trails.length; i += 1) {
      const trail = this.trails[i];
      trail.life += dt;
      if (trail.life >= trail.maxLife) {
        this.#release(this.trailFree, trail);
        continue;
      }
      trail.mesh.material.opacity = 0.55 * (1 - trail.life / trail.maxLife);
      this.trails[live] = trail;
      live += 1;
    }
    this.trails.length = live;
  }

  #applyPixelRatio() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }

  /**
   * A phone that manages 60 fps at 1.25x is not the same as one that drops to
   * 30; instead of guessing, the renderer walks its own resolution down while
   * frames are slow and back up when there is headroom.
   */
  #adaptQuality(dt) {
    this.frameTime += (dt - this.frameTime) * 0.06;
    this.qualityClock += dt;
    if (this.qualityClock < 1.4) return;
    this.qualityClock = 0;
    const max = this.quality.maxPixelRatio;
    if (this.frameTime > 0.026 && this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.15);
      this.#applyPixelRatio();
    } else if (this.frameTime < 0.0145 && this.pixelRatio < max) {
      this.pixelRatio = Math.min(max, this.pixelRatio + 0.1);
      this.#applyPixelRatio();
    }
  }

  #onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      return;
    }
    if (this._raf || this.disposed) return;
    this.clock.getDelta();
    this.#loop();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this.hintTimer);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.controls.dispose();
    this.renderer.dispose();
    this.composer?.dispose?.();
    for (const asset of this.burstAssets.values()) {
      asset.geometry.dispose();
      asset.material.dispose();
    }
    for (const item of [...this.shardPool, ...this.ripplePool, ...this.flarePool, ...this.glowPool, ...this.trailPool]) {
      item.mesh.geometry?.dispose?.();
      item.mesh.material?.dispose?.();
    }
    if (this.markers) {
      const done = new Set();
      for (const asset of Object.values(this.markers)) {
        for (const item of [asset.geometry, asset.material]) {
          if (!item || done.has(item)) continue;
          done.add(item);
          item.dispose?.();
        }
      }
    }
    this.checkGlow?.mesh?.material?.dispose?.();
    this.glowTexture?.dispose?.();
    this.envMap?.dispose?.();
    const seen = new Set();
    this.scene.traverse((object) => {
      if (object.geometry && !seen.has(object.geometry)) {
        seen.add(object.geometry);
        object.geometry.dispose();
      }
      const material = object.material;
      const list = Array.isArray(material) ? material : material ? [material] : [];
      for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        for (const value of Object.values(item)) {
          if (value && value.isTexture && !seen.has(value)) {
            seen.add(value);
            value.dispose();
          }
        }
        item.dispose?.();
      }
    });
  }
}

export { squarePos, pieceGlyph };
