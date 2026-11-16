import * as THREE from "three";

const $ = (s) => document.querySelector(s);

/** 人物保留独立编辑文档与 GPU 对象；切换编辑对象不会销毁其他人物。 */
export function initSceneEditor(host) {
  let actors = [], activeId = null, busy = false;
  const ray = new THREE.Raycaster();
  let down = null;
  const mode = () => $("#generation-mode").value;
  const active = () => actors.find((a) => a.id === activeId);

  function controls() {
    const locked = busy || host.busy();
    $("#generation-mode").disabled = locked;
    $("#skin-file").multiple = mode() === "full";
    for (const input of document.querySelectorAll("[data-scene-transform], #scene-name")) input.disabled = locked;
    $("#scene-actor").replaceChildren(...actors.map((a) => new Option(a.name, a.id)));
    $("#scene-actor").value = activeId || "";
    $("#scene-actor").disabled = locked || mode() === "head";
    $("#scene-duplicate").disabled = locked || mode() === "head" || actors.length >= 32;
    $("#scene-move").disabled = locked || mode() === "head";
    $("#scene-remove").disabled = locked || mode() === "head" || actors.length < 2;
    const actor = active();
    $("#scene-duplicate").disabled ||= !actor;
    if (actor) {
      $("#scene-name").value = actor.name;
      const settings = host.read().options;
      for (let i = 0; i < 3; i++) $(`#scene-position-${i}`).value = settings.placement?.[i] || 0;
      $("#scene-size").value = settings.scale_factor ?? 1;
    }
    for (const option of $("#statue-scale").options) option.textContent = `${Number(option.value) * (mode() === "head" ? 8 : 32)} 格 · ${option.value} 倍`;
  }

  function remember() {
    const value = host.read();
    if (!value.skin) return;
    if (!activeId) {
      activeId = crypto.randomUUID();
      actors.push({ id: activeId, name: value.file.name.replace(/\.png$/i, "").slice(0,80) });
    }
    Object.assign(active(), value);
    tagActive(); controls();
  }

  function tagActive() {
    const value = host.read();
    for (const group of [value.render.player, value.render.heldGroup]) if (group) for (const mesh of group.children) mesh.userData.actorId = activeId;
  }

  /** 所有场景写操作串行执行，先提交当前人物的最新姿势再保存其网格。 */
  async function run(action, force = false) {
    if (busy || (!force && host.busy())) { controls(); return; }
    busy = true;
    document.querySelector(".sidebar").inert = true;
    $("#scene-status").textContent = "正在更新人物场景…";
    host.sync();
    try {
      await host.flush(); remember(); host.clearGizmo();
      await action(); remember(); host.visibility();
      $("#scene-status").textContent = mode() === "head" ? "头颅模式：只显示并生成当前人物的头部。" : `场景共 ${actors.length} 人；左侧只编辑当前人物，也可点击其他人物切换。`;
    } catch (error) { if (force) throw error; host.notify(error.message, true); }
    finally { busy = false; document.querySelector(".sidebar").inert = false; controls(); host.sync(); }
  }

  async function activate(actor) {
    const previous = active();
    host.detach(); activeId = actor.id;
    try { await host.activate(actor); }
    catch (error) {
      host.dispose(host.read().render); host.detach();
      actors = actors.filter((a) => a.id !== actor.id);
      activeId = previous && previous.id !== actor.id ? previous.id : null;
      if (activeId) await host.activate(previous);
      throw error;
    }
    host.changed();
  }
  const nextPosition = () => [Math.max(...actors.map((a) => a.options?.placement?.[0] || 0), 0) + 20, 0, 0];

  $("#scene-actor").addEventListener("change", (event) => { const actor = actors.find((a) => a.id === event.target.value); void run(() => activate(actor)); });
  $("#scene-duplicate").addEventListener("click", () => void run(async () => {
    const original = active();
    const actor = { id: crypto.randomUUID(), name: original.name.slice(0,77) + " 副本", file: original.file, skin: original.skin, layers: [...original.layers], options: { ...structuredClone(original.options), placement: nextPosition() } };
    actors.push(actor); await activate(actor);
  }));
  /** 本地、拖放和用户名共用入口：完整模式新增人物，头颅模式替换当前人物。 */
  async function importSources(load) {
    await run(async () => {
      const sources = await load();
      if (mode() === "head") {
        if (sources.length !== 1) throw new Error("头颅模式一次只能导入一个皮肤。");
        await host.replace(sources[0]); remember();
        active().name = sources[0].file.name.replace(/\.png$/i, "").slice(0,80);
      } else {
        if (sources.length + actors.length > 32) throw new Error("一个场景最多放置 32 个人物。");
        for (const source of sources) {
          remember();
          const actor = {id:crypto.randomUUID(),name:source.file.name.replace(/\.png$/i, "").slice(0,80),file:source.file,model:source.model,layers:null,
            options:{pose:{},held:{},placement:actors.length ? nextPosition() : [0,0,0],scale_factor:1,
              cape:{library:source.capes || [],selected:source.capes?.at(-1)?.id || null,enabled:true,angle:10}}};
          actors.push(actor); await activate(actor); remember();
        }
      }
      host.frame();
    });
  }
  $("#scene-remove").addEventListener("click", () => void run(async () => {
    const removed = active(); host.detach();
    actors = actors.filter((a) => a.id !== activeId); host.dispose(removed.render);
    await activate(actors[0]);
  }));
  $("#scene-move").addEventListener("click",()=>window.dispatchEvent(new Event("move-scene-actor")));
  $("#scene-name").addEventListener("change", () => { if (active()) { active().name = $("#scene-name").value.trim() || "人物"; controls(); host.changed(); } });
  for (const input of document.querySelectorAll("[data-scene-transform]")) input.addEventListener("change", () => {
    if (![...document.querySelectorAll("[data-scene-transform]")].every((n) => n.reportValidity())) return;
    host.transform({ placement: [0, 1, 2].map((i) => Number($(`#scene-position-${i}`).value)), scale_factor: Number($("#scene-size").value) });
  });
  $("#generation-mode").addEventListener("change", () => void run(async () => { await host.modeChanged(); host.changed(); }));

  function reset() {
    remember(); host.detach();
    for (const actor of actors) host.dispose(actor.render);
    actors = []; activeId = null; $("#generation-mode").value = "full"; controls();
  }
  function visible() {
    for (const actor of actors) if (actor.id !== activeId && actor.render) {
      const show = host.mode() === "skin" && mode() === "full";
      actor.render.player.visible = show;
      if (actor.render.heldGroup) actor.render.heldGroup.visible = show;
      for (const group of [actor.render.player, actor.render.heldGroup]) if (group) for (const mesh of group.children) mesh.material = host.flat() ? mesh.userData.flat : mesh.userData.standard;
    }
  }
  function meshes() {
    const result = [];
    for (const actor of actors) {
      const render = actor.id === activeId ? host.read().render : actor.render;
      if (render) for (const group of [render.player, render.heldGroup]) if (group?.visible) result.push(...group.children.filter((m) => m.visible));
    }
    return result;
  }
  host.canvas.addEventListener("pointerdown", (e) => { down = e.button === 0 ? {x:e.clientX,y:e.clientY} : null; });
  host.canvas.addEventListener("pointercancel", () => { down = null; });
  host.canvas.addEventListener("pointerup", (e) => {
    const start = down; down = null;
    if (!start || e.statueTransformHandled || busy || host.mode() !== "skin" || mode() === "head" || Math.hypot(e.clientX-start.x,e.clientY-start.y)>5 || host.dragging()) return;
    const rect = host.canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1, -(e.clientY-rect.top)/rect.height*2+1), host.camera);
    const hit = ray.intersectObjects(meshes(), false)[0];
    const actor = actors.find((a) => a.id === hit?.object.userData.actorId);
    if (actor && actor.id !== activeId) void run(() => activate(actor));
  });

  return {
    get busy() { return busy; }, get headOnly() { return mode() === "head"; },
    remember, tagActive, visible, meshes, reset, sync: controls, importSources,
    async changeModel() { await run(() => host.rebuildModel()); },
    document() {
      remember();
      return {mode: mode(), active_id: activeId, actors: actors.filter((a) => mode() === "full" || a.id === activeId).map((a) => ({id:a.id,name:a.name,image:a.skin.images.normalized,model:a.skin.model,layers:a.layers,...structuredClone(a.options)}))};
    },
    async restore(doc) {
      await run(async () => {
        reset(); $("#generation-mode").value = doc.mode;
        actors = doc.actors.map((a) => ({id:a.id,name:a.name,image:a.image,model:a.model,layers:a.layers,options:{pose:a.pose,held:a.held,cape:a.cape,placement:a.placement,scale_factor:a.scale_factor}}));
        for (const actor of actors) { await activate(actor); remember(); }
        const chosen = actors.find((a) => a.id === doc.active_id);
        if (chosen.id !== activeId) await activate(chosen);
        await host.modeChanged();
      }, true);
    },
  };
}
