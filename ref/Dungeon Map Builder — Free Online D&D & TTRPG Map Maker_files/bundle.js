'use strict';
window.DM = window.DM || {};

DM.GIFDecoder = (() => {

  async function decode(buf) {
    try { return _parse(new Uint8Array(buf)); }
    catch { return null; }
  }

  function _parse(b) {
    if (b[0] !== 71 || b[1] !== 73 || b[2] !== 70) return null; // 'GIF'
    let p = 6;

    const W = b[p] | b[p+1]<<8;  p+=2;
    const H = b[p] | b[p+1]<<8;  p+=2;
    const f = b[p++];
    p += 2; // background index + pixel aspect ratio

    const hasGCT = !!(f & 0x80);
    const gctSz  = 2 << (f & 7);
    let gct = null;
    if (hasGCT) { gct = b.slice(p, p + gctSz*3); p += gctSz*3; }

    const comp    = new Uint8ClampedArray(W * H * 4); // all transparent
    let   prevComp = null; // saved copy for disposal=3
    const frames  = [];

    let delay=100, transIdx=-1, disposal=0;
    let prevLeft=0, prevTop=0, prevFW=W, prevFH=H;

    while (p < b.length) {
      const sentinel = b[p++];
      if (sentinel === 0x3B) break; // Trailer

      if (sentinel === 0x21) { // Extension
        const label = b[p++];
        if (label === 0xF9) { // Graphic Control Extension
          p++; // block size = 4
          const gf  = b[p++];
          disposal  = (gf >> 3) & 7;
          const hasT = !!(gf & 1);
          delay     = (b[p] | b[p+1]<<8) * 10 || 50;  p+=2;
          transIdx  = hasT ? b[p] : -1;  p++;
          p++; // block terminator
        } else {
          p = _skipBlocks(b, p);
        }
        continue;
      }

      if (sentinel === 0x2C) { // Image Descriptor
        const left = b[p] | b[p+1]<<8; p+=2;
        const top  = b[p] | b[p+1]<<8; p+=2;
        const fw   = b[p] | b[p+1]<<8; p+=2;
        const fh   = b[p] | b[p+1]<<8; p+=2;
        const fi   = b[p++];
        const hasLCT    = !!(fi & 0x80);
        const interlace = !!(fi & 0x40);
        let ct = gct;
        if (hasLCT) {
          const lctSz = 2 << (fi & 7);
          ct = b.slice(p, p + lctSz*3); p += lctSz*3;
        }

        const minCode = b[p++];
        const { data: lzw, next } = _readBlocks(b, p); p = next;
        let px = _lzwDecode(lzw, minCode, fw * fh);
        if (interlace) px = _deinterlace(px, fw, fh);

        if (frames.length > 0) {
          if (disposal === 2) {
            for (let y = 0; y < prevFH; y++) {
              for (let x = 0; x < prevFW; x++) {
                const di = ((prevTop+y)*W + (prevLeft+x))*4;
                if (di+3 < comp.length) comp[di]=comp[di+1]=comp[di+2]=comp[di+3]=0;
              }
            }
          } else if (disposal === 3 && prevComp) {
            comp.set(prevComp);
          }
        }

        prevComp = disposal === 3 ? new Uint8ClampedArray(comp) : null;

        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const ci = px[y*fw + x];
            if (ci === transIdx) continue;
            const di = ((top+y)*W + (left+x))*4;
            if (di+3 >= comp.length || !ct) continue;
            comp[di]   = ct[ci*3];
            comp[di+1] = ct[ci*3+1];
            comp[di+2] = ct[ci*3+2];
            comp[di+3] = 255;
          }
        }

        frames.push({
          imageData: new ImageData(new Uint8ClampedArray(comp), W, H),
          delay:     Math.max(delay, 20),
        });

        prevLeft=left; prevTop=top; prevFW=fw; prevFH=fh;
        delay=100; transIdx=-1; disposal=0;
        continue;
      }

      if (b[p] !== undefined) p = _skipBlocks(b, p);
    }

    return frames.length > 1 ? { width: W, height: H, frames } : null;
  }

  function _deinterlace(src, w, h) {
    const dst = new Uint8Array(w * h);
    const passes = [[0,8],[4,8],[2,4],[1,2]];
    let si = 0;
    for (const [start, step] of passes)
      for (let r = start; r < h; r += step)
        for (let c = 0; c < w; c++)
          dst[r*w + c] = src[si++];
    return dst;
  }

  function _skipBlocks(b, p) {
    while (p < b.length) { const s=b[p++]; if (!s) break; p+=s; }
    return p;
  }

  function _readBlocks(b, p) {
    const out = [];
    while (p < b.length) {
      const s = b[p++];
      if (!s) break;
      for (let i=0; i<s; i++) out.push(b[p++]);
    }
    return { data: new Uint8Array(out), next: p };
  }

  function _lzwDecode(data, minCode, total) {
    const clearCode = 1 << minCode;
    const eodCode   = clearCode + 1;
    let   codeSize  = minCode + 1;
    let   codeMask  = (1 << codeSize) - 1;

    const table = [];
    const reset = () => {
      table.length = 0;
      for (let i=0; i<clearCode; i++) table.push(new Uint8Array([i]));
      table.push(new Uint8Array()); table.push(new Uint8Array()); // cc, eod
      codeSize = minCode+1; codeMask = (1<<codeSize)-1;
    };
    reset();

    const out  = new Uint8Array(total);
    let op=0, buf=0, bits=0, dp=0, prev=-1;

    const read = () => {
      while (bits < codeSize && dp < data.length) { buf |= data[dp++]<<bits; bits+=8; }
      const c = buf & codeMask; buf >>= codeSize; bits -= codeSize; return c;
    };

    while (op < total) {
      const code = read();
      if (code === clearCode) { reset(); prev=-1; continue; }
      if (code === eodCode) break;

      let entry;
      if (code < table.length) {
        entry = table[code];
      } else if (code === table.length && prev >= 0) {
        const p = table[prev];
        const e = new Uint8Array(p.length+1); e.set(p); e[p.length]=p[0];
        entry = e;
      } else break;

      const end = Math.min(op + entry.length, total);
      out.set(entry.subarray(0, end-op), op); op = end;

      if (prev >= 0 && table.length < 4096) {
        const pv = table[prev];
        const ne = new Uint8Array(pv.length+1); ne.set(pv); ne[pv.length]=entry[0];
        table.push(ne);
        if (table.length > codeMask && codeSize < 12) { codeSize++; codeMask=(1<<codeSize)-1; }
      }
      prev = code;
    }
    return out;
  }

  return { decode };
})();

'use strict';
window.DM = window.DM || {};

DM.Config = Object.freeze({
  MAP_W: 1800,
  MAP_H: 1300,
  WALL_T: 9,

  AREA_TOOLS:  new Set(['room','water','pit','stairs','secret']),
  POINT_TOOLS: new Set(['door','pillar','torch',
                        'chest','sarcophagus','altar','trap','magic','portal','stalactite','rubble']),
  FLOOR_TYPES: new Set(['room','water','pit','secret']),

  BORDER_TYPES: new Set(['room','water','pit','secret','stairs',
                         'door',
                         'pillar','chest','sarcophagus','altar','trap','magic']),

  BORDER_DEFAULTS: {
    room:        { color: '#0a0200', width: 2.5 },
    water:       { color: '#b4e6ff', width: 0.8 },
    pit:         { color: '#1a0800', width: 1.2 },
    secret:      { color: '#4e2c0c', width: 1.2 },
    stairs:      { color: '#0a0300', width: 1.2 },
    door:        { color: '#0a0300', width: 1.5 },
    pillar:      { color: '#0a0300', width: 1.5 },
    chest:       { color: '#0a0300', width: 1.5 },
    sarcophagus: { color: '#0a0300', width: 1.5 },
    altar:       { color: '#0a0300', width: 1.5 },
    trap:        { color: '#8b0000', width: 1.5 },
    magic:       { color: '#9f4fff', width: 1.2 },
    wall:        { color: '#0a0200', width: 2.5 },
  },

  TOOL_GROUPS: [
    { id:'main', label:null, flat:true, tools:[
      { id:'select', label:'Select', icon:'↖'  },
      { id:'erase',  label:'Erase',  icon:'🧹' },
      { id:'brush',  label:'Brush',  icon:'🖌'  },
      { id:'fill',   label:'Fill',   icon:'🪣' },
      { id:'text',   label:'Text',   icon:'T'   },
      { id:'hand',   label:'Hand',   icon:'✋'  },
      { id:'water',  label:'Water',  icon:'💧' },
      { id:'room',   label:'Room',   icon:'▭'  },
      { id:'door',   label:'Door',   icon:'🚪' },
    ]},
    { id:'elements', label:'Elements', tools:[
      { id:'secret',      label:'Secret Passage', icon:'⋯'  },
      { id:'pit',         label:'Pit',            icon:'◯'  },
      { id:'stairs',      label:'Stairs',         icon:'📶' },
      { id:'pillar',      label:'Pillar',         icon:'⬤'  },
      { id:'altar',       label:'Altar',          icon:'⛩'  },
      { id:'chest',       label:'Chest',          icon:'📦' },
      { id:'sarcophagus', label:'Sarcophagus',    icon:'⬛' },
      { id:'torch',       label:'Torch',          icon:'🔥' },
      { id:'stalactite',  label:'Stalactites',    icon:'▼'  },
      { id:'rubble',      label:'Rubble',         icon:'🪨' },
      { id:'trap',        label:'Trap',           icon:'✖'  },
      { id:'magic',       label:'Magic Circle',   icon:'◎'  },
      { id:'portal',      label:'Portal',         icon:'🌀' },
      { id:'fog',         label:'Fog',            icon:'🌫' },
      { id:'wall',        label:'Wall',           icon:'╱'  },
    ]},
  ],

  ERASE_PRIO: {
    torch:0, trap:1, magic:2, portal:2, rubble:3, stalactite:4,
    chest:5, pillar:6, altar:7, sarcophagus:8,
    door:9,
    fog:10,
    wall:11,
    text:12, image:13, brush:14,
    water:15, pit:16, stairs:17,
    secret:18, room:19,
    'bg-fill': 100,
  },

  COLORS: {
    floor:      '#eedfa0',
    floorAlt:   '#e8d88e',
    wallFill:   '#150900',
    wallHatch:  'rgba(0,0,0,.2)',
    wallLine:   '#0a0200',
    grid:       'rgba(110,72,25,.15)',
    selection:  'rgba(80,155,255,.88)',
    handle:     'rgba(80,155,255,.9)',
  },
});

(function () {
  window.DM = window.DM || {};

  DM.track = function (name, params) {
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, params || {});
      }
    } catch (_) {  }
  };
})();

'use strict';
window.DM = window.DM || {};

DM.State = (() => {
  function _makeLayer(id, name) {
    return { id, name, visible: true, locked: false, elements: [] };
  }

  const _make = () => {
    const layers = [_makeLayer(0, 'Layer 1')];
    return {
      tool:       'room',
      elements:   layers[0].elements,  // always ref to active layer's elements
      assets:     [],      // { id, name, src }
      history:    [],      // JSON snapshots of { layers, activeLayerIdx }

      mapW:       1800,
      mapH:       1300,

      gridType:      'square', // 'square' | 'hex' | 'none'
      cellSize:      36,
      gridColor:     '#6e4819',
      gridLineWidth: 0.5,
      gridOpacity:   0.15,
      zoom:       1,

      drawing:    false,
      drawStart:  null,    // { x, y }
      drawEnd:    null,    // { x, y }

      selectedIdx: -1,

      brushColor:   '#8b7355',
      brushSize:    20,     // diameter in canvas pixels
      brushShape:   'round', // 'round' | 'square' | 'soft' | 'cave'
      brushOpacity: 1,
      brushAssetId:    null,  // asset id for texture-reveal mode, null = solid color
      brushAssetScale: 1,    // tile size multiplier for texture mode (1 = natural size)
      brushBorderColor: null, // cave edge color, null = same as fill (legacy look)
      brushBorderWidth: 0,    // cave edge thickness in px (0 = no outline halo)
      brushBorderRough: 0.5,  // cave edge raggedness 0..1 (0.5 = legacy look)
      doorAssetId:     null, // asset id for new door placements, null = standard drawing
      fillColor:       '#8b7355', // fill bucket: selected color
      fillAssetId:     null,      // fill bucket: texture asset, null = solid color
      fillAssetScale:  1,         // fill bucket: tile size multiplier

      fogColor:     '#cdd4e1', // mist tint
      fogSize:      120,       // puff base diameter in canvas pixels
      fogDensity:   0.35,      // per-puff opacity factor
      fogSoft:      0.7,       // softness of the puff edge
      fogAnimated:  true,      // new clouds drift & breathe by default
      fogAnimSpeed: 1,         // animation speed multiplier (0 = frozen)
      bgColor:      null,    // null = parchment default; hex string = solid colour
      bgNoise:      1,       // 0–1 multiplier for the noise layer (0 = off)
      bgImageId:    null,    // asset id used as tiled background (null = none)
      bgImageSrc:   null,    // data URL of an uploaded background (never sent to server); mutually exclusive with bgImageId
      bgImageScale: 1,       // tile size multiplier for the background image (0.1–4)

      roomShape: 'rect',   // 'rect' | 'circle'

      pendingAssetId: null,

      pendingTextPos: null,

      mouseX: 0,
      mouseY: 0,

      multiSelectedSet: new Set(), // indices of all selected elements
      rubberBand: null,            // { sx, sy, ex, ey } — transient, for rendering

      layers,
      activeLayerIdx: 0,
    };
  };

  let _cur = _make();

  function syncElements() {
    _cur.elements = _cur.layers[_cur.activeLayerIdx].elements;
  }

  function _snapshotLayers() {
    return JSON.stringify(_cur.layers.map(l => ({
      id: l.id, name: l.name, visible: l.visible, locked: l.locked,
      elements: l.elements,
    })));
  }

  function _restoreLayers(json) {
    return JSON.parse(json).map(l => ({
      id: l.id, name: l.name, visible: l.visible, locked: l.locked,
      elements: l.elements,
    }));
  }

  return {
    get current() { return _cur; },

    syncElements,

    setActiveLayer(idx) {
      if (idx < 0 || idx >= _cur.layers.length) return;
      _cur.activeLayerIdx = idx;
      _cur.selectedIdx    = -1;
      _cur.multiSelectedSet.clear();
      syncElements();
    },

    addLayer() {
      const id = Date.now();
      _cur.layers.push(_makeLayer(id, `Layer ${_cur.layers.length + 1}`));
    },

    removeLayer(idx) {
      if (_cur.layers.length <= 1) return; // must keep at least one
      _cur.layers.splice(idx, 1);
      if (_cur.activeLayerIdx >= _cur.layers.length) {
        _cur.activeLayerIdx = _cur.layers.length - 1;
      }
      _cur.selectedIdx = -1;
      syncElements();
    },

    moveLayerUp(idx) {
      if (idx <= 0) return;
      [_cur.layers[idx - 1], _cur.layers[idx]] = [_cur.layers[idx], _cur.layers[idx - 1]];
      if (_cur.activeLayerIdx === idx)       _cur.activeLayerIdx = idx - 1;
      else if (_cur.activeLayerIdx === idx - 1) _cur.activeLayerIdx = idx;
    },

    moveLayerDown(idx) {
      if (idx >= _cur.layers.length - 1) return;
      [_cur.layers[idx], _cur.layers[idx + 1]] = [_cur.layers[idx + 1], _cur.layers[idx]];
      if (_cur.activeLayerIdx === idx)       _cur.activeLayerIdx = idx + 1;
      else if (_cur.activeLayerIdx === idx + 1) _cur.activeLayerIdx = idx;
    },

    renameLayer(idx, name) {
      if (_cur.layers[idx]) _cur.layers[idx].name = name;
    },

    toggleLayerVisibility(idx) {
      if (_cur.layers[idx]) _cur.layers[idx].visible = !_cur.layers[idx].visible;
    },

    toggleLayerLocked(idx) {
      if (_cur.layers[idx]) _cur.layers[idx].locked = !_cur.layers[idx].locked;
    },

    visibleElements() {
      return _cur.layers.filter(l => l.visible).flatMap(l => l.elements);
    },

    saveHistory() {
      _cur.history.push(_snapshotLayers());
      if (_cur.history.length > 60) _cur.history.shift();
    },

    undo() {
      if (!_cur.history.length) return false;
      _cur.layers = _restoreLayers(_cur.history.pop());
      if (_cur.activeLayerIdx >= _cur.layers.length) {
        _cur.activeLayerIdx = _cur.layers.length - 1;
      }
      _cur.selectedIdx      = -1;
      _cur.multiSelectedSet = new Set();
      syncElements();
      return true;
    },

    clearMap() {
      this.saveHistory();
      for (const layer of _cur.layers) layer.elements = [];
      _cur.selectedIdx = -1;
      _cur.multiSelectedSet.clear();
      syncElements();
    },

    newMap() {
      const assets = _cur.assets.slice();
      _cur = _make();
      _cur.assets = assets;
      syncElements();
    },

    addElement(el) {
      if (_cur.layers[_cur.activeLayerIdx].locked) return;
      this.saveHistory();
      _cur.elements.push(el);
      DM.track?.('element_added', { type: el.type });
    },

    removeElementAt(idx) {
      if (_cur.layers[_cur.activeLayerIdx].locked) return;
      this.saveHistory();
      _cur.elements.splice(idx, 1);
      if      (_cur.selectedIdx === idx) _cur.selectedIdx = -1;
      else if (_cur.selectedIdx  >  idx) _cur.selectedIdx--;
      const newMs = new Set();
      for (const i of _cur.multiSelectedSet) {
        if      (i < idx) newMs.add(i);
        else if (i > idx) newMs.add(i - 1);
      }
      _cur.multiSelectedSet = newMs;
    },

    updateElement(idx, patch) {
      Object.assign(_cur.elements[idx], patch);
    },

    serialize() {
      return JSON.stringify({
        version:        3,
        gridType:      _cur.gridType,
        cellSize:      _cur.cellSize,
        gridColor:     _cur.gridColor,
        gridLineWidth: _cur.gridLineWidth,
        gridOpacity:   _cur.gridOpacity,
        mapW:           _cur.mapW,
        mapH:           _cur.mapH,
        bgColor:        _cur.bgColor,
        bgNoise:        _cur.bgNoise,
        bgImageId:      _cur.bgImageId,
        bgImageSrc:     _cur.bgImageSrc,
        bgImageScale:   _cur.bgImageScale,
        layers:         _cur.layers.map(l => ({
          id: l.id, name: l.name, visible: l.visible, locked: l.locked,
          elements: l.elements,
        })),
        activeLayerIdx: _cur.activeLayerIdx,
        assets:         _cur.assets.map(a => ({
          id:         a.id,
          name:       a.name,
          src:        a.src,
          categoryId: a.categoryId ?? null,
          isSystem:   a.isSystem   ?? 0,
        })),
      }, null, 2);
    },

    deserialize(json) {
      let data;
      try {
        data = JSON.parse(json);
      } catch {
        throw new Error('Save file is corrupted or in an unrecognised format.');
      }
      if (!data || typeof data !== 'object') {
        throw new Error('Save file is corrupted or in an unrecognised format.');
      }
      _cur = _make();
      _cur.gridType      = data.gridType      || 'square';
      _cur.cellSize      = data.cellSize      || 36;
      _cur.gridColor     = data.gridColor     || '#6e4819';
      _cur.gridLineWidth = data.gridLineWidth ?? 0.5;
      _cur.gridOpacity   = data.gridOpacity   ?? 0.15;
      _cur.mapW     = Number(data.mapW) || 1800;
      _cur.mapH     = Number(data.mapH) || 1300;
      _cur.bgColor  = data.bgColor  || null;
      _cur.bgNoise  = data.bgNoise  ?? 1;   // ?? preserves 0 (silence)
      _cur.bgImageId    = data.bgImageId    ?? null;
      _cur.bgImageSrc   = data.bgImageSrc   || null;
      _cur.bgImageScale = data.bgImageScale ?? 1;
      _cur.assets   = data.assets   || [];

      if (data.elements && !data.layers) {
        _cur.layers = [_makeLayer(0, 'Layer 1')];
        _cur.layers[0].elements = data.elements;
        _cur.activeLayerIdx     = 0;
      } else if (data.layers && data.layers.length) {
        _cur.layers = data.layers.map(l => ({
          id: l.id, name: l.name, visible: l.visible !== false,
          locked: l.locked || false, elements: l.elements || [],
        }));
        _cur.activeLayerIdx = Math.min(
          data.activeLayerIdx || 0, _cur.layers.length - 1
        );
      }
      syncElements();
    },

    addAsset(asset) { _cur.assets.push(asset); },

    removeAsset(id) {
      _cur.assets = _cur.assets.filter(a => a.id !== id);
      for (const layer of _cur.layers) {
        layer.elements = layer.elements.filter(
          el => !(el.type === 'image' && el.assetId === id)
        );
      }
      syncElements();
    },

    getAsset(id) {
      return _cur.assets.find(a => a.id === id) || null;
    },
  };
})();

'use strict';
window.DM = window.DM || {};

DM.RNG = class RNG {
  constructor(seed) { this.s = (seed >>> 0) || 1337; }

  next() {
    this.s = Math.imul(this.s ^ (this.s >>> 15), 0xd168aaad);
    this.s ^= this.s << 5;
    this.s = Math.imul(this.s ^ (this.s >>> 16), 0x11e8b01b);
    this.s ^= this.s << 7;
    return (this.s >>> 0) / 0xffffffff;
  }

  jitter(amp) { return (this.next() - 0.5) * 2 * amp; }
};

DM.cellRNG = function cellRNG(gx, gy) {
  let s = ((gx * 73856093) ^ (gy * 19349663)) >>> 0;
  return {
    next() {
      s = Math.imul(s ^ (s >>> 15), 0xd168aaad);
      s ^= s << 5;
      s = Math.imul(s ^ (s >>> 16), 0x11e8b01b);
      s ^= s << 7;
      return (s >>> 0) / 0xffffffff;
    },
    jitter(amp) { return (this.next() - 0.5) * 2 * amp; },
  };
};

DM.rng = new DM.RNG(1337);

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

let _bgCanvas = null;
let _bgKey    = null;

let _upImg     = null;
let _upSrc     = null;
let _upVersion = 0;   // bumps on every uploaded-image change (used as a cheap cache key)

function _bgImageFrame(st) {
  if (st.bgImageId != null) {
    return DM.getAnimFrame(DM.State.getAsset(st.bgImageId)) || null;
  }
  if (st.bgImageSrc) {
    if (_upSrc !== st.bgImageSrc) {
      _upSrc = st.bgImageSrc;
      _upVersion++;
      _upImg = new Image();
      _upImg.onload  = () => { DM.Renderer.render(); };
      _upImg.onerror = () => { DM.toast?.('Could not load the background image.', true); };
      _upImg.src     = st.bgImageSrc;
    }
    return (_upImg && _upImg.complete && _upImg.naturalWidth) ? _upImg : null;
  }
  return null;
}

function _bgIsAnimated(st) {
  if (st.bgImageId == null) return false;
  const asset = DM.State.getAsset(st.bgImageId);
  if (!asset) return false;
  if (DM.isVideoAsset && DM.isVideoAsset(asset)) return true;
  return !!(asset._gifFrames && asset._gifFrames.length > 1);
}

let _bgImgCanvas = null;
let _bgImgKey    = null;

DM.Draw.background = function drawBackground(ctx, W, H) {
  const st      = DM.State.current;

  const bgFrame = _bgImageFrame(st);
  if (bgFrame) {
    const s = st.bgImageScale ?? 1;

    if (_bgIsAnimated(st)) {
      const pat = ctx.createPattern(bgFrame, 'repeat');
      if (s !== 1) pat.setTransform(new DOMMatrix().scale(s, s));
      ctx.save();
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }

    const idKey = st.bgImageId != null ? 'a' + st.bgImageId : 's' + _upVersion;
    const key   = `${W}|${H}|${s}|${idKey}|${bgFrame.width}x${bgFrame.height}`;
    if (_bgImgKey !== key) {
      if (!_bgImgCanvas) _bgImgCanvas = document.createElement('canvas');
      if (_bgImgCanvas.width !== W || _bgImgCanvas.height !== H) {
        _bgImgCanvas.width  = W;
        _bgImgCanvas.height = H;
      }
      const oc  = _bgImgCanvas.getContext('2d');
      const pat = oc.createPattern(bgFrame, 'repeat');
      if (s !== 1) pat.setTransform(new DOMMatrix().scale(s, s));
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.clearRect(0, 0, W, H);
      oc.fillStyle = pat;
      oc.fillRect(0, 0, W, H);
      _bgImgKey = key;
    }
    ctx.drawImage(_bgImgCanvas, 0, 0);
    return;
  }

  const bgColor = st.bgColor;
  const bgNoise = st.bgNoise ?? 1;
  const key     = `${W}|${H}|${bgColor ?? ''}|${bgNoise}`;

  if (_bgKey !== key) {
    if (!_bgCanvas || _bgCanvas.width !== W || _bgCanvas.height !== H) {
      _bgCanvas        = document.createElement('canvas');
      _bgCanvas.width  = W;
      _bgCanvas.height = H;
    }
    _bgKey = key;

    const offCtx = _bgCanvas.getContext('2d');
    const rng    = new DM.RNG(0xb47e1); // dedicated seed — never touches DM.rng

    if (bgColor) {
      offCtx.fillStyle = bgColor;
      offCtx.fillRect(0, 0, W, H);

      if (bgNoise > 0) {
        offCtx.save();
        offCtx.globalAlpha = 0.08 * bgNoise;
        offCtx.fillStyle   = '#000000';
        for (let i = 0; i < 2800; i++) {
          offCtx.fillRect(rng.next() * W, rng.next() * H, rng.next() * 2.2, rng.next() * 2.2);
        }
        offCtx.restore();
      }

    } else {
      const bg = offCtx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0,    '#fbf9f4');
      bg.addColorStop(0.4,  '#f1ede2');
      bg.addColorStop(0.75, '#f6f2e9');
      bg.addColorStop(1,    '#e9e3d4');
      offCtx.fillStyle = bg;
      offCtx.fillRect(0, 0, W, H);

      offCtx.save();
      offCtx.strokeStyle = 'rgba(120,105,80,.06)';
      offCtx.lineWidth   = 0.65;
      for (let i = -H; i < W + H; i += 5.5) {
        offCtx.beginPath();
        offCtx.moveTo(i, 0);
        offCtx.lineTo(i + H, H);
        offCtx.stroke();
      }
      offCtx.restore();

      if (bgNoise > 0) {
        offCtx.save();
        offCtx.globalAlpha = 0.05 * bgNoise;
        offCtx.fillStyle   = '#4a4238';
        for (let i = 0; i < 2800; i++) {
          offCtx.fillRect(rng.next() * W, rng.next() * H, rng.next() * 2.2, rng.next() * 2.2);
        }
        offCtx.restore();
      }
    }

    const vg = offCtx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.88);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(20,18,15,.16)');
    offCtx.fillStyle = vg;
    offCtx.fillRect(0, 0, W, H);
  }

  ctx.drawImage(_bgCanvas, 0, 0);
};

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

DM.Draw.squareGrid = function(ctx, W, H, cellSize, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;
  for (let x = 0; x <= W; x += cellSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y <= H; y += cellSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
};

DM.Draw.hexGrid = function(ctx, W, H, cellSize, color, lineWidth) {
  const s         = cellSize / 2;               // center→vertex radius
  const hexH      = Math.sqrt(3) * s;           // flat-to-flat height
  const colStep   = cellSize * 0.75;            // horizontal center spacing

  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;

  for (let col = 0; col * colStep < W + cellSize; col++) {
    const yOff = (col % 2 === 1) ? hexH / 2 : 0;
    for (let row = -1; row * hexH + yOff < H + hexH; row++) {
      const cx = col * colStep + s;
      const cy = row * hexH + yOff + hexH / 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const vx = cx + s * Math.cos(a);
        const vy = cy + s * Math.sin(a);
        i === 0 ? ctx.moveTo(vx, vy) : ctx.lineTo(vx, vy);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
};

DM.Draw.grid = function(ctx, W, H, cellSize, gridType) {
  if (gridType === 'none') return;
  const st      = DM.State.current;
  const color   = st.gridColor     ?? '#6e4819';
  const lw      = st.gridLineWidth ?? 0.5;
  const opacity = st.gridOpacity   ?? 0.15;
  ctx.save();
  ctx.globalAlpha = opacity;
  if      (gridType === 'square') DM.Draw.squareGrid(ctx, W, H, cellSize, color, lw);
  else if (gridType === 'hex')    DM.Draw.hexGrid(ctx, W, H, cellSize, color, lw);
  ctx.restore();
};

DM.snapSquare = function(px, py, cellSize) {
  return {
    x: Math.round(px / cellSize) * cellSize,
    y: Math.round(py / cellSize) * cellSize,
  };
};

DM.snapHex = function(px, py, cellSize) {
  const s       = cellSize / 2;
  const hexH    = Math.sqrt(3) * s;
  const colStep = cellSize * 0.75;

  const col    = Math.round((px - s) / colStep);
  const safeC  = Math.max(0, col);
  const yOff   = (safeC % 2 === 1) ? hexH / 2 : 0;
  const row    = Math.round((py - hexH / 2 - yOff) / hexH);

  return {
    x: safeC * colStep + s,
    y: row * hexH + yOff + hexH / 2,
  };
};

DM.snap = function(px, py) {
  const { gridType, cellSize } = DM.State.current;
  if (gridType === 'hex') return DM.snapHex(px, py, cellSize);
  return DM.snapSquare(px, py, cellSize);
};

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

DM.isVideoAsset = function(asset) {
  const src = asset?.src || '';
  return /\.(webm|mp4)(\?|$)/i.test(src) || /^data:video\//i.test(src);
};

DM.getAnimFrame = function(asset) {
  if (!asset) return null;
  if (asset._video && asset._video.readyState >= 2) return asset._video;
  if (asset._gifFrames?.length) return asset._gifFrames[asset._gifIdx ?? 0].bitmap;
  return asset._img ?? null;
};

DM.drawableSize = function(d) {
  return {
    w: d?.videoWidth  || d?.naturalWidth  || d?.width  || 0,
    h: d?.videoHeight || d?.naturalHeight || d?.height || 0,
  };
};

DM.normalizeRect = function(x, y, w, h) {
  return {
    x: w >= 0 ? x : x + w,
    y: h >= 0 ? y : y + h,
    w: Math.abs(w),
    h: Math.abs(h),
  };
};

DM.elementRect = function(el) {
  if (el.type === 'wall') {
    return {
      x: Math.min(el.x, el.x2), y: Math.min(el.y, el.y2),
      w: Math.max(1, Math.abs(el.x2 - el.x)),
      h: Math.max(1, Math.abs(el.y2 - el.y)),
    };
  }
  if (el.type === 'fog') {
    const ox = el.x || 0, oy = el.y || 0;
    if (!el.puffs?.length) return { x: ox, y: oy, w: 1, h: 1 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of el.puffs) {
      const rx = p.r, ry = p.r * (p.squash ?? 1);
      x0 = Math.min(x0, ox + p.bx - rx); y0 = Math.min(y0, oy + p.by - ry);
      x1 = Math.max(x1, ox + p.bx + rx); y1 = Math.max(y1, oy + p.by + ry);
    }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }
  if (DM.Config.POINT_TOOLS.has(el.type) && el.w && el.h) {
    return { x: el.x - el.w / 2, y: el.y - el.h / 2, w: el.w, h: el.h };
  }
  return DM.normalizeRect(el.x, el.y, el.w || 0, el.h || 0);
};

DM.elementCenter = function(el) {
  if (el.type === 'wall') return { x: (el.x + el.x2) / 2, y: (el.y + el.y2) / 2 };
  if (DM.Config.POINT_TOOLS.has(el.type) || el.type === 'text') return { x: el.x, y: el.y };
  const r = DM.elementRect(el);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

DM.Draw.roughLine = function(ctx, x1, y1, x2, y2, opts = {}) {
  const { rough = 1.5, color = '#0a0300', lw = 2.6, reps = 2 } = opts;
  const rng   = DM.rng;
  const dx    = x2 - x1, dy = y2 - y1;
  const steps = Math.max(3, Math.floor(Math.hypot(dx, dy) / 14));

  for (let r = 0; r < reps; r++) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = lw - r * 0.6;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.moveTo(x1 + rng.jitter(rough), y1 + rng.jitter(rough));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(
        x1 + dx * t + rng.jitter(rough + r * 0.35),
        y1 + dy * t + rng.jitter(rough + r * 0.35)
      );
    }
    ctx.stroke();
  }
};

DM.Draw.roughCircle = function(ctx, cx, cy, r, opts = {}) {
  const { rough = 1.5, color = '#0a0300', lw = 2, fill = null } = opts;
  const rng   = DM.rng;
  const steps = 36;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a  = (i / steps) * Math.PI * 2;
    const rr = r + rng.jitter(rough);
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.stroke();
};

DM.Draw.roughRect = function(ctx, x, y, w, h, opts = {}) {
  const rl = DM.Draw.roughLine;
  rl(ctx, x,   y,   x+w, y,   opts);
  rl(ctx, x+w, y,   x+w, y+h, opts);
  rl(ctx, x+w, y+h, x,   y+h, opts);
  rl(ctx, x,   y+h, x,   y,   opts);
};

function _computeCellGrid(elems, cs, floorSet) {
  const cells = {};
  for (let pass = 0; pass < 2; pass++) {
    for (const el of elems) {
      if (!floorSet.has(el.type)) continue;
      const isCircle = el.shape === 'circle';
      if (pass === 0 && !isCircle) continue;
      if (pass === 1 &&  isCircle) continue;

      const { x, y, w, h } = DM.elementRect(el);
      if (w < 1 || h < 1) continue;

      const gx0 = Math.round(x / cs), gy0 = Math.round(y / cs);
      const gx1 = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);
      const ecx = (gx0 + gx1) / 2, ecy = (gy0 + gy1) / 2;
      const erx = (gx1 - gx0) / 2 || 0.5, ery = (gy1 - gy0) / 2 || 0.5;

      for (let gx = gx0; gx < gx1; gx++) {
        for (let gy = gy0; gy < gy1; gy++) {
          if (isCircle) {
            const dx = (gx + 0.5 - ecx) / erx;
            const dy = (gy + 0.5 - ecy) / ery;
            if (dx * dx + dy * dy > 1) continue;
          }
          cells[`${gx},${gy}`] = el;
        }
      }
    }
  }
  return cells;
}

const _cellGridMemo = new WeakMap(); // elements[] → { sig, cells }
DM.buildCellGrid = function(elements) {
  const cs       = DM.State.current.cellSize;
  const floorSet = DM.Config.FLOOR_TYPES;
  const elems    = elements || DM.State.visibleElements();

  if (!elements) return _computeCellGrid(elems, cs, floorSet);

  let sig = cs + '|';
  for (const el of elems) {
    if (!floorSet.has(el.type)) continue;
    sig += (el.shape === 'circle' ? 'c' : 'r') + el.type
         + el.x + '_' + el.y + '_' + el.w + '_' + el.h + ';';
  }
  const memo = _cellGridMemo.get(elements);
  if (memo && memo.sig === sig) return memo.cells;

  const cells = _computeCellGrid(elems, cs, floorSet);
  _cellGridMemo.set(elements, { sig, cells });
  return cells;
};

DM.buildWalls = function(cells) {
  const cs = DM.State.current.cellSize;
  const hEdges = {}, vEdges = {};

  const addH = (k, v) => { (hEdges[k] || (hEdges[k] = [])).push(v); };
  const addV = (k, v) => { (vEdges[k] || (vEdges[k] = [])).push(v); };

  for (const key of Object.keys(cells)) {
    const [gx, gy] = key.split(',').map(Number);
    if (!cells[`${gx},${gy-1}`]) addH(`${gy}_T`, gx);
    if (!cells[`${gx},${gy+1}`]) addH(`${gy}_B`, gx);
    if (!cells[`${gx-1},${gy}`]) addV(`${gx}_L`, gy);
    if (!cells[`${gx+1},${gy}`]) addV(`${gx}_R`, gy);
  }

  const mergeRuns = arr => {
    if (!arr.length) return [];
    arr.sort((a, b) => a - b);
    const runs = []; let s = arr[0], e = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === e + 1) e = arr[i];
      else { runs.push([s, e]); s = e = arr[i]; }
    }
    runs.push([s, e]);
    return runs;
  };

  const hSegs = [], vSegs = [];

  for (const [k, arr] of Object.entries(hEdges)) {
    const [gys, sd] = k.split('_');
    const gy = +gys;
    const py = sd === 'T' ? gy * cs : (gy + 1) * cs;
    const hd = sd === 'T' ? -1 : 1;
    for (const [s, e] of mergeRuns(arr)) hSegs.push({ x1: s * cs, x2: (e + 1) * cs, y: py, hd });
  }
  for (const [k, arr] of Object.entries(vEdges)) {
    const [gxs, sd] = k.split('_');
    const gx = +gxs;
    const px = sd === 'L' ? gx * cs : (gx + 1) * cs;
    const hd = sd === 'L' ? -1 : 1;
    for (const [s, e] of mergeRuns(arr)) vSegs.push({ y1: s * cs, y2: (e + 1) * cs, x: px, hd });
  }
  return { hSegs, vSegs };
};

DM.Draw.bgFillElements = function(ctx, elems) {
  const st = DM.State.current;
  for (const el of elems) {
    if (el.type !== 'bg-fill') continue;
    ctx.save();
    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
    let fillStyle = el.color || '#eedfa0';
    if (el.fillAssetId) {
      const asset = DM.State.getAsset(el.fillAssetId);
      const frame = DM.getAnimFrame(asset);
      if (frame) {
        const pat = ctx.createPattern(frame, 'repeat');
        const s = el.fillAssetScale ?? 1;
        if (s !== 1) pat.setTransform(new DOMMatrix().scale(s, s));
        fillStyle = pat;
      }
    }
    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, st.mapW, st.mapH);
    ctx.restore();
  }
};

function _drawStoneTexture(ctx, gx, gy, cs, intensity, rgb) {
  const cr = DM.cellRNG(gx * 7 + 3001, gy * 7 + 3001);
  const px = gx * cs, py = gy * cs;
  const [ir, ig, ib] = rgb;

  ctx.save();
  ctx.lineCap = 'round';

  const drawMortar = (x1, y1, x2, y2, mult = 1.0) => {
    const alpha = (0.22 + cr.next() * 0.55) * intensity * mult;
    if (alpha < 0.04) return; // some lines nearly invisible — intentional
    const lw    = (0.5 + cr.next() * 0.75) * (0.7 + 0.5 * intensity);
    const dx    = x2 - x1, dy = y2 - y1;
    const total = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.floor(total / 5));
    for (let rep = 0; rep < 2; rep++) {
      ctx.strokeStyle = `rgba(${ir},${ig},${ib},${alpha * (rep === 0 ? 1 : 0.30)})`;
      ctx.lineWidth   = lw - rep * 0.25;
      ctx.beginPath();
      ctx.moveTo(x1 + cr.jitter(1.0), y1 + cr.jitter(1.0));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        ctx.lineTo(x1 + dx * t + cr.jitter(0.9), y1 + dy * t + cr.jitter(0.9));
      }
      ctx.stroke();
    }
  };

  const fillBlock = (sx, sy, sw, sh) => {
    const tint = cr.next() * 0.11 * intensity;
    if (tint > 0.005) {
      ctx.fillStyle = `rgba(${ir},${ig},${ib},${tint})`;
      ctx.fillRect(sx + 1, sy + 1, sw - 2, sh - 2);
    }
    const bv = Math.max(1.5, Math.min(sw, sh) * 0.13);
    let g;
    g = ctx.createLinearGradient(sx, sy, sx, sy + bv);
    g.addColorStop(0, `rgba(255,252,235,${0.20 * intensity})`);
    g.addColorStop(1, 'rgba(255,252,235,0)');
    ctx.fillStyle = g; ctx.fillRect(sx + 1, sy + 1, sw - 2, bv);

    g = ctx.createLinearGradient(sx, sy, sx + bv, sy);
    g.addColorStop(0, `rgba(255,252,235,${0.14 * intensity})`);
    g.addColorStop(1, 'rgba(255,252,235,0)');
    ctx.fillStyle = g; ctx.fillRect(sx + 1, sy + 1, bv, sh - 2);

    g = ctx.createLinearGradient(sx, sy + sh, sx, sy + sh - bv);
    g.addColorStop(0, `rgba(${ir},${ig},${ib},${0.18 * intensity})`);
    g.addColorStop(1, `rgba(${ir},${ig},${ib},0)`);
    ctx.fillStyle = g; ctx.fillRect(sx + 1, sy + sh - bv, sw - 2, bv);

    g = ctx.createLinearGradient(sx + sw, sy, sx + sw - bv, sy);
    g.addColorStop(0, `rgba(${ir},${ig},${ib},${0.14 * intensity})`);
    g.addColorStop(1, `rgba(${ir},${ig},${ib},0)`);
    ctx.fillStyle = g; ctx.fillRect(sx + sw - bv, sy + 1, bv, sh - 2);
  };

  const stipple = (sx, sy, sw, sh) => {
    const nDots = 2 + Math.floor(cr.next() * (3 + intensity * 4));
    for (let i = 0; i < nDots; i++) {
      ctx.fillStyle = `rgba(${ir},${ig},${ib},${(0.07 + 0.18 * cr.next()) * intensity})`;
      ctx.beginPath();
      ctx.arc(
        sx + 2 + cr.next() * Math.max(1, sw - 4),
        sy + 2 + cr.next() * Math.max(1, sh - 4),
        0.3 + cr.next() * 1.3 * intensity, 0, Math.PI * 2
      );
      ctx.fill();
    }
    const nMarks = 1 + Math.floor(cr.next() * 3);
    for (let i = 0; i < nMarks; i++) {
      const mx = sx + 2 + cr.next() * Math.max(1, sw - 4);
      const my = sy + 2 + cr.next() * Math.max(1, sh - 4);
      const len = 1.5 + cr.next() * 4.5;
      const ang = cr.next() * Math.PI;
      ctx.strokeStyle = `rgba(${ir},${ig},${ib},${(0.05 + 0.08 * cr.next()) * intensity})`;
      ctx.lineWidth   = 0.4;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx + Math.cos(ang) * len, my + Math.sin(ang) * len);
      ctx.stroke();
    }
  };

  const layout = cr.next();

  const drawOuter = () => {
    drawMortar(px,      py,      px + cs, py     );
    drawMortar(px + cs, py,      px + cs, py + cs);
    drawMortar(px + cs, py + cs, px,      py + cs);
    drawMortar(px,      py + cs, px,      py     );
  };

  if (layout < 0.40) {
    fillBlock(px, py, cs, cs);
    drawOuter();
    stipple(px, py, cs, cs);

  } else if (layout < 0.62) {
    const t  = 0.32 + cr.next() * 0.36;
    const sy = py + cs * t;
    fillBlock(px, py, cs, cs * t);
    fillBlock(px, sy, cs, cs * (1 - t));
    drawOuter();
    drawMortar(px + 2, sy, px + cs - 2, sy, 0.85);
    stipple(px, py, cs, cs * t);
    stipple(px, sy, cs, cs * (1 - t));

  } else if (layout < 0.84) {
    const t  = 0.32 + cr.next() * 0.36;
    const sx = px + cs * t;
    fillBlock(px, py, cs * t, cs);
    fillBlock(sx, py, cs * (1 - t), cs);
    drawOuter();
    drawMortar(sx, py + 2, sx, py + cs - 2, 0.85);
    stipple(px, py, cs * t, cs);
    stipple(sx, py, cs * (1 - t), cs);

  } else {
    if (cr.next() < 0.5) {
      const hy = py + cs * (0.38 + cr.next() * 0.24);
      const vx = px + cs * (0.33 + cr.next() * 0.34);
      fillBlock(px, py, vx - px, hy - py);
      fillBlock(vx, py, px + cs - vx, hy - py);
      fillBlock(px, hy, cs, py + cs - hy);
      drawOuter();
      drawMortar(px + 1, hy, px + cs - 1, hy, 0.85);
      drawMortar(vx, py + 1, vx, hy - 1, 0.80);
      stipple(px, py, vx - px, hy - py);
      stipple(vx, py, px + cs - vx, hy - py);
      stipple(px, hy, cs, py + cs - hy);
    } else {
      const vx = px + cs * (0.38 + cr.next() * 0.24);
      const hy = py + cs * (0.33 + cr.next() * 0.34);
      fillBlock(px, py, vx - px, cs);
      fillBlock(vx, py, px + cs - vx, hy - py);
      fillBlock(vx, hy, px + cs - vx, py + cs - hy);
      drawOuter();
      drawMortar(vx, py + 1, vx, py + cs - 1, 0.85);
      drawMortar(vx + 1, hy, px + cs - 1, hy, 0.80);
      stipple(px, py, vx - px, cs);
      stipple(vx, py, px + cs - vx, hy - py);
      stipple(vx, hy, px + cs - vx, py + cs - hy);
    }
  }

  ctx.restore();
}

function _drawStoneEdge(ctx, gx, gy, cs, intensity, borderMask, rgb) {
  if (!borderMask) return;
  const px = gx * cs, py = gy * cs;
  const sz = Math.min(cs * 0.55, 4 + 9 * intensity);
  const al = 0.22 * intensity;
  const [r, g, b] = rgb;
  const col0 = `rgba(${r},${g},${b},${al})`, col1 = `rgba(${r},${g},${b},0)`;

  ctx.save();
  if (borderMask & 1) {
    const gr = ctx.createLinearGradient(px, py, px, py + sz);
    gr.addColorStop(0, col0); gr.addColorStop(1, col1);
    ctx.fillStyle = gr; ctx.fillRect(px, py, cs, sz);
  }
  if (borderMask & 2) {
    const gr = ctx.createLinearGradient(px, py + cs, px, py + cs - sz);
    gr.addColorStop(0, col0); gr.addColorStop(1, col1);
    ctx.fillStyle = gr; ctx.fillRect(px, py + cs - sz, cs, sz);
  }
  if (borderMask & 4) {
    const gr = ctx.createLinearGradient(px, py, px + sz, py);
    gr.addColorStop(0, col0); gr.addColorStop(1, col1);
    ctx.fillStyle = gr; ctx.fillRect(px, py, sz, cs);
  }
  if (borderMask & 8) {
    const gr = ctx.createLinearGradient(px + cs, py, px + cs - sz, py);
    gr.addColorStop(0, col0); gr.addColorStop(1, col1);
    ctx.fillStyle = gr; ctx.fillRect(px + cs - sz, py, sz, cs);
  }
  ctx.restore();
}

function _parseHexRGB(hex) {
  const c = (hex || '#000000').replace('#', '').padEnd(6, '0');
  return [parseInt(c.slice(0, 2), 16) || 0,
          parseInt(c.slice(2, 4), 16) || 0,
          parseInt(c.slice(4, 6), 16) || 0];
}

function _drawWallBlock(ctx, bx, by, bw, bh, rng, intensity, rgb) {
  if (bw < 2 || bh < 2) return;
  const r         = Math.min(bw, bh) * 0.22;
  const [cr, cg, cb] = rgb;

  const tint  = Math.floor(rng.next() * 28) - 10;
  const fr    = Math.max(0, Math.min(255, cr + tint));
  const fg    = Math.max(0, Math.min(255, cg + tint));
  const fb    = Math.max(0, Math.min(255, cb + tint));
  const alpha = 0.72 + rng.next() * 0.22;

  const p = new Path2D();
  p.roundRect(bx, by, bw, bh, r);

  ctx.fillStyle = `rgba(${fr},${fg},${fb},${alpha})`;
  ctx.fill(p);

  const cx  = bx + bw / 2, cy = by + bh / 2;
  const rad = Math.hypot(bw, bh) / 2;
  const vig = ctx.createRadialGradient(cx, cy, rad * 0.10, cx, cy, rad * 0.95);
  vig.addColorStop(0,    'rgba(255,255,255,0.09)');
  vig.addColorStop(0.50, 'rgba(0,0,0,0)');
  vig.addColorStop(1,   `rgba(0,0,0,${0.50 * intensity})`);
  ctx.fillStyle = vig;
  ctx.fill(p);

  if (bh > 3 && rng.next() < 0.50) {
    const hAl    = (0.07 + rng.next() * 0.09) * intensity;
    const innerY = by + bh;
    const g      = ctx.createLinearGradient(bx, innerY, bx, innerY - bh * 0.45);
    g.addColorStop(0, `rgba(255,252,230,${hAl})`);
    g.addColorStop(1, 'rgba(255,252,230,0)');
    ctx.fillStyle = g;
    const ph = new Path2D();
    ph.roundRect(bx + 1, innerY - bh * 0.44, bw - 2, bh * 0.42, r * 0.4);
    ctx.fill(ph);
  }
}

DM.Draw.floors = function(ctx, cells, elems) {
  const cs = DM.State.current.cellSize;

  const _fillPatterns = new Map();
  function _fillStyle(el, defaultColor) {
    if (!el.fillAssetId) return el.color || defaultColor;
    const asset = DM.State.getAsset(el.fillAssetId);
    const frame = DM.getAnimFrame(asset);
    if (!frame) return el.color || defaultColor;
    const key = el.fillAssetId + '_' + (el.fillAssetScale ?? 1);
    if (!_fillPatterns.has(key)) {
      const pat = ctx.createPattern(frame, 'repeat');
      const s = el.fillAssetScale ?? 1;
      if (s !== 1 && pat) pat.setTransform(new DOMMatrix().scale(s, s));
      _fillPatterns.set(key, pat);
    }
    return _fillPatterns.get(key) || el.color || defaultColor;
  }

  if (elems) {
    const floorSet = DM.Config.FLOOR_TYPES;
    for (const el of elems) {
      if (!floorSet.has(el.type) || el.shape !== 'circle') continue;
      if (el.type === 'water' || el.type === 'pit') continue;
      const { x, y, w, h } = DM.elementRect(el);
      if (w < 1 || h < 1) continue;

      const ecx = x + w / 2, ecy = y + h / 2;
      const erx = w / 2, ery = h / 2;
      const gx0 = Math.round(x / cs), gy0 = Math.round(y / cs);
      const gx1 = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);

      ctx.save();
      ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
      ctx.beginPath();
      ctx.ellipse(ecx, ecy, erx, ery, 0, 0, Math.PI * 2);
      ctx.clip();
      const isInkCircle = el.type === 'room' && el.stoneStyle === 'ink';
      const intensity   = isInkCircle ? (el.stoneIntensity ?? 0.5) : 0;
      ctx.fillStyle = isInkCircle ? (el.color || '#f5f3ee') : _fillStyle(el, '#eedfa0');
      ctx.fill();

      const inkRgbCircle = isInkCircle ? _parseHexRGB(el.borderColor || '#292929') : null;
      for (let gx = gx0; gx < gx1; gx++) {
        for (let gy = gy0; gy < gy1; gy++) {
          const dx = (gx + 0.5 - (gx0 + gx1) / 2) / ((gx1 - gx0) / 2 || 0.5);
          const dy = (gy + 0.5 - (gy0 + gy1) / 2) / ((gy1 - gy0) / 2 || 0.5);
          if (!isInkCircle && dx * dx + dy * dy > 1) continue;
          if (isInkCircle) {
            _drawStoneTexture(ctx, gx, gy, cs, intensity, inkRgbCircle);
          } else {
            const cr = DM.cellRNG(gx, gy);
            if (cr.next() < 0.22) {
              ctx.strokeStyle = 'rgba(85,60,22,.16)';
              ctx.lineWidth   = 0.6;
              const cx2 = gx * cs + 8 + cr.next() * (cs - 16);
              const cy2 = gy * cs + 8 + cr.next() * (cs - 16);
              ctx.beginPath();
              ctx.moveTo(cx2, cy2); ctx.lineTo(cx2 + cr.jitter(10), cy2 + cr.jitter(8));
              ctx.stroke();
            }
          }
        }
      }
      ctx.restore();
    }
  }

  try {
    for (const [key, el] of Object.entries(cells)) {
      if (el.type === 'water' || el.type === 'pit') continue;
      if (el.shape === 'circle') continue;

      const [gx, gy] = key.split(',').map(Number);
      const px = gx * cs, py = gy * cs;
      const cr = DM.cellRNG(gx, gy);

      ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;

      const isInkRect = el.type === 'room' && el.stoneStyle === 'ink';
      ctx.fillStyle = isInkRect ? (el.color || '#f5f3ee') : _fillStyle(el, el.type === 'secret' ? '#e0cd88' : '#eedfa0');
      ctx.fillRect(px, py, cs, cs);

      if (!isInkRect) {
        if (el.type !== 'room') {
          ctx.fillStyle = 'rgba(148,112,52,.13)';
          ctx.fillRect(px + 2, py + 2, cs - 4, cs - 4);
          ctx.strokeStyle = 'rgba(105,75,30,.2)';
          ctx.lineWidth   = 0.8;
          ctx.strokeRect(
            px + 2.5 + cr.jitter(0.6), py + 2.5 + cr.jitter(0.6),
            cs - 5   + cr.jitter(0.4), cs - 5   + cr.jitter(0.4)
          );
        }
        if (cr.next() < 0.22) {
          ctx.strokeStyle = 'rgba(85,60,22,.16)';
          ctx.lineWidth   = 0.6;
          const cx2 = px + 8 + cr.next() * (cs - 16);
          const cy2 = py + 8 + cr.next() * (cs - 16);
          ctx.beginPath();
          ctx.moveTo(cx2, cy2); ctx.lineTo(cx2 + cr.jitter(10), cy2 + cr.jitter(8));
          ctx.stroke();
        }
      }

      if (isInkRect) {
        const intensity = el.stoneIntensity ?? 0.5;
        const inkRgb    = _parseHexRGB(el.borderColor || '#292929');
        _drawStoneTexture(ctx, gx, gy, cs, intensity, inkRgb);
        const borderMask =
          (!cells[`${gx},${gy - 1}`] ? 1 : 0) |
          (!cells[`${gx},${gy + 1}`] ? 2 : 0) |
          (!cells[`${gx - 1},${gy}`] ? 4 : 0) |
          (!cells[`${gx + 1},${gy}`] ? 8 : 0);
        _drawStoneEdge(ctx, gx, gy, cs, intensity, borderMask, inkRgb);
      }
    }
  } finally {
    ctx.globalAlpha = 1;
  }
};

DM.Draw.walls = function(ctx, hSegs, vSegs) {
  const T  = DM.Config.WALL_T;
  const hs = 4.5;
  const rl = DM.Draw.roughLine;

  const drawHatch = (x, y, w, h) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = DM.Config.COLORS.wallFill; ctx.fill();
    ctx.strokeStyle = DM.Config.COLORS.wallHatch; ctx.lineWidth = 0.65;
    for (let i = x - T; i < x + w + T; i += hs) {
      ctx.beginPath(); ctx.moveTo(i, y); ctx.lineTo(i + T, y + T); ctx.stroke();
    }
    ctx.restore();
  };

  for (const { x1, x2, y, hd } of hSegs) {
    const ry = hd < 0 ? y - T : y;
    drawHatch(x1, ry, x2 - x1, T);
  }
  for (const { y1, y2, x, hd } of vSegs) {
    const rx = hd < 0 ? x - T : x;
    ctx.save();
    ctx.beginPath(); ctx.rect(rx, y1, T, y2 - y1); ctx.clip();
    ctx.fillStyle = DM.Config.COLORS.wallFill; ctx.fill();
    ctx.strokeStyle = DM.Config.COLORS.wallHatch; ctx.lineWidth = 0.65;
    for (let i = y1 - T; i < y2 + T; i += hs) {
      ctx.beginPath(); ctx.moveTo(rx, i); ctx.lineTo(rx + T, i + T); ctx.stroke();
    }
    ctx.restore();
  }

};

DM.Draw.waterElements = function(ctx, elements) {
  const cs = DM.State.current.cellSize;

  const waterCells = {};
  for (const el of elements) {
    if (el.type !== 'water') continue;
    const { x, y, w, h } = DM.elementRect(el);
    if (w < 1 || h < 1) continue;
    const gx0 = Math.round(x / cs), gy0 = Math.round(y / cs);
    const gx1 = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);
    for (let gx = gx0; gx < gx1; gx++)
      for (let gy = gy0; gy < gy1; gy++)
        waterCells[`${gx},${gy}`] = el;
  }
  const keys = Object.keys(waterCells);
  if (!keys.length) return;

  const outEdges = {};
  const addEdgeW = (fx, fy, tx, ty) => {
    const k = `${fx},${fy}`;
    (outEdges[k] || (outEdges[k] = [])).push([tx, ty]);
  };
  for (const key of keys) {
    const [gx, gy] = key.split(',').map(Number);
    if (!waterCells[`${gx},${gy-1}`]) addEdgeW(gx,   gy,   gx+1, gy  ); // top
    if (!waterCells[`${gx+1},${gy}`]) addEdgeW(gx+1, gy,   gx+1, gy+1); // right
    if (!waterCells[`${gx},${gy+1}`]) addEdgeW(gx+1, gy+1, gx,   gy+1); // bottom
    if (!waterCells[`${gx-1},${gy}`]) addEdgeW(gx,   gy+1, gx,   gy  ); // left
  }

  const usedEdgesW = new Set();
  const loops      = [];
  for (const startKey of Object.keys(outEdges)) {
    for (const [snx, sny] of outEdges[startKey]) {
      const firstEdge = `${startKey}>${snx},${sny}`;
      if (usedEdgesW.has(firstEdge)) continue;

      const loop = [];
      let [cx, cy] = startKey.split(',').map(Number);
      let [nx, ny] = [snx, sny];

      for (let guard = 0; guard < 40000; guard++) {
        usedEdgesW.add(`${cx},${cy}>${nx},${ny}`);
        const cr   = DM.cellRNG(cx, cy);
        const jAmt = cs * 0.11;
        loop.push([cx * cs + cr.jitter(jAmt), cy * cs + cr.jitter(jAmt)]);

        const nxtKey = `${nx},${ny}`;
        if (nxtKey === startKey) break;

        const [prevCx, prevCy] = [cx, cy];
        [cx, cy] = [nx, ny];

        const candidates = (outEdges[nxtKey] || []).filter(
          ([tx, ty]) => !usedEdgesW.has(`${nxtKey}>${tx},${ty}`)
        );
        if (!candidates.length) break;

        if (candidates.length === 1) {
          [nx, ny] = candidates[0];
        } else {
          const [idx, idy] = [cx - prevCx, cy - prevCy];
          let bestCross = -Infinity, bestCand = candidates[0];
          for (const cand of candidates) {
            const cross = idx * (cand[1] - cy) - idy * (cand[0] - cx);
            if (cross > bestCross) { bestCross = cross; bestCand = cand; }
          }
          [nx, ny] = bestCand;
        }
      }

      if (loop.length >= 3) loops.push(loop);
    }
  }
  if (!loops.length) return;

  const tracePath = () => {
    for (const loop of loops) {
      const n = loop.length;
      ctx.moveTo(
        (loop[n - 1][0] + loop[0][0]) / 2,
        (loop[n - 1][1] + loop[0][1]) / 2
      );
      for (let i = 0; i < n; i++) {
        const [cx, cy] = loop[i];
        const [nx, ny] = loop[(i + 1) % n];
        ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
      }
      ctx.closePath();
    }
  };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops)
    for (const [px, py] of loop) {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }

  const repEl   = waterCells[keys[0]];
  const def     = DM.Config.BORDER_DEFAULTS.water;
  const opacity = repEl.opacity !== undefined ? repEl.opacity : 1;
  const base    = repEl.color || 'rgba(62,145,208,.84)';
  const bc      = repEl.borderColor ?? def.color;
  const bw      = repEl.borderWidth ?? def.width;
  const grad    = ctx.createLinearGradient(minX, minY, minX, maxY);
  grad.addColorStop(0, base);
  grad.addColorStop(1, 'rgba(28,72,132,.92)');

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle   = grad;
  ctx.beginPath(); tracePath(); ctx.fill();

  if (bw > 0) {
    ctx.strokeStyle = bc;
    ctx.lineWidth   = bw;
    ctx.beginPath(); tracePath(); ctx.stroke();
  }

  ctx.beginPath(); tracePath(); ctx.clip();

  const rng  = DM.rng;
  const ww   = maxX - minX, wh = maxY - minY;
  const step = Math.max(7, cs * 0.2);
  ctx.strokeStyle = 'rgba(155,222,255,.38)';
  ctx.lineWidth   = 1.1;
  for (let ly = minY + 8; ly < maxY - 8; ly += step) {
    ctx.beginPath();
    let first = true;
    for (let lx = minX + 6; lx < maxX - 6; lx += 5) {
      const wy = Math.sin((lx - minX) * 0.2) * 2.2 + rng.jitter(0.55);
      first ? ctx.moveTo(lx, ly + wy) : ctx.lineTo(lx, ly + wy);
      first = false;
    }
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(220,248,255,.18)';
  ctx.lineWidth   = 2.2;
  for (let i = 0; i < 3; i++) {
    const rx = minX + 10 + rng.next() * Math.max(1, ww - 20);
    const ry = minY +  8 + rng.next() * Math.max(1, wh - 16);
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx + rng.jitter(14), ry + rng.jitter(7));
    ctx.stroke();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
};

DM.Draw.roomBorders = function(ctx, elements) {
  const cs  = DM.State.current.cellSize;
  const def = DM.Config.BORDER_DEFAULTS.room;

  const rectRooms   = elements.filter(el => el.type === 'room' && el.shape !== 'circle');
  const circleRooms = elements.filter(el => el.type === 'room' && el.shape === 'circle');
  if (!rectRooms.length && !circleRooms.length) return;

  const st    = DM.State.current;
  const selEl = (st.selectedIdx >= 0 && st.elements[st.selectedIdx]?.type === 'room')
                  ? st.elements[st.selectedIdx] : null;
  const rng   = DM.rng;
  const clipExpand = 0;

  if (rectRooms.length) {
    const processBorderGroup = (rooms, isInk) => {
      if (!rooms.length) return;
      const repEl   = (selEl && selEl.shape !== 'circle' && rooms.includes(selEl)) ? selEl : rooms[0];
      const bc      = repEl.borderColor ?? def.color;
      const bw      = repEl.borderWidth  ?? def.width;
      const opacity = repEl.opacity !== undefined ? repEl.opacity : 1;
      if (bw <= 0 && !isInk) return;

      const roomCells = {};
      for (const el of rooms) {
        const { x, y, w, h } = DM.elementRect(el);
        if (w < 1 || h < 1) continue;
        const gx0 = Math.round(x / cs), gy0 = Math.round(y / cs);
        const gx1 = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);
        for (let gx = gx0; gx < gx1; gx++)
          for (let gy = gy0; gy < gy1; gy++)
            roomCells[`${gx},${gy}`] = el;
      }

      const outEdges = {};
      const addEdge  = (fx, fy, tx, ty) => {
        const k = `${fx},${fy}`;
        (outEdges[k] || (outEdges[k] = [])).push([tx, ty]);
      };
      for (const key of Object.keys(roomCells)) {
        const [gx, gy] = key.split(',').map(Number);
        if (!roomCells[`${gx},${gy-1}`]) addEdge(gx,   gy,   gx+1, gy  );
        if (!roomCells[`${gx+1},${gy}`]) addEdge(gx+1, gy,   gx+1, gy+1);
        if (!roomCells[`${gx},${gy+1}`]) addEdge(gx+1, gy+1, gx,   gy+1);
        if (!roomCells[`${gx-1},${gy}`]) addEdge(gx,   gy+1, gx,   gy  );
      }

      const usedEdges = new Set();
      const loops     = [];
      for (const startKey of Object.keys(outEdges)) {
        for (const [snx, sny] of outEdges[startKey]) {
          const firstEdge = `${startKey}>${snx},${sny}`;
          if (usedEdges.has(firstEdge)) continue;
          const loop = [];
          let [cx, cy] = startKey.split(',').map(Number);
          let [nx, ny] = [snx, sny];
          for (let guard = 0; guard < 40000; guard++) {
            usedEdges.add(`${cx},${cy}>${nx},${ny}`);
            loop.push([cx * cs, cy * cs]);
            const nxtKey = `${nx},${ny}`;
            if (nxtKey === startKey) break;
            const [prevCx, prevCy] = [cx, cy];
            [cx, cy] = [nx, ny];
            const candidates = (outEdges[nxtKey] || []).filter(
              ([tx, ty]) => !usedEdges.has(`${nxtKey}>${tx},${ty}`)
            );
            if (!candidates.length) break;
            if (candidates.length === 1) {
              [nx, ny] = candidates[0];
            } else {
              const [idx, idy] = [cx - prevCx, cy - prevCy];
              let bestCross = -Infinity, bestCand = candidates[0];
              for (const cand of candidates) {
                const cross = idx * (cand[1] - cy) - idy * (cand[0] - cx);
                if (cross > bestCross) { bestCross = cross; bestCand = cand; }
              }
              [nx, ny] = bestCand;
            }
          }
          if (loop.length >= 3) loops.push(loop);
        }
      }
      if (!loops.length) return;

      const simplify = loop => {
        const n   = loop.length;
        const out = [];
        for (let i = 0; i < n; i++) {
          const [ax, ay] = loop[(i - 1 + n) % n];
          const [bx, by] = loop[i];
          const [cx2, cy2] = loop[(i + 1) % n];
          if ((bx - ax) * (cy2 - by) !== (by - ay) * (cx2 - bx)) out.push([bx, by]);
        }
        return out.length >= 3 ? out : loop;
      };
      const simplifiedLoops = loops.map(simplify);

      ctx.save();
      ctx.globalAlpha = opacity;

      if (circleRooms.length) {
        const W = ctx.canvas.width, H = ctx.canvas.height;
        for (const circEl of circleRooms) {
          const { x, y, w, h } = DM.elementRect(circEl);
          const clipPath = new Path2D();
          const outer    = new Path2D();
          outer.rect(0, 0, W, H);
          clipPath.addPath(outer);
          const hole = new Path2D();
          hole.ellipse(x + w / 2, y + h / 2,
                       Math.max(w / 2 + clipExpand, 1),
                       Math.max(h / 2 + clipExpand, 1),
                       0, 0, Math.PI * 2);
          clipPath.addPath(hole);
          ctx.clip(clipPath, 'evenodd');
        }
      }

      if (!isInk) {
        ctx.strokeStyle = bc;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        const rough = (repEl.borderRough ?? 0.4) * 5;
        for (const loop of simplifiedLoops) {
          const n = loop.length;
          for (let rep = 0; rep < 2; rep++) {
            ctx.lineWidth = bw - rep * 0.55;
            ctx.beginPath();
            ctx.moveTo(loop[0][0], loop[0][1]);
            for (let i = 0; i < n; i++) {
              const [x1, y1] = loop[i];
              const [x2, y2] = loop[(i + 1) % n];
              const dx    = x2 - x1, dy = y2 - y1;
              const steps = Math.max(2, Math.floor(Math.hypot(dx, dy) / 14));
              for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                s === steps
                  ? ctx.lineTo(x2, y2)
                  : ctx.lineTo(
                      x1 + dx * t + rng.jitter(rough + rep * 0.3),
                      y1 + dy * t + rng.jitter(rough + rep * 0.3)
                    );
              }
            }
            ctx.closePath();
            ctx.stroke();
          }
        }
      } else {
        const intensity = repEl.stoneIntensity ?? 0.5;
        const rgb       = _parseHexRGB(repEl.borderColor || '#292929');
        const sizeScale = 0.35 + (repEl.borderRough ?? 0.4) * 1.625;
        for (const loop of simplifiedLoops) {
          const n = loop.length;
          for (let i = 0; i < n; i++) {
            const [x1, y1] = loop[i];
            const [x2, y2] = loop[(i + 1) % n];
            const sdx = x2 - x1, sdy = y2 - y1;
            const segLen = Math.hypot(sdx, sdy);
            if (segLen < cs * 0.4) continue;
            const ux = sdx / segLen, uy = sdy / segLen;
            ctx.save();
            ctx.translate(x1, y1);
            ctx.rotate(Math.atan2(uy, ux));
            let t = rng.next() * cs * 0.08;
            while (t < segLen) {
              const blkW    = cs * (0.36 + rng.next() * 0.34) * sizeScale;
              const avail   = segLen - t;
              if (avail < cs * 0.18 * sizeScale) break;
              const bwActual = Math.min(blkW, avail);
              const d1       = cs * (0.19 + rng.next() * 0.13) * sizeScale;
              _drawWallBlock(ctx, t, -d1, bwActual, d1, rng, intensity, rgb);
              if (rng.next() < 0.33) {
                const d2  = cs * (0.14 + rng.next() * 0.10) * sizeScale;
                const bw2 = bwActual * (0.65 + rng.next() * 0.30);
                const off = (bwActual - bw2) * rng.next();
                _drawWallBlock(ctx, t + off, -(d1 + cs * 0.02 + d2), bw2, d2, rng, intensity, rgb);
              }
              t += bwActual + cs * (0.02 + rng.next() * 0.03) * sizeScale;
            }
            ctx.restore();
          }
        }
      }

      ctx.restore();
    };

    processBorderGroup(rectRooms.filter(el => el.stoneStyle !== 'ink'), false);
    processBorderGroup(rectRooms.filter(el => el.stoneStyle === 'ink'),  true);
  }

  if (circleRooms.length) {
    const W = ctx.canvas.width, H = ctx.canvas.height;

    for (const el of circleRooms) {
      const bc      = el.borderColor ?? def.color;
      const bw      = el.borderWidth ?? def.width;
      if (bw <= 0 && el.stoneStyle !== 'ink') continue;
      const opacity = el.opacity !== undefined ? el.opacity : 1;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = bc;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';

      for (const rectEl of rectRooms) {
        const { x, y, w, h } = DM.elementRect(rectEl);
        const gx0 = Math.round(x / cs), gy0 = Math.round(y / cs);
        const gx1 = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);
        const clipPath = new Path2D();
        const outer    = new Path2D();
        outer.rect(0, 0, W, H);
        clipPath.addPath(outer);
        const hole = new Path2D();
        hole.rect(gx0 * cs - clipExpand, gy0 * cs - clipExpand,
                  (gx1 - gx0) * cs + clipExpand * 2, (gy1 - gy0) * cs + clipExpand * 2);
        clipPath.addPath(hole);
        ctx.clip(clipPath, 'evenodd');
      }
      for (const other of circleRooms) {
        if (other === el) continue;
        const { x, y, w, h } = DM.elementRect(other);
        const clipPath = new Path2D();
        const outer    = new Path2D();
        outer.rect(0, 0, W, H);
        clipPath.addPath(outer);
        const hole = new Path2D();
        hole.ellipse(x + w / 2, y + h / 2,
                     Math.max(w / 2 + clipExpand, 1),
                     Math.max(h / 2 + clipExpand, 1),
                     0, 0, Math.PI * 2);
        clipPath.addPath(hole);
        ctx.clip(clipPath, 'evenodd');
      }

      const { x, y, w, h } = DM.elementRect(el);
      const ecx   = x + w / 2, ecy = y + h / 2;
      const erx   = w / 2,     ery = h / 2;
      const steps = Math.max(36, Math.ceil(Math.PI * 2 * Math.max(erx, ery) / 8));

      if (el.stoneStyle !== 'ink') {
        for (let rep = 0; rep < 2; rep++) {
          const rough = (el.borderRough ?? 0.4) * 5 + rep * 0.3;
          ctx.lineWidth = bw - rep * 0.55;
          ctx.beginPath();
          for (let s = 0; s <= steps; s++) {
            const theta = (s / steps) * Math.PI * 2;
            const jx    = s < steps ? rng.jitter(rough) : 0;
            const jy    = s < steps ? rng.jitter(rough) : 0;
            const px    = ecx + erx * Math.cos(theta) + jx;
            const py    = ecy + ery * Math.sin(theta) + jy;
            s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }

      if (el.stoneStyle === 'ink') {
        const intensity  = el.stoneIntensity ?? 0.5;
        const rgb        = _parseHexRGB(el.borderColor || '#292929');
        const sizeScale  = 0.35 + (el.borderRough ?? 0.4) * 1.625;
        let theta = rng.next() * 0.1;
        while (theta < Math.PI * 2) {
          const cos0  = Math.cos(theta), sin0 = Math.sin(theta);
          const tang0 = -erx * sin0, tang1 = ery * cos0;
          const tLen  = Math.hypot(tang0, tang1);
          const ux    = tang0 / tLen, uy = tang1 / tLen;
          const blkW  = cs * (0.36 + rng.next() * 0.34) * sizeScale;
          const bpx   = ecx + erx * cos0, bpy = ecy + ery * sin0;
          ctx.save();
          ctx.translate(bpx, bpy);
          ctx.rotate(Math.atan2(uy, ux));
          const d1 = cs * (0.19 + rng.next() * 0.13) * sizeScale;
          _drawWallBlock(ctx, -blkW / 2, -d1, blkW, d1, rng, intensity, rgb);
          if (rng.next() < 0.33) {
            const d2  = cs * (0.14 + rng.next() * 0.10) * sizeScale;
            const bw2 = blkW * (0.65 + rng.next() * 0.30);
            _drawWallBlock(ctx, -bw2 / 2, -(d1 + cs * 0.02 + d2), bw2, d2, rng, intensity, rgb);
          }
          ctx.restore();
          theta += blkW / tLen + rng.next() * 0.03;
        }
      }

      ctx.restore();
    }
  }

  ctx.globalAlpha = 1;
};

DM.Draw.pitElements = function(ctx, elements) {
  const cs = DM.State.current.cellSize;

  const pitCells = {};
  for (const el of elements) {
    if (el.type !== 'pit') continue;
    const { x, y, w, h } = DM.elementRect(el);
    if (w < 1 || h < 1) continue;
    const gx0 = Math.round(x / cs), gy0 = Math.round(y / cs);
    const gx1 = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);
    for (let gx = gx0; gx < gx1; gx++)
      for (let gy = gy0; gy < gy1; gy++)
        pitCells[`${gx},${gy}`] = el;
  }
  const keys = Object.keys(pitCells);
  if (!keys.length) return;

  const outEdges = {};
  const addEdge  = (fx, fy, tx, ty) => {
    const k = `${fx},${fy}`;
    (outEdges[k] || (outEdges[k] = [])).push([tx, ty]);
  };
  for (const key of keys) {
    const [gx, gy] = key.split(',').map(Number);
    if (!pitCells[`${gx},${gy-1}`]) addEdge(gx,   gy,   gx+1, gy  );
    if (!pitCells[`${gx+1},${gy}`]) addEdge(gx+1, gy,   gx+1, gy+1);
    if (!pitCells[`${gx},${gy+1}`]) addEdge(gx+1, gy+1, gx,   gy+1);
    if (!pitCells[`${gx-1},${gy}`]) addEdge(gx,   gy+1, gx,   gy  );
  }

  const usedEdges = new Set();
  const loops     = [];
  for (const startKey of Object.keys(outEdges)) {
    for (const [snx, sny] of outEdges[startKey]) {
      const firstEdge = `${startKey}>${snx},${sny}`;
      if (usedEdges.has(firstEdge)) continue;

      const loop = [];
      let [cx, cy] = startKey.split(',').map(Number);
      let [nx, ny] = [snx, sny];

      for (let guard = 0; guard < 40000; guard++) {
        usedEdges.add(`${cx},${cy}>${nx},${ny}`);
        const cr   = DM.cellRNG(cx, cy);
        const jAmt = cs * 0.11;
        loop.push([cx * cs + cr.jitter(jAmt), cy * cs + cr.jitter(jAmt)]);

        const nxtKey = `${nx},${ny}`;
        if (nxtKey === startKey) break;

        const [prevCx, prevCy] = [cx, cy];
        [cx, cy] = [nx, ny];

        const candidates = (outEdges[nxtKey] || []).filter(
          ([tx, ty]) => !usedEdges.has(`${nxtKey}>${tx},${ty}`)
        );
        if (!candidates.length) break;

        if (candidates.length === 1) {
          [nx, ny] = candidates[0];
        } else {
          const [idx, idy] = [cx - prevCx, cy - prevCy];
          let bestCross = -Infinity, bestCand = candidates[0];
          for (const cand of candidates) {
            const cross = idx * (cand[1] - cy) - idy * (cand[0] - cx);
            if (cross > bestCross) { bestCross = cross; bestCand = cand; }
          }
          [nx, ny] = bestCand;
        }
      }

      if (loop.length >= 3) loops.push(loop);
    }
  }
  if (!loops.length) return;

  const tracePath = () => {
    for (const loop of loops) {
      const n = loop.length;
      ctx.moveTo(
        (loop[n - 1][0] + loop[0][0]) / 2,
        (loop[n - 1][1] + loop[0][1]) / 2
      );
      for (let i = 0; i < n; i++) {
        const [cpx, cpy] = loop[i];
        const [epx, epy] = loop[(i + 1) % n];
        ctx.quadraticCurveTo(cpx, cpy, (cpx + epx) / 2, (cpy + epy) / 2);
      }
      ctx.closePath();
    }
  };

  const repEl    = pitCells[keys[0]];
  const def      = DM.Config.BORDER_DEFAULTS.pit;
  const opacity  = repEl.opacity !== undefined ? repEl.opacity : 1;
  const userColor = repEl.color || '#1a0800';
  const bc       = repEl.borderColor ?? def.color;
  const bw       = repEl.borderWidth ?? def.width;

  ctx.save();
  ctx.globalAlpha = opacity;

  ctx.fillStyle = 'rgba(3,1,0,1)';
  ctx.beginPath(); tracePath(); ctx.fill();

  if (bw > 0) {
    ctx.strokeStyle = bc;
    ctx.lineWidth   = bw;
    ctx.beginPath(); tracePath(); ctx.stroke();
  }

  ctx.beginPath(); tracePath(); ctx.clip();

  ctx.fillStyle = userColor;
  for (const key of keys) {
    const [gx, gy] = key.split(',').map(Number);
    const cr = DM.cellRNG(gx, gy);
    if (cr.next() > 0.40) continue;
    ctx.globalAlpha = opacity * (0.06 + cr.next() * 0.42);
    ctx.beginPath();
    ctx.ellipse(
      gx * cs + cs * (0.15 + cr.next() * 0.70),
      gy * cs + cs * (0.15 + cr.next() * 0.70),
      cs * (0.30 + cr.next() * 0.55),
      cs * (0.25 + cr.next() * 0.45),
      cr.next() * Math.PI, 0, Math.PI * 2
    );
    ctx.fill();
  }

  ctx.fillStyle = '#000';
  for (const key of keys) {
    const [gx, gy] = key.split(',').map(Number);
    const cr = DM.cellRNG(gx * 3 + 997, gy * 3 + 317);
    if (cr.next() > 0.50) continue;
    ctx.globalAlpha = opacity * (0.18 + cr.next() * 0.55);
    ctx.beginPath();
    ctx.ellipse(
      gx * cs + cs * (0.10 + cr.next() * 0.80),
      gy * cs + cs * (0.10 + cr.next() * 0.80),
      cs * (0.20 + cr.next() * 0.60),
      cs * (0.20 + cr.next() * 0.50),
      cr.next() * Math.PI, 0, Math.PI * 2
    );
    ctx.fill();
  }

  ctx.restore();
  ctx.globalAlpha = 1;
};

DM.Draw.stairsElements = function(ctx, elements) {
  for (const el of elements) {
    if (el.type !== 'stairs') continue;
    const { x, y, w, h } = DM.elementRect(el);
    if (w < 10 || h < 10) continue;

    const cs  = DM.State.current.cellSize;
    const def = DM.Config.BORDER_DEFAULTS.stairs;
    const color  = el.borderColor ?? def.color;
    const lwBase = el.borderWidth ?? def.width;

    ctx.save();
    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
    ctx.translate(x + w/2, y + h/2);
    ctx.rotate(el.rotation || 0);

    const totalH = h * 0.88;
    const minW   = w * 0.12;
    const maxW   = w * 0.90;
    const steps  = Math.max(3, Math.round(Math.max(w, h) / cs) * 2);

    for (let i = 0; i <= steps; i++) {
      const t  = i / steps;
      const sy = -totalH / 2 + t * totalH;
      const lw = minW + (maxW - minW) * t;
      DM.Draw.roughLine(ctx, -lw / 2, sy, lw / 2, sy, {
        rough: 0.6,
        color,
        lw: (i === 0 || i === steps) ? lwBase * 1.6 : lwBase,
      });
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }
};

DM.Draw.secretElements = function(ctx, elements) {
  for (const el of elements) {
    if (el.type !== 'secret') continue;
    const { x, y, w, h } = DM.elementRect(el);
    if (w < 10 || h < 10) continue;
    const cs = DM.State.current.cellSize;

    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
    const def = DM.Config.BORDER_DEFAULTS.secret;
    const sbc = el.borderColor ?? def.color;
    const sbw = el.borderWidth ?? def.width;
    ctx.save();
    ctx.setLineDash([8, 5]);
    ctx.strokeStyle = sbc;
    ctx.lineWidth   = sbw;
    ctx.strokeRect(x+3, y+3, w-6, h-6);
    ctx.setLineDash([]);
    ctx.font         = `bold ${Math.min(18, Math.min(w,h)*0.38)}px Cinzel,serif`;
    ctx.fillStyle    = 'rgba(88,48,14,.55)';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('S', x + w/2, y + h/2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
};

DM.Draw.imageElements = function(ctx, elements) {
  for (const el of elements) {
    if (el.type !== 'image') continue;
    const { x, y, w, h } = DM.elementRect(el);
    if (w < 4 || h < 4) continue;

    const asset = DM.State.getAsset(el.assetId);
    const frame = DM.getAnimFrame(asset);
    if (!frame) continue;

    ctx.save();
    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
    ctx.translate(x + w/2, y + h/2);
    ctx.rotate(el.rotation || 0);
    ctx.drawImage(frame, -w/2, -h/2, w, h);
    ctx.restore();
  }
};

function _wrapTextLines(ctx, text, maxW) {
  const result = [];
  for (const paragraph of (text || '').split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxW) {
        result.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    result.push(line);
  }
  return result.length ? result : [''];
}

DM.Draw.textElements = function(ctx, elements) {
  const playerRender = DM.State.current._playerRender;
  for (const el of elements) {
    if (el.type !== 'text') continue;
    if (el.gmOnly && playerRender) continue;
    const size       = el.fontSize || 18;
    const lineHeight = size * 1.3;
    const style      = (el.bold ? 'bold ' : '') + (el.italic ? 'italic ' : '');

    const align = el.align || 'center';

    ctx.save();
    ctx.globalAlpha  = el.opacity !== undefined ? el.opacity : 1;
    ctx.translate(el.x, el.y);
    ctx.rotate(el.rotation || 0);
    ctx.font         = `${style}${size}px 'IM Fell English', Georgia, serif`;
    ctx.textBaseline = 'middle';

    const vw     = el.w || 120;
    const pad    = Math.round(size * 0.25);
    const lines  = _wrapTextLines(ctx, el.text, vw - pad * 2);
    const totalH = lines.length * lineHeight;
    const rx     = -vw / 2;
    const ry     = -totalH / 2 - pad;
    const rh     = totalH + pad * 2;

    if (el.bgColor) {
      ctx.fillStyle = el.bgColor;
      ctx.fillRect(rx, ry, vw, rh);
    }

    const bw = el.borderWidth ?? 0;
    if (bw > 0) {
      ctx.strokeStyle = el.borderColor || '#000000';
      ctx.lineWidth   = bw;
      ctx.lineJoin    = 'miter';
      ctx.strokeRect(rx, ry, vw, rh);
    }

    const textX = align === 'left'  ? rx + pad : align === 'right' ? -rx - pad : 0;
    ctx.textAlign = align;
    ctx.fillStyle = el.color || '#2c1810';
    lines.forEach((line, i) => {
      ctx.fillText(line, textX, (i - (lines.length - 1) / 2) * lineHeight);
    });

    if (el.gmOnly && !playerRender) {
      ctx.font         = `bold 9px sans-serif`;
      ctx.fillStyle    = '#e88a00';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('GM', 0, ry - 2);
    }

    ctx.restore();
  }
};

DM.Draw.wallElements = function(ctx, elements) {
  const def = DM.Config.BORDER_DEFAULTS.wall;
  for (const el of elements) {
    if (el.type !== 'wall') continue;
    if (el.x === el.x2 && el.y === el.y2) continue;
    const color = el.color ?? def.color;
    const lw    = el.borderWidth ?? def.width;
    const rough = (el.borderRough ?? 0.4) * 5;
    ctx.save();
    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
    DM.Draw.roughLine(ctx, el.x, el.y, el.x2, el.y2, { rough, color, lw, reps: 2 });
    ctx.restore();
    ctx.globalAlpha = 1;
  }
};

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

DM.BrushPatterns = (() => {
  const _cache = {};

  function _makeStone(cs) {
    const W = cs * 3, H = cs * 2;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rng = new DM.RNG(31415);

    g.fillStyle = '#6a5a46';
    g.fillRect(0, 0, W, H);

    const bricks = [
      { x: 1,        y: 1,    w: cs - 2, h: cs - 2 },
      { x: cs + 1,   y: 1,    w: cs - 2, h: cs - 2 },
      { x: cs*2 + 1, y: 1,    w: cs - 2, h: cs - 2 },
      { x: -cs*0.5 + 1, y: cs+1, w: cs - 2, h: cs - 2 },
      { x: cs*0.5 + 1,  y: cs+1, w: cs - 2, h: cs - 2 },
      { x: cs*1.5 + 1,  y: cs+1, w: cs - 2, h: cs - 2 },
      { x: cs*2.5 + 1,  y: cs+1, w: cs - 2, h: cs - 2 },
    ];

    for (const b of bricks) {
      const lum = 36 + Math.floor(rng.next() * 16);
      const sat = 14 + Math.floor(rng.next() * 8);
      g.fillStyle = `hsl(30, ${sat}%, ${lum}%)`;
      g.beginPath();
      g.roundRect(b.x, b.y, b.w, b.h, 1.5);
      g.fill();
      g.fillStyle = 'rgba(255,248,220,0.07)';
      g.beginPath();
      g.roundRect(b.x + 2, b.y + 2, b.w - 4, b.h * 0.28, 1);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.14)';
      g.fillRect(b.x + 1, b.y + b.h - 2, b.w - 2, 2);
    }
    return c;
  }

  function _makeWood(cs) {
    const W = cs, H = cs * 3;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rng = new DM.RNG(27182);

    const planks = [
      { y: 0,    hue: 29, sat: 52, lum: 42 },
      { y: cs,   hue: 27, sat: 48, lum: 37 },
      { y: cs*2, hue: 30, sat: 50, lum: 44 },
    ];

    for (const pk of planks) {
      g.fillStyle = `hsl(${pk.hue}, ${pk.sat}%, ${pk.lum}%)`;
      g.fillRect(0, pk.y, W, cs);

      const grainCount = 3 + Math.floor(rng.next() * 3);
      for (let i = 0; i < grainCount; i++) {
        const gy = pk.y + (cs / (grainCount + 1)) * (i + 1) + rng.jitter(1.2);
        g.strokeStyle = `rgba(0,0,0,${0.06 + rng.next() * 0.09})`;
        g.lineWidth   = 0.4 + rng.next() * 0.5;
        g.beginPath();
        g.moveTo(0, gy);
        for (let x = 0; x < W; x += 3) {
          g.lineTo(x, gy + rng.jitter(0.5));
        }
        g.stroke();
      }

      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(0, pk.y + cs - 2, W, 2);

      if (rng.next() > 0.45) {
        const kx = W * 0.2 + rng.next() * W * 0.6;
        const ky = pk.y + cs * 0.25 + rng.next() * cs * 0.5;
        const kr = 1.5 + rng.next() * 2;
        g.fillStyle = `hsl(${pk.hue - 4}, ${pk.sat + 6}%, ${pk.lum - 13}%)`;
        g.beginPath();
        g.ellipse(kx, ky, kr * 1.6, kr, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    return c;
  }

  return {

    get(id, ctx, cs) {
      const key = `${id}_${cs}`;
      if (!_cache[key]) {
        const src = id === 'stone' ? _makeStone(cs) : _makeWood(cs);
        _cache[key] = ctx.createPattern(src, 'repeat');
      }
      return _cache[key];
    },

    preview(id, size = 40) {
      const src = id === 'stone' ? _makeStone(size) : _makeWood(size);
      const out = document.createElement('canvas');
      out.width = out.height = size;
      out.getContext('2d').drawImage(src, 0, 0, size, size);
      return out;
    },

    defs: [
      { id: 'stone', label: 'Stone',  icon: '🪨' },
      { id: 'wood',  label: 'Wood',   icon: '🪵' },
    ],
  };
})();

DM.Draw.brushLayer = function(ctx, elements) {
  for (const el of elements) {
    if (el.type !== 'brush') continue;

    if (el.cells?.length && !el.points) {
      const cs = DM.State.current.cellSize;
      ctx.save();
      ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
      ctx.fillStyle   = el.color || '#8b7355';
      for (const { gx, gy } of el.cells) ctx.fillRect(gx * cs, gy * cs, cs, cs);
      ctx.restore();
      continue;
    }

    if (!el.points?.length) continue;

    const pts     = el.points;
    const size    = el.size    || 20;
    const color   = el.color   || '#8b7355';
    const opacity = el.opacity !== undefined ? el.opacity : 1;
    const shape   = el.shape   || 'round';

    const texAsset = el.assetId ? DM.State.getAsset(el.assetId) : null;
    let fill;
    if (texAsset && texAsset._img) {
      fill = ctx.createPattern(texAsset._img, 'repeat');
      const s = el.assetScale ?? 1;
      if (s !== 1) fill.setTransform(new DOMMatrix().scale(s, s));
    } else {
      fill = color;
    }

    const effectiveShape = (fill !== color && shape === 'soft') ? 'round' : shape;

    ctx.save();
    ctx.globalAlpha = opacity;

    const subs = _splitSubpaths(pts);

    if (effectiveShape === 'cave') {
      const edgeW      = el.borderWidth || 0;
      const edgeCol    = el.borderColor || (edgeW > 0 ? '#2a2a2a' : fill);
      const rough      = el.borderRough != null ? el.borderRough : 0.5;
      const gapProb    = Math.max(0.05, 0.45 - rough * 0.34); // rough 0.5 → 0.28 (legacy)
      const spikeScale = 0.4 + rough * 1.2;                    // rough 0.5 → 1.0  (legacy)
      for (const sp of subs) _drawCaveEdge(ctx, sp, size, edgeCol, edgeW, gapProb, spikeScale);
      for (const sp of subs) _drawCaveBody(ctx, sp, size, fill);
    } else {
      for (const sp of subs) {
        if (effectiveShape === 'soft') _drawSoftStroke(ctx, sp, size, color);
        else                           _drawSolidStroke(ctx, sp, size, fill, effectiveShape);
      }
    }

    ctx.restore();
  }
};

function _splitSubpaths(pts) {
  let firstBreak = -1;
  for (let i = 1; i < pts.length; i++) { if (pts[i].m) { firstBreak = i; break; } }
  if (firstBreak === -1) return [pts];
  const out = [pts.slice(0, firstBreak)];
  let cur = [];
  out.push(cur);
  for (let i = firstBreak; i < pts.length; i++) {
    if (pts[i].m && cur.length) { cur = []; out.push(cur); }
    cur.push(pts[i]);
  }
  return out;
}

function _drawSolidStroke(ctx, pts, size, fill, shape) {
  ctx.strokeStyle = fill;
  ctx.fillStyle   = fill;
  ctx.lineWidth   = size;
  ctx.lineCap     = shape === 'square' ? 'square' : 'round';
  ctx.lineJoin    = shape === 'square' ? 'miter'  : 'round';
  ctx.beginPath();
  if (pts.length === 1) {
    if (shape === 'square') {
      ctx.fillRect(pts[0].x - size / 2, pts[0].y - size / 2, size, size);
    } else {
      ctx.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
}

function _drawCaveBody(ctx, pts, size, fill) {
  ctx.fillStyle   = fill;
  ctx.strokeStyle = fill;
  ctx.lineWidth   = size;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function _drawCaveEdge(ctx, pts, size, edgeCol, edgeW, gapProb, spikeScale) {
  const r = size / 2;

  if (pts.length === 1) {
    if (edgeW > 0) {
      ctx.fillStyle = edgeCol;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, r + edgeW, 0, Math.PI * 2);
      ctx.fill();
    }
    _caveSingleClickTeeth(ctx, pts[0].x, pts[0].y, r, edgeCol, gapProb, spikeScale);
    return;
  }

  if (edgeW > 0) {
    ctx.strokeStyle = edgeCol;
    ctx.lineWidth   = size + edgeW * 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  const toothInterval = Math.max(3, size * 0.27);
  const interp = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const last = interp[interp.length - 1];
    const dx   = pts[i].x - last.x, dy = pts[i].y - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) continue;
    const steps = Math.max(1, Math.ceil(dist / toothInterval));
    for (let s = 1; s <= steps; s++) {
      interp.push({ x: last.x + dx * s / steps, y: last.y + dy * s / steps });
    }
  }

  const seed = ((Math.round(pts[0].x * 137) ^ Math.round(pts[0].y * 251)) & 0x7fffffff) || 1;
  const rng  = new DM.RNG(seed);

  ctx.fillStyle = edgeCol;
  for (let i = 0; i < interp.length; i++) {
    const pt   = interp[i];
    const prev = interp[Math.max(0, i - 1)];
    const next = interp[Math.min(interp.length - 1, i + 1)];

    const tx = next.x - prev.x, ty = next.y - prev.y;
    const tLen = Math.hypot(tx, ty) || 1;
    const tnx = tx / tLen, tny = ty / tLen;
    const nnx = -tny,      nny = tnx;

    for (const side of [1, -1]) {
      if (rng.next() < gapProb) continue; // organic gap — prevents mechanical repetition

      const toothH = r * (0.20 + rng.next() * 0.52 * spikeScale); // protrusion (scaled by roughness)
      const toothW = r * (0.16 + rng.next() * 0.24); // base half-width
      const lean   = (rng.next() - 0.5) * 0.55;      // slight tilt along tangent

      const bx = pt.x + nnx * side * r;
      const by = pt.y + nny * side * r;

      const ax = bx + (nnx * side + tnx * lean) * toothH;
      const ay = by + (nny * side + tny * lean) * toothH;

      const l1x = bx - tnx * toothW, l1y = by - tny * toothW;
      const l2x = bx + tnx * toothW, l2y = by + tny * toothW;

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(l1x, l1y);
      ctx.lineTo(l2x, l2y);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function _caveSingleClickTeeth(ctx, cx, cy, r, fill, gapProb = 0.25, spikeScale = 1) {
  const seed = ((Math.round(cx * 137) ^ Math.round(cy * 251)) & 0x7fffffff) || 1;
  const rng  = new DM.RNG(seed);
  const count = Math.max(5, Math.round(r * 0.55));
  ctx.fillStyle = fill;
  for (let i = 0; i < count; i++) {
    const angle  = (i / count) * Math.PI * 2 + rng.jitter(0.35);
    if (rng.next() < gapProb) continue;
    const toothH = r * (0.22 + rng.next() * 0.48 * spikeScale);
    const toothW = r * (0.17 + rng.next() * 0.22);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const ax  = cx + cos * (r + toothH), ay = cy + sin * (r + toothH);
    const l1x = cx + cos * r - sin * toothW, l1y = cy + sin * r + cos * toothW;
    const l2x = cx + cos * r + sin * toothW, l2y = cy + sin * r - cos * toothW;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(l1x, l1y);
    ctx.lineTo(l2x, l2y);
    ctx.closePath();
    ctx.fill();
  }
}

function _drawSoftStroke(ctx, pts, size, color) {
  const r       = size / 2;
  const spacing = Math.max(1, size * 0.15);
  const rgba0   = _parseColorRgba(color, 1);
  const rgba1   = _parseColorRgba(color, 0);

  const stamps = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = stamps[stamps.length - 1];
    const dx = pts[i].x - prev.x, dy = pts[i].y - prev.y;
    const dist  = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.floor(dist / spacing));
    for (let s = 1; s <= steps; s++) {
      stamps.push({ x: prev.x + dx * s / steps, y: prev.y + dy * s / steps });
    }
  }

  for (const { x, y } of stamps) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0,   rgba0);
    grad.addColorStop(0.5, rgba0);
    grad.addColorStop(1,   rgba1);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

const _colorCache = {};
function _parseColorRgba(color, alpha) {
  if (!_colorCache[color]) {
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = 1;
    const g = tmp.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    _colorCache[color] = [d[0], d[1], d[2]];
  }
  const [r, g, b] = _colorCache[color];
  return `rgba(${r},${g},${b},${alpha})`;
}

DM.Draw.brushCursor = function(ctx) {
  const st   = DM.State.current;
  const cs   = st.cellSize;
  const tool = st.tool;

  if (tool === 'select' || tool === 'erase' || tool === '__export__') return;

  ctx.save();

  if (tool === 'brush') {
    const x     = st.mouseX;
    const y     = st.mouseY;
    const r     = (st.brushSize || 20) / 2;
    const shape = st.brushShape || 'round';
    const color = st.brushColor || '#8b7355';

    const cursorAsset = st.brushAssetId ? DM.State.getAsset(st.brushAssetId) : null;
    let cursorFill;
    if (cursorAsset && cursorAsset._img) {
      cursorFill = ctx.createPattern(cursorAsset._img, 'repeat');
      const s = st.brushAssetScale ?? 1;
      if (s !== 1) cursorFill.setTransform(new DOMMatrix().scale(s, s));
    } else {
      cursorFill = color;
    }

    ctx.globalAlpha = (st.brushOpacity ?? 1) * 0.6;
    ctx.fillStyle   = cursorFill;
    if (shape === 'square') {
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth   = 1.2;
    ctx.setLineDash([3, 2]);
    if (shape === 'square') {
      ctx.strokeRect(x - r + 0.5, y - r + 0.5, r * 2 - 1, r * 2 - 1);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  } else if (tool === 'fog') {
    const x = st.mouseX, y = st.mouseY;
    const r = (st.fogSize || 120) / 2;
    ctx.globalAlpha = (st.fogDensity ?? 0.35) * 0.5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, st.fogColor || '#cdd4e1');
    g.addColorStop(1, 'rgba(205,212,225,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth   = 1.2;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    const ogx = Math.floor(st.mouseX / cs);
    const ogy = Math.floor(st.mouseY / cs);
    ctx.globalAlpha = 0.14;
    ctx.fillStyle   = '#c8a44a';
    ctx.fillRect(ogx * cs, ogy * cs, cs, cs);
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = '#c8a44a';
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(ogx * cs + 0.5, ogy * cs + 0.5, cs - 1, cs - 1);
    ctx.setLineDash([]);
  }

  ctx.restore();
};

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

function _border(type, opts = {}) {
  const def = DM.Config.BORDER_DEFAULTS[type] || { color: '#0a0300', width: 1.5 };
  return {
    bc: opts.borderColor ?? def.color,
    bw: opts.borderWidth ?? def.width,
  };
}

function _anoise(x) {
  const r = n => { const v = Math.sin(n * 127.1) * 43758.5453; return v - Math.floor(v); };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return r(i) * (1 - u) + r(i + 1) * u;
}

const _torch = (ctx, cs, color, opts) => {
  const anim   = !!(opts && opts.anim);
  const t      = anim ? (opts.t || 0) : 0;
  const gflick = anim ? 0.82 + 0.18 * _anoise(t * 9 + 3) : 1;
  const gr     = anim ? 54 * (0.93 + 0.08 * _anoise(t * 6)) : 54;

  const gl = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
  gl.addColorStop(0,    `rgba(255,150,0,${0.38 * gflick})`);
  gl.addColorStop(0.45, `rgba(255,85,0,${0.14 * gflick})`);
  gl.addColorStop(1,    'rgba(255,50,0,0)');
  ctx.fillStyle = gl;
  ctx.beginPath(); ctx.arc(0, 0, gr, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = color || '#5a2e0a';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.beginPath(); ctx.moveTo(0, 15); ctx.lineTo(0, 3); ctx.stroke();

  ctx.fillStyle = '#3a1a04';
  ctx.fillRect(-5, 0, 10, 6);

  ctx.save();
  if (anim) {
    const sway = (_anoise(t * 4.5) - 0.5) * 7;
    const ht   = 0.8 + 0.32 * _anoise(t * 7.5);
    ctx.transform(1, 0, -sway / 18, 1, 0, 0);
    ctx.scale(1, ht);
  }
  ctx.fillStyle = color || '#ff8800';
  ctx.beginPath();
  ctx.moveTo(0, -18); ctx.bezierCurveTo(10, -6, 7, 2, 0, 2);
  ctx.bezierCurveTo(-7, 2, -10, -6, 0, -18); ctx.fill();

  ctx.fillStyle = '#ffcc00';
  ctx.beginPath();
  ctx.moveTo(0, -13); ctx.bezierCurveTo(5, -4, 3, 0, 0, 0);
  ctx.bezierCurveTo(-3, 0, -5, -4, 0, -13); ctx.fill();

  ctx.fillStyle = '#fff8e0';
  ctx.beginPath();
  ctx.moveTo(0, -8); ctx.bezierCurveTo(2, -3, 1, -1, 0, -1);
  ctx.bezierCurveTo(-1, -1, -2, -3, 0, -8); ctx.fill();
  ctx.restore();

  if (anim) {
    for (let i = 0; i < 3; i++) {
      const p  = ((t * 0.7 + i / 3) % 1);
      const ex = Math.sin(i * 4 + t * 3) * 4, ey = -4 - p * 40, a = (1 - p) * 0.7;
      ctx.fillStyle = `rgba(255,${180 + i * 10},80,${a})`;
      ctx.beginPath(); ctx.arc(ex, ey, 1.2 * (1 - p * 0.5), 0, Math.PI * 2); ctx.fill();
    }
  }
};

const _portal = (ctx, cs, color, opts) => {
  const R     = cs * 0.5;
  const anim  = !!(opts && opts.anim);
  const t     = anim ? (opts.t || 0) : 0;
  const pulse = anim ? 0.5 + 0.5 * Math.sin(t * 2.5) : 0.8;

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0,    '#12041f');
  g.addColorStop(0.5,  '#3a0f66');
  g.addColorStop(0.85, '#7a2fd0');
  g.addColorStop(1,    'rgba(20,6,40,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let layer = 0; layer < 2; layer++) {
    const dir  = layer ? -1 : 1;
    const arms = layer ? 3 : 4;
    const rot  = anim ? t * (layer ? 1.1 : 1.6) * dir : (layer ? 0.6 : -0.4);
    for (let a = 0; a < arms; a++) {
      ctx.beginPath();
      for (let s = 0; s < 48; s++) {
        const f   = s / 48;
        const rr  = R * 0.06 + f * R * 0.9;
        const ang = rot + a / arms * Math.PI * 2 + f * 6 * dir;
        const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
        s ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = layer ? 'rgba(120,200,255,0.16)' : 'rgba(232,170,255,0.20)';
      ctx.lineWidth   = cs * (layer ? 0.02 : 0.03);
      ctx.stroke();
    }
  }
  if (anim) {
    for (let i = 0; i < 12; i++) {
      const ph  = ((t * 0.5 + i / 12) % 1);
      const rr  = R * 0.95 * (1 - ph);
      const ang = i * 1.3 + t * 1.5 + ph * 4;
      const a   = Math.sin(ph * Math.PI) * 0.9;
      ctx.fillStyle = `rgba(240,210,255,${a})`;
      ctx.beginPath(); ctx.arc(Math.cos(ang) * rr, Math.sin(ang) * rr, cs * 0.018, 0, Math.PI * 2); ctx.fill();
    }
  }
  const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.4);
  cg.addColorStop(0, `rgba(245,225,255,${0.4 + 0.4 * pulse})`);
  cg.addColorStop(1, 'rgba(200,150,255,0)');
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.strokeStyle = color || `rgba(230,180,255,${0.5 + 0.4 * pulse})`;
  ctx.lineWidth   = cs * 0.03 * (0.8 + 0.4 * pulse);
  ctx.beginPath(); ctx.arc(0, 0, R * 0.92, 0, Math.PI * 2); ctx.stroke();
};

const _pillar = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('pillar', opts);
  const r = cs * 0.38;

  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.arc(3, 4, r, 0, Math.PI * 2); ctx.fill();

  const gr = ctx.createRadialGradient(-r * 0.3, -r * 0.3, 0, 0, 0, r);
  gr.addColorStop(0,   color || '#f0e4b0');
  gr.addColorStop(0.6, '#c8a870');
  gr.addColorStop(1,   '#7a5828');
  ctx.fillStyle = gr;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();

  DM.Draw.roughCircle(ctx, 0, 0, r, { rough: 1.8, color: bc, lw: bw });
  DM.Draw.roughLine(ctx, -r * 0.42, 0, r * 0.42, 0, { rough: 0.4, color: 'rgba(55,32,6,.26)', lw: 0.7 });
  DM.Draw.roughLine(ctx, 0, -r * 0.42, 0, r * 0.42,  { rough: 0.4, color: 'rgba(55,32,6,.26)', lw: 0.7 });
};

const _door = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('door', opts);
  const w = opts.w || cs;
  const h = opts.h || Math.round(cs * 0.25);

  if (opts.flipped) ctx.scale(-1, 1);

  ctx.fillStyle = color || '#f0e0b0';
  ctx.fillRect(-w / 2, -h / 2, w, h);
  DM.Draw.roughRect(ctx, -w / 2, -h / 2, w, h, { rough: 1.3, color: bc, lw: bw });

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(28,8,0,.45)';
  ctx.lineWidth   = 0.9;
  ctx.arc(-w / 2, 0, w, -0.12, Math.PI / 2);
  ctx.stroke();
};

const _chest = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('chest', opts);
  const cw = 28, ch = 18;

  ctx.fillStyle = 'rgba(0,0,0,.24)';
  ctx.fillRect(-cw / 2 + 3, -ch / 2 + 3, cw, ch);
  ctx.fillStyle = color || '#7a4e12';
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
  ctx.fillStyle = '#9a6520';
  ctx.fillRect(-cw / 2, -ch / 2, cw, 8);
  ctx.fillStyle = '#c8a020';
  ctx.fillRect(-cw / 2, -ch / 2 + 7, cw, 2);
  ctx.fillRect(-2, -ch / 2, 4, ch);
  ctx.fillStyle = '#f0c030';
  ctx.beginPath(); ctx.arc(0, -ch / 2 + 6, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(-3, -ch / 2 + 6, 6, 5);
  DM.Draw.roughRect(ctx, -cw / 2, -ch / 2, cw, ch, { rough: 1.2, color: bc, lw: bw });
};

const _sarcophagus = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('sarcophagus', opts);
  const sw = cs * 0.82, sh = cs * 1.35;

  ctx.fillStyle = 'rgba(0,0,0,.2)';
  ctx.fillRect(-sw / 2 + 3, -sh / 2 + 4, sw, sh);
  ctx.fillStyle = color || '#8a7a5a';
  ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
  ctx.fillStyle = '#a08a6a';
  ctx.fillRect(-sw / 2 + 4, -sh / 2 + 4, sw - 8, sh - 8);

  ctx.beginPath();
  ctx.arc(0, -sh / 2 + 14, sw * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = '#c0a880'; ctx.fill();

  DM.Draw.roughRect(ctx, -sw / 2, -sh / 2, sw, sh, { rough: 2, color: bc, lw: bw });
  DM.Draw.roughLine(ctx, -sw / 2 + 5, -sh / 2 + 28, sw / 2 - 5, -sh / 2 + 28,
    { rough: 0.9, color: '#3a2a1a', lw: 0.8 });
  DM.Draw.roughLine(ctx, -sw / 2 + 5, 0, sw / 2 - 5, 0,
    { rough: 0.9, color: '#3a2a1a', lw: 0.8 });
};

const _altar = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('altar', opts);
  const aw = 44, ah = 26;

  ctx.fillStyle = 'rgba(0,0,0,.2)';
  ctx.fillRect(-aw / 2 + 3, -ah / 2 + 4, aw, ah);
  ctx.fillStyle = color || '#4a3018';
  ctx.fillRect(-aw / 2, -ah / 2 + 6, aw, ah - 6);
  ctx.fillStyle = '#6a4820';
  ctx.fillRect(-aw / 2 + 2, -ah / 2, aw - 4, 12);
  DM.Draw.roughRect(ctx, -aw / 2, -ah / 2, aw, ah, { rough: 2.2, color: bc, lw: bw });

  ctx.strokeStyle = 'rgba(200,158,40,.7)';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.moveTo(0, -ah / 2 + 3); ctx.lineTo(0, ah / 2 - 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.stroke();

  [-14, 14].forEach(dx => {
    const cy2 = -ah / 2 - 8;
    ctx.fillStyle = '#e8e0a0';
    ctx.fillRect(dx - 2, cy2, 4, 10);
    const cg = ctx.createRadialGradient(dx, cy2, 0, dx, cy2, 8);
    cg.addColorStop(0, 'rgba(255,158,0,.44)');
    cg.addColorStop(1, 'rgba(255,98,0,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(dx, cy2, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff9900';
    ctx.beginPath(); ctx.arc(dx, cy2, 3, 0, Math.PI * 2); ctx.fill();
  });
};

const _trap = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('trap', opts);
  const lineColor  = color || bc;
  const s  = cs * 0.42;
  const lo = { rough: 1.8, color: lineColor, lw: bw };

  DM.Draw.roughLine(ctx, -s, -s,  s,  s, lo);
  DM.Draw.roughLine(ctx,  s, -s, -s,  s, lo);
  DM.Draw.roughCircle(ctx, 0, 0, s * 0.28, { rough: 1, color: lineColor, lw: bw * 0.75 });
};

const _magic = (ctx, cs, color, opts) => {
  const { bc, bw } = _border('magic', opts);
  const accent = color || bc;
  const R      = cs * 0.45;
  const anim   = !!(opts && opts.anim);
  const t      = anim ? (opts.t || 0) : 0;
  const pulse  = anim ? 0.5 + 0.5 * Math.sin(t * 2.2) : 0.85;
  const baseA  = ctx.globalAlpha;

  const g = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 1.25);
  g.addColorStop(0,   `rgba(175,95,255,${0.10 + 0.16 * pulse})`);
  g.addColorStop(0.7, `rgba(120,80,255,${0.05 + 0.08 * pulse})`);
  g.addColorStop(1,   'rgba(120,80,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, R * 1.25, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = accent;
  ctx.lineWidth   = bw;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth   = bw * 0.5;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.9, 0, Math.PI * 2); ctx.stroke();

  ctx.lineWidth = bw * 0.6;
  for (let tri = 0; tri < 2; tri++) {
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI * 2 - Math.PI / 2 + tri * Math.PI;
      const x = Math.cos(a) * R * 0.72, y = Math.sin(a) * R * 0.72;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, R * 0.5, 0, Math.PI * 2); ctx.stroke();

  for (let i = 0; i < 8; i++) {
    const a  = i / 8 * Math.PI * 2 - Math.PI / 2;
    const np = anim ? 0.5 + 0.5 * Math.sin(t * 3 - i * 0.6) : 0.7;
    ctx.globalAlpha = baseA * (0.4 + 0.6 * np);
    ctx.fillStyle   = accent;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * R, Math.sin(a) * R, bw * 1.3 * (0.6 + 0.5 * np), 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 6; i++) {
    const a  = i / 6 * Math.PI * 2;
    const rp = anim ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 2.5 - i)) : 0.7;
    ctx.globalAlpha = baseA * rp;
    ctx.fillStyle   = accent;
    ctx.save();
    ctx.translate(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillRect(-bw * 0.7, -bw * 1.8, bw * 1.4, bw * 3.6);
    ctx.restore();
  }
  ctx.globalAlpha = baseA;
};

const _stalactite = (ctx, cs, color) => {
  const rng    = DM.rng;
  const count  = 6;
  const spread = cs * 0.92;

  ctx.fillStyle   = color || '#6a5030';
  ctx.strokeStyle = '#0a0300';
  ctx.lineWidth   = 1;

  for (let i = 0; i < count; i++) {
    const sx = -spread / 2 + (i / (count - 1)) * spread + rng.jitter(2.2);
    const sh = 13 + rng.next() * 17;
    ctx.beginPath();
    ctx.moveTo(sx - 4, 0); ctx.lineTo(sx, sh); ctx.lineTo(sx + 4, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();

    const smy = sh + 7 + rng.next() * 7;
    ctx.beginPath();
    ctx.moveTo(sx - 3, sh + 18); ctx.lineTo(sx, smy); ctx.lineTo(sx + 3, sh + 18);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
};

const _rubble = (ctx, cs, color) => {
  const rng = DM.rng;
  for (let i = 0; i < 10; i++) {
    const rx   = rng.jitter(22), ry = rng.jitter(16);
    const rs   = 5 + rng.next() * 9;
    const rot2 = rng.next() * Math.PI;

    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(rot2);

    const gr = ctx.createLinearGradient(-rs, -rs, rs, rs);
    gr.addColorStop(0, color || '#9a8060');
    gr.addColorStop(1, '#6a5030');
    ctx.fillStyle   = gr;
    ctx.strokeStyle = '#2a1808';
    ctx.lineWidth   = 0.8;

    ctx.beginPath();
    ctx.moveTo(-rs, rng.jitter(rs * 0.4));
    ctx.lineTo(rng.jitter(rs * 0.3), -rs * 0.8);
    ctx.lineTo(rs, rng.jitter(rs * 0.4));
    ctx.lineTo(rng.jitter(rs * 0.3), rs * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
};

const DECAL_FNS = {
  door: _door,
  pillar: _pillar, torch: _torch, chest: _chest,
  sarcophagus: _sarcophagus, altar: _altar,
  trap: _trap, magic: _magic, portal: _portal, stalactite: _stalactite, rubble: _rubble,
};

DM.Draw.lightElements = function(ctx, elements) {
  const cs = DM.State.current.cellSize;
  for (const el of elements) {
    if (!el.light) continue;
    const { x, y } = DM.elementCenter(el);
    const radius   = el.light.radius * cs;
    const color    = el.light.color || '#ffaa44';
    const op       = el.light.opacity ?? 0.8;

    const hex = color.replace('#', '');
    const r   = parseInt(hex.slice(0, 2), 16);
    const g   = parseInt(hex.slice(2, 4), 16);
    const b   = parseInt(hex.slice(4, 6), 16);

    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0,   `rgba(${r},${g},${b},${op})`);
    grad.addColorStop(0.4, `rgba(${r},${g},${b},${op * 0.5})`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
};

DM.Draw.decals = function(ctx, elements) {
  const cs = DM.State.current.cellSize;
  for (const el of elements) {
    const fn = DECAL_FNS[el.type];
    if (!fn) continue;
    ctx.save();
    ctx.globalAlpha = el.opacity !== undefined ? el.opacity : 1;
    ctx.translate(el.x, el.y);
    ctx.rotate(el.rotation || 0);

    if (el.type === 'door') {
      const w     = el.w || cs;
      const asset = el.assetId ? DM.State.getAsset(el.assetId) : null;
      const img   = DM.getAnimFrame(asset);
      const dim = DM.drawableSize(img);
      const h = (img && dim.w)
        ? Math.round(w * dim.h / dim.w)
        : (el.h || Math.round(cs * 0.25));
      if (img) {
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
        continue;
      }
      fn(ctx, cs, el.color || null, {
        borderColor: el.borderColor,
        borderWidth: el.borderWidth,
        flipped: el.flipped || false,
        w, h,
      });
    } else if (el.w && el.h) {
      const sx = el.w / (cs * 2), sy = el.h / (cs * 2);
      if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);
      fn(ctx, cs, el.color || null, {
        borderColor: el.borderColor,
        borderWidth: el.borderWidth,
        flipped:     el.flipped || false,
        anim:        !!el.animated,
        t:           DM.animClock || 0,
      });
    } else {
      const s = el.scale || 1;
      if (s !== 1) ctx.scale(s, s);
      fn(ctx, cs, el.color || null, {
        borderColor: el.borderColor,
        borderWidth: el.borderWidth,
        flipped:     el.flipped || false,
        anim:        !!el.animated,
        t:           DM.animClock || 0,
      });
    }
    ctx.restore();
  }
};

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

const _fogRgbCache = {};
function _fogRgb(hex) {
  if (_fogRgbCache[hex]) return _fogRgbCache[hex];
  const h = (hex || '#cdd4e1').replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const rgb = [
    parseInt(s.slice(0, 2), 16) || 0,
    parseInt(s.slice(2, 4), 16) || 0,
    parseInt(s.slice(4, 6), 16) || 0,
  ];
  _fogRgbCache[hex] = rgb;
  return rgb;
}

const _PUFF_R = 64;                      // sprite radius (128×128 canvas)
const _puffSprites = new Map();
function _puffSprite(hex, soft) {
  const key = hex + '_' + soft.toFixed(3);
  let spr = _puffSprites.get(key);
  if (spr) return spr;
  const [R, G, B] = _fogRgb(hex);
  const d = _PUFF_R * 2;
  spr = document.createElement('canvas');
  spr.width = spr.height = d;
  const g = spr.getContext('2d');
  const grad = g.createRadialGradient(_PUFF_R, _PUFF_R, 0, _PUFF_R, _PUFF_R, _PUFF_R);
  grad.addColorStop(0,          `rgba(${R},${G},${B},1)`);
  grad.addColorStop(soft * 0.7, `rgba(${R},${G},${B},0.5)`);
  grad.addColorStop(1,          `rgba(${R},${G},${B},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, d, d);
  _puffSprites.set(key, spr);
  return spr;
}

const _FOG_SCALE = 0.5;
let _fogBuf = null, _fogBufCtx = null;

function _blitLowRes(ctx, draw) {
  const st = DM.State.current;
  const W  = st.mapW;
  const H  = st.mapH;
  const bw = Math.max(1, Math.round(W * _FOG_SCALE));
  const bh = Math.max(1, Math.round(H * _FOG_SCALE));
  if (!_fogBuf) {
    _fogBuf    = document.createElement('canvas');
    _fogBufCtx = _fogBuf.getContext('2d');
  }
  if (_fogBuf.width !== bw || _fogBuf.height !== bh) {
    _fogBuf.width  = bw;
    _fogBuf.height = bh;
  }
  const b = _fogBufCtx;
  b.setTransform(bw / W, 0, 0, bh / H, 0, 0);   // map coords → reduced buffer
  b.clearRect(0, 0, W, H);
  b.imageSmoothingEnabled = true;
  b.imageSmoothingQuality = 'high';
  draw(b);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(_fogBuf, 0, 0, W, H);
  ctx.restore();
}

function _drawPuffs(ctx, el, hex, ox, oy, anim, t, elemOp) {
  for (const p of el.puffs) {
    let dx = 0, dy = 0, breath = 1;
    if (anim) {
      dx     = Math.sin(t * p.speed + p.phase)             * p.driftX;
      dy     = Math.cos(t * p.speed * 0.8 + p.phase * 1.3) * p.driftY;
      breath = 1 + Math.sin(t * p.speed * 1.1 + p.phase)   * p.breath;
    }
    const a = elemOp * Math.min(1, Math.max(0, p.baseAlpha * breath));
    if (a <= 0) continue;

    const spr = _puffSprite(hex, p.soft ?? 0.7);
    const r   = p.r;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(ox + p.bx + dx, oy + p.by + dy);
    ctx.rotate(p.rot || 0);
    ctx.scale(1, p.squash ?? 1);
    ctx.drawImage(spr, -r, -r, r * 2, r * 2);
    ctx.restore();
  }
}

DM.Draw.fogElements = function(ctx, elements) {
  for (const el of elements) {
    if (el.type !== 'fog' || !el.puffs?.length) continue;

    const hex    = el.color || '#cdd4e1';
    const ox     = el.x || 0;
    const oy     = el.y || 0;
    const anim   = !!el.animated;
    const t      = anim ? (DM.animClock || 0) * (el.animSpeed ?? 1) : 0;
    const elemOp = el.opacity !== undefined ? el.opacity : 1;

    if (anim) {
      _blitLowRes(ctx, b => _drawPuffs(b, el, hex, ox, oy, true, t, elemOp));
    } else {
      _drawPuffs(ctx, el, hex, ox, oy, false, t, elemOp);
    }
  }
};

'use strict';
window.DM = window.DM || {};
DM.Draw = DM.Draw || {};

DM.getHandleFrame = function(el) {
  const PAD = 6;
  const MIN = 48;
  const r   = DM.elementRect(el);
  const cx  = r.x + r.w / 2;
  const cy  = r.y + r.h / 2;
  const fw  = Math.max(r.w + PAD * 2, MIN);
  const fh  = Math.max(r.h + PAD * 2, MIN);
  return { x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh, cx, cy };
};

DM.getRotateHandle = function(el) {
  const r = DM.elementRect(el);
  if (r.w > 0 && r.h > 0) {
    const f = DM.getHandleFrame(el);
    return { x: f.cx, y: f.y - 18 };
  }
  const radius = DM.State.current.cellSize * 0.6;
  return { x: el.x, y: el.y - radius - 16 };
};

DM.getResizeHandles = function(el) {
  if (el.type === 'text') return null;
  if (el.type === 'wall') return null;
  if (el.type === 'room') return null;
  if (el.type === 'fog')  return null;   // freeform cloud — move only, no resize

  const r = DM.elementRect(el);
  if (r.w <= 0 || r.h <= 0) return null;

  const f  = DM.getHandleFrame(el);
  const mx = f.x + f.w / 2;
  const my = f.y + f.h / 2;

  return [
    { x: f.x,       y: f.y       },  // 0 TL
    { x: mx,        y: f.y       },  // 1 TC
    { x: f.x + f.w, y: f.y       },  // 2 TR
    { x: f.x,       y: my        },  // 3 ML
    { x: f.x + f.w, y: my        },  // 4 MR
    { x: f.x,       y: f.y + f.h },  // 5 BL
    { x: mx,        y: f.y + f.h },  // 6 BC
    { x: f.x + f.w, y: f.y + f.h },  // 7 BR
  ];
};

DM.resizeHandleCursor = function(idx) {
  const cursors = [
    'nw-resize', 'n-resize',  'ne-resize',
    'w-resize',               'e-resize',
    'sw-resize', 's-resize',  'se-resize',
  ];
  return cursors[idx] || 'pointer';
};

DM.Draw.selection = function(ctx) {
  const st  = DM.State.current;
  const idx = st.selectedIdx;
  if (idx < 0 || idx >= st.elements.length) return;
  const el = st.elements[idx];

  if (el.type === 'wall') {
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = DM.Config.COLORS.selection;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(el.x, el.y);
    ctx.lineTo(el.x2, el.y2);
    ctx.stroke();
    ctx.setLineDash([]);
    const HS = 7;
    ctx.fillStyle   = DM.Config.COLORS.handle;
    ctx.strokeStyle = 'white';
    ctx.lineWidth   = 1.2;
    for (const pt of [{ x: el.x, y: el.y }, { x: el.x2, y: el.y2 }]) {
      ctx.beginPath();
      ctx.rect(pt.x - HS, pt.y - HS, HS * 2, HS * 2);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (el.type === 'fog') {
    const r = DM.elementRect(el);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = DM.Config.COLORS.selection;
    ctx.lineWidth   = 2;
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    ctx.restore();
    return;
  }

  const handles = DM.getResizeHandles(el);

  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = DM.Config.COLORS.selection;
  ctx.lineWidth   = 2;

  if (DM.Config.POINT_TOOLS.has(el.type) && !(el.w && el.h)) {
    const r = st.cellSize * 0.6;
    ctx.beginPath(); ctx.arc(el.x, el.y, r, 0, Math.PI*2); ctx.stroke();
  } else if (el.type === 'text') {
    ctx.strokeRect(el.x - 60, el.y - 20, 120, 40);
  } else if (handles) {
    const f = DM.getHandleFrame(el);
    ctx.strokeRect(f.x, f.y, f.w, f.h);
  } else {
    const r = DM.elementRect(el);
    ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
  }
  ctx.setLineDash([]);

  const rotH = DM.getRotateHandle(el);
  ctx.fillStyle = DM.Config.COLORS.handle;
  ctx.beginPath(); ctx.arc(rotH.x, rotH.y, 8, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle    = 'white';
  ctx.font         = 'bold 11px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('↻', rotH.x, rotH.y + 1);

  if (!DM.Config.POINT_TOOLS.has(el.type) && el.type !== 'text') {
    const c = DM.elementCenter(el);
    ctx.strokeStyle = 'rgba(80,155,255,.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rotH.x, rotH.y + 8); ctx.lineTo(c.x, c.y); ctx.stroke();
  }

  if (handles) {
    const HS = 7;
    ctx.fillStyle   = DM.Config.COLORS.handle;
    ctx.strokeStyle = 'white';
    ctx.lineWidth   = 1.2;
    for (const hpt of handles) {
      ctx.beginPath();
      ctx.rect(hpt.x - HS, hpt.y - HS, HS * 2, HS * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.restore();
};

DM.Draw.multiSelection = function(ctx) {
  const st = DM.State.current;
  if (st.multiSelectedSet.size < 2) return;

  ctx.save();
  ctx.lineWidth = 1.5;

  for (const idx of st.multiSelectedSet) {
    if (idx < 0 || idx >= st.elements.length) continue;
    const el        = st.elements[idx];
    const isPrimary = (idx === st.selectedIdx);

    ctx.strokeStyle = isPrimary
      ? DM.Config.COLORS.selection
      : 'rgba(80,155,255,.5)';
    ctx.setLineDash(isPrimary ? [6, 3] : [4, 5]);

    if (el.type === 'wall') {
      ctx.beginPath();
      ctx.moveTo(el.x, el.y);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }

    if (DM.Config.POINT_TOOLS.has(el.type) && !(el.w && el.h)) {
      const r = st.cellSize * 0.6;
      ctx.beginPath(); ctx.arc(el.x, el.y, r, 0, Math.PI * 2); ctx.stroke();
    } else if (el.type === 'text') {
      ctx.strokeRect(el.x - 60, el.y - 20, 120, 40);
    } else {
      const r = DM.elementRect(el);
      ctx.strokeRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6);
    }
  }

  ctx.restore();
};

DM.Draw.rubberBand = function(ctx) {
  const st = DM.State.current;
  if (!st.rubberBand) return;
  const { sx, sy, ex, ey } = st.rubberBand;
  const { x, y, w, h }     = DM.normalizeRect(sx, sy, ex - sx, ey - sy);
  if (w < 2 && h < 2) return;

  ctx.save();
  ctx.fillStyle   = 'rgba(80,155,255,.07)';
  ctx.strokeStyle = 'rgba(80,155,255,.8)';
  ctx.lineWidth   = 1.2;
  ctx.setLineDash([5, 3]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
};

DM.Draw.preview = function(ctx) {
  const st = DM.State.current;
  if (!st.drawing || !st.drawStart || !st.drawEnd) return;

  const { x: sx, y: sy } = st.drawStart;
  const { x: ex, y: ey } = st.drawEnd;
  const dx = ex - sx, dy = ey - sy;
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;

  const { x, y, w, h } = DM.normalizeRect(sx, sy, dx, dy);

  ctx.save();
  ctx.globalAlpha = 0.42;

  switch (st.tool) {
    case 'water': {
      const r = Math.min(Math.min(w, h) * 0.22, 20);
      ctx.fillStyle = 'rgba(52,138,205,.65)';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
      ctx.strokeStyle = '#183a56'; ctx.lineWidth = 2; ctx.stroke();
      break;
    }
    case 'pit': {
      const r = Math.min(Math.min(w, h) * 0.18, 16);
      ctx.fillStyle = 'rgba(8,3,0,.72)';
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
      ctx.strokeStyle = '#1a0800'; ctx.lineWidth = 2; ctx.stroke();
      break;
    }
    case 'wall': {
      ctx.strokeStyle = '#0a0200';
      ctx.lineWidth   = 3;
      ctx.lineCap     = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      break;
    }
    case 'room': {
      const st2 = DM.State.current;
      if (st2.roomShape === 'circle') {
        ctx.fillStyle = 'rgba(220,200,140,.72)';
        ctx.beginPath(); ctx.ellipse(x + w/2, y + h/2, w/2, h/2, 0, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = 'rgba(25,8,0,.5)'; ctx.lineWidth = 2; ctx.stroke();
      } else {
        ctx.fillStyle   = 'rgba(220,200,140,.72)'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(25,8,0,.5)'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      }
      break;
    }
    default: {
      ctx.fillStyle   = 'rgba(220,200,140,.72)'; ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(25,8,0,.5)'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
    }
  }
  ctx.restore();
};

DM.Draw.imagePlacementGhost = function(ctx) {
  const st = DM.State.current;
  if (st.tool !== 'image' || !st.pendingAssetId) return;
  const asset = DM.State.getAsset(st.pendingAssetId);
  if (!asset) return;

  const frame = DM.getAnimFrame(asset);

  if (!frame && asset.src && !asset._imgLoadPromise && !DM.isVideoAsset(asset)) {
    asset._imgLoadPromise = new Promise(resolve => {
      const img = new Image();
      img.onload  = () => { asset._img = img; resolve(); DM.Renderer.render(); };
      img.onerror = () => { resolve(); }; // failed — will retry on next placement
      img.src = asset.src;
    }).finally(() => { delete asset._imgLoadPromise; });
  }

  if (!frame) return;

  const cs  = st.cellSize;
  const w   = cs * 4;
  const dim = DM.drawableSize(frame);
  const h   = dim.w ? Math.round(w * dim.h / dim.w) : w;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.drawImage(frame, st.mouseX - w / 2, st.mouseY - h / 2, w, h);
  ctx.restore();
};

'use strict';
window.DM = window.DM || {};

DM.Renderer = (() => {
  let _canvas, _ctx;
  let _rafId = null; // pending rAF id for coalescing
  const _RENDER_MIN_MS = 66;
  let _renderPending = false;
  let _lastDrawTs    = -1e9;

  const _ANIM_TYPES = new Set(['torch', 'magic', 'portal', 'fog']);
  let _animRafId = null;
  let _animLast  = 0;
  const _ANIM_FAST_MS = 66;    // ~15 fps — cached composite (cheap)
  const _ANIM_SLOW_MS = 100;   // ~10 fps — full redraw fallback (expensive)

  let _belowCanvas = null, _belowCtx = null;
  let _aboveCanvas = null, _aboveCtx = null;
  let _mapVersion      = 0;   // bumped on every real render() (state changed)
  let _cacheVersion    = -1;  // _mapVersion the caches were built for
  let _tickPrevVersion = -1;  // _mapVersion observed on the previous tick

  const _isAnim = el => el.animated && _ANIM_TYPES.has(el.type);

  let _gridCanvas = null, _gridCtx = null, _gridSig = '';

  function _hasAnimatedDecal() {
    for (const layer of DM.State.current.layers) {
      if (!layer.visible) continue;
      for (const el of layer.elements) {
        if (_isAnim(el)) return true;
      }
    }
    return false;
  }

  function _animBand() {
    const layers = DM.State.current.layers;
    let first = -1, last = -1;
    for (let i = 0; i < layers.length; i++) {
      if (!layers[i].visible) continue;
      if (layers[i].elements.some(_isAnim)) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return null;                      // nothing animated
    for (let i = first; i <= last; i++) {
      if (!layers[i].visible) continue;
      for (const el of layers[i].elements) if (!_isAnim(el)) return null;
    }
    return { first, last };
  }

  function _drawLayer(ctx, layer, skipAnimated) {
    const elems = layer.elements;
    const cells = DM.buildCellGrid(elems);

    DM.Draw.floors(ctx, cells, elems);
    DM.Draw.bgFillElements(ctx, elems);
    DM.Draw.waterElements(ctx, elems);
    DM.Draw.pitElements(ctx,   elems);
    DM.Draw.secretElements(ctx, elems);
    DM.Draw.roomBorders(ctx, elems);

    for (const el of elems) {
      if (DM.Config.FLOOR_TYPES.has(el.type)) continue;
      if (skipAnimated && _isAnim(el)) continue;
      switch (el.type) {
        case 'stairs': DM.Draw.stairsElements(ctx, [el]); break;
        case 'wall':   DM.Draw.wallElements(ctx,   [el]); break;
        case 'brush':  DM.Draw.brushLayer(ctx,     [el]); break;
        case 'fog':    DM.Draw.fogElements(ctx,    [el]); break;
        case 'image':  DM.Draw.imageElements(ctx,  [el]); break;
        case 'text':   DM.Draw.textElements(ctx,   [el]); break;
        default:
          if (DM.Config.POINT_TOOLS.has(el.type)) {
            DM.Draw.decals(ctx,        [el]);
            DM.Draw.lightElements(ctx, [el]);
          }
      }
    }
  }

  function _drawMapBody(ctx, skipAnimated) {
    const st = DM.State.current;
    DM.Draw.background(ctx, st.mapW, st.mapH);
    for (const layer of st.layers) {
      if (!layer.visible) continue;
      _drawLayer(ctx, layer, skipAnimated);
    }
  }

  function _drawAnimatedOnly(ctx) {
    for (const layer of DM.State.current.layers) {
      if (!layer.visible) continue;
      for (const el of layer.elements) {
        if (!_isAnim(el)) continue;
        if (el.type === 'fog') {
          DM.Draw.fogElements(ctx, [el]);
        } else {
          DM.Draw.decals(ctx,        [el]);
          DM.Draw.lightElements(ctx, [el]);
        }
      }
    }
  }

  function _drawGridCached(ctx) {
    const st  = DM.State.current;
    const sig = st.mapW + '|' + st.mapH + '|' + st.cellSize + '|' + st.gridType + '|'
              + (st.gridColor || '') + '|' + (st.gridLineWidth ?? '') + '|' + (st.gridOpacity ?? '');
    if (_gridSig !== sig) {
      if (!_gridCanvas) {
        _gridCanvas = document.createElement('canvas');
        _gridCtx    = _gridCanvas.getContext('2d');
      }
      if (_gridCanvas.width !== st.mapW || _gridCanvas.height !== st.mapH) {
        _gridCanvas.width  = st.mapW;
        _gridCanvas.height = st.mapH;
      }
      _gridCtx.setTransform(1, 0, 0, 1, 0, 0);
      _gridCtx.clearRect(0, 0, st.mapW, st.mapH);
      DM.Draw.grid(_gridCtx, st.mapW, st.mapH, st.cellSize, st.gridType);
      _gridSig = sig;
    }
    ctx.drawImage(_gridCanvas, 0, 0);
  }

  function _drawGridAndOverlays(ctx) {
    const st = DM.State.current;
    _drawGridCached(ctx);

    DM.Draw.preview(ctx);

    if (st.tool === 'select') {
      if (st.multiSelectedSet.size <= 1) DM.Draw.selection(ctx);
      else                               DM.Draw.multiSelection(ctx);
      DM.Draw.rubberBand(ctx);
    }

    DM.Draw.brushCursor(ctx);
  }

  function _prepCache(canvas, ctx, W, H) {
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, W, H);
  }

  function _buildStaticCache(band) {
    const st     = DM.State.current;
    const W      = st.mapW;
    const H      = st.mapH;
    const layers = st.layers;

    if (!_belowCanvas) { _belowCanvas = document.createElement('canvas'); _belowCtx = _belowCanvas.getContext('2d'); }
    if (!_aboveCanvas) { _aboveCanvas = document.createElement('canvas'); _aboveCtx = _aboveCanvas.getContext('2d'); }

    DM.rng = new DM.RNG(1337);

    _prepCache(_belowCanvas, _belowCtx, W, H);
    DM.Draw.background(_belowCtx, W, H);
    for (let i = 0; i < band.first; i++) {
      if (layers[i].visible) _drawLayer(_belowCtx, layers[i], false);
    }

    _prepCache(_aboveCanvas, _aboveCtx, W, H);
    for (let i = band.last + 1; i < layers.length; i++) {
      if (layers[i].visible) _drawLayer(_aboveCtx, layers[i], false);
    }

    _cacheVersion = _mapVersion;
  }

  function _fastComposite() {
    const st  = DM.State.current;
    const ctx = _ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, st.mapW, st.mapH);
    ctx.drawImage(_belowCanvas, 0, 0);   // static scene under the animated band
    _drawAnimatedOnly(ctx);              // live fog / decals
    ctx.drawImage(_aboveCanvas, 0, 0);   // static scene over the animated band
    _drawGridAndOverlays(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function _animLoop(now) {
    const dt = now - _animLast;
    if (dt >= _ANIM_FAST_MS) {
      const band  = _animBand();                              // null → no clean split
      const cheap = band && _cacheVersion === _mapVersion;    // caches valid this frame
      if (cheap || dt >= _ANIM_SLOW_MS) {
        _animLast    = now;
        DM.animClock = now / 1000;
        if (!band) {
          _doRender(false);                            // full redraw (unchanged behaviour)
        } else if (cheap) {
          _fastComposite();                            // caches still valid → cheap
        } else if (_tickPrevVersion === _mapVersion) {
          _buildStaticCache(band);                     // map settled → build once, then composite
          _fastComposite();
        } else {
          _doRender(false);                            // still changing this frame → full redraw
        }
        _tickPrevVersion = _mapVersion;
      }
    }
    if (_hasAnimatedDecal()) {
      _animRafId = requestAnimationFrame(_animLoop);
    } else {
      _animRafId = null;
      _releaseStaticCaches();   // nothing animated left → free the full-size offscreens
    }
  }

  function _releaseStaticCaches() {
    if (_belowCanvas) { _belowCanvas.width = _belowCanvas.height = 0; }
    if (_aboveCanvas) { _aboveCanvas.width = _aboveCanvas.height = 0; }
    _belowCanvas = _belowCtx = _aboveCanvas = _aboveCtx = null;
    _cacheVersion = -1;
  }

  function _doRender(save = true) {
    const st  = DM.State.current;
    const ctx = _ctx;
    const W   = st.mapW;
    const H   = st.mapH;

    DM.rng = new DM.RNG(1337);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.clearRect(0, 0, W, H);

    _drawMapBody(ctx, false);
    _drawGridAndOverlays(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (save) DM.IO?.autoSave?.();
  }

  function _renderTick(now) {
    if (now - _lastDrawTs < _RENDER_MIN_MS) {
      _rafId = requestAnimationFrame(_renderTick);   // too soon → wait a frame
      return;
    }
    _rafId = null;
    if (!_renderPending) return;
    _renderPending = false;
    _lastDrawTs    = now;
    _doRender();
  }

  return {
    init(canvas) {
      _canvas        = canvas;
      _ctx           = canvas.getContext('2d');
      const st       = DM.State.current;
      canvas.width   = st.mapW;
      canvas.height  = st.mapH;
    },

    get canvas() { return _canvas; },
    get ctx()    { return _ctx; },

    resizeCanvas() {
      DM.Zoom.apply();
    },

    renderHD(scale = 1, target = null) {
      const st = DM.State.current;
      const W  = st.mapW;
      const H  = st.mapH;

      const offscreen = target || document.createElement('canvas');
      if (!target) {
        offscreen.width  = W * scale;
        offscreen.height = H * scale;
      }
      const ctx = offscreen.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(1, 0, 0, 1, 0, 0); // reset before scaling — critical when canvas is reused
      ctx.scale(scale, scale);

      DM.rng = new DM.RNG(1337);
      ctx.clearRect(0, 0, W, H);

      _drawMapBody(ctx, false);

      DM.Draw.grid(ctx, W, H, st.cellSize, st.gridType);

      return offscreen;
    },

    render() {
      _mapVersion++;
      _renderPending = true;
      if (_rafId == null) _rafId = requestAnimationFrame(_renderTick);
      DM.IO?._resumeAnim?.();
    },

    startDecalAnim() {
      if (_animRafId != null) return;
      if (!_hasAnimatedDecal()) return;
      _animLast        = 0;
      _tickPrevVersion = -1;   // force a full redraw on the first tick
      _animRafId       = requestAnimationFrame(_animLoop);
    },
  };
})();

DM.animClock = DM.animClock || 0;

'use strict';
window.DM = window.DM || {};

DM.Zoom = (() => {
  const MIN = 0.1;
  const MAX = 4.0;
  const STEPS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

  function apply() {
    const canvas = DM.Renderer.canvas;
    const st     = DM.State.current;
    const zoom   = st.zoom;
    if (canvas.width !== st.mapW || canvas.height !== st.mapH) {
      canvas.width  = st.mapW;
      canvas.height = st.mapH;
    }
    canvas.style.width  = Math.round(st.mapW * zoom) + 'px';
    canvas.style.height = Math.round(st.mapH * zoom) + 'px';
    const el = document.getElementById('zoom-val');
    if (el) el.textContent = Math.round(zoom * 100) + '%';
  }

  function set(value, vpX, vpY) {
    const area    = document.getElementById('canvas-area');
    const oldZoom = DM.State.current.zoom;
    const newZoom = Math.max(MIN, Math.min(MAX, value));
    if (Math.abs(newZoom - oldZoom) < 0.001) return;

    let cx, cy;
    if (vpX !== undefined && area) {
      cx = (vpX + area.scrollLeft) / oldZoom;
      cy = (vpY + area.scrollTop)  / oldZoom;
    }

    DM.State.current.zoom = newZoom;
    apply();

    if (cx !== undefined && area) {
      area.scrollLeft = cx * newZoom - vpX;
      area.scrollTop  = cy * newZoom - vpY;
    }
  }

  function zoomIn(vpX, vpY) {
    const cur  = DM.State.current.zoom;
    const next = STEPS.find(s => s > cur + 0.001) || MAX;
    set(next, vpX, vpY);
  }

  function zoomOut(vpX, vpY) {
    const cur  = DM.State.current.zoom;
    const prev = [...STEPS].reverse().find(s => s < cur - 0.001) || MIN;
    set(prev, vpX, vpY);
  }

  function reset() {
    const area = document.getElementById('canvas-area');
    const st   = DM.State.current;
    set(1);
    if (area) {
      const x = (st.mapW - area.clientWidth)  / 2;
      const y = (st.mapH - area.clientHeight) / 2;
      area.scrollLeft = Math.max(0, x);
      area.scrollTop  = Math.max(0, y);
    }
  }

  return { apply, set, zoomIn, zoomOut, reset, MIN, MAX };
})();

'use strict';
window.DM = window.DM || {};

DM.Tools = (() => {
  function _distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function hitTest(px, py, el) {
    const cs = DM.State.current.cellSize;
    if (el.type === 'brush') {
      const pts = el.points;
      if (!pts?.length) return false;
      const r = (el.size || 20) / 2 + 4;
      for (let i = 0; i < pts.length - 1; i++) {
        if (pts[i+1].m) continue; // pen-up marker: no segment across sub-strokes
        if (_distToSegment(px, py, pts[i].x, pts[i].y, pts[i+1].x, pts[i+1].y) <= r) return true;
      }
      return Math.hypot(px - pts[0].x, py - pts[0].y) <= r;
    }
    if (el.type === 'fog') {
      const r = DM.elementRect(el);
      return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    }
    if (DM.Config.POINT_TOOLS.has(el.type)) {
      if (el.w && el.h) {
        const r = DM.elementRect(el);
        return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
      }
      return Math.hypot(px - el.x, py - el.y) < cs * 0.7;
    }
    if (el.type === 'wall') {
      const hitR = Math.max(6, (el.borderWidth ?? 2.5) / 2 + 4);
      return _distToSegment(px, py, el.x, el.y, el.x2, el.y2) <= hitR;
    }
    if (el.type === 'text') {
      const hw = (el.w || 120) / 2 + 8;
      const hh = Math.max(40, (el.fontSize || 18) * 1.3 * 3);
      return Math.abs(px - el.x) <= hw && Math.abs(py - el.y) <= hh;
    }
    const r = DM.elementRect(el);
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function topCandidateAt(px, py) {
    const st   = DM.State.current;
    if (st.layers[st.activeLayerIdx].locked) return null;
    const prio = DM.Config.ERASE_PRIO;
    const cands = st.elements
      .map((el, i) => ({ el, i }))
      .filter(({ el }) => hitTest(px, py, el));
    if (!cands.length) return null;
    cands.sort((a, b) => (prio[a.el.type] ?? 99) - (prio[b.el.type] ?? 99));
    return cands[0];
  }

  function rotateAreaElement(el, steps) {
    const cs = DM.State.current.cellSize;
    for (let i = 0; i < steps; i++) {
      const { x, y, w, h } = DM.normalizeRect(el.x, el.y, el.w, el.h);
      const cx = x + w/2, cy = y + h/2;
      el.x = Math.round((cx - h/2) / cs) * cs;
      el.y = Math.round((cy - w/2) / cs) * cs;
      el.w = h; el.h = w;
    }
    if (el.type === 'stairs') {
      el.rotation = ((el.rotation || 0) + steps * Math.PI/2) % (Math.PI*2);
    }
  }

  function mousePos(e) {
    const r   = DM.Renderer.canvas.getBoundingClientRect();
    const st  = DM.State.current;
    const scX = st.mapW / r.width;
    const scY = st.mapH / r.height;
    return {
      x: (e.clientX - r.left) * scX,
      y: (e.clientY - r.top)  * scY,
    };
  }

  let _touching = false;

  function _touchPoint(e) {
    const t = e.touches[0] || e.changedTouches[0];
    return { clientX: t.clientX, clientY: t.clientY, buttons: 1 };
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    _touching = true;
    onMouseDown(_touchPoint(e));
  }

  function onTouchMove(e) {
    if (!_touching || e.touches.length !== 1) return;
    e.preventDefault();
    onMouseMove(_touchPoint(e));
  }

  function onTouchEnd(e) {
    if (!_touching) return;
    e.preventDefault();
    _touching = false;
    onMouseUp(_touchPoint(e));
  }

  function eraseAt(px, py) {
    const st = DM.State.current;
    if (st.layers[st.activeLayerIdx].locked) return;
    const hit = topCandidateAt(px, py);
    if (!hit) return;
    DM.State.removeElementAt(hit.i);
    DM.Renderer.render();
    DM.UI.updateProperties();
  }

  function snapVal(v, cs) {
    return Math.round(v / cs) * cs;
  }

  function resizeHandleHit(px, py, el) {
    const handles = DM.getResizeHandles(el);
    if (!handles) return -1;
    const HS = 9; // hit radius
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      if (Math.abs(px - h.x) <= HS && Math.abs(py - h.y) <= HS) return i;
    }
    return -1;
  }

  let _trackedInteraction = false;

  let _brushEl      = null; // stroke element currently being painted
  let _lastBrushPt  = null;
  let _brushLayerIdx = -1;  // layer index when brush stroke started

  function _brushNeedsPoint(x, y, size) {
    if (!_lastBrushPt) return true;
    return Math.hypot(x - _lastBrushPt.x, y - _lastBrushPt.y) >= Math.max(1, size * 0.2);
  }

  function _brushStyleMatch(a, b) {
    return a.color === b.color && a.size === b.size && a.shape === b.shape &&
           (a.opacity ?? 1)     === (b.opacity ?? 1) &&
           (a.assetId ?? null)  === (b.assetId ?? null) &&
           (a.assetScale ?? 1)  === (b.assetScale ?? 1) &&
           (a.borderColor ?? null) === (b.borderColor ?? null) &&
           (a.borderWidth ?? 0)    === (b.borderWidth ?? 0) &&
           (a.borderRough ?? null) === (b.borderRough ?? null);
  }

  function _brushStrokesTouch(a, b) {
    const pa = a.points, pb = b.points;
    if (!pa?.length || !pb?.length) return false;
    const thr = (a.size || 20) / 2 + (b.size || 20) / 2;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of pb) {
      if (p.x < bx0) bx0 = p.x; if (p.y < by0) by0 = p.y;
      if (p.x > bx1) bx1 = p.x; if (p.y > by1) by1 = p.y;
    }
    bx0 -= thr; by0 -= thr; bx1 += thr; by1 += thr;
    for (const p of pa) {
      if (p.x < bx0 || p.x > bx1 || p.y < by0 || p.y > by1) continue;
      for (let i = 0; i < pb.length; i++) {
        const hasSeg = i < pb.length - 1 && !pb[i + 1].m;
        const d = hasSeg
          ? _distToSegment(p.x, p.y, pb[i].x, pb[i].y, pb[i + 1].x, pb[i + 1].y)
          : Math.hypot(p.x - pb[i].x, p.y - pb[i].y);
        if (d <= thr) return true;
      }
    }
    return false;
  }

  function _mergeBrushStroke(newEl) {
    const st  = DM.State.current;
    const els = st.elements;
    const ni  = els.indexOf(newEl);
    if (ni < 0 || !newEl.points?.length) return;

    const hits = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el === newEl || el.type !== 'brush' || !el.points?.length) continue;
      if (_brushStyleMatch(el, newEl) && _brushStrokesTouch(newEl, el)) hits.push(i);
    }
    if (!hits.length) return;

    const base = els[hits[0]];
    const appendInto = (dst, src) => {
      dst.push({ x: src[0].x, y: src[0].y, m: true });
      for (let k = 1; k < src.length; k++) {
        dst.push(src[k].m ? { x: src[k].x, y: src[k].y, m: true } : { x: src[k].x, y: src[k].y });
      }
    };
    for (let h = 1; h < hits.length; h++) appendInto(base.points, els[hits[h]].points);
    appendInto(base.points, newEl.points);

    const remove = hits.slice(1).concat(ni).sort((x, y) => y - x);
    for (const i of remove) els.splice(i, 1);
  }

  let _fogEl       = null;  // fog cloud currently being painted
  let _lastFogPt   = null;
  let _fogLayerIdx = -1;

  function _makeFogPuff(x, y, size, density, soft) {
    return {
      bx: x, by: y,
      r: size * (0.5 + Math.random() * 0.6),
      squash: 0.55 + Math.random() * 0.5,
      rot: Math.random() * Math.PI,
      soft,
      baseAlpha: density * (0.4 + Math.random() * 0.6),
      phase:  Math.random() * Math.PI * 2,
      driftX: 35 + Math.random() * 55,
      driftY: 25 + Math.random() * 40,
      speed:  0.6 + Math.random() * 0.9,
      breath: 0.35 + Math.random() * 0.35,
    };
  }

  function _fogStamp(x, y) {
    const st  = DM.State.current;
    const sz  = st.fogSize    || 120;
    const den = st.fogDensity ?? 0.35;
    const sf  = st.fogSoft    ?? 0.7;
    const n   = 1 + Math.round(sz / 60);
    for (let i = 0; i < n; i++) {
      const jx = x + (Math.random() - 0.5) * sz * 0.5;
      const jy = y + (Math.random() - 0.5) * sz * 0.5;
      _fogEl.puffs.push(_makeFogPuff(jx, jy, sz, den, sf));
    }
  }

  function _fogStroke(x, y) {
    const sz   = DM.State.current.fogSize || 120;
    if (_lastFogPt) {
      const dx = x - _lastFogPt.x, dy = y - _lastFogPt.y, dist = Math.hypot(dx, dy);
      const step  = Math.max(4, sz * 0.15);
      const steps = Math.max(1, Math.floor(dist / step));
      for (let i = 1; i <= steps; i++) _fogStamp(_lastFogPt.x + dx * (i / steps), _lastFogPt.y + dy * (i / steps));
    } else {
      _fogStamp(x, y);
    }
    _lastFogPt = { x, y };
  }

  let _clipboard = null; // array of deep-copied element objects

  function _copySelected() {
    const st = DM.State.current;
    const ms = st.multiSelectedSet;
    if (!ms.size) return;
    _clipboard = [...ms]
      .filter(i => i >= 0 && i < st.elements.length)
      .map(i => JSON.parse(JSON.stringify(st.elements[i])));
  }

  function _pasteClipboard() {
    if (!_clipboard?.length) return;
    const st = DM.State.current;
    if (st.layers[st.activeLayerIdx].locked) return;
    const cs = st.cellSize;

    DM.State.saveHistory();
    const newIndices = [];

    for (const tpl of _clipboard) {
      const el = JSON.parse(JSON.stringify(tpl));
      el.x += cs;
      el.y += cs;
      if (el.type === 'wall') { el.x2 += cs; el.y2 += cs; }
      if (el.type === 'brush' && Array.isArray(el.points)) {
        el.points = el.points.map(p => p.m
          ? ({ x: p.x + cs, y: p.y + cs, m: true })
          : ({ x: p.x + cs, y: p.y + cs }));
      }
      st.elements.push(el);
      newIndices.push(st.elements.length - 1);
    }

    st.multiSelectedSet.clear();
    for (const idx of newIndices) st.multiSelectedSet.add(idx);
    st.selectedIdx = newIndices[newIndices.length - 1];

    DM.UI.selectTool('select');
    DM.Renderer.render();
    DM.UI.updateProperties();
    DM.UI.updateMultiSelectPopup();
  }

  function _duplicateSelected() {
    _copySelected();
    _pasteClipboard();
  }

  let _pan = null; // { startX, startY, scrollLeft, scrollTop }

  let _rubberBand = null; // { sx, sy, ex, ey, additive }

  function _panStart(e) {
    const area = document.getElementById('canvas-area');
    if (!area) return;
    _pan = {
      startX:     e.clientX,
      startY:     e.clientY,
      scrollLeft: area.scrollLeft,
      scrollTop:  area.scrollTop,
    };
  }

  function _panMove(e) {
    if (!_pan) return;
    const area = document.getElementById('canvas-area');
    if (!area) return;
    area.scrollLeft = _pan.scrollLeft - (e.clientX - _pan.startX);
    area.scrollTop  = _pan.scrollTop  - (e.clientY - _pan.startY);
  }

  function _panEnd() { _pan = null; }

  let _drag = null;

  function onMouseDown(e) {
    const p  = mousePos(e);
    const st = DM.State.current;

    if (!_trackedInteraction) { _trackedInteraction = true; DM.track?.('map_interaction'); }

    if (st.tool === 'hand') { _panStart(e); return; }

    if (st.tool === 'erase') { eraseAt(p.x, p.y); return; }

    if (st.tool === 'brush') {
      if (st.layers[st.activeLayerIdx].locked) return;
      _brushEl = {
        type:       'brush',
        points:     [{ x: p.x, y: p.y }],
        color:      st.brushColor      || '#8b7355',
        size:       st.brushSize       || 20,
        shape:      st.brushShape      || 'round',
        opacity:    st.brushOpacity    ?? 1,
        assetId:    st.brushAssetId    || null,
        assetScale: st.brushAssetScale ?? 1,
      };
      if (_brushEl.shape === 'cave') {
        _brushEl.borderColor = st.brushBorderColor || null;
        _brushEl.borderWidth = st.brushBorderWidth ?? 0;
        _brushEl.borderRough = st.brushBorderRough ?? 0.5;
      }
      _lastBrushPt   = { x: p.x, y: p.y };
      _brushLayerIdx = st.activeLayerIdx;
      DM.State.saveHistory();
      st.elements.push(_brushEl);
      DM.Renderer.render();
      return;
    }

    if (st.tool === 'fog') {
      if (st.layers[st.activeLayerIdx].locked) return;
      _fogEl = {
        type:      'fog',
        x:         0,
        y:         0,
        puffs:     [],
        color:     st.fogColor      || '#cdd4e1',
        opacity:   1,
        animated:  st.fogAnimated !== false,
        animSpeed: st.fogAnimSpeed ?? 1,
      };
      _lastFogPt   = null;
      _fogLayerIdx = st.activeLayerIdx;
      DM.State.saveHistory();
      st.elements.push(_fogEl);
      _fogStroke(p.x, p.y);
      DM.Renderer.render();
      if (_fogEl.animated) DM.Renderer.startDecalAnim();
      return;
    }

    if (st.tool === 'fill') {
      if (st.layers[st.activeLayerIdx].locked) return;

      const cs    = st.cellSize;
      const cells = DM.buildCellGrid(st.elements);
      const gx    = Math.floor(p.x / cs);
      const gy    = Math.floor(p.y / cs);

      DM.State.saveHistory();

      if (cells[`${gx},${gy}`]) {
        const visited = new Set();
        const queue   = [[gx, gy]];
        const filled  = new Set();
        while (queue.length) {
          const [cx, cy] = queue.shift();
          const key = `${cx},${cy}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const el = cells[key];
          if (!el) continue;
          filled.add(el);
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nk = `${cx+dx},${cy+dy}`;
            if (!visited.has(nk) && cells[nk]) queue.push([cx+dx, cy+dy]);
          }
        }
        for (const el of filled) {
          el.color          = st.fillColor;
          el.fillAssetId    = st.fillAssetId    || null;
          el.fillAssetScale = st.fillAssetScale ?? 1;
        }
      } else {
        const layer = st.layers[st.activeLayerIdx];
        let bgEl = layer.elements.find(e => e.type === 'bg-fill');
        if (!bgEl) {
          bgEl = { type: 'bg-fill', x: 0, y: 0, w: st.mapW, h: st.mapH, opacity: 1 };
          layer.elements.push(bgEl);
        }
        bgEl.color          = st.fillColor;
        bgEl.fillAssetId    = st.fillAssetId    || null;
        bgEl.fillAssetScale = st.fillAssetScale ?? 1;
      }

      DM.Renderer.render();
      return;
    }

    if (st.tool === 'text') {
      st.pendingTextPos = p;
      DM.UI.openTextModal(p);
      return;
    }

    if (st.tool === 'image') {
      if (!st.pendingAssetId) return;
      if (st.layers[st.activeLayerIdx].locked) return;
      const cs    = st.cellSize;
      const asset = DM.State.getAsset(st.pendingAssetId);
      const frame = DM.getAnimFrame(asset);
      const w     = cs * 4;
      const h     = frame ? Math.round(w * frame.height / frame.width) : w;
      DM.State.addElement({
        type: 'image',
        x: Math.round(p.x) - w / 2,
        y: Math.round(p.y) - h / 2,
        w, h,
        assetId: st.pendingAssetId,
        rotation: 0, opacity: 1,
        physical: asset?.physical || false,
      });
      DM.Renderer.render();
      DM.UI.updateProperties();
      return;
    }

    if (st.tool === 'select') {
      const ms = st.multiSelectedSet;

      if (ms.size <= 1 && st.selectedIdx >= 0 && st.selectedIdx < st.elements.length) {
        const el = st.elements[st.selectedIdx];

        const rIdx = resizeHandleHit(p.x, p.y, el);
        if (rIdx >= 0) {
          const rect = DM.elementRect(el);
          _drag = {
            type:      'resize',
            handleIdx: rIdx,
            origRect:  { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
            startX:    p.x,
            startY:    p.y,
          };
          return;
        }

        if (el.type !== 'wall' && el.type !== 'fog') {
          const rotH = DM.getRotateHandle(el);
          if (Math.hypot(p.x - rotH.x, p.y - rotH.y) < 12) {
            const c = DM.elementCenter(el);
            _drag = { type: 'rotate', cx: c.x, cy: c.y, el };
            return;
          }
        }
      }

      const hit = topCandidateAt(p.x, p.y);

      if (hit) {
        if (e.shiftKey) {
          if (ms.has(hit.i)) {
            ms.delete(hit.i);
            if (st.selectedIdx === hit.i) {
              st.selectedIdx = ms.size > 0 ? [...ms].at(-1) : -1;
            }
          } else {
            ms.add(hit.i);
            st.selectedIdx = hit.i;
          }
        } else {
          if (!ms.has(hit.i)) {
            ms.clear();
            ms.add(hit.i);
          }
          st.selectedIdx = hit.i;
        }

        const origPositions = [...ms].map(i => {
          const e = st.elements[i];
          return { i, x: e.x, y: e.y, x2: e.x2, y2: e.y2 };
        });
        _drag = { type: 'move', sx: p.x, sy: p.y, origPositions };
        DM.UI.updateProperties();
        DM.UI.updateMultiSelectPopup();
      } else {
        if (!e.shiftKey) {
          ms.clear();
          st.selectedIdx = -1;
          DM.UI.updateProperties();
          DM.UI.updateMultiSelectPopup();
        }
        _rubberBand = { sx: p.x, sy: p.y, ex: p.x, ey: p.y, additive: e.shiftKey };
        st.rubberBand = _rubberBand;
      }

      DM.Renderer.render();
      return;
    }

    if (DM.Config.POINT_TOOLS.has(st.tool)) {
      if (st.layers[st.activeLayerIdx].locked) return;
      const cs = st.cellSize;
      const elData = { type: st.tool, x: Math.round(p.x), y: Math.round(p.y), w: cs * 2, h: cs * 2, rotation: 0, scale: 1, color: null };
      if (st.tool === 'door') {
        elData.w       = cs;
        elData.assetId = st.doorAssetId || null;
        if (st.doorAssetId) {
          const _dimg = DM.State.getAsset(st.doorAssetId)?._img;
          elData.h = _dimg ? Math.round(cs * _dimg.height / _dimg.width) : cs;
        } else {
          elData.h = Math.round(cs * 0.25);
        }
      }
      DM.State.addElement(elData);
      DM.Renderer.render();
      return;
    }

    if (DM.Config.AREA_TOOLS.has(st.tool) || st.tool === 'wall') {
      if (st.layers[st.activeLayerIdx].locked) return;
      const rawP   = { x: Math.round(p.x), y: Math.round(p.y) };
      st.drawing   = true;
      st.drawStart = rawP;
      st.drawEnd   = rawP;
    }
  }

  function onMouseMove(e) {
    const p  = mousePos(e);
    const st = DM.State.current;
    st.mouseX = p.x; st.mouseY = p.y;

    const cs = st.cellSize;
    const cx = Math.floor(p.x / cs), cy = Math.floor(p.y / cs);
    const coordEl = document.getElementById('coords');
    if (coordEl) coordEl.textContent = `${cx}, ${cy}`;

    updateCursor(p);

    if (e.buttons !== 1) {
      return;
    }

    if (st.tool === 'hand') { _panMove(e); return; }

    if (st.tool === 'erase') { eraseAt(p.x, p.y); return; }

    if (st.tool === 'brush' && _brushEl) {
      if (st.activeLayerIdx !== _brushLayerIdx) {
        _brushEl = null; _lastBrushPt = null; _brushLayerIdx = -1;
      } else if (_brushNeedsPoint(p.x, p.y, _brushEl.size)) {
        _brushEl.points.push({ x: p.x, y: p.y });
        _lastBrushPt = { x: p.x, y: p.y };
        DM.Renderer.render();
      }
      return;
    }

    if (st.tool === 'fog' && _fogEl) {
      if (st.activeLayerIdx !== _fogLayerIdx) {
        _fogEl = null; _lastFogPt = null; _fogLayerIdx = -1;
      } else if (!_lastFogPt || Math.hypot(p.x - _lastFogPt.x, p.y - _lastFogPt.y) >= Math.max(4, (st.fogSize || 120) * 0.15)) {
        _fogStroke(p.x, p.y);
        DM.Renderer.render();
      }
      return;
    }

    if (st.tool === 'select') {
      if (_rubberBand) {
        _rubberBand.ex = p.x;
        _rubberBand.ey = p.y;
        st.rubberBand  = { ..._rubberBand };
        DM.Renderer.render();
        return;
      }

      if (_drag && st.selectedIdx >= 0) {
        const el = st.elements[st.selectedIdx];

        if (_drag.type === 'rotate') {
          const angle = Math.atan2(p.y - _drag.cy, p.x - _drag.cx) + Math.PI / 2;
          if (DM.Config.POINT_TOOLS.has(el.type) || el.type === 'text' || el.type === 'image') {
            el.rotation = angle;
          } else {
            el._previewRot = (Math.round(angle / (Math.PI / 2)) * Math.PI / 2 + Math.PI * 4) % (Math.PI * 2);
          }
        } else if (_drag.type === 'move') {
          const dx = p.x - _drag.sx;
          const dy = p.y - _drag.sy;
          for (const { i, x, y, x2, y2 } of _drag.origPositions) {
            if (i >= 0 && i < st.elements.length) {
              st.elements[i].x = Math.round(x + dx);
              st.elements[i].y = Math.round(y + dy);
              if (st.elements[i].type === 'wall' && x2 !== undefined) {
                st.elements[i].x2 = Math.round(x2 + dx);
                st.elements[i].y2 = Math.round(y2 + dy);
              }
            }
          }
        } else if (_drag.type === 'resize' && st.multiSelectedSet.size <= 1) {
          _applyResize(el, p, e.shiftKey);
        }

        DM.Renderer.render();
        return;
      }
    }

    if (st.drawing) {
      st.drawEnd = { x: Math.round(p.x), y: Math.round(p.y) };
      DM.Renderer.render();
    }
  }

  function _applyResize(el, p, shiftKey) {
    const { handleIdx, origRect, startX, startY } = _drag;
    const or = origRect;
    const dx = Math.round(p.x - startX);
    const dy = Math.round(p.y - startY);

    let nx = or.x, ny = or.y, nw = or.w, nh = or.h;

    const isCorner = [0, 2, 5, 7].includes(handleIdx);

    if (isCorner && !shiftKey) {
      const aspect     = or.w / Math.max(or.h, 1);
      const scaleDelta = Math.max(Math.abs(dx), Math.abs(dy));

      switch (handleIdx) {
        case 0: { // TL
          const sd = scaleDelta * (dx > 0 || dy > 0 ? 1 : -1);
          nw = Math.max(1, or.w - Math.round(sd));
          nh = Math.max(1, Math.round(nw / aspect));
          nx = or.x + or.w - nw;
          ny = or.y + or.h - nh;
          break;
        }
        case 2: { // TR
          const sd = scaleDelta * (dx > 0 || dy < 0 ? 1 : -1);
          nw = Math.max(1, or.w + Math.round(sd));
          nh = Math.max(1, Math.round(nw / aspect));
          ny = or.y + or.h - nh;
          break;
        }
        case 5: { // BL
          const sd = scaleDelta * (dx < 0 || dy > 0 ? 1 : -1);
          nw = Math.max(1, or.w + Math.round(sd));
          nh = Math.max(1, Math.round(nw / aspect));
          nx = or.x + or.w - nw;
          break;
        }
        case 7: { // BR
          const sd = scaleDelta * (dx > 0 || dy > 0 ? 1 : -1);
          nw = Math.max(1, or.w + Math.round(sd));
          nh = Math.max(1, Math.round(nw / aspect));
          break;
        }
      }
    } else if (isCorner && shiftKey) {
      switch (handleIdx) {
        case 0: nw = Math.max(1, or.w - dx); nh = Math.max(1, or.h - dy); nx = or.x + or.w - nw; ny = or.y + or.h - nh; break;
        case 2: nw = Math.max(1, or.w + dx); nh = Math.max(1, or.h - dy); ny = or.y + or.h - nh; break;
        case 5: nw = Math.max(1, or.w - dx); nh = Math.max(1, or.h + dy); nx = or.x + or.w - nw; break;
        case 7: nw = Math.max(1, or.w + dx); nh = Math.max(1, or.h + dy); break;
      }
    } else {
      switch (handleIdx) {
        case 1: nh = Math.max(1, or.h - dy); ny = or.y + or.h - nh; break; // TC
        case 6: nh = Math.max(1, or.h + dy); break;                          // BC
        case 3: nw = Math.max(1, or.w - dx); nx = or.x + or.w - nw; break;  // ML
        case 4: nw = Math.max(1, or.w + dx); break;                          // MR
      }
    }

    if (DM.Config.POINT_TOOLS.has(el.type)) {
      el.x = nx + nw / 2;
      el.y = ny + nh / 2;
    } else {
      el.x = nx; el.y = ny;
    }
    el.w = nw; el.h = nh;

    if (el.type === 'door') {
      const cs = DM.State.current.cellSize;
      el.w = Math.max(cs, Math.round(el.w / cs) * cs);
      if (el.assetId) {
        const _dimg = DM.State.getAsset(el.assetId)?._img;
        el.h = _dimg ? Math.round(el.w * _dimg.height / _dimg.width) : el.w;
      } else {
        el.h = Math.round(cs * 0.25);
      }
    }
  }

  function onMouseUp(e) {
    const p  = mousePos(e);
    const st = DM.State.current;

    if (_pan) { _panEnd(); return; }

    if (_brushEl) {
      _mergeBrushStroke(_brushEl);
      _brushEl     = null;
      _lastBrushPt = null;
      DM.track?.('element_added', { type: 'brush' });
      return;
    }

    if (_fogEl) {
      _fogEl       = null;
      _lastFogPt   = null;
      _fogLayerIdx = -1;
      DM.track?.('element_added', { type: 'fog' });
      return;
    }

    if (_rubberBand) {
      const rb = _rubberBand;
      _rubberBand   = null;
      st.rubberBand = null;

      const { x: bx, y: by, w: bw, h: bh } = DM.normalizeRect(
        rb.sx, rb.sy, rb.ex - rb.sx, rb.ey - rb.sy
      );
      const ms = st.multiSelectedSet;

      if (bw > 4 || bh > 4) {
        if (!rb.additive) ms.clear();
        const layer = st.layers[st.activeLayerIdx];
        if (!layer.locked) {
          st.elements.forEach((el, i) => {
            const c = DM.elementCenter(el);
            if (c.x >= bx && c.x <= bx + bw && c.y >= by && c.y <= by + bh) ms.add(i);
          });
        }
      } else if (!rb.additive) {
        ms.clear();
      }

      if (ms.size === 1) {
        st.selectedIdx = [...ms][0];
      } else if (ms.size === 0) {
        st.selectedIdx = -1;
      } else if (!ms.has(st.selectedIdx)) {
        st.selectedIdx = [...ms].at(-1);
      }

      DM.Renderer.render();
      DM.UI.updateProperties();
      DM.UI.updateMultiSelectPopup();
      return;
    }

    if (_drag) {
      if (_drag.type === 'rotate' && st.selectedIdx >= 0) {
        const el = st.elements[st.selectedIdx];
        if (!DM.Config.POINT_TOOLS.has(el.type) && el.type !== 'text' && el.type !== 'image'
            && el._previewRot !== undefined) {
          const steps = (Math.round(el._previewRot / (Math.PI/2)) + 4) % 4;
          if (steps > 0) rotateAreaElement(el, steps);
          delete el._previewRot;
        }
        DM.State.saveHistory();
      } else if (_drag.type === 'resize') {
        DM.State.saveHistory();
      } else if (_drag.type === 'move') {
        DM.State.saveHistory();
      }
      _drag = null;
      DM.UI.updateProperties();
      DM.Renderer.render();
      return;
    }

    if (!st.drawing) return;
    st.drawing = false;

    const { x: sx, y: sy } = st.drawStart;
    const { x: ex, y: ey } = st.drawEnd;
    const dx = Math.abs(ex - sx), dy = Math.abs(ey - sy);
    if (dx < 2 && dy < 2) {
      DM.Renderer.render(); return;
    }

    if (st.tool === 'wall') {
      DM.State.addElement({ type: 'wall', x: sx, y: sy, x2: ex, y2: ey, opacity: 1 });
      DM.Renderer.render();
      return;
    }

    const { x, y, w, h } = DM.normalizeRect(sx, sy, ex - sx, ey - sy);
    const shape      = (st.tool === 'room' && st.roomShape    === 'circle') ? 'circle' : undefined;
    const stoneStyle = (st.tool === 'room' && st.roomStoneStyle === 'ink')  ? 'ink'    : undefined;
    DM.State.addElement({ type: st.tool, x, y, w, h, rotation: 0, color: null, wallColor: null, ...(shape && { shape }), ...(stoneStyle && { stoneStyle }) });
    if (st.tool === 'room') {
      const newEl = st.elements[st.elements.length - 1];
      if (newEl) DM.applyConnectedStyle?.(newEl);
    }
    DM.Renderer.render();
  }

  function updateCursor(p) {
    const st  = DM.State.current;
    const cnv = DM.Renderer.canvas;
    if (st.tool === 'hand')  { cnv.style.cursor = _pan ? 'grabbing' : 'grab'; return; }
    if (st.tool === 'erase') { cnv.style.cursor = 'cell'; return; }
    if (st.tool === 'fill')  { cnv.style.cursor = 'crosshair'; return; }
    if (st.tool === 'image') { cnv.style.cursor = 'crosshair'; return; }
    if (st.tool === 'select') {
      const ms = st.multiSelectedSet;
      if (ms.size <= 1 && st.selectedIdx >= 0 && st.selectedIdx < st.elements.length) {
        const el = st.elements[st.selectedIdx];
        const rIdx = resizeHandleHit(p.x, p.y, el);
        if (rIdx >= 0) { cnv.style.cursor = DM.resizeHandleCursor(rIdx); return; }
        const h = DM.getRotateHandle(el);
        if (Math.hypot(p.x - h.x, p.y - h.y) < 12) { cnv.style.cursor = 'pointer'; return; }
      }
      if (ms.size > 0) {
        for (const idx of ms) {
          if (idx >= 0 && idx < st.elements.length && hitTest(p.x, p.y, st.elements[idx])) {
            cnv.style.cursor = 'move'; return;
          }
        }
      }
      cnv.style.cursor = 'default'; return;
    }
    cnv.style.cursor = 'crosshair';
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const st = DM.State.current;

    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey)) {
      if (DM.State.undo()) { DM.Renderer.render(); DM.UI.updateLayersPanel(); }
      return;
    }
    if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
      _copySelected(); return;
    }
    if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); _pasteClipboard(); return;
    }
    if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); _duplicateSelected(); return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.tool === 'select') {
      const ms = st.multiSelectedSet;
      if (ms.size === 0) return;
      DM.State.saveHistory();
      const sorted = [...ms].sort((a, b) => b - a);
      for (const idx of sorted) {
        if (idx >= 0 && idx < st.elements.length) st.elements.splice(idx, 1);
      }
      ms.clear();
      st.selectedIdx = -1;
      DM.Renderer.render();
      DM.UI.updateProperties();
      DM.UI.updateMultiSelectPopup();
      return;
    }
    if (e.key === 'r' && st.tool === 'select' && st.selectedIdx >= 0 && st.multiSelectedSet.size <= 1) {
      DM.State.saveHistory();
      const el = st.elements[st.selectedIdx];
      if (el.type === 'wall') return;
      if (DM.Config.POINT_TOOLS.has(el.type) || el.type === 'text' || el.type === 'image') {
        el.rotation = ((el.rotation || 0) + Math.PI/4) % (Math.PI*2);
      } else {
        rotateAreaElement(el, 1);
      }
      DM.Renderer.render();
      DM.UI.updateProperties();
      return;
    }
    if (e.key === 'Escape') {
      st.selectedIdx = -1;
      st.multiSelectedSet.clear();
      st.rubberBand  = null;
      DM.Renderer.render();
      DM.UI.updateProperties();
      DM.UI.updateMultiSelectPopup();
      return;
    }
    const shortcuts = {
      s: 'select', e: 'erase', r: 'room',
      w: 'water',  d: 'door',  t: 'torch',
      p: 'pillar', x: 'trap',  h: 'hand',
    };
    const k = e.key.toLowerCase();
    if (shortcuts[k] && !e.ctrlKey && !e.metaKey) {
      DM.UI.selectTool(shortcuts[k]);
    }
  }

  return {
    duplicate() { _duplicateSelected(); },

    init() {
      const cnv  = DM.Renderer.canvas;
      const area = document.getElementById('canvas-area');

      cnv.addEventListener('mousedown',  onMouseDown);
      cnv.addEventListener('mousemove',  onMouseMove);
      cnv.addEventListener('mouseup',    onMouseUp);
      cnv.addEventListener('mouseleave', () => {
        const st = DM.State.current;
        let needsRender = false;
        if (st.drawing) { st.drawing = false; needsRender = true; }
        if (_rubberBand) {
          _rubberBand = null; st.rubberBand = null; needsRender = true;
          DM.UI.updateProperties();
          DM.UI.updateMultiSelectPopup();
        }
        if (needsRender) DM.Renderer.render();
      });

      cnv.addEventListener('touchstart',  onTouchStart,  { passive: false });
      cnv.addEventListener('touchmove',   onTouchMove,   { passive: false });
      cnv.addEventListener('touchend',    onTouchEnd,    { passive: false });
      cnv.addEventListener('touchcancel', onTouchEnd,    { passive: false });

      area.addEventListener('wheel', e => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const rect = area.getBoundingClientRect();
        const vpX  = e.clientX - rect.left;
        const vpY  = e.clientY - rect.top;
        if (e.deltaY < 0) DM.Zoom.zoomIn(vpX, vpY);
        else               DM.Zoom.zoomOut(vpX, vpY);
      }, { passive: false });

      document.addEventListener('keydown', onKeyDown);
    },
  };
})();
'use strict';
window.DM = window.DM || {};

DM.Generator = (() => {

  const MIN_BSP     = 4;    // minimum BSP leaf dimension (grid cells)
  const MIN_ROOM    = 4;    // minimum room side (grid cells)
  const CIRCLE_RATE = 0.35; // probability a large room (≥ 5×5 cells) becomes a circle
  const PILLAR_STEP = 3;    // 1-in-N large rooms receive pillars (after shuffle)

  class Node {
    constructor(x, y, w, h) {
      this.x = x; this.y = y; this.w = w; this.h = h;
      this.left  = null;
      this.right = null;
      this.room  = null; // { x, y, w, h } in grid cells
    }
  }

  function bspSplit(node, depth, rng) {
    if (depth === 0) return;
    if (node.w < MIN_BSP * 2 && node.h < MIN_BSP * 2) return;

    const horiz = node.w < node.h ? true
                : node.h < node.w ? false
                : rng.next() > 0.5;

    if (horiz && node.h >= MIN_BSP * 2) {
      const at = MIN_BSP + Math.floor(rng.next() * (node.h - MIN_BSP * 2));
      node.left  = new Node(node.x, node.y,      node.w, at);
      node.right = new Node(node.x, node.y + at, node.w, node.h - at);
    } else if (!horiz && node.w >= MIN_BSP * 2) {
      const at = MIN_BSP + Math.floor(rng.next() * (node.w - MIN_BSP * 2));
      node.left  = new Node(node.x,      node.y, at,          node.h);
      node.right = new Node(node.x + at, node.y, node.w - at, node.h);
    } else return;

    bspSplit(node.left,  depth - 1, rng);
    bspSplit(node.right, depth - 1, rng);
  }

  function bspPlaceRooms(node, rng) {
    if (!node.left && !node.right) {
      const margin = 1;
      const maxW = Math.max(MIN_ROOM, node.w - margin * 2);
      const maxH = Math.max(MIN_ROOM, node.h - margin * 2);
      const rw = MIN_ROOM + Math.floor(rng.next() * (maxW - MIN_ROOM + 1));
      const rh = MIN_ROOM + Math.floor(rng.next() * (maxH - MIN_ROOM + 1));
      const rx = node.x + margin + Math.floor(rng.next() * Math.max(0, node.w - rw - margin * 2));
      const ry = node.y + margin + Math.floor(rng.next() * Math.max(0, node.h - rh - margin * 2));
      node.room = { x: rx, y: ry, w: rw, h: rh };
      return;
    }
    if (node.left)  bspPlaceRooms(node.left,  rng);
    if (node.right) bspPlaceRooms(node.right, rng);
    node.room = node.left?.room ?? node.right?.room ?? null;
  }

  function collectLeafRooms(node, out = []) {
    if (!node) return out;
    if (!node.left && !node.right && node.room) { out.push(node.room); return out; }
    collectLeafRooms(node.left,  out);
    collectLeafRooms(node.right, out);
    return out;
  }

  function shuffle(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const mkPoint = (type, cx, cy, rotation, cs) => ({
    type, rotation, scale: 1, color: null,
    x: (cx + 0.5) * cs,
    y: (cy + 0.5) * cs,
    w: cs * 2,
    h: cs * 2,
  });

  function corridorRects(a, b, cs) {
    const ax = Math.floor(a.x + a.w / 2), ay = Math.floor(a.y + a.h / 2);
    const bx = Math.floor(b.x + b.w / 2), by = Math.floor(b.y + b.h / 2);
    const rects = [];

    const horizEntersB = ax !== bx && ay >= b.y && ay < b.y + b.h;

    if (ax !== bx) {
      if (horizEntersB) {
        if (ax < bx) {
          const w = b.x - ax;
          if (w > 0) rects.push({ x: ax * cs, y: ay * cs, w: w * cs, h: cs });
        } else {
          const x = b.x + b.w, w = ax - x;
          if (w > 0) rects.push({ x: x * cs, y: ay * cs, w: w * cs, h: cs });
        }
      } else {
        const lx = Math.min(ax, bx), rx = Math.max(ax, bx);
        rects.push({ x: lx * cs, y: ay * cs, w: (rx - lx + 1) * cs, h: cs });
      }
    }

    if (!horizEntersB && ay !== by) {
      if (ay < b.y) {
        const h = b.y - ay;
        if (h > 0) rects.push({ x: bx * cs, y: ay * cs, w: cs, h: h * cs });
      } else {
        const sy = b.y + b.h;
        if (ay > sy) rects.push({ x: bx * cs, y: sy * cs, w: cs, h: (ay - sy) * cs });
      }
    }

    return rects;
  }

  function addPairDoors(rects, a, b, cs, doors, seen, allRoom) {
    const ends = new Set();
    for (const r of [a, b]) {
      if (r.circle) continue;                              // circular rooms → no doors
      for (let gx = r.x; gx < r.x + r.w; gx++)
        for (let gy = r.y; gy < r.y + r.h; gy++)
          ends.add(gx + ',' + gy);
    }
    if (!ends.size) return;
    const isEnd  = (gx, gy) => ends.has(gx + ',' + gy);
    const isOpen = (gx, gy) => !allRoom.has(gx + ',' + gy);   // outside every room

    const addV = (edgeX, row) => {           // door on vertical grid-line x=edgeX, at row
      const k = 'v' + edgeX + ',' + row;
      if (seen.has(k)) return; seen.add(k);
      doors.push({ type: 'door', x: edgeX * cs, y: (row + 0.5) * cs,
        w: cs, h: Math.round(cs * 0.25), rotation: Math.PI / 2, scale: 1, color: null });
    };
    const addH = (col, edgeY) => {           // door on horizontal grid-line y=edgeY, at column
      const k = 'h' + col + ',' + edgeY;
      if (seen.has(k)) return; seen.add(k);
      doors.push({ type: 'door', x: (col + 0.5) * cs, y: edgeY * cs,
        w: cs, h: Math.round(cs * 0.25), rotation: 0, scale: 1, color: null });
    };

    for (const c of rects) {
      const gx0 = Math.round(c.x / cs), gy0 = Math.round(c.y / cs);
      const wc  = Math.round(c.w / cs), hc  = Math.round(c.h / cs);
      if (wc < 1 || hc < 1) continue;

      if (hc === 1) {                        // horizontal strip → scan x, pierce W/E walls
        const row = gy0;
        for (let gx = gx0; gx < gx0 + wc; gx++) {
          if (!isOpen(gx, row)) continue;                  // must be an open corridor cell
          if (isEnd(gx - 1, row)) addV(gx, row);           // a/b to the west → door on west edge
          if (isEnd(gx + 1, row)) addV(gx + 1, row);       // a/b to the east → door on east edge
        }
      }
      if (wc === 1) {                        // vertical strip → scan y, pierce N/S walls
        const col = gx0;
        for (let gy = gy0; gy < gy0 + hc; gy++) {
          if (!isOpen(col, gy)) continue;
          if (isEnd(col, gy - 1)) addH(col, gy);           // a/b to the north → door on north edge
          if (isEnd(col, gy + 1)) addH(col, gy + 1);       // a/b to the south → door on south edge
        }
      }
    }
  }

  function pruneInteriorDoors(doors, rooms, cs) {
    const eps = cs * 0.01;                     // treat exact-on-edge as boundary
    const inside = (dx, dy) => {
      for (const r of rooms) {
        const rx = r.x * cs, ry = r.y * cs, rw = r.w * cs, rh = r.h * cs;
        if (dx <= rx + eps || dx >= rx + rw - eps ||
            dy <= ry + eps || dy >= ry + rh - eps) continue;
        if (r.circle) {                        // circle → must be inside the ellipse
          const nx = (dx - (rx + rw / 2)) / (rw / 2);
          const ny = (dy - (ry + rh / 2)) / (rh / 2);
          if (nx * nx + ny * ny >= 1) continue;
        }
        return true;                           // strictly inside this room
      }
      return false;
    };
    return doors.filter(d => !inside(d.x, d.y));
  }

  function makeStairs(room, cs) {
    const sw = Math.max(2, Math.round(room.w * 0.60)) * cs;
    const sh = Math.max(2, Math.round(room.h * 0.45)) * cs;
    const sx = room.x * cs + Math.round((room.w * cs - sw) / 2);
    const sy = room.y * cs + room.h * cs - sh - cs;
    return {
      el:  { type: 'stairs', x: sx, y: sy, w: sw, h: sh, rotation: 0 },
      gx0: sx / cs | 0,
      gy0: sy / cs | 0,
      gx1: (sx + sw) / cs | 0,
      gy1: (sy + sh) / cs | 0,
    };
  }

  function makeOcc() {
    const cells = new Set();
    const key = (cx, cy) => `${cx},${cy}`;
    return {
      free:     (cx, cy)              => !cells.has(key(cx, cy)),
      add:      (cx, cy)              => cells.add(key(cx, cy)),
      fillRect: (gx0, gy0, gx1, gy1) => {
        for (let cx = gx0; cx < gx1; cx++)
          for (let cy = gy0; cy < gy1; cy++)
            cells.add(key(cx, cy));
      },
    };
  }

  function placePillars(room, occ, cs) {
    const { x, y, w, h } = room;
    if (w < 6 || h < 5) return [];

    const positions = [
      [x + 1,     y + 1    ],  // NW inner corner
      [x + w - 2, y + 1    ],  // NE inner corner
      [x + 1,     y + h - 2],  // SW inner corner
      [x + w - 2, y + h - 2],  // SE inner corner
    ];

    if (w >= 9 && w / h >= 1.7) {
      const mx = x + Math.floor(w / 2);
      positions.push([mx, y + 1], [mx, y + h - 2]);
    } else if (h >= 9 && h / w >= 1.7) {
      const my = y + Math.floor(h / 2);
      positions.push([x + 1, my], [x + w - 2, my]);
    }

    const els = [];
    for (const [cx, cy] of positions) {
      if (occ.free(cx, cy)) {
        occ.add(cx, cy);
        els.push(mkPoint('pillar', cx, cy, 0, cs));
      }
    }
    return els;
  }

  return {

    generate(numRooms, seed, opts = {}) {
      const { style = 'ink', pillars: addPillars = false, stairs: addStairs = false } = opts;

      const cs  = DM.State.current.cellSize;
      const st  = DM.State.current;
      const W   = Math.floor((st.mapW || DM.Config.MAP_W) / cs) - 2;
      const H   = Math.floor((st.mapH || DM.Config.MAP_H) / cs) - 2;
      const rng = new DM.RNG(seed || Date.now());

      const makeRoom = (x, y, w, h, isCircle = false) => ({
        type: 'room', x, y, w, h, rotation: 0, color: null, wallColor: null,
        ...(isCircle && { shape: 'circle' }),
        ...(style === 'ink' && { stoneStyle: 'ink', borderColor: '#292929' }),
      });

      const depth = Math.ceil(Math.log2(Math.max(2, numRooms)));
      const root  = new Node(1, 1, W, H);
      bspSplit(root, depth, rng);
      bspPlaceRooms(root, rng);

      const rooms = collectLeafRooms(root).slice(0, numRooms);
      if (!rooms.length) return { rooms: [], props: [] };

      const roomEls = [];
      const propEls = [];

      for (const r of rooms) {
        const isCircle = r.w >= 5 && r.h >= 5 && rng.next() < CIRCLE_RATE;
        r.circle = isCircle;                 // tracked so doors skip circular rooms
        roomEls.push(makeRoom(r.x * cs, r.y * cs, r.w * cs, r.h * cs, isCircle));
      }

      const allRoomCells = new Set();          // cells of every rectangular room
      for (const r of rooms) {
        if (r.circle) continue;
        for (let gx = r.x; gx < r.x + r.w; gx++)
          for (let gy = r.y; gy < r.y + r.h; gy++)
            allRoomCells.add(gx + ',' + gy);
      }
      const doors = [];
      const doorSeen = new Set();
      for (let i = 0; i < rooms.length - 1; i++) {
        const rects = corridorRects(rooms[i], rooms[i + 1], cs);
        for (const rect of rects) roomEls.push(makeRoom(rect.x, rect.y, rect.w, rect.h));
        addPairDoors(rects, rooms[i], rooms[i + 1], cs, doors, doorSeen, allRoomCells);
      }
      for (const door of pruneInteriorDoors(doors, rooms, cs)) propEls.push(door);

      let exitRoom = null, stairsInfo = null;
      if (addStairs) {
        const mapCX = (st.mapW || DM.Config.MAP_W) / 2;
        const mapCY = (st.mapH || DM.Config.MAP_H) / 2;
        exitRoom = rooms.reduce((best, r) => {
          const d  = Math.hypot((r.x + r.w / 2) * cs - mapCX, (r.y + r.h / 2) * cs - mapCY);
          const bd = Math.hypot((best.x + best.w / 2) * cs - mapCX, (best.y + best.h / 2) * cs - mapCY);
          return d > bd ? r : best;
        }, rooms[0]);
        stairsInfo = makeStairs(exitRoom, cs);
        roomEls.push(stairsInfo.el);
      }

      if (addPillars) {
        const largeRooms = rooms.filter(r => r.w >= 6 && r.h >= 5);
        const pillarSet  = new Set(
          shuffle(largeRooms, rng).filter((_, i) => i % PILLAR_STEP === 0)
        );
        for (const r of rooms) {
          if (!pillarSet.has(r)) continue;
          const occ = makeOcc();
          if (stairsInfo && r === exitRoom) {
            occ.fillRect(stairsInfo.gx0, stairsInfo.gy0, stairsInfo.gx1, stairsInfo.gy1);
          }
          propEls.push(...placePillars(r, occ, cs));
        }
      }

      return { rooms: roomEls, props: propEls };
    },
  };

})();

'use strict';
window.DM = window.DM || {};

DM.IO = (() => {
  const _imgCache = {};
  const _imgInflight = {};

  const _SESSION_KEY = 'dmf_session';
  const _CLOUD_KEY   = 'dmf_cloud';
  let _saveTimer  = null;
  let _savePaused = false;

  const _delay = ms => new Promise(r => setTimeout(r, ms));

  function _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function _cacheOne(asset) {
    if (DM.isVideoAsset(asset)) { _setupVideo(asset); return; }

    const key = asset.id;

    if (!_imgCache[key] && asset.src) {
      if (!_imgInflight[key]) {
        _imgInflight[key] = _loadImage(asset.src)
          .then(img  => { _imgCache[key] = img; return img; })
          .catch(() => { console.warn('[IO] Asset load failed:', asset.name); return null; })
          .finally(() => { delete _imgInflight[key]; });
      }
      await _imgInflight[key];
    }

    asset._img = _imgCache[key] || null;
    _checkGifAnim(asset);
  }

  function _cacheAssets(assets) {
    return Promise.all(assets.map(a => _cacheOne(a)));
  }

  const _animAssets = new Set();
  let   _gifTicker  = null;

  function _startGifTicker() {
    if (_gifTicker) return;
    function tick(now) {
      if (_animAssets.size === 0) { _gifTicker = null; return; }
      const used = _usedAssetIdSet();
      let anyUsed = false, dirty = false;
      for (const a of _animAssets) {
        if (!used.has(a.id)) continue;
        anyUsed = true;
        if (now >= a._gifNext) {
          a._gifIdx  = (a._gifIdx + 1) % a._gifFrames.length;
          a._gifNext = now + a._gifFrames[a._gifIdx].delay;
          dirty = true;
        }
      }
      if (!anyUsed) { _gifTicker = null; return; }   // nothing placed → stop the loop
      if (dirty) DM.Renderer?.render?.();
      _gifTicker = requestAnimationFrame(tick);
    }
    _gifTicker = requestAnimationFrame(tick);
  }

  async function _setupAnimGif(asset) {
    if (asset._gifFrames) return; // idempotent
    try {
      let buffer;
      if (asset.src.startsWith('data:')) {
        const b64 = asset.src.split(',')[1];
        const bin = atob(b64);
        const u8  = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buffer = u8.buffer;
      } else {
        const res = await fetch(asset.src, { credentials: 'same-origin' });
        if (!res.ok) return;
        buffer = await res.arrayBuffer();
      }

      const gif = await DM.GIFDecoder.decode(buffer);
      if (!gif || gif.frames.length < 2) return;

      const frames = await Promise.all(gif.frames.map(async f => ({
        bitmap: await createImageBitmap(f.imageData),
        delay:  Math.max(f.delay, 20),
      })));

      asset._isAnimated = true;
      asset._gifFrames  = frames;
      asset._gifIdx     = 0;
      asset._gifNext    = performance.now() + frames[0].delay;

      _animAssets.add(asset);
      _startGifTicker();
      DM.Renderer?.render?.();
    } catch {
    }
  }

  async function _setupAnimWebP(asset) {
    if (asset._gifFrames) return;               // idempotent
    if (typeof ImageDecoder === 'undefined') return; // unsupported browser → static
    try {
      let buffer;
      if (asset.src.startsWith('data:')) {
        const b64 = asset.src.split(',')[1];
        const bin = atob(b64);
        const u8  = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        buffer = u8.buffer;
      } else {
        const res = await fetch(asset.src, { credentials: 'same-origin' });
        if (!res.ok) return;
        buffer = await res.arrayBuffer();
      }

      const decoder = new ImageDecoder({ data: buffer, type: 'image/webp' });
      await decoder.tracks.ready;
      const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1;
      if (frameCount < 2) { decoder.close?.(); return; } // static WebP — nothing to animate

      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        const delay  = Math.max((image.duration || 100000) / 1000, 20); // µs → ms
        const bitmap = await createImageBitmap(image);
        image.close();
        frames.push({ bitmap, delay });
      }
      decoder.close?.();

      asset._isAnimated = true;
      asset._gifFrames  = frames;
      asset._gifIdx     = 0;
      asset._gifNext    = performance.now() + frames[0].delay;

      _animAssets.add(asset);
      _startGifTicker();
      DM.Renderer?.render?.();
    } catch {
    }
  }

  function _checkGifAnim(asset) {
    if (!asset._img || asset._gifChecked) return;
    asset._gifChecked = true;
    const src = asset.src || '';
    if (/\.gif($|\?)/i.test(src) || src.startsWith('data:image/gif')) {
      _setupAnimGif(asset);  // fire-and-forget
    } else if (/\.webp($|\?)/i.test(src) || src.startsWith('data:image/webp')) {
      _setupAnimWebP(asset); // fire-and-forget
    }
  }

  const _videoAssets    = new Set();
  let   _videoTicker    = null;
  let   _videoLastRender = 0;
  let   _videoHolder    = null;

  function _getVideoHolder() {
    if (_videoHolder) return _videoHolder;
    _videoHolder = document.createElement('div');
    _videoHolder.style.cssText =
      'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0';
    document.body.appendChild(_videoHolder);
    return _videoHolder;
  }

  function _setupVideo(asset) {
    if (asset._video) return; // idempotent
    const v = document.createElement('video');
    v.src         = asset.src;
    v.muted       = true;
    v.loop        = true;
    v.autoplay    = true;
    v.playsInline = true;
    v.preload     = 'auto';
    v.setAttribute('muted', '');       // attribute form required by some engines
    v.setAttribute('playsinline', '');
    _getVideoHolder().appendChild(v);
    asset._video      = v;
    asset._isAnimated = true;
    _videoAssets.add(asset);

    const kick = () => { v.play().catch(() => {}); DM.Renderer?.render?.(); };
    if (v.readyState >= 2) kick();
    else v.addEventListener('loadeddata', kick, { once: true });

    _startVideoTicker();
  }

  function _usedAssetIdSet() {
    const ids = new Set();
    if (DM.State.current.bgImageId != null) ids.add(DM.State.current.bgImageId);
    for (const layer of DM.State.current.layers) {
      if (layer.visible === false) continue;
      for (const el of layer.elements) {
        if (el.assetId     != null) ids.add(el.assetId);
        if (el.fillAssetId != null) ids.add(el.fillAssetId);
      }
    }
    return ids;
  }

  function _startVideoTicker() {
    if (_videoTicker) return;
    function tick(now) {
      if (_videoAssets.size === 0) { _videoTicker = null; return; }
      if (now - _videoLastRender < 33) {           // ~30fps cap for scan + render
        _videoTicker = requestAnimationFrame(tick);
        return;
      }
      _videoLastRender = now;

      const used = _usedAssetIdSet();
      let anyPlaying = false;
      for (const a of _videoAssets) {
        const v = a._video;
        if (!v) continue;
        if (used.has(a.id)) {
          if (v.paused) v.play().catch(() => {});
          anyPlaying = true;
        } else if (!v.paused) {
          v.pause();
        }
      }
      if (!anyPlaying) { _videoTicker = null; return; }
      DM.Renderer?.render?.();
      _videoTicker = requestAnimationFrame(tick);
    }
    _videoTicker = requestAnimationFrame(tick);
  }

  function _resumeAnim() {
    if (_animAssets.size)  _startGifTicker();
    if (_videoAssets.size) _startVideoTicker();
  }

  function _csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  }

  function _forceCompositorFlush() {
    const canvas = DM.Renderer.canvas;
    if (!canvas) return;
    canvas.style.opacity = '0.9999';
    setTimeout(() => { canvas.style.opacity = ''; }, 0);
  }

  async function fetchServerAssets() {
    const url = (window.TMB_BASE || '') + '/api/assets.php';
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res  = await fetch(url, { credentials: 'same-origin' });
        const text = await res.text();

        let data;
        try { data = JSON.parse(text); }
        catch { console.error('[IO] assets.php non-JSON:', text.slice(0, 500)); return null; }

        if (!res.ok) {
          console.error('[IO] assets.php error:', res.status, data?.error);
          if (res.status >= 500 && attempt < MAX_ATTEMPTS) { await _delay(attempt * 400); continue; }
          return null;
        }

        return data.success ? data : null;
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) { await _delay(attempt * 400); continue; }
        console.error(`[IO] assets.php fetch failed after ${MAX_ATTEMPTS} attempts:`, e);
        return null;
      }
    }
    return null;
  }

  async function uploadToServer(file, categoryId = null) {
    const fd = new FormData();
    fd.append('file', file);
    if (categoryId != null) fd.append('category_id', String(categoryId));

    try {
      const res = await fetch((window.TMB_BASE || '') + '/api/assets.php', {
        method:      'POST',
        credentials: 'same-origin',
        headers:     { 'X-CSRF-Token': _csrfToken() },
        body:        fd,
      });
      const data = await res.json();
      return data.success
        ? { asset: data.asset }
        : { error: data.error || 'Upload refused by the server.' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  }

  async function deleteFromServer(id) {
    try {
      const res = await fetch((window.TMB_BASE || '') + '/api/assets.php?id=' + encodeURIComponent(id), {
        method:      'DELETE',
        credentials: 'same-origin',
        headers:     { 'X-CSRF-Token': _csrfToken() },
      });
      const data = await res.json();
      return data.success === true;
    } catch {
      return false;
    }
  }

  function _doSave() {
    const json = DM.State.serialize();
    try {
      localStorage.setItem(_SESSION_KEY, json);
    } catch (_quotaErr) {
      try {
        const data  = JSON.parse(json);
        data.assets = data.assets.map(a => ({
          id:         a.id,
          name:       a.name,
          src:        typeof a.id === 'string' ? a.src : '',
          categoryId: a.categoryId ?? null,
          isSystem:   a.isSystem ?? 0,
        }));
        localStorage.setItem(_SESSION_KEY, JSON.stringify(data));
      } catch (e) {
        console.warn('[DM.IO] Auto-save failed completely:', e);
      }
    }

    const st = DM.State.current;
    if (st._cloudMapId || st._cloudMapName) {
      try {
        localStorage.setItem(_CLOUD_KEY, JSON.stringify({
          id:   st._cloudMapId   ?? null,
          name: st._cloudMapName ?? null,
        }));
      } catch {}
    }
  }

  const _WEBM = {
    EBML:          [0x1a, 0x45, 0xdf, 0xa3],
    SEGMENT:       [0x18, 0x53, 0x80, 0x67],
    INFO:          [0x15, 0x49, 0xa9, 0x66],
    DURATION:      [0x44, 0x89],
    TIMECODESCALE: [0x2a, 0xd7, 0xb1],
  };

  function _matchSig(buf, pos, sig) {
    if (pos + sig.length > buf.length) return false;
    for (let i = 0; i < sig.length; i++) if (buf[pos + i] !== sig[i]) return false;
    return true;
  }

  function _vintLen(firstByte) {
    let mask = 0x80, len = 1;
    while (len <= 8 && !(firstByte & mask)) { mask >>= 1; len++; }
    return len > 8 ? 0 : len;
  }

  function _readSize(buf, pos) {
    const len = _vintLen(buf[pos]);
    if (!len || pos + len > buf.length) return null;
    let value = buf[pos] & ((1 << (8 - len)) - 1);
    let allOnes = value === ((1 << (8 - len)) - 1);
    for (let i = 1; i < len; i++) {
      value = value * 256 + buf[pos + i];
      if (buf[pos + i] !== 0xff) allOnes = false;
    }
    return { len, value, unknown: allOnes };
  }

  function _writeSize8(value) {
    const out = new Uint8Array(8);
    out[0] = 0x01;
    let v = value;
    for (let i = 7; i >= 1; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
    return out;
  }

  function _fixWebmDuration(blob, durationMs) {
    return new Promise(resolve => {
      const done = out => resolve(out || blob);
      const fr = new FileReader();
      fr.onerror = () => done(null);
      fr.onload = () => {
        try {
          const buf = new Uint8Array(fr.result);

          if (!_matchSig(buf, 0, _WEBM.EBML)) return done(null);
          let pos = _WEBM.EBML.length;
          let sz = _readSize(buf, pos);
          if (!sz) return done(null);
          const headerEnd = pos + sz.len + sz.value;

          pos = headerEnd;
          if (!_matchSig(buf, pos, _WEBM.SEGMENT)) return done(null);
          pos += _WEBM.SEGMENT.length;
          const segSize = _readSize(buf, pos);
          if (!segSize) return done(null);
          const segContentStart = pos + segSize.len;

          let p = segContentStart, infoStart = -1, infoContentStart = -1, infoSize = 0;
          while (p < buf.length) {
            const idLen = _vintLen(buf[p]);
            if (!idLen) return done(null);
            const isInfo = _matchSig(buf, p, _WEBM.INFO);
            const childSize = _readSize(buf, p + idLen);
            if (!childSize || childSize.unknown) {
              if (isInfo) break;
              return done(null);
            }
            if (isInfo) {
              infoStart        = p;
              infoContentStart = p + idLen + childSize.len;
              infoSize         = childSize.value;
              break;
            }
            p += idLen + childSize.len + childSize.value;
          }
          if (infoStart < 0) return done(null);
          const infoEnd = infoContentStart + infoSize;
          if (infoEnd > buf.length) return done(null);

          let timecodeScale = 1000000;
          let durIdx = -1, durValLen = 0;   // absolute offset of Duration value + its byte length
          let ip = infoContentStart;
          while (ip < infoEnd) {
            const idLen = _vintLen(buf[ip]);
            if (!idLen) break;
            const isDur = _matchSig(buf, ip, _WEBM.DURATION);
            const isTcs = _matchSig(buf, ip, _WEBM.TIMECODESCALE);
            const s = _readSize(buf, ip + idLen);
            if (!s) break;
            const valAt = ip + idLen + s.len;
            if (isDur)      { durIdx = valAt; durValLen = s.value; }
            else if (isTcs) {
              let t = 0;
              for (let i = 0; i < s.value; i++) t = t * 256 + buf[valAt + i];
              if (t > 0) timecodeScale = t;
            }
            ip = valAt + s.value;
          }
          const durationTicks = durationMs * 1e6 / timecodeScale;
          if (!isFinite(durationTicks) || durationTicks <= 0) return done(null);

          if (durIdx >= 0 && (durValLen === 4 || durValLen === 8)) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            if (durValLen === 4) dv.setFloat32(durIdx, durationTicks, false);
            else                 dv.setFloat64(durIdx, durationTicks, false);
          }

          let newInfo;
          if (durIdx >= 0) {
            newInfo = buf.subarray(infoStart, infoEnd);   // already patched in place
          } else {
            const durEl = new Uint8Array(2 + 1 + 8);
            durEl[0] = 0x44; durEl[1] = 0x89; durEl[2] = 0x88; // size = 8
            new DataView(durEl.buffer).setFloat64(3, durationTicks, false);
            const content = buf.subarray(infoContentStart, infoEnd);
            const newContentLen = content.length + durEl.length;
            const sizeVint = _writeSize8(newContentLen);
            newInfo = new Uint8Array(_WEBM.INFO.length + sizeVint.length + newContentLen);
            let o = 0;
            newInfo.set(_WEBM.INFO, o);              o += _WEBM.INFO.length;
            newInfo.set(sizeVint, o);                o += sizeVint.length;
            newInfo.set(content, o);                 o += content.length;
            newInfo.set(durEl, o);
          }

          const before   = buf.subarray(segContentStart, infoStart);
          const after     = buf.subarray(infoEnd, buf.length);
          const segLen   = before.length + newInfo.length + after.length;
          const segVint  = _writeSize8(segLen);

          const outLen = headerEnd + _WEBM.SEGMENT.length + segVint.length + segLen;
          const out = new Uint8Array(outLen);
          let w = 0;
          out.set(buf.subarray(0, headerEnd), w); w += headerEnd;
          out.set(_WEBM.SEGMENT, w);              w += _WEBM.SEGMENT.length;
          out.set(segVint, w);                    w += segVint.length;
          out.set(before, w);                     w += before.length;
          out.set(newInfo, w);                    w += newInfo.length;
          out.set(after, w);

          done(new Blob([out], { type: blob.type || 'video/webm' }));
        } catch (_) {
          done(null);
        }
      };
      fr.readAsArrayBuffer(blob);
    });
  }

  return {

    _resumeAnim,

    _renderClean(mimeType, quality, scale = 1) {
      const prevTool = DM.State.current.tool;
      const prevSel  = DM.State.current.selectedIdx;
      DM.State.current.tool        = '__export__';
      DM.State.current.selectedIdx = -1;

      let src;
      if (scale > 1) {
        src = DM.Renderer.renderHD(scale);
      } else {
        DM.Renderer.render();
        src = DM.Renderer.canvas;
      }

      let dataUrl;

      if (mimeType === 'image/jpeg') {
        const flat  = document.createElement('canvas');
        flat.width  = src.width;
        flat.height = src.height;
        const fctx  = flat.getContext('2d');
        fctx.fillStyle = '#ffffff';
        fctx.fillRect(0, 0, flat.width, flat.height);
        fctx.drawImage(src, 0, 0);
        dataUrl = flat.toDataURL('image/jpeg', quality);
      } else {
        dataUrl = src.toDataURL('image/png');
      }

      DM.State.current.tool        = prevTool;
      DM.State.current.selectedIdx = prevSel;
      DM.Renderer.render();
      return dataUrl;
    },

    exportPNG(scale = 1) {
      const link    = document.createElement('a');
      link.download = scale > 1 ? 'dungeon-map-hd.png' : 'dungeon-map.png';
      link.href     = this._renderClean('image/png', undefined, scale);
      link.click();
    },

    exportJPG(quality = 0.95, scale = 1) {
      const link    = document.createElement('a');
      link.download = scale > 1 ? 'dungeon-map-hd.jpg' : 'dungeon-map.jpg';
      link.href     = this._renderClean('image/jpeg', quality, scale);
      link.click();
    },

    saveMap() {
      const json = DM.State.serialize();
      const blob = new Blob([json], { type: 'application/json' });
      const link = document.createElement('a');
      link.download = 'dungeon-map.dungeon';
      link.href     = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    },

    async loadMap(file) {
      _savePaused = true;
      DM.UI?.showLoader('Loading map…');
      try {
        const text = await file.text();
        DM.State.deserialize(text);
        await _cacheAssets(DM.State.current.assets);
      } catch (err) {
        alert('Could not load map: ' + err.message);
        return;
      } finally {
        DM.UI?.hideLoader();
        _savePaused = false;
      }

      DM.Renderer.resizeCanvas();
      DM.Renderer.render();
      DM.Renderer.startDecalAnim?.();
      DM.UI?.syncBgPicker?.();
      DM.UI?.syncGridControls?.();
      _forceCompositorFlush();
      this.autoSave();
    },

    async uploadImages(files, categoryId = null) {
      const newAssets = [];
      const videoSkipped = [];
      const rejected = [];
      const isAuth = DM.Auth.state.isLoggedIn;

      for (const file of files) {
        let asset = null;

        if (isAuth) {
          const { asset: serverAsset, error } = await uploadToServer(file, categoryId);
          if (serverAsset) {
            asset = {
              id:         serverAsset.id,
              name:       serverAsset.original_name,
              src:        serverAsset.url,
              categoryId: serverAsset.category_id ?? null,
              isSystem:   0,
            };
          } else {
            rejected.push(`${file.name} — ${error}`);
            continue;
          }
        }

        if (!asset && /^video\//i.test(file.type)) {
          videoSkipped.push(file.name);
          continue;
        }

        if (!asset) {
          const src = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          asset = {
            id:         `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            name:       file.name,
            src,
            categoryId: null,
            isSystem:   0,
          };
        }

        await _cacheOne(asset);
        DM.State.addAsset(asset);
        newAssets.push(asset);
      }

      if (rejected.length) {
        DM.toast?.(
          rejected.length === 1
            ? `Could not upload ${rejected[0]}`
            : `${rejected.length} files could not be uploaded — max 500 KB each.`,
          true
        );
      } else if (videoSkipped.length) {
        DM.toast?.(
          `Could not add ${videoSkipped.join(', ')} — videos require an account.`,
          true
        );
      }
      if (newAssets.length) DM.track?.('upload_asset', { count: newAssets.length });
      return newAssets;
    },

    async loadServerAssets() {
      const data = await fetchServerAssets();
      if (!data) return null;

      const {
        my_assets = [], system_assets = [],
        system_categories = [], my_categories = [],
        user_tier = 0,
      } = data;

      const stateMap = new Map(DM.State.current.assets.map(a => [String(a.id), a]));

      for (const a of [...my_assets, ...system_assets]) {
        const key   = String(a.id);
        const inState = stateMap.get(key);
        if (inState) {
          if (!inState.src) inState.src = a.url;
          inState.categoryId = a.category_id ?? null;
          inState.isSystem   = +a.is_system;
          continue;
        }
        const asset = {
          id:         a.id,
          name:       a.original_name,
          src:        a.url,
          categoryId: a.category_id ?? null,
          isSystem:   +a.is_system,
        };
        DM.State.addAsset(asset);
        stateMap.set(key, asset);
      }

      await _cacheAssets(DM.State.current.assets.filter(a => typeof a.id === 'number'));

      return { systemCategories: system_categories, myCategories: my_categories, userTier: user_tier };
    },

    async deleteAsset(id) {
      const asset = DM.State.getAsset(id);
      if (asset) {
        if (asset._gifFrames) {
          asset._gifFrames.forEach(f => f.bitmap.close?.());
          _animAssets.delete(asset);
        }
        if (asset._video) {
          asset._video.pause();
          asset._video.removeAttribute('src');
          asset._video.load();
          asset._video.remove();
          asset._video = null;
          _videoAssets.delete(asset);
        }
        delete _imgCache[id];
      }
      const isServerAsset = typeof id === 'number';
      if (isServerAsset) await deleteFromServer(id);
      DM.State.removeAsset(id);
    },

    warmCache() {
      return _cacheAssets(DM.State.current.assets);
    },

    autoSave() {
      if (_savePaused) return;
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(_doSave, 1500);
    },

    saveNow() {
      if (_savePaused) return;
      clearTimeout(_saveTimer);
      _doSave();
    },

    async restoreSession() {
      let saved;
      try { saved = localStorage.getItem(_SESSION_KEY); } catch { return false; }
      if (!saved) return false;

      _savePaused = true;
      try {
        DM.State.deserialize(saved);
        await _cacheAssets(DM.State.current.assets);

        try {
          const meta = localStorage.getItem(_CLOUD_KEY);
          if (meta) {
            const { id, name } = JSON.parse(meta);
            if (id)   DM.State.current._cloudMapId   = id;
            if (name) DM.State.current._cloudMapName = name;
          }
        } catch {}

        return true;
      } catch (e) {
        console.warn('[DM.IO] Session restore failed, clearing:', e);
        try { localStorage.removeItem(_SESSION_KEY); } catch {}
        return false;
      } finally {
        _savePaused = false;
      }
    },

    clearSession() {
      try { localStorage.removeItem(_SESSION_KEY); } catch {}
      try { localStorage.removeItem(_CLOUD_KEY);   } catch {}
    },

    async recordWebM(durationMs, onTick, opts = {}) {
      const st = DM.State.current;
      const W  = st.mapW;
      const H  = st.mapH;

      const recCanvas = document.createElement('canvas');
      recCanvas.width  = W;
      recCanvas.height = H;

      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
          ? 'video/webm;codecs=vp8'
          : 'video/webm';

      const stream   = recCanvas.captureStream(0);
      const track    = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, {
        mimeType:           mime,
        videoBitsPerSecond: opts.bitrate || 25_000_000,
      });
      const chunks = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

      const FPS = 30;
      const renderFrame = () => {
        DM.animClock = performance.now() / 1000;
        st._playerRender = true;
        DM.Renderer.renderHD(1, recCanvas);
        delete st._playerRender;
        if (track && track.requestFrame) track.requestFrame();
        else if (stream.requestFrame)    stream.requestFrame();
      };

      return new Promise((resolve, reject) => {
        let frameId = null;
        recorder.onerror = e => reject(e?.error || new Error('Recording failed.'));
        recorder.onstop  = async () => {
          clearInterval(frameId);
          stream.getTracks().forEach(t => t.stop());
          let blob = new Blob(chunks, { type: 'video/webm' });
          if (blob.size === 0) {
            reject(new Error('No frames were captured. Keep this tab in the foreground while recording.'));
            return;
          }
          opts.onPhase?.('finalizing');
          try { blob = await _fixWebmDuration(blob, durationMs); } catch (_) {}
          if (opts.download !== false) {
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.download = 'dungeon-map-animated.webm';
            a.href = url; a.click();
            URL.revokeObjectURL(url);
          }
          resolve(blob);
        };

        recorder.start();      // single blob; requestData() before stop flushes it
        renderFrame();         // paint & push the first frame immediately
        frameId = setInterval(renderFrame, 1000 / FPS);

        const start  = performance.now();
        const tickId = setInterval(() => onTick?.(performance.now() - start), 200);
        setTimeout(() => {
          clearInterval(tickId);
          clearInterval(frameId);
          renderFrame();                              // guarantee a trailing frame
          try { recorder.requestData(); } catch (_) {} // flush the encoder buffer
          recorder.stop();
        }, durationMs);
      });
    },

  };
})();

'use strict';
window.DM = window.DM || {};

DM.Roll20 = (() => {

  function _suppressDoorWalls(hSegs, vSegs, doorEls, cs) {
    const TOL = cs * 0.4; // tolerance for wall-center alignment
    const EPS = 0.5;       // px epsilon for degenerate segment pruning

    function subtract(lo, hi, cuts) {
      let segs = [{ lo, hi }];
      for (const { lo: dlo, hi: dhi } of cuts) {
        const next = [];
        for (const s of segs) {
          if (dhi <= s.lo + EPS || dlo >= s.hi - EPS) { next.push(s); continue; }
          if (s.lo < dlo - EPS) next.push({ lo: s.lo, hi: dlo });
          if (s.hi > dhi + EPS) next.push({ lo: dhi, hi: s.hi });
        }
        segs = next;
      }
      return segs;
    }

    const newHSegs = [];
    for (const seg of hSegs) {
      const { x1, x2, y, hd } = seg;
      const cuts = [];
      for (const el of doorEls) {
        const r = el.rotation || 0;
        if (Math.abs(Math.sin(r)) > 0.3) continue;      // not horizontal
        if (Math.abs(el.y - y) > TOL) continue;          // not on this wall line
        const hw = (el.w || cs) / 2;
        cuts.push({ lo: el.x - hw, hi: el.x + hw });
      }
      if (!cuts.length) { newHSegs.push(seg); continue; }
      for (const { lo, hi } of subtract(x1, x2, cuts)) {
        if (hi - lo > EPS) newHSegs.push({ x1: lo, x2: hi, y, hd });
      }
    }

    const newVSegs = [];
    for (const seg of vSegs) {
      const { y1, y2, x, hd } = seg;
      const cuts = [];
      for (const el of doorEls) {
        const r = el.rotation || 0;
        if (Math.abs(Math.cos(r)) > 0.3) continue;      // not vertical
        if (Math.abs(el.x - x) > TOL) continue;          // not on this wall line
        const hw = (el.w || cs) / 2;
        cuts.push({ lo: el.y - hw, hi: el.y + hw });
      }
      if (!cuts.length) { newVSegs.push(seg); continue; }
      for (const { lo, hi } of subtract(y1, y2, cuts)) {
        if (hi - lo > EPS) newVSegs.push({ y1: lo, y2: hi, x, hd });
      }
    }

    return { hSegs: newHSegs, vSegs: newVSegs };
  }

  function _buildLOS(cells, doorEls) {
    const cs = DM.State.current.cellSize;
    const walls = DM.buildWalls(cells);
    const { hSegs, vSegs } = _suppressDoorWalls(walls.hSegs, walls.vSegs, doorEls, cs);
    const los = [];
    for (const { x1, x2, y } of hSegs) los.push([{ x: x1 / cs, y: y / cs }, { x: x2 / cs, y: y / cs }]);
    for (const { y1, y2, x } of vSegs) los.push([{ x: x / cs, y: y1 / cs }, { x: x / cs, y: y2 / cs }]);
    return los;
  }

  function _buildPortals(elems) {
    const cs = DM.State.current.cellSize;
    const portals = [];
    for (const el of elems) {
      if (el.type !== 'door') continue;
      const cx = el.x / cs;
      const cy = el.y / cs;
      const r  = el.rotation || 0;
      const halfLen = (el.w || cs) / (2 * cs);
      const dx = halfLen * Math.cos(r);
      const dy = halfLen * Math.sin(r);
      portals.push({
        position: { x: cx, y: cy },
        bounds: [{ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy }],
        rotation: r,
        closed: true,
        freestanding: false,
      });
    }
    return portals;
  }

  function _rotateGpt(gx, gy, cx, cy, rot) {
    if (!rot) return { x: gx, y: gy };
    const dx = gx - cx, dy = gy - cy;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }

  function _traceOccupied(cells) {
    const outEdges = {};
    const addEdge  = (fx, fy, tx, ty) => {
      const k = `${fx},${fy}`;
      (outEdges[k] || (outEdges[k] = [])).push([tx, ty]);
    };
    for (const key of cells) {
      const [gx, gy] = key.split(',').map(Number);
      if (!cells.has(`${gx},${gy-1}`)) addEdge(gx,   gy,   gx+1, gy  );
      if (!cells.has(`${gx+1},${gy}`)) addEdge(gx+1, gy,   gx+1, gy+1);
      if (!cells.has(`${gx},${gy+1}`)) addEdge(gx+1, gy+1, gx,   gy+1);
      if (!cells.has(`${gx-1},${gy}`)) addEdge(gx,   gy+1, gx,   gy  );
    }

    const usedEdges = new Set();
    const segs      = [];
    for (const startKey of Object.keys(outEdges)) {
      for (const [snx, sny] of outEdges[startKey]) {
        const firstEdge = `${startKey}>${snx},${sny}`;
        if (usedEdges.has(firstEdge)) continue;

        const loop = [];
        let [cx, cy] = startKey.split(',').map(Number);
        let [nx, ny] = [snx, sny];

        for (let guard = 0; guard < 40000; guard++) {
          usedEdges.add(`${cx},${cy}>${nx},${ny}`);
          loop.push([cx, cy]);

          const nxtKey = `${nx},${ny}`;
          if (nxtKey === startKey) break;

          const [prevCx, prevCy] = [cx, cy];
          [cx, cy] = [nx, ny];

          const candidates = (outEdges[nxtKey] || []).filter(
            ([tx, ty]) => !usedEdges.has(`${nxtKey}>${tx},${ty}`)
          );
          if (!candidates.length) break;

          if (candidates.length === 1) {
            [nx, ny] = candidates[0];
          } else {
            const [idx, idy] = [cx - prevCx, cy - prevCy];
            let bestCross = -Infinity, bestCand = candidates[0];
            for (const cand of candidates) {
              const cross = idx * (cand[1] - cy) - idy * (cand[0] - cx);
              if (cross > bestCross) { bestCross = cross; bestCand = cand; }
            }
            [nx, ny] = bestCand;
          }
        }

        if (loop.length >= 3) {
          const n = loop.length;
          for (let i = 0; i < n; i++) {
            segs.push([loop[i], loop[(i + 1) % n]]);
          }
        }
      }
    }
    return segs;
  }

  function _sampleAlpha(img, gridW, gridH) {
    try {
      const oc   = new OffscreenCanvas(gridW, gridH);
      const octx = oc.getContext('2d');
      octx.drawImage(img, 0, 0, gridW, gridH);
      const data  = octx.getImageData(0, 0, gridW, gridH).data;
      const cells = new Set();
      for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
          if (data[(gy * gridW + gx) * 4 + 3] > 32) cells.add(`${gx},${gy}`);
        }
      }
      return cells;
    } catch {
      const cells = new Set();
      for (let gy = 0; gy < gridH; gy++)
        for (let gx = 0; gx < gridW; gx++)
          cells.add(`${gx},${gy}`);
      return cells;
    }
  }

  function _buildObjectsLOS(elems) {
    const cs   = DM.State.current.cellSize;
    const segs = [];

    for (const el of elems) {
      if (!el.physical || el.light) continue;

      const { x, y, w, h } = DM.elementRect(el);
      const rot = el.rotation || 0;

      if (el.type === 'image') {
        const asset = DM.State.getAsset(el.assetId);
        if (!asset?._img) continue;

        const gridW = Math.max(1, Math.round(w / cs));
        const gridH = Math.max(1, Math.round(h / cs));
        const ox  = x / cs;
        const oy  = y / cs;
        const cx  = ox + gridW / 2;
        const cy  = oy + gridH / 2;

        const cells    = _sampleAlpha(asset._img, gridW, gridH);
        const rawSegs  = _traceOccupied(cells);

        for (const [[ax, ay], [bx, by]] of rawSegs) {
          segs.push([
            _rotateGpt(ox + ax, oy + ay, cx, cy, rot),
            _rotateGpt(ox + bx, oy + by, cx, cy, rot),
          ]);
        }
      } else {
        const gx0 = x / cs, gy0 = y / cs;
        const gx1 = (x + w) / cs, gy1 = (y + h) / cs;
        segs.push([{ x: gx0, y: gy0 }, { x: gx1, y: gy0 }]);
        segs.push([{ x: gx1, y: gy0 }, { x: gx1, y: gy1 }]);
        segs.push([{ x: gx1, y: gy1 }, { x: gx0, y: gy1 }]);
        segs.push([{ x: gx0, y: gy1 }, { x: gx0, y: gy0 }]);
      }
    }
    return segs;
  }

  function _buildLights(elems) {
    const cs = DM.State.current.cellSize;
    const lights = [];
    for (const el of elems) {
      if (!el.light) continue;
      const { x, y } = DM.elementCenter(el);
      lights.push({
        position:  { x: x / cs, y: y / cs },
        range:     el.light.radius,
        intensity: el.light.opacity ?? 0.8,
        color:     el.light.color || '#ffaa44',
        shadows:   true,
      });
    }
    return lights;
  }

  function _buildNotes(elems) {
    const cs    = DM.State.current.cellSize;
    const notes = [];
    for (const el of elems) {
      if (el.type !== 'text' || !el.gmOnly) continue;
      notes.push({
        position:  { x: el.x / cs, y: el.y / cs },
        label:     el.text || '',
        icon_path: 'icons/svg/anchor.svg',
      });
    }
    return notes;
  }

  function _download(href, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href     = href;
    a.click();
  }

  return {
    exportUVTT(scale = 2) {
      const st       = DM.State.current;
      const cs       = st.cellSize;
      const allElems = DM.State.visibleElements();

      st._playerRender = true;
      const dataUrl    = DM.IO._renderClean('image/png', undefined, scale);
      delete st._playerRender;

      const image                 = dataUrl.split(',')[1]; // raw base64, no data URL prefix
      const cells                 = DM.buildCellGrid(allElems);
      const doorEls               = allElems.filter(el => el.type === 'door');
      const line_of_sight         = _buildLOS(cells, doorEls);
      const portals               = _buildPortals(allElems);
      const objects_line_of_sight = _buildObjectsLOS(allElems);
      const lights                = _buildLights(allElems);
      const notes                 = _buildNotes(allElems);

      const uvtt = {
        format: 0.3,
        resolution: {
          map_origin:      { x: 0, y: 0 },
          map_size:        { x: Math.round(st.mapW / cs), y: Math.round(st.mapH / cs) },
          pixels_per_grid: cs * scale,
        },
        line_of_sight,
        objects_line_of_sight,
        portals,
        environment: { baked_lighting: false, ambient_light: null },
        lights,
        image,
        ...(notes.length && { notes }),
      };

      const blob = new Blob([JSON.stringify(uvtt)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      _download(url, 'dungeon-map.dd2vtt');
      URL.revokeObjectURL(url);
    },
  };
})();

'use strict';
window.DM = window.DM || {};

DM.UI = (() => {
  function buildToolGroups() {
    const container     = document.getElementById('tool-groups');
    const elemContainer = document.getElementById('element-groups');

    const panels = {};
    for (const pid of ['room-details', 'brush-details', 'fill-details', 'door-details', 'fog-details']) {
      const el = document.getElementById(pid);
      if (el) { el.remove(); panels[pid] = el; }
    }

    container.innerHTML = '';
    if (elemContainer) elemContainer.innerHTML = '';

    for (const group of DM.Config.TOOL_GROUPS) {
      const wrap = document.createElement('div');
      wrap.className = 'tool-group-btns';

      for (const tool of group.tools) {
        const btn = document.createElement('button');
        btn.className    = 'tool-btn';
        btn.dataset.tool = tool.id;
        btn.innerHTML    = `<span class="ti">${tool.icon}</span>${tool.label}`;
        btn.addEventListener('click', () => selectTool(tool.id));
        wrap.appendChild(btn);

        const panel = panels[`${tool.id}-details`];
        if (panel) wrap.appendChild(panel);
      }

      if (group.id === 'elements' && elemContainer) {
        elemContainer.appendChild(wrap);
      } else if (group.flat) {
        container.appendChild(wrap);
      } else {
        const details = document.createElement('details');
        details.className = 'tool-group-details';

        const summary = document.createElement('summary');
        summary.textContent = group.label;
        details.appendChild(summary);
        details.appendChild(wrap);
        container.appendChild(details);
      }
    }
  }

  let _trackReady = false;

  function selectTool(id) {
    if (_trackReady && id !== DM.State.current.tool) DM.track?.('select_tool', { tool: id });
    DM.State.current.tool = id;
    if (id !== 'select') {
      DM.State.current.selectedIdx = -1;
      DM.State.current.multiSelectedSet.clear();
      hidePopup();
      hideMultiPopup();
    }
    if (id !== 'image') DM.State.current.pendingAssetId = null;

    document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === id));
    const fabHand = document.getElementById('fab-hand');
    if (fabHand) fabHand.classList.toggle('active', id === 'hand');

    const brushDetails = document.getElementById('brush-details');
    if (brushDetails) brushDetails.hidden = (id !== 'brush');
    if (id === 'brush') refreshBrushAssets();

    const fillDetails = document.getElementById('fill-details');
    if (fillDetails) fillDetails.hidden = (id !== 'fill');
    if (id === 'fill') refreshFillAssets();

    const roomDetails = document.getElementById('room-details');
    if (roomDetails) {
      roomDetails.hidden = (id !== 'room');
      if (id === 'room') {
        const curShape = DM.State.current.roomShape || 'rect';
        roomDetails.querySelectorAll('[data-shape]').forEach(b =>
          b.classList.toggle('active', b.dataset.shape === curShape)
        );
        const curStyle = DM.State.current.roomStoneStyle || 'none';
        roomDetails.querySelectorAll('[data-room-style]').forEach(b =>
          b.classList.toggle('active', b.dataset.roomStyle === curStyle)
        );
      }
    }

    const doorDetails = document.getElementById('door-details');
    if (doorDetails) doorDetails.hidden = (id !== 'door');
    if (id === 'door') refreshDoorAssets();

    const fogDetails = document.getElementById('fog-details');
    if (fogDetails) fogDetails.hidden = (id !== 'fog');

    updateHint(id);
    DM.Renderer.render();
    updateProperties();
  }

  function updateHint(tool) {
    const hints = {
      select:  'Click to select · Shift+click or drag to multi-select · R = rotate · Del = delete',
      erase:   'Click an element to erase it',
      brush:   'Click and drag to paint — choose shape, size and opacity in the panel',
      fill:    'Click a room or floor to fill it with the selected color or texture',
      text:    'Click anywhere to place a text label',
      hand:    'Drag to pan the map',
      room:    'Drag to draw a room',
      secret:  'Drag to draw a secret passage',
      water:   'Drag to place a body of water',
      pit:     'Drag to draw a pit',
      stairs:  'Drag to place a staircase',
      fog:     'Click and drag to paint a fog cloud — set color, size and animation in the panel',
      image:   'Select an image asset, then click to place it',
    };
    const el = document.getElementById('hint');
    if (el) el.textContent = hints[tool] || 'Click to place';
  }

  function initGridControls() {
    document.querySelectorAll('.grid-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        DM.State.current.gridType = btn.dataset.type;
        document.querySelectorAll('.grid-type-btn').forEach(b => b.classList.toggle('active', b === btn));
        DM.Renderer.render();
      });
    });

    const slider = document.getElementById('cell-size');
    const label  = document.getElementById('cell-size-val');
    slider.addEventListener('input', () => {
      DM.State.current.cellSize = +slider.value;
      label.textContent = `${slider.value}px`;
      DM.Renderer.render();
    });

    const colorInput = document.getElementById('grid-color');
    colorInput?.addEventListener('input', () => {
      DM.State.current.gridColor = colorInput.value;
      DM.Renderer.render();
    });

    const widthSlider = document.getElementById('grid-linewidth');
    const widthVal    = document.getElementById('grid-linewidth-val');
    widthSlider?.addEventListener('input', () => {
      DM.State.current.gridLineWidth = +widthSlider.value;
      if (widthVal) widthVal.textContent = (+widthSlider.value).toFixed(1);
      DM.Renderer.render();
    });

    const opSlider = document.getElementById('grid-opacity');
    const opVal    = document.getElementById('grid-opacity-val');
    opSlider?.addEventListener('input', () => {
      DM.State.current.gridOpacity = +opSlider.value;
      if (opVal) opVal.textContent = `${Math.round(+opSlider.value * 100)}%`;
      DM.Renderer.render();
    });
  }

  function syncGridControls() {
    const st = DM.State.current;
    const colorInput  = document.getElementById('grid-color');
    const widthSlider = document.getElementById('grid-linewidth');
    const widthVal    = document.getElementById('grid-linewidth-val');
    const opSlider    = document.getElementById('grid-opacity');
    const opVal       = document.getElementById('grid-opacity-val');
    if (colorInput)  colorInput.value = st.gridColor ?? '#6e4819';
    if (widthSlider) widthSlider.value = st.gridLineWidth ?? 0.5;
    if (widthVal)    widthVal.textContent = (st.gridLineWidth ?? 0.5).toFixed(1);
    if (opSlider)    opSlider.value = st.gridOpacity ?? 0.15;
    if (opVal)       opVal.textContent = `${Math.round((st.gridOpacity ?? 0.15) * 100)}%`;
  }

  function initBgControls() {
    const colorInput = document.getElementById('bg-color');
    const resetBtn   = document.getElementById('bg-reset');
    const noiseInput = document.getElementById('bg-noise');
    const noiseVal   = document.getElementById('bg-noise-val');
    if (!colorInput) return;

    colorInput.addEventListener('input', () => {
      DM.State.current.bgColor = colorInput.value;
      DM.Renderer.render();
    });

    noiseInput?.addEventListener('input', () => {
      DM.State.current.bgNoise = +noiseInput.value / 100;
      if (noiseVal) noiseVal.textContent = noiseInput.value + '%';
      DM.Renderer.render();
    });

    resetBtn?.addEventListener('click', () => {
      DM.State.current.bgColor = null;
      DM.State.current.bgNoise = 1;
      colorInput.value = '#f2e4b2';
      if (noiseInput) noiseInput.value = 100;
      if (noiseVal)   noiseVal.textContent = '100%';
      DM.Renderer.render();
    });

    const fileInput  = document.getElementById('bg-image-file');
    const uploadBtn  = document.getElementById('bg-image-upload');
    const clearBtn   = document.getElementById('bg-image-clear');
    const scaleInput = document.getElementById('bg-image-scale');
    const scaleVal   = document.getElementById('bg-image-scale-val');

    uploadBtn?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file || !file.type.startsWith('image/')) return;
      if (file.size > 1024 * 1024) {
        DM.toast?.('Background image exceeds the 1 MB limit.', true);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const st = DM.State.current;
        st.bgImageSrc = reader.result;   // data URL, kept local only
        st.bgImageId  = null;
        refreshBgAssets();
        syncBgPicker();
        DM.Renderer.render();
      };
      reader.onerror = () => DM.toast?.('Could not read the image file.', true);
      reader.readAsDataURL(file);
    });

    clearBtn?.addEventListener('click', () => {
      const st = DM.State.current;
      st.bgImageId  = null;
      st.bgImageSrc = null;
      refreshBgAssets();
      syncBgPicker();
      DM.Renderer.render();
    });

    scaleInput?.addEventListener('input', () => {
      const scale = +scaleInput.value;
      DM.State.current.bgImageScale = scale;
      if (scaleVal) scaleVal.textContent = `${Math.round(scale * 100)}%`;
      DM.Renderer.render();
    });

    refreshBgAssets();
  }

  function refreshBgAssets() {
    const container = document.getElementById('bg-assets');
    if (!container) return;
    const st         = DM.State.current;
    const catNameMap = _buildCatNameMap();
    const assets     = st.assets.filter(_isValidAsset);
    container.innerHTML = '';

    const setActive = (activeBtn) => {
      container.querySelectorAll('.bp-asset-thumb-btn').forEach(b => b.classList.remove('active'));
      activeBtn.classList.add('active');
    };

    const noneBtn = document.createElement('button');
    noneBtn.className = 'bp-asset-thumb-btn' + (!st.bgImageId && !st.bgImageSrc ? ' active' : '');
    noneBtn.title = 'None';
    noneBtn.textContent = '✕';
    noneBtn.addEventListener('click', () => {
      st.bgImageId  = null;
      st.bgImageSrc = null;
      setActive(noneBtn);
      syncBgPicker();
      DM.Renderer.render();
    });
    container.appendChild(noneBtn);

    for (const asset of assets) {
      const btn = document.createElement('button');
      btn.className = 'bp-asset-thumb-btn' + (st.bgImageId === asset.id ? ' active' : '');
      btn.title = asset.name;
      if (asset._img) {
        const thumb = document.createElement('canvas');
        thumb.width = thumb.height = 30;
        thumb.getContext('2d').drawImage(asset._img, 0, 0, 30, 30);
        btn.appendChild(thumb);
      } else {
        btn.textContent = (asset.name || '?').substring(0, 3);
      }
      btn.addEventListener('click', () => {
        st.bgImageId  = asset.id;
        st.bgImageSrc = null;
        setActive(btn);
        syncBgPicker();
        DM.Renderer.render();
      });
      container.appendChild(btn);
    }
  }

  function syncBgPicker() {
    const st         = DM.State.current;
    const colorInput = document.getElementById('bg-color');
    const noiseInput = document.getElementById('bg-noise');
    const noiseVal   = document.getElementById('bg-noise-val');
    if (colorInput) colorInput.value = st.bgColor || '#f2e4b2';
    if (noiseInput) {
      const pct = Math.round((st.bgNoise ?? 1) * 100);
      noiseInput.value = pct;
      if (noiseVal) noiseVal.textContent = pct + '%';
    }
    const hasImage   = !!(st.bgImageId != null || st.bgImageSrc);
    const scaleRow   = document.getElementById('bg-scale-row');
    const scaleInput = document.getElementById('bg-image-scale');
    const scaleVal   = document.getElementById('bg-image-scale-val');
    if (scaleRow)   scaleRow.hidden = !hasImage;
    if (scaleInput) scaleInput.value = st.bgImageScale ?? 1;
    if (scaleVal)   scaleVal.textContent = `${Math.round((st.bgImageScale ?? 1) * 100)}%`;
  }

  function syncMapSizeInputs() {
    const st     = DM.State.current;
    const wInput = document.getElementById('map-width');
    const hInput = document.getElementById('map-height');
    if (wInput) { wInput.value = st.mapW; wInput.defaultValue = String(st.mapW); }
    if (hInput) { hInput.value = st.mapH; hInput.defaultValue = String(st.mapH); }
  }

  function initMapSizeControls() {
    const wInput = document.getElementById('map-width');
    const hInput = document.getElementById('map-height');
    if (!wInput || !hInput) return;

    syncMapSizeInputs();

    function applyMapSize() {
      const st = DM.State.current;
      const nw = Math.max(400, Math.min(8000, parseInt(wInput.value, 10) || st.mapW));
      const nh = Math.max(300, Math.min(8000, parseInt(hInput.value, 10) || st.mapH));
      wInput.value = nw; wInput.defaultValue = String(nw);
      hInput.value = nh; hInput.defaultValue = String(nh);
      if (nw === st.mapW && nh === st.mapH) return;
      st.mapW = nw; st.mapH = nh;
      DM.Renderer.resizeCanvas();
      DM.Renderer.render();
      DM.IO.saveNow();  // persist immediately — avoids losing changes on quick page refresh
    }

    [wInput, hInput].forEach(inp => {
      let _confirmed = false;

      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          _confirmed = true;
          applyMapSize();
          inp.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          _confirmed = true;  // mark as handled so blur doesn't double-reset
          syncMapSizeInputs();
          inp.blur();
        }
      });

      inp.addEventListener('blur', () => {
        if (!_confirmed) syncMapSizeInputs();  // cancel partial entry on focus-away
        _confirmed = false;
      });
    });
  }

  function initGeneratorControls() {
    const styleButtons = document.querySelectorAll('[data-gen-style]');
    styleButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        styleButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    document.querySelectorAll('.gen-toggle').forEach(btn => {
      btn.addEventListener('click', () => btn.classList.toggle('active'));
    });

    document.getElementById('btn-generate').addEventListener('click', () => {
      const numRooms = parseInt(document.getElementById('gen-rooms').value, 10) || 8;
      if (!confirm(`Generate a dungeon with ${numRooms} rooms? The current map will be replaced.`)) return;

      const style   = document.querySelector('[data-gen-style].active')?.dataset.genStyle ?? 'ink';
      const pillars = document.getElementById('gen-pillars').classList.contains('active');
      const stairs  = document.getElementById('gen-stairs').classList.contains('active');

      DM.State.clearMap();
      const st = DM.State.current;

      DM.State.renameLayer(0, 'Rooms');
      DM.State.addLayer();
      DM.State.renameLayer(1, 'Props');

      DM.track?.('generate_dungeon', { rooms: numRooms, style, pillars, stairs });

      const { rooms, props } = DM.Generator.generate(numRooms, Date.now(), { style, pillars, stairs });

      for (const el of rooms) st.layers[0].elements.push(el);
      for (const el of props) st.layers[1].elements.push(el);

      DM.State.setActiveLayer(0);
      st.selectedIdx = -1;

      DM.Renderer.render();
      updateProperties();
      updateLayersPanel();
    });
  }

  let _assetMeta = { systemCategories: [], myCategories: [], userTier: 0 };

  function setAssetMeta(meta) {
    if (meta) _assetMeta = meta;
  }

  function _isValidAsset(a) { return !!(a.src); }

  function _buildCatNameMap() {
    const map = {};
    for (const c of _assetMeta.systemCategories) map[String(c.id)] = c.name;
    for (const c of _assetMeta.myCategories)     map[String(c.id)] = c.name;
    return map;
  }

  const _assetTagFilter = new Set();   // active tag filters (combined with AND)

  function _toggleAssetTag(tag) {
    _assetTagFilter.has(tag) ? _assetTagFilter.delete(tag) : _assetTagFilter.add(tag);
    updateAssetList();
  }

  function _renderAssetTags(allAssets) {
    const freq = {};
    for (const a of allAssets) for (const t of (a.tags || [])) freq[t] = (freq[t] || 0) + 1;
    const popular = Object.keys(freq)
      .sort((a, b) => freq[b] - freq[a] || a.localeCompare(b))
      .slice(0, 12);

    const popWrap  = document.getElementById('asset-tag-pop-wrap');
    const popStrip = document.getElementById('asset-tag-pop');
    if (popWrap && popStrip) {
      popWrap.hidden = popular.length === 0;
      popStrip.innerHTML = popular.map(t =>
        `<button class="asset-tag-chip${_assetTagFilter.has(t) ? ' on' : ''}" data-tag="${t}">${t}</button>`
      ).join('');
      popStrip.querySelectorAll('.asset-tag-chip').forEach(c =>
        c.addEventListener('click', () => _toggleAssetTag(c.dataset.tag))
      );
    }

    const bar = document.getElementById('asset-active');
    if (bar) {
      const term = (document.getElementById('asset-search')?.value || '').trim();
      bar.classList.toggle('show', _assetTagFilter.size > 0 || term.length > 0);
      const chips = document.getElementById('asset-active-chips');
      if (chips) {
        chips.innerHTML = [..._assetTagFilter].map(t =>
          `<button class="asset-tag-chip on" data-tag="${t}">${t}<span class="x">✕</span></button>`
        ).join('');
        chips.querySelectorAll('.asset-tag-chip').forEach(c =>
          c.addEventListener('click', () => _toggleAssetTag(c.dataset.tag))
        );
      }
    }
  }

  function initAssetPanel() {
    document.getElementById('btn-upload-image').addEventListener('click', () => {
      document.getElementById('image-upload').click();
    });
    document.getElementById('image-upload').addEventListener('change', async e => {
      const files = [...e.target.files];
      if (!files.length) return;
      await DM.IO.uploadImages(files);
      updateAssetList();
      e.target.value = '';
    });
    document.getElementById('asset-search')?.addEventListener('input', updateAssetList);
    document.getElementById('asset-search-clr')?.addEventListener('click', () => {
      const inp = document.getElementById('asset-search');
      if (inp) inp.value = '';
      updateAssetList();
    });
    document.getElementById('asset-active-clear')?.addEventListener('click', () => {
      _assetTagFilter.clear();
      const inp = document.getElementById('asset-search');
      if (inp) inp.value = '';
      updateAssetList();
    });
  }

  function _assetItemEl(asset) {
    const item = document.createElement('div');
    item.className = 'asset-item';
    const thumbSrc = asset.src || '';
    const isVideo  = DM.isVideoAsset(asset);
    const thumbHtml = isVideo
      ? `<video src="${thumbSrc}#t=0.001" title="${asset.name}" class="asset-thumb" muted loop playsinline preload="metadata"></video>`
      : `<img src="${thumbSrc}" title="${asset.name}" class="asset-thumb" loading="lazy">`;
    item.innerHTML = `
      ${thumbHtml}
      <span class="asset-name" title="${asset.name}">${asset.name}</span>
      <label class="asset-physical-label" title="Physical: placed elements will be VTT obstacles">
        <input type="checkbox" class="asset-physical-cb" ${asset.physical ? 'checked' : ''}>
        <span>Phys</span>
      </label>
      ${!asset.isSystem
        ? `<button class="asset-del" title="Remove">✕</button>`
        : ''}
    `;
    if (isVideo) {
      const vid = item.querySelector('.asset-thumb');
      item.addEventListener('mouseenter', () => { vid.play?.().catch(() => {}); });
      item.addEventListener('mouseleave', () => { vid.pause?.(); });
    }
    item.querySelector('.asset-thumb').addEventListener('click', () => {
      const st = DM.State.current;
      if (st.pendingAssetId === asset.id) {
        const idx = st.elements.findIndex(el => el.type === 'image' && el.assetId === asset.id);
        document.querySelectorAll('.asset-item').forEach(i => i.classList.remove('selected'));
        st.selectedIdx = idx;
        st.multiSelectedSet.clear();
        if (idx >= 0) st.multiSelectedSet.add(idx);
        selectTool('select');
        return;
      }
      st.pendingAssetId = asset.id;
      selectTool('image');
      document.querySelectorAll('.asset-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
    });
    item.querySelector('.asset-physical-cb').addEventListener('change', function () {
      asset.physical = this.checked;
    });
    const delBtn = item.querySelector('.asset-del');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Remove "${asset.name}"?`)) return;
        delBtn.disabled = true;
        try {
          await DM.IO.deleteAsset(asset.id);
          updateAssetList();
          DM.Renderer.render();
        } finally {
          delBtn.disabled = false;
        }
      });
    }
    return item;
  }

  function updateAssetList() {
    const container = document.getElementById('asset-list');
    container.innerHTML = '';

    const allAssets  = DM.State.current.assets.filter(_isValidAsset);
    const catNameMap = _buildCatNameMap();
    const searchTerm = (document.getElementById('asset-search')?.value || '').trim().toLowerCase();
    document.getElementById('asset-search-box')?.classList.toggle('has', searchTerm.length > 0);

    _renderAssetTags(allAssets);

    if (searchTerm || _assetTagFilter.size) {
      const matches = allAssets.filter(a => {
        const tags = a.tags || [];
        for (const t of _assetTagFilter) if (!tags.includes(t)) return false;   // tags = AND
        if (!searchTerm) return true;
        const catName = (catNameMap[String(a.categoryId)] || '').toLowerCase();
        return a.name.toLowerCase().includes(searchTerm)
            || catName.includes(searchTerm)
            || tags.some(t => t.includes(searchTerm));
      });
      const cnt = document.getElementById('asset-active-count');
      if (cnt) cnt.textContent = String(matches.length);
      if (matches.length) {
        const grid = document.createElement('div');
        grid.className = 'asset-grid-mini';
        matches.forEach(a => grid.appendChild(_assetItemEl(a)));
        container.appendChild(grid);
      } else {
        const note = document.createElement('div');
        note.className = 'asset-locked-msg';
        note.style.textAlign = 'center';
        note.textContent = 'No results.';
        container.appendChild(note);
      }
      return;
    }

    const { systemCategories, myCategories, userTier } = _assetMeta;
    const tierLabels = { 0: 'Free', 1: 'Supporter', 2: 'Patron', 3: 'Pro', 99: 'Admin' };

    const parents = [...systemCategories]
      .filter(c => !c.parent_id)
      .sort((a, b) => (+a.sort_order) - (+b.sort_order) || (+a.id) - (+b.id));

    const childMap = {};
    systemCategories
      .filter(c => c.parent_id)
      .forEach(c => {
        const pid = +c.parent_id;
        (childMap[pid] = childMap[pid] || []).push(c);
      });
    Object.values(childMap).forEach(arr =>
      arr.sort((a, b) => (+a.sort_order) - (+b.sort_order) || (+a.id) - (+b.id))
    );

    let systemRendered = 0;
    const renderedCatIds = new Set();

    for (const parent of parents) {
      const subs       = childMap[+parent.id] || [];
      const parentTier = +parent.tier_min;
      const locked     = parentTier > (+userTier);

      if (locked) continue;

      const branchIds    = [+parent.id, ...subs.map(s => +s.id)];
      const branchAssets = allAssets.filter(
        a => a.isSystem && branchIds.includes(+a.categoryId)
      );
      if (branchAssets.length === 0) continue;

      systemRendered++;
      renderedCatIds.add(+parent.id);

      const details = document.createElement('details');
      details.className = 'asset-section';

      const summary = document.createElement('summary');
      summary.className = 'asset-section-header';
      summary.innerHTML =
        `<span class="asset-section-name">${parent.name}</span>` +
        `<span class="asset-tier-badge tier-${parentTier}">${tierLabels[parentTier] || ''}</span>` +
        `<span class="asset-count-pill">${branchAssets.length}</span>`;
      details.appendChild(summary);

      if (subs.length === 0) {
        const grid = document.createElement('div');
        grid.className = 'asset-grid-mini';
        branchAssets.forEach(a => grid.appendChild(_assetItemEl(a)));
        details.appendChild(grid);
      } else {
        const directAssets = allAssets.filter(
          a => a.isSystem && String(a.categoryId) === String(parent.id)
        );
        if (directAssets.length) {
          const grid = document.createElement('div');
          grid.className = 'asset-grid-mini';
          directAssets.forEach(a => grid.appendChild(_assetItemEl(a)));
          details.appendChild(grid);
        }

        for (const sub of subs) {
          const subTier = +sub.tier_min;
          if (subTier > (+userTier)) continue;

          const subAssets = allAssets.filter(
            a => a.isSystem && String(a.categoryId) === String(sub.id)
          );
          if (subAssets.length === 0) continue;

          renderedCatIds.add(+sub.id);

          const subDetails = document.createElement('details');
          subDetails.className = 'asset-sub-section';

          const subSummary = document.createElement('summary');
          subSummary.className = 'asset-sub-header';
          subSummary.innerHTML =
            `<span class="asset-section-name">${sub.name}</span>` +
            `<span class="asset-count-pill">${subAssets.length}</span>`;
          subDetails.appendChild(subSummary);

          const grid = document.createElement('div');
          grid.className = 'asset-grid-mini';
          subAssets.forEach(a => grid.appendChild(_assetItemEl(a)));
          subDetails.appendChild(grid);
          details.appendChild(subDetails);
        }
      }
      container.appendChild(details);
    }

    const orphanAssets = allAssets.filter(
      a => a.isSystem && !renderedCatIds.has(+a.categoryId)
    );
    if (orphanAssets.length > 0) {
      systemRendered++;
      const details = document.createElement('details');
      details.className = 'asset-section';
      details.open = true;
      const summary = document.createElement('summary');
      summary.className = 'asset-section-header';
      summary.innerHTML =
        `<span class="asset-section-name">General</span>` +
        `<span class="asset-count-pill">${orphanAssets.length}</span>`;
      details.appendChild(summary);
      const grid = document.createElement('div');
      grid.className = 'asset-grid-mini';
      orphanAssets.forEach(a => grid.appendChild(_assetItemEl(a)));
      details.appendChild(grid);
      container.appendChild(details);
    }

    if (systemRendered === 0) {
      const note = document.createElement('div');
      note.className = 'asset-locked-msg';
      note.style.textAlign = 'center';
      note.textContent = 'No system assets yet.';
      container.appendChild(note);
    }

    const isAuth      = DM.Auth.state.isLoggedIn;
    const hasPersonal = allAssets.some(a => !a.isSystem);
    if (!isAuth && !hasPersonal) return;

    const myDetails = document.createElement('details');
    myDetails.className = 'asset-section';
    myDetails.open = true;

    const mySummary = document.createElement('summary');
    mySummary.className = 'asset-section-header';
    const myLabel = document.createElement('span');
    myLabel.className = 'asset-section-name';
    myLabel.textContent = 'My Uploads';
    mySummary.appendChild(myLabel);

    if (isAuth) {
      const newCatBtn = document.createElement('button');
      newCatBtn.className = 'asset-newcat-btn';
      newCatBtn.title = 'New category';
      newCatBtn.textContent = '+';
      newCatBtn.addEventListener('click', e => {
        e.stopPropagation();
        newCatForm.classList.toggle('hidden');
        if (!newCatForm.classList.contains('hidden')) newCatForm.querySelector('input').focus();
      });
      mySummary.appendChild(newCatBtn);
    }

    myDetails.appendChild(mySummary);

    if (isAuth) {
      const newCatForm = document.createElement('div');
      newCatForm.className = 'asset-newcat-form hidden';
      newCatForm.innerHTML = `
        <input type="text" class="asset-newcat-input" placeholder="Category name…" maxlength="80">
        <button class="asset-newcat-ok">✓</button>
        <button class="asset-newcat-cancel">✕</button>
      `;
      myDetails.appendChild(newCatForm);

      mySummary.querySelector('.asset-newcat-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        newCatForm.classList.toggle('hidden');
        if (!newCatForm.classList.contains('hidden')) newCatForm.querySelector('input').focus();
      });

      newCatForm.querySelector('.asset-newcat-cancel').addEventListener('click', () => {
        newCatForm.classList.add('hidden');
        newCatForm.querySelector('input').value = '';
      });
      newCatForm.querySelector('.asset-newcat-ok').addEventListener('click', async () => {
        const input = newCatForm.querySelector('input');
        const name  = input.value.trim();
        if (!name) return;
        const okBtn = newCatForm.querySelector('.asset-newcat-ok');
        okBtn.disabled = true;
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
        let res;
        try {
          const r = await fetch((window.TMB_BASE || '') + '/api/asset-categories.php', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify({ name, personal: true }),
          });
          res = await r.json();
        } catch {
          alert('Network error — could not create category.');
          okBtn.disabled = false;
          return;
        }
        okBtn.disabled = false;
        if (res.success) {
          _assetMeta.myCategories.push({ id: res.id, name: res.name, slug: res.slug });
          input.value = '';
          newCatForm.classList.add('hidden');
          updateAssetList();
        } else {
          alert(res.error || 'Could not create category.');
        }
      });
    }

    if (isAuth) {
      for (const cat of myCategories) {
        const catAssets = allAssets.filter(a => !a.isSystem && String(a.categoryId) === String(cat.id));
        if (!catAssets.length) continue;

        const subDetails = document.createElement('details');
        subDetails.className = 'asset-sub-section';
        subDetails.open = true;

        const subSummary = document.createElement('summary');
        subSummary.className = 'asset-sub-header';
        const subLabel = document.createElement('span');
        subLabel.className = 'asset-section-name';
        subLabel.textContent = cat.name;
        const delBtn = document.createElement('button');
        delBtn.className = 'asset-delcat-btn';
        delBtn.title = 'Delete category';
        delBtn.textContent = '🗑';
        delBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (!confirm(`Delete category "${cat.name}"? Assets won't be deleted.`)) return;
          const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
          let res;
          try {
            const r = await fetch(`${window.TMB_BASE || ''}/api/asset-categories.php?id=${cat.id}`, {
              method: 'DELETE', credentials: 'same-origin',
              headers: { 'X-CSRF-Token': csrf },
            });
            res = await r.json();
          } catch {
            alert('Network error — could not delete category.');
            return;
          }
          if (res.success) {
            _assetMeta.myCategories = _assetMeta.myCategories.filter(c => c.id !== cat.id);
            updateAssetList();
          } else {
            alert(res.error || 'Could not delete category.');
          }
        });
        subSummary.appendChild(subLabel);
        subSummary.appendChild(delBtn);
        subDetails.appendChild(subSummary);

        const subGrid = document.createElement('div');
        subGrid.className = 'asset-grid-mini';
        catAssets.forEach(a => subGrid.appendChild(_assetItemEl(a)));
        subDetails.appendChild(subGrid);
        myDetails.appendChild(subDetails);
      }
    }

    const uncatAssets = allAssets.filter(a => !a.isSystem && !a.categoryId);
    if (uncatAssets.length) {
      const subDetails = document.createElement('details');
      subDetails.className = 'asset-sub-section';
      subDetails.open = true;
      const subSummary = document.createElement('summary');
      subSummary.className = 'asset-sub-header';
      subSummary.innerHTML = '<span class="asset-section-name" style="color:var(--muted)">Uncategorized</span>';
      subDetails.appendChild(subSummary);
      const subGrid = document.createElement('div');
      subGrid.className = 'asset-grid-mini';
      uncatAssets.forEach(a => subGrid.appendChild(_assetItemEl(a)));
      subDetails.appendChild(subGrid);
      myDetails.appendChild(subDetails);
    }

    if (!allAssets.some(a => !a.isSystem)) {
      const empty = document.createElement('div');
      empty.className = 'asset-locked-msg';
      empty.textContent = 'No uploads yet. Click Upload Image to add.';
      myDetails.appendChild(empty);
    }

    container.appendChild(myDetails);
    refreshBrushAssets();
    refreshDoorAssets();
    refreshFillAssets();
    refreshBgAssets();
    document.getElementById('popup-floor-search')?.dispatchEvent(new Event('input'));
    document.getElementById('popup-door-search')?.dispatchEvent(new Event('input'));
  }

  let _popupPinned     = null; // { left, top } set after user drags; null = use corner
  let _popupLastIdx    = -1;   // tracks selected element to reset pin/corner on change
  let _popupCornerSide = null; // 'left'|'right' — decided once per selection, never re-evaluated during drag

  function positionPopup() {
    const popup = document.getElementById('elem-popup');
    if (!popup || popup.classList.contains('hidden')) return;

    if (_popupPinned) {
      popup.style.left = _popupPinned.left + 'px';
      popup.style.top  = _popupPinned.top  + 'px';
      return;
    }

    const st  = DM.State.current;
    const idx = st.selectedIdx;
    if (idx < 0 || idx >= st.elements.length) return;

    const area = document.getElementById('canvas-area');
    if (!area) return;

    const pw     = popup.offsetWidth || 214;
    const MARGIN = 8;

    if (!_popupCornerSide) {
      const el   = st.elements[idx];
      const zoom = st.zoom;
      let elScreenX;
      if (DM.Config.POINT_TOOLS.has(el.type) || el.type === 'text') {
        elScreenX = el.x * zoom - area.scrollLeft;
      } else {
        const r = DM.elementRect(el);
        elScreenX = (r.x + r.w / 2) * zoom - area.scrollLeft;
      }
      _popupCornerSide = elScreenX < area.clientWidth / 2 ? 'right' : 'left';
    }

    popup.style.left = (_popupCornerSide === 'right' ? area.clientWidth - pw - MARGIN : MARGIN) + 'px';
    popup.style.top  = MARGIN + 'px';
  }

  function _initPopupDrag() {
    const popup = document.getElementById('elem-popup');
    if (!popup) return;

    let dragging = false, ox = 0, oy = 0;

    popup.addEventListener('mousedown', e => {
      if (!e.target.closest('.popup-type')) return;
      if (e.target.closest('#popup-close-btn')) return;
      dragging = true;
      ox = e.clientX - popup.getBoundingClientRect().left;
      oy = e.clientY - popup.getBoundingClientRect().top;
      popup.style.transition = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const wrapper = document.getElementById('canvas-wrapper');
      if (!wrapper) return;
      const wr = wrapper.getBoundingClientRect();
      const pw = popup.offsetWidth;
      const ph = popup.offsetHeight;
      const left = Math.max(4, Math.min(e.clientX - wr.left - ox, wr.width  - pw - 4));
      const top  = Math.max(4, Math.min(e.clientY - wr.top  - oy, wr.height - ph - 4));
      popup.style.left = left + 'px';
      popup.style.top  = top  + 'px';
      _popupPinned = { left, top };
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function hidePopup() {
    const popup = document.getElementById('elem-popup');
    if (popup) popup.classList.add('hidden');
  }

  function _cellsOf(el, cs) {
    const { x, y, w, h } = DM.elementRect(el);
    const gx0      = Math.round(x / cs), gy0 = Math.round(y / cs);
    const gx1      = Math.round((x + w) / cs), gy1 = Math.round((y + h) / cs);
    const isCircle = el.shape === 'circle';
    const ecx = (gx0 + gx1) / 2, ecy = (gy0 + gy1) / 2;
    const erx = (gx1 - gx0) / 2 || 0.5, ery = (gy1 - gy0) / 2 || 0.5;
    const s = new Set();
    for (let gx = gx0; gx < gx1; gx++) {
      for (let gy = gy0; gy < gy1; gy++) {
        if (isCircle) {
          const dx = (gx + 0.5 - ecx) / erx;
          const dy = (gy + 0.5 - ecy) / ery;
          if (dx * dx + dy * dy > 1) continue;
        }
        s.add(`${gx},${gy}`);
      }
    }
    return s;
  }

  function _expandCells(cells) {
    const out = new Set(cells);
    for (const key of cells) {
      const [gx, gy] = key.split(',').map(Number);
      out.add(`${gx - 1},${gy}`);
      out.add(`${gx + 1},${gy}`);
      out.add(`${gx},${gy - 1}`);
      out.add(`${gx},${gy + 1}`);
    }
    return out;
  }

  function _propagateConnected(srcEl, patch) {
    const st       = DM.State.current;
    const srcLayer = st.layers.find(l => l.elements.includes(srcEl));
    if (!srcLayer) return;

    const cs         = st.cellSize;
    const candidates = srcLayer.elements.filter(el => el !== srcEl && el.type === srcEl.type);
    if (!candidates.length) return;

    const allCells = new Map([[srcEl, _cellsOf(srcEl, cs)]]);
    for (const el of candidates) allCells.set(el, _cellsOf(el, cs));

    const visited = new Set([srcEl]);
    const queue   = [srcEl];
    while (queue.length) {
      const expanded = _expandCells(allCells.get(queue.shift()));
      for (const el of candidates) {
        if (visited.has(el)) continue;
        for (const key of allCells.get(el)) {
          if (expanded.has(key)) {
            visited.add(el);
            Object.assign(el, patch);
            queue.push(el);
            break;
          }
        }
      }
    }
  }

  const ROOM_STYLE_PROPS = [
    'color', 'borderColor', 'borderWidth', 'borderRough', 'opacity',
    'stoneStyle', 'stoneIntensity', 'fillAssetId', 'fillAssetScale',
  ];
  DM.applyConnectedStyle = function(newEl) {
    const st       = DM.State.current;
    const srcLayer = st.layers.find(l => l.elements.includes(newEl));
    if (!srcLayer) return;
    const cs         = st.cellSize;
    const candidates = srcLayer.elements.filter(el => el !== newEl && el.type === newEl.type);
    if (!candidates.length) return;

    const expanded = _expandCells(_cellsOf(newEl, cs));
    for (const el of candidates) {
      for (const key of _cellsOf(el, cs)) {
        if (expanded.has(key)) {
          for (const p of ROOM_STYLE_PROPS) {
            if (p in el) newEl[p] = el[p];
            else delete newEl[p];
          }
          return;
        }
      }
    }
  };

  function updateProperties() {
    const popup = document.getElementById('elem-popup');
    if (!popup) return;

    const st  = DM.State.current;
    const idx = st.selectedIdx;

    if (idx < 0 || idx >= st.elements.length || st.tool !== 'select' || st.multiSelectedSet.size > 1) {
      hidePopup();
      return;
    }

    if (idx !== _popupLastIdx) { _popupPinned = null; _popupCornerSide = null; _popupLastIdx = idx; }

    const el      = st.elements[idx];
    const isPoint = DM.Config.POINT_TOOLS.has(el.type);
    const isArea  = DM.Config.AREA_TOOLS.has(el.type);
    const cs      = st.cellSize;

    let html = `
      <div class="popup-type">
        ${_typeLabel(el.type)}
        <button class="popup-close" id="popup-close-btn">✕</button>
      </div>`;

    if (el.type === 'room') {
      const isCircle = el.shape === 'circle';
      html += _propRow('Shape',
        `<div class="brush-shape-row">
           <button class="brush-opt-btn prop-room-shape${!isCircle ? ' active' : ''}" data-shape="rect">▭ Rect</button>
           <button class="brush-opt-btn prop-room-shape${isCircle  ? ' active' : ''}" data-shape="circle">◯ Circle</button>
         </div>`
      );
    }

    const _r = (isPoint || el.type === 'text') ? null : DM.elementRect(el);
    const px = Math.round(isPoint || el.type === 'text' ? el.x : _r.x);
    const py = Math.round(isPoint || el.type === 'text' ? el.y : _r.y);
    html += _propRow('X px',
      `<input type="number" step="1" value="${px}" data-prop="posX" class="prop-input short">`
    );
    html += _propRow('Y px',
      `<input type="number" step="1" value="${py}" data-prop="posY" class="prop-input short">`
    );

    if (el.type === 'door') {
      const cells = Math.max(1, Math.round((el.w || cs) / cs));
      html += _propRow('Width (cells)',
        `<input type="number" min="1" step="1" value="${cells}" data-prop="doorCells" class="prop-input short">`
      );
    } else if (isArea || el.type === 'image' || (isPoint && el.w && el.h)) {
      const { w, h } = DM.elementRect(el);
      html += _propRow('W px',
        `<input type="number" min="1" step="1" value="${Math.round(w)}" data-prop="w" class="prop-input short">`
      );
      html += _propRow('H px',
        `<input type="number" min="1" step="1" value="${Math.round(h)}" data-prop="h" class="prop-input short">`
      );
    }

    if (isPoint || el.type === 'text' || el.type === 'image' || el.type === 'stairs') {
      const deg = Math.round(((el.rotation || 0) * 180 / Math.PI + 360) % 360);
      html += _propRow('Rotation', _propSlider('rotDeg', 0, 360, 1, deg, { scale: 1, decimals: 0, unit: '°' }));
    }

    if (isPoint && !(el.w && el.h)) {
      const sc = +(el.scale || 1);
      html += _propRow('Scale', _propSlider('scale', 0.25, 3, 0.05, sc, { scale: 1, decimals: 2, unit: '×' }));
    }

    const op = el.opacity !== undefined ? el.opacity : 1;
    html += _propRow('Opacity', _propSlider('opacity', 0.05, 1, 0.05, op, { scale: 100, decimals: 0, unit: '%' }));

    if (el.type === 'door') {
      html += _propRow('Asset',
        `<div style="display:flex;flex-direction:column;gap:4px;flex:1">` +
        `<input type="text" id="popup-door-search" placeholder="Search…" class="asset-search-input">` +
        `<div id="popup-door-thumbs" class="bp-asset-strip"></div></div>`
      );
    }

    if (el.type !== 'image' && el.type !== 'stairs') {
      const col = el.color || _defaultColor(el.type);
      html += _propRow('Color',
        `<input type="color" value="${col}" data-prop="color" class="prop-input prop-color">`
      );
    }

    if (el.type === 'brush' && el.shape === 'cave') {
      const cr = el.borderRough ?? 0.5;
      const cc = el.borderColor || '#2a2a2a';
      const cw = el.borderWidth ?? 0;
      html += _propRow('Roughness', _propSlider('borderRough', 0, 1, 0.05, cr, { scale: 100, decimals: 0, unit: '%' }));
      html += _propRow('Edge color',
        `<input type="color" value="${cc}" data-prop="borderColor" class="prop-input prop-color">`
      );
      html += _propRow('Edge width', _propSlider('borderWidth', 0, 12, 0.5, cw, { scale: 1, decimals: 1 }));
    }

    if (DM.Config.FLOOR_TYPES.has(el.type)) {
      const fscale = el.fillAssetScale ?? 1;
      html += _propRow('Texture',
        `<div style="display:flex;flex-direction:column;gap:4px;flex:1">` +
        `<input type="text" id="popup-floor-search" placeholder="Search…" class="asset-search-input">` +
        `<div id="popup-floor-thumbs" class="bp-asset-strip"></div></div>`
      );
      html += `<div class="prop-row" id="popup-floor-scale-row"${el.fillAssetId ? '' : ' hidden'}>` +
        `<label class="prop-label">Tile size</label>` +
        `<div class="prop-ctrl">` +
        `<input type="range" id="popup-floor-scale" data-sid="popup-floor-scale" data-scale="100" data-dec="0"` +
        ` min="0.1" max="4" step="0.1" value="${fscale}" class="prop-input" style="flex:1">` +
        `<input type="number" data-sid-n="popup-floor-scale" min="10" max="400" step="10" value="${Math.round(fscale*100)}" class="prop-val-input">` +
        `<span class="prop-unit">%</span>` +
        `</div></div>`;
    }

    if (el.type === 'text') {
      html += _propRow('Text',
        `<textarea data-prop="text" class="prop-textarea" rows="2">${_escHtml(el.text || '')}</textarea>`
      );
      html += _propRow('Size',
        `<input type="number" min="8" max="120" value="${el.fontSize || 18}" data-prop="fontSize" class="prop-input short">`
      );
      html += _propRow('Width',
        `<input type="number" min="40" max="800" value="${el.w || 120}" data-prop="textW" class="prop-input short">px`
      );
      html += _propRow('',
        `<label class="prop-check"><input type="checkbox" data-prop="bold" ${el.bold ? 'checked' : ''}> Bold</label>
         <label class="prop-check"><input type="checkbox" data-prop="italic" ${el.italic ? 'checked' : ''}> Italic</label>`
      );
      const elAlign = el.align || 'center';
      html += _propRow('Align',
        `<div style="display:flex;gap:4px">` +
        ['left','center','right'].map(a =>
          `<button class="prop-reset-btn prop-align-btn${a === elAlign ? ' active' : ''}" data-align="${a}" style="flex:1;padding:2px 4px">${
            a === 'left' ? '⬱' : a === 'center' ? '☰' : '⬰'
          }</button>`
        ).join('') + `</div>`
      );
      html += _propRow('',
        `<label class="prop-check"><input type="checkbox" data-prop="gmOnly" ${el.gmOnly ? 'checked' : ''}>
           <span style="color:#e88a00;font-weight:600">GM only</span>
           <span style="opacity:.6;font-size:.85em"> — Foundry note, hidden from players</span>
         </label>`
      );
      const hasBg = el.bgColor != null;
      html += _propRow('Background',
        `<input type="color" value="${el.bgColor || '#fffff0'}" data-prop="textBgColor" class="prop-input prop-color"${!hasBg ? ' disabled' : ''} id="text-bg-color">
         <button class="prop-reset-btn" id="toggle-text-bg" style="min-width:auto;padding:2px 8px">${hasBg ? '✕ Remove' : '+ Add'}</button>`
      );
      const sw  = el.borderWidth ?? 0;
      const sc  = el.borderColor || '#000000';
      html += _propRow('Border',
        `<input type="color" value="${sc}" data-prop="textBorderColor" class="prop-input prop-color" id="text-stroke-color">` +
        _propSlider('textBorderWidth', 0, 10, 0.5, sw, { scale: 1, decimals: 1 })
      );
    }

    if (DM.Config.BORDER_TYPES.has(el.type)) {
      const def = DM.Config.BORDER_DEFAULTS[el.type] || { color: '#0a0300', width: 1.5 };
      const bCol = el.borderColor ?? def.color;
      const bWid = el.borderWidth ?? def.width;
      html += _propRow('Border',
        `<input type="color" value="${bCol}" data-prop="borderColor" class="prop-input prop-color">` +
        _propSlider('borderWidth', 0, 10, 0.5, bWid, { scale: 1, decimals: 1 })
      );
    }

    if (el.type === 'wall') {
      const wid = el.borderWidth ?? DM.Config.BORDER_DEFAULTS.wall.width;
      html += _propRow('Width', _propSlider('borderWidth', 0.5, 12, 0.5, wid, { scale: 1, decimals: 1 }));
    }

    if (el.type === 'room' || el.type === 'wall') {
      const rough = el.borderRough ?? 0.4;
      html += _propRow('Roughness', _propSlider('borderRough', 0, 1, 0.05, rough, { scale: 100, decimals: 0, unit: '%' }));
    }

    if (el.type === 'room') {
      const sStyle = el.stoneStyle || 'none';
      const sInt   = el.stoneIntensity ?? 0.5;
      html += `<div class="prop-sep"></div>`;
      html += _propRow('Stone',
        `<div class="brush-shape-row">` +
        `<button class="brush-opt-btn prop-stone-style${sStyle === 'none' ? ' active' : ''}" data-stone="none">None</button>` +
        `<button class="brush-opt-btn prop-stone-style${sStyle === 'ink'  ? ' active' : ''}" data-stone="ink">✦ Ink</button>` +
        `</div>`
      );
      if (sStyle === 'ink') {
        html += _propRow('Intensity', _propSlider('stoneIntensity', 0.05, 1, 0.05, sInt, { scale: 100, decimals: 0, unit: '%' }));
      }
    }

    if (el.type === 'door') {
      html += `<button class="prop-reset-btn" id="flip-door">${el.flipped ? '⟵ Normal' : '⟶ Flip'}</button>`;
    }

    if (el.type === 'torch' || el.type === 'magic' || el.type === 'portal' || el.type === 'fog') {
      html += _propRow('',
        `<label class="prop-check"><input type="checkbox" data-prop="animated" ${el.animated ? 'checked' : ''}> Animate</label>`
      );
      if (el.type === 'fog' && el.animated) {
        html += _propRow('Anim speed',
          _propSlider('animSpeed', 0, 2.5, 0.05, el.animSpeed ?? 1, { scale: 1, decimals: 2, unit: '×' }));
      }
    }

    if (el.type !== 'text') {
      html += _propRow('Physical',
        `<label class="prop-check"><input type="checkbox" data-prop="physical" ${el.physical ? 'checked' : ''}> VTT obstacle</label>`
      );
    }

    const lt    = el.light;
    const ltOn  = !!lt;
    html += `<div class="prop-sep"></div>`;
    html += _propRow('Light',
      `<label class="prop-check"><input type="checkbox" data-prop="lightEnabled" ${ltOn ? 'checked' : ''}> Light source</label>`
    );
    if (ltOn) {
      const ltR      = lt.radius  ?? 3;
      const ltC      = lt.color   || '#ffaa44';
      const ltOpNum  = lt.opacity ?? 0.8;
      const ltOp     = ltOpNum.toFixed(2);
      html += _propRow('Radius', _propSlider('lightRadius', 0.5, 20, 0.5, ltR, { scale: 1, decimals: 1 }));
      html += _propRow('',
        `<input type="color" value="${ltC}" data-prop="lightColor" class="prop-input prop-color">` +
        _propSlider('lightOpacity', 0.1, 1, 0.05, ltOpNum, { scale: 100, decimals: 0, unit: '%' })
      );
    }

    html += `<div class="prop-sep"></div>`;
    html += `<button class="prop-reset-btn" id="duplicate-el" style="color:var(--accent2)">⧉ Duplicate <span style="opacity:.5;font-size:.85em">Ctrl+D</span></button>`;
    if (el.type !== 'image') {
      html += `<button class="prop-reset-btn" id="reset-color">Reset colors</button>`;
    }

    popup.innerHTML = html;
    _wireSliders(popup);
    popup.classList.remove('hidden');

    if (DM.Config.FLOOR_TYPES.has(el.type)) {
      const _floodFillFloor = (patch) => {
        const st    = DM.State.current;
        const cells = DM.buildCellGrid(st.elements);
        let startKey = null;
        for (const [key, cellEl] of Object.entries(cells)) {
          if (cellEl === el) { startKey = key; break; }
        }
        if (!startKey) { Object.assign(el, patch); DM.Renderer.render(); return; }
        DM.State.saveHistory();
        const visited = new Set();
        const queue   = [startKey];
        while (queue.length) {
          const key = queue.shift();
          if (visited.has(key)) continue;
          visited.add(key);
          const cellEl = cells[key];
          if (!cellEl) continue;
          Object.assign(cellEl, patch);
          const [cx, cy] = key.split(',').map(Number);
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const nk = `${cx+dx},${cy+dy}`;
            if (!visited.has(nk) && cells[nk]) queue.push(nk);
          }
        }
        DM.Renderer.render();
      };

      const buildFloorAssets = () => {
        const thumbs   = popup.querySelector('#popup-floor-thumbs');
        const search   = popup.querySelector('#popup-floor-search');
        const scaleRow = popup.querySelector('#popup-floor-scale-row');
        if (!thumbs) return;
        const term        = (search?.value || '').trim().toLowerCase();
        const catMap      = _buildCatNameMap();
        const validAssets = DM.State.current.assets.filter(_isValidAsset);
        const visible     = term
          ? validAssets.filter(a => {
              const cn = (catMap[String(a.categoryId)] || '').toLowerCase();
              return a.name.toLowerCase().includes(term) || cn.includes(term);
            })
          : validAssets;

        thumbs.innerHTML = '';
        const setActive = b => thumbs.querySelectorAll('.bp-asset-thumb-btn')
          .forEach(x => x.classList.toggle('active', x === b));

        const noneBtn = document.createElement('button');
        noneBtn.className = 'bp-asset-thumb-btn' + (el.fillAssetId == null ? ' active' : '');
        noneBtn.title = 'None (use color)';
        noneBtn.textContent = '✕';
        noneBtn.addEventListener('click', () => {
          _floodFillFloor({ fillAssetId: null });
          if (scaleRow) scaleRow.hidden = true;
          setActive(noneBtn);
        });
        thumbs.appendChild(noneBtn);

        for (const asset of visible) {
          const btn = document.createElement('button');
          btn.className = 'bp-asset-thumb-btn' + (String(el.fillAssetId) === String(asset.id) ? ' active' : '');
          btn.title = asset.name;
          if (asset._img) {
            const thumb = document.createElement('canvas');
            thumb.width = thumb.height = 30;
            thumb.getContext('2d').drawImage(asset._img, 0, 0, 30, 30);
            btn.appendChild(thumb);
          } else {
            btn.textContent = (asset.name || '?').substring(0, 3);
          }
          btn.addEventListener('click', () => {
            _floodFillFloor({ fillAssetId: asset.id });
            if (scaleRow) scaleRow.hidden = false;
            setActive(btn);
          });
          thumbs.appendChild(btn);
        }
      };

      popup.querySelector('#popup-floor-search')?.addEventListener('input', buildFloorAssets);
      buildFloorAssets();

      popup.querySelector('#popup-floor-scale')?.addEventListener('input', function () {
        _floodFillFloor({ fillAssetScale: +this.value });
      });
    }

    popup.querySelectorAll('.prop-align-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        DM.State.updateElement(idx, { align: btn.dataset.align });
        popup.querySelectorAll('.prop-align-btn').forEach(b => b.classList.toggle('active', b === btn));
        DM.Renderer.render();
      });
    });

    if (el.type === 'door') {
      const buildDoorStrip = () => {
        const thumbsDiv = popup.querySelector('#popup-door-thumbs');
        const searchInp = popup.querySelector('#popup-door-search');
        if (!thumbsDiv) return;
        const term        = (searchInp?.value || '').trim().toLowerCase();
        const catMap      = _buildCatNameMap();
        const validAssets = DM.State.current.assets.filter(_isValidAsset);
        const visible     = term
          ? validAssets.filter(a => {
              const cn = (catMap[String(a.categoryId)] || '').toLowerCase();
              return a.name.toLowerCase().includes(term) || cn.includes(term);
            })
          : validAssets;

        thumbsDiv.innerHTML = '';
        const setActive = b => thumbsDiv.querySelectorAll('.bp-asset-thumb-btn')
          .forEach(x => x.classList.toggle('active', x === b));

        const noneBtn = document.createElement('button');
        noneBtn.className = 'bp-asset-thumb-btn' + (el.assetId == null ? ' active' : '');
        noneBtn.title = 'Standard door (drawn)';
        noneBtn.textContent = '🚪';
        noneBtn.addEventListener('click', () => {
          DM.State.updateElement(idx, { assetId: null, h: Math.round(DM.State.current.cellSize * 0.25) });
          setActive(noneBtn);
          DM.Renderer.render();
        });
        thumbsDiv.appendChild(noneBtn);

        for (const asset of visible) {
          const btn = document.createElement('button');
          btn.className = 'bp-asset-thumb-btn' + (String(el.assetId) === String(asset.id) ? ' active' : '');
          btn.title = asset.name;
          if (asset._img) {
            const thumb = document.createElement('canvas');
            thumb.width = thumb.height = 30;
            thumb.getContext('2d').drawImage(asset._img, 0, 0, 30, 30);
            btn.appendChild(thumb);
          } else {
            btn.textContent = (asset.name || '?').substring(0, 3);
          }
          btn.addEventListener('click', () => {
            const img  = asset._img;
            const w    = el.w || DM.State.current.cellSize;
            const newH = img ? Math.round(w * img.height / img.width) : w;
            DM.State.updateElement(idx, { assetId: asset.id, h: newH });
            setActive(btn);
            DM.Renderer.render();
          });
          thumbsDiv.appendChild(btn);
        }
      };
      popup.querySelector('#popup-door-search')?.addEventListener('input', buildDoorStrip);
      buildDoorStrip();
    }

    const closeBtn = popup.querySelector('#popup-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        DM.State.current.selectedIdx = -1;
        hidePopup();
        DM.Renderer.render();
      });
    }

    popup.querySelectorAll('[data-prop]').forEach(input => {
      const prop = input.dataset.prop;
      const handler = () => {
        let val;
        if (input.type === 'checkbox') val = input.checked;
        else if (input.type === 'range' || input.type === 'number') val = +input.value;
        else val = input.value; // color, text, textarea

        if (prop === 'textW') {
          DM.State.updateElement(idx, { w: Math.max(40, Math.min(800, Math.round(val) || 120)) });
        } else if (prop === 'textBorderColor') {
          DM.State.updateElement(idx, { borderColor: val });
        } else if (prop === 'textBorderWidth') {
          DM.State.updateElement(idx, { borderWidth: val });
        } else if (prop === 'textBgColor') {
          DM.State.updateElement(idx, { bgColor: val });
        } else if (prop === 'doorCells') {
          const cs2    = DM.State.current.cellSize;
          const cells2 = Math.max(1, Math.round(+input.value));
          const newW   = cells2 * cs2;
          const dimg   = el.assetId ? DM.State.getAsset(el.assetId)?._img : null;
          const newH   = dimg ? Math.round(newW * dimg.height / dimg.width) : Math.round(cs2 * 0.25);
          DM.State.updateElement(idx, { w: newW, h: newH });
        } else if (prop === 'posX') {
          if (el.type === 'fog') {
            const r = DM.elementRect(el);
            DM.State.updateElement(idx, { x: (el.x || 0) + (+input.value - r.x) });
          } else {
            DM.State.updateElement(idx, { x: +input.value });
          }
        } else if (prop === 'posY') {
          if (el.type === 'fog') {
            const r = DM.elementRect(el);
            DM.State.updateElement(idx, { y: (el.y || 0) + (+input.value - r.y) });
          } else {
            DM.State.updateElement(idx, { y: +input.value });
          }
        } else if (prop === 'rotDeg') {
          DM.State.updateElement(idx, { rotation: val * Math.PI / 180 });
        } else if (prop === 'scale') {
          DM.State.updateElement(idx, { scale: val });
        } else if (prop === 'opacity') {
          DM.State.updateElement(idx, { opacity: val });
          if (el.type === 'room') _propagateConnected(el, { opacity: val });
        } else if (prop === 'borderWidth') {
          DM.State.updateElement(idx, { borderWidth: val });
          if (el.type === 'room') _propagateConnected(el, { borderWidth: val });
        } else if (prop === 'borderRough') {
          DM.State.updateElement(idx, { borderRough: val });
          if (el.type === 'room') _propagateConnected(el, { borderRough: val });
        } else if (prop === 'stoneIntensity') {
          DM.State.updateElement(idx, { stoneIntensity: val });
          _propagateConnected(el, { stoneIntensity: val });
        } else if (prop === 'w') {
          if (DM.Config.POINT_TOOLS.has(el.type)) {
            DM.State.updateElement(idx, { w: Math.max(1, +input.value) });
          } else {
            const r = DM.elementRect(el);
            DM.State.updateElement(idx, { w: Math.max(1, +input.value), x: r.x });
          }
        } else if (prop === 'h') {
          if (DM.Config.POINT_TOOLS.has(el.type)) {
            DM.State.updateElement(idx, { h: Math.max(1, +input.value) });
          } else {
            const r = DM.elementRect(el);
            DM.State.updateElement(idx, { h: Math.max(1, +input.value), y: r.y });
          }
        } else if (prop === 'color' && el.type === 'room') {
          DM.State.updateElement(idx, { color: val });
          _propagateConnected(el, { color: val });
        } else if (prop === 'borderColor' && el.type === 'room') {
          DM.State.updateElement(idx, { borderColor: val });
          _propagateConnected(el, { borderColor: val });
        } else if (prop === 'lightEnabled') {
          const cur = el.light;
          DM.State.updateElement(idx, {
            light: val ? { radius: cur?.radius ?? 3, color: cur?.color || '#ffaa44', opacity: cur?.opacity ?? 0.8 } : null,
          });
          updateProperties();
        } else if (prop === 'lightRadius') {
          DM.State.updateElement(idx, { light: { ...el.light, radius: val } });
        } else if (prop === 'lightColor') {
          DM.State.updateElement(idx, { light: { ...el.light, color: val } });
        } else if (prop === 'lightOpacity') {
          DM.State.updateElement(idx, { light: { ...el.light, opacity: val } });
        } else if (prop === 'animated') {
          DM.State.updateElement(idx, { animated: val });
          if (val) DM.Renderer.startDecalAnim();
          if (el.type === 'fog') updateProperties();  // show/hide the speed slider
        } else {
          DM.State.updateElement(idx, { [prop]: val });
        }
        DM.Renderer.render();
      };

      if (input.type === 'checkbox') {
        input.addEventListener('change', handler);
      } else {
        input.addEventListener('input', handler);
        if (input.type === 'number') input.addEventListener('change', handler);
      }
    });

    popup.querySelectorAll('.prop-room-shape').forEach(btn => {
      btn.addEventListener('click', () => {
        const shape = btn.dataset.shape === 'circle' ? 'circle' : undefined;
        DM.State.saveHistory();
        DM.State.updateElement(idx, { shape });
        updateProperties();
        DM.Renderer.render();
      });
    });

    popup.querySelectorAll('.prop-stone-style').forEach(btn => {
      btn.addEventListener('click', () => {
        const style = btn.dataset.stone === 'ink' ? 'ink' : undefined;
        DM.State.updateElement(idx, { stoneStyle: style });
        _propagateConnected(el, { stoneStyle: style });
        updateProperties();
        DM.Renderer.render();
      });
    });

    const flipBtn = popup.querySelector('#flip-door');
    if (flipBtn) {
      flipBtn.addEventListener('click', () => {
        DM.State.updateElement(idx, { flipped: !el.flipped });
        updateProperties();
        DM.Renderer.render();
      });
    }

    const toggleBgBtn = popup.querySelector('#toggle-text-bg');
    if (toggleBgBtn) {
      toggleBgBtn.addEventListener('click', () => {
        const newBg = el.bgColor != null
          ? null
          : (popup.querySelector('#text-bg-color')?.value || '#fffff0');
        DM.State.updateElement(idx, { bgColor: newBg });
        updateProperties();
        DM.Renderer.render();
      });
    }

    popup.querySelector('#duplicate-el')?.addEventListener('click', () => {
      DM.Tools.duplicate();
    });

    const resetBtn = popup.querySelector('#reset-color');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        const patch = { color: null, borderColor: null, borderWidth: null };
        if (el.type === 'text') patch.bgColor = null;
        DM.State.updateElement(idx, patch);
        if (el.type === 'room') _propagateConnected(el, { color: null, borderColor: null, borderWidth: null });
        updateProperties();
        DM.Renderer.render();
      });
    }

    requestAnimationFrame(positionPopup);
  }

  function _propRow(label, inputHtml) {
    return `<div class="prop-row">
      ${label ? `<label class="prop-label">${label}</label>` : ''}
      <div class="prop-ctrl">${inputHtml}</div>
    </div>`;
  }

  function _propSlider(dataProp, min, max, step, value, opts = {}) {
    const scale = opts.scale    ?? 1;
    const dec   = opts.decimals ?? 0;
    const unit  = opts.unit     ?? '';
    const dv    = +(value * scale).toFixed(dec);
    const dMin  = +(min   * scale).toFixed(dec);
    const dMax  = +(max   * scale).toFixed(dec);
    const dStep = +(step  * scale).toFixed(dec);
    return `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}"` +
           ` data-prop="${dataProp}" data-sid="${dataProp}" data-scale="${scale}" data-dec="${dec}" class="prop-input">` +
           `<input type="number" min="${dMin}" max="${dMax}" step="${dStep}" value="${dv}"` +
           ` data-sid-n="${dataProp}" class="prop-val-input">` +
           (unit ? `<span class="prop-unit">${unit}</span>` : '');
  }

  function _wireSliders(popup) {
    popup.querySelectorAll('input[data-sid]').forEach(range => {
      const sid   = range.dataset.sid;
      const num   = popup.querySelector(`[data-sid-n="${sid}"]`);
      if (!num) return;

      const scale = parseFloat(range.dataset.scale) || 1;
      const dec   = parseInt(range.dataset.dec, 10)  || 0;

      range.addEventListener('input', () => {
        num.value = +(+range.value * scale).toFixed(dec);
      });

      const syncFromNum = () => {
        const raw      = parseFloat(num.value);
        if (isNaN(raw)) return;
        const internal = raw / scale;
        const clamped  = Math.min(parseFloat(range.max), Math.max(parseFloat(range.min), internal));
        num.value   = +(clamped * scale).toFixed(dec);
        range.value = clamped;
        range.dispatchEvent(new Event('input', { bubbles: true }));
      };

      num.addEventListener('change', syncFromNum);
      num.addEventListener('blur',   syncFromNum);
      num.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); syncFromNum(); } });
    });
  }

  function _typeLabel(type) {
    const labels = {
      room:'Room', water:'Water', pit:'Pit', stairs:'Stairs', secret:'Secret Passage',
      door:'Door',
      pillar:'Pillar', torch:'Torch', chest:'Chest', sarcophagus:'Sarcophagus',
      altar:'Altar', trap:'Trap', magic:'Magic Circle', portal:'Portal', wall:'Wall',
      stalactite:'Stalactites', rubble:'Rubble', fog:'Fog',
      text:'Text', image:'Image',
    };
    return labels[type] || type;
  }

  function _defaultColor(type) {
    const map = {
      room: '#eedfa0', water: '#3e91d0', pit: '#0c0500',
      trap: '#8b0000', magic: '#af5fff', text: '#2c1810', wall: '#0a0200',
      fog: '#cdd4e1',
    };
    return map[type] || '#c8a870';
  }

  function _escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function hideMultiPopup() {
    const popup = document.getElementById('multi-popup');
    if (popup) popup.classList.add('hidden');
  }

  function positionMultiPopup() {
    const popup = document.getElementById('multi-popup');
    if (!popup || popup.classList.contains('hidden')) return;

    const st   = DM.State.current;
    const ms   = st.multiSelectedSet;
    const area = document.getElementById('canvas-area');
    if (!area || ms.size < 2) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const idx of ms) {
      if (idx < 0 || idx >= st.elements.length) continue;
      const r = DM.elementRect(st.elements[idx]);
      if (r.x           < minX) minX = r.x;
      if (r.y           < minY) minY = r.y;
      if (r.x + r.w > maxX) maxX = r.x + r.w;
      if (r.y + r.h > maxY) maxY = r.y + r.h;
    }

    const zoom = st.zoom;
    let left = maxX * zoom - area.scrollLeft + 14;
    let top  = minY * zoom - area.scrollTop;

    const areaW = area.clientWidth;
    const areaH = area.clientHeight;
    const pw    = popup.offsetWidth  || 208;
    const ph    = popup.offsetHeight || 170;

    if (left + pw > areaW - 6) left = minX * zoom - area.scrollLeft - pw - 14;
    left = Math.max(4, Math.min(left, areaW - pw - 4));
    top  = Math.max(4, Math.min(top,  areaH - ph - 4));

    popup.style.left = `${left}px`;
    popup.style.top  = `${top}px`;
  }

  function _multiRotateEl(el, stepsCW) {
    const cs = DM.State.current.cellSize;
    const isPoint = DM.Config.POINT_TOOLS.has(el.type);
    if (isPoint || el.type === 'text' || el.type === 'image') {
      el.rotation = ((el.rotation || 0) + stepsCW * Math.PI / 2 + Math.PI * 8) % (Math.PI * 2);
    } else {
      const n = ((stepsCW % 4) + 4) % 4;
      for (let i = 0; i < n; i++) {
        const { x, y, w, h } = DM.normalizeRect(el.x, el.y, el.w, el.h);
        const cx = x + w / 2, cy = y + h / 2;
        el.x = Math.round((cx - h / 2) / cs) * cs;
        el.y = Math.round((cy - w / 2) / cs) * cs;
        el.w = h; el.h = w;
      }
      if (el.type === 'stairs') {
        el.rotation = ((el.rotation || 0) + stepsCW * Math.PI / 2) % (Math.PI * 2);
      }
    }
  }

  function _multiScaleEl(el, factor) {
    if (el.type === 'brush') return;
    if (el.type === 'text') {
      el.fontSize = Math.max(6, Math.round((el.fontSize || 18) * factor));
      return;
    }
    if (!el.w || !el.h) return; // legacy point without dimensions
    const r  = DM.elementRect(el);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const nw = Math.max(1, Math.round(r.w * factor));
    const nh = Math.max(1, Math.round(r.h * factor));
    if (DM.Config.POINT_TOOLS.has(el.type)) {
      el.w = nw; el.h = nh;
    } else {
      el.w = nw; el.h = nh;
      el.x = Math.round(cx - nw / 2);
      el.y = Math.round(cy - nh / 2);
    }
  }

  function _setElLeft(el, newLeft) {
    const isPoint = DM.Config.POINT_TOOLS.has(el.type) && el.w;
    el.x = Math.round(isPoint ? newLeft + el.w / 2 : newLeft);
  }
  function _setElTop(el, newTop) {
    const isPoint = DM.Config.POINT_TOOLS.has(el.type) && el.h;
    el.y = Math.round(isPoint ? newTop + el.h / 2 : newTop);
  }

  function _handleAlignAction(action) {
    if (action === 'duplicate') { DM.Tools.duplicate(); return; }

    const st = DM.State.current;
    DM.State.saveHistory();

    const indices = [...st.multiSelectedSet].filter(i => i >= 0 && i < st.elements.length);
    if (indices.length < 2) return;

    const items = indices.map(i => ({ el: st.elements[i], r: DM.elementRect(st.elements[i]) }));

    switch (action) {
      case 'align-left': {
        const target = Math.min(...items.map(o => o.r.x));
        for (const { el } of items) _setElLeft(el, target);
        break;
      }
      case 'align-right': {
        const target = Math.max(...items.map(o => o.r.x + o.r.w));
        for (const { el, r } of items) _setElLeft(el, target - r.w);
        break;
      }
      case 'align-top': {
        const target = Math.min(...items.map(o => o.r.y));
        for (const { el } of items) _setElTop(el, target);
        break;
      }
      case 'align-bottom': {
        const target = Math.max(...items.map(o => o.r.y + o.r.h));
        for (const { el, r } of items) _setElTop(el, target - r.h);
        break;
      }
      case 'align-centerH': {
        const target = items.reduce((s, o) => s + o.r.x + o.r.w / 2, 0) / items.length;
        for (const { el, r } of items) _setElLeft(el, target - r.w / 2);
        break;
      }
      case 'align-centerV': {
        const target = items.reduce((s, o) => s + o.r.y + o.r.h / 2, 0) / items.length;
        for (const { el, r } of items) _setElTop(el, target - r.h / 2);
        break;
      }
      case 'distrib-h': {
        const sorted       = [...items].sort((a, b) => a.r.x - b.r.x);
        const spanLeft     = sorted[0].r.x;
        const spanRight    = sorted.at(-1).r.x + sorted.at(-1).r.w;
        const totalWidth   = sorted.reduce((s, o) => s + o.r.w, 0);
        const gap          = (spanRight - spanLeft - totalWidth) / (sorted.length - 1);
        let cursor         = spanLeft;
        for (const { el, r } of sorted) { _setElLeft(el, cursor); cursor += r.w + gap; }
        break;
      }
      case 'distrib-v': {
        const sorted       = [...items].sort((a, b) => a.r.y - b.r.y);
        const spanTop      = sorted[0].r.y;
        const spanBottom   = sorted.at(-1).r.y + sorted.at(-1).r.h;
        const totalHeight  = sorted.reduce((s, o) => s + o.r.h, 0);
        const gap          = (spanBottom - spanTop - totalHeight) / (sorted.length - 1);
        let cursor         = spanTop;
        for (const { el, r } of sorted) { _setElTop(el, cursor); cursor += r.h + gap; }
        break;
      }
      case 'rotate-cw90':  { for (const { el } of items) _multiRotateEl(el,  1); break; }
      case 'rotate-ccw90': { for (const { el } of items) _multiRotateEl(el, -1); break; }
      case 'scale-50':     { for (const { el } of items) _multiScaleEl(el, 0.50); break; }
      case 'scale-75':     { for (const { el } of items) _multiScaleEl(el, 0.75); break; }
      case 'scale-125':    { for (const { el } of items) _multiScaleEl(el, 1.25); break; }
      case 'scale-200':    { for (const { el } of items) _multiScaleEl(el, 2.00); break; }
    }

    DM.Renderer.render();
    requestAnimationFrame(positionMultiPopup);
  }

  function updateMultiSelectPopup() {
    const popup = document.getElementById('multi-popup');
    if (!popup) return;

    const st = DM.State.current;
    const ms = st.multiSelectedSet;

    if (ms.size < 2 || st.tool !== 'select') {
      hideMultiPopup();
      return;
    }

    popup.innerHTML = `
      <div class="mp-header">
        <span>${ms.size} selected</span>
        <button class="popup-close" id="mp-close">✕</button>
      </div>
      <div class="mp-section-label">Align</div>
      <div class="mp-grid">
        <button class="mp-btn" data-action="align-left"    title="Align left edges">← Left</button>
        <button class="mp-btn" data-action="align-centerH" title="Center horizontally">⬥ H</button>
        <button class="mp-btn" data-action="align-right"   title="Align right edges">Right →</button>
        <button class="mp-btn" data-action="align-top"     title="Align top edges">↑ Top</button>
        <button class="mp-btn" data-action="align-centerV" title="Center vertically">⬥ V</button>
        <button class="mp-btn" data-action="align-bottom"  title="Align bottom edges">Btm ↓</button>
      </div>
      <div class="mp-section-label">Distribute</div>
      <div class="mp-grid mp-grid-2">
        <button class="mp-btn" data-action="distrib-h" title="Space elements equally on X axis">↔ Space X</button>
        <button class="mp-btn" data-action="distrib-v" title="Space elements equally on Y axis">↕ Space Y</button>
      </div>
      <div class="mp-section-label">Rotate</div>
      <div class="mp-grid mp-grid-2">
        <button class="mp-btn" data-action="rotate-ccw90" title="Rotate 90° counter-clockwise">↺ 90°</button>
        <button class="mp-btn" data-action="rotate-cw90"  title="Rotate 90° clockwise">↻ 90°</button>
      </div>
      <div class="mp-section-label">Scale</div>
      <div class="mp-grid">
        <button class="mp-btn" data-action="scale-50"  title="Scale down to 50%">×½</button>
        <button class="mp-btn" data-action="scale-75"  title="Scale down to 75%">×¾</button>
        <button class="mp-btn" data-action="scale-125" title="Scale up to 125%">×1¼</button>
        <button class="mp-btn" data-action="scale-200" title="Scale up to 200%">×2</button>
      </div>
      <div class="mp-section-label">Actions</div>
      <div class="mp-grid mp-grid-2">
        <button class="mp-btn" data-action="duplicate" title="Duplicate selection (Ctrl+D)" style="grid-column:1/-1">⧉ Duplicate</button>
      </div>
    `;

    popup.classList.remove('hidden');

    popup.querySelector('#mp-close').addEventListener('click', () => {
      st.multiSelectedSet.clear();
      st.selectedIdx = -1;
      hideMultiPopup();
      updateProperties();
      DM.Renderer.render();
    });

    popup.querySelectorAll('.mp-btn').forEach(btn => {
      btn.addEventListener('click', () => _handleAlignAction(btn.dataset.action));
    });

    requestAnimationFrame(positionMultiPopup);
  }

  function updateLayersPanel() {
    const panel = document.getElementById('layers-content');
    if (!panel) return;
    const st = DM.State.current;

    let html = '';
    for (let i = st.layers.length - 1; i >= 0; i--) {
      const layer    = st.layers[i];
      const isActive = (i === st.activeLayerIdx);
      const lockIcon = layer.locked  ? '🔒' : '🔓';
      const eyeIcon  = layer.visible ? '👁' : '🚫';
      html += `
        <div class="layer-row${isActive ? ' layer-active' : ''}" data-idx="${i}">
          <button class="layer-btn layer-eye"  data-action="eye"  data-idx="${i}" title="Toggle visibility">${eyeIcon}</button>
          <button class="layer-btn layer-lock" data-action="lock" data-idx="${i}" title="${layer.locked ? 'Unlock' : 'Lock'}">${lockIcon}</button>
          <span class="layer-name" data-idx="${i}">${_escHtml(layer.name)}</span>
          <div class="layer-actions">
            <button class="layer-btn" data-action="rename" data-idx="${i}" title="Rename">✏</button>
            <button class="layer-btn" data-action="up"     data-idx="${i}" title="Move up"   ${i === st.layers.length - 1 ? 'disabled' : ''}>↑</button>
            <button class="layer-btn" data-action="down"   data-idx="${i}" title="Move down" ${i === 0 ? 'disabled' : ''}>↓</button>
            <button class="layer-btn layer-del" data-action="del" data-idx="${i}" title="Delete layer" ${st.layers.length <= 1 ? 'disabled' : ''}>✕</button>
          </div>
        </div>`;
    }

    panel.innerHTML = `
      <div id="layers-list">${html}</div>
      <button class="btn full-width" id="btn-add-layer">+ New Layer</button>
    `;

    panel.querySelectorAll('.layer-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.layer-btn')) return;
        const idx = parseInt(row.dataset.idx, 10);
        DM.State.setActiveLayer(idx);
        updateLayersPanel();
        DM.Renderer.render();
        updateProperties();
      });
    });

    panel.querySelectorAll('.layer-btn[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        const idx    = parseInt(btn.dataset.idx, 10);

        if (action === 'rename') {
          const span = panel.querySelector(`.layer-name[data-idx="${idx}"]`);
          if (span) _startLayerRename(span, st);
        } else if (action === 'eye') {
          DM.State.toggleLayerVisibility(idx);
          DM.Renderer.render();
          updateLayersPanel();
        } else if (action === 'lock') {
          DM.State.toggleLayerLocked(idx);
          updateLayersPanel();
        } else if (action === 'up') {
          DM.State.moveLayerDown(idx);   // higher index = visually higher = on top
          updateLayersPanel();
          DM.Renderer.render();
        } else if (action === 'down') {
          DM.State.moveLayerUp(idx);     // lower index = visually lower = underneath
          updateLayersPanel();
          DM.Renderer.render();
        } else if (action === 'del') {
          if (st.layers.length <= 1) return;
          if (!confirm(`Delete layer "${st.layers[idx].name}"? This cannot be undone.`)) return;
          DM.State.removeLayer(idx);
          updateLayersPanel();
          DM.Renderer.render();
          updateProperties();
        }
      });
    });

    panel.querySelectorAll('.layer-name').forEach(span => {
      span.addEventListener('dblclick', () => _startLayerRename(span, st));
    });

    const addBtn = panel.querySelector('#btn-add-layer');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        DM.State.addLayer();
        DM.State.setActiveLayer(st.layers.length - 1);
        updateLayersPanel();
        DM.Renderer.render();
      });
    }
  }

  function _startLayerRename(span, st) {
    const idx   = parseInt(span.dataset.idx, 10);
    const layer = st.layers[idx];
    const inp   = document.createElement('input');
    inp.type      = 'text';
    inp.value     = layer.name;
    inp.className = 'prop-input';
    inp.style.cssText = 'width:100%;padding:1px 4px;font-size:10px;height:20px;';
    span.replaceWith(inp);
    inp.focus(); inp.select();
    const commit = () => {
      const newName = inp.value.trim() || layer.name;
      DM.State.renameLayer(idx, newName);
      updateLayersPanel();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') updateLayersPanel();
    });
  }

  function initRoomPanel() {
    const panel = document.getElementById('room-details');
    if (!panel) return;

    panel.innerHTML = `
      <div class="opt-row">
        <span class="opt-label">Shape</span>
        <div class="opt-ctrl brush-shape-row">
          <button class="brush-opt-btn active" data-shape="rect">▭ Rect</button>
          <button class="brush-opt-btn"        data-shape="circle">◯ Circle</button>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Style</span>
        <div class="opt-ctrl brush-shape-row">
          <button class="brush-opt-btn active" data-room-style="none">Normal</button>
          <button class="brush-opt-btn"        data-room-style="ink">✦ Ink</button>
        </div>
      </div>`;

    panel.querySelectorAll('[data-shape]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.shape === (DM.State.current.roomShape || 'rect'));
      btn.addEventListener('click', () => {
        DM.State.current.roomShape = btn.dataset.shape;
        panel.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    panel.querySelectorAll('[data-room-style]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.roomStyle === (DM.State.current.roomStoneStyle || 'none'));
      btn.addEventListener('click', () => {
        DM.State.current.roomStoneStyle = btn.dataset.roomStyle === 'ink' ? 'ink' : undefined;
        panel.querySelectorAll('[data-room-style]').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
  }

  function initBrushPanel() {
    const panel = document.getElementById('brush-details');
    if (!panel) return;

    const st = DM.State.current;

    panel.innerHTML = `
      <div class="opt-row" id="bp-color-row">
        <span class="opt-label">Color</span>
        <div class="opt-ctrl">
          <input type="color" id="bp-color" value="${st.brushColor || '#8b7355'}">
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Texture</span>
        <div class="opt-ctrl" style="flex-direction:column;gap:4px">
          <input type="text" id="bp-asset-search" placeholder="Search…" class="asset-search-input">
          <div id="bp-assets" class="bp-asset-strip"></div>
        </div>
      </div>
      <div class="opt-row" id="bp-scale-row"${st.brushAssetId ? '' : ' hidden'}>
        <span class="opt-label">Tile size</span>
        <div class="opt-ctrl">
          <input type="range" id="bp-asset-scale" min="0.1" max="4" step="0.1" value="${st.brushAssetScale ?? 1}" style="flex:1">
          <span id="bp-asset-scale-val" class="prop-val">${Math.round((st.brushAssetScale ?? 1) * 100)}%</span>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Shape</span>
        <div class="opt-ctrl brush-shape-row">
          <button class="brush-opt-btn active" data-shape="round">Round</button>
          <button class="brush-opt-btn"        data-shape="square">Square</button>
          <button class="brush-opt-btn"        data-shape="soft">Soft</button>
          <button class="brush-opt-btn"        data-shape="cave">Cave</button>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Size</span>
        <div class="opt-ctrl">
          <input type="range" id="bp-size" min="4" max="120" step="1" value="${st.brushSize || 20}" style="flex:1">
          <span id="bp-size-val" class="prop-val">${st.brushSize || 20}px</span>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Opacity</span>
        <div class="opt-ctrl">
          <input type="range" id="bp-opacity" min="0.05" max="1" step="0.05" value="${st.brushOpacity ?? 1}" style="flex:1">
          <span id="bp-opacity-val" class="prop-val">${Math.round((st.brushOpacity ?? 1) * 100)}%</span>
        </div>
      </div>
      <div id="bp-cave-rows"${st.brushShape === 'cave' ? '' : ' hidden'}>
        <div class="opt-row">
          <span class="opt-label">Roughness</span>
          <div class="opt-ctrl">
            <input type="range" id="bp-cave-rough" min="0" max="1" step="0.05" value="${st.brushBorderRough ?? 0.5}" style="flex:1">
            <span id="bp-cave-rough-val" class="prop-val">${Math.round((st.brushBorderRough ?? 0.5) * 100)}%</span>
          </div>
        </div>
        <div class="opt-row">
          <span class="opt-label">Edge color</span>
          <div class="opt-ctrl">
            <input type="color" id="bp-cave-color" value="${st.brushBorderColor || '#2a2a2a'}">
          </div>
        </div>
        <div class="opt-row">
          <span class="opt-label">Edge width</span>
          <div class="opt-ctrl">
            <input type="range" id="bp-cave-width" min="0" max="12" step="0.5" value="${st.brushBorderWidth ?? 0}" style="flex:1">
            <span id="bp-cave-width-val" class="prop-val">${st.brushBorderWidth ?? 0}px</span>
          </div>
        </div>
      </div>`;

    panel.querySelector('#bp-color').addEventListener('input', function () {
      DM.State.current.brushColor = this.value;
      DM.Renderer.render();
    });

    panel.querySelectorAll('[data-shape]').forEach(btn => {
      btn.addEventListener('click', () => {
        DM.State.current.brushShape = btn.dataset.shape;
        panel.querySelectorAll('[data-shape]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        const caveRows = panel.querySelector('#bp-cave-rows');
        if (caveRows) caveRows.hidden = btn.dataset.shape !== 'cave';
        DM.Renderer.render();
      });
    });

    panel.querySelector('#bp-size').addEventListener('input', function () {
      DM.State.current.brushSize = +this.value;
      panel.querySelector('#bp-size-val').textContent = `${this.value}px`;
      DM.Renderer.render();
    });

    panel.querySelector('#bp-opacity').addEventListener('input', function () {
      DM.State.current.brushOpacity = +this.value;
      panel.querySelector('#bp-opacity-val').textContent = `${Math.round(this.value * 100)}%`;
      DM.Renderer.render();
    });

    panel.querySelector('#bp-asset-search').addEventListener('input', refreshBrushAssets);

    panel.querySelector('#bp-asset-scale').addEventListener('input', function () {
      const st    = DM.State.current;
      const scale = +this.value;
      st.brushAssetScale = scale;
      panel.querySelector('#bp-asset-scale-val').textContent = `${Math.round(scale * 100)}%`;
      if (st.brushAssetId) {
        for (const el of st.elements) {
          if (el.type === 'brush' && el.assetId === st.brushAssetId) el.assetScale = scale;
        }
      }
      DM.Renderer.render();
    });

    panel.querySelector('#bp-cave-rough').addEventListener('input', function () {
      DM.State.current.brushBorderRough = +this.value;
      panel.querySelector('#bp-cave-rough-val').textContent = `${Math.round(this.value * 100)}%`;
      DM.Renderer.render();
    });

    panel.querySelector('#bp-cave-color').addEventListener('input', function () {
      DM.State.current.brushBorderColor = this.value;
      DM.Renderer.render();
    });

    panel.querySelector('#bp-cave-width').addEventListener('input', function () {
      const st = DM.State.current;
      st.brushBorderWidth = +this.value;
      if (st.brushBorderColor == null) st.brushBorderColor = panel.querySelector('#bp-cave-color').value;
      panel.querySelector('#bp-cave-width-val').textContent = `${this.value}px`;
      DM.Renderer.render();
    });
  }

  function refreshBrushAssets() {
    const container = document.getElementById('bp-assets');
    if (!container) return;
    const st         = DM.State.current;
    const searchTerm = (document.getElementById('bp-asset-search')?.value || '').trim().toLowerCase();
    const catNameMap = _buildCatNameMap();
    const validAssets = st.assets.filter(_isValidAsset);
    const assets      = searchTerm
      ? validAssets.filter(a => {
          const catName = (catNameMap[String(a.categoryId)] || '').toLowerCase();
          return a.name.toLowerCase().includes(searchTerm) || catName.includes(searchTerm);
        })
      : validAssets;
    container.innerHTML = '';

    const setActive = (activeBtn) => {
      container.querySelectorAll('.bp-asset-thumb-btn').forEach(b => b.classList.remove('active'));
      activeBtn.classList.add('active');
    };

    const noneBtn = document.createElement('button');
    noneBtn.className = 'bp-asset-thumb-btn' + (!st.brushAssetId ? ' active' : '');
    noneBtn.title = 'None (use color)';
    noneBtn.textContent = '✕';
    noneBtn.addEventListener('click', () => {
      st.brushAssetId = null;
      const colorRow = document.getElementById('bp-color-row');
      if (colorRow) colorRow.hidden = false;
      const scaleRow = document.getElementById('bp-scale-row');
      if (scaleRow) scaleRow.hidden = true;
      setActive(noneBtn);
      DM.Renderer.render();
    });
    container.appendChild(noneBtn);

    for (const asset of assets) {
      const btn = document.createElement('button');
      btn.className = 'bp-asset-thumb-btn' + (st.brushAssetId === asset.id ? ' active' : '');
      btn.title = asset.name;
      if (asset._img) {
        const thumb = document.createElement('canvas');
        thumb.width = thumb.height = 30;
        thumb.getContext('2d').drawImage(asset._img, 0, 0, 30, 30);
        btn.appendChild(thumb);
      } else {
        btn.textContent = (asset.name || '?').substring(0, 3);
      }
      btn.addEventListener('click', () => {
        st.brushAssetId = asset.id;
        const colorRow = document.getElementById('bp-color-row');
        if (colorRow) colorRow.hidden = true;
        const scaleRow = document.getElementById('bp-scale-row');
        if (scaleRow) scaleRow.hidden = false;
        setActive(btn);
        DM.Renderer.render();
      });
      container.appendChild(btn);
    }

    const colorRow = document.getElementById('bp-color-row');
    if (colorRow) colorRow.hidden = !!st.brushAssetId;
    const scaleRow = document.getElementById('bp-scale-row');
    if (scaleRow) scaleRow.hidden = !st.brushAssetId;
  }

  function initFogPanel() {
    const panel = document.getElementById('fog-details');
    if (!panel) return;

    const st = DM.State.current;

    panel.innerHTML = `
      <div class="opt-row">
        <span class="opt-label">Color</span>
        <div class="opt-ctrl">
          <input type="color" id="fp-color" value="${st.fogColor || '#cdd4e1'}">
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Size</span>
        <div class="opt-ctrl">
          <input type="range" id="fp-size" min="30" max="300" step="1" value="${st.fogSize || 120}" style="flex:1">
          <span id="fp-size-val" class="prop-val">${st.fogSize || 120}px</span>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Density</span>
        <div class="opt-ctrl">
          <input type="range" id="fp-density" min="0.05" max="0.8" step="0.01" value="${st.fogDensity ?? 0.35}" style="flex:1">
          <span id="fp-density-val" class="prop-val">${Math.round((st.fogDensity ?? 0.35) * 100)}%</span>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Softness</span>
        <div class="opt-ctrl">
          <input type="range" id="fp-soft" min="0.1" max="0.95" step="0.01" value="${st.fogSoft ?? 0.7}" style="flex:1">
          <span id="fp-soft-val" class="prop-val">${Math.round((st.fogSoft ?? 0.7) * 100)}%</span>
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Animate</span>
        <div class="opt-ctrl">
          <label class="prop-check"><input type="checkbox" id="fp-animated" ${st.fogAnimated !== false ? 'checked' : ''}> Drift &amp; breathe</label>
        </div>
      </div>
      <div class="opt-row" id="fp-speed-row"${st.fogAnimated !== false ? '' : ' hidden'}>
        <span class="opt-label">Speed</span>
        <div class="opt-ctrl">
          <input type="range" id="fp-speed" min="0" max="2.5" step="0.05" value="${st.fogAnimSpeed ?? 1}" style="flex:1">
          <span id="fp-speed-val" class="prop-val">${(st.fogAnimSpeed ?? 1).toFixed(2)}×</span>
        </div>
      </div>`;

    panel.querySelector('#fp-color').addEventListener('input', function () {
      DM.State.current.fogColor = this.value;
    });
    panel.querySelector('#fp-size').addEventListener('input', function () {
      DM.State.current.fogSize = +this.value;
      panel.querySelector('#fp-size-val').textContent = `${this.value}px`;
    });
    panel.querySelector('#fp-density').addEventListener('input', function () {
      DM.State.current.fogDensity = +this.value;
      panel.querySelector('#fp-density-val').textContent = `${Math.round(this.value * 100)}%`;
    });
    panel.querySelector('#fp-soft').addEventListener('input', function () {
      DM.State.current.fogSoft = +this.value;
      panel.querySelector('#fp-soft-val').textContent = `${Math.round(this.value * 100)}%`;
    });
    panel.querySelector('#fp-animated').addEventListener('change', function () {
      DM.State.current.fogAnimated = this.checked;
      const row = panel.querySelector('#fp-speed-row');
      if (row) row.hidden = !this.checked;
    });
    panel.querySelector('#fp-speed').addEventListener('input', function () {
      DM.State.current.fogAnimSpeed = +this.value;
      panel.querySelector('#fp-speed-val').textContent = `${(+this.value).toFixed(2)}×`;
    });
  }

  function initDoorPanel() {
    const panel = document.getElementById('door-details');
    if (!panel) return;
    panel.innerHTML = `
      <div class="opt-row">
        <span class="opt-label">Asset</span>
        <div class="opt-ctrl" style="flex-direction:column;gap:4px">
          <input type="text" id="door-asset-search" placeholder="Search…" class="asset-search-input">
          <div id="door-assets" class="bp-asset-strip"></div>
        </div>
      </div>`;
    panel.querySelector('#door-asset-search').addEventListener('input', refreshDoorAssets);
    refreshDoorAssets();
  }

  function refreshDoorAssets() {
    const container = document.getElementById('door-assets');
    if (!container) return;
    const st         = DM.State.current;
    const searchTerm = (document.getElementById('door-asset-search')?.value || '').trim().toLowerCase();
    const catNameMap = _buildCatNameMap();
    const validAssets = st.assets.filter(_isValidAsset);
    const assets      = searchTerm
      ? validAssets.filter(a => {
          const catName = (catNameMap[String(a.categoryId)] || '').toLowerCase();
          return a.name.toLowerCase().includes(searchTerm) || catName.includes(searchTerm);
        })
      : validAssets;
    container.innerHTML = '';

    const setActive = btn => {
      container.querySelectorAll('.bp-asset-thumb-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };

    const noneBtn = document.createElement('button');
    noneBtn.className = 'bp-asset-thumb-btn' + (!st.doorAssetId ? ' active' : '');
    noneBtn.title = 'Standard door (drawn)';
    noneBtn.textContent = '🚪';
    noneBtn.addEventListener('click', () => {
      st.doorAssetId = null;
      setActive(noneBtn);
    });
    container.appendChild(noneBtn);

    for (const asset of assets) {
      const btn = document.createElement('button');
      btn.className = 'bp-asset-thumb-btn' + (st.doorAssetId === asset.id ? ' active' : '');
      btn.title = asset.name;
      if (asset._img) {
        const thumb = document.createElement('canvas');
        thumb.width = thumb.height = 30;
        thumb.getContext('2d').drawImage(asset._img, 0, 0, 30, 30);
        btn.appendChild(thumb);
      } else {
        btn.textContent = (asset.name || '?').substring(0, 3);
      }
      btn.addEventListener('click', () => {
        st.doorAssetId = asset.id;
        setActive(btn);
      });
      container.appendChild(btn);
    }
  }

  function initFillPanel() {
    const panel = document.getElementById('fill-details');
    if (!panel) return;
    const st = DM.State.current;
    panel.innerHTML = `
      <div class="opt-row" id="fp-color-row">
        <span class="opt-label">Color</span>
        <div class="opt-ctrl">
          <input type="color" id="fp-color" value="${st.fillColor || '#8b7355'}">
        </div>
      </div>
      <div class="opt-row">
        <span class="opt-label">Texture</span>
        <div class="opt-ctrl" style="flex-direction:column;gap:4px">
          <input type="text" id="fp-asset-search" placeholder="Search…" class="asset-search-input">
          <div id="fp-assets" class="bp-asset-strip"></div>
        </div>
      </div>
      <div class="opt-row" id="fp-scale-row"${st.fillAssetId ? '' : ' hidden'}>
        <span class="opt-label">Tile size</span>
        <div class="opt-ctrl">
          <input type="range" id="fp-asset-scale" min="0.1" max="4" step="0.1" value="${st.fillAssetScale ?? 1}" style="flex:1">
          <span id="fp-asset-scale-val" class="prop-val">${Math.round((st.fillAssetScale ?? 1) * 100)}%</span>
        </div>
      </div>`;

    panel.querySelector('#fp-color').addEventListener('input', function () {
      DM.State.current.fillColor = this.value;
    });

    panel.querySelector('#fp-asset-search').addEventListener('input', refreshFillAssets);

    panel.querySelector('#fp-asset-scale').addEventListener('input', function () {
      const scale = +this.value;
      DM.State.current.fillAssetScale = scale;
      panel.querySelector('#fp-asset-scale-val').textContent = `${Math.round(scale * 100)}%`;
    });
  }

  function refreshFillAssets() {
    const container = document.getElementById('fp-assets');
    if (!container) return;
    const st         = DM.State.current;
    const searchTerm = (document.getElementById('fp-asset-search')?.value || '').trim().toLowerCase();
    const catNameMap = _buildCatNameMap();
    const validAssets = st.assets.filter(_isValidAsset);
    const assets      = searchTerm
      ? validAssets.filter(a => {
          const catName = (catNameMap[String(a.categoryId)] || '').toLowerCase();
          return a.name.toLowerCase().includes(searchTerm) || catName.includes(searchTerm);
        })
      : validAssets;
    container.innerHTML = '';

    const setActive = (activeBtn) => {
      container.querySelectorAll('.bp-asset-thumb-btn').forEach(b => b.classList.remove('active'));
      activeBtn.classList.add('active');
    };

    const noneBtn = document.createElement('button');
    noneBtn.className = 'bp-asset-thumb-btn' + (!st.fillAssetId ? ' active' : '');
    noneBtn.title = 'None (use color)';
    noneBtn.textContent = '✕';
    noneBtn.addEventListener('click', () => {
      st.fillAssetId = null;
      document.getElementById('fp-color-row').hidden = false;
      document.getElementById('fp-scale-row').hidden = true;
      setActive(noneBtn);
    });
    container.appendChild(noneBtn);

    for (const asset of assets) {
      const btn = document.createElement('button');
      btn.className = 'bp-asset-thumb-btn' + (st.fillAssetId === asset.id ? ' active' : '');
      btn.title = asset.name;
      if (asset._img) {
        const thumb = document.createElement('canvas');
        thumb.width = thumb.height = 30;
        thumb.getContext('2d').drawImage(asset._img, 0, 0, 30, 30);
        btn.appendChild(thumb);
      } else {
        btn.textContent = (asset.name || '?').substring(0, 3);
      }
      btn.addEventListener('click', () => {
        st.fillAssetId = asset.id;
        document.getElementById('fp-color-row').hidden = true;
        document.getElementById('fp-scale-row').hidden = false;
        setActive(btn);
      });
      container.appendChild(btn);
    }

    const colorRow = document.getElementById('fp-color-row');
    if (colorRow) colorRow.hidden = !!st.fillAssetId;
    const scaleRow = document.getElementById('fp-scale-row');
    if (scaleRow) scaleRow.hidden = !st.fillAssetId;
  }

  function initZoomControls() {
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      DM.Zoom.zoomIn();
      requestAnimationFrame(positionPopup);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      DM.Zoom.zoomOut();
      requestAnimationFrame(positionPopup);
    });
    document.getElementById('btn-zoom-reset').addEventListener('click', () => {
      DM.Zoom.reset();
      requestAnimationFrame(positionPopup);
    });

    const fabIn   = document.getElementById('fab-zoom-in');
    const fabOut  = document.getElementById('fab-zoom-out');
    const fabHand = document.getElementById('fab-hand');
    if (fabIn)   fabIn.addEventListener('click',  () => { DM.Zoom.zoomIn();  requestAnimationFrame(positionPopup); });
    if (fabOut)  fabOut.addEventListener('click', () => { DM.Zoom.zoomOut(); requestAnimationFrame(positionPopup); });
    if (fabHand) fabHand.addEventListener('click', () => selectTool('hand'));
  }

  function openTextModal(pos) {
    const st = DM.State.current;
    if (st.layers[st.activeLayerIdx].locked) return;

    const modal   = document.getElementById('text-modal');
    const inputEl = document.getElementById('text-input');
    inputEl.value = '';
    modal.classList.remove('hidden');
    inputEl.focus();

    const confirm2 = () => {
      const text = inputEl.value.trim();
      modal.classList.add('hidden');
      if (!text) return;
      DM.State.addElement({
        type: 'text', x: pos.x, y: pos.y,
        text, fontSize: 18, color: '#2c1810',
        w: 120, rotation: 0, bold: false, italic: false, opacity: 1,
      });
      DM.Renderer.render();
      updateProperties();
    };

    document.getElementById('text-confirm').onclick = confirm2;
    document.getElementById('text-cancel').onclick  = () => modal.classList.add('hidden');
    inputEl.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirm2(); }
      if (e.key === 'Escape') modal.classList.add('hidden');
    };
  }

  function initHeaderButtons() {
    document.getElementById('btn-undo').addEventListener('click', () => {
      if (DM.State.undo()) {
        DM.Renderer.render();
        updateProperties();
        updateLayersPanel();
      }
    });

    document.getElementById('btn-new').addEventListener('click', () => {
      if (!confirm('Start a new map? All unsaved changes will be lost.')) return;
      DM.State.newMap();
      DM.IO?.clearSession?.();
      DM.Renderer.resizeCanvas();
      DM.Renderer.render();
      buildToolGroups();
      updateAssetList();
      updateProperties();
      syncMapSizeInputs();
      syncBgPicker();
      syncGridControls();
      updateLayersPanel();
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
      if (!confirm('Clear the entire map? All elements will be permanently removed.')) return;
      DM.State.clearMap();
      DM.IO?.clearSession?.();
      DM.Renderer.render();
      updateProperties();
      updateLayersPanel();
    });

    document.getElementById('btn-export-uvtt').addEventListener('click', () => { DM.track?.('export_map', { format: 'foundry_vtt' }); DM.Roll20.exportUVTT(); });
    document.getElementById('btn-export-webm')?.addEventListener('click', () => _openRecordModal());

    document.getElementById('btn-export-png').addEventListener('click',    () => { DM.track?.('export_map', { format: 'png' });    DM.IO.exportPNG(); });
    document.getElementById('btn-export-png-hd').addEventListener('click', () => { DM.track?.('export_map', { format: 'png_hd' }); DM.IO.exportPNG(2); });
    document.getElementById('btn-export-jpg').addEventListener('click',    () => { DM.track?.('export_map', { format: 'jpg' });    DM.IO.exportJPG(0.95); });
    document.getElementById('btn-export-jpg-hd').addEventListener('click', () => { DM.track?.('export_map', { format: 'jpg_hd' }); DM.IO.exportJPG(0.95, 2); });
    document.getElementById('btn-save').addEventListener('click',       () => { DM.track?.('save_map_file'); DM.IO.saveMap(); });

    document.getElementById('btn-print').addEventListener('click', () => {
      DM.track?.('export_map', { format: 'print' });
      DM.Renderer.render();
      const dataUrl = DM.Renderer.canvas.toDataURL('image/png');
      const st      = DM.State.current;

      const win = window.open('', '_blank');
      if (!win) {
        alert('Your browser blocked the print popup.\nPlease allow popups for this page and try again.');
        return;
      }

      const landscape = st.mapW > st.mapH ? 'landscape' : 'portrait';
      win.document.write(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8">
  <title>Dungeon Map Builder — Map</title>
  <style>
    @page { margin: 8mm; size: auto ${landscape}; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: #fff; width: 100%; height: 100%; }
    img {
      display: block;
      max-width: 100%;
      max-height: 100vh;
      width: auto;
      height: auto;
    }
    @media print {
      img { max-width: 100%; max-height: none; width: 100%; }
    }
  </style>
</head><body>
  <img src="${dataUrl}"
       onload="window.focus(); window.print();"
       onerror="document.body.textContent='Failed to load map image.'">
</body></html>`);
      win.document.close();
    });

    function _openRecordModal() {
      const modal    = document.getElementById('record-modal');
      const slider   = document.getElementById('record-duration');
      const label    = document.getElementById('record-duration-label');
      const btn      = document.getElementById('record-btn');
      const progress = document.getElementById('record-progress');
      const status   = document.getElementById('record-status');
      if (!modal) return;

      slider.value = slider.value || '3';
      label.textContent    = parseFloat(slider.value).toFixed(1) + 's';
      progress.style.width = '0%';
      status.textContent   = '';
      btn.disabled         = false;
      btn.textContent      = '⏺ Record';
      modal.classList.remove('hidden');

      slider.oninput = () => { label.textContent = parseFloat(slider.value).toFixed(1) + 's'; };

      btn.onclick = async () => {
        const durMs = parseFloat(slider.value) * 1000;
        const total = parseFloat(slider.value).toFixed(1);
        btn.disabled    = true;
        btn.textContent = '● Recording…';
        status.textContent   = 'Recording… 0.0 / ' + total + 's — keep this tab in the foreground';
        progress.style.width = '0%';
        try {
          await DM.IO.recordWebM(durMs, elapsed => {
            const e = Math.min(elapsed, durMs);
            progress.style.width = (e / durMs * 100) + '%';
            status.textContent   = 'Recording… ' + (e / 1000).toFixed(1) + ' / ' + total + 's — keep this tab in the foreground';
          }, {
            onPhase: phase => {
              if (phase === 'finalizing') {
                progress.style.width = '100%';
                btn.textContent    = 'Finalizing…';
                status.textContent = 'Finalizing video… almost done, please wait';
              }
            }
          });
          progress.style.width = '100%';
          status.textContent   = 'Done — check your downloads.';
          btn.textContent      = '⏺ Record again';
          btn.disabled         = false;
          DM.track?.('export_map', { format: 'webm' });
        } catch (err) {
          status.textContent = 'Error: ' + (err?.message || 'Recording not supported in this browser.');
          progress.style.width = '0%';
          btn.disabled       = false;
          btn.textContent    = '⏺ Record';
        }
      };

      modal.querySelector('#record-modal-close').onclick = () => modal.classList.add('hidden');
    }

    const _exportMenuBtn  = document.getElementById('btn-export-menu');
    const _exportDropdown = document.getElementById('export-dropdown');
    if (_exportMenuBtn && _exportDropdown) {
      _exportMenuBtn.addEventListener('click', e => {
        e.stopPropagation();
        const open = _exportDropdown.classList.contains('hidden');
        _exportDropdown.classList.toggle('hidden', !open);
        _exportMenuBtn.setAttribute('aria-expanded', String(open));
      });
      document.addEventListener('click', () => {
        _exportDropdown.classList.add('hidden');
        _exportMenuBtn.setAttribute('aria-expanded', 'false');
      });
    }

    document.getElementById('btn-load').addEventListener('click', () => {
      document.getElementById('load-file').click();
    });
    document.getElementById('load-file').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      await DM.IO.loadMap(file);
      syncMapSizeInputs();
      buildToolGroups();
      updateAssetList();
      updateProperties();
      updateLayersPanel();
      e.target.value = '';
    });
  }

  function showLoader(msg = 'Loading…') {
    let el = document.getElementById('dm-loader');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dm-loader';
      el.innerHTML = `
        <div class="dm-loader-box">
          <div class="dm-loader-spinner"></div>
          <p id="dm-loader-msg"></p>
        </div>`;
      document.body.appendChild(el);
    }
    el.querySelector('#dm-loader-msg').textContent = msg;
    el.classList.remove('hidden');
  }

  function hideLoader() {
    document.getElementById('dm-loader')?.classList.add('hidden');
  }

  function initScrollListener() {
    const area = document.getElementById('canvas-area');
    if (area) {
      area.addEventListener('scroll', () => {
        if (DM.State.current.selectedIdx >= 0) positionPopup();
        if (DM.State.current.multiSelectedSet.size >= 2) positionMultiPopup();
      }, { passive: true });
    }
  }

  function initSidebarToggle() {
    const toggleBtn = document.getElementById('btn-sidebar-toggle');
    const sidebar   = document.getElementById('sidebar');
    const backdrop  = document.getElementById('sidebar-backdrop');
    if (!toggleBtn || !sidebar || !backdrop) return;

    function openSidebar()  { sidebar.classList.add('open');    backdrop.classList.add('open');    }
    function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('open'); }

    toggleBtn.addEventListener('click', () => {
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
    backdrop.addEventListener('click', closeSidebar);

    const closeBtn = document.getElementById('btn-sidebar-close');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);

    sidebar.addEventListener('click', e => {
      if (window.innerWidth <= 1100 && e.target.closest('.tool-btn')) closeSidebar();
    });
  }

  return {
    init() {
      initDoorPanel();     // must run before buildToolGroups (div must exist in DOM)
      initFillPanel();
      buildToolGroups();
      initGridControls();
      initBgControls();
      initMapSizeControls();
      initGeneratorControls();
      initAssetPanel();
      initRoomPanel();
      initBrushPanel();
      initFogPanel();
      initHeaderButtons();
      initZoomControls();
      initScrollListener();
      _initPopupDrag();
      initSidebarToggle();
      updateLayersPanel();
      selectTool('room');
      _trackReady = true;
    },
    selectTool,
    updateProperties,
    updateMultiSelectPopup,
    updateAssetList,
    updateLayersPanel,
    refreshBrushAssets,
    refreshDoorAssets,
    refreshFillAssets,
    refreshBgAssets,
    setAssetMeta,
    addMyCategory(cat)    { _assetMeta.myCategories.push(cat); updateAssetList(); },
    removeMyCategory(id)  { _assetMeta.myCategories = _assetMeta.myCategories.filter(c => c.id !== id); updateAssetList(); },
    renameMyCategory(id, name) {
      const cat = _assetMeta.myCategories.find(c => String(c.id) === String(id));
      if (!cat) return;
      cat.name = name;
      updateAssetList();
    },
    syncMapSizeInputs,
    syncBgPicker,
    syncGridControls,
    rebuildSidebar: buildToolGroups,
    openTextModal,
    positionPopup,
    showLoader,
    hideLoader,
  };
})();

'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const canvas = document.getElementById('mapCanvas');

  DM.Renderer.init(canvas);
  DM.UI.init();
  DM.Tools.init();
  DM.Feedback.init();

  try {
    await DM.Auth.init();
  } catch (err) {
    console.error('[DM] Auth init failed:', err);
  }

  DM.Auth.on('login', async () => {
    try {
      const meta = await DM.IO.loadServerAssets();
      if (meta) DM.UI.setAssetMeta(meta);
      DM.UI.updateAssetList();
    } catch (err) {
      console.error('[DM] Asset reload after login failed:', err);
    }
  });

  try {
    const restored = await DM.IO.restoreSession();
    if (restored) {
      DM.UI.syncMapSizeInputs();
      DM.Renderer.resizeCanvas();
      DM.UI.updateLayersPanel();
      DM.UI.syncBgPicker();
      DM.UI.syncGridControls();
    }
  } catch (err) {
    console.error('[DM] Session restore failed:', err);
  }

  try {
    const meta = await DM.IO.loadServerAssets();
    if (meta) DM.UI.setAssetMeta(meta);
  } catch (err) {
    console.error('[DM] Server asset load failed:', err);
  }
  DM.UI.updateAssetList();

  DM.Zoom.apply();
  setTimeout(() => {
    DM.Renderer.render();
    DM.Renderer.startDecalAnim();   // resume animation if the restored map has animated decals
    canvas.style.opacity = '0.9999';
    setTimeout(() => { canvas.style.opacity = ''; }, 0);
  }, 0);
});

'use strict';
window.DM = window.DM || {};

DM.Auth = (() => {

  const API = (window.TMB_BASE || '') + '/api/auth.php';

  let _user  = null;
  let _csrf  = '';
  const _bus = [];   // [{event, cb}]

  const state = Object.freeze({
    get user()       { return _user; },
    get isLoggedIn() { return _user !== null; },
    get csrfToken()  { return _csrf; },
  });

  function on(event, cb) {
    _bus.push({ event, cb });
  }

  function _emit(event, data) {
    _bus.filter(l => l.event === event).forEach(l => l.cb(data));
  }

  async function _fetch(action, method = 'GET', body = null) {
    const init = {
      method,
      credentials: 'same-origin',
      headers:     { 'Content-Type': 'application/json' },
    };
    if (_csrf)  init.headers['X-CSRF-Token'] = _csrf;
    if (body)   init.body = JSON.stringify(body);

    const res = await fetch(`${API}?action=${action}`, init);
    if (!res.ok && res.status !== 400 && res.status !== 401 && res.status !== 403) {
      throw new Error(`Server error (${res.status})`);
    }
    return res.json();
  }

  async function init() {
    _csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

    const initial = window.__INITIAL_AUTH__;
    if (initial?.authenticated && initial.user) {
      _user = initial.user;
    }

    _buildUI();
    _updateHeader();

    if (_user) _emit('login', _user);
  }

  async function login(loginStr, password) {
    const res = await _fetch('login', 'POST', { login: loginStr, password });
    if (!res.success) throw new Error(res.error);

    const csrf = await _fetch('csrf');
    _csrf = csrf.token || _csrf;

    _user = res.user;
    _emit('login', _user);
    _updateHeader();
    DM.track?.('login');
    return res.user;
  }

  async function register(username, email, password) {
    const res = await _fetch('register', 'POST', { username, email, password });
    if (!res.success) throw new Error(res.error);

    const csrf = await _fetch('csrf');
    _csrf = csrf.token || _csrf;

    _user = res.user;
    _emit('login', _user);
    _updateHeader();
    DM.track?.('sign_up');
    return res.user;
  }

  async function logout() {
    await _fetch('logout', 'POST');
    _user = null;
    _csrf = '';
    _emit('logout');
    _updateHeader();

    const csrf = await _fetch('csrf');
    _csrf = csrf.token || '';
  }

  function _buildUI() {
    _buildAuthModal();
    _buildHeaderWidget();
  }

  function _buildAuthModal() {
    const el = document.createElement('div');
    el.id        = 'auth-modal';
    el.className = 'auth-modal hidden';
    el.innerHTML = `
      <div class="auth-backdrop"></div>
      <div class="auth-box">
        <div class="auth-logo">⚔ DUNGEON MAP BUILDER</div>

        <div class="auth-tabs" role="tablist">
          <button class="auth-tab active" data-tab="login"    role="tab">Sign In</button>
          <button class="auth-tab"        data-tab="register" role="tab">Register</button>
        </div>

        <form id="auth-form-login" class="auth-form" novalidate autocomplete="on">
          <div class="auth-field">
            <label for="auth-login-id">Username or Email</label>
            <input id="auth-login-id"   type="text"     name="login"    autocomplete="username"         required>
          </div>
          <div class="auth-field">
            <label for="auth-login-pw">Password</label>
            <input id="auth-login-pw"   type="password" name="password" autocomplete="current-password" required>
          </div>
          <p class="auth-error" id="auth-login-error" role="alert"></p>
          <button type="submit" class="btn primary full-width">Sign In</button>
        </form>

        <form id="auth-form-register" class="auth-form hidden" novalidate autocomplete="on">
          <div class="auth-field">
            <label for="auth-reg-user">Username</label>
            <input id="auth-reg-user"  type="text"     name="username" autocomplete="username"     minlength="3" maxlength="40" required>
          </div>
          <div class="auth-field">
            <label for="auth-reg-email">Email</label>
            <input id="auth-reg-email" type="email"    name="email"    autocomplete="email"         required>
          </div>
          <div class="auth-field">
            <label for="auth-reg-pw">Password <small>(min. 8 characters)</small></label>
            <input id="auth-reg-pw"    type="password" name="password" autocomplete="new-password"  minlength="8" required>
          </div>
          <p class="auth-error" id="auth-register-error" role="alert"></p>
          <button type="submit" class="btn primary full-width">Create Account</button>
        </form>
      </div>
    `;

    document.body.appendChild(el);
    _bindModalEvents(el);
  }

  function _buildHeaderWidget() {
    const headerActions = document.querySelector('.header-actions');
    if (!headerActions) return;

    const signinBtn = document.createElement('button');
    signinBtn.id          = 'btn-auth-signin';
    signinBtn.className   = 'btn';
    signinBtn.textContent = '🔑 Sign In';
    headerActions.insertBefore(signinBtn, headerActions.firstChild);
    signinBtn.addEventListener('click', showModal);

    const menu = document.createElement('div');
    menu.id        = 'auth-user-menu';
    menu.className = 'auth-user-menu hidden';
    menu.innerHTML = `
      <button class="btn" id="auth-user-btn" aria-haspopup="true" aria-expanded="false">
        <span id="auth-user-label"></span>
        <span id="auth-tier-badge" class="auth-tier-badge"></span>
        ▾
      </button>
      <ul class="auth-dropdown" id="auth-dropdown" role="menu">
        <li><button class="dropdown-item" id="auth-btn-cloud-save" role="menuitem">☁ Save Map</button></li>
        <li><button class="dropdown-item" id="auth-btn-maps"       role="menuitem">📂 Load Map</button></li>
        <li><button class="dropdown-item" id="auth-btn-cloud-assets" role="menuitem">🖼 My Assets</button></li>
        <li class="dropdown-sep" role="separator"></li>
        <li><button class="dropdown-item danger" id="auth-btn-logout" role="menuitem">⏏ Sign Out</button></li>
      </ul>
    `;
    headerActions.insertBefore(menu, headerActions.firstChild);

    document.getElementById('auth-user-btn').addEventListener('click', e => {
      e.stopPropagation();
      const dd       = document.getElementById('auth-dropdown');
      const expanded = !dd.classList.contains('hidden');
      dd.classList.toggle('hidden', expanded);
      e.currentTarget.setAttribute('aria-expanded', String(!expanded));
    });

    document.addEventListener('click', () => {
      document.getElementById('auth-dropdown')?.classList.add('hidden');
      document.getElementById('auth-user-btn')?.setAttribute('aria-expanded', 'false');
    });

    document.getElementById('auth-btn-logout').addEventListener('click', async () => {
      document.getElementById('auth-dropdown').classList.add('hidden');
      await logout();
    });

    document.getElementById('auth-btn-cloud-save').addEventListener('click', () => {
      document.getElementById('auth-dropdown').classList.add('hidden');
      DM.Cloud?.quickSave();
    });

    document.getElementById('auth-btn-maps').addEventListener('click', () => {
      document.getElementById('auth-dropdown').classList.add('hidden');
      DM.Cloud?.showMapManager();
    });

    document.getElementById('auth-btn-cloud-assets').addEventListener('click', () => {
      document.getElementById('auth-dropdown').classList.add('hidden');
      DM.Cloud?.showAssetManager();
    });

  }

  function _bindModalEvents(modal) {
    modal.querySelector('.auth-backdrop').addEventListener('click', () => {
      if (_user) hideModal();
    });

    modal.querySelectorAll('.auth-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        modal.querySelectorAll('.auth-tab').forEach(t =>
          t.classList.toggle('active', t === tab)
        );
        document.getElementById('auth-form-login')
          .classList.toggle('hidden', tab.dataset.tab !== 'login');
        document.getElementById('auth-form-register')
          .classList.toggle('hidden', tab.dataset.tab !== 'register');
      });
    });

    document.getElementById('auth-form-login').addEventListener('submit', async e => {
      e.preventDefault();
      const form  = e.target;
      const errEl = document.getElementById('auth-login-error');
      const btn   = form.querySelector('[type=submit]');
      _setFormBusy(btn, errEl, 'Signing in…');
      try {
        await login(form.login.value.trim(), form.password.value);
        hideModal();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        _clearFormBusy(btn, errEl, 'Sign In');
      }
    });

    document.getElementById('auth-form-register').addEventListener('submit', async e => {
      e.preventDefault();
      const form  = e.target;
      const errEl = document.getElementById('auth-register-error');
      const btn   = form.querySelector('[type=submit]');
      _setFormBusy(btn, errEl, 'Creating account…');
      try {
        await register(form.username.value.trim(), form.email.value.trim(), form.password.value);
        hideModal();
      } catch (err) {
        errEl.textContent = err.message;
      } finally {
        _clearFormBusy(btn, errEl, 'Create Account');
      }
    });
  }

  function _setFormBusy(btn, errEl, label) {
    errEl.textContent = '';
    btn.disabled      = true;
    btn.textContent   = label;
  }

  function _clearFormBusy(btn, errEl, label) {
    btn.disabled    = false;
    btn.textContent = label;
  }

  function _updateHeader() {
    const signinBtn = document.getElementById('btn-auth-signin');
    const userMenu  = document.getElementById('auth-user-menu');
    const userLabel = document.getElementById('auth-user-label');
    const tierBadge = document.getElementById('auth-tier-badge');

    if (_user) {
      signinBtn?.classList.add('hidden');
      userMenu?.classList.remove('hidden');
      if (userLabel) userLabel.textContent = _user.username;

      if (tierBadge) {
        const label = _user.tier_label || '';
        tierBadge.textContent    = label;
        tierBadge.dataset.tier   = _user.tier_name || 'free';
        tierBadge.style.display  = label ? '' : 'none';
      }
    } else {
      signinBtn?.classList.remove('hidden');
      userMenu?.classList.add('hidden');
    }
  }

  function showModal() {
    document.getElementById('auth-modal')?.classList.remove('hidden');
  }

  function hideModal() {
    document.getElementById('auth-modal')?.classList.add('hidden');
  }

  return { init, login, register, logout, showModal, hideModal, state, on };

})();

'use strict';
window.DM = window.DM || {};

DM.Cloud = (() => {

  const _base      = window.TMB_BASE || '';
  const MAPS_API   = _base + '/api/maps.php';
  const ASSETS_API = _base + '/api/assets.php';
  const PLAY_API   = _base + '/api/play.php';

  async function _api(url, method = 'GET', body = null) {
    const init = { method, credentials: 'same-origin', headers: {} };

    const token = DM.Auth.state.csrfToken;
    if (token) init.headers['X-CSRF-Token'] = token;

    if (body instanceof FormData) {
      init.body = body;                          // let browser set Content-Type + boundary
    } else if (body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (res.status === 401) {
      DM.Auth?.showModal?.();
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      console.error('[Cloud API] Non-JSON response from', url, ':', text.slice(0, 500));
      return { success: false, error: 'Server error (invalid response)' };
    }
  }

  function _toast(message, isError = false) {
    let el = document.getElementById('cloud-toast');
    if (!el) {
      el    = document.createElement('div');
      el.id = 'cloud-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className   = 'cloud-toast' + (isError ? ' error' : '');
    el.classList.remove('visible');
    void el.offsetWidth;                         // force reflow to restart animation
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('visible'), 3200);
  }

  DM.toast = _toast;

  function _esc(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#x27;')
      .replace(/`/g,  '&#x60;');
  }

  function _bytes(n) {
    if (n < 1024)        return n + ' B';
    if (n < 1048576)     return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function _date(str) {
    return new Date(str).toLocaleDateString('it-IT', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function showMapManager() {
    if (!DM.Auth.state.isLoggedIn) { DM.Auth.showModal(); return; }

    let modal = document.getElementById('cloud-map-modal');
    if (!modal) modal = _buildMapModal();

    modal.classList.remove('hidden');
    _refreshMapList();
  }

  function _buildMapModal() {
    const modal = document.createElement('div');
    modal.id        = 'cloud-map-modal';
    modal.className = 'auth-modal hidden';
    modal.innerHTML = `
      <div class="auth-backdrop"></div>
      <div class="auth-box wide">
        <div class="cloud-modal-header">
          <h2>My Maps</h2>
          <button class="cloud-modal-close" id="cloud-map-close" aria-label="Close">✕</button>
        </div>

        <div class="cloud-toolbar">
          <button class="btn primary" id="cloud-btn-save">💾 Save Current Map</button>
          <span class="cloud-counter" id="cloud-map-counter"></span>
        </div>

        <div id="cloud-map-list" class="cloud-list">
          <p class="cloud-loading">Loading…</p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.auth-backdrop')
         .addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('cloud-map-close')
            .addEventListener('click',  () => modal.classList.add('hidden'));
    document.getElementById('cloud-btn-save')
            .addEventListener('click',  () => _promptAndSave());

    return modal;
  }

  async function _snapshotBlob() {
    const st = DM.State.current;
    const prevTool = st.tool, prevSel = st.selectedIdx;
    st._playerRender = true;
    st.tool          = '__export__';
    st.selectedIdx   = -1;
    let dataUrl;
    try { dataUrl = DM.Renderer.renderHD(1).toDataURL('image/png'); }
    finally {
      delete st._playerRender;
      st.tool        = prevTool;
      st.selectedIdx = prevSel;
    }
    return (await fetch(dataUrl)).blob();
  }

  async function _doUploadPlayLink(mapId, name) {
    const st   = DM.State.current;
    const blob = await _snapshotBlob();
    const meta = { mapW: st.mapW, mapH: st.mapH, cellSize: st.cellSize, gridType: st.gridType, ftPerCell: 5 };
    const fd = new FormData();
    fd.append('file', blob, 'map.png');
    fd.append('title', name || 'Battle Map');
    if (mapId) fd.append('map_id', String(mapId));
    fd.append('meta', JSON.stringify(meta));
    const res = await _api(PLAY_API, 'POST', fd);
    if (!res.success) throw new Error(res.error || 'Failed to create play link.');
    DM.track?.('create_play_link');
    return res.url;
  }

  function _showPlayLinkModal(url, name) {
    let modal = document.getElementById('cloud-play-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id        = 'cloud-play-modal';
      modal.className = 'auth-modal hidden';
      modal.innerHTML = `
        <div class="auth-backdrop"></div>
        <div class="auth-box">
          <div class="cloud-modal-header">
            <h2>🎲 Play link</h2>
            <button class="cloud-modal-close" id="cloud-play-close" aria-label="Close">✕</button>
          </div>
          <p id="cloud-play-desc" style="color:var(--muted);font-size:13px;line-height:1.5;margin:4px 0 12px"></p>
          <div style="display:flex;gap:8px;margin-bottom:10px">
            <input type="text" id="cloud-play-url" readonly
                   style="flex:1;background:var(--sidebar-bg2);border:1px solid var(--border);color:var(--parchment);padding:8px;border-radius:5px;font-size:12px">
            <button class="btn primary" id="cloud-play-copy">Copy</button>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" id="cloud-play-open">▶ Open</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.querySelector('.auth-backdrop').addEventListener('click', () => modal.classList.add('hidden'));
      document.getElementById('cloud-play-close').addEventListener('click', () => modal.classList.add('hidden'));
      document.getElementById('cloud-play-copy').addEventListener('click', async () => {
        const inp = document.getElementById('cloud-play-url');
        inp.select();
        try { await navigator.clipboard.writeText(inp.value); _toast('Link copied'); }
        catch { try { document.execCommand('copy'); _toast('Link copied'); } catch {} }
      });
      document.getElementById('cloud-play-open').addEventListener('click', () => {
        window.open(document.getElementById('cloud-play-url').value, '_blank', 'noopener');
      });
    }
    document.getElementById('cloud-play-desc').textContent =
      `Share this link to play on "${name}". It opens the map with tokens, a ruler and dice — no editing.`;
    const inp = document.getElementById('cloud-play-url');
    inp.value = url;
    modal.classList.remove('hidden');
    inp.focus(); inp.select();
    navigator.clipboard?.writeText(url).then(() => _toast('Play link copied')).catch(() => {});
  }

  async function _createPlayLink(mapId, name) {
    if (!DM.Auth.state.isLoggedIn) { DM.Auth.showModal(); return; }

    DM.UI?.showLoader?.('Building play link…');

    const backupJson = DM.State.serialize();
    const backupId   = DM.State.current._cloudMapId;
    const backupName = DM.State.current._cloudMapName;
    let swapped = false, url = null;

    try {
      const loaded = await _api(`${MAPS_API}?id=${mapId}`);
      if (!loaded.success) throw new Error(loaded.error || 'Map not found.');

      DM.State.deserialize(JSON.stringify(loaded.map.data));
      swapped = true;
      await DM.IO.warmCache();

      url = await _doUploadPlayLink(mapId, name || loaded.map.name);
    } catch (err) {
      _toast('Play link failed: ' + err.message, true);
    } finally {
      if (swapped) {
        try {
          DM.State.deserialize(backupJson);
          DM.State.current._cloudMapId   = backupId;
          DM.State.current._cloudMapName = backupName;
          await DM.IO.warmCache();
          DM.Renderer.resizeCanvas();
          DM.Renderer.render();
          DM.Renderer.startDecalAnim?.();
          DM.UI?.updateLayersPanel?.();
          DM.UI?.updateProperties?.();
          DM.UI?.syncMapSizeInputs?.();
          DM.UI?.syncBgPicker?.();
          DM.UI?.syncGridControls?.();
        } catch (e) { console.error('[Cloud] play-link restore failed:', e); }
      }
      DM.UI?.hideLoader?.();
    }

    if (url) _showPlayLinkModal(url, name);
  }

  async function _createPlayLinkCurrent() {
    if (!DM.Auth.state.isLoggedIn) { DM.Auth.showModal(); return; }

    const name = DM.State.current._cloudMapName || 'Battle Map';
    DM.UI?.showLoader?.('Building play link…');
    let url = null;
    try {
      url = await _doUploadPlayLink(DM.State.current._cloudMapId || null, name);
    } catch (err) {
      _toast('Play link failed: ' + err.message, true);
    } finally {
      DM.UI?.hideLoader?.();
    }
    if (url) _showPlayLinkModal(url, name);
  }

  async function _promptAndSave() {
    const current = DM.State.current;
    const default_ = current._cloudMapName || 'Untitled Map';
    const name     = prompt('Map name:', default_);
    if (name === null) return;

    const trimmed = name.trim();
    if (!trimmed) return;

    current._cloudMapName = trimmed;

    const btn = document.getElementById('cloud-btn-save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    try {
      await _saveMap(trimmed);
      _toast('Map saved!');
      _refreshMapList();
    } catch (err) {
      _toast('Save failed: ' + err.message, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save Current Map'; }
    }
  }

  async function _saveMap(name) {
    const current    = DM.State.current;
    const data       = JSON.parse(DM.State.serialize());
    const existingId = current._cloudMapId ?? null;
    const body       = { name, data };

    let res;
    if (existingId) {
      res = await _api(`${MAPS_API}?id=${existingId}`, 'PUT', body);
    } else {
      res = await _api(MAPS_API, 'POST', body);
      if (res.success) current._cloudMapId = res.id;
    }

    if (!res.success) throw new Error(res.error);
    DM.track?.('save_map_cloud');
    return res;
  }

  async function _refreshMapList() {
    const listEl = document.getElementById('cloud-map-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="cloud-loading">Loading…</p>';

    const res = await _api(MAPS_API);

    if (!res.success) {
      listEl.innerHTML = `<p class="cloud-empty error">${_esc(res.error)}</p>`;
      return;
    }

    if (res.limits) {
      const counterEl = document.getElementById('cloud-map-counter');
      if (counterEl) {
        const max = res.limits.map_limit === -1 ? '∞' : res.limits.map_limit;
        counterEl.textContent = `${res.maps.length} / ${max} maps · ${_esc(res.limits.tier_label)}`;
      }
    }

    if (!res.maps.length) {
      listEl.innerHTML = '<p class="cloud-empty">No saved maps yet.</p>';
      return;
    }

    listEl.innerHTML = '';
    for (const map of res.maps) {
      const isActive = map.id === (DM.State.current._cloudMapId ?? null);
      const row      = document.createElement('div');
      row.className  = 'cloud-row' + (isActive ? ' active' : '');
      row.innerHTML  = `
        <div class="cloud-row-info">
          <span class="cloud-row-name">${_esc(map.name)}</span>
          <span class="cloud-row-meta">${_date(map.updated_at)}</span>
        </div>
        <div class="cloud-row-actions">
          <button class="btn small" data-action="play"   data-id="${map.id}" data-name="${_esc(map.name)}" title="Get a play link for this map">🎲 Play</button>
          <button class="btn small" data-action="load"   data-id="${map.id}" title="Load map">📂 Load</button>
          <button class="btn small" data-action="rename" data-id="${map.id}" data-name="${_esc(map.name)}" title="Rename">✏</button>
          <button class="btn small danger" data-action="delete" data-id="${map.id}" data-name="${_esc(map.name)}" title="Delete">🗑</button>
        </div>
      `;
      listEl.appendChild(row);
    }

    listEl.addEventListener('click', _handleMapListClick);
  }

  async function _handleMapListClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.currentTarget.removeEventListener('click', _handleMapListClick);

    const { action, id, name } = btn.dataset;
    const mapId = parseInt(id, 10);

    if (action === 'play') {
      await _createPlayLink(mapId, name);
      _refreshMapList();
      return;

    } else if (action === 'load') {
      if (!confirm(`Load "${name}"?\nUnsaved changes will be lost.`)) {
        _refreshMapList(); return;
      }
      btn.disabled    = true;
      btn.textContent = 'Loading…';
      try {
        await _loadMap(mapId);
        document.getElementById('cloud-map-modal')?.classList.add('hidden');
        _toast(`"${name}" loaded`);
      } catch (err) {
        _toast('Load failed: ' + err.message, true);
        _refreshMapList();
      }

    } else if (action === 'rename') {
      const newName = prompt('New name:', name);
      if (!newName?.trim()) { _refreshMapList(); return; }
      const res = await _api(`${MAPS_API}?id=${mapId}`, 'PUT', {
        name: newName.trim(),
        data: JSON.parse(DM.State.serialize()),
      });
      if (res.success) {
        if (mapId === (DM.State.current._cloudMapId ?? null)) {
          DM.State.current._cloudMapName = newName.trim();
        }
        _toast('Renamed');
      } else {
        _toast('Rename failed: ' + res.error, true);
      }
      _refreshMapList();

    } else if (action === 'delete') {
      if (!confirm(`Delete "${name}"?\nThis cannot be undone.`)) {
        _refreshMapList(); return;
      }
      const res = await _api(`${MAPS_API}?id=${mapId}`, 'DELETE');
      if (res.success) {
        if (mapId === (DM.State.current._cloudMapId ?? null)) {
          DM.State.current._cloudMapId   = null;
          DM.State.current._cloudMapName = null;
        }
        _toast('Map deleted');
      } else {
        _toast('Delete failed: ' + res.error, true);
      }
      _refreshMapList();
    }
  }

  async function _loadMap(id) {
    DM.UI?.showLoader('Loading map from cloud…');
    try {
      const res = await _api(`${MAPS_API}?id=${id}`);
      if (!res.success) throw new Error(res.error);

      const map = res.map;
      DM.State.deserialize(JSON.stringify(map.data));

      DM.State.current._cloudMapId   = map.id;
      DM.State.current._cloudMapName = map.name;

      await DM.IO.warmCache();
      DM.Renderer.resizeCanvas();
      DM.Renderer.render();
      DM.Renderer.startDecalAnim?.();
      DM.UI.rebuildSidebar();
      DM.UI.updateAssetList();
      DM.UI.updateProperties();
      DM.UI.syncMapSizeInputs();
      DM.UI.syncBgPicker();
      DM.UI.syncGridControls();
    } finally {
      DM.UI?.hideLoader();
    }
  }

  async function quickSave() {
    if (!DM.Auth.state.isLoggedIn) { DM.Auth.showModal(); return; }

    const current = DM.State.current;
    if (!current._cloudMapName) {
      showMapManager();
      return;
    }

    DM.UI?.showLoader('Saving to cloud…');
    try {
      await _saveMap(current._cloudMapName);
      _toast('Map saved!');
    } catch (err) {
      _toast('Save failed: ' + err.message, true);
    } finally {
      DM.UI?.hideLoader();
    }
  }

  function showAssetManager() {
    if (!DM.Auth.state.isLoggedIn) { DM.Auth.showModal(); return; }

    let modal = document.getElementById('cloud-asset-modal');
    if (!modal) modal = _buildAssetModal();

    modal.classList.remove('hidden');
    _refreshCategoryDropdown();
    _refreshAssetList();
  }

  let _myAssetsCache = null;

  function _selectedCat() {
    return document.getElementById('cloud-upload-cat')?.value ?? '';
  }

  function _selectedCatName() {
    const sel = document.getElementById('cloud-upload-cat');
    if (!sel || !sel.value || sel.value === 'none') return null;
    return sel.options[sel.selectedIndex]?.textContent ?? null;
  }

  function _closeCatForms() {
    for (const id of ['cloud-newcat-form', 'cloud-rencat-form', 'cloud-delcat-confirm']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
  }

  function _syncCatUI() {
    const isReal = _selectedCatName() !== null;
    const ren = document.getElementById('cloud-rencat-btn');
    const del = document.getElementById('cloud-delcat-btn');
    if (ren) ren.disabled = !isReal;
    if (del) del.disabled = !isReal;
    _closeCatForms();   // any open form belonged to the previous selection
    _renderAssetList();
  }

  async function _refreshCategoryDropdown() {
    const sel = document.getElementById('cloud-upload-cat');
    if (!sel) return;
    const prevVal = sel.value;
    while (sel.options.length > 2) sel.remove(2);
    const res = await _api(_base + '/api/asset-categories.php');
    if (!res.success) { _syncCatUI(); return; }
    for (const cat of (res.my_categories || [])) {
      if (!cat.name) continue; // skip malformed rows
      const opt = document.createElement('option');
      opt.value       = cat.id;
      opt.textContent = cat.name;
      sel.appendChild(opt);
    }
    if (prevVal) sel.value = prevVal;
    if (sel.selectedIndex < 0) sel.value = '';
    _syncCatUI();
  }

  function _buildAssetModal() {
    const modal = document.createElement('div');
    modal.id        = 'cloud-asset-modal';
    modal.className = 'auth-modal hidden';
    modal.innerHTML = `
      <div class="auth-backdrop"></div>
      <div class="auth-box wide">
        <div class="cloud-modal-header">
          <h2>My Assets</h2>
          <button class="cloud-modal-close" id="cloud-asset-close" aria-label="Close">✕</button>
        </div>

        <div class="cloud-toolbar">
          <select id="cloud-upload-cat" style="background:var(--sidebar-bg2);border:1px solid var(--border);color:var(--parchment);padding:4px 6px;border-radius:3px;font-size:12px">
            <option value="">All assets</option>
            <option value="none">Uncategorised</option>
          </select>
          <button class="btn" id="cloud-newcat-btn" title="New category" style="padding:4px 8px">+</button>
          <button class="btn" id="cloud-rencat-btn" title="Rename selected category" style="padding:4px 8px" disabled>✎</button>
          <button class="btn" id="cloud-delcat-btn" title="Delete selected category" style="padding:4px 8px" disabled>🗑</button>
          <button class="btn primary" id="cloud-btn-upload">📤 Upload Image</button>
          <input  type="file" id="cloud-upload-input" accept="image/*" multiple style="display:none">
          <span class="cloud-hint">JPG · PNG · GIF · WebP · SVG — max 500 KB</span>
        </div>

        <div id="cloud-cat-label" style="padding:2px 0 8px;font-size:13px;color:var(--parchment);font-weight:600"></div>

        <div id="cloud-newcat-form" style="display:none;align-items:center;gap:6px;padding:6px 0">
          <input type="text" id="cloud-newcat-input" placeholder="Category name…" maxlength="80"
                 style="background:var(--sidebar-bg2);border:1px solid var(--border);color:var(--parchment);padding:4px 8px;border-radius:3px;font-size:12px;flex:1">
          <button class="btn primary" id="cloud-newcat-ok" style="padding:4px 10px">✓</button>
          <button class="btn"         id="cloud-newcat-cancel" style="padding:4px 10px">✕</button>
        </div>

        <div id="cloud-rencat-form" style="display:none;align-items:center;gap:6px;padding:6px 0">
          <input type="text" id="cloud-rencat-input" placeholder="New category name…" maxlength="80"
                 style="background:var(--sidebar-bg2);border:1px solid var(--border);color:var(--parchment);padding:4px 8px;border-radius:3px;font-size:12px;flex:1">
          <button class="btn primary" id="cloud-rencat-ok" style="padding:4px 10px">✓</button>
          <button class="btn"         id="cloud-rencat-cancel" style="padding:4px 10px">✕</button>
        </div>

        <div id="cloud-delcat-confirm" style="display:none;align-items:center;gap:8px;padding:6px 0;font-size:12px">
          <span id="cloud-delcat-text" style="flex:1;color:var(--muted)"></span>
          <button class="btn danger" id="cloud-delcat-yes" style="padding:4px 10px">Delete</button>
          <button class="btn"        id="cloud-delcat-no"  style="padding:4px 10px">Cancel</button>
        </div>

        <div id="cloud-asset-list" class="cloud-list cloud-asset-grid">
          <p class="cloud-loading">Loading…</p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.auth-backdrop')
         .addEventListener('click', () => modal.classList.add('hidden'));
    document.getElementById('cloud-asset-close')
            .addEventListener('click', () => modal.classList.add('hidden'));

    const newCatForm   = document.getElementById('cloud-newcat-form');
    const newCatInput  = document.getElementById('cloud-newcat-input');
    const newCatOk     = document.getElementById('cloud-newcat-ok');
    const newCatCancel = document.getElementById('cloud-newcat-cancel');

    document.getElementById('cloud-newcat-btn').addEventListener('click', () => {
      newCatForm.style.display = 'flex';
      newCatInput.focus();
    });

    newCatCancel.addEventListener('click', () => {
      newCatForm.style.display = 'none';
      newCatInput.value = '';
    });

    newCatOk.addEventListener('click', async () => {
      const name = newCatInput.value.trim();
      if (!name) return;

      newCatOk.disabled = true;
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
      let res;
      try {
        const r = await fetch(_base + '/api/asset-categories.php', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ name, personal: true }),
        });
        res = await r.json();
      } catch {
        _toast('Network error — could not create category.', true);
        newCatOk.disabled = false;
        return;
      }

      newCatOk.disabled = false;
      if (res.success) {
        const cat = { id: res.id, name: res.name, slug: res.slug };
        const sel = document.getElementById('cloud-upload-cat');
        const opt = document.createElement('option');
        opt.value       = cat.id;
        opt.textContent = cat.name;
        sel.appendChild(opt);
        sel.value = cat.id;
        DM.UI.addMyCategory(cat);
        newCatInput.value = '';
        newCatForm.style.display = 'none';
        _syncCatUI();
        _toast(`Category "${cat.name}" created`);
      } else {
        _toast(res.error || 'Could not create category.', true);
      }
    });

    newCatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  newCatOk.click();
      if (e.key === 'Escape') newCatCancel.click();
    });

    document.getElementById('cloud-upload-cat').addEventListener('change', _syncCatUI);

    const renForm   = document.getElementById('cloud-rencat-form');
    const renInput  = document.getElementById('cloud-rencat-input');
    const renOk     = document.getElementById('cloud-rencat-ok');
    const renCancel = document.getElementById('cloud-rencat-cancel');

    document.getElementById('cloud-rencat-btn').addEventListener('click', () => {
      const name = _selectedCatName();
      if (name === null) return;
      _closeCatForms();
      renForm.style.display = 'flex';
      renInput.value = name;
      renInput.focus();
      renInput.select();
    });

    renCancel.addEventListener('click', () => { renForm.style.display = 'none'; });

    renOk.addEventListener('click', async () => {
      const sel     = document.getElementById('cloud-upload-cat');
      const id      = sel.value;
      const name    = renInput.value.trim();
      const oldName = _selectedCatName();
      if (!id || id === 'none' || !name) return;
      if (name === oldName) { renForm.style.display = 'none'; return; }

      renOk.disabled = true;
      const res = await _api(`${_base}/api/asset-categories.php?id=${encodeURIComponent(id)}`, 'PUT', { name });
      renOk.disabled = false;

      if (res.success) {
        sel.options[sel.selectedIndex].textContent = name;
        DM.UI.renameMyCategory?.(Number(id), name);
        renForm.style.display = 'none';
        _syncCatUI();
        _toast(`Renamed to "${name}"`);
      } else {
        _toast(res.error || 'Could not rename the category.', true);
      }
    });

    renInput.addEventListener('keydown', e => {
      if (e.key === 'Enter')  renOk.click();
      if (e.key === 'Escape') renCancel.click();
    });

    const delConfirm = document.getElementById('cloud-delcat-confirm');
    const delText    = document.getElementById('cloud-delcat-text');
    const delYes     = document.getElementById('cloud-delcat-yes');
    const delNo      = document.getElementById('cloud-delcat-no');

    document.getElementById('cloud-delcat-btn').addEventListener('click', () => {
      const name = _selectedCatName();
      if (name === null) return;
      _closeCatForms();
      delText.textContent = `Delete "${name}"? Your assets are kept — they simply become uncategorised.`;
      delConfirm.style.display = 'flex';
    });

    delNo.addEventListener('click', () => { delConfirm.style.display = 'none'; });

    delYes.addEventListener('click', async () => {
      const sel  = document.getElementById('cloud-upload-cat');
      const id   = sel.value;
      const name = _selectedCatName();
      if (!id || id === 'none') return;

      delYes.disabled = true;
      const res = await _api(`${_base}/api/asset-categories.php?id=${encodeURIComponent(id)}`, 'DELETE');
      delYes.disabled = false;

      if (res.success) {
        sel.remove(sel.selectedIndex);
        sel.value = '';                       // fall back to "All assets"
        DM.UI.removeMyCategory?.(Number(id));
        delConfirm.style.display = 'none';
        await _refreshAssetList();
        _syncCatUI();
        _toast(`Category "${name}" deleted`);
      } else {
        _toast(res.error || 'Could not delete the category.', true);
      }
    });

    const uploadBtn   = document.getElementById('cloud-btn-upload');
    const uploadInput = document.getElementById('cloud-upload-input');

    uploadBtn.addEventListener('click', () => uploadInput.click());
    uploadInput.addEventListener('change', async () => {
      const files = Array.from(uploadInput.files);
      if (!files.length) return;
      const rawCat = document.getElementById('cloud-upload-cat')?.value || '';
      const catId  = rawCat === 'none' ? '' : rawCat;
      uploadBtn.disabled    = true;
      uploadBtn.textContent = 'Uploading…';
      let ok = 0, fail = 0;
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        if (catId) fd.append('category_id', catId);
        const res = await _api(ASSETS_API, 'POST', fd);
        if (res.success) {
          ok++;
          const a = res.asset;
          if (a && !DM.State.getAsset(a.id)) {
            DM.State.addAsset({
              id:         a.id,
              name:       a.original_name,
              src:        a.url,
              categoryId: a.category_id ?? null,
              isSystem:   0,
            });
          }
        } else {
          fail++;
        }
      }
      uploadInput.value     = '';
      uploadBtn.disabled    = false;
      uploadBtn.textContent = '📤 Upload Image';
      _toast(ok + ' file(s) uploaded' + (fail ? ` (${fail} failed)` : ''), fail > 0);
      if (ok > 0) DM.UI?.updateAssetList();
      _refreshAssetList();
    });

    return modal;
  }

  async function _refreshAssetList() {
    const listEl = document.getElementById('cloud-asset-list');
    if (!listEl) return;
    listEl.innerHTML = '<p class="cloud-loading">Loading…</p>';

    const res = await _api(ASSETS_API);
    if (!res.success) {
      listEl.innerHTML = `<p class="cloud-empty error">${_esc(res.error)}</p>`;
      return;
    }
    _myAssetsCache = res.my_assets || [];
    _renderAssetList();
  }

  function _renderAssetList() {
    const listEl  = document.getElementById('cloud-asset-list');
    const labelEl = document.getElementById('cloud-cat-label');
    if (!listEl) return;

    const val     = _selectedCat();
    const catName = _selectedCatName();
    const all     = _myAssetsCache || [];

    const assets = val === ''
      ? all
      : val === 'none'
        ? all.filter(a => a.category_id === null || a.category_id === undefined)
        : all.filter(a => String(a.category_id) === String(val));

    if (labelEl) {
      const scope = catName !== null ? catName : (val === 'none' ? 'Uncategorised' : 'All assets');
      labelEl.textContent = _myAssetsCache === null
        ? scope
        : `${scope} · ${assets.length} ${assets.length === 1 ? 'asset' : 'assets'}`;
    }

    if (_myAssetsCache === null) return;

    if (!assets.length) {
      listEl.innerHTML = catName !== null
        ? `<p class="cloud-empty">No assets in “${_esc(catName)}” yet — upload with this category selected.</p>`
        : val === 'none'
          ? '<p class="cloud-empty">No uncategorised assets.</p>'
          : '<p class="cloud-empty">No uploaded assets yet.</p>';
      return;
    }

    listEl.innerHTML = '';
    for (const asset of assets) {
      const card = document.createElement('div');
      card.className = 'cloud-asset-card';
      card.innerHTML = `
        <div class="cloud-asset-thumb" style="background-image:url('${asset.url}')"></div>
        <div class="cloud-asset-info">
          <span class="cloud-asset-name" title="${_esc(asset.original_name)}">${_esc(asset.original_name)}</span>
          <span class="cloud-asset-size">${_bytes(asset.file_size)}</span>
        </div>
        <div class="cloud-asset-actions">
          <button class="btn small" data-use="${_esc(asset.url)}" data-name="${_esc(asset.original_name)}" title="Use in map">+ Use</button>
          <button class="btn small danger" data-del="${asset.id}" title="Delete">🗑</button>
        </div>
      `;

      card.querySelector('[data-use]').addEventListener('click', async e => {
        const url      = e.currentTarget.dataset.use;
        const assetName = e.currentTarget.dataset.name;
        const id       = 'cloud_' + asset.id;
        if (!DM.State.getAsset(id)) {
          DM.State.addAsset({ id, name: assetName, src: url, _img: null });
          await DM.IO.warmCache();
        }
        DM.UI.updateAssetList();
        document.getElementById('cloud-asset-modal')?.classList.add('hidden');
        _toast(`"${assetName}" added to asset list`);
      });

      card.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm(`Delete "${asset.original_name}"?`)) return;
        const res = await _api(`${ASSETS_API}?id=${asset.id}`, 'DELETE');
        if (res.success) {
          DM.State.removeAsset('cloud_' + asset.id);
          DM.UI.updateAssetList();
          _toast('Asset deleted');
        } else {
          _toast('Delete failed: ' + res.error, true);
        }
        _refreshAssetList();
      });

      listEl.appendChild(card);
    }
  }

  document.getElementById('btn-play')
          ?.addEventListener('click', () => _createPlayLinkCurrent());

  return { showMapManager, showAssetManager, quickSave, createPlayLinkCurrent: _createPlayLinkCurrent };

})();


window.DM = window.DM || {};

DM.Feedback = (() => {
  'use strict';

  let _kind = 'bug';

  function _csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  function _selectKind(btn) {
    document.querySelectorAll('.fb-kind-btn')
            .forEach(b => b.classList.toggle('active', b === btn));
    _kind = btn.dataset.kind;
  }

  async function _submit(e) {
    e.preventDefault();

    const msgEl   = document.getElementById('fb-message');
    const mailEl  = document.getElementById('fb-email');
    const hpEl    = document.getElementById('fb-hp');
    const btn     = document.getElementById('fb-submit');
    const message = msgEl.value.trim();

    if (message.length < 10) {
      DM.toast?.('Please describe it in a few words.', true);
      msgEl.focus();
      return;
    }

    const label = btn.textContent;
    btn.disabled    = true;
    btn.textContent = 'Sending…';

    try {
      const res = await fetch((window.TMB_BASE || '') + '/api/feedback.php', {
        method:      'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': _csrfToken(),
        },
        body: JSON.stringify({
          kind:    _kind,
          message,
          email:   mailEl.value.trim(),
          _hp:     hpEl.value,
        }),
      });
      const data = await res.json();

      if (data.success) {
        msgEl.value  = '';
        mailEl.value = '';
        DM.track?.('submit_feedback', { type: _kind });
        DM.toast?.('Thanks — your feedback was sent.');
      } else {
        DM.toast?.(data.error || 'Could not send your feedback.', true);
      }
    } catch {
      DM.toast?.('Network error — please try again.', true);
    } finally {
      btn.disabled    = false;
      btn.textContent = label;
    }
  }

  return {
    init() {
      const form = document.getElementById('feedback-form');
      if (!form) return;

      form.addEventListener('submit', _submit);
      document.querySelectorAll('.fb-kind-btn')
              .forEach(b => b.addEventListener('click', () => _selectKind(b)));
    },
  };
})();

'use strict';
window.DM = window.DM || {};

DM.Share = (() => {
  let _blob         = null;   // PNG Blob of the current render
  let _blobUrl      = null;   // object URL for preview / download
  let _publishedUrl = null;   // public share page URL (set after publish)
  const _tags       = new Set();
  let _acTimer      = null;   // autocomplete debounce handle
  let _acSeq        = 0;      // sequence counter to discard stale responses

  function _sanitizeTag(raw) {
    return raw.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }

  function _renderTags(modal) {
    const container = modal.querySelector('#share-tags');
    container.innerHTML = '';
    for (const tag of _tags) {
      const chip   = document.createElement('span');
      chip.className = 'share-tag';
      const label  = document.createElement('span');
      label.textContent = tag;
      const btn    = document.createElement('button');
      btn.className   = 'share-tag-remove';
      btn.textContent = '×';
      btn.setAttribute('aria-label', 'Remove ' + tag);
      btn.addEventListener('click', () => { _tags.delete(tag); _renderTags(modal); _syncPresets(modal); });
      chip.append(label, btn);
      container.appendChild(chip);
    }
  }

  function _syncPresets(modal) {
    modal.querySelectorAll('.share-tag-preset').forEach(btn => {
      btn.classList.toggle('active', _tags.has(btn.dataset.tag));
    });
  }

  function _addTag(raw, modal) {
    const tag = _sanitizeTag(raw);
    if (!tag || _tags.size >= 10 || _tags.has(tag)) return false;
    _tags.add(tag);
    _renderTags(modal);
    _syncPresets(modal);
    return true;
  }

  function _hideSuggestions(modal) {
    modal.querySelector('#share-tag-suggestions')?.classList.add('hidden');
  }

  function _renderSuggestions(modal, tags) {
    const box = modal.querySelector('#share-tag-suggestions');
    if (!box) return;
    const available = tags.filter(t => !_tags.has(t));
    if (!available.length) { box.classList.add('hidden'); return; }
    box.innerHTML = '';
    for (const tag of available) {
      const item = document.createElement('div');
      item.className = 'share-tag-suggestion';
      item.textContent = tag;
      item.addEventListener('mousedown', e => {
        e.preventDefault(); // keep focus on input
        if (_addTag(tag, modal)) modal.querySelector('#share-tag-input').value = '';
        _hideSuggestions(modal);
      });
      box.appendChild(item);
    }
    box.classList.remove('hidden');
  }

  async function _fetchSuggestions(modal, q) {
    const seq = ++_acSeq;
    try {
      const res  = await fetch('api/tags.php?q=' + encodeURIComponent(q));
      const data = await res.json();
      if (seq !== _acSeq) return; // stale response — a newer request is in flight
      if (Array.isArray(data.tags)) _renderSuggestions(modal, data.tags);
    } catch {  }
  }

  function _cleanup() {
    if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
    _blob         = null;
    _publishedUrl = null;
  }

  function _close() {
    document.getElementById('share-modal')?.classList.add('hidden');
    _cleanup();
  }

  async function _renderBlob() {
    const dataUrl = DM.IO._renderClean('image/png');
    const res     = await fetch(dataUrl);
    return res.blob();
  }

  function _toSlug(title) {
    return title.trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s\-]/g, '')
      .replace(/[\s\-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200) || 'dungeon-map';
  }

  function _updateSlugPreview(modal) {
    const input   = modal.querySelector('#share-title');
    const preview = modal.querySelector('#share-slug-preview');
    if (!input || !preview) return;
    const raw = input.value.trim();
    if (!raw) {
      preview.textContent = '';
      return;
    }
    preview.textContent = 'dungeonmapbuilder.com/map/' + _toSlug(raw);
  }

  function _platformUrls(shareUrl, title) {
    const url       = encodeURIComponent(shareUrl);
    const titleText = title ? `"${title}" ` : '';
    const msg       = encodeURIComponent(`I just made a dungeon map ${titleText}with Dungeon Map Builder! ⚔️ #DnD #TTRPG #dungeon`);
    const shareTitle = encodeURIComponent((title || 'My Dungeon Map') + ' — Dungeon Map Builder');
    return {
      x:         `https://twitter.com/intent/tweet?text=${msg}&url=${url}`,
      facebook:  `https://www.facebook.com/sharer/sharer.php?u=${url}`,
      whatsapp:  `https://wa.me/?text=${msg}%20${url}`,
      telegram:  `https://t.me/share/url?url=${url}&text=${msg}`,
      reddit:    `https://www.reddit.com/submit?title=${shareTitle}&url=${url}`,
    };
  }

  function _updatePlatformButtons(shareUrl, title) {
    const modal = document.getElementById('share-modal');
    if (!modal) return;
    const urls = _platformUrls(shareUrl, title);
    modal.querySelector('#share-btn-x')        ._shareUrl = urls.x;
    modal.querySelector('#share-btn-facebook') ._shareUrl = urls.facebook;
    modal.querySelector('#share-btn-whatsapp') ._shareUrl = urls.whatsapp;
    modal.querySelector('#share-btn-telegram') ._shareUrl = urls.telegram;
    modal.querySelector('#share-btn-reddit')   ._shareUrl = urls.reddit;
  }

  async function open() {
    const modal   = document.getElementById('share-modal');
    const btnOpen = document.getElementById('btn-share');
    if (!modal) return;

    if (btnOpen) btnOpen.disabled = true;
    try {
      _cleanup();
      _blob    = await _renderBlob();
      _blobUrl = URL.createObjectURL(_blob);
    } finally {
      if (btnOpen) btnOpen.disabled = false;
    }

    modal.querySelector('#share-preview').src              = _blobUrl;
    modal.querySelector('#share-title').value              = DM.State.current.name || '';
    modal.querySelector('#share-link-wrap').hidden         = true;
    modal.querySelector('#share-btn-publish').disabled     = false;
    modal.querySelector('#share-btn-publish').textContent  = '⤴ Publish & Get Link';
    modal.querySelector('#share-publish-status').textContent = '';

    _tags.clear();
    modal.querySelector('#share-tag-input').value = '';
    _renderTags(modal);
    _syncPresets(modal);
    _hideSuggestions(modal);

    _updateSlugPreview(modal);

    const file          = new File([_blob], 'dungeon-map.png', { type: 'image/png' });
    const canShareFiles = navigator.canShare?.({ files: [file] }) ?? false;
    modal.querySelector('#share-btn-native').hidden = !canShareFiles;

    _updatePlatformButtons(window.location.origin + window.location.pathname);

    modal.classList.remove('hidden');
  }

  function _bind() {
    const modal = document.getElementById('share-modal');
    if (!modal) return;

    document.getElementById('btn-share')?.addEventListener('click', open);

    modal.querySelector('.modal-backdrop').addEventListener('click', _close);
    modal.querySelector('#share-close').addEventListener('click', _close);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) _close();
    });

    modal.querySelector('#share-title')?.addEventListener('input', () => _updateSlugPreview(modal));

    modal.querySelectorAll('.share-tag-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const tag = btn.dataset.tag;
        if (_tags.has(tag)) {
          _tags.delete(tag);
          _renderTags(modal);
          _syncPresets(modal);
        } else {
          _addTag(tag, modal);
        }
      });
    });

    const tagInput = modal.querySelector('#share-tag-input');
    const tagAdd   = modal.querySelector('#share-tag-add');

    tagAdd.addEventListener('click', () => {
      if (_addTag(tagInput.value, modal)) tagInput.value = '';
      _hideSuggestions(modal);
    });

    tagInput.addEventListener('input', () => {
      const val = _sanitizeTag(tagInput.value);
      clearTimeout(_acTimer);
      if (!val) { _hideSuggestions(modal); return; }
      _acTimer = setTimeout(() => _fetchSuggestions(modal, val), 200);
    });

    tagInput.addEventListener('focus', () => {
      const val = _sanitizeTag(tagInput.value);
      if (val) _fetchSuggestions(modal, val);
    });

    tagInput.addEventListener('blur', () => {
      setTimeout(() => _hideSuggestions(modal), 150);
    });

    tagInput.addEventListener('keydown', e => {
      const box     = modal.querySelector('#share-tag-suggestions');
      const isOpen  = box && !box.classList.contains('hidden');
      const items   = isOpen ? box.querySelectorAll('.share-tag-suggestion') : [];
      const focused = isOpen ? box.querySelector('.share-tag-suggestion.focused') : null;
      let   idx     = focused ? [...items].indexOf(focused) : -1;

      if (e.key === 'ArrowDown' && isOpen) {
        e.preventDefault();
        focused?.classList.remove('focused');
        items[(idx + 1) % items.length].classList.add('focused');
        return;
      }
      if (e.key === 'ArrowUp' && isOpen) {
        e.preventDefault();
        focused?.classList.remove('focused');
        items[(idx - 1 + items.length) % items.length].classList.add('focused');
        return;
      }
      if (e.key === 'Escape') {
        _hideSuggestions(modal);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (focused) {
          if (_addTag(focused.textContent, modal)) tagInput.value = '';
          _hideSuggestions(modal);
        } else {
          if (_addTag(tagInput.value, modal)) tagInput.value = '';
          _hideSuggestions(modal);
        }
      }
    });

    modal.querySelector('#share-btn-copy').addEventListener('click', async () => {
      const btn = modal.querySelector('#share-btn-copy');
      btn.disabled = true;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': _blob })]);
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy Image'; btn.disabled = false; }, 2200);
      } catch {
        Object.assign(document.createElement('a'), { href: _blobUrl, download: 'dungeon-map.png' }).click();
        btn.disabled = false;
      }
    });

    modal.querySelector('#share-btn-native').addEventListener('click', async () => {
      try {
        const file = new File([_blob], 'dungeon-map.png', { type: 'image/png' });
        await navigator.share({
          files: [file],
          title: modal.querySelector('#share-title').value || 'My Dungeon Map',
          text:  'Check out my dungeon map made with Dungeon Map Builder! ⚔️ #DnD #TTRPG',
        });
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Share] Web Share failed:', e);
      }
    });

    modal.querySelector('#share-btn-download').addEventListener('click', () => {
      Object.assign(document.createElement('a'), { href: _blobUrl, download: 'dungeon-map.png' }).click();
    });

    modal.querySelector('#share-btn-publish').addEventListener('click', async () => {
      if (!DM.Auth.state.isLoggedIn) {
        _close();
        DM.Auth.showModal();
        return;
      }

      const btn    = modal.querySelector('#share-btn-publish');
      const status = modal.querySelector('#share-publish-status');
      const title  = modal.querySelector('#share-title').value.trim() || 'Dungeon Map';

      btn.disabled       = true;
      btn.textContent    = 'Publishing…';
      status.textContent = '';

      try {
        const form = new FormData();
        form.append('image', new File([_blob], 'dungeon-map.png', { type: 'image/png' }));
        form.append('title', title);
        form.append('tags',  JSON.stringify([..._tags]));

        const res  = await fetch('api/share-map.php', {
          method:  'POST',
          headers: { 'X-CSRF-Token': DM.Auth.state.csrfToken },
          body:    form,
        });
        const data = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));

        if (!data.success) throw new Error(data.error || 'Publish failed');

        DM.track?.('share_map');

        _publishedUrl = data.url;
        modal.querySelector('#share-link-url').value   = data.url;
        modal.querySelector('#share-link-wrap').hidden = false;
        _updatePlatformButtons(data.url, title);

        btn.textContent = '✓ Published';

        const preview = modal.querySelector('#share-slug-preview');
        if (preview) preview.textContent = '';

      } catch (err) {
        status.textContent = err.message;
        btn.disabled       = false;
        btn.textContent    = '⤴ Publish & Get Link';
      }
    });

    modal.querySelector('#share-btn-copy-link').addEventListener('click', async () => {
      const btn = modal.querySelector('#share-btn-copy-link');
      const url = modal.querySelector('#share-link-url').value;
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      } catch {
        modal.querySelector('#share-link-url').select();
      }
    });

    modal.querySelector('#share-btn-instagram').addEventListener('click', async () => {
      const btn = modal.querySelector('#share-btn-instagram');
      btn.disabled = true;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': _blob })]);
        btn.textContent = '✓ Copied — open app!';
        setTimeout(() => { btn.textContent = '📸 Instagram'; btn.disabled = false; }, 3000);
      } catch {
        Object.assign(document.createElement('a'), { href: _blobUrl, download: 'dungeon-map.png' }).click();
        btn.disabled = false;
      }
    });

    const platformConfigs = {
      'share-btn-x':        { w: 560, h: 420 },
      'share-btn-facebook': { w: 640, h: 480 },
      'share-btn-whatsapp': { w: 0,   h: 0   },
      'share-btn-telegram': { w: 600, h: 480 },
      'share-btn-reddit':   { w: 900, h: 680 },
    };
    for (const [id, cfg] of Object.entries(platformConfigs)) {
      modal.querySelector(`#${id}`)?.addEventListener('click', function () {
        if (!this._shareUrl) return;
        const spec = cfg.w ? `noopener,width=${cfg.w},height=${cfg.h}` : 'noopener';
        window.open(this._shareUrl, '_blank', spec);
      });
    }
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', _bind)
    : _bind();

  return { open };
})();
