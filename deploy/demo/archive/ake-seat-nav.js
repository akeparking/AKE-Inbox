(() => {
  let account,loaded=false,marketing=false,shownConversation,contextVersion=0;
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
  style.textContent+=`
    #ake-workspace-nav{gap:16px;height:64px;border-color:#e6e9ee}
    body.ake-workspace{--ake-nav-height:64px}
    #ake-workspace-nav .ake-brand{color:#fff;background:#252a30;align-self:stretch;margin-left:-20px;padding:0 20px;width:220px;box-sizing:border-box;letter-spacing:1px}
    #ake-workspace-nav .ake-brand small{display:none}
    #ake-workspace-nav [aria-current=page]{color:#1677ff!important;background:#eaf3ff!important}
    #ake-workspace-nav :focus-visible{outline-color:#1677ff}
    body.ake-workspace aside.ake-native-nav{background:#252a30!important;color:#c5cbd3;border-color:#343b44;--n-background:37 42 48;--n-slate-11:185 193 204;--n-slate-12:245 247 250}
    body.ake-workspace aside.ake-native-nav a,body.ake-workspace aside.ake-native-nav button{color:inherit}
    body.ake-workspace aside.ake-native-nav .text-n-slate-12{color:#f0f3f7}
    body.ake-workspace aside.ake-native-nav a:hover,body.ake-workspace aside.ake-native-nav button:hover{background:#343c46}
    body.ake-workspace aside.ake-native-nav a.router-link-active{background:#1677ff;color:#fff}
    body.ake-workspace aside.ake-native-nav .bg-gradient-to-t{background-image:none!important}
    body.ake-workspace aside.ake-native-nav input{background:#353c45;color:#fff;border-color:#46515e}
    body.ake-workspace .conversation-panel{background:#f5f7fa}
    body.ake-workspace .reply-box{border-radius:8px}
    #ake-source-panel{flex:0 0 300px;width:300px;min-width:0;overflow:auto;border-left:1px solid #e6e9ee;background:#fff;color:#263345;padding:22px 18px;font:13px/1.65 system-ui,sans-serif;box-sizing:border-box}
    #ake-source-panel h2{font-size:15px;font-weight:650;margin:0 0 16px}
    #ake-source-panel h3{font-size:13px;font-weight:600;margin:24px 0 10px;border-top:1px solid #edf0f3;padding-top:20px}
    #ake-source-panel p{margin:6px 0;overflow-wrap:anywhere}
    #ake-source-panel .ake-context-muted{color:#748294;font-size:12px}
    #ake-source-panel .ake-context-name{font-size:18px;font-weight:600;margin-bottom:6px}
    #ake-source-panel .ake-context-link{display:block;color:#1677ff;text-decoration:none;margin-top:12px;min-height:32px}
    #ake-source-panel button{font:inherit;border:1px solid #dce3eb;border-radius:5px;padding:8px 12px;min-height:40px;background:#fff;color:#355270;cursor:pointer;margin-top:12px}
    #ake-source-panel button:hover{background:#edf5ff}
    #ake-source-panel :focus-visible{outline:2px solid #1677ff;outline-offset:2px}
    #ake-source-panel details>summary{font-weight:650;cursor:pointer;min-height:32px}
    .ake-context-native #ake-source-panel{width:auto;flex:0 0 auto;max-height:42vh;border-left:0;border-bottom:1px solid #e6e9ee}
    @media(min-width:1080px){body.ake-workspace aside.ake-native-nav{width:220px!important}body.ake-workspace .conversations-list-wrap{width:286px!important}}
    @media(max-width:1399px){#ake-source-panel{flex-basis:260px;width:260px;padding:18px 14px}}
    @media(max-width:1199px){#ake-source-panel{position:fixed;right:16px;bottom:16px;z-index:30;width:280px;max-height:60vh;border:1px solid #dce3eb;border-radius:8px;padding:12px 16px;box-shadow:0 4px 18px #26374714}.ake-context-native #ake-source-panel{position:static;width:auto;max-height:35vh;border-radius:0;box-shadow:none}}
    @media(max-width:1079px){body.ake-workspace{--ake-nav-height:108px}#ake-workspace-nav{height:108px;gap:0}#ake-workspace-nav .ake-brand{background:transparent;color:#253345;width:auto;margin:0;padding:0}#ake-workspace-nav .ake-secondary{right:205px}#ake-workspace-nav .ake-secondary a{padding:10px 7px;font-size:12px}}
    @media(min-width:1080px) and (max-width:1230px){#ake-workspace-nav .ake-brand{margin-left:-12px;width:208px;padding-left:20px}#ake-workspace-nav{gap:8px}#ake-workspace-nav .ake-secondary{padding-left:4px}#ake-workspace-nav .ake-secondary a{padding:10px 6px;font-size:12px}}
    @media(max-width:700px){#ake-source-panel{bottom:12px;right:12px;max-width:calc(100vw - 24px)}#ake-workspace-nav .ake-secondary{position:static}body.ake-workspace aside.ake-native-nav{top:var(--ake-nav-height);height:calc(100dvh - var(--ake-nav-height))}}
  `;
  document.head.append(style);
  const link=(label,href)=>{const a=document.createElement('a');a.textContent=label;a.href=href;a.dataset.route=new URL(href,location.origin).pathname;return a;};
  function active(){
    document.querySelector('#app aside')?.classList.add('ake-native-nav');
    placeContext();
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
    if(!match){document.getElementById('ake-workspace-nav')?.remove();document.querySelector('#ake-source-panel')?.remove();document.body.classList.remove('ake-workspace');loaded=false;shownConversation=undefined;contextVersion++;return;}
    if(loaded&&account===match[1]){active();void attribution();return;}
    if(!window.akeApi)return;
    account=match[1];loaded=true;shownConversation=undefined;contextVersion++;
    document.querySelector('#ake-source-panel')?.remove();
    const requestedAccount=account;
    try{
      const [inboxes,seats]=await Promise.all([window.akeApi(account,'/inboxes'),window.akeApi(account,'/ake_seats')]);
      if(requestedAccount!==account)return;
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
      if(seats.marketing_enabled){utilities.push(['询盘管理',`/ake/marketing?account=${account}`]);if(seats.role==='administrator')utilities.push(['Meta 回传',`/ake/marketing?account=${account}&view=meta_feedback`]);}
      for(const [label,href] of utilities){secondary.append(link(label,href));const mobile=link(label,href);mobile.className='ake-mobile-link';primary.append(mobile);}
      document.body.append(nav);document.body.classList.add('ake-workspace');document.documentElement.lang='zh-CN';active();void attribution();window.dispatchEvent(new Event('ake:workspace-ready'));
    }catch{loaded=false;}
  }
  function placeContext(){
    const panel=document.querySelector('#ake-source-panel'),conversation=document.querySelector('.conversation-details-wrap');
    if(!panel||!conversation)return;
    const row=conversation.parentElement;
    const native=[...row.children].find(x=>x!==panel&&x!==conversation&&x.classList.contains('max-w-sm'));
    document.querySelectorAll('.ake-context-native').forEach(x=>x.classList.remove('ake-context-native'));
    const host=native||row;
    if(native)native.classList.add('ake-context-native');
    if(panel.parentElement!==host){if(native)host.prepend(panel);else host.append(panel);}
  }
  const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  async function attribution(){
    const cid=location.pathname.match(/\/conversations\/(\d+)/)?.[1];
    if(cid===shownConversation&&(!cid||document.querySelector('#ake-source-panel')))return;shownConversation=cid;const version=++contextVersion;
    document.querySelector('#ake-source-panel')?.remove();if(!cid)return;
    const p=node('aside');p.id='ake-source-panel';p.setAttribute('aria-label','客户与询盘概览');
    const details=node('details');details.open=innerWidth>=1200;details.append(node('summary','客户与询盘'));p.append(details);document.body.append(p);placeContext();
    const content=node('div');content.append(node('p','正在读取客户资料…','ake-context-muted'));details.append(content);
    try{
      const conversation=await window.akeApi(account,'/conversations/'+cid);
      if(version!==contextVersion)return;
      const customer=conversation.meta?.sender||{};
      content.replaceChildren(node('h3','客户概览'),node('p',customer.name||'未填写姓名','ake-context-name'));
      for(const value of [customer.additional_attributes?.company_name,customer.email,customer.phone_number])if(value)content.append(node('p',value));
      if(!customer.email&&!customer.phone_number)content.append(node('p','尚未提供联系方式','ake-context-muted'));
      const more=node('button','查看 / 编辑客户资料');more.type='button';more.onclick=()=>{
        const native=document.querySelector('.ake-context-native');
        if(native)native.querySelector(':scope > div button')?.focus();
        else document.querySelector('.conversation-details-wrap .i-ph-user-bold')?.closest('button')?.click();
      };content.append(more);
      content.append(node('h3','询盘与来源'));
      if(!marketing){content.append(node('p','询盘管理尚未启用。','ake-context-muted'));return;}
      const d=await window.akeApi(account,'/ake_marketing/inquiries',{input:{conversationId:Number(cid)}});
      if(version!==contextVersion)return;
      for(const i of d.inquiries){
        content.append(node('p',i.qualified_at?'已确认有效线索':'待人工核验'));
        content.append(node('p','首次来源：'+(i.first_touch?.source||'覆盖未知'),'ake-context-muted'),node('p','本次来源：'+(i.current_touch?.source||'覆盖未知'),'ake-context-muted'));
        const a=link('查看询盘、访问轨迹与回传',`/ake/marketing?account=${account}&inquiry=${encodeURIComponent(i.id)}`);a.className='ake-context-link';content.append(a);
      }
      if(!d.inquiries.length)content.append(node('p','此会话暂无关联询盘。','ake-context-muted'),node('p','历史访问来源覆盖未知，不自动推断广告归因。','ake-context-muted'));
      const all=link('打开询盘管理',`/ake/marketing?account=${account}&view=inquiries`);all.className='ake-context-link';content.append(all);
    }catch{
      if(version!==contextVersion)return;
      const error=node('p','客户或询盘资料暂时无法读取。','ake-context-muted');error.setAttribute('role','alert');content.append(error);
      const retry=node('button','重新读取');retry.type='button';retry.onclick=()=>{shownConversation=undefined;void attribution();};content.append(retry);
    }
  }
  const wideContext=matchMedia('(min-width:1200px)');
  wideContext.addEventListener('change',()=>{const details=document.querySelector('#ake-source-panel>details');if(details)details.open=wideContext.matches;});
  attach();setInterval(attach,3000);
})();
