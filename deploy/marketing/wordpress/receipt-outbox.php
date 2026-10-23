<?php
if (!defined('ABSPATH')) exit;

function ake_marketing_receipt_name($id) { return 'ake_mkt_'.hash_hmac('sha256',(string)$id,wp_salt('auth')); }
function ake_marketing_receipt_hash($value) {
  $sort=function($item) use (&$sort) {if(!is_array($item))return $item;if(array_keys($item)!==range(0,count($item)-1))ksort($item);return array_map($sort,$item);};
  return hash_hmac('sha256',wp_json_encode($sort($value)),wp_salt('auth'));
}
function ake_marketing_schedule_receipt($name,$delay=1) {
  if(!wp_next_scheduled('ake_marketing_deliver_receipt',array($name)))wp_schedule_single_event(time()+$delay,'ake_marketing_deliver_receipt',array($name));
}
function ake_marketing_record_receipt($receipt_id,$payload) {
  if(!ake_marketing_configured() || !defined('AKE_MARKETING_RECEIPT_KEY') || !defined('AKE_MARKETING_SERVER_URL'))return false;
  if(!is_array($payload)||empty($payload['formId'])||empty($payload['fields'])||empty($receipt_id))return false;
  $payload['siteId']=AKE_MARKETING_SITE_ID;$payload['persistedReceiptId']=(string)$receipt_id;
  $name=ake_marketing_receipt_name($receipt_id);$hash=ake_marketing_receipt_hash($payload);$existing=get_option($name);
  if($existing) {
    if(isset($existing['payloadHash'])&&!hash_equals($existing['payloadHash'],$hash))return false;
    if($existing['state']==='pending')ake_marketing_schedule_receipt($name);
    return true;
  }
  $iv=random_bytes(12);$tag='';$cipher=openssl_encrypt(wp_json_encode($payload),'aes-256-gcm',hash('sha256',wp_salt('auth'),true),OPENSSL_RAW_DATA,$iv,$tag);
  if($cipher===false)return false;
  $record=array('encrypted'=>base64_encode($iv.$tag.$cipher),'payloadHash'=>$hash,'attempts'=>0,'totalAttempts'=>0,'state'=>'pending','createdAt'=>gmdate('c'));
  if(!add_option($name,$record,'','no')) {
    wp_cache_delete($name,'options');wp_cache_delete('notoptions','options');$winner=get_option($name);
    // A database failure is not a successful duplicate and must not recurse.
    if(!$winner||isset($winner['payloadHash'])&&!hash_equals($winner['payloadHash'],$hash))return false;
    if($winner['state']==='pending')ake_marketing_schedule_receipt($name);return true;
  }
  ake_marketing_schedule_receipt($name);return true;
}
add_action('ake_marketing_form_persisted','ake_marketing_record_receipt',10,2);

// A short database lease prevents overlapping WP-Cron and manual retry deliveries.
// Expired lease deletion is compare-and-delete, so it cannot remove a new owner.
function ake_marketing_receipt_lock($name) {
  global $wpdb;$key=$name.'_lock';wp_cache_delete($key,'options');$old=get_option($key);
  if($old && intval(explode(':',$old)[0])<time()) {
    $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name=%s AND option_value=%s",$key,$old));
    wp_cache_delete($key,'options');wp_cache_delete('notoptions','options');
  }
  $lease=(time()+90).':'.bin2hex(random_bytes(12));return add_option($key,$lease,'','no')?$lease:false;
}
function ake_marketing_receipt_unlock($name,$lease) {
  global $wpdb;$key=$name.'_lock';$wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name=%s AND option_value=%s",$key,$lease));wp_cache_delete($key,'options');wp_cache_delete('notoptions','options');
}
function ake_marketing_deliver_receipt($name) {
  if(!ake_marketing_configured()||!preg_match('/^ake_mkt_[a-f0-9]{64}$/',$name))return;
  $lease=ake_marketing_receipt_lock($name);if(!$lease)return;
  try {
    wp_cache_delete($name,'options');$record=get_option($name);
    if(!$record||$record['state']!=='pending'||$record['attempts']>=5)return;
    $sealed=base64_decode($record['encrypted'],true);
    $body=$sealed&&strlen($sealed)>=28?openssl_decrypt(substr($sealed,28),'aes-256-gcm',hash('sha256',wp_salt('auth'),true),OPENSSL_RAW_DATA,substr($sealed,0,12),substr($sealed,12,16)):false;
    if($body===false){$record['state']='review';$record['lastError']='payload_unreadable';update_option($name,$record,false);return;}
    $time=(string)time();$response=wp_remote_post(rtrim(AKE_MARKETING_SERVER_URL,'/').'/trusted/form-receipt',array('timeout'=>20,'redirection'=>0,'headers'=>array('Content-Type'=>'application/json','X-Ake-Timestamp'=>$time,'X-Ake-Signature'=>hash_hmac('sha256',$time.'.'.$body,AKE_MARKETING_RECEIPT_KEY)),'body'=>$body));
    $record['attempts']++;$record['totalAttempts']=($record['totalAttempts']??0)+1;$record['updatedAt']=gmdate('c');$record['lastError']='transport_failed';
    if(!is_wp_error($response)) {
      $status=wp_remote_retrieve_response_code($response);$record['lastError']='http_'.$status;
      if($status>=200&&$status<300) {
        $data=json_decode(wp_remote_retrieve_body($response),true);$record['lastError']='unconfirmed_receipt';
        if(($data['confirmed']??false)===true&&is_string($data['inquiryId']??null)&&preg_match('/^[0-9a-f-]{36}$/',$data['inquiryId'])) {
          $record['state']='accepted';$record['inquiryId']=$data['inquiryId'];unset($record['encrypted'],$record['lastError']);
        }
      }
    }
    if($record['state']!=='accepted')$record['state']=$record['attempts']>=5?'review':'pending';
    update_option($name,$record,false);
    if($record['state']==='pending')ake_marketing_schedule_receipt($name,min(3600,30*(2**$record['attempts'])));
    else wp_clear_scheduled_hook('ake_marketing_deliver_receipt',array($name));
  } finally { ake_marketing_receipt_unlock($name,$lease); }
}
add_action('ake_marketing_deliver_receipt','ake_marketing_deliver_receipt');

function ake_marketing_recover_receipts() {
  global $wpdb;$cursor=intval(get_option('ake_marketing_recovery_cursor',0));
  $rows=$wpdb->get_results($wpdb->prepare("SELECT option_id,option_name FROM {$wpdb->options} WHERE option_name LIKE %s AND LENGTH(option_name)=72 AND option_id>%d ORDER BY option_id LIMIT 200",$wpdb->esc_like('ake_mkt_').'%',$cursor));
  foreach($rows as $row){$r=get_option($row->option_name);if(($r['state']??null)==='pending'&&$r['attempts']<5)ake_marketing_schedule_receipt($row->option_name);$cursor=$row->option_id;}
  update_option('ake_marketing_recovery_cursor',count($rows)<200?0:$cursor,false);
}
add_action('ake_marketing_recover_receipts','ake_marketing_recover_receipts');
add_action('init',function(){if(ake_marketing_configured()&&!wp_next_scheduled('ake_marketing_recover_receipts'))wp_schedule_event(time()+60,'hourly','ake_marketing_recover_receipts');});

function ake_marketing_retry_receipt($name) {
  if(!current_user_can('manage_options'))return new WP_Error('forbidden');
  if(!preg_match('/^ake_mkt_[a-f0-9]{64}$/',$name))return new WP_Error('invalid_receipt');
  $lease=ake_marketing_receipt_lock($name);if(!$lease)return new WP_Error('busy');
  try {
    wp_cache_delete($name,'options');$record=get_option($name);
    if(!$record||$record['state']!=='review'||empty($record['encrypted']))return new WP_Error('not_retryable');
    $record['retryAudit'][]=array('actor'=>get_current_user_id(),'at'=>gmdate('c'),'previousAttempts'=>$record['attempts'],'previousError'=>$record['lastError']??null);
    $record['state']='pending';$record['attempts']=0;update_option($name,$record,false);ake_marketing_schedule_receipt($name);return true;
  } finally {ake_marketing_receipt_unlock($name,$lease);}
}
add_action('admin_menu',function(){add_management_page('Inbox 收件投递','Inbox 收件投递','manage_options','ake-marketing-receipts','ake_marketing_receipts_page');});
add_action('admin_post_ake_marketing_retry',function(){
  if(!current_user_can('manage_options'))wp_die('Forbidden',403);
  check_admin_referer('ake_marketing_retry');$result=ake_marketing_retry_receipt(sanitize_text_field(wp_unslash($_POST['receipt']??'')));
  wp_safe_redirect(admin_url('tools.php?page=ake-marketing-receipts&result='.(is_wp_error($result)?'held':'queued')));exit;
});
function ake_marketing_receipts_page() {
  if(!current_user_can('manage_options'))return;
  global $wpdb;$rows=$wpdb->get_col($wpdb->prepare("SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s AND LENGTH(option_name)=72 ORDER BY option_id DESC LIMIT 100",$wpdb->esc_like('ake_mkt_').'%'));
  echo '<div class="wrap"><h1>Inbox 收件投递</h1><p>最近 100 条已持久收件的投递状态。成功只表示 Inbox 已收件，不表示有效线索或广告匹配。页面不显示客户内容。</p>';
  if(isset($_GET['result']))echo '<div class="notice notice-info"><p>'.(sanitize_text_field($_GET['result'])==='queued'?'已安排重试，使用原收件编号防止重复建档。':'当前记录未重试，请核对状态。').'</p></div>';
  echo '<table class="widefat striped"><thead><tr><th>记录</th><th>状态</th><th>累计尝试</th><th>最近结果</th><th>操作</th></tr></thead><tbody>';
  foreach($rows as $name) {
    $r=get_option($name);echo '<tr><td>'.esc_html(substr($name,-12)).'</td><td>'.esc_html($r['state']).'</td><td>'.intval($r['totalAttempts']??$r['attempts']).'</td><td>'.esc_html($r['lastError']??'已收件').'</td><td>';
    if($r['state']==='review'&&!empty($r['encrypted'])){echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'"><input type="hidden" name="action" value="ake_marketing_retry"><input type="hidden" name="receipt" value="'.esc_attr($name).'">';wp_nonce_field('ake_marketing_retry');submit_button('重试原收件','secondary','submit',false);echo '</form>';}
    echo '</td></tr>';
  }
  echo '</tbody></table><p>自动重试每轮最多 5 次。WordPress Cron 依赖访问触发；无人访问的网站应由运维配置定时触发。人工重试保留原加密载荷、幂等键及操作审计。</p></div>';
}
