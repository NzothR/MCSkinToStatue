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

/** 使用独立纹理层和整数材质索引批处理，重复 UV 不跨越其他贴图。 */
export async function createStatue(data) {
  const bytes = Uint8Array.from(atob(data.mesh.quads), (character) => character.charCodeAt(0));
  const quads = new Int32Array(bytes.buffer);
  const count = data.mesh.quad_count;
  const layersPerPage = 128;
  const pageCount = Math.ceil(data.atlas.colors.length / layersPerPage);
  const pageQuads = new Uint32Array(pageCount);
  const order = Array.from({ length: count }, (_, index) => index).sort((a, b) => Math.floor(quads[a * 7 + 6] / layersPerPage) - Math.floor(quads[b * 7 + 6] / layersPerPage));
  const position = new Float32Array(count * 12);
  const normal = new Float32Array(count * 12);
  const uv = new Float32Array(count * 8);
  const tile = new Float32Array(count * 4);
  const colors = new Float32Array(count * 12);
  const indices = new Uint32Array(count * 6);
  const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const tileColors = data.atlas.colors.map((rgb) => new THREE.Color().setRGB(...rgb.map((v) => v / 255), THREE.SRGBColorSpace));
  for (let q = 0; q < count; q++) {
    const source = order[q];
    const [x, y, z, face, w, h, texture] = quads.subarray(source * 7, source * 7 + 7);
    pageQuads[Math.floor(texture / layersPerPage)]++;
    const corners = rectangle(x, y, z, face, w, h);
    for (let v = 0; v < 4; v++) {
      position.set(corners[v], q * 12 + v * 3);
      normal.set(normals[face], q * 12 + v * 3);
      tile[q * 4 + v] = texture;
      tileColors[texture].toArray(colors, q * 12 + v * 3);
    }
    // Minecraft 方块底面的 PNG 顶行对应 -Z，与几何顶点的排列相反。
    uv.set(face === 3 ? [0, 0, w, 0, 0, h, w, h] : [0, h, w, h, 0, 0, w, 0], q * 8);
    indices.set([0, 2, 1, 2, 3, 1].map((v) => q * 4 + v), q * 6);
  }
  const source = await new THREE.ImageLoader().loadAsync(data.atlas.image);
  const canvas = document.createElement("canvas");
  canvas.width = data.atlas.width; canvas.height = data.atlas.height;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const maps = [];
  const size = data.atlas.tile_size;
  for (let page = 0; page < pageCount; page++) {
    const depth = Math.min(layersPerPage, data.atlas.colors.length - page * layersPerPage);
    const bytes = new Uint8Array(size * size * depth * 4);
    for (let layer = 0; layer < depth; layer++) {
      const index = page * layersPerPage + layer;
      const x = (index % data.atlas.columns) * (size + 2) + 1;
      const y = Math.floor(index / data.atlas.columns) * (size + 2) + 1;
      for (let row = 0; row < size; row++) {
        const from = ((y + row) * canvas.width + x) * 4;
        // DataArrayTexture 不使用 DOM flipY；显式转换到 OpenGL 的底部行原点。
        bytes.set(pixels.subarray(from, from + size * 4), (layer * size * size + (size - 1 - row) * size) * 4);
      }
    }
    const map = new THREE.DataArrayTexture(bytes, size, size, depth);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.wrapS = THREE.RepeatWrapping; map.wrapT = THREE.RepeatWrapping;
    map.generateMipmaps = false;
    map.needsUpdate = true;
    maps.push(map);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute("tile", new THREE.BufferAttribute(tile, 1));
  geometry.setAttribute("blockColor", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  let groupStart = 0;
  pageQuads.forEach((quads, page) => {
    if (quads) geometry.addGroup(groupStart, quads * 6, page);
    groupStart += quads * 6;
  });
  const materials = maps.map((map, page) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      tileMap: { value: map }, layerBase: { value: page * layersPerPage },
      rawColor: { value: false }, plainColor: { value: false },
    },
    vertexShader: `attribute float tile;
      uniform int layerBase;
      attribute vec3 blockColor;
      varying vec2 blockUV;
      flat out int blockTile;
      varying vec3 faceNormal;
      varying vec3 averageColor;
      void main() {
        blockUV = uv; blockTile = int(tile + 0.5) - layerBase; faceNormal = normal; averageColor = blockColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `precision highp sampler2DArray;
      uniform sampler2DArray tileMap;
      uniform bool rawColor;
      uniform bool plainColor;
      varying vec2 blockUV;
      flat in int blockTile;
      varying vec3 faceNormal;
      varying vec3 averageColor;
      out vec4 outputColor;
      #define gl_FragColor outputColor
      void main() {
        vec3 color = plainColor ? averageColor : texture(tileMap, vec3(blockUV, float(blockTile))).rgb;
        float light = rawColor ? 1.0 : 0.68 + 0.32 * max(dot(normalize(faceNormal), normalize(vec3(-0.4, 0.8, 0.6))), 0.0);
        gl_FragColor = vec4(color * light, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }));
  const mesh = new THREE.Mesh(geometry, materials);
  // 让不同尺寸以相同玩家比例显示，真实格数保留在体素及统计中。
  mesh.scale.setScalar(1 / data.scale);
  mesh.userData.texturePages = maps;
  return mesh;
}

/** 释放雕像预览占用的纹理、材质和几何资源。 */
export function disposeStatue(mesh) {
  mesh.geometry.dispose();
  mesh.material.forEach((material) => material.dispose());
  mesh.userData.texturePages.forEach((map) => map.dispose());
}

/** 用当前包围盒和同一导出原点标出 I；辅助线不写入体素。 */
export function createPlacementGuide(data) {
  const group = new THREE.Group();
  const min = new THREE.Vector3(...data.bounds[0]).multiplyScalar(1 / data.scale);
  const max = new THREE.Vector3(...data.bounds[1]).multiplyScalar(1 / data.scale);
  const box = new THREE.Box3Helper(new THREE.Box3(min, max), 0x8ae7bb);
  box.material.transparent = true;
  box.material.opacity = 0.45;
  group.add(box);
  const local = data.placement.anchor_local;
  const anchor = new THREE.Vector3(...local.map((value, axis) => (value + data.bounds[0][axis]) / data.scale));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.34, 24), new THREE.MeshBasicMaterial({ color: 0x8ae7bb, side: THREE.DoubleSide, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(anchor).add(new THREE.Vector3(0, 0.02, 0));
  group.add(ring);
  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 64;
  const context = canvas.getContext("2d");
  context.fillStyle = "#163c30"; context.fillRect(0, 0, 128, 64);
  context.font = "bold 38px Segoe UI"; context.textAlign = "center";
  context.fillStyle = "#8ae7bb"; context.fillText("I", 64, 46);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false }));
  label.scale.set(1.8, 0.9, 1);
  label.position.copy(anchor).add(new THREE.Vector3(0.6, 0.8, 0.3));
  group.add(label);
  return group;
}

/** 释放当前生成结果的辅助线与 I 点标签。 */
export function disposePlacementGuide(group) {
  group.traverse((object) => {
    if (!object.isSprite) object.geometry?.dispose();
    if (object.material) {
      object.material.map?.dispose();
      object.material.dispose();
    }
  });
}
