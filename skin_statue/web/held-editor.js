import * as THREE from "three";
import { TransformControls } from "/static/vendor/TransformControls.js";

const JOINTS = {head:"头部",body:"躯干（整个模型）",left_arm:"左臂",right_arm:"右臂",left_leg:"左腿",right_leg:"右腿"};

/** 共用三维手柄编辑持物与关节；即时矩阵补偿使拖动不等待服务端重建网格。 */
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
  let selectionKind = "item";
  let itemMode = "translate";
  let records = new Map();
  let joints = new Map();
  let group = null;
  let usedHandle = false;
  let start = null;
  let startScale = new THREE.Vector3(1, 1, 1);
  const ray = new THREE.Raycaster();

  /** 只显示皮肤编辑手柄，雕像预览始终保留已生成的状态。 */
  function visible() {
    const show = selected !== null && host.mode() === "skin";
    toolbar.hidden = !show; helper.visible = show; control.enabled = show;
    const joint = selectionKind === "joint";
    toolbar.querySelectorAll("[data-item-transform]").forEach((b)=>{b.hidden=joint && b.dataset.itemTransform!=="rotate";});
    document.querySelector("#held-transform-scale-options").hidden=joint;
    document.querySelector("#joint-transform-reset").hidden=!joint;
    document.querySelector("#held-transform-hint").textContent=joint
      ? "拖动红 X／绿 Y／蓝 Z 旋转环；躯干旋转整个模型，手臂旋转会带动对应手持物品。"
      : "拖动红 X／绿 Y／蓝 Z 手柄；位移使用世界轴，旋转和缩放使用握持点局部轴。";
  }

  /** 依据当前模式使用世界位移轴与物品局部旋转／缩放轴。 */
  function setMode(mode) {
    control.setMode(mode); control.setSpace(mode === "translate" ? "world" : "local");
    toolbar.querySelectorAll("[data-item-transform]").forEach((b) => b.classList.toggle("active", b.dataset.itemTransform === mode));
  }

  /** 将本次新网格相对于已返回矩阵的差量补上，保持鼠标拖动中的连续位置。 */
  function applyDelta() {
    if (!selected || !group) return;
    const joint=selectionKind==="joint";
    const row = joint ? joints.get(selected) : records.get(selected);
    frame.updateMatrixWorld(true);
    const oldWorld = new THREE.Matrix4().fromArray(joint ? row.joint_frame : row.edit_frame).multiply(new THREE.Matrix4().fromArray(joint ? row.joint_matrix : row.edit_matrix));
    const delta = proxy.matrixWorld.clone().multiply(oldWorld.invert());
    // 根旋转覆盖所有图层和物品；手臂只影响自身双层与对应那只手的装备。
    const meshes=joint ? host.pickables() : group.children.filter((m)=>m.userData.hand===selected);
    // 服务器会重新贴地；拖动中将相同的父坐标补偿应用于其余部位，保持肩、髋、颈的连接。
    const parentDelta=joint ? frame.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(row.joint_frame).invert()) : null;
    for (const mesh of meshes) {
      const affected=!joint || selected==="body" || mesh.userData.part===selected ||
        (selected==="left_arm" && mesh.userData.hand==="left") || (selected==="right_arm" && mesh.userData.hand==="right");
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(affected ? delta : parentDelta).multiply(mesh.userData.restMatrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
  }

  /** 数值面板、预设与工程恢复后，用同一份持物参数更新手柄。 */
  function refreshSettings() {
    if (!selected) return;
    if (selectionKind === "joint") {
      if (!joints.has(selected)) return;
      if (!control.dragging) {
        frame.matrix.fromArray(joints.get(selected).joint_frame);frame.matrixWorldNeedsUpdate=true;
        proxy.position.set(0,0,0);proxy.scale.set(1,1,1);
        proxy.rotation.set(...host.joint(selected).map(THREE.MathUtils.degToRad),"ZYX");
      }
      applyDelta();visible();return;
    }
    if (!records.has(selected)) return;
    const item = host.item(selected), row = records.get(selected);
    if (!item) { finish(); return; }
    if (!control.dragging) {
      frame.matrix.fromArray(row.edit_frame); frame.matrixWorldNeedsUpdate = true;
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
    host.showSkin(); selected = hand;selectionKind="item";setMode(itemMode);
    document.querySelector("#held-transform-name").textContent = hand === "right" ? "编辑右手物品" : "编辑左手物品";
    refreshSettings(); control.attach(proxy); visible();
  }
  /** 关节仅开放旋转；“躯干”选择模型根节点而非局部身体网格。 */
  function selectJoint(part) {
    if(!joints.has(part)) {
      const message="当前服务尚未加载关节接口，请先保存工程并重启本地工具。";
      document.querySelector("#pose-status").textContent=message;
      host.notify(message,true);return;
    }
    host.showSkin();selected=part;selectionKind="joint";setMode("rotate");
    document.querySelector("#held-transform-name").textContent=`旋转${JOINTS[part]}`;
    document.querySelector("#pose-status").textContent=`已选中${JOINTS[part]}，拖动三色旋转环调整角度。`;
    refreshSettings();control.attach(proxy);visible();
  }
  function finish() {
    selected = null; control.detach(); host.dragging(false); visible();
  }

  control.addEventListener("dragging-changed", (event) => {
    host.dragging(event.value);
    if (event.value) startScale.copy(proxy.scale);
    else refreshSettings();
  });
  control.addEventListener("objectChange", () => {
    if (!selected) return;
    if(selectionKind==="joint") {
      const angles=[proxy.rotation.x,proxy.rotation.y,proxy.rotation.z].map((v)=>((THREE.MathUtils.radToDeg(v)+180)%360+360)%360-180);
      host.rotateJoint(selected,angles);applyDelta();return;
    }
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
    else if(hit?.object.userData.part) selectJoint(hit.object.userData.part);
  });
  host.canvas.addEventListener("pointercancel", () => { start = null; usedHandle = false; host.dragging(false); });
  window.addEventListener("edit-held-item", (event) => select(event.detail));
  window.addEventListener("edit-pose-joint",(event)=>selectJoint(event.detail));
  toolbar.querySelectorAll("[data-item-transform]").forEach((b) => b.addEventListener("click", () => {
    if(selectionKind==="item")itemMode=b.dataset.itemTransform;
    setMode(selectionKind==="joint" ? "rotate" : b.dataset.itemTransform);
  }));
  document.querySelector("#held-transform-done").addEventListener("click", finish);
  document.querySelector("#joint-transform-reset").addEventListener("click",()=>host.rotateJoint(selected,[0,0,0]));
  setMode("translate"); visible();

  return {
    refreshSettings, setVisible: visible,
    /** 服务端换入新网格时重新基准化，但拖动期间不覆盖手柄的当前位置。 */
    update(data, meshes) {
      group = meshes;
      records = new Map(data.objects.filter((o) => o.edit_frame).map((o) => [o.id.split("_")[0], o]));
      joints=new Map(data.objects.filter((o)=>o.joint_frame).map((o)=>[o.id,o]));
      if (selected && !(selectionKind==="joint" ? joints : records).has(selected)) finish();
      else refreshSettings();
    },
  };
}
