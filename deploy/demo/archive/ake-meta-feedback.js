(() => {
  const names = { Lead: '收到线索', QualifiedLead: '有效线索', ConvertedLead: '成交线索' };
  const states = { ready: '待回传', sending: '发送中', accepted: 'Meta 已受理', mock: '模拟完成', test: '测试事件已受理', rejected: '已拒绝', review: '结果待核对' };
  const modes = { mock: '本地模拟', test: 'Meta 测试事件', live: '正式回传' };
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const date = v => new Date(v).toLocaleString('zh-CN', { hour12: false });
  function field(parent, label, type = 'text') {
    const wrap = el('label', label), input = el(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    wrap.append(input); parent.append(wrap); return input;
  }
  function button(label, action) {
    const b = el('button', label); b.type = 'button';
    b.onclick = async () => {
      b.disabled = true;
      const parent = b.closest('dialog') || b.closest('section');
      let error = parent.querySelector('[role=alert]');
      if (!error) { error = el('p', '', 'notice'); error.setAttribute('role', 'alert'); parent.append(error); }
      error.textContent = '';
      try { await action(); } catch (e) { error.textContent = e.message || '操作失败，请刷新后核对'; }
      finally { b.disabled = false; }
    }; return b;
  }
  function prepare({ inquiry, api, reload }) {
    const d = el('dialog'); d.append(el('h2', '准备 Meta Ads 回传'));
    const sourceLabel = el('label', '询盘来源'), source = el('select');
    source.setAttribute('aria-label', '询盘来源');
    for (const [v, label] of [['website', '网站询盘'], ['instant_form', 'Facebook / Instagram 原生表单']]) {
      const o = el('option', label); o.value = v; source.append(o);
    }
    sourceLabel.append(source); d.append(sourceLabel);
    if (inquiry.source_kind === 'instant_form') source.value = 'instant_form';
    const eventLabel = el('label', '回传阶段'), event = el('select');
    event.setAttribute('aria-label', '回传阶段');
    for (const [v, label] of Object.entries(names)) { const o = el('option', label); o.value = v; event.append(o); }
    eventLabel.append(event); d.append(eventLabel);
    const instant = el('div'), lead = field(instant, 'Meta Lead ID（原生表单编号）'), generated = field(instant, 'Meta 线索生成时间', 'datetime-local');
    generated.step = '1'; instant.hidden = true; d.append(instant);
    const consentLabel = el('label', '', 'check'), consent = el('input'); consent.type = 'checkbox';
    consentLabel.append(consent, el('span', '已核验原生表单身份与广告数据使用依据')); instant.append(consentLabel);
    const converted = el('div'), occurred = field(converted, '真实成交时间', 'datetime-local'); occurred.step = '1'; converted.hidden = true; d.append(converted);
    const note = el('p', '', 'muted'); d.append(note);
    function update() {
      instant.hidden = source.value !== 'instant_form'; converted.hidden = event.value !== 'ConvertedLead';
      note.textContent = event.value === 'Lead' ? (source.value === 'instant_form' ? '使用已核验的 Meta 表单提交时间；导入 Inbox 不会改写原始时间。' : '使用 Inbox 实际收件时间：' + date(inquiry.created_at))
        : event.value === 'QualifiedLead' ? (inquiry.qualified_at ? '使用人工确认有效时间：' + date(inquiry.qualified_at) : '请先在询盘详情中确认有效线索。')
          : '仅用于已核验的真实成交；填写成交依据。';
    }
    source.onchange = update; event.onchange = update; update();
    const evidence = field(d, '核验依据', 'textarea');
    const confirmLabel = el('label', '', 'check'), confirm = el('input'); confirm.type = 'checkbox';
    confirmLabel.append(confirm, el('span', '已核实来源、阶段和时间，并核对旧系统没有重复回传')); d.append(confirmLabel);
    d.append(button('保存待回传事件', async () => {
      if (!confirm.checked) throw Error('请核实并勾选确认项');
      await api('meta_prepare', { id: inquiry.id, sourceType: source.value, eventName: event.value,
        evidence: evidence.value, confirmed: true,
        ...(source.value === 'instant_form' ? { metaLeadId: lead.value.trim(), leadGeneratedAt: generated.value ? new Date(generated.value).toISOString() : '', consentConfirmed: consent.checked } : {}),
        ...(event.value === 'ConvertedLead' ? { occurredAt: occurred.value ? new Date(occurred.value).toISOString() : '' } : {}),
      }); d.close(); await reload();
    }), button('取消', async () => d.close()));
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  }
  function render({ settings, receipts, inquiry, api, reload, openInquiry, heading = true }) {
    const rawApi=api;api=async(...args)=>{const result=await rawApi(...args);if(result.metaError)throw Error(result.metaError);return result;};
    const root = el('section', null, 'panel'); if(heading)root.append(el('h2', 'Meta Ads 回传'));
    root.append(el('p', `${modes[settings.mode]} · ${settings.enabled ? '已启用' : '未启用'}${settings.mode === 'mock' ? ' · 不上传到 Meta' : settings.configured ? ' · 数据集已配置' : ' · 等待数据集配置'}`, 'notice'));
    if (settings.mode === 'test' && !settings.testCodeConfigured) root.append(el('p', '等待当前数据集的 Test Events 测试代码，尚不能发送。', 'notice'));
    if (settings.mode === 'test') root.append(el('p', 'Test Events 会真实发送到 Meta，并可能用于广告衡量；切换正式模式后，同一阶段仍不重复发送。', 'notice'));
    root.append(el('p', '按收到线索、有效线索、成交线索的顺序回传。已受理仅表示收到事件，广告匹配状态仍需在 Meta 核对。', 'muted'));
    if (inquiry && settings.enabled) root.append(button('准备回传事件', () => prepare({ inquiry, api, reload })));
    else if (!inquiry) root.append(el('p', '在询盘详情中核验阶段并准备事件，然后在此一键回传。', 'muted'));
    const wrap = el('div', null, 'table-wrap'), table = el('table'), head = el('thead'), tr = el('tr'), body = el('tbody');
    const labels = ['阶段 / 发生时间', '来源 / 模式', '回传结果', '操作']; labels.forEach(t => tr.append(el('th', t))); head.append(tr);
    for (const r of receipts) {
      const line = el('tr'), values = [el('div'), el('div'), el('div'), el('div')];
      values[0].append(el('strong', names[r.event_name]), el('small', date(r.occurred_at)));
      values[1].append(el('span', r.source_type === 'website' ? '网站' : '原生表单'), el('small', modes[r.mode]));
      values[2].append(el('strong', states[r.status]), el('small', '匹配：未知'));
      if (r.response_id) values[2].append(el('small', '回执：' + r.response_id, 'code'));
      if (r.error_code) values[2].append(el('small', r.error_code, 'code'));
      if (settings.canSend && ['ready', 'rejected'].includes(r.status) && r.mode === settings.mode && r.dataset_id === settings.datasetId) {
        const send = button(r.status === 'rejected' ? '重试回传' : '一键回传', async () => {
          await api('meta_send', { inquiryId: r.inquiry_id, feedbackId: r.id }); await reload();
        }); send.setAttribute('aria-label', (r.status === 'rejected' ? '重试回传 ' : '一键回传 ') + names[r.event_name]); values[3].append(send);
      } else values[3].append(el('span', r.status === 'review' ? '请先核对 Meta 记录' : ['accepted', 'mock', 'test'].includes(r.status) ? '已记录，不重复发送' : '等待配置或结果'));
      if (openInquiry && !inquiry) values[3].append(button('查看询盘', () => openInquiry(r.inquiry_id)));
      values.forEach((v, i) => { const cell = el('td'); cell.dataset.label = labels[i]; cell.append(v); line.append(cell); }); body.append(line);
    }
    table.append(head, body); wrap.append(table); root.append(wrap);
    if (!receipts.length) root.append(el('p', '暂无 Meta 回传记录。', 'empty'));
    return root;
  }
  window.akeMetaFeedback = { render };
})();
