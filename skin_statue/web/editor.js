import * as THREE from "three";

const $ = (selector) => document.querySelector(selector);
const PAGE = 12;

/** 点击拾取与固定分组编辑共享服务端真实体素；候选序列在一次选中期间保持稳定。 */
export function initEditor(host) {
  let selected = null;
  let choices = [];
  let page = 0;
  let searchPage = 0;
  let searchTotal = 0;
  let searchText = "";
  let busy = false;
  let sequence = 0; // 异步选择或查找只允许最近一次请求更新面板。
  let searchSequence = 0;
  let pointer = null;
  let history = [];
  let historyIndex = -1;
  const ray = new THREE.Raycaster();
  const highlight = new THREE.Box3Helper(new THREE.Box3(), 0x8bffd0);
  highlight.visible = false;
  highlight.material.depthTest = false;
  highlight.renderOrder = 10;
  host.scene.add(highlight);

  /** 保留 API 的具体失败原因。 */
  async function json(url, options) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "请求参数无效。");
    return result;
  }

  /** 修改期间锁住相互冲突的编辑、生成、导入和保存操作。 */
  function setBusy(value) {
    busy = value;
    for (const id of ["save-project", "save-draft", "generate-statue", "skin-file", "demo", "import-username", "project-file", "open-draft"]) {
      const input = $(`#${id}`);
      if (value) { input.dataset.previousDisabled = String(input.disabled); input.disabled = true; }
      else input.disabled = input.dataset.previousDisabled === "true";
    }
    for (const button of document.querySelectorAll("#block-editor button")) button.disabled = value;
    if (!value) { renderChoices(); updateHistory(); host.sync(); }
  }

  /** 显示本地化名称、注册名与实际数字 ID，不把猜测的翻译当游戏名称。 */
  function showSelection() {
    if (!selected) return;
    const e = selected.entry;
    $("#selection-info").textContent = `${e.display_name || "本地化名称需重新导出索引（辅助模组 0.1.2）"}\n${e.registry_name} · ID ${e.numeric_id}:${e.metadata}\n${e.building_label || "其他材料"}\n固定分组 ${selected.count.toLocaleString()} 块 · 原始材料 ${selected.origin}\n局部坐标 ${selected.position.join(", ")}`;
    $("#edit-tools").hidden = false;
    const data = host.state().data;
    const min = new THREE.Vector3(...selected.position.map((p, i) => (p + data.bounds[0][i]) / data.scale));
    highlight.box.set(min, min.clone().addScalar(1 / data.scale));
    highlight.visible = host.state().mode === "statue";
  }

  /** 每张卡片显示实际纹理和精确状态，点击即替换当前原始分组。 */
  function card(entry, cost) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-card";
    const active = selected?.entry.key === entry.key;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    const data = host.state().data;
    button.disabled = busy || data.options.excluded.includes(entry.key);
    const img = document.createElement("img");
    img.src = `/api/palettes/${data.palette_id}/textures/${entry.faces.south.texture_id}`;
    img.alt = "正面纹理";
    img.loading = "lazy";
    const label = document.createElement("span");
    label.textContent = entry.display_name || entry.registry_name;
    const detail = document.createElement("small");
    detail.textContent = `${entry.key} · ID ${entry.numeric_id}:${entry.metadata}${cost === undefined ? "" : ` · 分数 ${cost}`}${entry.connected_texture ? " · CTM" : ""} · ${entry.building_label || "其他材料"}`;
    label.append(detail);
    button.append(img, label);
    button.addEventListener("click", () => void apply(entry));
    return button;
  }

  /** 分批展示候选；上一个和下一个沿完整候选表移动，不局限当前页。 */
  function renderChoices() {
    const index = selected ? choices.findIndex((row) => row.entry.key === selected.entry.key) : -1;
    $("#candidate-list").replaceChildren(...choices.slice(page * PAGE, (page + 1) * PAGE).map((row) => card(row.entry, row.cost)));
    $("#candidate-index").textContent = index < 0 ? `共 ${choices.length} 个候选` : `候选 ${index + 1} / ${choices.length}`;
    $("#candidate-page").textContent = choices.length ? `第 ${page + 1} / ${Math.ceil(choices.length / PAGE)} 批` : "";
    $("#candidate-prev").disabled = busy || index <= 0;
    $("#candidate-next").disabled = busy || !choices.length || index === choices.length - 1;
    $("#candidate-page-prev").disabled = busy || page === 0;
    $("#candidate-page-next").disabled = busy || (page + 1) * PAGE >= choices.length;
    $("#replacement-prev").disabled = busy || searchPage === 0;
    $("#replacement-next").disabled = busy || (searchPage + 1) * PAGE >= searchTotal;
  }

  /** 恢复 20 份以内的快照历史；服务重启后的编辑以工程为起点。 */
  function updateHistory() {
    $("#edit-undo").disabled = busy || historyIndex <= 0;
    $("#edit-redo").disabled = busy || historyIndex >= history.length - 1;
  }

  /** 清除不同生成结果之间的拾取状态，防止把旧材料应用到新雕像。 */
  function clearSelection() {
    sequence++;
    searchSequence++;
    selected = null;
    choices = [];
    page = 0;
    searchPage = 0;
    searchTotal = 0;
    highlight.visible = false;
    $("#edit-tools").hidden = true;
    $("#selection-info").textContent = "单击雕像方块，查看名称、ID 和替换候选。";
    $("#replacement-list").replaceChildren();
    $("#edit-status").textContent = "";
  }

  /** 点击坐标先查询真实材料，再一次性取得原目标色的完整候选排序。 */
  async function select(position) {
    const token = ++sequence;
    searchSequence++;
    const data = host.state().data;
    $("#edit-tools").hidden = true;
    $("#edit-status").textContent = "正在读取方块与候选…";
    try {
      const params = new URLSearchParams({ x: position[0], y: position[1], z: position[2] });
      const result = await json(`/api/statue/${data.statue_id}/block?${params}`);
      if (token !== sequence) return;
      selected = result;
      showSelection();
      $("#edit-tools").hidden = true;
      // 排序完成前禁止使用上一组候选。
      choices = [];
      page = 0;
      renderChoices();
      $("#replacement-list").replaceChildren();
      searchPage = 0;
      searchTotal = 0;
      $("#replacement-page").textContent = "";
      const list = await json(`/api/statue/${data.statue_id}/candidates?${new URLSearchParams({ key: result.entry.key, group: result.group })}`);
      if (token !== sequence) return;
      choices = list.candidates;
      $("#edit-tools").hidden = false;
      const index = choices.findIndex((row) => row.entry.key === selected.entry.key);
      page = Math.floor(Math.max(0, index) / PAGE);
      renderChoices();
      $("#edit-status").textContent = "点击候选只替换该原始分组，其他同材质分组保持独立。";
    } catch (error) { if (token === sequence) $("#edit-status").textContent = error.message; }
  }

  /** 编辑后保留这次候选顺序，切换材料不会再次从新方块颜色开始匹配。 */
  async function apply(entry) {
    if (busy || host.state().busy || !selected || selected.entry.key === entry.key) return;
    sequence++;
    searchSequence++;
    setBusy(true);
    const data = host.state().data;
    $("#edit-status").textContent = `正在替换 ${selected.count.toLocaleString()} 个方块…`;
    try {
      const result = await json(`/api/statue/${data.statue_id}/replace`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: selected.entry.key, target: entry.key, group: selected.group }),
      });
      await host.display(result);
      history = history.slice(0, historyIndex + 1);
      history.push(result.statue_id);
      if (history.length > 20) history.shift();
      historyIndex = history.length - 1;
      selected.entry = entry;
      showSelection();
      const index = choices.findIndex((row) => row.entry.key === entry.key);
      if (index >= 0) page = Math.floor(index / PAGE);
      $("#edit-status").textContent = "已替换，结构导出和工程保存使用当前结果。";
      // 重新渲染指定方块列表上的当前状态标记。
      $("#replacement-list").replaceChildren();
    } catch (error) { $("#edit-status").textContent = error.message; }
    finally { setBusy(false); }
  }

  /** 指定方块搜索沿用安全候选筛选，并支持本地化名称、注册名和数字 ID。 */
  async function search() {
    if (!selected || busy) return;
    const token = ++searchSequence;
    const data = host.state().data;
    try {
      const params = new URLSearchParams({ search: searchText, eligible_only: true, include_connected: data.options.prefer_connected, offset: searchPage * PAGE, limit: PAGE });
      const result = await json(`/api/palettes/${data.palette_id}/entries?${params}`);
      if (token !== searchSequence) return;
      searchTotal = result.total;
      $("#replacement-list").replaceChildren(...result.entries.map((entry) => card(entry)));
      $("#replacement-page").textContent = `${result.total} 个结果 · ${searchPage + 1} / ${Math.max(1, Math.ceil(result.total / PAGE))} 页`;
      renderChoices();
    } catch (error) { if (token === searchSequence) $("#edit-status").textContent = error.message; }
  }

  /** 点击与拖动使用屏幕位移区分；在合并大面上仍按交点确定单个方块。 */
  host.canvas.addEventListener("pointerdown", (event) => {
    pointer = event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
  });
  host.canvas.addEventListener("pointercancel", () => { pointer = null; });
  host.canvas.addEventListener("pointerup", (event) => {
    const start = pointer;
    pointer = null;
    const state = host.state();
    if (!start || event.pointerId !== start.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5 || state.mode !== "statue" || busy || state.busy) return;
    const rect = host.canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), host.camera);
    const hit = ray.intersectObject(state.mesh, false)[0];
    if (!hit) { clearSelection(); return; }
    const point = state.mesh.worldToLocal(hit.point.clone()).addScaledVector(hit.face.normal, -0.001);
    const position = point.toArray().map((p, axis) => Math.floor(p) - state.data.bounds[0][axis]);
    void select(position);
  });
  $("#candidate-prev").addEventListener("click", () => {
    const i = choices.findIndex((r) => r.entry.key === selected.entry.key);
    if (i > 0) void apply(choices[i - 1].entry);
  });
  $("#candidate-next").addEventListener("click", () => {
    const i = choices.findIndex((r) => r.entry.key === selected.entry.key);
    if (i + 1 < choices.length) void apply(choices[i + 1].entry);
  });
  $("#candidate-page-prev").addEventListener("click", () => { page--; renderChoices(); });
  $("#candidate-page-next").addEventListener("click", () => { page++; renderChoices(); });
  $("#replacement-form").addEventListener("submit", (event) => {
    event.preventDefault(); searchText = $("#replacement-search").value.trim(); searchPage = 0; void search();
  });
  $("#replacement-prev").addEventListener("click", () => { searchPage--; void search(); });
  $("#replacement-next").addEventListener("click", () => { searchPage++; void search(); });

  /** 撤销／重做恢复已有体素快照，清除旧候选并允许重新选择。 */
  async function navigate(delta) {
    if (busy || host.state().busy) return;
    setBusy(true);
    try {
      const result = await json(`/api/statue/${history[historyIndex + delta]}/snapshot`);
      await host.display(result);
      historyIndex += delta;
      clearSelection();
    } catch (error) { host.notify(error.message, true); }
    finally { setBusy(false); }
  }
  $("#edit-undo").addEventListener("click", () => void navigate(-1));
  $("#edit-redo").addEventListener("click", () => void navigate(1));

  /** 保存草稿或下载工程时保留当前快照，不触发再次生成。 */
  async function save(draft) {
    if (busy || host.state().busy || !host.state().data) return;
    setBusy(true);
    const id = host.state().data.statue_id;
    $("#project-status").textContent = "正在保存体素、皮肤和候选纹理…";
    try {
      if (draft) {
        const result = await json(`/api/statue/${id}/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(host.workspace()) });
        await refreshDrafts(result.id);
        $("#project-status").textContent = `已保存本地草稿 ${result.id}。`;
      } else {
        const response = await fetch(`/api/statue/${id}/project`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(host.workspace()) });
        if (!response.ok) throw new Error((await response.json()).detail);
        host.download(URL.createObjectURL(await response.blob()), `statue-${id.slice(0, 8)}.skinproj`, true);
        $("#project-status").textContent = "工程文件已下载，包含当前编辑结果及继续替换所需纹理。";
      }
    } catch (error) { $("#project-status").textContent = error.message; }
    finally { setBusy(false); $("#open-draft").disabled = !$("#draft-list").options.length; }
  }

  /** 草稿名由服务端生成，列表显示独立保存的各个版本。 */
  async function refreshDrafts(id) {
    const result = await json("/api/drafts");
    $("#draft-list").replaceChildren(...result.drafts.map((draft) => new Option(draft.name, draft.id)));
    if (id) $("#draft-list").value = id;
    $("#open-draft").disabled = busy || !result.drafts.length;
  }

  /** 工程和草稿共用恢复逻辑，恢复后从该实际结果开始新的编辑历史。 */
  async function open(file) {
    if (busy || host.state().busy) return;
    setBusy(true);
    $("#project-status").textContent = "正在打开工程…";
    try {
      let payload;
      if (file) {
        const form = new FormData(); form.append("file", file);
        payload = await json("/api/projects/open", { method: "POST", body: form });
      } else payload = await json(`/api/drafts/${$("#draft-list").value}/open`, { method: "POST" });
      await host.restore(payload);
      $("#project-status").textContent = "已恢复工程，可以继续选择、替换和导出。";
    } catch (error) { $("#project-status").textContent = error.message; }
    finally {
      setBusy(false);
      $("#save-project").disabled = !host.state().data;
      $("#save-draft").disabled = !host.state().data;
      $("#open-draft").disabled = !$("#draft-list").options.length;
    }
  }
  $("#save-project").addEventListener("click", () => void save(false));
  $("#save-draft").addEventListener("click", () => void save(true));
  $("#open-draft").addEventListener("click", () => void open(null));
  $("#project-file").addEventListener("change", (event) => {
    const file = event.target.files[0]; event.target.value = ""; if (file) void open(file);
  });
  void refreshDrafts().catch((error) => { $("#project-status").textContent = error.message; });

  return {
    get busy() { return busy; },
    /** 新生成或恢复的工程建立自己的撤销起点。 */
    reset(data) {
      clearSelection();
      history = [data.statue_id]; historyIndex = 0; updateHistory();
      $("#save-project").disabled = busy;
      $("#save-draft").disabled = busy;
    },
    /** 编辑面板与雕像同屏；原皮肤模式恢复完整画布宽度。 */
    setVisible(value) {
      highlight.visible = value && selected !== null;
      $("#block-editor").hidden = !value;
      document.querySelector(".preview-stage").classList.toggle("editing", value);
    },
  };
}
