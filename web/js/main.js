const App = {
  user: null,
  doc: null,
  mapId: null,
  shareToken: null,
  selection: null,
  tool: "wall",
  playerMode: false,
  dirty: false,
  assets: [],
  folders: [],
  tags: [],
  tagIds: [],
  folderId: null,
  previewDoc: null,
  syncing: false,
  saving: false,
  painting: false,
  drag: null,
  libraryFolder: "all",
  libraryTag: null,
  galleryMapId: null,
  notes: [],
  selectedAssetId: null,
  wallVariant: 0,
  floorVariant: 0,
  objectVariant: {},
};

const PREMIUM = new Set(["chest", "enemy", "trap", "water", "lava", "anvil", "decor", "select", "text", "sprite"]);
const TOOL_NAME = {
  wall: "стена", floor: "пол", door: "дверь", empty: "ластик",
  chest: "сундук", enemy: "противник", trap: "ловушка", water: "вода", lava: "лава",
  anvil: "наковальня", decor: "декор", select: "выбор", text: "метка", sprite: "спрайт",
};

function tileForTool(tool) {
  if (tool === "wall") return 100 + (App.wallVariant || 0);
  if (tool === "floor") return 200 + (App.floorVariant || 0);
  if (tool === "door") return 3;
  return 0;
}

function toolCaption(tool) {
  if (tool === "wall") return `стена · ${IO.MATERIALS.walls[App.wallVariant || 0].name}`;
  if (tool === "floor") return `пол · ${IO.MATERIALS.floors[App.floorVariant || 0].name}`;
  if (IO.OBJECTS[tool]) return `${IO.OBJECTS[tool].name} · ${(App.objectVariant[tool] || 0) + 1}`;
  return TOOL_NAME[tool] || tool;
}

function cellFromEvent(event) {
  const canvas = document.getElementById("map");
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) * (canvas.width / rect.width)) / 16;
  const y = ((event.clientY - rect.top) * (canvas.height / rect.height)) / 16;
  return {
    x: Math.max(0, Math.min(App.doc.cols - 1, Math.floor(x))),
    y: Math.max(0, Math.min(App.doc.rows - 1, Math.floor(y))),
  };
}

function paintLine(x0, y0, x1, y1, tile) {
  const layer = currentTileLayer();
  if (!layer) return;
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x0 >= 0 && y0 >= 0 && x0 < App.doc.cols && y0 < App.doc.rows) layer.tiles[y0 * App.doc.cols + x0] = tile;
    if (x0 === x1 && y0 === y1) break;
    const doubled = 2 * err;
    if (doubled > -dy) { err -= dy; x0 += sx; }
    if (doubled < dx) { err += dx; y0 += sy; }
  }
}

function currentTileLayer() {
  if (!App.user) return App.doc.layers.find((layer) => layer.kind === "tiles" && !layer.locked) || null;
  const active = App.doc.layers.find((layer) => layer.id === App.doc.activeLayerId);
  if (!active || active.kind !== "tiles" || active.locked) return null;
  return active;
}

function layerByKind(kind) {
  const active = App.doc.layers.find((layer) => layer.id === App.doc.activeLayerId);
  if (active && active.kind === kind) return active;
  return App.doc.layers.find((layer) => layer.kind === kind) || null;
}

const Editor = {
  markDirty() {
    App.dirty = true;
    this.syncStatus();
  },
  markClean() {
    App.dirty = false;
    this.syncStatus();
  },
  syncStatus() {
    const layer = App.doc.layers.find((item) => item.id === App.doc.activeLayerId);
    document.getElementById("st-tool").textContent = toolCaption(App.tool);
    document.getElementById("st-layer").textContent = layer ? layer.name : "—";
    document.getElementById("st-dirty").textContent = App.dirty ? "есть несохранённые изменения" : (App.mapId ? "сохранено" : "новая карта");
  },
  syncHistory() {
    const undo = document.getElementById("btn-undo");
    const redo = document.getElementById("btn-redo");
    if (!undo || !App.doc) return;
    undo.disabled = !!App.user && !App.doc.history.undo.length;
    redo.disabled = !!App.user && !App.doc.history.redo.length;
  },
  draw() {
    IO.drawMap(document.getElementById("map"), App.doc, {
      editor: true,
      player: App.playerMode,
      selection: App.selection,
      redraw: () => Editor.draw(),
    });
  },
  setTool(tool, keepVariant) {
    if (PREMIUM.has(tool) && !App.user) {
      UI.openAuth("Этот инструмент доступен после входа");
      return;
    }
    if (!keepVariant && tool === App.tool) {
      if (tool === "wall") App.wallVariant = (App.wallVariant + 1) % IO.MATERIALS.walls.length;
      else if (tool === "floor") App.floorVariant = (App.floorVariant + 1) % IO.MATERIALS.floors.length;
      else if (IO.OBJECTS[tool]) {
        App.objectVariant[tool] = ((App.objectVariant[tool] || 0) + 1) % IO.OBJECTS[tool].variants.length;
      }
    }
    App.tool = tool;
    document.querySelectorAll("[data-tool]").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
    document.getElementById("map").style.cursor = tool === "select" ? "move" : tool === "text" ? "text" : "crosshair";
    renderPalette();
    this.syncStatus();
  },
  resetDocument() {
    IO.disarm();
    App.mapId = null;
    App.shareToken = null;
    App.selection = null;
    App.previewDoc = null;
    App.playerMode = false;
    App.folderId = null;
    App.tagIds = [];
    App.doc = IO.newDocument();
    document.getElementById("map-name").value = "Новая карта";
    document.getElementById("map-public").checked = false;
    document.getElementById("player-banner").hidden = true;
    document.getElementById("btn-player").classList.remove("active");
    this.markClean();
    UI.renderLayers();
    UI.syncGrid();
    UI.renderTaxonomy();
    UI.showInspector();
    this.setTool("wall");
    this.syncHistory();
    this.draw();
  },
  newMap() {
    if (App.dirty && !confirm("Есть несохранённые изменения. Начать новую карту?")) return;
    this.resetDocument();
    history.replaceState(null, "", "/#editor");
    activate("editor");
  },
  async openMap(id) {
    IO.disarm();
    await UI.ensureTaxonomy();
    const data = await API.map(id);
    App.mapId = data.id;
    App.shareToken = data.share_token;
    App.doc = IO.normalize(data.data);
    IO.remember(App.doc);
    App.selection = null;
    App.playerMode = false;
    App.folderId = data.folder_id;
    App.tagIds = (data.tags || []).map((tag) => tag.id);
    document.getElementById("map-name").value = data.name;
    document.getElementById("map-public").checked = !!data.is_public;
    document.getElementById("player-banner").hidden = true;
    document.getElementById("btn-player").classList.remove("active");
    this.markClean();
    UI.renderLayers();
    UI.syncGrid();
    UI.renderTaxonomy();
    UI.showInspector();
    this.syncHistory();
    this.draw();
    activate("editor");
    history.replaceState(null, "", `/?map=${data.id}#editor`);
  },
  payload() {
    return {
      name: document.getElementById("map-name").value,
      folder_id: App.folderId,
      tag_ids: App.tagIds,
      is_public: document.getElementById("map-public").checked,
      preview: IO.makePreview(App.doc),
      data: App.doc,
    };
  },
  async save() {
    if (!App.user) {
      UI.openAuth("Сохранение в облако доступно после входа");
      throw new Error("Требуется авторизация");
    }
    if (App.saving) return null;
    App.saving = true;
    try {
      IO.commit(App.doc);
      await IO.preload(App.doc);
      const payload = this.payload();
      const saved = App.mapId ? await API.updateMap(App.mapId, payload) : await API.createMap(payload);
      App.mapId = saved.id;
      App.shareToken = saved.share_token;
      this.markClean();
      this.syncHistory();
      UI.toast("Карта сохранена");
      if (document.getElementById("view-library").classList.contains("active")) await UI.loadLibrary();
      history.replaceState(null, "", `/?map=${saved.id}#editor`);
      return saved;
    } finally {
      App.saving = false;
    }
  },
  async duplicate() {
    if (!App.user) { UI.openAuth("Дублирование доступно после входа"); return; }
    if (!App.mapId || App.dirty) await this.save();
    const copy = await API.duplicate(App.mapId);
    UI.toast(`Создана «${copy.name}»`);
    await this.openMap(copy.id);
  },
  undo() {
    if (!App.user) { UI.openAuth("Отмена действий доступна после входа"); return; }
    if (!IO.undo(App.doc)) return;
    App.selection = null;
    this.markDirty();
    UI.renderLayers();
    UI.syncGrid();
    UI.showInspector();
    this.syncHistory();
    this.draw();
  },
  redo() {
    if (!App.user) { UI.openAuth("Повтор действий доступен после входа"); return; }
    if (!IO.redo(App.doc)) return;
    App.selection = null;
    this.markDirty();
    UI.renderLayers();
    UI.syncGrid();
    UI.showInspector();
    this.syncHistory();
    this.draw();
  },
  togglePlayer() {
    if (!App.user) { UI.openAuth("Режим игрока доступен после входа"); return; }
    App.playerMode = !App.playerMode;
    document.getElementById("player-banner").hidden = !App.playerMode;
    document.getElementById("btn-player").classList.toggle("active", App.playerMode);
    if (App.playerMode) { App.selection = null; UI.showInspector(); }
    this.draw();
  },
  toggleLayer(id, field) {
    const layer = App.doc.layers.find((item) => item.id === id);
    if (!layer) return;
    IO.arm(App.doc);
    layer[field] = !layer[field];
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.renderLayers();
    this.draw();
  },
  moveLayer(index, dir) {
    const next = index + dir;
    if (next < 0 || next >= App.doc.layers.length) return;
    IO.arm(App.doc);
    const [layer] = App.doc.layers.splice(index, 1);
    App.doc.layers.splice(next, 0, layer);
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.renderLayers();
    this.draw();
  },
  deleteLayer(id) {
    const tiles = App.doc.layers.filter((layer) => layer.kind === "tiles");
    const layer = App.doc.layers.find((item) => item.id === id);
    if (layer && layer.kind === "tiles" && tiles.length === 1) {
      UI.toast("Нельзя удалить единственный слой тайлов", "error");
      return;
    }
    IO.arm(App.doc);
    App.doc.layers = App.doc.layers.filter((item) => item.id !== id);
    if (App.doc.activeLayerId === id) App.doc.activeLayerId = App.doc.layers[0].id;
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.renderLayers();
    this.draw();
  },
  addLayer() {
    if (!App.user) { UI.openAuth("Слои доступны после входа"); return; }
    const kind = document.getElementById("layer-kind").value;
    const names = { tiles: "Новый слой тайлов", objects: "Объекты", notes: "Заметки" };
    IO.arm(App.doc);
    const layer = { id: IO.uid(), name: names[kind] || "Слой", kind, visible: true, locked: false };
    if (kind === "tiles") layer.tiles = Array(App.doc.cols * App.doc.rows).fill(0);
    else layer.items = [];
    App.doc.layers.push(layer);
    App.doc.activeLayerId = layer.id;
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.renderLayers();
    this.draw();
  },
  deleteSelection() {
    const found = IO.findItem(App.doc, App.selection);
    if (!found) return;
    IO.arm(App.doc);
    found.layer.items = found.layer.items.filter((item) => item.id !== App.selection);
    App.selection = null;
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.showInspector();
    this.draw();
  },
  placeLabel(x, y) {
    const layer = layerByKind("notes");
    if (!layer) { UI.toast("Добавьте слой заметок", "error"); return; }
    layer.visible = true;
    IO.arm(App.doc);
    const item = {
      id: IO.uid(), kind: "label", x, y, w: 8, h: 2, text: "Метка",
      description: "", color: "#f3e6c0",
    };
    layer.items.push(item);
    App.doc.activeLayerId = layer.id;
    App.selection = item.id;
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.renderLayers();
    UI.showInspector();
    this.draw();
    document.getElementById("prop-text").focus();
  },
  async placeAsset(asset, x, y) {
    const layer = layerByKind("objects");
    if (!layer) { UI.toast("Добавьте слой объектов", "error"); return; }
    const src = await assetSource(asset);
    IO.arm(App.doc);
    const item = {
      id: IO.uid(), kind: "sprite", x, y, w: 3, h: 3, assetId: asset.id,
      src, name: asset.name, text: "", description: "",
    };
    layer.items.push(item);
    IO.remember(App.doc);
    App.doc.activeLayerId = layer.id;
    App.selection = item.id;
    IO.commit(App.doc);
    this.markDirty();
    this.syncHistory();
    UI.renderLayers();
    UI.showInspector();
    this.draw();
  },
  async uploadAsset(file) {
    if (!App.user) { UI.openAuth("Загрузка текстур и спрайтов доступна после входа"); return; }
    if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("Допустимы только PNG и JPG");
    if (file.size > 1.5 * 1024 * 1024) throw new Error("Файл больше допустимого размера");
    const data = await API.uploadAsset(file);
    data.asset.src = await blobToData(file);
    App.assets.unshift(data.asset);
    App.selectedAssetId = data.asset.id;
    UI.renderAssets();
    this.setTool("sprite");
    UI.toast("Файл добавлен в палитру");
  },
  async logout() {
    await API.logout();
    App.user = null;
    App.mapId = null;
    App.shareToken = null;
    App.assets = [];
    UI.renderAuth();
    UI.renderAssets();
    UI.renderTaxonomy();
    activate("editor");
    UI.toast("Вы вышли");
  },
};

function blobToData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(blob);
  });
}

async function assetSource(asset) {
  if (asset.src) return asset.src;
  const response = await fetch(`/api/assets/${asset.id}/file`, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Не удалось прочитать файл");
  asset.src = await blobToData(await response.blob());
  return asset.src;
}

function activate(name) {
  for (const view of ["editor", "library", "gallery"]) {
    document.getElementById(`view-${view}`).classList.toggle("active", view === name);
    document.getElementById(`btn-nav-${view}`).classList.toggle("active", view === name);
  }
}

function go(hash) {
  if ((location.hash || "#").replace(/^#/, "") === hash) applyRoute();
  else location.hash = hash;
}
window.go = go;

function applyRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (hash === "library") { enterLibrary(); return; }
  if (hash === "gallery" || hash.startsWith("gallery/")) { enterGallery(hash); return; }
  activate("editor");
  if (App.doc) Editor.draw();
}

function enterLibrary() {
  if (!App.user) {
    UI.openAuth("Библиотека карт доступна после входа", () => enterLibrary());
    activate("editor");
    return;
  }
  activate("library");
  UI.loadLibrary().catch((err) => UI.toast(err.message, "error"));
}

function enterGallery(hash) {
  activate("gallery");
  const id = hash.startsWith("gallery/") ? hash.split("/")[1] : "";
  const job = id ? UI.openGalleryMap(id) : UI.showGalleryList();
  job.catch((err) => UI.toast(err.message, "error"));
}

function readInt(id) {
  const value = Number(document.getElementById(id).value);
  return Number.isInteger(value) ? value : NaN;
}

function validateGen(params) {
  if (![params.w, params.h, params.rooms, params.min, params.max].every(Number.isInteger)) return "Параметры должны быть целыми числами";
  if (params.w < 20 || params.w > 64 || params.h < 14 || params.h > 40) return "Размер карты: ширина 20–64, высота 14–40";
  if (params.rooms < 2 || params.rooms > 16) return "Количество комнат: от 2 до 16";
  if (params.min < 3 || params.max > 14 || params.min > params.max) return "Некорректный размер комнаты";
  if (params.w < params.max + 3 || params.h < params.max + 3) return "Карта слишком мала для таких комнат";
  return "";
}

async function generate() {
  if (!App.user) { UI.openAuth("Генерация случайной карты доступна после входа"); return; }
  const params = {
    w: readInt("gen-w"), h: readInt("gen-h"), rooms: readInt("gen-rooms"),
    min: readInt("gen-min"), max: readInt("gen-max"),
  };
  const error = document.getElementById("gen-error");
  const message = validateGen(params);
  if (message) { error.textContent = message; return; }
  let generated;
  try {
    generated = generateDungeonMap({
      width: params.w, height: params.h, max_rooms: params.rooms,
      min_room_xy: params.min, max_room_xy: params.max,
      rooms_overlap: false, random_connections: 2, random_spurs: 0,
    });
  } catch (_err) {
    error.textContent = "Не удалось сгенерировать карту. Измените параметры.";
    return;
  }
  const level = generated && generated.level;
  if (!level || level.length !== params.h || !level.some((row) => row.includes("floor"))) {
    error.textContent = "Не удалось разместить комнаты. Уменьшите размер или число комнат.";
    return;
  }
  const built = IO.furnishDungeon(level, generated.rooms || [], {
    withObjects: document.getElementById("gen-objects").checked,
    specials: [...document.querySelectorAll(".gen-special:checked")].map((el) => el.value),
  });
  error.textContent = "";
  App.previewDoc = IO.newDocument(params.w, params.h);
  App.previewDoc.layers[0].tiles = built.tiles;
  const objects = App.previewDoc.layers.find((layer) => layer.kind === "objects");
  objects.items = built.items;
  IO.remember(App.previewDoc);
  await IO.preload(App.previewDoc);
  const canvas = document.getElementById("gen-canvas");
  const scale = Math.min(1, 520 / (params.w * 16));
  const draw = () => IO.drawMap(canvas, App.previewDoc, { editor: false, player: true, scale, redraw: draw });
  draw();
  document.getElementById("modal-gen").hidden = false;
}

function acceptGen() {
  if (!App.previewDoc || !App.user) return;
  const src = App.previewDoc;
  const srcObjects = src.layers.find((layer) => layer.kind === "objects");
  IO.arm(App.doc);
  App.doc.cols = src.cols;
  App.doc.rows = src.rows;
  let replaced = false;
  let objectsDone = false;
  for (const layer of App.doc.layers) {
    if (layer.kind === "tiles") {
      layer.tiles = replaced ? Array(src.cols * src.rows).fill(0) : src.layers[0].tiles.slice();
      replaced = true;
    } else if (layer.kind === "objects") {
      layer.items = objectsDone ? [] : (srcObjects?.items || []).map((item) => ({ ...item, id: IO.uid() }));
      objectsDone = true;
    } else layer.items = (layer.items || []).filter((item) => item.x < src.cols && item.y < src.rows);
  }
  IO.remember(App.doc);
  IO.commit(App.doc);
  App.previewDoc = null;
  document.getElementById("modal-gen").hidden = true;
  Editor.markDirty();
  Editor.syncHistory();
  UI.renderLayers();
  Editor.draw();
  UI.toast("Карта открыта в редакторе");
}

async function doExport(scale, format) {
  if (!App.user && (scale !== 1 || format !== "image/png")) {
    UI.openAuth("Экспорт в высоком разрешении без водяного знака доступен после входа");
    return;
  }
  const notes = !!App.user && document.getElementById("export-notes").checked;
  await IO.preload(App.doc);
  const canvas = document.createElement("canvas");
  IO.drawMap(canvas, App.doc, { scale, player: !notes, editor: false, watermark: !App.user });
  const name = (document.getElementById("map-name").value || "map").replace(/[\\/:*?"<>|]+/g, "").trim() || "map";
  const link = document.createElement("a");
  link.href = canvas.toDataURL(format, 0.92);
  link.download = `${name}.${format === "image/jpeg" ? "jpg" : "png"}`;
  link.click();
  UI.toast(App.user ? "Файл скачан без водяного знака" : "Файл скачан с водяным знаком");
}

async function openShare() {
  if (!App.user) { UI.openAuth("Ссылка для просмотра доступна после входа"); return; }
  if (!App.mapId || App.dirty) await Editor.save();
  const fresh = await API.map(App.mapId);
  App.shareToken = fresh.share_token;
  document.getElementById("share-link").value = `${location.origin}/s/${fresh.share_token}`;
  document.getElementById("share-public").checked = !!fresh.is_public;
  document.getElementById("map-public").checked = !!fresh.is_public;
  document.getElementById("modal-share").hidden = false;
}

const TILE_TOOLS = new Set(["wall", "floor", "door", "empty"]);

function stampObject(x, y) {
  const spec = IO.OBJECTS[App.tool];
  const layer = layerByKind("objects");
  if (!spec || !layer || layer.locked) return;
  const variant = App.objectVariant[App.tool] || 0;
  const same = (layer.items || []).some((item) => item.x === x && item.y === y && item.objectType === App.tool && item.variant === variant && item.w === 1 && item.h === 1);
  if (same) return;
  layer.items = (layer.items || []).filter((item) => !(item.objectType && item.x === x && item.y === y && item.w === 1 && item.h === 1));
  layer.items.push({
    id: IO.uid(), kind: "sprite", x, y, w: 1, h: 1,
    src: spec.variants[variant], name: spec.name, text: "", description: spec.name,
    objectType: App.tool, variant,
  });
}

function onPointerDown(event) {
  if (event.button !== 0 || !App.doc) return;
  if (App.playerMode) { UI.toast("Выключите режим игрока, чтобы редактировать"); return; }
  const cell = cellFromEvent(event);
  if (PREMIUM.has(App.tool) && !App.user) { UI.openAuth("Этот инструмент доступен после входа"); return; }
  if (IO.OBJECTS[App.tool]) {
    const layer = layerByKind("objects");
    if (!layer || layer.locked) {
      UI.toast(layer ? "Слой объектов заблокирован" : "Добавьте слой объектов", "error");
      return;
    }
    IO.arm(App.doc);
    App.painting = true;
    stampObject(cell.x, cell.y);
    Editor.draw();
    return;
  }
  if (TILE_TOOLS.has(App.tool)) {
    const layer = currentTileLayer();
    if (!layer) { UI.toast(App.user ? "Выберите незаблокированный слой тайлов" : "Нет слоя для рисования", "error"); return; }
    IO.arm(App.doc);
    App.painting = true;
    App.prevX = cell.x;
    App.prevY = cell.y;
    paintLine(cell.x, cell.y, cell.x, cell.y, tileForTool(App.tool));
    Editor.draw();
    return;
  }
  if (App.tool === "select" || App.tool === "text") {
    const hit = IO.hitTest(App.doc, cell.x, cell.y, App.playerMode);
    if (hit) {
      IO.arm(App.doc);
      App.selection = hit.item.id;
      App.drag = App.tool === "select" ? { id: hit.item.id, dx: cell.x - hit.item.x, dy: cell.y - hit.item.y } : null;
      UI.showInspector();
      Editor.draw();
      return;
    }
    if (App.tool === "text") { Editor.placeLabel(cell.x, cell.y); return; }
    App.selection = null;
    UI.showInspector();
    Editor.draw();
    return;
  }
  if (App.tool === "sprite") {
    const asset = App.assets.find((item) => item.id === App.selectedAssetId);
    if (!asset) { UI.toast("Выберите спрайт в палитре", "error"); return; }
    Editor.placeAsset(asset, cell.x, cell.y).catch((err) => UI.toast(err.message, "error"));
  }
}

function onPointerMove(event) {
  if (!App.doc) return;
  const cell = cellFromEvent(event);
  const pos = document.getElementById("st-pos");
  if (pos) pos.textContent = `${cell.x},${cell.y}`;
  const hit = IO.hitTest(App.doc, cell.x, cell.y, App.playerMode);
  if (hit && hit.item.description && !App.painting) UI.showTooltip(event, hit.item.description);
  else UI.hideTooltip();
  if (App.painting) {
    if (IO.OBJECTS[App.tool]) stampObject(cell.x, cell.y);
    else {
      paintLine(App.prevX, App.prevY, cell.x, cell.y, tileForTool(App.tool));
      App.prevX = cell.x;
      App.prevY = cell.y;
    }
    Editor.draw();
  }
  if (App.drag) {
    const found = IO.findItem(App.doc, App.drag.id);
    if (!found) return;
    found.item.x = Math.max(0, Math.min(App.doc.cols - 1, cell.x - App.drag.dx));
    found.item.y = Math.max(0, Math.min(App.doc.rows - 1, cell.y - App.drag.dy));
    Editor.draw();
  }
}

function onPointerUp() {
  if (!App.painting && !App.drag) return;
  IO.remember(App.doc);
  if (IO.commit(App.doc)) Editor.markDirty();
  Editor.syncHistory();
  App.painting = false;
  App.drag = null;
}

function bindEditor() {
  const canvas = document.getElementById("map");
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", () => {
    if (!App.painting) document.getElementById("st-pos").textContent = "—";
    UI.hideTooltip();
  });
  window.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("dragover", (event) => event.preventDefault());
  canvas.addEventListener("drop", (event) => {
    event.preventDefault();
    if (!App.user) { UI.openAuth("Свои текстуры доступны после входа"); return; }
    const asset = App.assets.find((item) => item.id === event.dataTransfer.getData("text/plain"));
    if (!asset) return;
    const cell = cellFromEvent(event);
    Editor.placeAsset(asset, cell.x, cell.y).catch((err) => UI.toast(err.message, "error"));
  });
  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => Editor.setTool(button.dataset.tool));
  });
  document.getElementById("btn-new").addEventListener("click", () => Editor.newMap());
  document.getElementById("btn-undo").addEventListener("click", () => Editor.undo());
  document.getElementById("btn-redo").addEventListener("click", () => Editor.redo());
  document.getElementById("btn-player").addEventListener("click", () => Editor.togglePlayer());
  document.getElementById("btn-save").addEventListener("click", () => UI.run(() => Editor.save()));
  document.getElementById("btn-share").addEventListener("click", () => UI.run(openShare));
  document.getElementById("btn-duplicate").addEventListener("click", () => UI.run(() => Editor.duplicate()));
  document.getElementById("btn-export").addEventListener("click", () => { document.getElementById("modal-export").hidden = false; });
  document.getElementById("export-png").addEventListener("click", () => UI.run(() => doExport(1, "image/png")));
  document.getElementById("export-png2").addEventListener("click", () => UI.run(() => doExport(2, "image/png")));
  document.getElementById("export-png4").addEventListener("click", () => UI.run(() => doExport(4, "image/png")));
  document.getElementById("export-jpg").addEventListener("click", () => UI.run(() => doExport(2, "image/jpeg")));
  document.getElementById("btn-gen").addEventListener("click", generate);
  document.getElementById("gen-accept").addEventListener("click", acceptGen);
  document.getElementById("btn-add-layer").addEventListener("click", () => Editor.addLayer());
  document.getElementById("share-public").addEventListener("change", () => UI.run(async () => {
    const isPublic = document.getElementById("share-public").checked;
    try {
      await API.setShare(App.mapId, isPublic);
      document.getElementById("map-public").checked = isPublic;
      UI.toast(isPublic ? "Ссылка открыта" : "Доступ по ссылке закрыт");
    } catch (err) {
      document.getElementById("share-public").checked = !isPublic;
      throw err;
    }
  }));
  document.getElementById("share-copy").addEventListener("click", () => UI.run(async () => {
    const field = document.getElementById("share-link");
    if (!document.getElementById("share-public").checked) UI.toast("Доступ пока закрыт: ссылка не откроется", "error");
    try {
      await navigator.clipboard.writeText(field.value);
      UI.toast("Ссылка скопирована");
    } catch (_err) {
      field.focus();
      field.select();
      UI.toast("Скопируйте ссылку из поля");
    }
  }));
  window.addEventListener("keydown", (event) => {
    const typing = event.target.matches("input, textarea");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      UI.run(() => Editor.save());
      return;
    }
    if (typing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); Editor.undo(); }
    if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
      event.preventDefault();
      Editor.redo();
    }
    if ((event.key === "Delete" || event.key === "Backspace") && App.selection) {
      event.preventDefault();
      Editor.deleteSelection();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!App.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("hashchange", applyRoute);
  window.addEventListener("focus", () => { if (App.user) UI.refreshNotes(false).catch(() => {}); });
}

async function bootView() {
  const canvas = document.getElementById("map");
  const message = document.getElementById("view-message");
  try {
    const data = await API.shared(document.body.dataset.token);
    document.getElementById("view-title").textContent = data.name;
    document.getElementById("view-author").textContent = `${data.author} · ${new Date(data.updated_at).toLocaleString("ru-RU")}`;
    const doc = IO.normalize(data.data);
    const scale = Math.min(1.25, 960 / (doc.cols * 16));
    const draw = () => IO.drawMap(canvas, doc, { scale, player: true, editor: false });
    IO.drawMap(canvas, doc, { scale, player: true, editor: false, redraw: draw });
  } catch (err) {
    document.getElementById("view-title").textContent = "Карта недоступна";
    message.hidden = false;
    message.textContent = err.message || "Доступ к карте закрыт";
    canvas.parentElement.hidden = true;
  }
}

function swatch(src, title, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = active ? "swatch active" : "swatch";
  button.title = title;
  const img = document.createElement("img");
  img.src = src;
  img.alt = title;
  button.append(img);
  button.addEventListener("click", onClick);
  return button;
}

function renderPalette() {
  const root = document.getElementById("palette");
  if (!root) return;
  root.replaceChildren();
  const add = (title, buttons) => {
    const heading = document.createElement("p");
    heading.className = "muted palette-title";
    heading.textContent = title;
    const row = document.createElement("div");
    row.className = "swatches";
    buttons.forEach((button) => row.append(button));
    root.append(heading, row);
  };
  add("Стены", IO.MATERIALS.walls.map((mat, index) => swatch(mat.src, mat.name, App.tool === "wall" && App.wallVariant === index, () => {
    App.wallVariant = index;
    Editor.setTool("wall", true);
  })));
  add("Полы", IO.MATERIALS.floors.map((mat, index) => swatch(mat.src, mat.name, App.tool === "floor" && App.floorVariant === index, () => {
    App.floorVariant = index;
    Editor.setTool("floor", true);
  })));
  for (const [type, spec] of Object.entries(IO.OBJECTS)) {
    add(spec.name, spec.variants.map((src, index) => swatch(src, `${spec.name} ${index + 1}`, App.tool === type && (App.objectVariant[type] || 0) === index, () => {
      if (!App.user) { UI.openAuth("Объекты доступны после входа"); return; }
      App.objectVariant[type] = index;
      Editor.setTool(type, true);
    })));
  }
}

function renderSpecials() {
  const box = document.getElementById("gen-specials");
  if (!box || box.childElementCount) return;
  for (const spec of IO.SPECIALS) {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "gen-special";
    input.value = spec.id;
    label.append(input, document.createTextNode(` ${spec.label}`));
    box.append(label);
  }
}

async function bootApp() {
  UI.bind();
  bindEditor();
  renderSpecials();
  renderPalette();
  IO.preload();
  try {
    const me = await API.me();
    App.user = me.user;
  } catch (err) {
    UI.toast(err.message, "error");
  }
  Editor.resetDocument();
  UI.renderAuth();
  if (App.user) {
    await UI.ensureTaxonomy();
    await UI.loadAssets();
    await UI.refreshNotes(false);
  }
  const mapId = new URLSearchParams(location.search).get("map");
  if (mapId) {
    if (App.user) await Editor.openMap(mapId).catch((err) => UI.toast(err.message, "error"));
    else UI.openAuth("Войдите, чтобы открыть карту", () => Editor.openMap(mapId));
  } else applyRoute();
}

if (document.body.dataset.page === "view") bootView();
else bootApp();
