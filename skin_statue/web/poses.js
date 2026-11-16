const $ = (s) => document.querySelector(s);
const ITEM_PAGE = 24;
const PARTS = { head: "头部", body: "躯干", right_arm: "右臂", left_arm: "左臂", right_leg: "右腿", left_leg: "左腿" };

/** 本地起步目录使用与运行时目录相同的空格 AND／!排除语法。 */
function matchesItem(item, query) {
  const names = `${item.id} ${item.label}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/u).filter(Boolean).every((word) => word.startsWith("!") && word.length > 1 ? !names.includes(word.slice(1)) : names.includes(word));
}

/** 预设和旧工程允许整圈角度，界面及接口统一使用 -180～180 度的等价值。 */
function normalizedRotations(rotations) {
  return Object.fromEntries(Object.entries(rotations).map(([part, angles]) => [part, angles.map((angle) => ((angle + 180) % 360 + 360) % 360 - 180)]));
}

/** 姿势与两手装备独立存储，工程恢复及生成读取相同设置。 */
export function initPoseControls(host) {
  let pose = {};
  let held = {};
  let cape = { library: [], selected: null, enabled: true, angle: 10 };
  let presets = [];
  let catalog = [];
  let selectedItem = null;
  let selectedKey = null;
  let selectionRequest = 0;
  const handDrafts = {};
  let catalogOffset = 0;
  let catalogTotal = 0;
  let catalogSequence = 0;
  let catalogTimer = null;
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
        body: JSON.stringify({ model: host.model(), pose, held, cape: {...cape, library: cape.library.filter((c) => c.id === cape.selected)}, alpha_threshold: Number($("#statue-alpha").value) }) });
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
  /** 手柄、数值面板和单关节重置都更新同一份姿势；其他部位和装备设置保持原值。 */
  function rotateJoint(part,angles) {
    if (part === "cape") { cape.angle = Math.min(120, Math.max(0, angles[2])); showCape(); changed(); return; }
    pose[part] = [...angles]; $("#pose-preset").value = "custom";
    showAngles(); changed();
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
    const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "重置";
    reset.title = `将${name}的 XYZ 角度重置为 0、0、0`;
    reset.setAttribute("aria-label", reset.title);
    reset.addEventListener("click",()=>rotateJoint(part,[0,0,0]));
    const actions = document.createElement("div"); actions.className = "joint-angle-actions";
    actions.append(edit,reset);row.append(actions);
    $("#pose-angles").append(row);
  }
  $("#pose-preset").addEventListener("change", () => {
    const preset = presets.find((p) => p.id === $("#pose-preset").value);
    if (preset) { pose = normalizedRotations(preset.rotations); showAngles(); changed(); }
  });

  /** 披风候选与当前佩戴分开，切换和单轴手柄共用一份状态。 */
  function showCape() {
    $("#cape-list").replaceChildren(new Option("不佩戴披风", ""), ...cape.library.map((c) => new Option(`${c.name} · ${c.id.slice(0, 8)}`, c.id)));
    $("#cape-list").value = cape.selected || "";
    $("#cape-angle").value = cape.angle;
    $("#cape-enabled").checked = cape.enabled;
    for (const id of ["cape-edit", "cape-reset", "cape-remove", "cape-angle"]) $(`#${id}`).disabled = !cape.selected;
  }
  function addCapes(rows) {
    const library = new Map(cape.library.map((c) => [c.id, c]));
    for (const row of rows) library.set(row.id, row);
    if (library.size > 32) throw new Error("一份工程最多保留 32 张披风，请先移除不需要的披风。");
    cape.library = [...library.values()]; cape.selected = rows.at(-1)?.id || null; cape.enabled = true;
    showCape(); changed();
    $("#cape-status").textContent = rows.length ? `已加入披风；当前有 ${library.size} 张，可在列表中切换。` : "该玩家的公开档案没有当前披风；可选择已收集披风或导入 PNG。";
  }
  $("#cape-list").addEventListener("change", () => { cape.selected = $("#cape-list").value || null; showCape(); changed(); });
  $("#cape-enabled").addEventListener("change", () => { cape.enabled = $("#cape-enabled").checked; changed(); });
  $("#cape-angle").addEventListener("input", () => { if (!$("#cape-angle").checkValidity()) return; cape.angle = Number($("#cape-angle").value); changed(); });
  $("#cape-reset").addEventListener("click", () => rotateJoint("cape", [0, 0, 0]));
  $("#cape-edit").addEventListener("click", () => { cape.enabled = true; showCape(); host.changed(); void apply().then(() => window.dispatchEvent(new CustomEvent("edit-pose-joint", { detail: "cape" }))); });
  $("#cape-remove").addEventListener("click", () => { cape.library = cape.library.filter((c) => c.id !== cape.selected); cape.selected = null; showCape(); changed(); });
  $("#cape-file").addEventListener("change", async (event) => {
    const files = [...event.target.files]; event.target.value = "";
    try {
      const rows = [];
      for (const file of files) { const form = new FormData(); form.append("file", file); rows.push(await json("/api/cape", { method: "POST", body: form })); }
      if (rows.length) addCapes(rows);
    } catch (error) { $("#cape-status").textContent = error.message; }
  });
  showCape();

  /** 用资源包实际图片填充装备，类型可按工具／普通物品／弓独立调整。 */
  function showHand(hand) {
    const item = held[hand];
    const img = $(`#held-${hand}-image`); img.hidden = !item;
    $(`#held-${hand}-enabled`).checked = !!item;
    $(`#held-${hand}-enabled`).disabled = !selectedItem && !item;
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
    box.innerHTML = `<div class="held-hand-heading"><label><input id="held-${hand}-enabled" type="checkbox" disabled> ${name}持物</label><button id="held-${hand}-clear" type="button">空手</button></div>
      <img id="held-${hand}-image" hidden alt="${name}物品"><span id="held-${hand}-name">空手</span>
      <select id="held-${hand}-kind" aria-label="${name}持握类型"><option value="tool">工具 / 剑</option><option value="flat">普通物品</option><option value="bow">弓</option><option value="block">立方体方块</option></select>
      <label class="import-index">导入${name} PNG<input id="held-${hand}-file" type="file" accept="image/png,.png" hidden></label>
      <button id="held-${hand}-edit">可视化修改${name}</button>`;
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
    $(`#held-${hand}-enabled`).addEventListener("change", () => {
      itemRequests[hand]++;
      if ($(`#held-${hand}-enabled`).checked) equipSelection(hand);
      else { handDrafts[hand] = held[hand]; delete held[hand]; }
      showHand(hand); changed();
    });
    $(`#held-${hand}-kind`).addEventListener("change", (event) => { if (held[hand]) { held[hand].kind = event.target.value; showHand(hand); changed(); } });
    $(`#held-${hand}-file`).addEventListener("change", async (event) => {
      const file = event.target.files[0]; event.target.value = "";
      if (!file) return;
      const token = ++itemRequests[hand];
      const selectionToken = ++selectionRequest;
      if (file.size > 2 * 1024 * 1024) { $("#pose-status").textContent = "物品 PNG 需小于 2 MB。"; return; }
      const image = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      if (token !== itemRequests[hand] || selectionToken !== selectionRequest) return;
      held[hand] = { ...held[hand], name: file.name, kind: $(`#held-${hand}-kind`).value, image, block_faces:{}, rotate_around:false };
      held[hand].source_id = null;
      selectedItem = { ...held[hand], label: held[hand].name }; selectedKey = null;
      for (const h of ["right", "left"]) showHand(h);
      renderItems(); changed();
    });
    $(`#held-${hand}-clear`).addEventListener("click", () => { itemRequests[hand]++; handDrafts[hand] = held[hand]; delete held[hand]; showHand(hand); changed(); });
    $(`#held-${hand}-edit`).addEventListener("click",()=>window.dispatchEvent(new CustomEvent("edit-held-item",{detail:hand})));
  }

  /** 当前选中物品只写入已勾选的手，左右手的编辑变换各自保留。 */
  function equipSelection(hand) {
    held[hand] = { ...(held[hand] || handDrafts[hand]), name: (selectedItem.label || selectedItem.name || selectedItem.id) + (selectedItem.custom_renderer ? "（静态图标）" : ""),
      kind: selectedItem.kind, image: selectedItem.image, rotate_around: selectedItem.rotate_around || false, block_faces: selectedItem.block_faces || {}, source_id: selectedItem.id || null };
  }
  /** 列表选择与搜索翻页独立；只让最近一次选择更新装备。 */
  async function selectItem(row) {
    const token = ++selectionRequest;
    try {
      const params = new URLSearchParams({ key: row.id });
      if (host.palette()) params.set("palette_id", host.palette().id);
      const item = await json(`/api/scene/item?${params}`);
      if (token !== selectionRequest) return;
      selectedItem = item; selectedKey = row.id;
      let equipped = false;
      for (const hand of ["right", "left"]) {
        if ($(`#held-${hand}-enabled`).checked) { equipSelection(hand); equipped = true; }
        showHand(hand);
      }
      renderItems(); if (equipped) changed();
    } catch (error) { if (token === selectionRequest) $("#scene-resource-status").textContent = error.message; }
  }
  /** 搜索结果为独立缩略图列表，不改写左右手候选或当前装备。 */
  function renderItems() {
    $("#selected-item-name").textContent = selectedItem ? `已选：${selectedItem.label || selectedItem.name}；勾选左右手即可装备。` : "先从列表选择物品，再勾选左右手。";
    $("#item-results").replaceChildren(...catalog.map((row) => {
      const button = document.createElement("button"); button.type = "button"; button.className = "item-result";
      button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(row.id === selectedKey));
      button.disabled = row.status === "unresolved"; button.classList.toggle("active", row.id === selectedKey);
      if (row.image) { const img = document.createElement("img"); img.src = row.image; img.alt = ""; img.loading = "lazy"; button.append(img); }
      const name = document.createElement("span"); name.textContent = row.label || row.id;
      const detail = document.createElement("small"); detail.textContent = row.status === "unresolved" ? "图标未捕获，请使用新版辅助模组重新导出" : row.variants > 1 ? `合并 ${row.variants} 个相同外观变体` : "点击选择";
      name.append(detail); button.append(name); button.addEventListener("click", () => void selectItem(row)); return button;
    }));
  }
  function showCatalog(data) {
    catalog = data.items;
    if (data.directory) $("#scene-instance").value = data.directory;
    renderItems();
    $("#scene-resource-status").textContent = data.directory ? `已读取 ${catalog.length} 个物品图标，${data.connected_textures} 个状态面有连接图。` : "请载入实例资源，或直接导入左右手 PNG。";
  }
  /** 运行时物品按本地化名称分页；旧索引继续使用实例加载的原版图标。 */
  async function refreshCatalog() {
    clearTimeout(catalogTimer);
    const token=++catalogSequence;
    if(!host.palette()) {
      const source = await json("/api/scene/resources");
      if (token !== catalogSequence) return;
      const rows = source.items.filter((item) => matchesItem(item, $("#item-search").value));
      catalogTotal = rows.length; showCatalog({...source, items: rows.slice(catalogOffset, catalogOffset + ITEM_PAGE)});
      $("#items-prev").disabled = catalogOffset === 0;
      $("#items-next").disabled = catalogOffset + ITEM_PAGE >= catalogTotal;
      $("#scene-resource-status").textContent = catalogTotal ? `共 ${catalogTotal} 项；当前 ${catalogOffset + 1}～${Math.min(catalogOffset + ITEM_PAGE, catalogTotal)}。搜索和翻页不会改变手持物。` : "没有匹配的物品，可修改搜索条件。";
      return;
    }
    const params=new URLSearchParams({search:$("#item-search").value.trim(),offset:catalogOffset,limit:ITEM_PAGE});
    const data=await json(`/api/palettes/${host.palette().id}/items?${params}`);
    if(token!==catalogSequence)return;
    catalogTotal=data.total;
    if(data.runtime) {
      showCatalog({items:data.items,directory:$("#scene-instance").value,connected_textures:0});
      $("#scene-resource-status").textContent=data.total ? `运行时物品共 ${data.total.toLocaleString()} 种外观；当前显示 ${catalogOffset+1}～${Math.min(catalogOffset+ITEM_PAGE,data.total)}。搜索和翻页不会改变手持物。` : "没有匹配的物品，可修改搜索条件。";
      if (data.loading.active) {
        $("#scene-resource-status").textContent = `正在分批读取 ${data.loading.processed.toLocaleString()} / ${data.loading.total.toLocaleString()} 个变体；当前查询已有 ${data.total} 种外观，可先选择使用。`;
        catalogTimer = setTimeout(() => { void refreshCatalog().catch(e => { $("#scene-resource-status").textContent = e.message; }); }, 500);
      } else if (data.loading.error) $("#scene-resource-status").textContent = `物品读取失败：${data.loading.error}；已加载的物品仍可使用。`;
    } else {
      const source=await json("/api/scene/resources");
      if(token!==catalogSequence)return;
      const rows=source.items.filter(item=>matchesItem(item, $("#item-search").value));
      catalogTotal=rows.length;showCatalog({...source,items:rows.slice(catalogOffset,catalogOffset+ITEM_PAGE)});
    }
    $("#items-prev").disabled=catalogOffset===0;
    $("#items-next").disabled=catalogOffset+ITEM_PAGE>=catalogTotal;
  }
  window.addEventListener("palette-loaded",()=>{catalogOffset=0;void refreshCatalog().catch(e=>{$("#scene-resource-status").textContent=e.message;});});
  $("#item-search-form").addEventListener("submit",event=>{event.preventDefault();catalogOffset=0;void refreshCatalog().catch(e=>{$("#scene-resource-status").textContent=e.message;});});
  $("#items-prev").addEventListener("click",()=>{catalogOffset=Math.max(0,catalogOffset-ITEM_PAGE);void refreshCatalog().catch(e=>{$("#scene-resource-status").textContent=e.message;});});
  $("#items-next").addEventListener("click",()=>{catalogOffset=Math.min(catalogOffset+ITEM_PAGE,Math.floor(Math.max(0,catalogTotal-1)/ITEM_PAGE)*ITEM_PAGE);void refreshCatalog().catch(e=>{$("#scene-resource-status").textContent=e.message;});});
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
  void refreshCatalog().catch((error) => { $("#scene-resource-status").textContent = error.message; });
  return {
    get busy() { return applying || applyTimer !== null; },
    get settings() { return structuredClone({ pose, held, cape }); },
    addCapes,
    apply,
    /** 三维手柄写回同一份设置，数值面板、工程和雕像生成共用。 */
    transformHeld(hand,values) {
      Object.assign(held[hand],values);
      showHand(hand);changed();
    },
    getHeld(hand) { return held[hand] ? structuredClone(held[hand]) : null; },
    rotateJoint,
    getJoint(part) { return part === "cape" ? [0, 0, cape.angle] : [...(pose[part] || [0,0,0])]; },
    /** 旧工程没有姿势字段时按站立空手恢复，新工程保留两手 PNG。 */
    async restore(options) {
      sequence++; itemRequests.left++; itemRequests.right++;
      selectionRequest++; selectedItem = null; selectedKey = null;
      pose = normalizedRotations(options.pose || {}); held = structuredClone(options.held || {});
      const restored = held.right || held.left;
      if (restored) { selectedItem = {...restored, label: restored.name}; selectedKey = restored.source_id || null; }
      for (const hand of ["right", "left"]) delete handDrafts[hand];
      renderItems();
      cape = structuredClone(options.cape || { library: [], selected: null, enabled: true, angle: 10 }); showCape();
      for (const item of Object.values(held)) if (item.rotation) item.rotation = normalizedRotations({ item: item.rotation }).item;
      $("#pose-preset").value = Object.keys(pose).length ? "custom" : "standing";
      showAngles(); for (const hand of ["right", "left"]) showHand(hand);
      await apply();
    },
  };
}
