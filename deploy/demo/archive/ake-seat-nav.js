(() => {
  let account,loaded=false,marketing=false,shownConversation;
  const style=document.createElement('style');style.textContent=`
    body.ake-workspace{--ake-nav-height:60px;padding-top:var(--ake-nav-height);box-sizing:border-box;height:100dvh;overflow:hidden}
    body.ake-workspace #app{height:100%!important;min-height:0}
    #ake-workspace-nav{height:var(--ake-nav-height);position:fixed;inset:0 0 auto;z-index:90;display:flex;align-items:center;gap:20px;padding:0 20px;border-bottom:1px solid #dfe5eb;background:#fff;color:#253345;font:14px/1.4 system-ui,sans-serif;white-space:nowrap;box-sizing:border-box}
    #ake-workspace-nav a{color:#586979;text-decoration:none}
    #ake-workspace-nav .ake-brand{display:flex;align-items:center;gap:12px;font-size:15px;font-weight:750;letter-spacing:.5px;color:#da251d;flex-shrink:0}
    #ake-workspace-nav .ake-brand small{border-left:1px solid #dfe5eb;padding-left:12px;color:#526578;font-size:13px;font-weight:500;letter-spacing:0}
    #ake-workspace-nav .ake-nav-links{display:flex;align-items:center;gap:4px;min-width:0;scrollbar-width:thin}
    #ake-workspace-nav .ake-primary{overflow-x:auto}
    #ake-workspace-nav .ake-nav-links>a,#ake-workspace-nav select{min-height:44px;display:flex;align-items:center;padding:10px 12px;box-sizing:border-box;font:inherit;flex-shrink:0;border:0;border-radius:8px;background:transparent}
    #ake-workspace-nav select{max-width:180px;color:#586979;cursor:pointer}
    #ake-workspace-nav .ake-nav-links>a:hover,#ake-workspace-nav select:hover{background:#f3f5f7;color:#253345}
    #ake-workspace-nav [aria-current=page]{background:#fff0ef!important;color:#b51e18!important;font-weight:650}
    #ake-workspace-nav .ake-secondary{margin-left:auto;border-left:1px solid #e8edf1;padding-left:12px}
    #ake-workspace-nav .ake-secondary a{font-size:13px;padding-left:10px;padding-right:10px}
    #ake-workspace-nav :focus-visible{outline:2px solid #b51e18;outline-offset:-2px}
    #ake-reception-status{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;flex-shrink:0;padding:9px 12px;border:1px solid #d8e0e6;border-radius:8px;background:#f7f9fb;color:#526578;font:13px system-ui,sans-serif;cursor:pointer}
    #ake-reception-status:before{content:"";width:7px;height:7px;border-radius:50%;background:#7b8893;flex-shrink:0}
    #ake-reception-status[data-state=online]{background:#f0f8f3;border-color:#cce3d5;color:#216444}
    #ake-reception-status[data-state=online]:before{background:#2d845a}
    #ake-reception-status[data-state=error]{background:#fff8ec;border-color:#e5d2ae;color:#875c1b}
    #ake-reception-status[data-state=error]:before{background:#a96f1b}
    #ake-reception-status:disabled{cursor:wait;opacity:.65}
    #ake-reception-status:hover:not(:disabled){filter:brightness(.97)}
    body.ake-workspace .conversation-panel{background:#f7f9fb;padding-left:20px;padding-right:20px}
    body.ake-workspace .reply-box{border-radius:12px;border-color:#dfe5eb;box-shadow:none}
    @media(min-width:1080px){body.ake-workspace .conversations-list-wrap{width:clamp(280px,24vw,360px)}}
    @media(max-width:1230px){#ake-workspace-nav{gap:10px;padding:0 12px}#ake-workspace-nav .ake-brand small{display:none}#ake-workspace-nav .ake-nav-links>a,#ake-workspace-nav select{padding-left:10px;padding-right:10px}}
    @media(max-width:1079px){body.ake-workspace{--ake-nav-height:108px}#ake-workspace-nav{display:grid;grid-template-columns:1fr auto;grid-template-rows:58px 49px;gap:0;padding:0 12px}#ake-workspace-nav .ake-brand small{display:inline}#ake-workspace-nav .ake-primary{grid-row:2;grid-column:1/-1;border-top:1px solid #edf0f3;overflow-x:auto;height:49px}#ake-workspace-nav .ake-secondary{position:absolute;right:225px;top:7px;border:0}#ake-reception-status{grid-column:2;grid-row:1}body.ake-workspace .conversation-panel{padding-left:12px;padding-right:12px}}
    @media(max-width:700px){#ake-workspace-nav .ake-brand{font-size:14px;gap:8px}#ake-workspace-nav .ake-brand small{font-size:12px;padding-left:8px}#ake-workspace-nav .ake-secondary{position:static;display:contents}#ake-workspace-nav .ake-secondary>a{display:none}#ake-workspace-nav .ake-mobile-link{display:flex}#ake-reception-status{font-size:12px;padding:8px;gap:6px}}
    @media(min-width:701px){#ake-workspace-nav .ake-nav-links>a.ake-mobile-link{display:none}}
    @media(max-width:350px){#ake-workspace-nav .ake-brand small{display:none}}
    .dark #ake-workspace-nav{background:#171b20;color:#e7edf3;border-color:#343c46}
    .dark #ake-workspace-nav a,.dark #ake-workspace-nav select{color:#bac6d2}
    .dark #ake-workspace-nav [aria-current=page]{background:#422623!important;color:#ffb5ad!important}
    .dark #ake-workspace-nav .ake-nav-links>a:hover,.dark #ake-workspace-nav select:hover{background:#262d35;color:#fff}
    .dark body.ake-workspace .conversation-panel{background:#171b20}
  `;
  document.head.append(style);
  const link=(label,href)=>{const a=document.createElement('a');a.textContent=label;a.href=href;a.dataset.route=new URL(href,location.origin).pathname;return a;};
  function active(){
    document.querySelectorAll('#ake-workspace-nav [data-route]').forEach(control=>{
      const path=control.dataset.route;
      let selected=path.endsWith('/dashboard') ? /\/(dashboard|inbox\/all)(\/|$)/.test(location.pathname) : location.pathname===path||location.pathname.startsWith(path+'/');
      if(control.tagName==='SELECT'){control.value=location.pathname.match(/\/inbox\/(\d+)/)?.[1]||'';selected=!!control.value;}
      selected?control.setAttribute('aria-current','page'):control.removeAttribute('aria-current');
    });
    // Chatwoot's current Chinese catalogue leaves this navigation label in English.
    // Limit this presentation fix to the navigation link, never message content.
    document.querySelectorAll('a[href$="/calls"]').forEach(a=>{
      const label=a.querySelector('span.truncate');
      if(label?.textContent==='Calls')label.textContent='通话';
      if(a.title==='Calls')a.title='通话';
      if(a.getAttribute('name')==='Calls')a.setAttribute('name','通话');
    });
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
      const nav=document.createElement('nav');nav.id='ake-workspace-nav';nav.setAttribute('aria-label','接待工作区');nav.lang='zh-CN';
      const brand=link('AKE INBOX',`/app/accounts/${account}/dashboard`);brand.className='ake-brand';delete brand.dataset.route;const desk=document.createElement('small');desk.textContent='接待工作台';brand.append(desk);nav.append(brand);const primary=document.createElement('div');primary.className='ake-nav-links ake-primary';nav.append(primary);
      primary.append(link(seats.role==='administrator'?'全部会话':'我的会话',`/app/accounts/${account}/dashboard`));
      for(const [type,label]of [['Channel::WebWidget','网站'],['Channel::Email','邮箱'],['Channel::Api','WhatsApp']]){
        const rows=(inboxes.payload||[]).filter(i=>i.channel_type===type);
        if(rows.length===1)primary.append(link(label,`/app/accounts/${account}/inbox/${rows[0].id}`));
        else if(rows.length>1){
          const select=document.createElement('select');select.setAttribute('aria-label',label+'渠道');select.dataset.route=`/app/accounts/${account}/inbox`;
          const title=document.createElement('option');title.value='';title.textContent=label;select.append(title);
          for(const row of rows){const o=document.createElement('option');o.value=row.id;o.textContent=row.name;select.append(o);}
          select.onchange=()=>{if(select.value)location.href=`/app/accounts/${account}/inbox/${select.value}`;};primary.append(select);
        }else primary.append(link(label+' · 连接',`/ake/channels?account=${account}`));
      }
      const secondary=document.createElement('div');secondary.className='ake-nav-links ake-secondary';nav.append(secondary);
      const utilities=[['客户管理',`/ake/customers?account=${account}`],['渠道设置',`/ake/channels?account=${account}`]];
      if(seats.marketing_enabled)utilities.push(['营销',`/ake/marketing?account=${account}`]);
      for(const [label,href] of utilities){secondary.append(link(label,href));const mobile=link(label,href);mobile.className='ake-mobile-link';primary.append(mobile);}
      document.body.append(nav);document.body.classList.add('ake-workspace');document.documentElement.lang='zh-CN';active();window.dispatchEvent(new Event('ake:workspace-ready'));
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
