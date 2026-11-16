const $ = (s) => document.querySelector(s);
const PARTS = { head: "头部", body: "躯干", right_arm: "右臂", left_arm: "左臂", right_leg: "右腿", left_leg: "左腿" };

/** 预设和旧工程允许整圈角度，界面及接口统一使用 -180～180 度的等价值。 */
function normalizedRotations(rotations) {
  return Object.fromEntries(Object.entries(rotations).map(([part, angles]) => [part, angles.map((angle) => ((angle + 180) % 360 + 360) % 360 - 180)]));
}

/** 姿势与两手装备独立存储，工程恢复及生成读取相同设置。 */
export function initPoseControls(host) {
  let pose = {};
  let held = {};
  let presets = [];
  let catalog = [];
  let catalogOffset = 0;
  let catalogTotal = 0;
  let catalogSequence = 0;
  let sequence = 0;
  let applying = false;
  let applyTimer = null;
  const itemRequests = { left: 0, right: 0 };

  /** 传递资源和输入错误，已有可见模型保留到新结果就绪。 */
  async function json(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "姿势或物品参数无效。");
    return data;
  }

  /** 每次变化请求同一套服务端矩阵，快速连续操作仅显示最新一次结果。 */
  async function apply() {
    clearTimeout(applyTimer); applyTimer = null;
    const token = ++sequence;
    if (!host.model()) return;
    applying = true; host.sync();
    try {
      const result = await json("/api/pose", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: host.model(), pose, held, alpha_threshold: Number($("#statue-alpha").value) }) });
      if (token !== sequence) return;
      host.display(result);
      $("#pose-status").textContent = "姿势与持物已更新；生成雕像使用这些设置。";
    } catch (error) { if (token === sequence) $("#pose-status").textContent = error.message; }
    finally { if (token === sequence) { applying = false; host.sync(); } }
  }

  /** 修改角度或装备后标记雕像需要重新生成，但不改变另一部分设置。 */
  function changed() {
    host.changed();
    // 每 50ms 提交最新参数；持续按住步进按钮时仍更新，不必等松开或移走焦点。
    if (applyTimer === null) applyTimer = setTimeout(() => { void apply(); }, 50);
    $("#pose-status").textContent = "正在更新姿势与持物…";
    host.sync();
  }

  /** 回填关节数值，不把物品装备覆盖为姿势预设中的内容。 */
  function showAngles() {
    for (const input of document.querySelectorAll("[data-pose-part]")) input.value = pose[input.dataset.posePart]?.[Number(input.dataset.axis)] ?? 0;
  }
  for (const [part, name] of Object.entries(PARTS)) {
    const row = document.createElement("div"); row.className = "pose-angle-row joint-angle-row";
    const label = document.createElement("span"); label.textContent = name; row.append(label);
    for (let axis = 0; axis < 3; axis++) {
      const input = document.createElement("input"); input.type = "number"; input.min = -180; input.max = 180; input.step = "any"; input.required = true; input.value = 0;
      input.dataset.posePart = part; input.dataset.axis = axis; input.setAttribute("aria-label", `${name} ${"XYZ"[axis]} 角度`);
      input.addEventListener("input", () => {
        if (!input.checkValidity()) return;
        pose[part] = [...(pose[part] || [0, 0, 0])]; pose[part][axis] = Number(input.value);
        $("#pose-preset").value = "custom"; changed();
      });
      input.addEventListener("change", () => input.reportValidity());
      row.append(input);
    }
    const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "旋转";
    edit.title = part === "body" ? "可视化旋转整个模型" : `可视化旋转${name}`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click",()=>window.dispatchEvent(new CustomEvent("edit-pose-joint",{detail:part})));
    row.append(edit);
    $("#pose-angles").append(row);
  }
  $("#pose-preset").addEventListener("change", () => {
    const preset = presets.find((p) => p.id === $("#pose-preset").value);
    if (preset) { pose = normalizedRotations(preset.rotations); showAngles(); changed(); }
  });

  /** 用资源包实际图片填充装备，类型可按工具／普通物品／弓独立调整。 */
  function showHand(hand) {
    const item = held[hand];
    const img = $(`#held-${hand}-image`); img.hidden = !item;
    if (item) { img.src = item.image; img.alt = item.name; }
    $(`#held-${hand}-name`).textContent = item?.name || "空手";
    $(`#held-${hand}-kind`).value = item?.kind || "tool";
    for (const group of ["offset", "rotation", "stretch"]) for (let axis=0;axis<3;axis++) {
      const input=$(`#held-${hand}-${group}-${axis}`);
      input.value=item?.[group]?.[axis] ?? (group==="stretch" ? 1 : 0); input.disabled=!item;
    }
    for (const field of ["scale", "thickness"]) {
      const input=$(`#held-${hand}-${field}`);
      input.value=item?.[field] ?? (field==="scale" ? 1 : 0); input.disabled=!item || (field==="thickness" && item.kind==="block");
    }
  }
  for (const hand of ["right", "left"]) {
    const box = document.createElement("div"); box.className = "held-control";
    const name = hand === "right" ? "右手" : "左手";
    box.innerHTML = `<strong>${name}</strong> <img id="held-${hand}-image" hidden alt="${name}物品"><span id="held-${hand}-name">空手</span>
      <select id="held-${hand}" aria-label="${name}物品"><option value="">空手</option></select>
      <select id="held-${hand}-kind" aria-label="${name}持握类型"><option value="tool">工具 / 剑</option><option value="flat">普通物品</option><option value="bow">弓</option><option value="block">立方体方块</option></select>
      <label class="import-index">导入${name} PNG<input id="held-${hand}-file" type="file" accept="image/png,.png" hidden></label>
      <button id="held-${hand}-edit">可视化修改${name}</button><button id="held-${hand}-clear">清空${name}</button>`;
    $("#held-controls").append(box);
    for (const [group,label,min,max] of [["offset","位移",-64,64],["rotation","旋转",-180,180],["stretch","轴缩放",.01,16]]) {
      const row=document.createElement("div");row.className="pose-angle-row";
      const title=document.createElement("span");title.textContent=label;row.append(title);
      for (let axis=0;axis<3;axis++) {
        const input=document.createElement("input"); input.type="number";input.id=`held-${hand}-${group}-${axis}`;
        const initial=group==="stretch" ? 1 : 0;
        input.min=min;input.max=max;input.step="any";input.required=true;input.value=initial;input.disabled=true;input.setAttribute("aria-label",`${name}${label} ${"XYZ"[axis]}`);
        input.addEventListener("input",()=>{if(!input.checkValidity() || !held[hand])return;held[hand][group]=[...(held[hand][group]||[initial,initial,initial])];held[hand][group][axis]=Number(input.value);changed();});
        input.addEventListener("change",()=>input.reportValidity());
        row.append(input);
      }
      box.append(row);
    }
    for (const [field,label,min,max,step,value] of [["scale","物品缩放",.1,4,.1,1],["thickness","厚度（皮肤像素）",0,8,.25,0]]) {
      const row=document.createElement("label");row.className="setting-row";row.textContent=label;
      const input=document.createElement("input");input.type="number";input.id=`held-${hand}-${field}`;
      input.min=min;input.max=max;input.step="any";input.required=true;input.value=value;input.disabled=true;
      input.addEventListener("input",()=>{if(!input.checkValidity() || !held[hand])return;held[hand][field]=Number(input.value);changed();});
      input.addEventListener("change",()=>input.reportValidity());row.append(input);box.append(row);
    }
    $(`#held-${hand}`).addEventListener("change", async (event) => {
      const token = ++itemRequests[hand];
      if (!event.target.value) { delete held[hand]; showHand(hand); changed(); return; }
      try {
        const params=new URLSearchParams({key:event.target.value}); if(host.palette())params.set("palette_id",host.palette().id);
        const item = await json(`/api/scene/item?${params}`);
        if (token !== itemRequests[hand]) return;
        held[hand] = { ...held[hand], name: (item.label || item.id)+(item.custom_renderer ? "（图标近似）" : ""), kind: item.kind, image: item.image, rotate_around:item.rotate_around || false, block_faces:item.block_faces || {} }; showHand(hand); changed();
      } catch (error) { $("#pose-status").textContent = error.message; }
    });
    $(`#held-${hand}-kind`).addEventListener("change", (event) => { if (held[hand]) { held[hand].kind = event.target.value; showHand(hand); changed(); } });
    $(`#held-${hand}-file`).addEventListener("change", async (event) => {
      const file = event.target.files[0]; event.target.value = "";
      if (!file) return;
      const token = ++itemRequests[hand];
      if (file.size > 2 * 1024 * 1024) { $("#pose-status").textContent = "物品 PNG 需小于 2 MB。"; return; }
      const image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      if (token !== itemRequests[hand]) return;
      held[hand] = { ...held[hand], name: file.name, kind: $(`#held-${hand}-kind`).value, image, block_faces:{}, rotate_around:false };
      $(`#held-${hand}`).value = ""; showHand(hand); changed();
    });
    $(`#held-${hand}-clear`).addEventListener("click", () => { itemRequests[hand]++; delete held[hand]; $(`#held-${hand}`).value = ""; showHand(hand); changed(); });
    $(`#held-${hand}-edit`).addEventListener("click",()=>window.dispatchEvent(new CustomEvent("edit-held-item",{detail:hand})));
  }

  /** 资源重载保留两手当前图片，已有工程不依赖再次读取实例。 */
  function showCatalog(data) {
    catalog = data.items;
    if (data.directory) $("#scene-instance").value = data.directory;
    for (const hand of ["right", "left"]) {
      const select = $(`#held-${hand}`);
      select.replaceChildren(new Option("空手", ""), ...catalog.map((item) => {const option=new Option(item.label || item.id, item.id);option.disabled=item.status==="unresolved";return option;}));
    }
    $("#scene-resource-status").textContent = data.directory ? `已读取 ${catalog.length} 个物品图标，${data.connected_textures} 个状态面有连接图。` : "请载入实例资源，或直接导入左右手 PNG。";
  }
  /** 运行时物品按本地化名称分页；旧索引继续使用实例加载的原版图标。 */
  async function refreshCatalog() {
    const token=++catalogSequence;
    if(!host.palette())return;
    const params=new URLSearchParams({search:$("#item-search").value.trim(),offset:catalogOffset,limit:200});
    const data=await json(`/api/palettes/${host.palette().id}/items?${params}`);
    if(token!==catalogSequence)return;
    catalogTotal=data.total;
    if(data.runtime) {
      showCatalog({items:data.items,directory:$("#scene-instance").value,connected_textures:0});
      $("#scene-resource-status").textContent=`运行时物品共 ${data.total.toLocaleString()} 项；当前显示 ${catalogOffset+1}～${Math.min(catalogOffset+200,data.total)}。名称和图标来自游戏索引。`;
    } else {
      const source=await json("/api/scene/resources");
      if(token!==catalogSequence)return;
      const needle=$("#item-search").value.trim().toLowerCase();
      const rows=source.items.filter(item=>(item.id+" "+item.label).toLowerCase().includes(needle));
      catalogTotal=rows.length;showCatalog({...source,items:rows.slice(catalogOffset,catalogOffset+200)});
    }
    $("#items-prev").disabled=catalogOffset===0;
    $("#items-next").disabled=catalogOffset+200>=catalogTotal;
  }
  window.addEventListener("palette-loaded",()=>{catalogOffset=0;void refreshCatalog().catch(e=>{$("#scene-resource-status").textContent=e.message;});});
  $("#item-search-form").addEventListener("submit",event=>{event.preventDefault();catalogOffset=0;void refreshCatalog().catch(e=>{$("#scene-resource-status").textContent=e.message;});});
  $("#items-prev").addEventListener("click",()=>{catalogOffset-=200;void refreshCatalog();});
  $("#items-next").addEventListener("click",()=>{catalogOffset+=200;void refreshCatalog();});
  $("#load-scene-resources").addEventListener("click", async () => {
    const button = $("#load-scene-resources"); button.disabled = true;
    try {
      const directory = $("#scene-instance").value.trim() || $("#instance-path").value.trim();
      if (!directory) throw new Error("请填写实例 .minecraft 路径。");
      $("#scene-resource-status").textContent = "正在只读加载物品与 CTM 资源…";
      showCatalog(await json("/api/scene/resources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ directory, vanilla_jar: $("#vanilla-jar").value.trim() || null }) }));
      await refreshCatalog();
      await host.resourcesChanged();
    } catch (error) { $("#scene-resource-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
  void json("/api/poses").then((data) => {
    presets = data.presets;
    const value = $("#pose-preset").value;
    $("#pose-preset").replaceChildren(...presets.map((p) => new Option(p.label, p.id)), new Option("自定义角度", "custom"));
    $("#pose-preset").value = value;
  }).catch((error) => { $("#pose-status").textContent = error.message; });
  void json("/api/scene/resources").then(data=>{showCatalog(data);if(host.palette())return refreshCatalog();}).catch((error) => { $("#scene-resource-status").textContent = error.message; });
  return {
    get busy() { return applying || applyTimer !== null; },
    get settings() { return structuredClone({ pose, held }); },
    apply,
    /** 三维手柄写回同一份设置，数值面板、工程和雕像生成共用。 */
    transformHeld(hand,values) {
      Object.assign(held[hand],values);
      showHand(hand);changed();
    },
    getHeld(hand) { return held[hand] ? structuredClone(held[hand]) : null; },
    /** 关节手柄和数字角度使用同一份静态姿势，保持生成与工程保存一致。 */
    rotateJoint(part,angles) {
      pose[part] = [...angles]; $("#pose-preset").value = "custom";
      showAngles(); changed();
    },
    getJoint(part) { return [...(pose[part] || [0,0,0])]; },
    /** 旧工程没有姿势字段时按站立空手恢复，新工程保留两手 PNG。 */
    async restore(options) {
      sequence++; itemRequests.left++; itemRequests.right++;
      pose = normalizedRotations(options.pose || {}); held = structuredClone(options.held || {});
      for (const item of Object.values(held)) if (item.rotation) item.rotation = normalizedRotations({ item: item.rotation }).item;
      $("#pose-preset").value = Object.keys(pose).length ? "custom" : "standing";
      showAngles(); for (const hand of ["right", "left"]) showHand(hand);
      await apply();
    },
  };
}
