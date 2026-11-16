import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { initResourcePanel, showPalette } from "/static/resources.js";
import { createStatue, disposeStatue, createPlacementGuide, disposePlacementGuide } from "/static/statue.js";

import { initEditor } from "/static/editor.js";
import { initPoseControls } from "/static/poses.js";
import { initHeldEditor } from "/static/held-editor.js";
import { initSceneEditor } from "/static/scene.js";

const $ = (selector) => document.querySelector(selector);
const matchingInputs = [...document.querySelectorAll(".matching-controls input")];
const matchingDefaults = Object.fromEntries(matchingInputs.map((input) => [input.id.replace("matching-", ""), Number(input.defaultValue)]));
let preferencesWrite = Promise.resolve();

/** 串行保存 change 操作，页面停止服务前等待最后一次写入。 */
function saveAlgorithmPreferences() {
  const settings = { matching: matchingSettings(), smoothness: Number($("#statue-smoothness").value), prefer_connected: $("#statue-connected").checked };
  preferencesWrite = preferencesWrite.then(async () => {
    const response = await fetch("/api/preferences", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings), keepalive: true });
    if (!response.ok) throw new Error((await response.json()).detail);
    $("#preferences-status").textContent = "选材设置已保存，下次启动自动恢复。";
  }).catch((error) => { $("#preferences-status").textContent = `保存选材设置失败：${error.message}`; });
}

/** 先恢复允许持久化的项目，再初始化注册表界面，其他控件保持启动默认值。 */
async function restorePreferences() {
  const controls = [...matchingInputs, $("#statue-smoothness"), $("#statue-connected"), $("#reset-matching"), $("#index-file"), $("#scan-instance")];
  controls.forEach((input) => { input.disabled = true; });
  $("#resource-status").textContent = "正在恢复上次的运行时索引与选材设置…";
  try {
    const response = await fetch("/api/preferences");
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail);
    for (const input of matchingInputs) input.value = result.algorithm.matching[input.id.replace("matching-", "")];
    const strategy = $("#statue-smoothness");
    if (![...strategy.options].some((o) => o.value === String(result.algorithm.smoothness))) strategy.add(new Option(String(result.algorithm.smoothness), String(result.algorithm.smoothness)));
    strategy.value = result.algorithm.smoothness;
    $("#statue-connected").checked = result.algorithm.prefer_connected;
    $("#preferences-status").textContent = "已恢复选材设置；成功导入的运行时索引也会自动保留。";
  } catch (error) { $("#preferences-status").textContent = `恢复设置失败：${error.message}`; }
  controls.forEach((input) => { input.disabled = false; });
  initResourcePanel(() => ({ matching: matchingSettings(), smoothness: Number($("#statue-smoothness").value) }));
}

/** 保存到生成参数，候选排序和工程恢复使用同一组权重。 */
function matchingSettings() {
  return Object.fromEntries(matchingInputs.map((input) => [input.id.replace("matching-", ""), Number(input.value)]));
}

/** 参数名称及输入框可悬浮查看含义。 */
function initParameterHelp() {
  const hints = {
    "statue-scale": "站立皮肤原高为 32 像素。倍率越高，方块越多、轮廓越精细；实际高度也受姿势和外层影响。",
    "statue-detail": "逐像素保留原始轮廓。2×2 或 4×4 会先平均颜色和透明度，减少细节，也可能削弱耳尖等小轮廓。",
    "statue-hollow": "空心只保留主体外壳，节省方块；实心填满内部。第二层单独保留。",
    "statue-thickness": "空心主体保留多少格厚的壳；仅在空心模式生效。越厚所需方块越多。",
    "statue-offset": "第二层至少向外突出多少格。实际还会保留头部 0.5、其他部位 0.25 皮肤像素乘倍率的膨胀量。",
    "statue-alpha": "透明度范围为 0～255，0 完全透明，255 完全不透明。达到此数值的外层像素才生成方块；降低会保留更多半透明细节，提高会过滤它们。",
    "statue-smoothness": "控制平滑惩罚的总强度：颜色优先不惩罚花纹；平衡和均匀平滑优先会逐渐避开渐变、颗粒和接缝。下方可细调各项权重。",
    "statue-connected": "允许安全的连接纹理方块参与匹配，并按偏好强度奖励。支持连接并不等于纯色，有花纹或接缝的材料仍会受到惩罚。",
    "matching-uniformity": "越高越偏好单块内部颜色均匀的纹理，减少机械面板、对角渐变和大色斑。受上方匹配策略强度控制；0 关闭此项。",
    "matching-border": "越高越排斥明显外框以及重复铺设时两侧边缘颜色不一致的接缝。受匹配策略强度控制；0 关闭此项。",
    "matching-grain": "越高越排斥密集颗粒和细碎像素变化。受匹配策略强度控制；0 关闭此项。",
    "matching-connection": "只在勾选优先连接纹理时生效。越高越偏好连接方块；连接后仍有渐变或接缝的材料奖励会减弱。0 关闭奖励，但仍允许这些候选参与。",
    "matching-color_tolerance": "相对颜色最接近的候选，最多允许多出多少 Lab 色差来换取平滑效果。越大越容易选到平整材料，也越可能偏色；0 只允许最接近的颜色。",
    "matching-building": "越高越优先私人维度允许材料、羊毛、混凝土和 Ztones 等建筑块；其次为普通建筑分类，再考虑其他材料。仍受允许色差约束；0 关闭经济偏好。粉末等重力块仍排除。",
    "preview-connected": "只改变当前预览的纹理拼接，不重新选材。需要加载实例实际使用的连接图；可与关闭时对比。",
    "statue-plain": "使用方块纹理的平均色显示，便于区分颜色匹配和纹理花纹问题；不改变导出方块。",
    "flat-color": "关闭预览的方向明暗，按纹理原色显示；不改变方块或皮肤文件。",
  };
  for (const [id, text] of Object.entries(hints)) {
    const input = $(`#${id}`);
    input.title = text;
    const label = input.closest("label");
    if (label) {
      label.title = text;
      label.classList.add("parameter-help");
    }
  }
  for (const hand of ["left", "right"]) {
    for (const [field, text] of Object.entries({ scale: "整体等比例放大物品；不改变握持绑定。重新生成才应用到雕像。", thickness: "单位为皮肤像素。0 为双面薄片，体素化至少占一格；提高会把物品加厚。", kind: "决定游戏中的握持方式；立方体类型按六面方块生成，其他类型按图标生成。" })) {
      const input = $(`#held-${hand}-${field}`);
      input.title = text;
      const label = input.closest("label");
      if (label) { label.title = text; label.classList.add("parameter-help"); }
    }
  }
  for (const row of document.querySelectorAll(".pose-angle-row")) {
    const inputs = [...row.querySelectorAll("input")];
    const first = inputs[0];
    const text = first.hasAttribute("data-pose-part") ? "依次为 X、Y、Z 轴旋转角度，单位是度。围绕绑定关节转动；躯干会旋转整个模型。" : first.id.includes("offset") ? "依次为 X 左右、Y 上下、Z 前后位移，单位为皮肤像素。随手臂动作保持绑定。" : first.id.includes("stretch") ? "依次为 X、Y、Z 三个轴的缩放倍率。1 为原大小，可分别修改以拉长或压扁物品。" : "依次为 X、Y、Z 轴旋转角度，单位是度；调整物品相对于手的方向。";
    for (const input of inputs) input.title = text;
    row.querySelector("span").title = text;
  }
  for (const label of document.querySelectorAll("label.parameter-help")) {
    const text = [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    const caption = text ? document.createElement("span") : label.querySelector("span");
    if (text) { caption.textContent = text.textContent; text.replaceWith(caption); }
    caption.classList.add("parameter-name");
    caption.title = label.title;
    const icon = document.createElement("small"); icon.textContent = " ⓘ"; icon.setAttribute("aria-hidden", "true");
    caption.append(icon);
  }
}
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
let sceneEditor = null;

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
  $("#statue-export-hint").textContent = "正在编码结构并读回校验 ID、Metadata 和粘贴站位…";
  try {
    const response = await fetch(`/api/statue/${snapshot.statue_id}/export?profile=${profile}&bundle=${bundle}&anchor=${$("#paste-anchor").value}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail);
    }
    download(URL.createObjectURL(await response.blob()), filename, true);
    $("#statue-export-hint").textContent = profile === "schematica_gtnh" ? `已导出 ${filename}。在 Schematica 中启用 SchematicPlus，并用其 GUI 定位。` : `已导出 ${filename}。站在所选位置：//schem load mcedit statue-${snapshot.statue_id.slice(0, 8)}-${profile}，然后 //paste -a。朝向整体中心；普通粘贴保持坐标方向。`;
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
  sceneEditor?.sync();
  const count = (palette?.eligible ?? 0) + ($("#statue-connected").checked ? (palette?.connected_eligible ?? 0) : 0);
  $("#generate-statue").disabled = !skin || !count || loading || generating || editor?.busy || poseControls?.busy || sceneEditor?.busy;
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
  sceneEditor?.visible();
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
  if (!skin || !palette || generating || editor?.busy || poseControls?.busy || sceneEditor?.busy) return;
  for (const input of matchingInputs) {
    input.required = true;
    if (!input.reportValidity()) return;
  }
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
    matching: matchingSettings(), paste_anchor: $("#paste-anchor").value,
  };
  try {
    const response = await fetch("/api/scene/generate", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({...options, scene: sceneEditor.document()}) });
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
  updatePlacementGuide();
  updateExportButtons();
  updateVisibility();
  $("#show-statue").disabled = false;
  $("#statue-state").textContent = result.edits?.length ? `已编辑 ${result.edits.length} 次` : "生成完成";
  $("#statue-report").hidden = false;
  $("#statue-statistics").textContent = `站立高度基准 ${result.base_height} 格；实际包围尺寸 ${result.dimensions.join(" × ")} 格\n${result.options.hollow ? "空心" : "实心"} · 方块 ${result.block_count.toLocaleString()} · 第二层 ${result.overlay_blocks.toLocaleString()}\n可见单格面 ${result.mesh.exposed_faces.toLocaleString()} → 合并矩形 ${result.mesh.quad_count.toLocaleString()}\n初次生成平均 / 最大 Lab 色差 ${result.matching.mean_color_error} / ${result.matching.max_color_error}；内部填充 ${result.matching.interior_block}`;
  if (["uniform-building-v4", "uniform-seam-ctm-v3", "border-grain-ctm-v2"].includes(result.matching.method)) {
    $("#statue-statistics").textContent += `\n${result.matching.method === "border-grain-ctm-v2" ? "匹配已考虑边框与颗粒" : "匹配已考虑颜色均匀度、平铺接缝与颗粒"}${result.matching.method === "uniform-building-v4" ? ` · 建筑材料优先强度 ${result.matching.building_preference}` : ""}；可用连接图材料 ${result.matching.ctm_available} 种，初次选用 ${result.matching.ctm_selected} 种`;
  }
  const materialRows = result.actor_materials ? result.actor_materials.flatMap((actor) => actor.materials.map((m) => ({...m, actor_name: actor.name}))) : result.materials;
  $("#statue-materials").replaceChildren(...materialRows.map((material) => {
    const row = document.createElement("div");
    row.textContent = `${material.actor_name ? "[" + material.actor_name + "] " : ""}${material.display_name ? material.display_name + " · " : ""}${material.key} · ID ${material.numeric_id} · ${material.count.toLocaleString()} 块`;
    return row;
  }));
  showMode("statue");
  $("#ctm-preview-status").textContent = !result.ctm?.enabled ? "连接纹理预览已关闭。" : `连接纹理：${result.ctm.connected_faces.toLocaleString()} 个暴露面。${result.ctm.unsupported_materials.length ? `${result.ctm.unsupported_materials.length} 种材料缺少支持的连接图，显示基础纹理；可从实例载入 CTM 资源。` : ""}`;
  const notices = [];
  if (result.overlap_blocks) notices.push(`人物重叠 ${result.overlap_blocks.toLocaleString()} 格，已保留列表中靠前人物的方块。`);
  if (result.options.prefer_connected && result.matching.ctm_available === 0) notices.push("尚未加载可用连接图；请从相同资源包的客户端实例载入连接纹理后重新生成，以按连接效果选材。");
  if (result.legacy_groups) notices.push("旧工程按打开时的材质建立固定分组；此前已合并的范围需要重新生成才能恢复原始分组。");
  showNotice(notices.join(" "));
}

/** 站位只改变导出偏移和辅助小人，保留当前实际方块与材料编辑历史。 */
function updatePlacementGuide() {
  if (!statueData) return;
  const selection=$("#paste-anchor").value;
  const id=selection==="auto" ? statueData.placement.default_anchor : selection;
  const point=statueData.placement.points[id];
  statueData.placement={...statueData.placement,selection,anchor:id,label:point.label,anchor_local:point.position,offset:point.position.map((v)=>-v)};
  if(placementGuide){scene.remove(placementGuide);disposePlacementGuide(placementGuide);}
  placementGuide=createPlacementGuide(statueData);scene.add(placementGuide);
  placementGuide.visible=previewMode==="statue" && $("#show-anchor").checked;
  $("#statue-export-hint").textContent=`粘贴站位：${point.label} · 局部格坐标 ${point.position.join(", ")}；底面几何中心 ${statueData.placement.center.join(", ")}。小人朝向整体中心。`;
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
    const obj = objects.get(mesh.userData.key.split(":")[0]);
    if (!obj) continue;
    mesh.matrix.fromArray(obj.matrix);
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
      const standard=maps.map((map)=>new THREE.MeshStandardMaterial({map,roughness:1,side:THREE.DoubleSide,alphaTest:obj.id === "cape" ? obj.alpha_threshold / 255 : 0}));
      const flat=maps.map((map)=>new THREE.MeshBasicMaterial({map,side:THREE.DoubleSide,alphaTest:obj.id === "cape" ? obj.alpha_threshold / 255 : 0}));
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(...obj.size),standard);
      mesh.matrixAutoUpdate=false;mesh.matrix.fromArray(obj.matrix);mesh.userData={standard,flat,...(obj.id === "cape" ? {part:"cape"} : {hand:obj.id.split("_")[0]}),restMatrix:mesh.matrix.clone()};heldGroup.add(mesh);
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
  sceneEditor?.tagActive();
  updateVisibility();
}

/** 恢复工程的模型、生成参数、调色板和图层，然后显示已编辑的体素。 */
async function restoreProject(payload) {
  const result = payload.statue;
  $("#paste-anchor").value = result.workspace?.paste_anchor || result.placement.selection;
  modelInputs.forEach((input) => { input.checked = input.value === result.source.model; input.disabled = false; });
  const sceneDoc = result.workspace?.scene || result.scene;
  if (!sceneDoc) {
    sceneEditor.reset();
    const blob = await (await fetch(payload.skin)).blob();
    if (!await importSkin(new File([blob], result.source.filename || "project-skin.png", { type: "image/png" }))) throw new Error("工程皮肤无法打开。");
  }
  await showPalette({ palette: payload.palette });
  const settings = result.options;
  for (const input of matchingInputs) {
    const key = input.id.replace("matching-", "");
    input.value = settings.matching?.[key] ?? matchingDefaults[key];
  }
  const fields = { scale: "scale", detail: "detail", shell_thickness: "thickness", overlay_offset: "offset", alpha_threshold: "alpha", smoothness: "smoothness" };
  for (const [key, suffix] of Object.entries(fields)) {
    const input = $(`#statue-${suffix}`);
    if (input.tagName === "SELECT" && ![...input.options].some((o) => o.value === String(settings[key]))) input.add(new Option(String(settings[key]), String(settings[key])));
    input.value = settings[key];
  }
  $("#statue-hollow").value = settings.hollow ? "hollow" : "solid";
  $("#statue-connected").checked = settings.prefer_connected;
  excludedBlocks = settings.excluded;
  if (sceneDoc) await sceneEditor.restore(sceneDoc);
  else {
    for (const key of visibility.keys()) visibility.set(key, settings.layers.includes(key));
    buildLayerControls();
    await poseControls.restore(result.workspace || settings);
    sceneEditor.remember();
  }
  window.dispatchEvent(new CustomEvent("project-palette-settings", { detail: settings }));
  await displayStatue(result);
  editor.reset(result);
  if (result.workspace) $("#statue-state").textContent = "已恢复皮肤编辑设置；重新生成应用姿势与持物";
  saveAlgorithmPreferences();
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
  else if(player) for (const mesh of sceneEditor?.meshes() || player.children.filter((m) => m.visible)) bounds.union(new THREE.Box3().setFromObject(mesh));
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

/** 移除人物或恢复工程时释放该人物独占的网格、材质和纹理。 */
function disposeActor(bundle) {
  if (!bundle) return;
  const mats=new Set(bundle.materials), maps=new Set([bundle.texture]);
  for(const group of [bundle.player,bundle.heldGroup]) if(group) {
    scene.remove(group);
    for(const mesh of group.children) {
      mesh.geometry.dispose();
      for(const material of [mesh.userData.standard,mesh.userData.flat].flat()) mats.add(material);
      if(mesh.isInstancedMesh)mesh.dispose();
    }
  }
  for(const material of mats){if(material.map)maps.add(material.map);material.dispose();}
  for(const map of maps)if(map)map.dispose();
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
    if (!sceneEditor?.busy) sceneEditor?.remember();
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
      input.disabled = data.pixels === 0 || (sceneEditor?.headOnly && part.id !== "head");
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
    mesh.visible = visibility.get(mesh.userData.key) && mesh.userData.pixels > 0 && (!sceneEditor?.headOnly || mesh.userData.part === "head");
    mesh.material = $("#flat-color").checked ? mesh.userData.flat : mesh.userData.standard;
  }
  if (heldGroup) heldGroup.children.forEach((mesh) => { mesh.material = $("#flat-color").checked ? mesh.userData.flat : mesh.userData.standard; });
  sceneEditor?.visible();
  for (const layer of ["base", "overlay"]) {
    const inputs = [...document.querySelectorAll(`[data-layer="${layer}"]:not(:disabled)`)];
    const checked = inputs.filter((input) => input.checked).length;
    const master = $(`#${layer}-visible`);
    master.checked = inputs.length > 0 && checked === inputs.length;
    master.indeterminate = checked > 0 && checked < inputs.length;
    master.disabled = inputs.length === 0;
  }
  const outer = skin.parts.filter((p)=>!sceneEditor?.headOnly || p.id==="head").reduce((total, part) => total + part.layers.overlay.pixels, 0);
  const shown = player.children.filter((mesh) => mesh.visible).length;
  if (previewMode === "skin") status.textContent = `已解析 ${sceneEditor?.headOnly ? 1 : 6} 个部位 · 第二层 ${outer} 像素 · 当前显示 ${shown} 个图层`;
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
      await preferencesWrite;
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
      poseControls.addCapes(result.capes || []);
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
  $("#paste-anchor").addEventListener("change",updatePlacementGuide);
  // 点击固定吸附点选择粘贴站位；拖动继续交给相机。
  const anchorRay=new THREE.Raycaster();let anchorDown=null;
  renderer.domElement.addEventListener("pointerdown",(e)=>{anchorDown=e.button===0?{x:e.clientX,y:e.clientY}:null;});
  renderer.domElement.addEventListener("pointercancel",()=>{anchorDown=null;});
  renderer.domElement.addEventListener("pointerup",(e)=>{
    const down=anchorDown;anchorDown=null;
    if(!down || !placementGuide?.visible || previewMode!=="statue" || Math.hypot(e.clientX-down.x,e.clientY-down.y)>5)return;
    const r=renderer.domElement.getBoundingClientRect();
    anchorRay.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);
    const hit=anchorRay.intersectObject(placementGuide,true).find((h)=>h.object.userData.anchorPoint);
    if(hit){e.statuePlacementHandled=true;$("#paste-anchor").value=hit.object.userData.anchorPoint;updatePlacementGuide();}
  });
  $("#show-anchor").addEventListener("change", () => { if (placementGuide) placementGuide.visible = previewMode === "statue" && $("#show-anchor").checked; });
  $("#export-statue").addEventListener("click", () => void exportStatue(false));
  $("#export-statue-bundle").addEventListener("click", () => void exportStatue(true));
  $("#generate-statue").addEventListener("click", () => void generateStatue());
  $("#show-skin").addEventListener("click", () => showMode("skin"));
  $("#show-statue").addEventListener("click", () => showMode("statue"));
  document.querySelectorAll(".statue-settings select, .statue-settings input").forEach((input) => input.addEventListener("change", markStatueChanged));
  $("#reset-matching").addEventListener("click", () => {
    for (const input of matchingInputs) input.value = matchingDefaults[input.id.replace("matching-", "")];
    $("#statue-smoothness").value = "0.2";
    $("#statue-connected").checked = false;
    saveAlgorithmPreferences();
    window.dispatchEvent(new Event("connected-preference"));
    markStatueChanged();
  });
  for (const input of [...matchingInputs, $("#statue-smoothness"), $("#statue-connected")]) input.addEventListener("change", saveAlgorithmPreferences);
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
    state: () => ({ mesh: statueMesh, data: statueData, mode: previewMode, busy: generating || loading || poseControls?.busy || sceneEditor?.busy }),
    display: displayStatue, restore: restoreProject, download, notify: showNotice, sync: updateGenerateButton,
    workspace: () => ({...poseControls.settings, paste_anchor:$("#paste-anchor").value, scene: sceneEditor.document()}),
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
    placement:()=>poseControls.settings.placement,move:(placement)=>poseControls.setPlacement({...poseControls.settings,placement}),
    joint:(part)=>poseControls.getJoint(part),rotateJoint:(part,angles)=>poseControls.rotateJoint(part,angles),
    notify:showNotice,showSkin:()=>{showMode("skin");controls.autoRotate=false;$("#auto-rotate").checked=false;},
    dragging:(value)=>{controls.enabled=!value;},
    pickables:()=>[...(player?.children || []),...(heldGroup?.children || [])],
  });
  sceneEditor = initSceneEditor({
    canvas: renderer.domElement, camera,
    read: () => ({file:currentFile, skin, layers:[...visibility].filter(([,v])=>v).map(([k])=>k), options:poseControls.settings, render:{player,heldGroup,materials,texture}}),
    detach: () => { player=null;heldGroup=null;skin=null;currentFile=null;materials=[];texture=null; },
    async activate(actor) {
      if (actor.render) {
        ({player,heldGroup,materials,texture}=actor.render); skin=actor.skin;currentFile=actor.file;
        modelInputs.forEach((input)=>{input.checked=input.value===skin.model;input.disabled=skin.legacy&&input.value==="alex";});
        $("#file-info").textContent=`${currentFile.name} · ${skin.source_size.join(" × ")}`;
        $("#model-hint").textContent=skin.legacy ? "64×32 旧皮肤使用 Steve。" : "请选择与皮肤匹配的手臂模型。";
      } else {
        modelInputs.forEach((input)=>{input.checked=input.value===(actor.model || actor.skin?.model || "steve");input.disabled=false;});
        await poseControls.restore(actor.options);
        const file=actor.file || new File([await (await fetch(actor.image)).blob()],actor.name+".png",{type:"image/png"});
        if (!await importSkin(file)) throw new Error(`人物“${actor.name}”的皮肤无法打开。`);
      }
      if (actor.layers) for(const key of visibility.keys())visibility.set(key,actor.layers.includes(key));
      buildLayerControls(); await poseControls.restore(actor.options);updateAtlas();showMode("skin");
    },
    dispose: disposeActor,
    flush: () => poseControls.apply(), clearGizmo: () => heldEditor.clearSelection(),
    busy: () => generating || loading || editor?.busy,
    sync:updateGenerateButton, notify:showNotice, changed:markStatueChanged, visibility:updateVisibility,
    mode:()=>previewMode,flat:()=>$("#flat-color").checked,dragging:()=>!controls.enabled,
    transform:(values)=>poseControls.setPlacement(values),
    async modeChanged(){
      buildLayerControls();
      for(const row of document.querySelectorAll(".joint-angle-row")) row.inert = sceneEditor.headOnly && row.querySelector("[data-pose-part]").dataset.posePart !== "head";
      await poseControls.apply();updateVisibility();setView("reset");
    },
  });
  initParameterHelp();
  void loadDemo();
} catch (error) {
  status.textContent = "无法创建 3D 预览。";
  showNotice(`请使用启用硬件加速、支持 WebGL 2 的浏览器。${error.message}`, true);
}

void restorePreferences();
