(() => {
  let account,loaded=false,marketing=false,shownConversation;
  const style=document.createElement('style');style.textContent=`body.ake-workspace{padding-top:48px;box-sizing:border-box;height:100dvh;overflow:hidden}body.ake-workspace #app{height:100%!important;min-height:0}#ake-workspace-nav{height:48px;position:fixed;inset:0 0 auto;z-index:90;display:flex;align-items:center;gap:6px;padding:0 16px;border-bottom:1px solid #dbe3eb;background:#fff;color:#253345;font:13px system-ui;white-space:nowrap;overflow-x:auto}#ake-workspace-nav>a,#ake-workspace-nav select{padding:10px 12px;color:#526578;text-decoration:none;border:0;border-radius:5px;background:transparent;min-height:40px;font:inherit}#ake-workspace-nav select{width:auto;max-width:190px;flex:0 0 auto}#ake-workspace-nav>a{flex-shrink:0}#ake-workspace-nav>a:hover{background:#eff4f8}#ake-workspace-nav a[aria-current=page]{color:#1768ab;background:#edf5fc;font-weight:600}#ake-workspace-nav .ake-brand{font-weight:700;color:#da251d;margin-right:12px}#ake-workspace-nav .ake-spacer{flex:1}#ake-workspace-nav :focus-visible{outline:2px solid #257abf;outline-offset:-2px}@media(max-width:700px){#ake-workspace-nav{padding:0 8px;gap:0}#ake-workspace-nav .ake-brand{display:none}}`;
  document.head.append(style);
  const link=(label,href)=>{const a=document.createElement('a');a.textContent=label;a.href=href;return a;};
  function active(){
    document.querySelectorAll('#ake-workspace-nav a').forEach(a=>{a.removeAttribute('aria-current');if(!a.classList.contains('ake-brand')&&new URL(a.href).pathname===location.pathname)a.setAttribute('aria-current','page');});
  }
  async function attach(){
    const match=location.pathname.match(/^\/app\/accounts\/(\d+)/);
    if(!match){document.getElementById('ake-workspace-nav')?.remove();document.body.classList.remove('ake-workspace');loaded=false;return;}
    if(loaded&&account===match[1]){active();void attribution();return;}
    if(!window.akeApi)return;
    account=match[1];loaded=true;
    try{
      const [inboxes,seats]=await Promise.all([window.akeApi(account,'/inboxes'),window.akeApi(account,'/ake_seats')]);
      marketing=seats.marketing_enabled;
      document.getElementById('ake-workspace-nav')?.remove();
      const nav=document.createElement('nav');nav.id='ake-workspace-nav';nav.setAttribute('aria-label','消息与客户工作区');
      const brand=link('AKE INBOX',`/app/accounts/${account}/dashboard`);brand.className='ake-brand';nav.append(brand);
      nav.append(link(seats.role==='administrator'?'全部会话':'我的会话',`/app/accounts/${account}/dashboard`));
      for(const [type,label]of [['Channel::WebWidget','Website'],['Channel::Email','邮箱'],['Channel::Api','WhatsApp']]){
        const rows=(inboxes.payload||[]).filter(i=>i.channel_type===type);
        if(rows.length===1)nav.append(link(label,`/app/accounts/${account}/inbox/${rows[0].id}`));
        else if(rows.length>1){
          const select=document.createElement('select');select.setAttribute('aria-label',label+' 渠道');
          const title=document.createElement('option');title.value='';title.textContent=label;select.append(title);
          for(const row of rows){const o=document.createElement('option');o.value=row.id;o.textContent=row.name;select.append(o);}
          select.onchange=()=>{if(select.value)location.href=`/app/accounts/${account}/inbox/${select.value}`;};nav.append(select);
        }else nav.append(link(label+' · 连接',`/ake/channels?account=${account}`));
      }
      const spacer=document.createElement('span');spacer.className='ake-spacer';nav.append(spacer);
      nav.append(link('客户管理',`/ake/customers?account=${account}`),link('我的渠道',`/ake/channels?account=${account}`));
      if(seats.marketing_enabled){nav.append(link('营销',`/ake/marketing?account=${account}`));if(seats.role==='administrator')nav.append(link('Meta Ads 回传',`/ake/marketing?account=${account}&view=meta_feedback`));}
      document.body.append(nav);document.body.classList.add('ake-workspace');active();
    }catch{loaded=false;}
  }
  async function attribution(){
    const cid=location.pathname.match(/\/conversations\/(\d+)/)?.[1];
    if(!marketing||cid===shownConversation)return;shownConversation=cid;document.querySelector('#ake-source-panel')?.remove();if(!cid)return;
    try{const d=await window.akeApi(account,'/ake_marketing/inquiries',{input:{conversationId:Number(cid)}});if(shownConversation!==cid)return;
      const p=document.createElement('details');p.id='ake-source-panel';p.style.cssText='position:fixed;bottom:16px;right:16px;z-index:80;background:white;color:#253345;border:1px solid #ccd9e5;border-radius:8px;padding:12px;max-width:320px;max-height:65vh;overflow:auto;font:13px/1.5 system-ui;box-shadow:0 4px 20px #26374720';
      const summary=document.createElement('summary');summary.textContent='网站来源与轨迹 · '+d.inquiries.length+' 条询盘';p.append(summary);
      for(const i of d.inquiries){const row=document.createElement('p'),a=document.createElement('a');row.textContent='首次：'+(i.first_touch?.source||'覆盖未知')+' · 本次：'+(i.current_touch?.source||'覆盖未知')+' · '+new Date(i.created_at).toLocaleString('zh-CN');a.textContent='查看访问时间线、关联依据与纠正';a.href='/ake/marketing?account='+account+'&inquiry='+i.id;row.append(document.createElement('br'),a);p.append(row);}
      if(!d.inquiries.length){const text=document.createElement('p');text.textContent='暂无可信网站关联。历史覆盖未知。';p.append(text);}document.body.append(p);
    }catch{shownConversation=undefined;}
  }
  attach();setInterval(attach,3000);
})();
