"use strict";

const state = {
  sources: [],
  destination: null,
  comparisons: [],
  copied: 0,
};

const els = {
  addSourceBtn: document.querySelector("#addSourceBtn"),
  destinationSelect: document.querySelector("#destinationSelect"),
  refreshDrivesBtn: document.querySelector("#refreshDrivesBtn"),
  scanBtn: document.querySelector("#scanBtn"),
  backupBtn: document.querySelector("#backupBtn"),
  clearHistoryBtn: document.querySelector("#clearHistoryBtn"),
  sourcesList: document.querySelector("#sourcesList"),
  destinationLabel: document.querySelector("#destinationLabel"),
  manifestStatus: document.querySelector("#manifestStatus"),
  changesView: document.querySelector("#changesView"),
  supportWarning: document.querySelector("#supportWarning"),
  sourceCount: document.querySelector("#sourceCount"),
  changeCount: document.querySelector("#changeCount"),
  copiedCount: document.querySelector("#copiedCount"),
  logList: document.querySelector("#logList"),
  spaceInfo: document.querySelector("#spaceInfo"),
  folderTemplate: document.querySelector("#folderTemplate"),
  versioningToggle: document.querySelector("#versioningToggle"),
  hashToggle: document.querySelector("#hashToggle"),
};

const supportsFileSystem = typeof window.showDirectoryPicker === "function";
els.supportWarning.hidden = supportsFileSystem;

function log(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
  els.logList.prepend(item);
}

function updateCounts() {
  const changes = state.comparisons.reduce(
    (total, item) => total + item.newFiles.length + item.changedFiles.length + item.missingFiles.length,
    0,
  );
  els.sourceCount.textContent = state.sources.length;
  els.changeCount.textContent = changes;
  els.copiedCount.textContent = state.copied;
  els.backupBtn.disabled = !state.destination || changes === 0;
}

const MAX_RENDERED_FILES = 50;
const BACKUP_CONCURRENCY = 3;

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLimitedConcurrency(items, handler, concurrency) {
  const results = [];
  const inFlight = new Set();

  for (const item of items) {
    const promise = Promise.resolve().then(() => handler(item));
    results.push(promise);
    inFlight.add(promise);

    const cleanup = () => inFlight.delete(promise);
    promise.then(cleanup, cleanup);

    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }
  }

  await Promise.all(inFlight);
  return Promise.all(results);
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "carpeta";
}

function manifestKey(sourceName) {
  return `kopia-desk:manifest:${sourceName}`;
}

function manifestPath(sourceName) {
  return ["KopiaDesk", safeName(sourceName), "_manifests", "manifest.json"].join("/");
}

function readManifest(sourceName) {
  try {
    return JSON.parse(localStorage.getItem(manifestKey(sourceName)) || "{}");
  } catch {
    return {};
  }
}

function setManifestStatus(message) {
  if (els.manifestStatus) {
    els.manifestStatus.textContent = message;
  }
}

async function loadManifest(sourceName) {
  const local = readManifest(sourceName);
  if (!state.destination) {
    setManifestStatus("Manifiesto: destino no seleccionado, usando historial local");
    return { manifest: local, source: "local" };
  }

  try {
    const payload = await api("/api/read-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: state.destination.root, path: manifestPath(sourceName), meta: true }),
    });
    // payload may be JSON {text, mtime} or plain text
    if (typeof payload === "object" && payload.text != null) {
      setManifestStatus(`Manifiesto: cargado desde destino (${new Date(payload.mtime * 1000).toLocaleString()})`);
      return { manifest: JSON.parse(payload.text), source: "remote", mtime: payload.mtime };
    }
    setManifestStatus("Manifiesto: cargado desde destino (fecha desconocida)");
    return { manifest: JSON.parse(payload), source: "remote" };
  } catch {
    setManifestStatus("Manifiesto: no existe en destino, usando historial local");
    return { manifest: local, source: "local" };
  }
}

async function saveManifest(sourceName, manifest) {
  localStorage.setItem(manifestKey(sourceName), JSON.stringify(manifest));
  if (!state.destination) {
    return;
  }
  await uploadText(state.destination.root, manifestPath(sourceName), JSON.stringify(manifest));
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Error ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

function renderSources() {
  els.sourcesList.innerHTML = "";
  els.sourcesList.classList.toggle("empty", state.sources.length === 0);
  if (!state.sources.length) {
    els.sourcesList.textContent = "Sin carpetas seleccionadas";
    updateCounts();
    return;
  }

  state.sources.forEach((source, index) => {
    const row = document.createElement("div");
    row.className = "source-pill";
    row.innerHTML = `<strong>${source.name}</strong>`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Quitar carpeta";
    remove.textContent = "x";
    remove.addEventListener("click", () => {
      state.sources.splice(index, 1);
      state.comparisons = state.comparisons.filter((item) => item.sourceName !== source.name);
      renderSources();
      renderComparisons();
      log(`Carpeta quitada: ${source.name}`);
    });
    row.append(remove);
    els.sourcesList.append(row);
  });
  updateCounts();
}

async function addSource() {
  if (!supportsFileSystem) {
    log("Abre Kopia Desk en Chrome o Edge para seleccionar carpetas.");
    return;
  }
  const handle = await window.showDirectoryPicker({ mode: "read" });
  if (state.sources.some((source) => source.name === handle.name)) {
    log(`La carpeta ${handle.name} ya estaba seleccionada.`);
    return;
  }
  state.sources.push({ name: handle.name, handle });
  renderSources();
  log(`Carpeta anadida: ${handle.name}`);
}

async function loadDrives() {
  els.destinationSelect.innerHTML = `<option value="">Buscando discos...</option>`;
  state.destination = null;
  updateCounts();

  try {
    const drives = await api("/api/drives");
    els.destinationSelect.innerHTML = `<option value="">Selecciona un disco</option>`;

    drives.forEach((drive) => {
      const option = document.createElement("option");
      option.value = drive.root;
      option.textContent = `${drive.root} ${drive.label ? "- " + drive.label : ""} (${formatBytes(drive.free)} libres)`;
      option.dataset.free = drive.free;
      option.dataset.total = drive.total;
      option.dataset.label = drive.label || "";
      els.destinationSelect.append(option);
    });

    if (!drives.length) {
      els.destinationSelect.innerHTML = `<option value="">No hay discos disponibles</option>`;
      els.destinationLabel.textContent = "Conecta un disco o USB y pulsa Actualizar discos";
    } else {
      els.destinationLabel.textContent = "Selecciona donde guardar";
    }
    log(`Discos detectados: ${drives.length}.`);
  } catch (error) {
    els.destinationSelect.innerHTML = `<option value="">Servidor local no disponible</option>`;
    els.destinationLabel.textContent = "Ejecuta iniciar-kopia-desk.bat para detectar discos";
    log(`No se pudieron leer los discos: ${error.message}`);
  }
}

function selectDestination() {
  const option = els.destinationSelect.selectedOptions[0];
  if (!option?.value) {
    state.destination = null;
    els.destinationLabel.textContent = "Selecciona donde guardar";
    updateCounts();
    return;
  }

  state.destination = {
    root: option.value,
    label: option.dataset.label || "",
    free: Number(option.dataset.free || 0),
    total: Number(option.dataset.total || 0),
  };
  els.destinationLabel.textContent = `${state.destination.root} seleccionado - ${formatBytes(state.destination.free)} libres`;
  log(`Destino elegido: ${state.destination.root}`);
  updateCounts();
}

async function scanDirectory(handle, basePath = "", previous = {}) {
  const files = {};
  let scanned = 0;

  for await (const [name, child] of handle.entries()) {
    const relativePath = basePath ? `${basePath}/${name}` : name;
    if (child.kind === "directory") {
      Object.assign(files, await scanDirectory(child, relativePath, previous));
      continue;
    }
    const file = await child.getFile();
    const previousFile = previous[relativePath];
    const record = {
      name,
      path: relativePath,
      size: file.size,
      lastModified: file.lastModified,
      hash: null,
    };

    if (
      els.hashToggle.checked &&
      previousFile?.hash != null &&
      previousFile.size === file.size &&
      previousFile.lastModified === file.lastModified
    ) {
      record.hash = await hashFile(file);
    }

    files[relativePath] = record;
    scanned += 1;
    if (scanned % 100 === 0) {
      await sleep();
    }
  }
  return files;
}

async function hashFile(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareManifests(current, previous) {
  const newFiles = [];
  const changedFiles = [];
  const missingFiles = [];

  for (const [path, file] of Object.entries(current)) {
    const old = previous[path];
    if (!old) {
      newFiles.push(file);
      continue;
    }
    const changed =
      old.size !== file.size ||
      old.lastModified !== file.lastModified ||
      (file.hash && old.hash && file.hash !== old.hash);
    if (changed) changedFiles.push({ ...file, previous: old });
  }

  for (const [path, file] of Object.entries(previous)) {
    if (!current[path]) missingFiles.push(file);
  }

  return { newFiles, changedFiles, missingFiles };
}

async function scanAll() {
  if (!state.sources.length) {
    log("Anade al menos una carpeta antes de escanear.");
    return;
  }

  state.comparisons = [];
  els.changesView.className = "changes-view empty-state";
  els.changesView.innerHTML = "<h3>Escaneando...</h3><p>Esto puede tardar si hay muchas subcarpetas.</p>";

  for (const source of state.sources) {
    log(`Escaneando ${source.name}...`);
    const { manifest: previous, source: manifestSource } = await loadManifest(source.name);
    const current = await scanDirectory(source.handle, "", previous);
    const diff = compareManifests(current, previous);
    state.comparisons.push({
      sourceName: source.name,
      handle: source.handle,
      manifest: current,
      previousManifest: previous,
      ...diff,
      decisions: { new: true, changed: true, missing: false },
    });
    log(`${source.name}: manifiesto cargado desde ${manifestSource === "remote" ? "destino" : "local"}.`);
    log(
      `${source.name}: ${diff.newFiles.length} nuevos, ${diff.changedFiles.length} cambiados, ${diff.missingFiles.length} eliminados.`,
    );
    await sleep();
  }
  renderComparisons();
}

function renderComparisons() {
  updateCounts();
  if (!state.comparisons.length) {
    els.changesView.className = "changes-view empty-state";
    els.changesView.innerHTML = "<h3>Listo para escanear</h3><p>Agrega carpetas, elige destino y ejecuta el escaneo.</p>";
    return;
  }

  els.changesView.className = "changes-view";
  els.changesView.innerHTML = "";

  state.comparisons.forEach((comparison) => {
    const node = els.folderTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = comparison.sourceName;
    node.querySelector("p").textContent = `${Object.keys(comparison.manifest).length} archivos revisados`;
    node.querySelector(".folder-stats").innerHTML = `
      <span class="badge new">${comparison.newFiles.length} nuevos</span>
      <span class="badge changed">${comparison.changedFiles.length} cambiados</span>
      <span class="badge missing">${comparison.missingFiles.length} faltantes</span>
    `;

    node.querySelectorAll(".decision-row input").forEach((input) => {
      input.checked = comparison.decisions[input.dataset.kind];
      input.addEventListener("change", () => {
        comparison.decisions[input.dataset.kind] = input.checked;
        updateCounts();
      });
    });

    const groups = node.querySelector(".file-groups");
    groups.append(
      fileGroup("Nuevos", comparison.newFiles, "Aparecen en el origen y no estaban en el historial."),
      fileGroup("Cambiados", comparison.changedFiles, "Mismo nombre, distinto tamano, fecha o hash."),
      fileGroup("Eliminados del origen", comparison.missingFiles, "Se registran, pero no se borran del backup."),
    );
    els.changesView.append(node);
  });
}

function fileGroup(title, files, hint) {
  const details = document.createElement("details");
  details.className = "file-group";
  details.open = files.length > 0 && files.length <= 8;
  details.innerHTML = `<summary><span>${title}</span><span>${files.length}</span></summary>`;
  const list = document.createElement("div");
  list.className = "file-list";

  if (!files.length) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `<strong>Sin archivos</strong><span></span><span>${hint}</span>`;
    list.append(row);
  } else {
    files.slice(0, MAX_RENDERED_FILES).forEach((file) => {
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `
        <strong title="${file.path}">${file.path}</strong>
        <span>${formatBytes(file.size)}</span>
        <span>${new Date(file.lastModified).toLocaleString()}</span>
      `;
      list.append(row);
    });
    if (files.length > MAX_RENDERED_FILES) {
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `<strong>+ ${files.length - MAX_RENDERED_FILES} mas</strong><span></span><span>Se copiaran aunque no se listen aqui.</span>`;
      list.append(row);
    }
  }
  details.append(list);
  return details;
}

async function getFileFromPath(root, path) {
  const parts = path.split("/");
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = await cursor.getDirectoryHandle(part);
  }
  return cursor.getFileHandle(parts.at(-1));
}

async function uploadFile(destinationRoot, relativePath, file) {
  const form = new FormData();
  form.append("root", destinationRoot);
  form.append("path", relativePath);
  form.append("file", file, file.name);
  await api("/api/write-file", { method: "POST", body: form });
}

async function uploadText(destinationRoot, relativePath, text) {
  await api("/api/write-text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: destinationRoot, path: relativePath, text }),
  });
}

async function backupAll() {
  if (!state.destination) {
    log("Elige un destino antes de copiar.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let copied = 0;

  for (const comparison of state.comparisons) {
    const selected = [
      ...(comparison.decisions.new ? comparison.newFiles : []),
      ...(comparison.decisions.changed ? comparison.changedFiles : []),
    ];

    await runLimitedConcurrency(selected, async (item) => {
      const sourceHandle = await getFileFromPath(comparison.handle, item.path);
      const file = await sourceHandle.getFile();
      await uploadFile(
        state.destination.root,
        ["KopiaDesk", safeName(comparison.sourceName), "latest", item.path].join("/"),
        file,
      );
      if (els.versioningToggle.checked && item.previous) {
        await uploadFile(
          state.destination.root,
          ["KopiaDesk", safeName(comparison.sourceName), "_versions", stamp, item.path].join("/"),
          file,
        );
      }
      copied += 1;
      state.copied = copied;
      updateCounts();
      if (copied % 10 === 0) {
        await sleep();
      }
    }, BACKUP_CONCURRENCY);

    const nextManifest = { ...comparison.previousManifest };
    selected.forEach((item) => {
      nextManifest[item.path] = comparison.manifest[item.path];
    });
    if (comparison.decisions.missing) {
      comparison.missingFiles.forEach((item) => {
        delete nextManifest[item.path];
      });
    }

    const report = {
      date: new Date().toISOString(),
      source: comparison.sourceName,
      copied: selected.length,
      skippedNew: comparison.decisions.new ? 0 : comparison.newFiles.length,
      skippedChanged: comparison.decisions.changed ? 0 : comparison.changedFiles.length,
      missingRegistered: comparison.decisions.missing ? comparison.missingFiles : [],
    };
    await uploadText(
      state.destination.root,
      ["KopiaDesk", safeName(comparison.sourceName), "_logs", `${stamp}.json`].join("/"),
      JSON.stringify(report, null, 2),
    );
    await saveManifest(comparison.sourceName, nextManifest);
    log(`${comparison.sourceName}: ${selected.length} archivos copiados y manifiesto actualizado.`);
  }

  state.copied = copied;
  updateCounts();
  log(`Copia finalizada: ${copied} archivos.`);
}

function clearHistory() {
  const keys = Object.keys(localStorage).filter((key) => key.startsWith("kopia-desk:manifest:"));
  keys.forEach((key) => localStorage.removeItem(key));
  state.comparisons = [];
  renderComparisons();
  log("Historial local borrado. El proximo escaneo sera una copia completa.");
}

async function updateStorageEstimate() {
  if (!navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  els.spaceInfo.textContent = `Navegador: ${formatBytes(estimate.usage)} usados de ${formatBytes(estimate.quota)}. Discos detectados por Kopia Desk local.`;
}

els.addSourceBtn.addEventListener("click", () => addSource().catch((error) => log(error.message)));
els.destinationSelect.addEventListener("change", selectDestination);
els.refreshDrivesBtn.addEventListener("click", () => loadDrives().catch((error) => log(error.message)));
els.scanBtn.addEventListener("click", () => scanAll().catch((error) => log(error.message)));
els.backupBtn.addEventListener("click", () => backupAll().catch((error) => log(error.message)));
els.clearHistoryBtn.addEventListener("click", clearHistory);

renderSources();
renderComparisons();
updateStorageEstimate();
loadDrives();
log("Kopia Desk iniciado. Para la prueba, anade la carpeta FOTOS como origen.");
