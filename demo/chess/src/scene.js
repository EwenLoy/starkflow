import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createPiece, pieceGlyph } from './pieces.js?v=20261029-2';

const FILES = 'abcdefgh';
// The board tiles finish at y = 0.0795. Pieces used to stand at 0.105 — a
// visible float once the contact shadow was added, so they sit on the wood now.
const PIECE_Y = 0.085;
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

/**
 * One atlas for all sixteen board marks. The old code built a 128×128 canvas,
 * a texture and a material *per label*: 32 textures, 32 programs, 32 draw calls
 * and ~2 MB of VRAM for eight letters and eight digits.
 */
function labelAtlas() {
  const cell = 128;
  const cols = 8;
  const rows = 2;
  const canvas = document.createElement('canvas');
  canvas.width = cell * cols;
  canvas.height = cell * rows;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(218,184,119,.82)';
  ctx.font = '500 62px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 8; i += 1) {
    ctx.fillText(FILES[i], i * cell + cell / 2, cell / 2 + 3);
    ctx.fillText(String(i + 1), i * cell + cell / 2, cell + cell / 2 + 3);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  // No mipmaps: at 26 px a mip level would smear one glyph into its neighbour.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
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
    this.renderer.toneMappingExposure = 0.8;
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
    this.#warmEffects();
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
    const { w, h, freeW, freeH } = this.#freeBox();
    const fov = this.camera.fov || 36;
    const aspect = this.camera.aspect || 1;
    const tanHalf = Math.tan((fov * Math.PI) / 360);
    // How much of the frame the HUD leaves free, in normalised device units.
    const xLimit = clamp(freeW / w, 0.4, 1);
    const yLimit = clamp(freeH / h, 0.4, 1);

    // Flat estimate first, then measure the real corners. A tilted board is not
    // a flat billboard: its near edge is a few units closer to the lens, so it
    // projects wider than the distance-to-target maths suggests — that is how a
    // portrait phone ended up with the board hanging over both edges.
    let distance = clamp(
      Math.max(5.05 / (tanHalf * aspect * xLimit), 5.05 / (tanHalf * yLimit)),
      7.8,
      46,
    );

    const probe = new THREE.PerspectiveCamera(fov, aspect, 0.1, 200);
    const dir =
      this.viewSide === 'b'
        ? new THREE.Vector3(-0.02, 0.92, -0.72).normalize()
        : new THREE.Vector3(0.02, 0.92, 0.72).normalize();
    const target = this.#boardTarget(this.viewSide);
    const corners = [];
    for (const x of [-4.92, 4.92]) {
      for (const z of [-4.92, 4.92]) {
        for (const y of [-0.3, 2.05]) corners.push(new THREE.Vector3(x, y, z));
      }
    }

    for (let pass = 0; pass < 3; pass += 1) {
      probe.position.copy(dir).multiplyScalar(distance);
      probe.lookAt(target);
      probe.updateMatrixWorld(true);
      probe.updateProjectionMatrix();
      let worst = 1;
      for (const corner of corners) {
        const projected = corner.clone().project(probe);
        worst = Math.max(worst, Math.abs(projected.x) / xLimit, Math.abs(projected.y) / yLimit);
      }
      distance *= worst * 1.02;
    }
    return clamp(distance, 7.8, 60);
  }

  /**
   * The HUD tells the camera how much room it has left. Two ideas keep this
   * honest: the distance grows so the board fits between the strips, and the
   * camera slides along its own up vector (target included) so the board sits in
   * the middle of that gap without changing the perspective by a degree.
   */
  setHudInsets({ top = 0, bottom = 0, left = 0, right = 0 } = {}) {
    const next = { top, bottom, left, right };
    const prev = this.hudInsets || { top: 0, bottom: 0, left: 0, right: 0 };
    const changed = ['top', 'bottom', 'left', 'right'].some((key) => Math.abs(next[key] - prev[key]) > 1.5);
    this.hudInsets = next;
    if (!changed) return;
    this.#applyFraming();
    if (this.cameraTween) return;
    if (this.mode === 'game' && !this.topViewActive) {
      this.#placeCamera(this.#sidePosition(this.viewSide), this.#boardTarget(this.viewSide));
    }
  }

  #freeBox() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const insets = this.hudInsets || { top: 0, bottom: 0, left: 0, right: 0 };
    return {
      w,
      h,
      freeW: Math.max(w * 0.5, w - insets.left - insets.right),
      freeH: Math.max(h * 0.4, h - insets.top - insets.bottom),
    };
  }

  #hudShift(toPos, toTarget) {
    const insets = this.hudInsets || { top: 0, bottom: 0 };
    const h = window.innerHeight || 1;
    const freeTop = clamp(insets.top, 0, h);
    const freeBottom = h - clamp(insets.bottom, 0, h);
    const ndc = 1 - (2 * ((freeTop + freeBottom) * 0.5)) / h;
    if (Math.abs(ndc) < 1e-3) return new THREE.Vector3();
    const distance = toPos.distanceTo(toTarget);
    const halfFov = ((this.camera.fov || 36) * Math.PI) / 360;
    const shift = -ndc * distance * Math.tan(halfFov);
    const look = new THREE.Matrix4().lookAt(toPos, toTarget, new THREE.Vector3(0, 1, 0));
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(new THREE.Matrix4().extractRotation(look));
    return up.multiplyScalar(shift);
  }

  #placeCamera(position, target) {
    const shift = this.#hudShift(position, target);
    this.controls.target.copy(target).add(shift);
    this.camera.position.copy(position).add(shift);
    this.controls.update();
  }

  #applyFraming() {
    this.fitDistance = this.#fitDistance();
    // The limits have to contain the fit distance itself, otherwise OrbitControls
    // clamps the camera on its very first update and the board is cropped — a
    // portrait phone needs a distance of ~27 units, which the old cap of 24 cut.
    this.controls.minDistance = Math.max(5, this.fitDistance * 0.55);
    this.controls.maxDistance = Math.max(this.fitDistance * 1.6, 24);
    // The haze is a look, not a ruler: a phone pulls the camera back, so the
    // density follows, otherwise the board would drown in fog.
    if (this.scene.fog) this.scene.fog.density = 0.0155 * clamp(13.4 / this.fitDistance, 0.42, 1);
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
    this.particleFree = [];
    this.shardMaterial = null;
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

  /**
   * Everything a move throws at the screen - sparkle, ripple, flare, shards, the
   * knight trail - is created and compiled here, while the lobby is still up.
   * Leasing them lazily meant a new geometry, a new material and a shader build in
   * the very frame a piece landed: that was the freeze on every first move.
   */
  #warmEffects() {
    const warm = (free, make, count) => {
      for (let i = 0; i < count; i += 1) {
        const item = make();
        item.mesh.visible = true;
        free.push(item);
      }
    };
    warm(this.rippleFree, () => this.#makeRipple(), 4);
    warm(this.flareFree, () => this.#makeFlare(), 3);
    warm(this.glowFree, () => this.#makeGlow(), 4);
    warm(this.shardFree, () => this.#makeShard(), Math.max(8, this.quality.shards));
    warm(this.trailFree, () => this.#makeTrail(), 2);

    const spark = this.#burstAsset(0xe2c487);
    for (const color of [0x9bd4b7, 0xf2d69a, 0xffe8b6, 0xffe9bd, 0xffd7a0, 0x8fd7b4, 0xf6dda2, 0xffe6b0, 0x8bd5b2, 0xf0cf8b]) {
      this.#burstAsset(color);
    }
    const sparks = Math.max(30, Math.round(70 * this.quality.fx));
    for (let i = 0; i < sparks; i += 1) {
      const mesh = new THREE.Mesh(spark.geometry, spark.material);
      mesh.position.set(0, 0.4, 0);
      this.scene.add(mesh);
      this.particleFree.push(mesh);
    }

    // The programs are warmed by precompile(), which the app calls after the
    // starting position exists: compiling here meant the pieces (built a moment
    // later) still paid for their programs on the first visible frame.

    for (const item of [...this.shardFree, ...this.rippleFree, ...this.flareFree, ...this.glowFree, ...this.trailFree]) {
      item.mesh.visible = false;
    }
    for (const mesh of this.particleFree) mesh.visible = false;
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
    // The wash carries a little more weight than before: the black set needs
    // *some* diffuse term or the pieces read as holes in the board.
    this.scene.add(new THREE.HemisphereLight(0x7c93a6, 0x0a1410, 0.34));

    const key = new THREE.SpotLight(0xffd7ab, 96, 26, 0.5, 0.9, 2);
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

    // A broad overhead shaft straight down on the table: the pool that makes the
    // board readable from a low camera. No cone mesh - it read as a curtain - and
    // no shadow map: the key already casts the only shadow in the room.
    const shaft = new THREE.SpotLight(0xfff0d2, 72, 28, 0.44, 0.95, 2);
    shaft.position.set(0.4, 15.6, 1.2);
    shaft.target.position.set(0, 0, 0);
    this.scene.add(shaft, shaft.target);
    this.shaftLight = shaft;

    // The cool rim that used to stand behind the black side is gone: its wide
    // cone flooded the far throne, the columns and the floor, so a camera on
    // the black side saw a light the mirrored white view did not.

    // One warm pool per candlestick on the table - four candles, four lights, so
    // no candle is left standing there dark.
    this.candleLights = [];
    for (const cx of [-6.9, 6.9]) {
      for (const cz of [-6.5, 6.5]) {
        const pool = new THREE.PointLight(0xffab5c, 12, 13, 2);
        pool.position.set(cx, 1.15, cz);
        this.scene.add(pool);
        this.candleLights.push(pool);
      }
    }
    // Two warm washes behind the colonnade: the library has to read from the
    // table, but low enough that the hall stays a dark cathedral.
    this.libraryLights = [];
    for (const [lx, lz] of [[16, 16], [-16, -16]]) {
      const wash = new THREE.PointLight(0xffb066, 40, 34, 2);
      wash.position.set(lx, 10.5, lz);
      this.scene.add(wash);
      this.libraryLights.push(wash);
    }
  }

  #buildBoard() {
    // Slightly deeper than before on both sides: ivory pieces were landing on
    // cream squares with almost no value difference, and the black set needed
    // the dark squares lifted so it stops merging with them.
    const lightTex = marbleTexture({
      base: '#e2d7bd',
      vein: '#94866c',
      fleck: 'rgba(255,248,223,.7)',
      seed: 11,
    });
    const darkTex = marbleTexture({
      base: '#15463a',
      vein: '#04130e',
      fleck: 'rgba(174,218,187,.35)',
      seed: 31,
      dark: true,
    });

    const lightMat = new THREE.MeshPhysicalMaterial({
      map: lightTex,
      bumpMap: lightTex,
      bumpScale: 0.01,
      // Matte marble: a polished clearcoat turned the whole near half of the
      // board into a mirror of the key light whenever the camera sat on the
      // black side, so both the coat and the grazing sheen are toned down.
      roughness: 0.7,
      metalness: 0,
      clearcoat: 0,
      envMapIntensity: 0.16,
      specularIntensity: 0.32,
    });
    const darkMat = new THREE.MeshPhysicalMaterial({
      map: darkTex,
      bumpMap: darkTex,
      bumpScale: 0.012,
      roughness: 0.68,
      metalness: 0.02,
      clearcoat: 0,
      envMapIntensity: 0.16,
      specularIntensity: 0.32,
    });
    this.squareMaterials = { light: lightMat, dark: darkMat };

    const wood = new THREE.MeshPhysicalMaterial({
      color: 0x142720,
      roughness: 0.46,
      metalness: 0.1,
      clearcoat: 0.12,
      clearcoatRoughness: 0.75,
      envMapIntensity: 0.32,
      specularIntensity: 0.3,
    });
    const stone = new THREE.MeshPhysicalMaterial({
      color: 0x0a1511,
      roughness: 0.52,
      metalness: 0.05,
      clearcoat: 0.06,
      clearcoatRoughness: 0.85,
      envMapIntensity: 0.24,
      specularIntensity: 0.22,
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

    // 64 tiles were 64 draw calls for two materials. They never move, so they
    // bake into two meshes; the rounded bevel survives the merge.
    const lightTiles = [];
    const darkTiles = [];
    for (let rank = 1; rank <= 8; rank += 1) {
      for (let file = 0; file < 8; file += 1) {
        const tile = dressed(new RoundedBoxGeometry(0.965, 0.065, 0.965, 3, 0.018), [
          file - 3.5,
          0.047,
          3.5 - (rank - 1),
        ]);
        ((file + rank) % 2 === 0 ? lightTiles : darkTiles).push(tile);
      }
    }
    for (const [tiles, material] of [
      [lightTiles, lightMat],
      [darkTiles, darkMat],
    ]) {
      const mesh = new THREE.Mesh(mergeAll(tiles), material);
      mesh.receiveShadow = true;
      this.boardGroup.add(mesh);
    }

    // Thin brass separators around the playing field, plus the engraved corner
    // ornaments: one brass mesh for all four sides and all four arcs.
    const brassTrim = [];
    const brassDots = [];
    for (const offset of [-4.08, 4.08]) {
      brassTrim.push(dressed(new THREE.BoxGeometry(8.18, 0.018, 0.028), [0, 0.084, offset]));
      brassTrim.push(dressed(new THREE.BoxGeometry(0.028, 0.018, 8.18), [offset, 0.084, 0]));
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        brassTrim.push(
          dressed(
            new THREE.TorusGeometry(0.27, 0.012, 6, 24, Math.PI / 2),
            [sx * 4.22, 0.083, sz * 4.22],
            [Math.PI / 2, 0, sx * sz > 0 ? Math.PI : Math.PI / 2],
          ),
        );
        brassDots.push(dressed(new THREE.SphereGeometry(0.035, 12, 8), [sx * 4.39, 0.087, sz * 4.39]));
      }
    }
    this.boardGroup.add(new THREE.Mesh(mergeAll(brassTrim), brass));
    this.boardGroup.add(new THREE.Mesh(mergeAll(brassDots), brassDim));

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
    const material = new THREE.MeshBasicMaterial({
      map: labelAtlas(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const quad = new THREE.PlaneGeometry(0.45, 0.45);
    const parts = [];
    // The atlas holds letters on the top row and digits on the bottom one.
    const add = (col, row, position, rotation) => {
      const geometry = quad.clone();
      const uv = geometry.attributes.uv;
      for (let i = 0; i < uv.count; i += 1) {
        uv.setXY(i, (col + uv.getX(i)) / 8, 1 - (row + 1) / 2 + uv.getY(i) / 2);
      }
      parts.push(dressed(geometry, position, rotation));
    };

    for (let i = 0; i < 8; i += 1) {
      const x = i - 3.5;
      add(i, 0, [x, 0.086, 4.47], [-Math.PI / 2, 0, 0]);
      add(i, 0, [x, 0.086, -4.47], [-Math.PI / 2, 0, Math.PI]);
    }
    for (let rank = 1; rank <= 8; rank += 1) {
      const z = 3.5 - (rank - 1);
      add(rank - 1, 1, [-4.47, 0.086, z], [-Math.PI / 2, 0, -Math.PI / 2]);
      add(rank - 1, 1, [4.47, 0.086, z], [-Math.PI / 2, 0, Math.PI / 2]);
    }

    const mesh = new THREE.Mesh(mergeAll(parts), material);
    this.boardGroup.add(mesh);
  }

  #buildTable() {
    const floorY = -2.35;
    this.floorY = floorY;

    const wood = new THREE.MeshPhysicalMaterial({
      color: 0x1c1109,
      // The tabletop was a mirror at a low camera: a candle flame turned into
      // a big oval pool next to the board. Matte it like the tiles.
      roughness: 0.66,
      metalness: 0.04,
      clearcoat: 0.04,
      clearcoatRoughness: 0.85,
      envMapIntensity: 0.14,
      specularIntensity: 0.18,
    });
    const stone = new THREE.MeshStandardMaterial({
      color: 0x09140f,
      roughness: 0.6,
      metalness: 0.08,
      envMapIntensity: 0.12,
    });
    const velvet = new THREE.MeshPhysicalMaterial({
      color: 0x141110,
      roughness: 0.94,
      metalness: 0.02,
      sheen: 0.6,
      sheenRoughness: 0.65,
      sheenColor: 0x7d6c52,
      envMapIntensity: 0.16,
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
        // A metallic floor mirrored the bright studio environment whenever the
        // camera grazed it from the black side, which read as a stray light.
        roughness: 0.64,
        metalness: 0.08,
        envMapIntensity: 0.08,
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

    // A gilded throne on each end of the board: black tufted velvet in an ornate
    // gold frame, two columns with urn finials, scrolled arms with rosettes and a
    // crested top. There is a short stone step under it, and both stand far enough
    // out that the orbit never reaches them.
    const throne = (sign) => {
      const cz = sign * 17.5;
      const ry = sign > 0 ? Math.PI : 0;
      const cos = Math.cos(ry);
      const sin = Math.sin(ry);
      const at = (lx, y, lz) => [lx * cos + lz * sin, floorY + y, cz - lx * sin + lz * cos];
      const add = (list, geometry, lx, y, lz, rx = 0) => put(list, geometry, at(lx, y, lz), [rx, ry, 0]);

      // step, moulded base, corner bosses and the rosette on the front
      add(stoneParts, new RoundedBoxGeometry(5.4, 0.26, 4.5, 3, 0.08), 0, 0.13, 0, 0);
      add(brassParts, new RoundedBoxGeometry(4.8, 0.2, 3.9, 3, 0.06), 0, 0.28, 0, 0);
      add(brassParts, new RoundedBoxGeometry(4.4, 0.36, 3.5, 3, 0.08), 0, 0.48, 0);
      add(brassParts, new THREE.TorusGeometry(0.3, 0.075, 8, 16), 0, 0.48, 1.76);
      add(brassParts, new THREE.SphereGeometry(0.15, 12, 10), 0, 0.48, 1.83);
      for (const s of [-1, 1]) {
        add(brassParts, new THREE.SphereGeometry(0.21, 14, 12), s * 1.88, 0.54, 1.56);
      }

      // seat: gold frame, thick black cushion
      add(brassParts, new RoundedBoxGeometry(4.05, 0.3, 3.25, 3, 0.08), 0, 0.82, 0);
      add(velvetParts, new RoundedBoxGeometry(3.55, 0.34, 2.8, 4, 0.14), 0, 1.06, 0.05);

      // two gold columns with collars and urn finials
      for (const s of [-1, 1]) {
        add(brassParts, new THREE.CylinderGeometry(0.17, 0.21, 5.3, 12), s * 1.88, 3.66, -1.34);
        add(brassParts, new THREE.CylinderGeometry(0.27, 0.27, 0.16, 12), s * 1.88, 1.12, -1.34);
        add(brassParts, new THREE.CylinderGeometry(0.24, 0.27, 0.2, 12), s * 1.88, 6.16, -1.34);
        add(brassParts, new THREE.SphereGeometry(0.24, 14, 12), s * 1.88, 6.5, -1.34);
        add(brassParts, new THREE.ConeGeometry(0.13, 0.34, 10), s * 1.88, 6.84, -1.34);
      }

      // the back: gold surround, tufted velvet panel, diamond buttons, crest
      add(brassParts, new RoundedBoxGeometry(3.75, 5.2, 0.34, 3, 0.1), 0, 3.75, -1.44, -0.03);
      add(velvetParts, new RoundedBoxGeometry(2.95, 4.35, 0.2, 4, 0.1), 0, 3.68, -1.24, -0.03);
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const bx = (col - 1) * 0.88 + (row % 2 ? 0.44 : 0);
          add(brassParts, new THREE.SphereGeometry(0.075, 8, 6), bx, 2.0 + row * 0.8, -1.14);
        }
      }
      add(brassParts, new THREE.TorusGeometry(0.66, 0.09, 8, 20, Math.PI), 0, 6.34, -1.38);
      add(brassParts, new THREE.SphereGeometry(0.19, 12, 10), 0, 6.72, -1.38);
      add(brassParts, new THREE.ConeGeometry(0.11, 0.3, 10), 0, 7.0, -1.38);

      // scrolled arms with a rosette and a black velvet pad
      for (const s of [-1, 1]) {
        add(brassParts, new THREE.CylinderGeometry(0.15, 0.2, 0.95, 10), s * 1.88, 1.4, 0.34);
        add(brassParts, new THREE.BoxGeometry(0.26, 0.16, 2.1), s * 1.88, 1.92, -0.5);
        add(brassParts, new THREE.SphereGeometry(0.2, 12, 10), s * 1.88, 1.92, 0.6);
        add(brassParts, new THREE.CylinderGeometry(0.1, 0.1, 0.08, 10), s * 2.0, 1.92, 0.6);
        add(velvetParts, new THREE.BoxGeometry(0.3, 0.08, 1.9), s * 1.88, 2.03, -0.55);
      }
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
        opacity: 0.42,
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
    const marbleCol = new THREE.MeshStandardMaterial({
      color: 0x1d2023,
      // Fluted columns used to catch the environment at a grazing angle and
      // turn silver from one camera side; keep the marble, lose the mirror.
      roughness: 0.6,
      metalness: 0.05,
      envMapIntensity: 0.15,
    });
    const wax = new THREE.MeshStandardMaterial({
      color: 0xe6d8b6,
      roughness: 0.55,
      metalness: 0.02,
      emissive: 0x3a2a12,
      emissiveIntensity: 0.55,
    });
    const shelfWood = new THREE.MeshStandardMaterial({
      color: 0x2b1a0f,
      roughness: 0.82,
      metalness: 0.04,
      emissive: 0x0b0603,
      emissiveIntensity: 0.5,
      envMapIntensity: 0.16,
    });
    const bookLeather = new THREE.MeshStandardMaterial({
      color: 0x7a3128,
      roughness: 0.86,
      metalness: 0.06,
      emissive: 0x2c100b,
      emissiveIntensity: 1,
      envMapIntensity: 0.12,
    });
    // Spines and shelves glow a little of their own: the library has to read from
    // across a hall that is, by design, mostly dark.
    const goldSpine = new THREE.MeshStandardMaterial({
      color: 0xd8b06a,
      roughness: 0.34,
      metalness: 0.7,
      emissive: 0x4a3513,
      emissiveIntensity: 1,
      envMapIntensity: 0.6,
    });
    const paleSpine = new THREE.MeshStandardMaterial({
      color: 0xe3d7ba,
      roughness: 0.6,
      metalness: 0.02,
      emissive: 0x3d3527,
      emissiveIntensity: 1,
      envMapIntensity: 0.2,
    });
    const emeraldSpine = new THREE.MeshStandardMaterial({
      color: 0x35664a,
      roughness: 0.5,
      metalness: 0.12,
      emissive: 0x0e2418,
      emissiveIntensity: 1,
      envMapIntensity: 0.3,
    });
    const indigoSpine = new THREE.MeshStandardMaterial({
      color: 0x35406e,
      roughness: 0.55,
      metalness: 0.1,
      emissive: 0x101733,
      emissiveIntensity: 1,
      envMapIntensity: 0.3,
    });
    const slateSpine = new THREE.MeshStandardMaterial({
      color: 0x4a4148,
      roughness: 0.6,
      metalness: 0.08,
      emissive: 0x16121a,
      emissiveIntensity: 1,
      envMapIntensity: 0.2,
    });
    const carpet = new THREE.MeshStandardMaterial({
      color: 0x3c1016,
      roughness: 0.95,
      metalness: 0.02,
      emissive: 0x180609,
      emissiveIntensity: 0.8,
      envMapIntensity: 0.1,
    });

    const marbleParts = [];
    const brassParts = [];
    const waxParts = [];
    const carpetParts = [];
    const flames = [];
    const put = (list, geometry, position, rotation) => list.push(dressed(geometry, position, rotation));

    // A round hall: fluted marble columns carry a ring of arches, tall bookcases
    // fill the bays behind them, and a curved wall closes the room. The shafts are
    // tall enough that their capitals stay out of frame - the hall has no ceiling
    // you can see, only darkness above.
    const R = 22.5;
    const bays = 20;
    const shaft = 17.6;
    const archRadius = R * Math.sin(Math.PI / bays);
    for (let i = 0; i < bays; i += 1) {
      const a = (i / bays) * Math.PI * 2;
      const x = Math.cos(a) * R;
      const z = Math.sin(a) * R;
      const capY = floorY + 0.74 + shaft;

      // base: plinth, torus, and the apophyge above it
      put(marbleParts, new THREE.CylinderGeometry(1.3, 1.5, 0.44, 16), [x, floorY + 0.22, z]);
      put(marbleParts, new THREE.CylinderGeometry(1.14, 1.28, 0.26, 16), [x, floorY + 0.57, z]);
      put(brassParts, new THREE.TorusGeometry(1.16, 0.045, 6, 22), [x, floorY + 0.72, z], [Math.PI / 2, 0, 0]);

      // fluted shaft: a tapered drum with the fillets between the flutes standing
      // proud of it, which is what reads as fluting from any distance
      put(marbleParts, new THREE.CylinderGeometry(0.74, 0.94, shaft, 20), [x, floorY + 0.74 + shaft / 2, z]);
      for (let f = 0; f < 20; f += 1) {
        const t = (f / 20) * Math.PI * 2;
        put(
          marbleParts,
          new THREE.BoxGeometry(0.09, shaft - 0.5, 0.09),
          [x + Math.cos(t) * 0.85, floorY + 0.74 + shaft / 2, z + Math.sin(t) * 0.85],
          [0, -t, 0],
        );
      }

      // Ionic capital: echinus, two volutes turned to the bay, abacus
      put(marbleParts, new THREE.CylinderGeometry(1.04, 0.78, 0.38, 16), [x, capY + 0.17, z]);
      for (const s of [-1, 1]) {
        put(
          marbleParts,
          new THREE.TorusGeometry(0.32, 0.11, 8, 18),
          [x + Math.cos(a + Math.PI / 2) * 0.94 * s, capY + 0.36, z + Math.sin(a + Math.PI / 2) * 0.94 * s],
          [0, -a, 0],
        );
      }
      put(marbleParts, new RoundedBoxGeometry(2.34, 0.26, 2.34, 2, 0.06), [x, capY + 0.6, z], [0, -a, 0]);
    }
    for (let i = 0; i < bays; i += 1) {
      const a = ((i + 0.5) / bays) * Math.PI * 2;
      put(
        marbleParts,
        new THREE.TorusGeometry(archRadius, 0.13, 6, 18, Math.PI),
        [Math.cos(a) * R, floorY + 0.74 + shaft + 0.73, Math.sin(a) * R],
        [0, -a - Math.PI / 2, 0],
      );
    }

    // Bookcases fill the bays between the columns - open wood shelving in three
    // heights, packed with gilded, pale and leather spines. They sit almost flush
    // with the colonnade so you look straight into the library from the table.
    const shelfParts = [];
    const goldSpineParts = [];
    const paleSpineParts = [];
    const bookParts = [];
    const emeraldParts = [];
    const indigoParts = [];
    const slateParts = [];
    const spineBuckets = [goldSpineParts, paleSpineParts, bookParts, emeraldParts, indigoParts, slateParts];
    for (let i = 0; i < bays; i += 1) {
      const a = ((i + 0.5) / bays) * Math.PI * 2;
      const dist = R + 1.2;
      const x = Math.cos(a) * dist;
      const z = Math.sin(a) * dist;
      const ry = -a - Math.PI / 2;
      const tx = -Math.sin(a);
      const tz = Math.cos(a);
      const nx = -Math.cos(a);
      const nz = -Math.sin(a);
      // local x runs along the bay, local z points into the hall
      const at = (lx, y, lz) => [x + tx * lx + nx * lz, floorY + y, z + tz * lx + nz * lz];
      const add = (list, geometry, lx, y, lz) => put(list, geometry, at(lx, y, lz), [0, ry, 0]);

      const height = 11.5 + (i % 3) * 1.5;
      const width = 5.7;
      const halfW = width / 2;

      // an open carcass - back panel, two sides, moulded cornice and plinth - so
      // the shelves and the spines are actually visible from the table
      add(shelfParts, new RoundedBoxGeometry(width, height, 0.16, 2, 0.04), 0, height / 2 + 0.3, -0.28);
      for (const s of [-1, 1]) {
        add(shelfParts, new RoundedBoxGeometry(0.18, height, 0.66, 2, 0.04), s * (halfW - 0.09), height / 2 + 0.3, 0.02);
      }
      add(shelfParts, new RoundedBoxGeometry(width + 0.5, 0.4, 1.02, 2, 0.06), 0, height + 0.46, 0.02);
      add(shelfParts, new RoundedBoxGeometry(width + 0.35, 0.34, 0.94, 2, 0.06), 0, 0.22, 0.02);

      const rnd = seeded(1607 + i * 31);
      const levels = Math.max(3, Math.floor((height - 1.6) / 2.2));
      const usable = halfW - 0.34;
      for (let l = 0; l <= levels; l += 1) {
        const y = 0.88 + l * 2.2;
        add(shelfParts, new RoundedBoxGeometry(width - 0.5, 0.13, 0.58, 2, 0.03), 0, y, 0.02);
        if (l === levels) break;
        // Packed shelf by shelf: random thickness, height, tone and the odd gap, so
        // no two bays read the same and the wood stays the dark thing behind them.
        let cursor = -usable;
        while (cursor < usable - 0.1) {
          if (rnd() < 0.1) {
            cursor += 0.16 + rnd() * 0.26;
            continue;
          }
          const thick = 0.09 + rnd() * 0.09;
          if (cursor + thick > usable) break;
          const tall = 1.15 + rnd() * 0.9;
          const bucket = spineBuckets[Math.floor(rnd() * spineBuckets.length)];
          add(
            bucket,
            new THREE.BoxGeometry(thick, tall, 0.28 + rnd() * 0.1),
            cursor + thick / 2,
            y + tall / 2 + 0.07,
            0.02 + rnd() * 0.06,
          );
          cursor += thick + 0.015;
        }
      }

      // a candle on every other case top, so the library glows from inside
      if (i % 2 === 0) {
        add(brassParts, new THREE.CylinderGeometry(0.22, 0.14, 0.16, 10), 0, height + 0.66, 0.02);
        add(waxParts, new THREE.CylinderGeometry(0.1, 0.12, 0.66, 8), 0, height + 1.08, 0.02);
        flames.push(...at(0, height + 1.52, 0.02));
      }
    }

    // The curved wall behind the shelves.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(R + 8, R + 8, 46, 44, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x050d0a,
        roughness: 0.96,
        metalness: 0.04,
        side: THREE.BackSide,
      }),
    );
    wall.position.y = floorY + 18;
    this.scene.add(wall);

    // Two crimson runners lead from the thrones to the table.
    for (const s of [-1, 1]) {
      const rz = s * 13.9;
      put(carpetParts, new RoundedBoxGeometry(5.6, 0.06, 6.6, 2, 0.03), [0, floorY + 0.03, rz]);
      for (const e of [-1, 1]) {
        put(brassParts, new THREE.BoxGeometry(5.7, 0.025, 0.12), [0, floorY + 0.07, rz + e * 3.2]);
        put(brassParts, new THREE.BoxGeometry(0.12, 0.025, 6.6), [e * 2.8, floorY + 0.07, rz]);
      }
    }

    // Sconces on every fifth column: four of them, so the ring mirrors onto
    // itself when the camera flips to the other side.
    for (let i = 0; i < bays; i += 5) {
      const a = (i / bays) * Math.PI * 2;
      const x = Math.cos(a) * (R - 1.35);
      const z = Math.sin(a) * (R - 1.35);
      const y = floorY + 6.1;
      put(brassParts, new THREE.BoxGeometry(0.8, 0.14, 0.14), [x, y, z], [0, -a, 0]);
      put(brassParts, new THREE.CylinderGeometry(0.34, 0.19, 0.2, 10), [x, y + 0.08, z]);
      put(waxParts, new THREE.CylinderGeometry(0.11, 0.13, 0.8, 8), [x, y + 0.58, z]);
      flames.push(x, y + 1.08, z);
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
      const x = Math.cos(a) * 13.6;
      const z = Math.sin(a) * 13.6;
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
    addMerged(marbleParts, marbleCol);
    addMerged(shelfParts, shelfWood);
    addMerged(goldSpineParts, goldSpine);
    addMerged(paleSpineParts, paleSpine);
    addMerged(bookParts, bookLeather);
    addMerged(emeraldParts, emeraldSpine);
    addMerged(indigoParts, indigoSpine);
    addMerged(slateParts, slateSpine);
    addMerged(carpetParts, carpet);
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
    this.peekGroup = new THREE.Group();
    this.scene.add(
      this.selectionGroup,
      this.legalGroup,
      this.lastMoveGroup,
      this.checkGroup,
      this.hintGroup,
      this.peekGroup,
    );

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
      this.#placeCamera(this.#sidePosition(this.viewSide), this.#boardTarget(this.viewSide));
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
      this.#animateCamera(this.#sidePosition(this.viewSide), this.#boardTarget(this.viewSide), 1.4);
    }
  }

  /**
   * What the camera aims at. The old target sat 0.42 above the surface and dead
   * centre, so bringing the camera in cropped the near ranks first while the far
   * end stayed in frame. Aiming lower and slightly towards the player keeps both
   * of your own rows visible at every zoom level.
   */
  #boardTarget(side) {
    const z = side === 'b' ? -0.45 : 0.45;
    return new THREE.Vector3(0, 0.24, z);
  }

  #sidePosition(side) {
    // 52 degrees above the horizon. The old 36 was a "cinematic" angle that
    // stacked the far pieces on top of each other and made every silhouette a
    // smudge; chess is read from above, so the camera has to sit higher.
    const dir = side === 'b' ? new THREE.Vector3(-0.02, 0.92, -0.72) : new THREE.Vector3(0.02, 0.92, 0.72);
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
    this.#mirrorSideLights();
    if (this.mode !== 'game') return;
    this.controls.autoRotate = false;
    if (animate) this.#animateCamera(this.#sidePosition(this.viewSide), this.#boardTarget(this.viewSide), 1.35);
    else this.#placeCamera(this.#sidePosition(this.viewSide), this.#boardTarget(this.viewSide));
  }

  /**
   * The light rig turns with the player: the key and the overhead shaft stay in
   * front of the side that is looking at the board, so playing Black looks like
   * the mirror of playing White instead of lighting the opponent's pieces.
   */
  #mirrorSideLights() {
    const s = this.viewSide === 'b' ? -1 : 1;
    if (this.keyLight) this.keyLight.position.set(-2.2 * s, 11.8, 5.4 * s);
    if (this.shaftLight) this.shaftLight.position.set(0.4 * s, 15.6, 1.2 * s);
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
    const target = toTarget.clone();
    const shift = this.#hudShift(toPos.clone(), target);
    this.cameraTween = {
      t: 0,
      duration,
      fromPos: this.camera.position.clone(),
      toPos: toPos.clone().add(shift),
      fromTarget: this.controls.target.clone(),
      toTarget: target.add(shift),
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
    this.lastFen = fen;
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
      // Knights face the opponent, straight down the board: a yaw offset made
      // the sculpt look like it had been put down in the wrong direction.
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

  /**
   * Rebuild the pieces from the current position. Used when an asset that shapes
   * a piece finishes loading after the board is already on screen.
   */
  refreshPieces() {
    if (!this.lastFen) return;
    this.clearBoard();
    this.setPosition(this.lastFen, { initial: true });
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
    // Enemy markers blend normally: an additive red would wash out on the cream
    // squares exactly where the warning has to read.
    const solid = (color, opacity) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    const glowGeometry = new THREE.PlaneGeometry(0.88, 0.88);
    const borderGeometry = new THREE.RingGeometry(0.4, 0.42, 4, 1);
    this.markers = {
      tile: { geometry: new THREE.PlaneGeometry(0.98, 0.98), material: additive(0xf0cd86, 0.16) },
      ring: { geometry: new THREE.TorusGeometry(0.4, 0.026, 10, 52), material: additive(0xf5d692, 0.95) },
      capture: { geometry: new THREE.TorusGeometry(0.36, 0.026, 8, 40), material: additive(0xe7ad74, 0.72) },
      dot: { geometry: new THREE.CircleGeometry(0.11, 24), material: additive(0xcfe3c2, 0.58) },
      foeTile: { geometry: new THREE.PlaneGeometry(0.98, 0.98), material: solid(0xc44734, 0.13) },
      foeRing: { geometry: new THREE.TorusGeometry(0.4, 0.026, 10, 52), material: solid(0xd4563f, 0.95) },
      foeCapture: { geometry: new THREE.TorusGeometry(0.36, 0.026, 8, 40), material: solid(0xd4563f, 0.9) },
      foeDot: { geometry: new THREE.CircleGeometry(0.11, 24), material: solid(0xd4563f, 0.82) },
      lastGlowW: { geometry: glowGeometry, material: additive(0xd6b371, 0.13) },
      lastGlowB: { geometry: glowGeometry, material: additive(0x72b596, 0.13) },
      lastBorderW: { geometry: borderGeometry, material: border(0xefd196) },
      lastBorderB: { geometry: borderGeometry, material: border(0x8bd0ac) },
      // Shared marker assets. Creating a material inside setCheck/setHint meant
      // a shader release and rebuild on every check and every hint.
      checkRing: { geometry: new THREE.TorusGeometry(0.41, 0.03, 8, 40), material: additive(0xff6b57, 0.9) },
      hintFrom: { geometry: new THREE.TorusGeometry(0.4, 0.022, 8, 36), material: solid(0xc94b39, 0.95) },
      hintTo: { geometry: new THREE.TorusGeometry(0.4, 0.022, 8, 36), material: solid(0xe0775f, 0.92) },
      hintShaft: {
        geometry: new THREE.CylinderGeometry(0.018, 0.018, 1, 8),
        material: solid(0xc94b39, 0.62),
      },
      peek: { geometry: new THREE.TorusGeometry(0.43, 0.026, 8, 40), material: additive(0xe6d2a4, 0.85) },
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

  selectSquare(square, moves = [], { foe = false } = {}) {
    this.#clearSelection();
    const assets = this.#markerAssets();
    const pos = squarePos(square, 0.09);
    const tileAsset = foe ? assets.foeTile : assets.tile;
    const ringAsset = foe ? assets.foeRing : assets.ring;
    const tile = new THREE.Mesh(tileAsset.geometry, tileAsset.material);
    tile.rotation.x = -Math.PI / 2;
    tile.position.copy(pos);
    this.selectionGroup.add(tile);
    const ring = new THREE.Mesh(ringAsset.geometry, ringAsset.material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos);
    this.selectionGroup.add(ring);

    for (const [i, move] of moves.entries()) {
      const target = squarePos(move.to, 0.092);
      const capture = !!move.captured;
      const asset = capture
        ? (foe ? assets.foeCapture : assets.capture)
        : (foe ? assets.foeDot : assets.dot);
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
    // Cached assets: the group is emptied, never disposed.
    this.#clearGroup(this.checkGroup, false);
    if (!this.checkGlow) this.checkGlow = this.#makeGlow();
    if (!square) {
      this.checkGlow.mesh.visible = false;
      return;
    }
    const assets = this.#markerAssets();
    const ring = new THREE.Mesh(assets.checkRing.geometry, assets.checkRing.material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(squarePos(square, 0.094));
    this.checkGroup.add(ring);
    this.checkGlow.mesh.material.color.setHex(0xff5a44);
    this.checkGlow.mesh.material.opacity = 0.3;
    this.checkGlow.mesh.position.copy(squarePos(square, 0.72));
    this.checkGlow.mesh.scale.setScalar(1.9);
    this.checkGlow.mesh.visible = true;
  }

  /**
   * A ring that says "this is the piece you just asked about". Used by the HUD
   * piece badge, so a beginner can connect the name to the piece on the board.
   */
  pulseSquare(square, duration = 1800) {
    this.#clearGroup(this.peekGroup, false);
    if (!square) return;
    const assets = this.#markerAssets();
    const ring = new THREE.Mesh(assets.peek.geometry, assets.peek.material);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(squarePos(square, 0.094));
    ring.userData.bornAt = this.time;
    this.peekGroup.add(ring);
    this.peekUntil = this.time + duration / 1000;
  }

  /** Screen position of the top of a piece, for HUD labels pinned to the board. */
  projectSquare(square, lift = 0.16) {
    const piece = this.pieces.get(square);
    const height = piece?.userData.height || 0.9;
    const point = squarePos(square, PIECE_Y + height + lift).project(this.camera);
    return {
      x: (point.x * 0.5 + 0.5) * window.innerWidth,
      y: (-point.y * 0.5 + 0.5) * window.innerHeight,
      visible: point.z < 1 && Math.abs(point.x) < 1.15 && Math.abs(point.y) < 1.15,
    };
  }

  /**
   * Warm every program in the scene. This must run *after* the pieces exist:
   * the old call sat in #warmEffects, before the board was built, so the six
   * piece programs still compiled on the first real frame.
   */
  precompile() {
    const done = () => {
      this.precompiled = true;
    };
    if (this.renderer.compileAsync) {
      this.renderer
        .compileAsync(this.scene, this.camera)
        .then(done)
        .catch(done);
      return;
    }
    this.renderer.compile(this.scene, this.camera);
    done();
  }

  setHint(move, duration = 4200) {
    clearTimeout(this.hintTimer);
    this.#clearGroup(this.hintGroup, false);
    if (!move?.from || !move?.to) return;
    const assets = this.#markerAssets();
    for (const [square, asset] of [
      [move.from, assets.hintFrom],
      [move.to, assets.hintTo],
    ]) {
      const ring = new THREE.Mesh(asset.geometry, asset.material);
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
    const shaft = new THREE.Mesh(assets.hintShaft.geometry, assets.hintShaft.material);
    shaft.position.copy(mid);
    shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    shaft.scale.set(1, Math.max(len, 0.001), 1);
    shaft.userData.baseOpacity = 0.6;
    this.hintGroup.add(shaft);
    this.hintTimer = setTimeout(() => this.#clearGroup(this.hintGroup, false), duration);
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
      const pooled = this.particleFree.pop();
      const mesh = pooled || new THREE.Mesh(asset.geometry, asset.material);
      if (mesh.material !== asset.material) mesh.material = asset.material;
      if (!mesh.parent) this.scene.add(mesh);
      mesh.visible = true;
      mesh.scale.setScalar(1);
      mesh.position.copy(origin);
      const angle = Math.random() * TAU;
      const speed = 0.4 + Math.random() * 1.2;
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
    if (!this.shardMaterial) {
      this.shardMaterial = new THREE.MeshStandardMaterial({
        color: 0xe9d9b8,
        roughness: 0.32,
        metalness: 0.3,
        transparent: true,
        opacity: 1,
      });
    }
    const mesh = new THREE.Mesh(new THREE.TetrahedronGeometry(0.05), this.shardMaterial);
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
      // Every candle on the table breathes with the flames.
      if (this.candleLights?.length) {
        this.candleLights.forEach((light, i) => {
          light.intensity = 12 + (i % 2 === 0 ? flicker : 1.06 - flicker) * 6;
        });
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
    if (this.peekGroup.children.length) {
      const ring = this.peekGroup.children[0];
      const born = ring.userData.bornAt || 0;
      const grow = clamp((this.time - born) / 0.3, 0, 1);
      const fade = clamp((this.peekUntil - this.time) / 0.45, 0, 1);
      ring.scale.setScalar(0.86 + grow * 0.22 + Math.sin(this.time * 5) * 0.03);
      ring.material.opacity = 0.85 * fade;
      if (this.time > this.peekUntil) this.#clearGroup(this.peekGroup, false);
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
        p.mesh.visible = false;
        this.particleFree.push(p.mesh);
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
