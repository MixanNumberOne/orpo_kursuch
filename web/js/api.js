const API = (() => {
  function csrf() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : "";
  }

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    let payload = options.body;
    const method = (options.method || "GET").toUpperCase();
    if (payload && !(payload instanceof FormData) && typeof payload !== "string") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(payload);
    }
    if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrf();
    let response;
    try {
      response = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
    } catch (_err) {
      throw new Error("Нет соединения. Повторите попытку.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Ошибка запроса");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return {
    me: () => request("/api/auth/me"),
    register: (username, password) => request("/api/auth/register", { method: "POST", body: { username, password } }),
    login: (username, password) => request("/api/auth/login", { method: "POST", body: { username, password } }),
    logout: () => request("/api/auth/logout", { method: "POST", body: {} }),
    folders: () => request("/api/folders"),
    createFolder: (name) => request("/api/folders", { method: "POST", body: { name } }),
    renameFolder: (id, name) => request(`/api/folders/${id}`, { method: "PUT", body: { name } }),
    deleteFolder: (id) => request(`/api/folders/${id}`, { method: "DELETE" }),
    tags: () => request("/api/tags"),
    createTag: (name) => request("/api/tags", { method: "POST", body: { name } }),
    deleteTag: (id) => request(`/api/tags/${id}`, { method: "DELETE" }),
    maps(folder, tag) {
      const query = new URLSearchParams();
      if (folder) query.set("folder", folder);
      if (tag) query.set("tag", String(tag));
      return request(`/api/maps?${query.toString()}`);
    },
    map: (id) => request(`/api/maps/${id}`),
    createMap: (body) => request("/api/maps", { method: "POST", body }),
    updateMap: (id, body) => request(`/api/maps/${id}`, { method: "PUT", body }),
    deleteMap: (id) => request(`/api/maps/${id}`, { method: "DELETE" }),
    duplicate: (id) => request(`/api/maps/${id}/duplicate`, { method: "POST", body: {} }),
    setShare: (id, isPublic) => request(`/api/maps/${id}/share`, { method: "POST", body: { is_public: isPublic } }),
    assets: () => request("/api/assets"),
    uploadAsset(file) {
      const body = new FormData();
      body.append("file", file);
      return request("/api/assets", { method: "POST", body });
    },
    deleteAsset: (id) => request(`/api/assets/${id}`, { method: "DELETE" }),
    gallery: (sort) => request(`/api/gallery?sort=${encodeURIComponent(sort || "new")}`),
    galleryMap: (id) => request(`/api/gallery/${id}`),
    addComment: (id, text) => request(`/api/gallery/${id}/comments`, { method: "POST", body: { text } }),
    deleteComment: (id) => request(`/api/comments/${id}`, { method: "DELETE" }),
    notifications: () => request("/api/notifications"),
    shared: (token) => request(`/api/share/${encodeURIComponent(token)}`),
  };
})();
