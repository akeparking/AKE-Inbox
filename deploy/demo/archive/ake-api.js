(() => {
  window.akeApi = async (account, path, body) => {
    const raw = document.cookie.split('; ').find(x => x.startsWith('cw_d_session_info='));
    if (!raw) throw new Error('请先登录 Inbox，再打开此页面。');
    const auth = JSON.parse(decodeURIComponent(raw.slice(raw.indexOf('=') + 1)));
    const headers = {'content-type':'application/json'};
    for (const key of ['access-token','client','uid','token-type']) if(auth[key]) headers[key]=auth[key];
    const response = await fetch(`/api/v1/accounts/${encodeURIComponent(account)}${path}`, {
      method:body === undefined ? 'GET' : 'POST', headers, credentials:'same-origin', cache:'no-store',
      body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(45000)
    });
    if(response.headers.get('access-token')) {
      for(const key of ['access-token','client','uid','token-type','expiry']) if(response.headers.get(key)) auth[key]=response.headers.get(key);
      document.cookie=`cw_d_session_info=${encodeURIComponent(JSON.stringify(auth))}; Path=/; ${location.protocol==='https:'?'Secure; ':''}SameSite=Lax`;
    }
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(response.status===401?'登录已过期，请重新登录 Inbox。':data.error||'操作未完成，请稍后重试。');
    return data;
  };
})();
