/* AKE first-party marketing collector. No keystrokes, page bodies or recordings. */
(() => {
  'use strict';
  if (window.AKEMarketing?.version) return;
  const pendingConsent=window.AKEMarketing?.pendingConsent;
  const cfg=window.AKE_MARKETING||{},base=String(cfg.apiBase||'').replace(/\/$/,''),siteId=cfg.siteId;
  if(!base||!siteId)return;
  const prefix='ake.marketing.'+siteId+'.',id=()=>crypto.randomUUID();
  let storageAvailable=true;
  try{localStorage.setItem(prefix+'probe','1');localStorage.removeItem(prefix+'probe');}catch{storageAvailable=false;}
  const get=k=>{try{return localStorage.getItem(prefix+k);}catch{return null;}};
  const set=(k,v)=>{if(!storageAvailable)return;try{v==null?localStorage.removeItem(prefix+k):localStorage.setItem(prefix+k,v);}catch{storageAvailable=false;}};
  let consent={analytics:'unknown',adStorage:'unknown',adUserData:'unknown',adPersonalization:'unknown'};
  try{consent={...consent,...JSON.parse(get('consent')||'{}')};}catch{/* Choice is unknown if storage is invalid. */}
  let visitorToken=get('visitor'),visitToken=get('visit'),session=null,sessionPromise=null,queue=[],flushPromise=null,generation=0,navigation=Promise.resolve();
  let page={url:location.href,title:document.title,id:id()},visibleAt=document.visibilityState==='visible'?performance.now():null;
  let pageRecorded=false,lastNavigation=location.href,hiddenAt=null;
  const eligible=()=>![/\/wp-admin(?:\/|$)/,/\/wp-login\.php/,/\/login(?:\/|$)/,/\/checkout(?:\/|$)/,...(cfg.excludedPaths||[]).map(x=>new RegExp(x))].some(p=>p.test(new URL(page.url,location.href).pathname));
  const notify=(name,detail)=>window.dispatchEvent(new CustomEvent('ake:marketing:'+name,{detail}));
  async function request(path,body){
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',signal:AbortSignal.timeout(12000)});
    const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(r.status===409?'Please reload the form and try again.':'Request unavailable ('+r.status+').');return d;
  }
  async function ensureSession(force=false){
    if(session&&!force)return session;if(sessionPromise&&!force)return sessionPromise;
    const revision=generation;
    const pending=request('/public/session',{siteId,visitorToken:visitorToken||undefined,visitToken:visitToken||undefined,consent,policyVersion:cfg.policyVersion||'1',pageUrl:page.url,referrer:document.referrer,storageAvailable}).then(d=>{
      if(revision!==generation)return null;session=d;visitorToken=d.visitorToken;visitToken=d.visitToken;
      if(consent.analytics==='granted'){set('visitor',visitorToken);set('visit',visitToken);}else{set('visitor',null);set('visit',null);}
      notify('coverage',d.coverage);return d;
    }).finally(()=>{if(sessionPromise===pending)sessionPromise=null;});sessionPromise=pending;return pending;
  }
  function event(type,extra={}){
    if(consent.analytics!=='granted'||!eligible())return;
    queue.push({sessionToken:session?.sessionToken,data:{eventId:id(),eventType:type,pageUrl:page.url,title:page.title,clientAt:new Date().toISOString(),...extra}});
    if(queue.length>200){queue=queue.slice(-200);notify('coverage',{droppedEvents:true});}
  }
  async function flush(){
    if(flushPromise)return flushPromise;if(!queue.length||consent.analytics!=='granted')return;
    flushPromise=(async()=>{
    try{const s=await ensureSession();if(!s?.visitorId||!queue.length)return;const token=queue[0].sessionToken||s.sessionToken,batch=queue.filter(e=>(e.sessionToken||s.sessionToken)===token).slice(0,20),r=await request('/public/events',{siteId,sessionToken:token,events:batch.map(e=>e.data)});const accepted=new Set(r.accepted.map(x=>x.eventId));queue=queue.filter(e=>!accepted.has(e.data.eventId));}
    catch{notify('coverage',{transport:'unavailable',history:'only_acknowledged_events_are_saved'});}
    })().finally(()=>{flushPromise=null;});return flushPromise;
  }
  function dwell(){
    if(visibleAt===null)return;const now=performance.now(),ms=Math.max(0,Math.min(60000,Math.round(now-visibleAt)));visibleAt=now;
    if(pageRecorded&&ms>0)event('page_engagement',{activeMs:ms,pageViewId:page.id});
  }
  async function pageview(){
    if(consent.analytics!=='granted'||!eligible())return;
    try{const s=await ensureSession();if(!s||pageRecorded)return;pageRecorded=true;event('page_view',{pageViewId:page.id});await flush();}catch{notify('coverage',{transport:'blocked_or_unavailable'});}
  }
  async function navigate(next,revision){
    if(revision!==generation)return;dwell();await flush();if(revision!==generation)return;page=next;pageRecorded=false;session=null;
    visibleAt=document.visibilityState==='visible'?performance.now():null;await pageview();
  }
  function queueNavigation(){
    if(location.href===lastNavigation)return;lastNavigation=location.href;
    const next={url:location.href,title:document.title,id:id()},revision=generation;
    if(consent.analytics!=='granted'){page=next;pageRecorded=false;session=null;return;}
    navigation=navigation.then(()=>navigate(next,revision)).catch(()=>notify('coverage',{transport:'navigation_unavailable'}));
  }
  for(const name of ['pushState','replaceState']){const original=history[name];history[name]=function(...args){const result=original.apply(this,args);queueNavigation();return result;};}
  window.addEventListener('popstate',queueNavigation);
  document.addEventListener('visibilitychange',async()=>{
    if(document.visibilityState!=='visible'){dwell();hiddenAt=Date.now();visibleAt=null;void flush();return;}
    const expired=hiddenAt!==null&&Date.now()-hiddenAt>Number(cfg.sessionMinutes||30)*60000;hiddenAt=null;
    if(expired){await flush();session=null;visitToken=null;set('visit',null);pageRecorded=false;page={url:location.href,title:document.title,id:id()};}
    visibleAt=performance.now();if(expired)await pageview();else void flush();
  });
  window.addEventListener('pagehide',()=>{dwell();if(session&&queue.length&&consent.analytics==='granted'){const token=queue[0].sessionToken||session.sessionToken;fetch(base+'/public/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({siteId,sessionToken:token,events:queue.filter(e=>(e.sessionToken||session.sessionToken)===token).slice(0,20).map(e=>e.data)}),keepalive:true,credentials:'omit'}).catch(()=>undefined);}});
  async function setConsent(choice){
    dwell();generation++;queue=[];session=null;sessionPromise=null;consent={analytics:'unknown',adStorage:'unknown',adUserData:'unknown',adPersonalization:'unknown',...choice};set('consent',JSON.stringify(consent));pageRecorded=false;page={url:location.href,title:document.title,id:id()};
    if(consent.analytics!=='granted'){set('visitor',null);set('visit',null);}
    try{await ensureSession(true);await pageview();}catch{notify('coverage',{transport:'unavailable',consent:consent.analytics});}
    if(consent.analytics!=='granted'){visitorToken=null;visitToken=null;set('visitor',null);set('visit',null);}
    notify('consent',consent);
  }
  async function submit(formId,version,fields,sourceSubmissionId=id()){
    const s=await ensureSession();if(!s)throw new Error('Please try again.');
    event('form_submit_attempt',{formId});void flush();
    try{const receipt=await request('/public/submissions',{siteId,sessionToken:s.sessionToken,sourceSubmissionId,formId,version,fields});
      // Optional existing Pixel integration: same ID as the server Lead. No SDK is loaded here.
      if(cfg.metaPixelId&&typeof window.fbq==='function'&&consent.adStorage==='granted'&&consent.adUserData==='granted'&&receipt.metaEventId){
        try{window.fbq('trackSingle',cfg.metaPixelId,'Lead',{}, {eventID:receipt.metaEventId});}catch{/* A tracking failure must not undo a persisted inquiry. */}
      }
      notify('inquiry',receipt);return receipt;}
    catch(e){event('form_submit_failed',{formId});void flush();throw e;}
  }
  async function renderForm(container){
    const formId=container.dataset.formId;if(!formId||container.dataset.akeRendered)return;container.dataset.akeRendered='loading';container.textContent='Loading enquiry form…';
    try{
      const data=await request('/public/forms/'+encodeURIComponent(siteId)+'/'+encodeURIComponent(formId)),d=data.definition;
      const form=document.createElement('form');form.dataset.akeForm=formId;form.lang=d.language;form.className='ake-marketing-form-fields';
      const heading=document.createElement('h2');heading.textContent=d.heading;form.append(heading);
      for(const f of d.fields){
        const label=document.createElement('label');label.textContent=f.label+(f.required?' *':'');
        const field=document.createElement(f.type==='textarea'?'textarea':f.type==='select'?'select':'input');
        if(field.tagName==='INPUT')field.type=['text','email','tel','checkbox'].includes(f.type)?f.type:'text';
        field.name=f.key;field.required=f.required;field.id='ake-'+id()+'-'+f.key;label.htmlFor=field.id;
        if(f.type==='select')for(const option of ['',...f.options]){const o=document.createElement('option');o.value=option;o.textContent=option||'Select…';field.append(o);}
        if(f.type!=='checkbox')field.maxLength=4000;label.append(field);form.append(label);
      }
      const submitButton=document.createElement('button');submitButton.type='submit';submitButton.textContent=d.submitLabel;
      const status=document.createElement('p');status.setAttribute('role','status');form.append(submitButton,status);
      let requestId=id(),lastFields='',lastInvalidAt=0;
      form.addEventListener('invalid',()=>{if(Date.now()-lastInvalidAt>500){lastInvalidAt=Date.now();event('form_submit_attempt',{formId});void flush();}},true);
      form.addEventListener('submit',async e=>{
        e.preventDefault();if(!form.reportValidity())return;
        const fields=Object.fromEntries(d.fields.map(f=>{const field=form.elements.namedItem(f.key);return [f.key,f.type==='checkbox'?field.checked:field.value];}));
        const fingerprint=JSON.stringify(fields);if(lastFields&&lastFields!==fingerprint)requestId=id();lastFields=fingerprint;
        submitButton.disabled=true;status.textContent='Sending…';
        try{const r=await submit(formId,data.published_version,fields,requestId);status.textContent=d.successMessage+' · '+r.inquiryId.slice(0,8);form.reset();requestId=id();lastFields='';}
        catch(error){status.textContent=error.message;}
        finally{submitButton.disabled=false;}
      });
      if(d.placement==='dialog'){
        const dialog=document.createElement('dialog'),open=document.createElement('button'),close=document.createElement('button');open.type=close.type='button';open.textContent=d.heading;close.textContent=d.language.startsWith('zh')?'关闭':'Close';open.onclick=()=>dialog.showModal();close.onclick=()=>dialog.close();dialog.append(close,form);container.replaceChildren(open,dialog);
      }else container.replaceChildren(form);container.dataset.akeRendered='ready';
    }catch{container.dataset.akeRendered='failed';container.textContent='The enquiry form is temporarily unavailable. Please try again later.';}
  }
  async function reference(bindingId,requestId=id()){const s=await ensureSession();if(!s)throw new Error('Session unavailable');return request('/public/whatsapp-reference',{siteId,sessionToken:s.sessionToken,bindingId,requestId});}
  document.addEventListener('click',e=>{
    const choice=e.target.closest?.('[data-ake-consent]');if(choice){void setConsent({analytics:choice.dataset.akeConsent==='analytics'?'granted':'denied',adStorage:'denied',adUserData:'denied',adPersonalization:'denied'});return;}
    const a=e.target.closest?.('a,button[data-ake-contact]');if(!a)return;const href=a.getAttribute('href')||'',binding=a.dataset.akeWaBinding;
    const target=binding||/wa\.me|whatsapp/i.test(href)?'whatsapp':href.startsWith('mailto:')?'email':href.startsWith('tel:')?'phone':a.dataset.akeContact;
    if(target){event('contact_click',{target:['whatsapp','email','phone','chat'].includes(target)?target:'other'});void flush();}
    if(binding&&consent.analytics==='granted'){e.preventDefault();const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;reference(binding).then(r=>{if(tab)tab.location.href=r.url;else location.href=r.url;}).catch(()=>{tab?.close();notify('coverage',{whatsappReference:'unavailable'});});}
  });
  document.addEventListener('submit',e=>{if(!e.target.dataset.akeForm){event('form_submit_attempt');void flush();}},true);
  function discover(){document.querySelectorAll('.ake-marketing-form[data-form-id]').forEach(el=>void renderForm(el));}
  function connectFrame(frame,{origin,formId}){
    if(!(frame instanceof HTMLIFrameElement)||new URL(frame.src,location.href).origin!==origin)throw new Error('Embedded form origin mismatch');
    let last=null,serial=0;
    const refresh=async()=>{
      if(!last)return;const request=++serial,revision=generation,e=last;
      try{const s=await ensureSession(),r=await frameContext(s);if(request===serial&&revision===generation&&frame.contentWindow===e.source)e.source.postMessage({type:'AKE_FORM_CONTEXT',challenge:e.data.challenge,...r},origin);}catch{notify('coverage',{embeddedForm:'context_unavailable'});}
    };
    const frameContext=s=>request('/public/iframe-context',{siteId,sessionToken:s.sessionToken,formId,childOrigin:origin});
    const listener=e=>{
      if(e.source!==frame.contentWindow||e.origin!==origin||e.data?.type!=='AKE_FORM_READY'||!/^[-a-zA-Z0-9]{16,80}$/.test(e.data.challenge||''))return;
      last=e;void refresh();
    };
    // Completion messages are deliberately ignored: only the signed, persisted
    // backend receipt can create an InquiryCase.
    window.addEventListener('message',listener);window.addEventListener('ake:marketing:consent',refresh);return ()=>{window.removeEventListener('message',listener);window.removeEventListener('ake:marketing:consent',refresh);serial++;last=null;};
  }
  const observer=new MutationObserver(discover);observer.observe(document.documentElement,{childList:true,subtree:true});
  setInterval(()=>{dwell();void flush();},10000);
  window.AKEMarketing={version:'1.2.0',setConsent,submit,reference,flush,renderForm,connectFrame,receiptContext:async()=>({siteId,sessionToken:(await ensureSession()).sessionToken,sourceSubmissionId:id()}),getState:()=>({consent:{...consent},coverage:session?.coverage||{storageAvailable,history:'not_observed'},visitorId:session?.visitorId||null,visitId:session?.visitId||null})};
  discover();if(pendingConsent)void setConsent(pendingConsent);else void pageview();notify('ready',{storageAvailable});
})();
