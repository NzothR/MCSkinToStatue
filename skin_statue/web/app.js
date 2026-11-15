import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { initResourcePanel } from "/static/resources.js";

const $ = (selector) => document.querySelector(selector);
const viewport = $("#viewport");
const status = $("#status");
const fileInput = $("#skin-file");
const modelInputs = [...document.querySelectorAll('[name="model"]')];
let renderer;
let controls;
let scene;
let camera;
let grid;
let player = null;
let skin = null;
let currentFile = null;
let texture = null;
let materials = [];
let requestId = 0;
let loading = false;
const visibility = new Map();

/** 显示解析说明或可以直接处理的错误信息。 */
function showNotice(message, error = false) {
  const notice = $("#notice");
  notice.textContent = message;
  notice.classList.toggle("error", error);
  notice.hidden = !message;
}

/** 创建透明背景的 Three.js 场景，供本地预览及无损截图共同使用。 */
function createViewer() {
  renderer = new THREE.WebGLRenderer({ canvas: $("#viewer"), antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 20;
  controls.maxDistance = 160;
  controls.autoRotateSpeed = 1.4;
  controls.target.set(0, 16, 0);
  setView("reset");
  scene.add(new THREE.HemisphereLight(0xffffff, 0x899aab, 2.2));
  const sunlight = new THREE.DirectionalLight(0xffffff, 2.4);
  sunlight.position.set(-25, 50, 40);
  scene.add(sunlight);
  grid = new THREE.GridHelper(80, 40, 0x65817b, 0x385257);
  grid.position.y = -0.3;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  scene.add(grid);
  new ResizeObserver(() => {
    const { width, height } = viewport.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }).observe(viewport);
  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    showNotice("3D 图形上下文已丢失，请刷新页面重新加载皮肤。", true);
  });
}

/** 按角色自身左右设置视角；正面为 +Z，角色左侧为 +X。 */
function setView(view) {
  const offsets = {
    front: [0, 0, 65], back: [0, 0, -65],
    left: [65, 0, 0], right: [-65, 0, 0],
    top: [0, 65, 0.01], reset: [39, 15, 65],
  };
  controls.target.set(0, 16, 0);
  camera.position.copy(controls.target).add(new THREE.Vector3(...offsets[view]));
  // 清除阻尼中残留的旋转，确保固定视角可以精确到位。
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.position.copy(controls.target).add(new THREE.Vector3(...offsets[view]));
  controls.update();
  controls.enableDamping = damping;
}

/** 将后端的六面矩形映射到 BoxGeometry 顶点；底面的 V 方向独立翻转。 */
function applyUV(geometry, faces) {
  const uv = [];
  for (const [face, [x1, y1, x2, y2]] of Object.entries(faces)) {
    const top = face === "down" ? y2 : y1;
    const bottom = face === "down" ? y1 : y2;
    uv.push(x1 / 64, 1 - top / 64, x2 / 64, 1 - top / 64,
      x1 / 64, 1 - bottom / 64, x2 / 64, 1 - bottom / 64);
  }
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
}

/** 只使用后端解析的尺寸、UV、位置和外凸量创建双层站姿模型。 */
function buildPlayer(parsed, map) {
  const group = new THREE.Group();
  const standard = [false, true].map((outer) => new THREE.MeshStandardMaterial({
    map, roughness: 1, metalness: 0,
    transparent: outer, alphaTest: outer ? 0.001 : 0,
    side: outer ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: !outer,
  }));
  const flat = [false, true].map((outer) => new THREE.MeshBasicMaterial({
    map, transparent: outer, alphaTest: outer ? 0.001 : 0,
    side: outer ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: !outer,
  }));
  for (const part of parsed.parts) {
    for (const [layer, data] of Object.entries(part.layers)) {
      const size = part.size.map((value) => value + 2 * data.inflate);
      const geometry = new THREE.BoxGeometry(...size);
      applyUV(geometry, data.faces);
      const index = layer === "overlay" ? 1 : 0;
      const mesh = new THREE.Mesh(geometry, standard[index]);
      mesh.position.set(...part.position);
      mesh.userData = { key: `${part.id}:${layer}`, pixels: data.pixels, standard: standard[index], flat: flat[index] };
      // 外层最后渲染，完全透明像素不会写入深度缓冲。
      mesh.renderOrder = index;
      group.add(mesh);
    }
  }
  return { group, materials: [...standard, ...flat] };
}

/** 释放旧模型的 GPU 资源，连续导入不会积累纹理和几何体。 */
function disposePlayer() {
  if (player) {
    scene.remove(player);
    player.children.forEach((mesh) => mesh.geometry.dispose());
    materials.forEach((material) => material.dispose());
    texture.dispose();
  }
}

/** 导入成功后原子替换模型；保留最近一次请求，避免快速切换时显示旧结果。 */
async function importSkin(file, preserveLayers = false) {
  const id = ++requestId;
  loading = true;
  $("#loading").hidden = false;
  $("#export").disabled = true;
  showNotice("");
  try {
    const form = new FormData();
    form.append("file", file);
    form.append("model", $('input[name="model"]:checked').value);
    const response = await fetch("/api/skin", { method: "POST", body: form });
    const parsed = await response.json();
    if (!response.ok) throw new Error(typeof parsed.detail === "string" ? parsed.detail : "皮肤参数无效，请重新选择文件。");
    const map = await new THREE.TextureLoader().loadAsync(parsed.images.normalized);
    if (id !== requestId) { map.dispose(); return; }
    map.magFilter = THREE.NearestFilter;
    map.minFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    map.colorSpace = THREE.SRGBColorSpace;
    const result = buildPlayer(parsed, map);
    disposePlayer();
    texture = map;
    player = result.group;
    materials = result.materials;
    skin = parsed;
    currentFile = file;
    scene.add(player);
    if (!preserveLayers) visibility.clear();
    for (const part of parsed.parts) {
      for (const layer of ["base", "overlay"]) {
        const key = `${part.id}:${layer}`;
        if (!visibility.has(key)) visibility.set(key, true);
      }
    }
    modelInputs.forEach((input) => {
      input.checked = input.value === parsed.model;
      input.disabled = parsed.legacy && input.value === "alex";
    });
    $("#model-hint").textContent = parsed.legacy ? "64×32 旧皮肤使用 Steve，左右肢体已镜像补全。" : "请选择与皮肤匹配的手臂模型。";
    $("#file-info").textContent = `${file.name} · ${parsed.source_size.join(" × ")}`;
    $("#format-badge").textContent = `${parsed.legacy ? "LEGACY → 64×64" : "64×64 RGBA"} / ${parsed.model === "steve" ? "STEVE" : "ALEX"}`;
    buildLayerControls();
    updateVisibility();
    updateAtlas();
    showNotice(parsed.notes.join(" "));
    if (!preserveLayers) {
      $("#auto-rotate").checked = false;
      controls.autoRotate = false;
      setView("reset");
    }
  } catch (error) {
    if (id !== requestId) return;
    modelInputs.forEach((input) => { input.checked = input.value === (skin?.model ?? "steve"); });
    showNotice(error.message, true);
    status.textContent = skin ? "导入失败，当前皮肤已保留。" : "导入失败，请选择有效的皮肤 PNG。";
  } finally {
    if (id === requestId) {
      loading = false;
      $("#loading").hidden = true;
      $("#export").disabled = !skin;
    }
  }
}

/** 为每个部位生成基础层、第二层开关，并用实际像素数量标记空外层。 */
function buildLayerControls() {
  const container = $("#part-controls");
  container.replaceChildren();
  skin.parts.forEach((part, index) => {
    const row = document.createElement("div");
    row.className = "part-row";
    const name = document.createElement("div");
    name.className = "part-name";
    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");
    name.append(number, part.label);
    row.append(name);
    for (const [layer, data] of Object.entries(part.layers)) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.key = `${part.id}:${layer}`;
      input.dataset.layer = layer;
      input.checked = visibility.get(input.dataset.key) && data.pixels > 0;
      input.disabled = data.pixels === 0;
      input.setAttribute("aria-label", `${part.label}${layer === "base" ? "基础层" : "第二层"}`);
      label.title = data.pixels ? `${data.pixels} 个有效像素，其中 ${data.translucent_pixels} 个半透明像素` : "此部位没有第二层像素";
      input.addEventListener("change", () => {
        visibility.set(input.dataset.key, input.checked);
        updateVisibility();
      });
      label.append(input);
      row.append(label);
    }
    container.append(row);
  });
}

/** 更新显示、主开关的半选状态及像素统计；不修改底层皮肤数据。 */
function updateVisibility() {
  if (!player) return;
  for (const mesh of player.children) {
    mesh.visible = visibility.get(mesh.userData.key) && mesh.userData.pixels > 0;
    mesh.material = $("#flat-color").checked ? mesh.userData.flat : mesh.userData.standard;
  }
  for (const layer of ["base", "overlay"]) {
    const inputs = [...document.querySelectorAll(`[data-layer="${layer}"]:not(:disabled)`)];
    const checked = inputs.filter((input) => input.checked).length;
    const master = $(`#${layer}-visible`);
    master.checked = inputs.length > 0 && checked === inputs.length;
    master.indeterminate = checked > 0 && checked < inputs.length;
    master.disabled = inputs.length === 0;
  }
  const outer = skin.parts.reduce((total, part) => total + part.layers.overlay.pixels, 0);
  const shown = player.children.filter((mesh) => mesh.visible).length;
  status.textContent = `已解析 6 个部位 · 第二层 ${outer} 像素 · 当前显示 ${shown} 个图层`;
}

/** 查看与下载完全同源的纹理图集。 */
function updateAtlas() {
  if (!skin) return;
  $("#atlas").src = skin.images[$("#atlas-kind").value];
  $("#atlas").hidden = false;
}

/** 使用临时下载链接保存 PNG；及时释放文件对象的临时地址。 */
function download(url, name, revoke = false) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出当前数据或当前视角，截图保留透明背景及所显示的地面网格。 */
function exportPNG() {
  if (!skin || loading) return;
  const kind = $("#export-kind").value;
  const stem = currentFile.name.replace(/\.png$/i, "");
  if (kind === "original") {
    download(URL.createObjectURL(currentFile), currentFile.name, true);
  } else if (kind === "screenshot") {
    // 与读取像素处于同一帧，无需长期保留 WebGL 绘图缓冲区。
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
      if (blob) download(URL.createObjectURL(blob), `${stem}-preview.png`, true);
      else showNotice("浏览器未能生成截图，请重试。", true);
    }, "image/png");
  } else {
    download(skin.images[kind], `${stem}-${skin.model}-${kind}.png`);
  }
}

/** 加载项目自带的原创双层示例皮肤，让界面打开即可查看模型。 */
async function loadDemo() {
  const before = requestId;
  try {
    const response = await fetch("/static/demo.png");
    if (!response.ok) throw new Error("内置示例加载失败。");
    const blob = await response.blob();
    if (requestId !== before) return;
    modelInputs[0].checked = true;
    await importSkin(new File([blob], "studio-demo.png", { type: "image/png" }));
  } catch (error) {
    if (requestId === before) showNotice(error.message, true);
  }
}

/** 绑定文件导入、视角、图层和导出等界面交互。 */
function bindUI() {
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) void importSkin(file);
    fileInput.value = "";
  });
  const dropzone = $("#dropzone");
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); }
  });
  for (const name of ["dragenter", "dragover"]) {
    dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
  }
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
    const file = event.dataTransfer.files[0];
    if (file) void importSkin(file);
  });
  // 阻止皮肤被拖到面板之外时触发浏览器跳转。
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
  modelInputs.forEach((input) => input.addEventListener("change", () => {
    if (currentFile) void importSkin(currentFile, true);
  }));
  for (const layer of ["base", "overlay"]) {
    $(`#${layer}-visible`).addEventListener("change", (event) => {
      document.querySelectorAll(`[data-layer="${layer}"]:not(:disabled)`).forEach((input) => {
        input.checked = event.target.checked;
        visibility.set(input.dataset.key, input.checked);
      });
      updateVisibility();
    });
  }
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    $("#auto-rotate").checked = false;
    controls.autoRotate = false;
    setView(button.dataset.view);
  }));
  $("#grid-visible").addEventListener("change", (event) => { grid.visible = event.target.checked; });
  $("#auto-rotate").addEventListener("change", (event) => { controls.autoRotate = event.target.checked; });
  $("#flat-color").addEventListener("change", updateVisibility);
  $("#atlas-kind").addEventListener("change", updateAtlas);
  $("#export").addEventListener("click", exportPNG);
  $("#demo").addEventListener("click", () => void loadDemo());
  document.querySelectorAll("[data-bg]").forEach((button) => button.addEventListener("click", () => {
    viewport.dataset.background = button.dataset.bg;
    document.querySelectorAll("[data-bg]").forEach((item) => item.classList.toggle("active", item === button));
  }));
}

try {
  createViewer();
  bindUI();
  void loadDemo();
} catch (error) {
  status.textContent = "无法创建 3D 预览。";
  showNotice(`请使用启用硬件加速、支持 WebGL 2 的浏览器。${error.message}`, true);
}

initResourcePanel();
