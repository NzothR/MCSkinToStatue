import * as THREE from "three";
import { TransformControls } from "/static/vendor/TransformControls.js";

/** 在手部关节坐标系内编辑握持点；即时矩阵补偿使拖动不等待服务端重建像素网格。 */
export function initHeldEditor(host) {
  const control = new TransformControls(host.camera, host.canvas);
  const helper = control.getHelper();
  host.scene.add(helper);
  control.enabled = false;
  control.setSize(.85);
  const frame = new THREE.Group();
  frame.matrixAutoUpdate = false;
  const proxy = new THREE.Object3D();
  proxy.rotation.order = "ZYX";
  frame.add(proxy); host.scene.add(frame);
  const toolbar = document.querySelector("#held-transform-toolbar");
  let selected = null;
  let records = new Map();
  let group = null;
  let usedHandle = false;
  let start = null;
  let startScale = new THREE.Vector3(1, 1, 1);
  const ray = new THREE.Raycaster();

  /** 只显示皮肤编辑手柄，雕像预览始终保留已生成的状态。 */
  function visible() {
    const show = selected !== null && host.mode() === "skin";
    toolbar.hidden = !show; helper.visible = show; control.enabled = show;
  }

  /** 依据当前模式使用世界位移轴与物品局部旋转／缩放轴。 */
  function setMode(mode) {
    control.setMode(mode); control.setSpace(mode === "translate" ? "world" : "local");
    toolbar.querySelectorAll("[data-item-transform]").forEach((b) => b.classList.toggle("active", b.dataset.itemTransform === mode));
  }

  /** 将本次新网格相对于已返回矩阵的差量补上，保持鼠标拖动中的连续位置。 */
  function applyDelta() {
    if (!selected || !group || !records.has(selected)) return;
    const row = records.get(selected);
    frame.updateMatrixWorld(true);
    const oldWorld = new THREE.Matrix4().fromArray(row.edit_frame).multiply(new THREE.Matrix4().fromArray(row.edit_matrix));
    const delta = proxy.matrixWorld.clone().multiply(oldWorld.invert());
    for (const mesh of group.children.filter((m) => m.userData.hand === selected)) {
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(delta).multiply(mesh.userData.restMatrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
  }

  /** 数值面板、预设与工程恢复后，用同一份持物参数更新手柄。 */
  function refreshSettings() {
    if (!selected || !records.has(selected)) return;
    const item = host.item(selected), row = records.get(selected);
    if (!item) { finish(); return; }
    frame.matrix.fromArray(row.edit_frame); frame.matrixWorldNeedsUpdate = true;
    if (!control.dragging) {
      proxy.position.fromArray(row.grip).add(new THREE.Vector3(...(item.offset || [0, 0, 0])));
      proxy.rotation.set(...(item.rotation || [0, 0, 0]).map(THREE.MathUtils.degToRad), "ZYX");
      proxy.scale.fromArray(item.stretch || [1, 1, 1]).multiplyScalar(item.scale ?? 1);
    }
    applyDelta(); visible();
  }

  /** 选择左右手时把手柄定位到实际握持点，结束编辑仅隐藏手柄。 */
  function select(hand) {
    if (!host.item(hand)) { host.notify("请先给这只手装备物品。", true); return; }
    if (!records.has(hand)) { host.notify("请先保存工程并重启本地服务，以加载可视化物品编辑接口。", true); return; }
    host.showSkin(); selected = hand;
    document.querySelector("#held-transform-name").textContent = hand === "right" ? "编辑右手物品" : "编辑左手物品";
    refreshSettings(); control.attach(proxy); visible();
  }
  function finish() {
    selected = null; control.detach(); host.dragging(false); visible();
  }

  control.addEventListener("dragging-changed", (event) => {
    host.dragging(event.value);
    if (event.value) startScale.copy(proxy.scale);
  });
  control.addEventListener("objectChange", () => {
    if (!selected) return;
    const item = host.item(selected), grip = new THREE.Vector3(...records.get(selected).grip);
    const factor = item.scale ?? 1;
    const min = .01 * factor, max = 16 * factor;
    if (control.mode === "scale" && document.querySelector("#held-transform-uniform").checked) {
      const axis = control.axis === "Y" ? "y" : control.axis === "Z" ? "z" : "x";
      const ratio = proxy.scale[axis] / startScale[axis];
      const lower = Math.max(...startScale.toArray().map((v) => min / v));
      const upper = Math.min(...startScale.toArray().map((v) => max / v));
      proxy.scale.copy(startScale).multiplyScalar(THREE.MathUtils.clamp(ratio, lower, upper));
    } else proxy.scale.clampScalar(min, max);
    const offset = proxy.position.clone().sub(grip).clampScalar(-64, 64);
    proxy.position.copy(grip).add(offset);
    const angles = [proxy.rotation.x, proxy.rotation.y, proxy.rotation.z].map((v) => ((THREE.MathUtils.radToDeg(v) + 180) % 360 + 360) % 360 - 180);
    host.change(selected, { offset: offset.toArray(), rotation: angles, stretch: proxy.scale.toArray().map((v) => v / factor) });
    applyDelta();
  });

  /** 优先让手柄接管鼠标，防止拖轴时 OrbitControls 同时旋转相机。 */
  function pointer(event) {
    const r = host.canvas.getBoundingClientRect();
    return { x: (event.clientX - r.left) / r.width * 2 - 1, y: -(event.clientY - r.top) / r.height * 2 + 1, button: event.button };
  }
  host.canvas.addEventListener("pointerdown", (event) => {
    start = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    usedHandle = false;
    if (!control.enabled || event.button !== 0) return;
    control.pointerHover(pointer(event));
    usedHandle = control.axis !== null;
    if (usedHandle) host.dragging(true);
  }, true);
  host.canvas.addEventListener("pointerup", (event) => {
    const down = start; start = null;
    if (usedHandle) { usedHandle = false; host.dragging(false); return; }
    if (!down || down.id !== event.pointerId || host.mode() !== "skin" || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const p = pointer(event); ray.setFromCamera(new THREE.Vector2(p.x, p.y), host.camera);
    const hit = ray.intersectObjects(host.pickables(), false).find((h) => h.object.visible);
    if (hit?.object.userData.hand) select(hit.object.userData.hand);
  });
  host.canvas.addEventListener("pointercancel", () => { start = null; usedHandle = false; host.dragging(false); });
  window.addEventListener("edit-held-item", (event) => select(event.detail));
  toolbar.querySelectorAll("[data-item-transform]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.itemTransform)));
  document.querySelector("#held-transform-done").addEventListener("click", finish);
  setMode("translate"); visible();

  return {
    refreshSettings, setVisible: visible,
    /** 服务端换入新网格时重新基准化，但拖动期间不覆盖手柄的当前位置。 */
    update(data, meshes) {
      group = meshes;
      records = new Map(data.objects.filter((o) => o.edit_frame).map((o) => [o.id.split("_")[0], o]));
      if (selected && !records.has(selected)) finish();
      else refreshSettings();
    },
  };
}
