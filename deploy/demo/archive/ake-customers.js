(() => {
  const $=id=>document.getElementById(id),account=new URL(location.href).searchParams.get('account')||'1';
  const api=path=>window.akeApi(account,'/ake_customers'+path),escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={'Channel::WebWidget':'网站','Channel::Email':'邮箱','Channel::Api':'WhatsApp'},tags=items=>items.map(x=>`<span class="tag">${escape(x)}</span>`).join('');
  const date=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
  const conversation=id=>`/app/accounts/${encodeURIComponent(account)}/conversations/${Number(id)}`;
  let page=1,busy=false,detailId;
  $('brand').href=$('conversations').href=`/app/accounts/${account}/dashboard`;$('channels').href=`/ake/channels?account=${account}`;
  async function load(){
    if(busy)return;busy=true;$('notice').textContent='正在读取…';$('notice').classList.remove('error');
    try{
      const query=new URLSearchParams({page,q:$('search').value,channel:$('channel').value,label:$('label').value});
      const data=await api('?'+query);
      $('scope').textContent=data.role==='administrator'?'查看全部接待客户、坐席归属与 OKKI 关联资料。':'仅显示分配给您的会话所关联的客户。';
      $('notice').textContent=data.crm_available?'':'OKKI 资料暂时不可读取；Inbox 客户和会话仍可查看。';
      $('rows').innerHTML=data.customers.length?data.customers.map(c=>`<tr><td><span class="name">${escape(c.crm?.name||c.company||c.name)}</span><span class="sub">${escape(c.name)} · ${escape(c.email_hint)}</span></td><td>${escape(c.country||'—')}</td><td>${tags(c.channels.map(x=>names[x]||x))}</td><td>${tags(c.labels)||'—'}</td><td>${escape(c.owners.join('、')||'待分配')}</td><td>${c.crm?`${c.crm.companyId?'客户 #'+escape(c.crm.companyId):'线索 #'+escape(c.crm.leadId)}<span class="sub">${escape(c.crm.stage||c.crm.opportunities?.[0]?.stage||'')}</span>`:'未关联'}</td><td>${date(c.last_activity_at)}</td><td><button data-detail="${c.id}">查看</button></td></tr>`).join(''):'<tr><td colspan="8" class="empty">暂无符合条件的客户。新的询盘会在这里显示。</td></tr>';
      $('count').textContent=`共 ${data.total} 位 · 第 ${page} 页`;$('prev').disabled=page===1;$('next').disabled=page*30>=data.total;
    }catch(e){$('notice').textContent=e.message;$('notice').classList.add('error');$('rows').innerHTML='<tr><td colspan="8" class="empty">暂时无法载入客户，请重试。</td></tr>';}
    finally{busy=false;}
  }
  async function detail(id,refresh=false){
    detailId=Number(id);if(!$('details').open)$('details').showModal();$('detail-body').textContent='正在读取客户资料…';
    try{
      const c=await api('/'+Number(id)+(refresh?'?refresh=true':''));if(detailId!==Number(id))return;
      $('detail-title').textContent=c.crm?.name||c.company||c.name;
      const crm=c.crm;
      $('detail-body').innerHTML=`<section class="detail-section"><h2>客户资料</h2><dl class="facts"><dt>联系人</dt><dd>${escape(c.name)}</dd><dt>国家／地区</dt><dd>${escape(c.country||'—')}</dd><dt>接待坐席</dt><dd>${escape(c.owners.join('、')||'待分配')}</dd><dt>标签</dt><dd>${tags(c.labels)||'—'}</dd></dl></section><section class="detail-section"><h2>OKKI 客户档案</h2>${crm?`<dl class="facts"><dt>客户／线索</dt><dd>${crm.companyId?'客户 #'+escape(crm.companyId):'线索 #'+escape(crm.leadId)}</dd><dt>OKKI 负责人</dt><dd>${escape(crm.owner||'—')}</dd><dt>客户阶段</dt><dd>${escape(crm.stage||'—')}</dd><dt>读取时间</dt><dd>${date(crm.refreshedAt)}</dd></dl><div class="actions" style="margin-top:16px"><button id="refresh-crm">从 OKKI 刷新资料和跟进</button></div><p class="sub">客户资料以 OKKI 为准。修改与商机创建沿用会话中的售前工作台。</p>`:`<p>${c.crm_available?'尚未关联 OKKI 客户。可从下方会话进入售前工作台核对和建档。':'暂时无法读取 OKKI 关联资料。'}</p>`}</section>${crm?.opportunities?.length?`<section class="detail-section"><h2>关联商机</h2>${crm.opportunities.map(o=>`<div class="record"><strong>${escape(o.name||'#'+o.id)}</strong><p>${escape(o.stage)} · ${escape(o.amount??'—')} ${escape(o.currency)}</p></div>`).join('')}</section>`:''}${refresh&&crm?`<section class="detail-section"><h2>OKKI 跟进动态</h2>${crm.followupsAvailable?(crm.followups.length?crm.followups.map(t=>`<div class="record"><span class="sub">${escape(t.createdAt||'')} ${escape(t.author||'')}</span><p>${escape(t.content)}</p></div>`).join(''):'<p>暂无跟进动态。</p>'):'<p>暂时无法读取跟进动态，请稍后刷新。</p>'}</section>`:''}<section class="detail-section"><h2>关联会话</h2>${c.conversations.map(v=>`<div class="record"><a href="${conversation(v.id)}">${escape(v.inbox)} · #${v.id} ↗</a><p class="sub">${escape(v.owner||'待分配')} · ${{open:'待处理',resolved:'已解决',pending:'等待处理',snoozed:'稍后处理'}[v.status]||escape(v.status)} · ${date(v.updated_at)}</p></div>`).join('')}</section>`;
      $('refresh-crm')?.addEventListener('click',()=>detail(id,true));
      try{const m=await window.akeApi(account,'/ake_marketing/inquiries',{input:{contactId:Number(id)}});if(detailId===Number(id)){
        const s=document.createElement('section');s.className='detail-section';const h=document.createElement('h2');h.textContent='营销询盘与访问轨迹';s.append(h);
        for(const item of m.inquiries){const p=document.createElement('p'),a=document.createElement('a');p.textContent=date(item.created_at)+' · '+(item.first_touch?.source||'历史来源未知')+' · ';a.textContent='查看询盘、访问时间线及关联依据';a.href='/ake/marketing?account='+account+'&inquiry='+item.id;p.append(a);s.append(p);}if(!m.inquiries.length){const p=document.createElement('p');p.textContent='暂无可信关联；未观察到的历史保持未知。';s.append(p);}$('detail-body').append(s);
      }}catch{/* Existing customer workflow remains available when marketing is disabled. */}
    }catch(e){$('detail-body').textContent=e.message;}
  }
  $('rows').addEventListener('click',e=>{const button=e.target.closest('[data-detail]');if(button)detail(button.dataset.detail);});
  $('filters').addEventListener('submit',e=>{e.preventDefault();page=1;load();});$('reset').onclick=()=>{$('filters').reset();page=1;load();};
  $('prev').onclick=()=>{page=Math.max(1,page-1);load();};$('next').onclick=()=>{page++;load();};$('close').onclick=()=>{$('details').close();detailId=undefined;};
  load();
})();
