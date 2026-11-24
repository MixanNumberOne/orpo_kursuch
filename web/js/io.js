const IO = (() => {
  const COLORS = { 0: "#26221b" };
  const MATERIALS = {
    walls: [
      { name: "Кирпич", src: "/static/textures/wall-0.png", color: "#8b93a6" },
      { name: "Камень", src: "/static/textures/wall-1.png", color: "#7a8496" },
      { name: "Кладка", src: "/static/textures/wall-2.png", color: "#6a7484" },
    ],
    floors: [
      { name: "Земля", src: "/static/textures/floor-0.png", color: "#6b4034" },
      { name: "Плитка", src: "/static/textures/floor-1.png", color: "#9aa0aa" },
      { name: "Дерево", src: "/static/textures/floor-2.png", color: "#8d7a62" },
      { name: "Брусчатка", src: "/static/textures/floor-3.png", color: "#8e929a" },
    ],
  };
  const DOOR = { src: "/static/textures/door.png", color: "#8a5426" };
  const OBJECTS = {
    chest: { name: "Сундук", variants: ["/static/textures/chest-0.png", "/static/textures/chest-1.png", "/static/textures/chest-2.png"] },
    enemy: {
      name: "Противник",
      labels: ["Рыцарь", "Гоблин", "Разбойник", "Слизень", "Паук"],
      variants: [
        "/static/textures/enemy-0.png",
        "/static/textures/enemy-3.png",
        "/static/textures/enemy-4.png",
        "/static/textures/enemy-1.png",
        "/static/textures/enemy-2.png",
      ],
    },
    trap: { name: "Ловушка", variants: ["/static/textures/trap-0.png", "/static/textures/trap-1.png", "/static/textures/trap-2.png"] },
    water: { name: "Вода", variants: ["/static/textures/water-0.png", "/static/textures/water-1.png", "/static/textures/water-2.png"] },
    lava: { name: "Лава", variants: ["/static/textures/lava-0.png", "/static/textures/lava-1.png", "/static/textures/lava-2.png"] },
    decor: {
      name: "Декор",
      labels: ["Ящик", "Бочка", "Зелье", "Щит", "Наковальня", "Молот", "Кости"],
      variants: [
        "/static/textures/decor-0.png",
        "/static/textures/decor-1.png",
        "/static/textures/decor-2.png",
        "/static/textures/decor-3.png",
        "/static/textures/decor-4.png",
        "/static/textures/decor-5.png",
        "/static/textures/decor-6.png",
      ],
    },
  };
  const SPECIALS = [
    { id: "treasury", label: "Сокровищница", object: "chest", wall: 0, floor: 1 },
    { id: "lair", label: "Логово", object: "enemy", wall: 1, floor: 0 },
    { id: "traps", label: "Зал ловушек", object: "trap", wall: 2, floor: 1 },
    { id: "cistern", label: "Цистерна", object: "water", wall: 1, floor: 3 },
    { id: "lava", label: "Лавовая яма", object: "lava", wall: 1, floor: 3 },
    { id: "hall", label: "Украшенный зал", object: "decor", wall: 2, floor: 2 },
  ];
  const ROOM_PAIRS = [[0, 0], [1, 1], [2, 2], [1, 3]];
  const CORRIDOR = { wall: 1, floor: 3 };
  const WALL_MAP = [0, 1, 2, 2, 1];
  const FLOOR_MAP = [0, 0, 1, 3, 0];
  const images = new Map();
  const srcStore = new Map();
  let armed = null;

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function defaultGrid() {
    return { show: true, cell: 16, offsetX: 0, offsetY: 0, color: "#d9c07a" };
  }

  function newDocument(cols = 40, rows = 24) {
    const floorId = uid();
    return {
      cols, rows, grid: defaultGrid(), activeLayerId: floorId,
      history: { undo: [], redo: [] },
      layers: [
        { id: floorId, name: "Стены и пол", kind: "tiles", visible: true, locked: false, tiles: Array(cols * rows).fill(0) },
        { id: uid(), name: "Объекты", kind: "objects", visible: true, locked: false, items: [] },
        { id: uid(), name: "Заметки мастера", kind: "notes", visible: true, locked: false, items: [] },
      ],
    };
  }

  function clampInt(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(max, Math.max(min, number));
  }

  function migrateTile(tile) {
    if (!Number.isInteger(tile)) return 0;
    if (tile === 0 || tile === 3) return tile;
    if (tile === 1) return 100;
    if (tile === 2 || (tile >= 4 && tile <= 9)) return 200;
    if (tile >= 100 && tile < 200) {
      const mapped = WALL_MAP[tile - 100];
      return mapped === undefined ? 100 : 100 + mapped;
    }
    if (tile >= 200 && tile < 300) {
      const mapped = FLOOR_MAP[tile - 200];
      return mapped === undefined ? 200 : 200 + mapped;
    }
    return 0;
  }

  function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  function roomCells(room, tiles, cols, rows) {
    const cells = [];
    const x1 = room.x + room.w - 1;
    const y1 = room.y + room.h - 1;
    const inset = room.w >= 3 && room.h >= 3;
    for (let y = room.y; y <= y1; y += 1) {
      for (let x = room.x; x <= x1; x += 1) {
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if ((tiles[y * cols + x] || 0) < 200) continue;
        if (inset && (x === room.x || y === room.y || x === x1 || y === y1)) continue;
        cells.push({ x, y });
      }
    }
    return cells;
  }

  function objectQuota(type, total, special) {
    if (!special) return Math.min(2, Math.max(1, Math.ceil(total / 8)));
    if (type === "water" || type === "lava") return Math.max(1, Math.min(total, Math.round(total * 0.55)));
    if (type === "decor" || type === "enemy" || type === "trap") return Math.max(1, Math.min(5, Math.ceil(total / 3)));
    return Math.max(1, Math.min(3, Math.ceil(total / 4)));
  }

  function furnishDungeon(level, rooms, options) {
    const rows = level.length;
    const cols = level[0].length;
    const withObjects = !!(options && options.withObjects);
    const specialById = Object.fromEntries(SPECIALS.map((item) => [item.id, item]));
    const chosen = (options && Array.isArray(options.specials) ? options.specials : []).filter((id) => specialById[id]);
    const roomMeta = rooms.map((room) => ({ x: room.x, y: room.y, w: room.w, h: room.h, wall: CORRIDOR.wall, floor: CORRIDOR.floor, special: null }));
    if (chosen.length) {
      shuffle(roomMeta.map((_, index) => index)).forEach((index, position) => {
        roomMeta[index].special = chosen[position % chosen.length];
      });
    }
    for (const room of roomMeta) {
      if (room.special) {
        room.wall = specialById[room.special].wall;
        room.floor = specialById[room.special].floor;
      } else {
        const pair = ROOM_PAIRS[Math.floor(Math.random() * ROOM_PAIRS.length)];
        room.wall = pair[0];
        room.floor = pair[1];
      }
    }
    const tiles = Array(cols * rows).fill(0);
    const owner = Array(cols * rows).fill(-1);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (level[y][x] === "floor") tiles[y * cols + x] = 200 + CORRIDOR.floor;
      }
    }
    roomMeta.forEach((room, index) => {
      for (let y = room.y; y < room.y + room.h; y += 1) {
        for (let x = room.x; x < room.x + room.w; x += 1) {
          if (y < 0 || x < 0 || y >= rows || x >= cols) continue;
          if (level[y][x] !== "floor") continue;
          tiles[y * cols + x] = 200 + room.floor;
          owner[y * cols + x] = index;
        }
      }
    });
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (level[y][x] !== "wall") continue;
        const votes = new Map();
        for (const [dx, dy] of around) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const id = owner[ny * cols + nx];
          if (id >= 0) votes.set(id, (votes.get(id) || 0) + 1);
        }
        let best = -1;
        let bestN = 0;
        for (const [id, count] of votes) {
          if (count > bestN || (count === bestN && (best < 0 || id < best))) {
            best = id;
            bestN = count;
          }
        }
        tiles[y * cols + x] = 100 + (best >= 0 ? roomMeta[best].wall : CORRIDOR.wall);
      }
    }
    const items = [];
    if (withObjects) {
      const used = new Set();
      for (const room of roomMeta) {
        const cells = shuffle(roomCells(room, tiles, cols, rows));
        if (!cells.length) continue;
        const types = room.special
          ? [specialById[room.special].object]
          : shuffle(Object.keys(OBJECTS)).slice(0, Math.random() < 0.45 ? 2 : 1);
        for (const type of types) {
          const spec = OBJECTS[type];
          const quota = objectQuota(type, cells.length, !!room.special);
          let placed = 0;
          for (const cell of cells) {
            if (placed >= quota || items.length >= 400) break;
            const key = `${cell.x},${cell.y}`;
            if (used.has(key)) continue;
            used.add(key);
            const variant = Math.floor(Math.random() * spec.variants.length);
            items.push({
              id: uid(), kind: "sprite", x: cell.x, y: cell.y, w: 1, h: 1,
              src: spec.variants[variant], name: spec.name, text: "", description: spec.name,
              objectType: type, variant,
            });
            placed += 1;
          }
        }
      }
    }
    return { tiles, items, rooms: roomMeta };
  }

  function normalize(raw) {
    const source = raw || {};
    const cols = clampInt(source.cols, 8, 96, 40);
    const rows = clampInt(source.rows, 8, 64, 24);
    const doc = {
      cols, rows,
      grid: Object.assign(defaultGrid(), source.grid || {}),
      activeLayerId: source.activeLayerId || null,
      history: {
        undo: Array.isArray(source.history?.undo) ? source.history.undo.slice(-40) : [],
        redo: Array.isArray(source.history?.redo) ? source.history.redo.slice(-40) : [],
      },
      layers: [],
    };
    for (const layer of Array.isArray(source.layers) ? source.layers : []) {
      const kind = layer.kind === "objects" || layer.kind === "notes" ? layer.kind : "tiles";
      const base = {
        id: layer.id || uid(),
        name: layer.name || "Слой",
        kind,
        visible: layer.visible !== false,
        locked: !!layer.locked,
      };
      if (kind === "tiles") {
        const tiles = Array.isArray(layer.tiles) ? layer.tiles.slice(0, cols * rows) : [];
        while (tiles.length < cols * rows) tiles.push(0);
        base.tiles = tiles.map(migrateTile);
      } else {
        base.items = (Array.isArray(layer.items) ? layer.items : []).map((item) => ({
          id: item.id || uid(),
          kind: item.kind === "label" ? "label" : "sprite",
          x: Number(item.x) || 0,
          y: Number(item.y) || 0,
          w: Number(item.w) || (item.kind === "label" ? 8 : 3),
          h: Number(item.h) || (item.kind === "label" ? 2 : 3),
          assetId: item.assetId || null,
          src: item.src || "",
          name: item.name || "",
          text: item.text || "",
          description: item.description || "",
          color: item.color || "#f3e6c0",
          objectType: OBJECTS[item.objectType] ? item.objectType : "",
          variant: Number.isInteger(item.variant) && item.variant >= 0 && item.variant < 8 ? item.variant : 0,
        }));
      }
      doc.layers.push(base);
    }
    if (!doc.layers.some((layer) => layer.kind === "tiles")) {
      const id = uid();
      doc.layers.unshift({
        id, name: "Стены и пол", kind: "tiles", visible: true, locked: false,
        tiles: Array(cols * rows).fill(0),
      });
      doc.activeLayerId = id;
    }
    if (!doc.layers.some((layer) => layer.id === doc.activeLayerId)) doc.activeLayerId = doc.layers[0].id;
    return doc;
  }

  function remember(doc) {
    for (const layer of doc.layers) {
      for (const item of layer.items || []) if (item.src) srcStore.set(item.id, item.src);
    }
  }

  function restoreSources(doc) {
    for (const layer of doc.layers) {
      for (const item of layer.items || []) {
        if (!item.src && srcStore.has(item.id)) item.src = srcStore.get(item.id);
      }
    }
  }

  function snapshot(doc) {
    return JSON.stringify({
      cols: doc.cols,
      rows: doc.rows,
      grid: doc.grid,
      activeLayerId: doc.activeLayerId,
      layers: doc.layers.map((layer) => {
        if (layer.kind === "tiles") {
          return {
            id: layer.id, name: layer.name, kind: layer.kind,
            visible: layer.visible, locked: layer.locked, tiles: layer.tiles,
          };
        }
        return {
          id: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, locked: layer.locked,
          items: (layer.items || []).map(({ src, ...rest }) => rest),
        };
      }),
    });
  }

  function apply(doc, snap) {
    const data = JSON.parse(snap);
    doc.cols = data.cols;
    doc.rows = data.rows;
    doc.grid = data.grid;
    doc.activeLayerId = data.activeLayerId;
    doc.layers = data.layers;
    for (const layer of doc.layers) {
      if (layer.kind === "tiles" && Array.isArray(layer.tiles)) layer.tiles = layer.tiles.map(migrateTile);
    }
    restoreSources(doc);
  }

  function disarm() {
    armed = null;
  }

  function arm(doc) {
    if (!armed) armed = snapshot(doc);
  }

  function commit(doc) {
    if (!armed) return false;
    const current = snapshot(doc);
    const changed = current !== armed;
    if (changed) {
      doc.history.undo.push(armed);
      doc.history.redo = [];
      if (doc.history.undo.length > 40) doc.history.undo.shift();
    }
    armed = null;
    return changed;
  }

  function undo(doc) {
    commit(doc);
    if (!doc.history.undo.length) return false;
    doc.history.redo.push(snapshot(doc));
    apply(doc, doc.history.undo.pop());
    return true;
  }

  function redo(doc) {
    commit(doc);
    if (!doc.history.redo.length) return false;
    doc.history.undo.push(snapshot(doc));
    apply(doc, doc.history.redo.pop());
    return true;
  }

  function findItem(doc, id) {
    if (!doc || !id) return null;
    for (const layer of doc.layers) {
      for (const item of layer.items || []) if (item.id === id) return { layer, item };
    }
    return null;
  }

  function hitTest(doc, x, y, playerMode) {
    for (let i = doc.layers.length - 1; i >= 0; i -= 1) {
      const layer = doc.layers[i];
      if (!layer.visible || (playerMode && layer.kind === "notes")) continue;
      const items = layer.items || [];
      for (let j = items.length - 1; j >= 0; j -= 1) {
        const item = items[j];
        const w = item.w || 1;
        const h = item.h || 1;
        if (x >= item.x && y >= item.y && x < item.x + w && y < item.y + h) return { layer, item };
      }
    }
    return null;
  }

  function freshImage(src, redraw) {
    const image = new Image();
    images.set(src, image);
    image.onload = () => { if (redraw) redraw(); };
    image.src = src;
    return image;
  }

  function readyImage(src, redraw) {
    if (!src) return null;
    let image = images.get(src);
    if (!image || !image.src || (image.complete && !image.naturalWidth)) image = freshImage(src, redraw);
    return image.complete && image.naturalWidth ? image : null;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) { resolve(null); return; }
      let image = images.get(src);
      if (!image || !image.src || (image.complete && !image.naturalWidth)) image = freshImage(src);
      if (image.complete && image.naturalWidth) { resolve(image); return; }
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(image.naturalWidth ? image : null); } };
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
      if (image.complete) done();
    });
  }

  function textureUrls() {
    const urls = [DOOR.src];
    for (const mat of MATERIALS.walls) urls.push(mat.src);
    for (const mat of MATERIALS.floors) urls.push(mat.src);
    for (const spec of Object.values(OBJECTS)) urls.push(...spec.variants);
    return urls;
  }

  function preload(doc) {
    const jobs = textureUrls().map(loadImage);
    if (doc) {
      for (const layer of doc.layers) {
        for (const item of layer.items || []) if (item.src) jobs.push(loadImage(item.src));
      }
    }
    return Promise.all(jobs);
  }

  function tileVisual(tile) {
    const code = migrateTile(tile);
    if (code === 3) return DOOR;
    if (code >= 100 && code < 200) return MATERIALS.walls[code - 100] || MATERIALS.walls[0];
    if (code >= 200) return MATERIALS.floors[code - 200] || MATERIALS.floors[0];
    return { color: COLORS[0] };
  }

  function drawTiles(ctx, layer, cols, rows, cell, paintStone, redraw) {
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const tile = layer.tiles[y * cols + x] || 0;
        if (!tile && !paintStone) continue;
        const visual = tileVisual(tile);
        const image = visual.src ? readyImage(visual.src, redraw) : null;
        if (image) ctx.drawImage(image, x * cell, y * cell, cell, cell);
        else {
          ctx.fillStyle = visual.color || COLORS[0];
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
  }

  function drawItem(ctx, item, cell, redraw) {
    const x = item.x * cell;
    const y = item.y * cell;
    const w = (item.w || 1) * cell;
    const h = (item.h || 1) * cell;
    if (item.kind === "label") {
      ctx.fillStyle = "rgba(36, 28, 16, 0.92)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#c2a15a";
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
      ctx.fillStyle = item.color || "#f3e6c0";
    } else {
      const image = readyImage(item.src, redraw);
      if (image) ctx.drawImage(image, x, y, w, h);
      else { ctx.fillStyle = "#6a5a3a"; ctx.fillRect(x, y, w, h); }
      ctx.fillStyle = "#fff8e0";
    }
    if (item.text) {
      ctx.font = `${Math.max(10, Math.floor(cell * 0.72))}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(item.text, x + 3, y + 3, Math.max(0, w - 6));
    }
  }

  function drawMap(canvas, doc, opts = {}) {
    const scale = opts.scale || 1;
    const cell = 16 * scale;
    canvas.width = Math.max(1, Math.round(doc.cols * cell));
    canvas.height = Math.max(1, Math.round(doc.rows * cell));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = COLORS[0];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let paintedStone = false;
    for (const layer of doc.layers) {
      if (!layer.visible || (opts.player && layer.kind === "notes")) continue;
      if (layer.kind === "tiles") {
        drawTiles(ctx, layer, doc.cols, doc.rows, cell, !paintedStone, opts.redraw);
        paintedStone = true;
      } else if (layer.items) {
        for (const item of layer.items) drawItem(ctx, item, cell, opts.redraw);
      }
    }
    if (opts.editor) {
      ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
      ctx.beginPath();
      for (let x = 0; x <= doc.cols; x += 1) {
        ctx.moveTo(x * cell + 0.5, 0);
        ctx.lineTo(x * cell + 0.5, canvas.height);
      }
      for (let y = 0; y <= doc.rows; y += 1) {
        ctx.moveTo(0, y * cell + 0.5);
        ctx.lineTo(canvas.width, y * cell + 0.5);
      }
      ctx.stroke();
    }
    const grid = doc.grid || defaultGrid();
    if (grid.show !== false) {
      const step = Math.max(4, Number(grid.cell) || 16) * scale;
      let ox = (Number(grid.offsetX) || 0) * scale % step;
      let oy = (Number(grid.offsetY) || 0) * scale % step;
      if (ox < 0) ox += step;
      if (oy < 0) oy += step;
      ctx.save();
      ctx.strokeStyle = grid.color || "#d9c07a";
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let x = ox; x <= canvas.width; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, canvas.height); }
      for (let y = oy; y <= canvas.height; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(canvas.width, y + 0.5); }
      ctx.stroke();
      ctx.restore();
    }
    if (opts.selection) {
      const found = findItem(doc, opts.selection);
      if (found && found.layer.visible && !(opts.player && found.layer.kind === "notes")) {
        ctx.strokeStyle = "#ffd700";
        ctx.lineWidth = Math.max(1, scale);
        ctx.strokeRect(found.item.x * cell + 1, found.item.y * cell + 1, found.item.w * cell - 2, found.item.h * cell - 2);
      }
    }
    if (opts.watermark) {
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 7);
      ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
      ctx.font = `700 ${Math.max(18, Math.floor(canvas.width / 18))}px sans-serif`;
      ctx.textAlign = "center";
      for (let i = -2; i <= 2; i += 1) ctx.fillText("Dungeon Map Builder", 0, i * Math.max(36, canvas.width / 10));
      ctx.restore();
    }
  }

  function makePreview(doc) {
    const canvas = document.createElement("canvas");
    drawMap(canvas, doc, { scale: Math.min(1, 240 / (doc.cols * 16)), player: true, editor: false });
    const url = canvas.toDataURL("image/jpeg", 0.65);
    return url.length <= 180000 ? url : "";
  }

  return {
    MATERIALS, OBJECTS, SPECIALS, uid, newDocument, normalize, remember, arm, commit, undo, redo,
    findItem, hitTest, preload, drawMap, makePreview, disarm, furnishDungeon,
  };
})();
