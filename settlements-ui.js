(() => {
  const panel = document.querySelector("#settlementPanel");
  const form = document.querySelector("#settlementForm");
  const status = document.querySelector("#settlementStatus");
  const badge = document.querySelector("#settlementBadge");
  const balances = document.querySelector("#settlementBalances");
  const recordsElement = document.querySelector("#settlementRecords");
  const filter = document.querySelector("#settlementPersonFilter");
  const refresh = document.querySelector("#settlementRefresh");
  const exportButton = document.querySelector("#settlementExport");
  const money = value => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value / 100);
  let records = [];
  let ready = false;
  let busy = false;
  let pendingRecord = null;
  form.elements.date.value = localDate();

  function localDate() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function setBusy(value) {
    busy = value;
    for (const input of form.elements) input.disabled = value || !ready;
    refresh.disabled = value;
    exportButton.disabled = value || !ready;
    recordsElement.querySelectorAll("button").forEach(button => { button.disabled = value || !ready; });
  }

  async function request(path = "", options = {}) {
    const response = await fetch(`/api/settlements${path}`, {
      ...options, headers: { "Content-Type": "application/json" },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (result.error === "settlements_not_initialized") throw new Error("垫付与报销尚未启用，请先完成新增表设置。原账本可正常使用。");
      if (result.error === "invalid_record") throw new Error("请检查姓名、日期和金额，金额最多两位小数。");
      throw new Error("垫付与报销同步失败，请稍后重试；填写内容已保留。");
    }
    return result;
  }

  async function load() {
    if (busy) return;
    setBusy(true);
    status.textContent = "正在加载垫付与报销…";
    try {
      const result = await request();
      records = result.records;
      ready = true;
      render();
      status.textContent = `已同步 · ${records.length} 条记录`;
    } catch (error) {
      ready = false;
      status.textContent = error.message;
      badge.textContent = "暂未连接";
    } finally { setBusy(false); }
  }

  function render() {
    const totals = new Map();
    for (const record of records) {
      if (!totals.has(record.person)) totals.set(record.person, { advance: 0, reimbursement: 0 });
      totals.get(record.person)[record.kind] += Math.round(record.amount * 100);
    }
    const people = [...totals.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const previous = filter.value;
    filter.replaceChildren(new Option("全部人员", ""));
    const suggestions = document.querySelector("#settlementPeople");
    suggestions.replaceChildren();
    balances.replaceChildren();
    let pending = 0;
    for (const person of people) {
      filter.add(new Option(person, person));
      suggestions.append(new Option(person, person));
      const total = totals.get(person);
      const due = total.advance - total.reimbursement;
      pending += Math.max(0, due);
      const row = document.createElement("div");
      row.className = "settlement-balance";
      const name = document.createElement("strong");
      name.textContent = person;
      row.append(name);
      for (const text of [`垫付 ${money(total.advance)}`, `已报销 ${money(total.reimbursement)}`,
        due >= 0 ? `待报销 ${money(due)}` : `超额报销 ${money(-due)}`]) {
        const span = document.createElement("span");
        span.textContent = text;
        row.append(span);
      }
      balances.append(row);
    }
    if (people.includes(previous)) filter.value = previous;
    badge.textContent = `待报销 ${money(pending)} · ${people.length} 人`;
    renderRecords();
  }

  function renderRecords() {
    recordsElement.replaceChildren();
    const selected = records.filter(record => !filter.value || record.person === filter.value)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    if (!selected.length) {
      const empty = document.createElement("p");
      empty.textContent = "暂无垫付与报销记录";
      recordsElement.append(empty);
    }
    for (const record of selected) {
      const row = document.createElement("div");
      row.className = "settlement-row";
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${record.person} · ${record.kind === "advance" ? "垫付" : "报销"} ${money(Math.round(record.amount * 100))}`;
      const description = document.createElement("p");
      description.textContent = `${record.date}${record.note ? ` · ${record.note}` : ""}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "delete-button";
      button.textContent = "删除";
      button.dataset.id = record.id;
      button.disabled = busy || !ready;
      details.append(title, description);
      row.append(details, button);
      recordsElement.append(row);
    }
  }

  form.addEventListener("input", () => { pendingRecord = null; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !ready) return;
    const data = Object.fromEntries(new FormData(form));
    if (!data.person.trim()) { form.elements.person.focus(); return; }
    // Reuse the ID on a retry when a successful response was lost in transit.
    pendingRecord ||= { ...data, person: data.person.trim(), amount: Number(data.amount), id: crypto.randomUUID() };
    setBusy(true);
    try {
      const result = await request("", { method: "POST", body: JSON.stringify({ record: pendingRecord }) });
      records = [...records.filter(record => record.id !== result.record.id), result.record];
      const person = form.elements.person.value;
      form.reset();
      form.elements.date.value = localDate();
      form.elements.person.value = person;
      pendingRecord = null;
      render();
      status.textContent = "已保存并同步";
    } catch (error) { status.textContent = error.message; }
    finally { setBusy(false); }
  });

  recordsElement.addEventListener("click", async event => {
    const button = event.target.closest("button[data-id]");
    if (!button || busy || !ready) return;
    const record = records.find(item => item.id === button.dataset.id);
    if (!record || !window.confirm(`删除 ${record.person} 的这笔${record.kind === "advance" ? "垫付" : "报销"} ${money(Math.round(record.amount * 100))}？`)) return;
    setBusy(true);
    try {
      await request(`/${record.id}`, { method: "DELETE" });
      records = records.filter(item => item.id !== record.id);
      render();
      status.textContent = "记录已删除并同步";
    } catch (error) { status.textContent = error.message; }
    finally { setBusy(false); }
  });

  exportButton.addEventListener("click", async () => {
    if (busy || !ready) return;
    setBusy(true);
    try {
      const result = await request();
      const blob = new Blob([JSON.stringify({ app: "垫付与报销", exportedAt: new Date().toISOString(), records: result.records }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `垫付与报销-${localDate()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "垫付与报销记录已导出";
    } catch (error) { status.textContent = error.message; }
    finally { setBusy(false); }
  });

  filter.addEventListener("change", renderRecords);
  refresh.addEventListener("click", load);
  panel.addEventListener("toggle", () => { if (panel.open && !ready) load(); });
  setBusy(false);
})();
