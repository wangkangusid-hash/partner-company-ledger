const LEGACY_STORAGE_KEY = "partner-company-ledger-v1";
const LOCAL_BACKUP_KEY = "partner-company-ledger-online-backup-v1";
const ENTRIES_API = "/api/entries/";
const EXPORT_API = "/api/export";

const incomeCategories = ["销售收入", "服务费", "投资款", "退款", "其他收入"];
const expenseCategories = ["采购", "房租", "工资", "差旅", "办公", "营销", "税费", "其他支出"];

const state = {
  entries: loadLocalBackup(),
  connected: false,
};

const form = document.querySelector("#entryForm");
const dateInput = document.querySelector("#dateInput");
const amountInput = document.querySelector("#amountInput");
const categoryInput = document.querySelector("#categoryInput");
const noteInput = document.querySelector("#noteInput");
const imageInput = document.querySelector("#imageInput");
const imageDropzone = document.querySelector("#imageDropzone");
const imagePreview = document.querySelector("#imagePreview");
const dayGroups = document.querySelector("#dayGroups");
const emptyState = document.querySelector("#emptyState");
const fromDate = document.querySelector("#fromDate");
const toDate = document.querySelector("#toDate");
const typeFilter = document.querySelector("#typeFilter");
const searchInput = document.querySelector("#searchInput");
const exportBtn = document.querySelector("#exportBtn");
const importInput = document.querySelector("#importInput");
const clearFiltersBtn = document.querySelector("#clearFiltersBtn");
const syncStatus = document.querySelector("#syncStatus");
const syncMessage = document.querySelector("#syncMessage");
const refreshBtn = document.querySelector("#refreshBtn");
const dayTemplate = document.querySelector("#dayTemplate");
const entryTemplate = document.querySelector("#entryTemplate");

dateInput.value = todayISO();
updateCategories();
render();
loadServerEntries();

form.addEventListener("change", (event) => {
  if (event.target.name === "type") {
    updateCategories();
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const amount = Number(formData.get("amount"));

  if (!Number.isFinite(amount) || amount <= 0) {
    amountInput.focus();
    return;
  }

  const entry = {
    id: crypto.randomUUID(),
    date: formData.get("date"),
    type: formData.get("type"),
    amount: roundMoney(amount),
    category: formData.get("category"),
    note: formData.get("note").trim(),
    images: await readImageFiles(imageInput.files),
    createdAt: new Date().toISOString(),
  };

  try {
    setBusy(true);
    const result = await apiRequest(ENTRIES_API, {
      method: "POST",
      body: JSON.stringify({ entry }),
    });
    state.entries = upsertEntry(state.entries, result.entry || entry);
    saveLocalBackup(state.entries);
    setSyncState(true, "已同步", "这条明细已保存到同步账本");
    form.reset();
    dateInput.value = todayISO();
    resetImagePreview();
    updateCategories();
    render();
  } catch (error) {
    handleApiError(error, "保存失败，请检查同步服务器。");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#resetFormBtn").addEventListener("click", () => {
  window.setTimeout(() => {
    dateInput.value = todayISO();
    resetImagePreview();
    updateCategories();
  }, 0);
});

imageInput.addEventListener("change", () => {
  renderSelectedImagePreview(imageInput.files);
});

["dragenter", "dragover"].forEach((eventName) => {
  imageDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    imageDropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  imageDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    imageDropzone.classList.remove("is-dragging");
  });
});

imageDropzone.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;

  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  imageInput.files = transfer.files;
  renderSelectedImagePreview(imageInput.files);
});

[fromDate, toDate, typeFilter, searchInput].forEach((control) => {
  control.addEventListener("input", render);
});

clearFiltersBtn.addEventListener("click", () => {
  fromDate.value = "";
  toDate.value = "";
  typeFilter.value = "all";
  searchInput.value = "";
  render();
});

refreshBtn.addEventListener("click", loadServerEntries);

dayGroups.addEventListener("click", async (event) => {
  const button = event.target.closest(".delete-button");
  if (!button) return;

  const entry = state.entries.find((item) => item.id === button.dataset.id);
  if (!entry) return;

  const confirmed = window.confirm(`删除这条${entry.type === "income" ? "收入" : "支出"}明细？`);
  if (!confirmed) return;

  try {
    setBusy(true);
    const result = await apiRequest(`/api/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    state.entries = normalizeEntries(state.entries.filter((item) => item.id !== entry.id));
    saveLocalBackup(state.entries);
    setSyncState(true, "已同步", "明细已删除");
    render();
  } catch (error) {
    handleApiError(error, "删除失败，请检查同步服务器。");
  } finally {
    setBusy(false);
  }
});

exportBtn.addEventListener("click", async () => {
  let entries = state.entries;
  try {
    const data = await apiRequest(EXPORT_API);
    entries = normalizeEntries(data.entries || entries, { includeImages: true });
  } catch {
    window.alert("完整导出失败，将导出当前页面已加载的数据。");
  }

  const payload = {
    app: "合伙公司记账",
    exportedAt: new Date().toISOString(),
    entries,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `合伙公司记账-${todayISO()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

importInput.addEventListener("change", async () => {
  const file = importInput.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const imported = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(imported)) throw new Error("Invalid data");

    const entries = normalizeEntries(imported);
    const confirmed = window.confirm(`导入会用 ${entries.length} 条记录替换同步账本，确定继续？`);
    if (!confirmed) return;

    setBusy(true);
    const result = await apiRequest(ENTRIES_API, {
      method: "PUT",
      body: JSON.stringify({ entries }),
    });
    state.entries = normalizeEntries(result.entries);
    saveLocalBackup(state.entries);
    setSyncState(true, "已同步", "导入数据已保存到同步账本");
    render();
  } catch {
    window.alert("导入失败，请选择本软件导出的 JSON 文件。");
  } finally {
    setBusy(false);
    importInput.value = "";
  }
});

async function loadServerEntries() {
  try {
    setBusy(true);
    setSyncState(false, "正在连接同步账本", "请稍候");
    const data = await apiRequest(ENTRIES_API);
    const serverEntries = normalizeEntries(data.entries);
    const backupEntries = loadLocalBackup();

    if (!serverEntries.length && backupEntries.length) {
      const confirmed = window.confirm(
        `同步账本现在是空的，但这台设备有 ${backupEntries.length} 条本地备份。是否恢复到同步账本？`
      );
      if (confirmed) {
        const result = await apiRequest(ENTRIES_API, {
          method: "PUT",
          body: JSON.stringify({ entries: backupEntries }),
        });
        state.entries = normalizeEntries(result.entries);
        saveLocalBackup(state.entries);
        setSyncState(true, "已恢复同步账本", `已恢复 ${state.entries.length} 条记录`);
        render();
        return;
      }
    }

    state.entries = serverEntries;
    saveLocalBackup(state.entries);
    setSyncState(true, "已连接同步账本", `共 ${state.entries.length} 条记录`);
    maybeOfferLegacyImport();
    render();
  } catch (error) {
    handleApiError(error, "未连接同步账本，请稍后刷新重试。");
    render();
  } finally {
    setBusy(false);
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function handleApiError(error, message) {
  if (error.status === 401) {
    setSyncState(false, "同步需要访问密码", "请在 Render 删除 LEDGER_PASSWORD，或恢复页面密码输入框");
    return;
  }

  setSyncState(false, "同步不可用", message);
}

function setSyncState(connected, title, message) {
  state.connected = connected;
  syncStatus.textContent = title;
  syncMessage.textContent = message;
  document.querySelector("#syncPanel").classList.toggle("connected", connected);
}

function setBusy(isBusy) {
  form.querySelector("button[type='submit']").disabled = isBusy;
  refreshBtn.disabled = isBusy;
}

async function maybeOfferLegacyImport() {
  const legacyEntries = loadLegacyEntries();
  if (!legacyEntries.length || state.entries.length) return;

  const confirmed = window.confirm(`检测到本机旧账本有 ${legacyEntries.length} 条记录，是否导入到同步账本？`);
  if (!confirmed) return;

  const result = await apiRequest(ENTRIES_API, {
    method: "PUT",
    body: JSON.stringify({ entries: legacyEntries }),
  });
  state.entries = normalizeEntries(result.entries);
  saveLocalBackup(state.entries);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  setSyncState(true, "已连接同步账本", `已导入 ${state.entries.length} 条旧记录`);
}

function render() {
  const entries = getFilteredEntries();
  renderSummary();
  renderDayGroups(entries);
}

function renderSummary() {
  const totalIncome = sumByType(state.entries, "income");
  const totalExpense = sumByType(state.entries, "expense");
  const todayEntries = state.entries.filter((entry) => entry.date === todayISO());
  const todayIncome = sumByType(todayEntries, "income");
  const todayExpense = sumByType(todayEntries, "expense");

  document.querySelector("#totalIncome").textContent = formatMoney(totalIncome);
  document.querySelector("#totalExpense").textContent = formatMoney(totalExpense);
  document.querySelector("#balance").textContent = formatMoney(totalIncome - totalExpense);
  document.querySelector("#todayNet").textContent = formatMoney(todayIncome - todayExpense);
}

function renderDayGroups(entries) {
  dayGroups.replaceChildren();
  emptyState.classList.toggle("visible", entries.length === 0);

  const groups = entries.reduce((collection, entry) => {
    collection[entry.date] ||= [];
    collection[entry.date].push(entry);
    return collection;
  }, {});

  Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .forEach(([date, dayEntries]) => {
      const dayNode = dayTemplate.content.firstElementChild.cloneNode(true);
      const income = sumByType(dayEntries, "income");
      const expense = sumByType(dayEntries, "expense");
      const net = income - expense;

      dayNode.querySelector("h3").textContent = formatDate(date);
      dayNode.querySelector("header p").textContent = `收入 ${formatMoney(income)} · 支出 ${formatMoney(expense)} · ${dayEntries.length} 笔`;
      dayNode.querySelector("header strong").textContent = formatSignedMoney(net);
      dayNode.querySelector("header strong").style.color = net >= 0 ? "var(--income)" : "var(--expense)";

      const entriesContainer = dayNode.querySelector(".entries");
      dayEntries
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .forEach((entry) => entriesContainer.appendChild(createEntryNode(entry)));

      dayGroups.appendChild(dayNode);
    });
}

function createEntryNode(entry) {
  const node = entryTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(entry.type);
  node.querySelector(".type-pill").textContent = entry.type === "income" ? "收入" : "支出";
  node.querySelector(".entry-category").textContent = entry.category;
  node.querySelector(".entry-meta").textContent = new Date(entry.createdAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  node.querySelector(".entry-note").textContent = entry.note || "无备注";
  renderEntryImages(node.querySelector(".entry-images"), entry);
  node.querySelector(".entry-amount").textContent =
    entry.type === "income" ? formatSignedMoney(entry.amount) : formatSignedMoney(-entry.amount);
  node.querySelector(".delete-button").dataset.id = entry.id;
  return node;
}

function getFilteredEntries() {
  const keyword = searchInput.value.trim().toLowerCase();
  return state.entries.filter((entry) => {
    const afterFrom = !fromDate.value || entry.date >= fromDate.value;
    const beforeTo = !toDate.value || entry.date <= toDate.value;
    const matchesType = typeFilter.value === "all" || entry.type === typeFilter.value;
    const text = `${entry.category} ${entry.note} ${entry.images.map((image) => image.name).join(" ")}`.toLowerCase();
    return afterFrom && beforeTo && matchesType && (!keyword || text.includes(keyword));
  });
}

function updateCategories() {
  const type = new FormData(form).get("type") || "income";
  const categories = type === "income" ? incomeCategories : expenseCategories;
  categoryInput.replaceChildren(
    ...categories.map((category) => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      return option;
    })
  );
}

function normalizeEntries(entries, options = {}) {
  return entries.filter(isValidEntry).map((entry) => ({
    id: entry.id || crypto.randomUUID(),
    date: String(entry.date).slice(0, 10),
    type: entry.type,
    amount: roundMoney(Number(entry.amount)),
    category: entry.category || "未分类",
    note: typeof entry.note === "string" ? entry.note : "",
    images: normalizeClientImages(entry.images || entry.image, options),
    createdAt: entry.createdAt || new Date().toISOString(),
  }));
}

function upsertEntry(entries, nextEntry) {
  const normalized = normalizeEntries([nextEntry])[0];
  if (!normalized) return normalizeEntries(entries);

  const rest = normalizeEntries(entries).filter((entry) => entry.id !== normalized.id);
  return [normalized, ...rest];
}

function normalizeClientImages(value, options = {}) {
  const rawImages = Array.isArray(value) ? value : value ? [value] : [];
  return rawImages
    .filter((image) => image && typeof image === "object")
    .map((image) => {
      if (image.dataUrl && options.includeImages !== false) {
        return {
          name: image.name || "记录图片",
          type: image.type || "image/*",
          size: Number(image.size) || 0,
          originalSize: Number(image.originalSize) || 0,
          dataUrl: image.dataUrl,
        };
      }
      if (image.hasImage || image.name || image.count) {
        return {
          name: image.name || "记录图片",
          type: image.type || "image/*",
          size: Number(image.size) || 0,
          originalSize: Number(image.originalSize) || 0,
          hasImage: true,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function loadLegacyEntries() {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? normalizeEntries(saved) : [];
  } catch {
    return [];
  }
}

function loadLocalBackup() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_BACKUP_KEY) || "[]");
    return Array.isArray(saved) ? normalizeEntries(saved) : [];
  } catch {
    return [];
  }
}

function saveLocalBackup(entries) {
  localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(normalizeEntries(entries)));
}

function isValidEntry(entry) {
  return (
    entry &&
    typeof entry.date === "string" &&
    ["income", "expense"].includes(entry.type) &&
    Number(entry.amount) > 0 &&
    typeof entry.category === "string"
  );
}

async function readImageFiles(fileList) {
  const files = [...(fileList || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return [];

  const images = [];
  for (const file of files) {
    images.push(await readImageFile(file));
  }
  return images.filter(Boolean);
}

function readImageFile(file) {
  if (!file) return null;
  if (!file.type.startsWith("image/")) {
    window.alert("请选择图片文件。");
    return null;
  }

  if (file.type === "image/gif") {
    return readOriginalImageFile(file);
  }

  return compressImageFile(file).catch(() => readOriginalImageFile(file));
}

function readOriginalImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        name: file.name,
        type: file.type,
        size: file.size,
        dataUrl: reader.result,
      });
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function compressImageFile(file) {
  const maxSide = 1280;
  const quality = 0.78;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error));
    reader.addEventListener("load", () => {
      const image = new Image();
      image.addEventListener("error", reject);
      image.addEventListener("load", () => {
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, width, height);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({
          name: file.name.replace(/\.[^.]+$/, ".jpg"),
          type: "image/jpeg",
          size: estimateDataUrlBytes(dataUrl),
          originalSize: file.size,
          dataUrl,
        });
      });
      image.src = reader.result;
    });
    reader.readAsDataURL(file);
  });
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1] || "";
  return Math.round((base64.length * 3) / 4);
}

function renderSelectedImagePreview(fileList) {
  const files = [...(fileList || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    resetImagePreview();
    return;
  }

  resetImagePreview();
  const previewGrid = imagePreview.querySelector(".image-preview-grid");
  files.forEach((file) => {
    const image = document.createElement("img");
    image.alt = file.name;
    image.src = URL.createObjectURL(file);
    previewGrid.appendChild(image);
  });
  imagePreview.hidden = false;
}

function resetImagePreview() {
  imagePreview.querySelectorAll("img").forEach((image) => {
    if (image.src.startsWith("blob:")) {
      URL.revokeObjectURL(image.src);
    }
  });
  imagePreview.querySelector(".image-preview-grid").replaceChildren();
  imagePreview.hidden = true;
}

function renderEntryImages(container, entry) {
  container.replaceChildren();
  if (!entry.images.length) return;

  const loadedImages = entry.images.filter((image) => image.dataUrl);
  if (loadedImages.length) {
    loadedImages.forEach((image, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "entry-image-button";
      button.title = image.name || "查看记录图片";
      const thumbnail = document.createElement("img");
      thumbnail.alt = image.name || `记录图片 ${index + 1}`;
      thumbnail.src = image.dataUrl;
      button.appendChild(thumbnail);
      button.addEventListener("click", () => openImagePreview(loadedImages, index));
      container.appendChild(button);
    });
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "entry-image-button image-placeholder";
  button.textContent = `查看图片 (${entry.images.length})`;
  button.addEventListener("click", () => openEntryImages(entry));
  container.appendChild(button);
}

async function openEntryImages(entry) {
  try {
    const data = await apiRequest(`/api/entries/${encodeURIComponent(entry.id)}/image`);
    const images = normalizeClientImages(data.images || data.image, { includeImages: true });
    if (!images.length) throw new Error("No image");

    state.entries = state.entries.map((item) => (item.id === entry.id ? { ...item, images } : item));
    saveLocalBackup(state.entries);
    render();
    openImagePreview(images);
  } catch {
    window.alert("图片加载失败，请稍后再试。");
  }
}

function openImagePreview(images, startIndex = 0) {
  const imageList = Array.isArray(images) ? images : [images];
  const previewWindow = window.open("", "_blank");
  if (!previewWindow) return;

  const imageMarkup = imageList
    .map((image, index) => {
      return `<figure>
        <img src="${image.dataUrl}" alt="${escapeHtml(image.name || `记录图片 ${index + 1}`)}" />
        <figcaption>${index + 1} / ${imageList.length} ${escapeHtml(image.name || "")}</figcaption>
      </figure>`;
    })
    .join("");

  previewWindow.document.write(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>记录图片</title>
        <style>
          body { margin: 0; min-height: 100vh; background: #111820; color: #fff; font-family: system-ui, sans-serif; }
          figure { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 16px; }
          img { max-width: 100%; max-height: 88vh; object-fit: contain; }
          figcaption { color: #d7dde4; padding: 10px; }
        </style>
      </head>
      <body>
        ${imageMarkup}
        <script>document.querySelectorAll('figure')[${startIndex}]?.scrollIntoView();</script>
      </body>
    </html>
  `);
  previewWindow.document.close();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character];
  });
}

function sumByType(entries, type) {
  return roundMoney(
    entries.filter((entry) => entry.type === type).reduce((sum, entry) => sum + Number(entry.amount), 0)
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
  }).format(value);
}

function formatSignedMoney(value) {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatMoney(Math.abs(value))}`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T00:00:00`));
}
