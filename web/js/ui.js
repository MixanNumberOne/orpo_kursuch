const UI = (() => {
  let authMode = "login";
  let authSuccess = null;

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = `toast${kind ? ` ${kind}` : ""}`;
    el.textContent = message;
    document.getElementById("toasts").append(el);
    setTimeout(() => el.remove(), 3600);
  }

  function run(fn) {
    return Promise.resolve().then(fn).catch((err) => toast(err.message || "Ошибка", "error"));
  }

  function fmt(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? (iso || "") : date.toLocaleString("ru-RU");
  }

  function openAuth(message, onSuccess) {
    authSuccess = onSuccess || null;
    const modal = document.getElementById("modal-auth");
    document.getElementById("auth-message").textContent = message || "Войдите, чтобы открыть остальные возможности.";
    document.getElementById("auth-error").textContent = "";
    modal.hidden = false;
    document.getElementById("auth-username").focus();
  }

  function closeAuth() {
    document.getElementById("modal-auth").hidden = true;
    document.getElementById("auth-password").value = "";
    authSuccess = null;
  }

  function setAuthMode(mode) {
    authMode = mode;
    const register = mode === "register";
    document.getElementById("auth-title").textContent = register ? "Регистрация" : "Вход";
    document.getElementById("auth-submit").textContent = register ? "Создать аккаунт" : "Войти";
    document.getElementById("auth-mode").textContent = register ? "Уже есть аккаунт" : "Создать аккаунт";
    document.getElementById("auth-password").autocomplete = register ? "new-password" : "current-password";
  }

  async function submitAuth(event) {
    event.preventDefault();
    const username = document.getElementById("auth-username").value.trim();
    const password = document.getElementById("auth-password").value;
    const error = document.getElementById("auth-error");
    error.textContent = "";
    try {
      const data = authMode === "register"
        ? await API.register(username, password)
        : await API.login(username, password);
      App.user = data.user;
      renderAuth();
      await ensureTaxonomy();
      await loadAssets();
      await refreshNotes(false);
      const done = authSuccess;
      closeAuth();
      toast(authMode === "register" ? "Аккаунт создан" : "Вы вошли");
      if (done) await done();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  function renderAuth() {
    const box = document.getElementById("auth-box");
    box.innerHTML = "";
    const bell = document.getElementById("btn-bell");
    if (!App.user) {
      document.body.classList.remove("is-auth");
      bell.hidden = true;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.textContent = "Войти";
      button.addEventListener("click", () => openAuth());
      box.append(button);
    } else {
      document.body.classList.add("is-auth");
      bell.hidden = false;
      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = App.user.username;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn";
      button.textContent = "Выйти";
      button.addEventListener("click", () => run(() => Editor.logout()));
      box.append(name, button);
    }
    Editor.syncHistory();
  }

  function renderLayers() {
    const list = document.getElementById("layer-list");
    list.innerHTML = "";
    App.doc.layers.forEach((layer, index) => {
      const row = document.createElement("div");
      row.className = `layer${layer.id === App.doc.activeLayerId ? " active" : ""}`;
      row.addEventListener("click", () => {
        if (!App.user) { openAuth("Слои доступны после входа"); return; }
        App.doc.activeLayerId = layer.id;
        renderLayers();
        Editor.syncStatus();
      });
      const eye = iconButton(layer.visible ? "Скрыть" : "Показать", () => Editor.toggleLayer(layer.id, "visible"));
      eye.textContent = layer.visible ? "👁" : "🚫";
      const lock = iconButton(layer.locked ? "Разблокировать" : "Заблокировать", () => Editor.toggleLayer(layer.id, "locked"));
      lock.textContent = layer.locked ? "🔒" : "🔓";
      const name = document.createElement("input");
      name.value = layer.name;
      name.maxLength = 40;
      name.addEventListener("click", (event) => event.stopPropagation());
      name.addEventListener("focus", () => { if (App.user) IO.arm(App.doc); });
      name.addEventListener("input", () => {
        if (!App.user) return;
        layer.name = name.value.trim() || "Слой";
        Editor.markDirty();
      });
      name.addEventListener("blur", () => { if (IO.commit(App.doc)) Editor.syncHistory(); });
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = layer.kind === "tiles" ? "тайлы" : "объекты";
      row.append(
        eye, lock, name, kind,
        iconButton("Поверх", () => Editor.moveLayer(index, 1), "↑"),
        iconButton("Под", () => Editor.moveLayer(index, -1), "↓"),
        iconButton("Удалить слой", () => Editor.deleteLayer(layer.id), "✕"),
      );
      list.append(row);
    });
  }

  function iconButton(title, onClick, text) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn tiny";
    button.title = title;
    button.textContent = text || title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!App.user) { openAuth("Слои доступны после входа"); return; }
      onClick();
    });
    return button;
  }

  function syncGrid() {
    const grid = App.doc.grid;
    App.syncing = true;
    document.getElementById("grid-show").checked = grid.show !== false;
    document.getElementById("grid-cell").value = grid.cell;
    document.getElementById("grid-cell-val").textContent = grid.cell;
    document.getElementById("grid-ox").value = grid.offsetX;
    document.getElementById("grid-ox-val").textContent = grid.offsetX;
    document.getElementById("grid-oy").value = grid.offsetY;
    document.getElementById("grid-oy-val").textContent = grid.offsetY;
    document.getElementById("grid-color").value = /^#[0-9a-fA-F]{6}$/.test(grid.color) ? grid.color : "#d9c07a";
    App.syncing = false;
  }

  function renderTaxonomy() {
    const select = document.getElementById("map-folder");
    const current = App.folderId ? String(App.folderId) : "";
    select.innerHTML = `<option value="">Без папки</option>${App.folders.map((folder) => `<option value="${folder.id}">${escapeText(folder.name)}</option>`).join("")}`;
    select.value = App.folders.some((folder) => String(folder.id) === current) ? current : "";
    const box = document.getElementById("map-tags");
    box.innerHTML = "";
    if (!App.tags.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = App.user ? "Тегов пока нет. Их можно создать в библиотеке." : "Теги появятся после входа.";
      box.append(note);
      return;
    }
    for (const tag of App.tags) {
      const label = document.createElement("label");
      label.className = "check";
      label.dataset.auth = "Теги доступны после входа";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = tag.id;
      input.checked = App.tagIds.includes(tag.id);
      label.append(input, document.createTextNode(tag.name));
      box.append(label);
    }
  }

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  async function ensureTaxonomy() {
    if (!App.user) { App.folders = []; App.tags = []; renderTaxonomy(); return; }
    const [folders, tags] = await Promise.all([API.folders(), API.tags()]);
    App.folders = folders.items;
    App.tags = tags.items;
    renderTaxonomy();
  }

  function showInspector() {
    const found = IO.findItem(App.doc, App.selection);
    const box = document.getElementById("inspector");
    if (!found) { box.hidden = true; return; }
    box.hidden = false;
    App.syncing = true;
    document.getElementById("prop-text").value = found.item.text || "";
    document.getElementById("prop-desc").value = found.item.description || "";
    App.syncing = false;
  }

  function hideTooltip() {
    document.getElementById("tooltip").hidden = true;
  }

  function showTooltip(event, text) {
    const tip = document.getElementById("tooltip");
    tip.hidden = false;
    tip.textContent = text;
    tip.style.left = `${event.clientX + 14}px`;
    tip.style.top = `${event.clientY + 14}px`;
  }

  async function loadAssets() {
    if (!App.user) { App.assets = []; renderAssets(); return; }
    const data = await API.assets();
    App.assets = data.items;
    renderAssets();
  }

  function renderAssets() {
    const list = document.getElementById("asset-list");
    list.innerHTML = "";
    if (!App.assets.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = App.user ? "Своих файлов пока нет." : "Загрузка доступна после входа.";
      list.append(note);
      return;
    }
    for (const asset of App.assets) {
      const row = document.createElement("div");
      row.className = `asset${asset.id === App.selectedAssetId ? " selected" : ""}`;
      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", asset.id);
        event.dataTransfer.effectAllowed = "copy";
      });
      row.addEventListener("click", () => {
        App.selectedAssetId = asset.id;
        Editor.setTool("sprite");
        renderAssets();
      });
      const img = document.createElement("img");
      img.alt = asset.name;
      img.src = asset.src || `/api/assets/${asset.id}/file`;
      const name = document.createElement("span");
      name.textContent = asset.name;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn tiny danger";
      del.textContent = "✕";
      del.title = "Удалить из палитры";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        run(async () => {
          await API.deleteAsset(asset.id);
          App.assets = App.assets.filter((item) => item.id !== asset.id);
          renderAssets();
        });
      });
      row.append(img, name, del);
      list.append(row);
    }
  }

  async function loadLibrary() {
    await ensureTaxonomy();
    const data = await API.maps(App.libraryFolder, App.libraryTag);
    renderLibraryFilters();
    const box = document.getElementById("library-maps");
    box.innerHTML = "";
    if (!data.items.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Карт пока нет. Сохраните карту из редактора.";
      box.append(note);
      return;
    }
    for (const item of data.items) box.append(mapCard(item));
  }

  function renderLibraryFilters() {
    document.getElementById("folder-all").classList.toggle("active", App.libraryFolder === "all");
    document.getElementById("folder-root").classList.toggle("active", App.libraryFolder === "root");
    document.getElementById("tag-all").classList.toggle("active", !App.libraryTag);
    const folders = document.getElementById("library-folders");
    folders.innerHTML = "";
    for (const folder of App.folders) {
      const row = document.createElement("div");
      row.className = "row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = `btn side-nav${String(App.libraryFolder) === String(folder.id) ? " active" : ""}`;
      open.textContent = folder.name;
      open.addEventListener("click", () => { App.libraryFolder = String(folder.id); run(loadLibrary); });
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "btn tiny";
      rename.textContent = "Имя";
      rename.addEventListener("click", () => run(async () => {
        const name = prompt("Новое название папки", folder.name);
        if (name === null) return;
        await API.renameFolder(folder.id, name.trim());
        toast("Папка переименована");
        await loadLibrary();
      }));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn tiny danger";
      del.textContent = "✕";
      del.addEventListener("click", () => run(async () => {
        if (!confirm(`Удалить папку «${folder.name}»? Карты останутся в библиотеке.`)) return;
        await API.deleteFolder(folder.id);
        if (String(App.libraryFolder) === String(folder.id)) App.libraryFolder = "all";
        if (App.folderId === folder.id) App.folderId = null;
        toast("Папка удалена, карты перенесены в корень");
        await loadLibrary();
      }));
      row.append(open, rename, del);
      folders.append(row);
    }
    const tags = document.getElementById("library-tags");
    tags.innerHTML = "";
    for (const tag of App.tags) {
      const row = document.createElement("div");
      row.className = "row";
      const filter = document.createElement("button");
      filter.type = "button";
      filter.className = `btn side-nav${App.libraryTag === tag.id ? " active" : ""}`;
      filter.textContent = tag.name;
      filter.addEventListener("click", () => { App.libraryTag = tag.id; run(loadLibrary); });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn tiny danger";
      del.textContent = "✕";
      del.addEventListener("click", () => run(async () => {
        if (!confirm(`Удалить тег «${tag.name}»?`)) return;
        await API.deleteTag(tag.id);
        if (App.libraryTag === tag.id) App.libraryTag = null;
        App.tagIds = App.tagIds.filter((id) => id !== tag.id);
        await loadLibrary();
      }));
      row.append(filter, del);
      tags.append(row);
    }
  }

  function mapCard(item) {
    const card = document.createElement("article");
    card.className = "card";
    if (item.preview) {
      const img = document.createElement("img");
      img.alt = item.name;
      img.src = item.preview;
      card.append(img);
    } else {
      const empty = document.createElement("div");
      empty.className = "placeholder";
      empty.textContent = "Без превью";
      card.append(empty);
    }
    const pad = document.createElement("div");
    pad.className = "pad";
    const title = document.createElement("h3");
    title.textContent = item.name;
    const meta = document.createElement("p");
    meta.className = "muted";
    const tagNames = (item.tags || []).map((tag) => tag.name).join(", ");
    meta.textContent = `${fmt(item.updated_at)}${item.is_public ? " · публичная" : ""}${tagNames ? ` · ${tagNames}` : ""}`;
    const actions = document.createElement("div");
    actions.className = "row";
    actions.append(
      actionButton("Открыть", () => Editor.openMap(item.id)),
      actionButton("Дублировать", async () => {
        const copy = await API.duplicate(item.id);
        toast(`Создана «${copy.name}»`);
        await loadLibrary();
      }),
      actionButton("Удалить", async () => {
        if (!confirm(`Удалить карту «${item.name}»?`)) return;
        await API.deleteMap(item.id);
        if (App.mapId === item.id) Editor.resetDocument();
        toast("Карта удалена");
        await loadLibrary();
      }, true),
    );
    pad.append(title, meta, actions);
    card.append(pad);
    return card;
  }

  function actionButton(text, fn, danger) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn tiny${danger ? " danger" : ""}`;
    button.textContent = text;
    button.addEventListener("click", () => run(fn));
    return button;
  }

  async function refreshNotes(toggle) {
    if (!App.user) return;
    const data = await API.notifications();
    App.notes = data.items;
    document.getElementById("bell-count").textContent = data.items.length ? String(data.items.length) : "";
    const panel = document.getElementById("notif-panel");
    panel.innerHTML = "";
    if (!data.items.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Комментариев к вашим картам пока нет";
      panel.append(note);
    }
    for (const note of data.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "notif";
      const title = document.createElement("strong");
      title.textContent = `${note.author} · ${note.map_name}`;
      const text = document.createElement("span");
      text.textContent = note.text;
      const time = document.createElement("time");
      time.textContent = fmt(note.created_at);
      button.append(title, text, time);
      button.addEventListener("click", () => {
        panel.hidden = true;
        run(() => Editor.openMap(note.map_id));
      });
      panel.append(button);
    }
    if (toggle) panel.hidden = !panel.hidden;
  }

  async function showGalleryList() {
    document.getElementById("gallery-list").hidden = false;
    document.getElementById("gallery-detail").hidden = true;
    const data = await API.gallery(document.getElementById("gallery-sort").value);
    const box = document.getElementById("gallery-list");
    box.innerHTML = "";
    if (!data.items.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Публичных карт пока нет.";
      box.append(note);
      return;
    }
    for (const item of data.items) {
      const card = document.createElement("article");
      card.className = "card";
      if (item.preview) {
        const img = document.createElement("img");
        img.alt = item.name;
        img.src = item.preview;
        card.append(img);
      } else {
        const empty = document.createElement("div");
        empty.className = "placeholder";
        empty.textContent = "Без превью";
        card.append(empty);
      }
      const pad = document.createElement("div");
      pad.className = "pad";
      const title = document.createElement("h3");
      title.textContent = item.name;
      const meta = document.createElement("p");
      meta.className = "muted";
      meta.textContent = `${item.author} · ${fmt(item.updated_at)} · комментариев: ${item.comment_count}`;
      const open = actionButton("Открыть", () => window.go(`gallery/${item.id}`));
      pad.append(title, meta, open);
      card.append(pad);
      box.append(card);
    }
  }

  async function openGalleryMap(id) {
    const data = await API.galleryMap(id);
    App.galleryMapId = data.id;
    document.getElementById("gallery-list").hidden = true;
    document.getElementById("gallery-detail").hidden = false;
    document.getElementById("gallery-title").textContent = data.name;
    document.getElementById("gallery-author").textContent = `${data.author} · ${fmt(data.updated_at)}`;
    const doc = IO.normalize(data.data);
    const canvas = document.getElementById("gallery-canvas");
    const scale = Math.min(1, 860 / (doc.cols * 16));
    const draw = () => IO.drawMap(canvas, doc, { scale, player: true, editor: false });
    IO.drawMap(canvas, doc, { scale, player: true, editor: false, redraw: draw });
    const box = document.getElementById("gallery-comments");
    box.innerHTML = "";
    if (!data.comments.length) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Комментариев пока нет";
      box.append(note);
    }
    for (const comment of data.comments) {
      const article = document.createElement("article");
      article.className = "comment";
      const head = document.createElement("strong");
      head.textContent = `${comment.author} · ${fmt(comment.created_at)}`;
      const text = document.createElement("p");
      text.textContent = comment.text;
      article.append(head, text);
      if (comment.mine) article.append(actionButton("Удалить", async () => {
        await API.deleteComment(comment.id);
        toast("Комментарий удалён");
        await openGalleryMap(id);
      }, true));
      box.append(article);
    }
  }

  function bindRange(id, key, labelId) {
    const el = document.getElementById(id);
    const commit = () => { if (IO.commit(App.doc)) { Editor.markDirty(); Editor.syncHistory(); } };
    el.addEventListener("pointerdown", () => { if (App.user) IO.arm(App.doc); });
    el.addEventListener("focus", () => { if (App.user) IO.arm(App.doc); });
    el.addEventListener("input", () => {
      if (App.syncing || !App.user) return;
      App.doc.grid[key] = Number(el.value);
      document.getElementById(labelId).textContent = el.value;
      Editor.markDirty();
      Editor.draw();
    });
    el.addEventListener("pointerup", commit);
    el.addEventListener("change", commit);
    el.addEventListener("blur", commit);
  }

  function blockPremium(event) {
    if (App.user) return;
    const el = event.target.closest("[data-auth]");
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    if (document.getElementById("modal-auth").hidden) openAuth(el.getAttribute("data-auth"));
  }

  function bind() {
    document.addEventListener("click", blockPremium, true);
    document.addEventListener("pointerdown", blockPremium, true);
    document.getElementById("auth-form").addEventListener("submit", submitAuth);
    document.getElementById("auth-close").addEventListener("click", closeAuth);
    document.getElementById("auth-mode").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));
    document.getElementById("modal-auth").addEventListener("click", (event) => {
      if (event.target.id === "modal-auth") closeAuth();
    });
    document.getElementById("btn-nav-editor").addEventListener("click", () => window.go("editor"));
    document.getElementById("btn-nav-library").addEventListener("click", () => window.go("library"));
    document.getElementById("btn-nav-gallery").addEventListener("click", () => window.go("gallery"));
    document.getElementById("btn-bell").addEventListener("click", () => run(() => refreshNotes(true)));
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === button));
        document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
      });
    });
    document.getElementById("map-name").addEventListener("input", () => Editor.markDirty());
    document.getElementById("map-folder").addEventListener("change", () => {
      if (App.syncing) return;
      const value = document.getElementById("map-folder").value;
      App.folderId = value ? Number(value) : null;
      Editor.markDirty();
    });
    document.getElementById("map-tags").addEventListener("change", () => {
      if (App.syncing) return;
      App.tagIds = [...document.querySelectorAll("#map-tags input:checked")].map((input) => Number(input.value));
      Editor.markDirty();
    });
    document.getElementById("map-public").addEventListener("change", () => { if (!App.syncing) Editor.markDirty(); });
    document.getElementById("grid-show").addEventListener("change", () => {
      if (!App.user || App.syncing) return;
      IO.arm(App.doc);
      App.doc.grid.show = document.getElementById("grid-show").checked;
      IO.commit(App.doc);
      Editor.markDirty();
      Editor.syncHistory();
      Editor.draw();
    });
    bindRange("grid-cell", "cell", "grid-cell-val");
    bindRange("grid-ox", "offsetX", "grid-ox-val");
    bindRange("grid-oy", "offsetY", "grid-oy-val");
    const color = document.getElementById("grid-color");
    color.addEventListener("focus", () => { if (App.user) IO.arm(App.doc); });
    color.addEventListener("input", () => {
      if (!App.user || App.syncing) return;
      App.doc.grid.color = color.value;
      Editor.markDirty();
      Editor.draw();
    });
    color.addEventListener("change", () => { if (IO.commit(App.doc)) Editor.syncHistory(); });
    const propText = document.getElementById("prop-text");
    const propDesc = document.getElementById("prop-desc");
    for (const input of [propText, propDesc]) {
      input.addEventListener("focus", () => { if (App.user) IO.arm(App.doc); });
      input.addEventListener("blur", () => { if (IO.commit(App.doc)) Editor.syncHistory(); });
    }
    propText.addEventListener("input", () => {
      if (App.syncing) return;
      const found = IO.findItem(App.doc, App.selection);
      if (!found) return;
      found.item.text = propText.value;
      Editor.markDirty();
      Editor.draw();
    });
    propDesc.addEventListener("input", () => {
      if (App.syncing) return;
      const found = IO.findItem(App.doc, App.selection);
      if (!found) return;
      found.item.description = propDesc.value;
      Editor.markDirty();
      Editor.draw();
    });
    document.getElementById("prop-delete").addEventListener("click", () => Editor.deleteSelection());
    document.getElementById("folder-all").addEventListener("click", () => { App.libraryFolder = "all"; run(loadLibrary); });
    document.getElementById("folder-root").addEventListener("click", () => { App.libraryFolder = "root"; run(loadLibrary); });
    document.getElementById("tag-all").addEventListener("click", () => { App.libraryTag = null; run(loadLibrary); });
    document.getElementById("folder-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("new-folder");
      run(async () => {
        await API.createFolder(input.value.trim());
        input.value = "";
        toast("Папка создана");
        await loadLibrary();
      });
    });
    document.getElementById("tag-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("new-tag");
      run(async () => {
        await API.createTag(input.value.trim());
        input.value = "";
        toast("Тег создан");
        await loadLibrary();
      });
    });
    document.getElementById("gallery-sort").addEventListener("change", () => run(showGalleryList));
    document.getElementById("gallery-back").addEventListener("click", () => window.go("gallery"));
    document.getElementById("comment-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!App.user) { openAuth("Комментарии доступны после входа"); return; }
      run(async () => {
        await API.addComment(App.galleryMapId, document.getElementById("comment-text").value);
        document.getElementById("comment-text").value = "";
        toast("Комментарий добавлен");
        await openGalleryMap(App.galleryMapId);
      });
    });
    document.getElementById("asset-file").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) run(() => Editor.uploadAsset(file));
    });
    document.getElementById("export-close").addEventListener("click", () => { document.getElementById("modal-export").hidden = true; });
    document.getElementById("share-close").addEventListener("click", () => { document.getElementById("modal-share").hidden = true; });
    document.getElementById("gen-cancel").addEventListener("click", () => { document.getElementById("modal-gen").hidden = true; App.previewDoc = null; });
    document.getElementById("modal-export").addEventListener("click", (event) => { if (event.target.id === "modal-export") event.currentTarget.hidden = true; });
    document.getElementById("modal-share").addEventListener("click", (event) => { if (event.target.id === "modal-share") event.currentTarget.hidden = true; });
    document.getElementById("modal-gen").addEventListener("click", (event) => {
      if (event.target.id === "modal-gen") { event.currentTarget.hidden = true; App.previewDoc = null; }
    });
  }

  return {
    toast, run, openAuth, closeAuth, renderAuth, renderLayers, syncGrid, renderTaxonomy,
    ensureTaxonomy, showInspector, hideTooltip, showTooltip, loadAssets, renderAssets,
    loadLibrary, refreshNotes, showGalleryList, openGalleryMap, bind,
  };
})();
