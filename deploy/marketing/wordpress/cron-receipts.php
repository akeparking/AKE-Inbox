<?php
// Local scheduler entry point. Run only our receipt hooks; unrelated WordPress
// update checks must not delay already persisted customer inquiry delivery.
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require '/var/www/html/wp-load.php';
if(!function_exists('ake_marketing_recover_receipts')||!ake_marketing_configured())exit;
ake_marketing_recover_receipts();
foreach(wp_get_ready_cron_jobs() as $timestamp=>$hooks) {
  foreach($hooks as $hook=>$events) {
    if(!in_array($hook,array('ake_marketing_deliver_receipt','ake_marketing_recover_receipts'),true))continue;
    foreach($events as $event) {
      if(!empty($event['schedule']))wp_reschedule_event($timestamp,$event['schedule'],$hook,$event['args']);
      wp_unschedule_event($timestamp,$hook,$event['args']);
      try {do_action_ref_array($hook,$event['args']);}catch(Throwable $error){error_log('Inbox receipt scheduler requires review');}
    }
  }
}
