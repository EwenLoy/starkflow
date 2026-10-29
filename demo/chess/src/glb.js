import * as THREE from 'three';

/**
 * A very small GLB reader: one mesh, one material, no skinning, no animation.
 *
 * The demo ships without a bundler and vendors exact versions of its libraries,
 * so pulling in three's GLTFLoader plus a Draco decoder (300 KB of wasm) for a
 * single 400 KB knight is not a trade worth making. This reads the same subset
 * of the format that the sculpt actually uses: contiguous accessors, embedded
 * WebP textures and KHR_texture_transform.
 */

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const ARRAY_TYPES = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};

function parseContainer(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file');
  if (view.getUint32(4, true) !== 2) throw new Error('Unsupported GLB version');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
    } else if (type === CHUNK_BIN) {
      bin = new Uint8Array(buffer, start, length);
    }
    offset = start + length;
  }
  if (!json || !bin) throw new Error('GLB is missing its JSON or binary chunk');
  return { json, bin };
}

/** Copies one accessor out of the binary chunk into a typed array. */
function readAccessor(json, bin, index) {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`Missing accessor ${index}`);
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error('Compressed or sparse accessors are not supported');
  const Ctor = ARRAY_TYPES[accessor.componentType];
  if (!Ctor) throw new Error(`Unsupported component type ${accessor.componentType}`);
  const components = COMPONENTS[accessor.type] || 1;
  const count = accessor.count * components;
  const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const bytes = bin.slice(start, start + count * Ctor.BYTES_PER_ELEMENT);
  return new Ctor(bytes.buffer, 0, count);
}

async function readTexture(json, bin, reference, colorSpace) {
  const textureDef = json.textures?.[reference?.index];
  // Blender writes WebP through EXT_texture_webp, where the image index sits
  // inside the extension instead of the usual `source` field.
  const source = textureDef?.source ?? textureDef?.extensions?.EXT_texture_webp?.source;
  const imageDef = json.images?.[source];
  const view = json.bufferViews?.[imageDef?.bufferView];
  if (!view) return null;
  const bytes = bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  const blob = new Blob([bytes], { type: imageDef.mimeType || 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false; // glTF puts the origin at the top left
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  const transform = reference?.extensions?.KHR_texture_transform;
  if (transform?.scale) texture.repeat.set(transform.scale[0], transform.scale[1]);
  if (transform?.offset) texture.offset.set(transform.offset[0], transform.offset[1]);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Loads the first mesh of a GLB and returns geometry, material and its bounding
 * box. Rejects (rather than half-loading) when the file uses compression.
 */
export async function loadGlb(url, { textures = true } = {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
  const { json, bin } = parseContainer(await response.arrayBuffer());
  const required = json.extensionsRequired || [];
  if (required.includes('KHR_draco_mesh_compression')) {
    throw new Error('This GLB is Draco-compressed: re-export it without compression');
  }
  if (required.includes('KHR_mesh_quantization')) {
    throw new Error('Quantized meshes are not supported by the demo loader');
  }

  const primitive = json.meshes?.[0]?.primitives?.[0];
  if (!primitive) throw new Error('GLB has no mesh');

  const geometry = new THREE.BufferGeometry();
  const position = readAccessor(json, bin, primitive.attributes.POSITION);
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (primitive.attributes.NORMAL != null) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(readAccessor(json, bin, primitive.attributes.NORMAL), 3));
  }
  if (primitive.attributes.TEXCOORD_0 != null) {
    geometry.setAttribute('uv', new THREE.BufferAttribute(readAccessor(json, bin, primitive.attributes.TEXCOORD_0), 2));
  }
  if (primitive.indices != null) {
    geometry.setIndex(new THREE.BufferAttribute(readAccessor(json, bin, primitive.indices), 1));
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox.clone();

  const def = json.materials?.[primitive.material] || {};
  const pbr = def.pbrMetallicRoughness || {};
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    metalness: 1,
    roughness: 1,
    side: def.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    envMapIntensity: 0.9,
  });

  const [map, normalMap, metallicRoughness] = textures
    ? await Promise.all([
        pbr.baseColorTexture ? readTexture(json, bin, pbr.baseColorTexture, THREE.SRGBColorSpace) : null,
        def.normalTexture ? readTexture(json, bin, def.normalTexture, THREE.NoColorSpace) : null,
        pbr.metallicRoughnessTexture ? readTexture(json, bin, pbr.metallicRoughnessTexture, THREE.NoColorSpace) : null,
      ])
    : [null, null, null];
  if (map) material.map = map;
  if (normalMap) material.normalMap = normalMap;
  if (metallicRoughness) {
    material.metalnessMap = metallicRoughness;
    material.roughnessMap = metallicRoughness;
  }

  return { geometry, material, box };
}
