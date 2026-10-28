<?php
/** Plugin Name: AKE Inbox local Meta feedback acceptance */
// Install only on a local preview, alongside ake-inbox-meta-test.json and the collector copy.
if (!defined('ABSPATH') || wp_get_environment_type() !== 'local' || ($_GET['ake_meta_test'] ?? '') !== '1') return;
$ake_meta_test = json_decode(@file_get_contents(__DIR__.'/ake-inbox-meta-test.json') ?: '{}', true);
if (empty($ake_meta_test['siteId']) || empty($ake_meta_test['formId']) || ($ake_meta_test['apiBase'] ?? '') !== 'http://localhost:14622/api/v1/inbox-v2/marketing') return;
add_action('send_headers', function () {
    header('Cache-Control: no-store');
    header("Content-Security-Policy: default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:14622; frame-src 'self'; form-action 'self'");
}, 99);
add_action('wp_footer', function () use ($ake_meta_test) {
?>
<aside id="ake-meta-test" hidden aria-label="Inbox Meta 本地测试">
<style>
#ake-meta-test{position:fixed;right:22px;bottom:22px;width:390px;max-width:calc(100vw - 28px);max-height:84vh;overflow:auto;z-index:99999;background:#fff;color:#183247;padding:20px;border:2px solid #2479b0;border-radius:10px;box-shadow:0 8px 32px #122d4930;font:14px/1.5 system-ui}#ake-meta-test[hidden]{display:none}#ake-meta-test h2{font:600 20px/1.4 system-ui;margin:0 0 10px;color:#183247}#ake-meta-test p{font:13px/1.5 system-ui;margin:10px 0;color:#456278}#ake-meta-test label{display:block;font:13px/1.4 system-ui;margin:9px 0}#ake-meta-test input,#ake-meta-test textarea{display:block;width:100%;box-sizing:border-box;padding:8px;border:1px solid #bed0de;border-radius:5px;font:14px system-ui;min-height:40px}#ake-meta-test button{font:14px system-ui;min-height:42px;padding:9px 12px;margin:5px 4px 5px 0;border:1px solid #226c9d;border-radius:5px;background:#edf5fa;color:#154d74;cursor:pointer}#ake-meta-test :focus-visible{outline:2px solid #185f91;outline-offset:2px}#ake-meta-test [role=status]{color:#16577f;overflow-wrap:anywhere}
</style>
<h2>Meta Ads 回传 · 本地测试</h2>
<p>此面板只写入本地测试 Inbox。请填写虚构资料；回传为模拟模式，不上传到 Meta。</p>
<button id="ake-meta-consent" type="button">允许本次测试采集</button>
<button id="ake-meta-revoke" type="button">撤回同意</button>
<p id="ake-meta-coverage" role="status">尚未同意采集</p>
<div class="ake-marketing-form" data-form-id="<?php echo esc_attr($ake_meta_test['formId']); ?>"></div>
<a href="http://localhost:14620/ake/marketing?account=1&amp;view=meta_feedback" target="_blank" rel="noopener">打开 Inbox 的 Meta Ads 回传</a>
</aside>
<script>
if(['localhost','127.0.0.1'].includes(location.hostname)) {
  window.AKE_MARKETING=<?php echo wp_json_encode(['apiBase'=>$ake_meta_test['apiBase'],'siteId'=>$ake_meta_test['siteId'],'policyVersion'=>'local-meta-test-v1']); ?>;
  document.getElementById('ake-meta-test').hidden=false;
}
</script>
<script><?php echo file_get_contents(__DIR__.'/ake-inbox-meta-collector.js'); ?></script>
<script>
if(window.AKE_MARKETING) {
  const status=document.getElementById('ake-meta-coverage');
  document.getElementById('ake-meta-consent').onclick=async()=>{
    await AKEMarketing.setConsent({analytics:'granted',adStorage:'granted',adUserData:'granted',adPersonalization:'denied'});
    status.textContent='已同意本次测试采集，可提交虚构询盘';
  };
  document.getElementById('ake-meta-revoke').onclick=async()=>{
    await AKEMarketing.setConsent({analytics:'denied',adStorage:'denied',adUserData:'denied',adPersonalization:'denied'});
    status.textContent='已撤回同意，未发送的 Meta 回传将被阻止';
  };
}
</script>
<?php
}, 999);
