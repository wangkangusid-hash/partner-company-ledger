const LEGACY_STORAGE_KEY = "partner-company-ledger-v1";
const PASSWORD_STORAGE_KEY = "partner-company-ledger-password";
const LOCAL_BACKUP_KEY = "partner-company-ledger-online-backup-v1";
const ENTRIES_API = "/api/entries/";

const incomeCategories = ["销售收入", "服务费", "投资款", "退款", "其他收入"];
const expenseCategories = ["采购", "房租", "工资", "差旅", "办公", "营销", "税费", "其他支出"];

const state = {
  entries: loadLocalBackup(),
  connected: false,
  password: localStorage.getItem(PASSWORD_STORAGE_KEY) || "",
};

const form = document.querySelector("#entryForm");
const dateInput = document.querySelector("#dateInput");
const amountInput = document.querySelector("#amountInput");
const categoryInput = document.querySelector("#categoryInput");
const noteInput = document.querySelector("#noteInput");
const imageInput = document.querySelector("#imageInput");
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
const passwordInput = document.querySelector("#passwordInput");
const connectBtn = document.querySelector("#connectBtn");
const refreshBtn = document.querySelector("#refreshBtn");
const dayTemplate = document.querySelector("#dayTemplate");
const entryTemplate = document.querySelector("#entryTemplate");

dateInput.value = todayISO();
passwordInput.value = state.password;
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
    image: await readImageFile(imageInput.files?.[0]),
    createdAt: new Date().toISOString(),
  };

  try {
    setBusy(true);
    const result = await apiRequest(ENTRIES_API, {
      method: "POST",
      body: JSON.stringify({ entry }),
    });
    state.entries = normalizeEntries(result.entries || [...state.entries, result.entry]);
    saveLocalBackup(state.entries);
    setSyncState(true, "已同步", "这条明细已保存到同步账本");
    form.reset();
    dateInput.value = todayISO();
    resetImagePreview();
    updateCategories();
    render();
  } catch (error) {
    handleApiError(error, "保存失败，请检查同步服务器或访问密码。");
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
  const file = imageInput.files?.[0];
  if (!file) {
    resetImagePreview();
    return;
  }

  resetImagePreview();
  const previewUrl = URL.createObjectURL(file);
  imagePreview.querySelector("img").src = previewUrl;
  imagePreview.hidden = false;
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

connectBtn.addEventListener("click", () => {
  state.password = passwordInput.value.trim();
  localStorage.setItem(PASSWORD_STORAGE_KEY, state.password);
  loadServerEntries();
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
    state.entries = normalizeEntries(result.entries || state.entries.filter((item) => item.id !== entry.id));
    saveLocalBackup(state.entries);
    setSyncState(true, "已同步", "明细已删除");
    render();
  } catch (error) {
    handleApiError(error, "删除失败，请检查同步服务器或访问密码。");
  } finally {
    setBusy(false);
  }
});

exportBtn.addEventListener("click", () => {
  const payload = {
    app: "合伙公司记账",
    exportedAt: new Date().toISOString(),
    entries: state.entries,
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
    handleApiError(error, "未连接同步账本。请确认使用 node server.js 启动，并检查访问密码。");
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
      ...(state.password ? { "x-ledger-password": state.password } : {}),
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
    setSyncState(false, "需要访问密码", "请输入服务器设置的访问密码后连接");
    passwordInput.focus();
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
  connectBtn.disabled = isBusy;
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
  const imageButton = node.querySelector(".entry-image-button");
  if (entry.image?.dataUrl) {
    imageButton.hidden = false;
    imageButton.querySelector("img").src = entry.image.dataUrl;
    imageButton.title = entry.image.name || "查看记录图片";
    imageButton.addEventListener("click", () => openImagePreview(entry.image));
  }
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
    const text = `${entry.category} ${entry.note} ${entry.image?.name || ""}`.toLowerCase();
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

function normalizeEntries(entries) {
  return entries.filter(isValidEntry).map((entry) => ({
    id: entry.id || crypto.randomUUID(),
    date: String(entry.date).slice(0, 10),
    type: entry.type,
    amount: roundMoney(Number(entry.amount)),
    category: entry.category || "未分类",
    note: typeof entry.note === "string" ? entry.note : "",
    image: entry.image?.dataUrl ? entry.image : null,
    createdAt: entry.createdAt || new Date().toISOString(),
  }));
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

function resetImagePreview() {
  const image = imagePreview.querySelector("img");
  if (image.src.startsWith("blob:")) {
    URL.revokeObjectURL(image.src);
  }
  image.removeAttribute("src");
  imagePreview.hidden = true;
}

function openImagePreview(image) {
  const previewWindow = window.open("", "_blank");
  if (!previewWindow) return;

  previewWindow.document.write(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(image.name || "记录图片")}</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111820; }
          img { max-width: 100vw; max-height: 100vh; object-fit: contain; }
        </style>
      </head>
      <body>
        <img src="${image.dataUrl}" alt="${escapeHtml(image.name || "记录图片")}" />
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
