import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { initResourcePanel, showPalette } from "/static/resources.js";
import { createStatue, disposeStatue, createPlacementGuide, disposePlacementGuide } from "/static/statue.js";

import { initEditor } from "/static/editor.js";
import { initPoseControls } from "/static/poses.js";
import { initHeldEditor } from "/static/held-editor.js";

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
let statueMesh = null;
let statueData = null;
let palette = null;
let excludedBlocks = [];
let previewMode = "skin";
let generating = false;
let revision = 0;
let placementGuide = null;
let exporting = false;
let editor = null;
let poseControls = null;
let heldGroup = null;
let renderRequest = 0;
let serviceStopping = false;
let heldEditor = null;

/** 导出按钮始终指向当前已显示的生成快照，参数变化不会暗中重新匹配。 */
function updateExportButtons() {
  $("#export-statue").disabled = !statueData || exporting;
  $("#export-statue-bundle").disabled = !statueData || exporting;
}

/** 下载同源结构，或附带材质、ID、生成参数和规范化皮肤的对照包。 */
async function exportStatue(bundle) {
  if (!statueData || exporting) return;
  const snapshot = statueData;
  const profile = $("#statue-export-profile").value;
  const filename = `statue-${snapshot.statue_id.slice(0, 8)}-${profile}.${bundle ? "zip" : "schematic"}`;
  exporting = true;
  updateExportButtons();
  $("#statue-export-hint").textContent = "正在编码结构并读回校验 ID、Metadata 和 I 点原点…";
  try {
    const response = await fetch(`/api/statue/${snapshot.statue_id}/export?profile=${profile}&bundle=${bundle}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail);
    }
    download(URL.createObjectURL(await response.blob()), filename, true);
    $("#statue-export-hint").textContent = profile === "schematica_gtnh" ? `已导出 ${filename}。在 Schematica 中启用 SchematicPlus，并用其 GUI 定位。` : `已导出 ${filename}。站在 I 点：//schem load mcedit statue-${snapshot.statue_id.slice(0, 8)}-${profile}，然后 //paste -a。正面朝南。`;
  } catch (error) {
    $("#statue-export-hint").textContent = error.message;
    showNotice(error.message, true);
  } finally {
    exporting = false;
    updateExportButtons();
  }
}

/** 生成按钮依赖有效皮肤和可用调色板。 */
function updateGenerateButton() {
  const count = (palette?.eligible ?? 0) + ($("#statue-connected").checked ? (palette?.connected_eligible ?? 0) : 0);
  $("#generate-statue").disabled = !skin || !count || loading || generating || editor?.busy || poseControls?.busy;
}

/** 参数改变后保留上次可看的结果，并明确提示需要重新生成。 */
function markStatueChanged() {
  revision++;
  if (statueData || generating) $("#statue-state").textContent = "参数已改，请重新生成";
}

/** 用相同的玩家比例切换皮肤和实际方块网格。 */
function showMode(mode) {
  if (mode === "statue" && !statueMesh) return;
  previewMode = mode;
  if (player) player.visible = mode === "skin";
  if (heldGroup) heldGroup.visible = mode === "skin";
  if (statueMesh) statueMesh.visible = mode === "statue";
  if (placementGuide) placementGuide.visible = mode === "statue" && $("#show-anchor").checked;
  editor?.setVisible(mode === "statue");
  heldEditor?.setVisible();
  $("#show-skin").classList.toggle("active", mode === "skin");
  $("#show-statue").classList.toggle("active", mode === "statue");
  if (mode === "statue") {
    $("#format-badge").textContent = `${statueData.dimensions.join(" × ")} 格`;
    status.textContent = `${statueData.block_count.toLocaleString()} 个方块 · ${statueData.materials.length} 种材料 · ${statueData.mesh.quad_count.toLocaleString()} 个合并面`;
  } else if (skin) {
    $("#format-badge").textContent = `${skin.legacy ? "LEGACY → 64×64" : "64×64 RGBA"} / ${skin.model.toUpperCase()}`;
    updateVisibility();
  }
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
    const scale = mode === "statue" ? statueData.scale : 1;
    grid = new THREE.GridHelper(80, mode === "statue" ? 80 * scale : 40, 0x65817b, 0x385257);
    grid.position.y = mode === "statue" ? statueData.bounds[0][1] / scale - 0.3 : -0.3;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.visible = $("#grid-visible").checked;
    scene.add(grid);
  }
}

/** 发送当前皮肤和参数，在后台生成后一次性替换雕像预览。 */
async function generateStatue() {
  if (!skin || !palette || generating || editor?.busy || poseControls?.busy) return;
  generating = true;
  updateGenerateButton();
  $("#generate-statue").textContent = "正在生成…";
  $("#statue-state").textContent = "正在计算体素、匹配颜色与合并网格…";
  const startRevision = revision;
  const layers = [...visibility].filter(([, enabled]) => enabled).map(([key]) => key);
  const options = {
    ...poseControls.settings,
    palette_id: palette.id, scale: Number($("#statue-scale").value), detail: Number($("#statue-detail").value),
    hollow: $("#statue-hollow").value === "hollow", shell_thickness: Number($("#statue-thickness").value),
    overlay_offset: Number($("#statue-offset").value), alpha_threshold: Number($("#statue-alpha").value),
    smoothness: Number($("#statue-smoothness").value), excluded: excludedBlocks, layers,
    prefer_connected: $("#statue-connected").checked,
  };
  try {
    const form = new FormData();
    form.append("file", currentFile);
    form.append("model", skin.model);
    form.append("options", JSON.stringify(options));
    const response = await fetch("/api/statue/generate", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "生成参数无效。");
    await displayStatue(result);
    editor.reset(result);
    if (revision !== startRevision) $("#statue-state").textContent = "已显示本次结果；参数已改，请重新生成";
  } catch (error) {
    $("#statue-state").textContent = "生成失败，保留上次结果";
    showNotice(error.message, true);
  } finally {
    generating = false;
    $("#generate-statue").textContent = "重新生成雕像预览";
    updateGenerateButton();
  }
}

/** 原子更新实际雕像网格、材料与导出快照；编辑与工程恢复复用此入口。 */
async function displayStatue(result) {
  if (result.ctm?.enabled !== $("#preview-connected").checked) {
    const response = await fetch(`/api/statue/${result.statue_id}/render?connected=${$("#preview-connected").checked}`);
    const rendering = await response.json();
    if (!response.ok) throw new Error(rendering.detail);
    result = { ...result, ...rendering };
  }
  const mesh = await createStatue(result);
  if (statueMesh) { scene.remove(statueMesh); disposeStatue(statueMesh); }
  statueMesh = mesh;
  statueData = result;
  scene.add(mesh);
  if (placementGuide) { scene.remove(placementGuide); disposePlacementGuide(placementGuide); }
  placementGuide = createPlacementGuide(result);
  scene.add(placementGuide);
  updateExportButtons();
  $("#statue-export-hint").textContent = `I 点：局部坐标 ${result.placement.anchor_local.join(", ")}。正面朝南（+Z），I 在东南角。`;
  updateVisibility();
  $("#show-statue").disabled = false;
  $("#statue-state").textContent = result.edits?.length ? `已编辑 ${result.edits.length} 次` : "生成完成";
  $("#statue-report").hidden = false;
  $("#statue-statistics").textContent = `站立高度基准 ${result.base_height} 格；实际包围尺寸 ${result.dimensions.join(" × ")} 格\n${result.options.hollow ? "空心" : "实心"} · 方块 ${result.block_count.toLocaleString()} · 第二层 ${result.overlay_blocks.toLocaleString()}\n可见单格面 ${result.mesh.exposed_faces.toLocaleString()} → 合并矩形 ${result.mesh.quad_count.toLocaleString()}\n初次生成平均 / 最大 Lab 色差 ${result.matching.mean_color_error} / ${result.matching.max_color_error}；内部填充 ${result.matching.interior_block}`;
  $("#statue-materials").replaceChildren(...result.materials.map((material) => {
    const row = document.createElement("div");
    row.textContent = `${material.display_name ? material.display_name + " · " : ""}${material.key} · ID ${material.numeric_id} · ${material.count.toLocaleString()} 块`;
    return row;
  }));
  showMode("statue");
  $("#ctm-preview-status").textContent = !result.ctm?.enabled ? "连接纹理预览已关闭。" : `连接纹理：${result.ctm.connected_faces.toLocaleString()} 个暴露面。${result.ctm.unsupported_materials.length ? `${result.ctm.unsupported_materials.length} 种材料缺少支持的连接图，显示基础纹理；可从实例载入 CTM 资源。` : ""}`;
  showNotice("");
}

/** 切换仅影响当前网格的纹理，不重新匹配材料或修改体素快照。 */
async function refreshConnectedPreview() {
  if (!statueData || generating || editor?.busy) return;
  const token = ++renderRequest;
  const snapshot = statueData;
  try {
    const response = await fetch(`/api/statue/${snapshot.statue_id}/render?connected=${$("#preview-connected").checked}`);
    const rendering = await response.json();
    if (!response.ok) throw new Error(rendering.detail);
    if (token !== renderRequest || snapshot.statue_id !== statueData?.statue_id) return;
    await displayStatue({ ...snapshot, ...rendering });
  } catch (error) { if (token === renderRequest) showNotice(error.message, true); }
}

/** 使用同源关节矩阵更新双层部件，手持像素用实例网格显示厚度及握持位置。 */
function displayPose(data) {
  const objects = new Map(data.objects.map((o) => [o.id, o]));
  for (const mesh of player.children) {
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(objects.get(mesh.userData.key.split(":")[0]).matrix);
    mesh.userData.restMatrix = mesh.matrix.clone();
    mesh.matrixWorldNeedsUpdate = true;
  }
  if (heldGroup) {
    scene.remove(heldGroup);
    heldGroup.traverse((mesh) => { if (mesh.isMesh) {
      mesh.geometry.dispose();
      const materials = new Set([...([mesh.userData.standard].flat()), ...([mesh.userData.flat].flat())]);
      const maps = new Set();
      for (const material of materials) { if (material.map) maps.add(material.map); material.dispose(); }
      for (const map of maps) map.dispose();
      if (mesh.isInstancedMesh) mesh.dispose();
    } });
  }
  heldGroup = new THREE.Group();
  for (const obj of data.objects.filter((o) => o.pixels || o.cube)) {
    if (obj.cube) {
      const maps = ["east", "west", "up", "down", "south", "north"].map((face) => {
        const source=obj.cube[face];
        const pixels=new Uint8Array(source.pixels.length), stride=source.width*4;
        for(let y=0;y<source.height;y++)pixels.set(source.pixels.slice(y*stride,(y+1)*stride),(source.height-1-y)*stride);
        const map=new THREE.DataTexture(pixels,source.width,source.height);
        map.colorSpace=THREE.SRGBColorSpace;map.magFilter=THREE.NearestFilter;map.minFilter=THREE.NearestFilter;map.needsUpdate=true;return map;
      });
      const standard=maps.map((map)=>new THREE.MeshStandardMaterial({map,roughness:1,side:THREE.DoubleSide}));
      const flat=maps.map((map)=>new THREE.MeshBasicMaterial({map,side:THREE.DoubleSide}));
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(16,16,16),standard);
      mesh.matrixAutoUpdate=false;mesh.matrix.fromArray(obj.matrix);mesh.userData={standard,flat,hand:obj.id.split("_")[0],restMatrix:mesh.matrix.clone()};heldGroup.add(mesh);
      continue;
    }
    const geometry = obj.thickness > 0 ? new THREE.BoxGeometry(16 / obj.width, 16 / obj.height, obj.thickness) : new THREE.PlaneGeometry(16 / obj.width, 16 / obj.height);
    const standard = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide });
    const flat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.InstancedMesh(geometry, standard, obj.pixels.length);
    const world = new THREE.Matrix4().fromArray(obj.matrix);
    const translation = new THREE.Matrix4();
    obj.pixels.forEach(([x, y, r, g, b], i) => {
      translation.makeTranslation(16 * (1 - (x + .5) / obj.width), 16 * (1 - (y + .5) / obj.height), -obj.thickness/2);
      mesh.setMatrixAt(i, world.clone().multiply(translation));
      mesh.setColorAt(i, new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace));
    });
    mesh.userData = { standard, flat, hand:obj.id.split("_")[0],restMatrix:mesh.matrix.clone() };
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    heldGroup.add(mesh);
  }
  heldGroup.visible = previewMode === "skin";
  scene.add(heldGroup);
  heldEditor?.update(data,heldGroup);
  updateVisibility();
}

/** 恢复工程的模型、生成参数、调色板和图层，然后显示已编辑的体素。 */
async function restoreProject(payload) {
  const result = payload.statue;
  modelInputs.forEach((input) => { input.checked = input.value === result.source.model; input.disabled = false; });
  const blob = await (await fetch(payload.skin)).blob();
  if (!await importSkin(new File([blob], result.source.filename || "project-skin.png", { type: "image/png" }))) throw new Error("工程皮肤无法打开。");
  await showPalette({ palette: payload.palette });
  const settings = result.options;
  const fields = { scale: "scale", detail: "detail", shell_thickness: "thickness", overlay_offset: "offset", alpha_threshold: "alpha", smoothness: "smoothness" };
  for (const [key, suffix] of Object.entries(fields)) {
    const input = $(`#statue-${suffix}`);
    if (input.tagName === "SELECT" && ![...input.options].some((o) => o.value === String(settings[key]))) input.add(new Option(String(settings[key]), String(settings[key])));
    input.value = settings[key];
  }
  $("#statue-hollow").value = settings.hollow ? "hollow" : "solid";
  $("#statue-connected").checked = settings.prefer_connected;
  excludedBlocks = settings.excluded;
  for (const key of visibility.keys()) visibility.set(key, settings.layers.includes(key));
  buildLayerControls();
  await poseControls.restore(result.workspace || settings);
  window.dispatchEvent(new CustomEvent("project-palette-settings", { detail: settings }));
  await displayStatue(result);
  editor.reset(result);
  if (result.workspace) $("#statue-state").textContent = "已恢复皮肤编辑设置；重新生成应用姿势与持物";
  updateGenerateButton();
}

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
  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 10000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 20;
  controls.maxDistance = 6000;
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

/** 按当前姿势和持物的包围盒适配固定视角；正面 +Z、角色左侧 +X。 */
function setView(view) {
  const offsets = {
    front: [0, 0, 65], back: [0, 0, -65],
    left: [65, 0, 0], right: [-65, 0, 0],
    top: [0, 65, 0.01], reset: [39, 15, 65],
  };
  const bounds=new THREE.Box3();
  scene.updateMatrixWorld(true);
  if(previewMode==="statue" && statueMesh) bounds.setFromObject(statueMesh);
  else if(player) {bounds.setFromObject(player);if(heldGroup)bounds.union(new THREE.Box3().setFromObject(heldGroup));}
  let distance=65;
  if(bounds.isEmpty())controls.target.set(0,16,0);
  else {
    controls.target.copy(bounds.getCenter(new THREE.Vector3()));
    const size=bounds.getSize(new THREE.Vector3());
    const extent=Math.max(size.x,size.y,size.z)/Math.min(1,camera.aspect);
    distance=Math.max(65,extent/(2*Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*1.15);
  }
  const offset=new THREE.Vector3(...offsets[view]).normalize().multiplyScalar(distance);
  camera.position.copy(controls.target).add(offset);
  // 清除阻尼中残留的旋转，确保固定视角可以精确到位。
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  camera.position.copy(controls.target).add(offset);
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
      mesh.userData = { key: `${part.id}:${layer}`, part:part.id, pixels: data.pixels, standard: standard[index], flat: flat[index] };
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
    markStatueChanged();
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
    await poseControls.apply();
    updateVisibility();
    updateAtlas();
    showMode("skin");
    showNotice(parsed.notes.join(" "));
    if (!preserveLayers) {
      $("#auto-rotate").checked = false;
      controls.autoRotate = false;
      setView("reset");
    }
    return true;
  } catch (error) {
    if (id !== requestId) return;
    modelInputs.forEach((input) => { input.checked = input.value === (skin?.model ?? "steve"); });
    showNotice(error.message, true);
    status.textContent = skin ? "导入失败，当前皮肤已保留。" : "导入失败，请选择有效的皮肤 PNG。";
    return false;
  } finally {
    if (id === requestId) {
      loading = false;
      $("#loading").hidden = true;
      $("#export").disabled = !skin;
      updateGenerateButton();
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
        markStatueChanged();
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
  if (statueMesh) {
    for (const material of statueMesh.material) {
      material.uniforms.rawColor.value = $("#flat-color").checked;
      material.uniforms.plainColor.value = $("#statue-plain").checked;
    }
  }
  for (const mesh of player.children) {
    mesh.visible = visibility.get(mesh.userData.key) && mesh.userData.pixels > 0;
    mesh.material = $("#flat-color").checked ? mesh.userData.flat : mesh.userData.standard;
  }
  if (heldGroup) heldGroup.children.forEach((mesh) => { mesh.material = $("#flat-color").checked ? mesh.userData.flat : mesh.userData.standard; });
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
  if (previewMode === "skin") status.textContent = `已解析 6 个部位 · 第二层 ${outer} 像素 · 当前显示 ${shown} 个图层`;
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
  // 浏览器工具栏刷新、F5、Ctrl+R 和关闭标签页都通过原生离开确认保护当前工作。
  window.addEventListener("beforeunload", (event) => {
    if (serviceStopping || (!skin && !statueData)) return;
    event.preventDefault();
    event.returnValue = "";
  });
  $("#stop-server").addEventListener("click",async()=>{
    const button=$("#stop-server");button.disabled=true;button.textContent="正在停止…";
    try {
      const response=await fetch("/api/shutdown",{method:"POST"});
      const result=await response.json();
      if(!response.ok)throw new Error(result.detail);
      serviceStopping = true;
      renderer.setAnimationLoop(null);
      document.querySelector(".workspace").inert=true;
      button.textContent="服务退出中";
      status.textContent="正在退出 Python 服务。";
      document.querySelector(".local-badge").textContent="已请求退出本地服务";
      showNotice("已请求退出。当前任务结束后 Python 进程会关闭；再次运行 start.bat 或 python run.py 后刷新页面即可继续。");
    } catch(error) {button.disabled=false;button.textContent="停止服务";showNotice(error.message,true);}
  });
  $("#username-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#import-username");
    button.disabled = true;
    button.textContent = "查询中…";
    const before = requestId;
    try {
      const response = await fetch("/api/skin/username", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#java-username").value.trim() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail);
      if (before !== requestId) return;
      modelInputs.forEach((input) => { input.checked = input.value === result.model; input.disabled = false; });
      const blob = await (await fetch(result.image)).blob();
      await importSkin(new File([blob], `${result.username}.png`, { type: "image/png" }));
    } catch (error) { showNotice(error.message, true); }
    finally { button.disabled = false; button.textContent = "查询皮肤"; }
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file && !editor?.busy) void importSkin(file);
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
    if (file && !editor?.busy) void importSkin(file);
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
      markStatueChanged();
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
  $("#statue-plain").addEventListener("change", updateVisibility);
  $("#preview-connected").addEventListener("change", () => void refreshConnectedPreview());
  $("#statue-alpha").addEventListener("change", () => void poseControls.apply());
  $("#show-anchor").addEventListener("change", () => { if (placementGuide) placementGuide.visible = previewMode === "statue" && $("#show-anchor").checked; });
  $("#export-statue").addEventListener("click", () => void exportStatue(false));
  $("#export-statue-bundle").addEventListener("click", () => void exportStatue(true));
  $("#generate-statue").addEventListener("click", () => void generateStatue());
  $("#show-skin").addEventListener("click", () => showMode("skin"));
  $("#show-statue").addEventListener("click", () => showMode("statue"));
  document.querySelectorAll(".statue-settings select, .statue-settings input").forEach((input) => input.addEventListener("change", markStatueChanged));
  $("#statue-connected").addEventListener("change", () => { updateGenerateButton(); window.dispatchEvent(new Event("connected-preference")); });
  window.addEventListener("palette-loaded", (event) => {
    palette = event.detail;
    excludedBlocks = [];
    $("#statue-palette").textContent = `静态候选 ${palette.eligible.toLocaleString()}；连接纹理候选 ${palette.connected_eligible.toLocaleString()}`;
    markStatueChanged();
    updateGenerateButton();
  });
  window.addEventListener("palette-exclusions", (event) => { excludedBlocks = event.detail; markStatueChanged(); });
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
  editor = initEditor({
    canvas: renderer.domElement, camera, scene,
    state: () => ({ mesh: statueMesh, data: statueData, mode: previewMode, busy: generating || loading || poseControls?.busy }),
    display: displayStatue, restore: restoreProject, download, notify: showNotice, sync: updateGenerateButton,
    workspace: () => poseControls.settings,
  });
  poseControls = initPoseControls({
    model: () => skin?.model, display: displayPose,
    changed: () => { markStatueChanged(); if (skin && previewMode !== "skin") showMode("skin"); heldEditor?.refreshSettings(); },
    palette: () => palette,
    sync: updateGenerateButton, resourcesChanged: refreshConnectedPreview,
  });
  heldEditor = initHeldEditor({
    scene,camera,canvas:renderer.domElement,mode:()=>previewMode,
    item:(hand)=>poseControls.getHeld(hand),change:(hand,values)=>poseControls.transformHeld(hand,values),
    joint:(part)=>poseControls.getJoint(part),rotateJoint:(part,angles)=>poseControls.rotateJoint(part,angles),
    notify:showNotice,showSkin:()=>{showMode("skin");controls.autoRotate=false;$("#auto-rotate").checked=false;},
    dragging:(value)=>{controls.enabled=!value;},
    pickables:()=>[...(player?.children || []),...(heldGroup?.children || [])],
  });
  void loadDemo();
} catch (error) {
  status.textContent = "无法创建 3D 预览。";
  showNotice(`请使用启用硬件加速、支持 WebGL 2 的浏览器。${error.message}`, true);
}

initResourcePanel();
