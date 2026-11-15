import * as THREE from "three";

/** 展开服务返回的贪心矩形；四个顶点依次为左上、右上、左下、右下。 */
function rectangle(x, y, z, face, w, h) {
  switch (face) {
    case 0: return [[x + 1, y + h, z + w], [x + 1, y + h, z], [x + 1, y, z + w], [x + 1, y, z]];
    case 1: return [[x, y + h, z], [x, y + h, z + w], [x, y, z], [x, y, z + w]];
    case 2: return [[x, y + 1, z], [x + w, y + 1, z], [x, y + 1, z + h], [x + w, y + 1, z + h]];
    case 3: return [[x, y, z + h], [x + w, y, z + h], [x, y, z], [x + w, y, z]];
    case 4: return [[x, y + h, z + 1], [x + w, y + h, z + 1], [x, y, z + 1], [x + w, y, z + 1]];
    case 5: return [[x + w, y + h, z], [x, y + h, z], [x + w, y, z], [x, y, z]];
  }
}

/** 将实际体素的可见面组合为单次材质批处理，合并后仍按每格重复方块贴图。 */
export async function createStatue(data) {
  const bytes = Uint8Array.from(atob(data.mesh.quads), (character) => character.charCodeAt(0));
  const quads = new Int32Array(bytes.buffer);
  const count = data.mesh.quad_count;
  const position = new Float32Array(count * 12);
  const normal = new Float32Array(count * 12);
  const uv = new Float32Array(count * 8);
  const tile = new Float32Array(count * 4);
  const colors = new Float32Array(count * 12);
  const indices = new Uint32Array(count * 6);
  const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const tileColors = data.atlas.colors.map((rgb) => new THREE.Color().setRGB(...rgb.map((v) => v / 255), THREE.SRGBColorSpace));
  for (let q = 0; q < count; q++) {
    const [x, y, z, face, w, h, texture] = quads.subarray(q * 7, q * 7 + 7);
    const corners = rectangle(x, y, z, face, w, h);
    for (let v = 0; v < 4; v++) {
      position.set(corners[v], q * 12 + v * 3);
      normal.set(normals[face], q * 12 + v * 3);
      tile[q * 4 + v] = texture;
      tileColors[texture].toArray(colors, q * 12 + v * 3);
    }
    uv.set([0, h, w, h, 0, 0, w, 0], q * 8);
    indices.set([0, 2, 1, 2, 3, 1].map((v) => q * 4 + v), q * 6);
  }
  const map = await new THREE.TextureLoader().loadAsync(data.atlas.image);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute("tile", new THREE.BufferAttribute(tile, 1));
  geometry.setAttribute("blockColor", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      atlas: { value: map }, atlasSize: { value: new THREE.Vector2(data.atlas.width, data.atlas.height) },
      columns: { value: data.atlas.columns }, tileSize: { value: data.atlas.tile_size },
      rawColor: { value: false }, plainColor: { value: false },
    },
    vertexShader: `attribute float tile;
      attribute vec3 blockColor;
      varying vec2 blockUV;
      varying float blockTile;
      varying vec3 faceNormal;
      varying vec3 averageColor;
      void main() {
        blockUV = uv; blockTile = tile; faceNormal = normal; averageColor = blockColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform sampler2D atlas;
      uniform vec2 atlasSize;
      uniform float columns;
      uniform float tileSize;
      uniform bool rawColor;
      uniform bool plainColor;
      varying vec2 blockUV;
      varying float blockTile;
      varying vec3 faceNormal;
      varying vec3 averageColor;
      void main() {
        float tileId = floor(blockTile + 0.5);
        vec2 origin = vec2(mod(tileId, columns), floor(tileId / columns)) * (tileSize + 2.0) + 1.0;
        vec2 pixel = origin + vec2(fract(blockUV.x), 1.0 - fract(blockUV.y)) * tileSize;
        vec2 atlasUV = vec2(pixel.x / atlasSize.x, 1.0 - pixel.y / atlasSize.y);
        vec3 color = plainColor ? averageColor : texture2D(atlas, atlasUV).rgb;
        float light = rawColor ? 1.0 : 0.68 + 0.32 * max(dot(normalize(faceNormal), normalize(vec3(-0.4, 0.8, 0.6))), 0.0);
        gl_FragColor = vec4(color * light, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // 让不同尺寸以相同玩家比例显示，真实格数保留在体素及统计中。
  mesh.scale.setScalar(1 / data.scale);
  mesh.userData.atlas = map;
  return mesh;
}

/** 释放雕像预览占用的纹理、材质和几何资源。 */
export function disposeStatue(mesh) {
  mesh.geometry.dispose();
  mesh.material.dispose();
  mesh.userData.atlas.dispose();
}
