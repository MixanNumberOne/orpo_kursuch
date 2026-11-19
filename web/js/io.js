const IO = (() => {
  const COLORS = {
    0: "#26221b", 1: "#3e3a33", 2: "#b3a184", 3: "#8a5426", 4: "#a02020",
    5: "#ffd700", 6: "#40a040", 7: "#ff4040", 8: "#ffff80", 9: "#ffffff",
  };
  const TILE_CODE = {
    stone: 0, empty: 0, wall: 1, floor: 2, door: 3, trap: 4,
    treasure: 5, goblin: 6, boss: 7, light: 8, stairs: 9,
  };
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
        base.tiles = tiles.map((tile) => (Number.isInteger(tile) && tile >= 0 && tile <= 9 ? tile : 0));
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

  function readyImage(src, redraw) {
    if (!src) return null;
    let image = images.get(src);
    if (!image) {
      image = new Image();
      images.set(src, image);
      image.onload = () => { if (redraw) redraw(); };
      image.src = src;
    }
    return image.complete && image.naturalWidth ? image : null;
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      if (!src) { resolve(null); return; }
      let image = images.get(src);
      if (!image) {
        image = new Image();
        images.set(src, image);
      }
      if (image.complete) { resolve(image.naturalWidth ? image : null); return; }
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(image.naturalWidth ? image : null); } };
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", done, { once: true });
      if (!image.src) image.src = src;
    });
  }

  function preload(doc) {
    const jobs = [];
    for (const layer of doc.layers) {
      for (const item of layer.items || []) if (item.src) jobs.push(loadImage(item.src));
    }
    return Promise.all(jobs);
  }

  function drawTiles(ctx, layer, cols, rows, cell, paintStone) {
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const tile = layer.tiles[y * cols + x] || 0;
        if (!tile && !paintStone) continue;
        ctx.fillStyle = COLORS[tile] || COLORS[0];
        ctx.fillRect(x * cell, y * cell, cell, cell);
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
    ctx.fillStyle = COLORS[0];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let paintedStone = false;
    for (const layer of doc.layers) {
      if (!layer.visible || (opts.player && layer.kind === "notes")) continue;
      if (layer.kind === "tiles") {
        drawTiles(ctx, layer, doc.cols, doc.rows, cell, !paintedStone);
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
    TILE_CODE, uid, newDocument, normalize, remember, arm, commit, undo, redo,
    findItem, hitTest, preload, drawMap, makePreview, disarm,
  };
})();
