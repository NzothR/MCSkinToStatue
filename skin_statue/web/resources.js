const $ = (selector) => document.querySelector(selector);
const PAGE_SIZE = 24;
const FACE_NAMES = { east: "左", west: "右", up: "顶", down: "底", south: "前", north: "后" };
const REASONS = {
  unresolved: "解析未完成", unconfirmed_metadata: "Metadata 未获创造栏确认",
  non_opaque_cube: "非不透明完整方块", custom_renderer: "自定义渲染",
  tile_entity: "包含 TileEntity", tinted: "需要染色", emissive: "自发光",
  missing_faces: "六面纹理不完整", transparent_texture: "纹理含透明像素",
  animated: "动态纹理", air_or_fluid: "空气或流体", missing_texture: "纹理缺失",
  world_dependent_icon: "纹理依赖世界环境", world_dependent_color: "颜色依赖世界环境",
  connected_texture: "资源包连接纹理", server_pack_rules_unreviewed: "服务器资源包规则待确认",
  gravity_affected: "重力方块（不能悬空）",
};
let palette = null;
let offset = 0;
let total = 0;
let pageRequest = 0;
const excluded = new Set();

/** 读取 JSON API，保留服务返回的具体错误。 */
async function requestJSON(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "请求参数无效。");
  return payload;
}

/** 在资源面板显示进度，不影响已经通过验收的皮肤预览。 */
function report(message, error = false) {
  $("#resource-status").textContent = message;
  $("#resource-status").classList.toggle("error", error);
}

/** 阻止重复导入，直到本次扫描或索引解析结束。 */
function setBusy(value) {
  $("#scan-instance").disabled = value;
  $("#index-file").disabled = value;
  $("#load-local-index").disabled = value || !$("#local-index").options.length;
}

/** 展示数据来源与启用资源包顺序，帮助核对实际游戏外观。 */
export async function showPalette(payload) {
  palette = payload.palette;
  excluded.clear();
  offset = 0;
  $("#palette-search").value = "";
  $("#eligible-only").checked = true;
  $("#palette-browser").hidden = false;
  const summary = $("#resource-summary");
  summary.hidden = false;
  const packs = palette.resource_packs.length ? palette.resource_packs.join(" → ") : "未启用资源包";
  const lines = [
    `来源：${palette.source === "runtime_index" ? "游戏运行时索引" : "1.7.10 原版已知映射"} · 注册方块 ${palette.registry_count} · 状态 ${palette.states} · 纹理 ${palette.textures} · 静态候选 ${palette.eligible} · 连接纹理候选 ${palette.connected_eligible}`,
    `资源包顺序（后项优先）：${packs}`,
  ];
  if (payload.scan) {
    lines.push(`扫描 ${payload.scan.sources} 个资源来源、${payload.scan.textures} 张方块纹理；资源包覆盖 ${payload.scan.overridden_textures} 张；连接纹理规则 ${payload.scan.contextual_pack_rules} 条。`);
    if (!payload.scan.vanilla_jar) lines.push("尚未找到原版客户端 JAR；可展开原版 JAR 路径后重新扫描。");
    if (payload.scan.ambiguous_base_textures) lines.push(`基础资源有 ${payload.scan.ambiguous_base_textures} 个同名纹理冲突，涉及的候选需要运行时索引确认。`);
    if (payload.scan.errors.length) lines.push(`另有 ${payload.scan.errors.length} 个基础资源无法读取，详情已保留在报告中。`);
  }
  lines.push(`解析问题 ${palette.errors.length} 条；完整问题与排除原因随调色板 JSON 导出。`);
  summary.textContent = lines.join("\n");
  const link = $("#palette-export");
  link.href = `/api/palettes/${palette.id}/export`;
  link.hidden = false;
  $("#match-result").textContent = "";
  report(palette.source === "runtime_index" ? "运行时注册表与纹理已导入。" : "实例扫描完成，原版起步调色板已建立。模组注册表请导入游戏索引 ZIP。");
  window.dispatchEvent(new CustomEvent("palette-loaded", { detail: palette }));
  await loadPage();
}

/** 创建包含六面纹理和代表色的方块卡片。 */
function blockCard(entry) {
  const card = document.createElement("article");
  card.className = `block-card${entry.eligible || entry.connected_eligible ? "" : " excluded"}`;
  const title = document.createElement("div");
  title.className = "block-name";
  title.textContent = entry.display_name ? `${entry.display_name} · ${entry.registry_name}` : entry.registry_name;
  const meta = document.createElement("div");
  meta.className = "block-meta";
  meta.textContent = `ID ${entry.numeric_id} / Metadata ${entry.metadata} · ${entry.eligible ? "静态候选" : entry.connected_eligible ? "连接纹理候选" : "已排除"}`;
  const faces = document.createElement("div");
  faces.className = "block-faces";
  for (const [direction, name] of Object.entries(FACE_NAMES)) {
    const data = entry.faces[direction];
    if (!data) continue;
    const face = document.createElement("div");
    face.className = "block-face";
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = `${entry.registry_name} ${name}面`;
    image.src = `/api/palettes/${palette.id}/textures/${data.texture_id}`;
    const label = document.createElement("span");
    label.textContent = name;
    const swatch = document.createElement("span");
    swatch.className = "block-color";
    swatch.style.background = `rgb(${data.rgb.join(",")})`;
    face.title = `${data.icon_name}\nRGB ${data.rgb.join(", ")}\n纹理方差 ${data.variance}\n来源 ${data.provider ?? data.pixel_source ?? "运行时索引"}`;
    face.append(image, swatch, label);
    faces.append(face);
  }
  card.append(title, meta, faces);
  if (entry.eligible || entry.connected_eligible) {
    const label = document.createElement("label");
    label.className = "block-enabled";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = !excluded.has(entry.key);
    enabled.addEventListener("change", () => {
      if (enabled.checked) excluded.delete(entry.key); else excluded.add(entry.key);
      window.dispatchEvent(new CustomEvent("palette-exclusions", { detail: [...excluded] }));
    });
    label.append(enabled, entry.connected_eligible ? "连接纹理优先开启时允许使用" : "允许用于雕像");
    card.append(label);
  }
  if (entry.exclusions.length) {
    const issues = document.createElement("div");
    issues.className = "block-exclusions";
    issues.textContent = entry.exclusions.map((reason) => REASONS[reason] ?? reason).join(" · ");
    if (entry.error) issues.title = entry.error;
    card.append(issues);
  }
  return card;
}

/** 分页请求并丢弃旧查询，避免搜索结果被较慢的请求覆盖。 */
async function loadPage() {
  if (!palette) return;
  const id = ++pageRequest;
  const query = new URLSearchParams({ search: $("#palette-search").value, eligible_only: $("#eligible-only").checked, include_connected: $("#statue-connected").checked, offset, limit: PAGE_SIZE });
  try {
    const result = await requestJSON(`/api/palettes/${palette.id}/entries?${query}`);
    if (id !== pageRequest) return;
    total = result.total;
    $("#palette-list").replaceChildren(...result.entries.map(blockCard));
    if (!result.entries.length) $("#palette-list").textContent = "没有符合筛选条件的方块。可关闭“仅静态候选”查看排除原因。";
    $("#palette-count").textContent = `${total} 个状态`;
    $("#palette-page").textContent = `${total ? Math.floor(offset / PAGE_SIZE) + 1 : 0} / ${Math.ceil(total / PAGE_SIZE)}`;
    $("#palette-prev").disabled = offset === 0;
    $("#palette-next").disabled = offset + PAGE_SIZE >= total;
  } catch (error) {
    if (id === pageRequest) report(error.message, true);
  }
}

/** 绑定实例扫描、索引上传、调色板查询及单色匹配。 */
export function initResourcePanel() {
  window.addEventListener("project-palette-settings", (event) => {
    excluded.clear();
    for (const key of event.detail.excluded) excluded.add(key);
    offset = 0;
    void loadPage();
  });
  window.addEventListener("connected-preference", () => { offset = 0; void loadPage(); });
  requestJSON("/api/resources/loaded").then((result) => {
    if (result.palettes.length === 1 && !palette) return showPalette({ palette: result.palettes[0] });
  }).catch((error) => report(error.message, true));
  requestJSON("/api/resources/local").then((result) => {
    const select = $("#local-index");
    for (const file of result.files) {
      const option = document.createElement("option");
      option.value = file.name;
      option.textContent = file.name;
      select.append(option);
    }
    $("#load-local-index").disabled = !result.files.length;
  }).catch((error) => report(error.message, true));
  $("#load-local-index").addEventListener("click", async () => {
    setBusy(true);
    report("正在读取项目目录中的 GTNH 索引并建立调色板…");
    try { await showPalette(await requestJSON(`/api/resources/local/${encodeURIComponent($("#local-index").value)}`, { method: "POST" })); }
    catch (error) { report(error.message, true); }
    finally { setBusy(false); }
  });
  $("#scan-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(true);
    report("正在只读扫描实例和资源包，并计算原版候选颜色…");
    try {
      const payload = await requestJSON("/api/resources/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ directory: $("#instance-path").value.trim(), vanilla_jar: $("#vanilla-jar").value.trim() || null }) });
      await showPalette(payload);
    } catch (error) { report(error.message, true); }
    finally { setBusy(false); }
  });
  $("#index-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    setBusy(true);
    report("正在读取运行时方块注册表和逐面纹理，计算颜色…");
    try {
      const body = new FormData();
      body.append("file", file);
      await showPalette(await requestJSON("/api/resources/index", { method: "POST", body }));
    } catch (error) { report(error.message, true); }
    finally { event.target.value = ""; setBusy(false); }
  });
  let searchTimer;
  $("#palette-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { offset = 0; void loadPage(); }, 180);
  });
  $("#eligible-only").addEventListener("change", () => { offset = 0; void loadPage(); });
  $("#palette-prev").addEventListener("click", () => { offset = Math.max(0, offset - PAGE_SIZE); void loadPage(); });
  $("#palette-next").addEventListener("click", () => { if (offset + PAGE_SIZE < total) { offset += PAGE_SIZE; void loadPage(); } });
  $("#match-color-button").addEventListener("click", async () => {
    if (!palette) return;
    const rgb = $("#match-color").value.match(/[a-f\d]{2}/gi).map((value) => parseInt(value, 16));
    try {
      const result = await requestJSON(`/api/palettes/${palette.id}/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rgb, face: $("#match-face").value, excluded: [...excluded], prefer_connected: $("#statue-connected").checked }) });
      $("#match-result").textContent = `${result.key} · 匹配代价 ${result.cost}`;
    } catch (error) { $("#match-result").textContent = error.message; }
  });
}
