<?php
/**
 * Plugin Name: AKE Inbox Marketing
 * Description: Consent-aware website collection, versioned inquiry forms and signed persisted form receipts.
 * Version: 1.2.0
 */
if (!defined('ABSPATH')) exit;
function ake_marketing_configured() {return defined('AKE_MARKETING_SITE_ID') && defined('AKE_MARKETING_PUBLIC_URL') && defined('AKE_MARKETING_ENABLED') && AKE_MARKETING_ENABLED;}
add_action('wp_head',function(){
  if(!ake_marketing_configured() || is_admin() || is_user_logged_in())return;
  echo '<script id="ake-marketing-consent" data-no-defer="1">'.file_get_contents(__DIR__.'/consent.js').'</script>';
},1);
add_filter('litespeed_optm_js_defer_exc',function($patterns){$patterns[]='AKE_MARKETING_CONSENT_BRIDGE';return $patterns;});
add_filter('litespeed_optm_gm_js_exc',function($patterns){$patterns[]='AKE_MARKETING_CONSENT_BRIDGE';return $patterns;});
add_action('wp_enqueue_scripts',function(){
  if(!ake_marketing_configured() || is_admin() || is_user_logged_in())return;
  wp_enqueue_script('ake-marketing',plugins_url('collector.js',__FILE__),array(),'1.2.0',true);
  wp_add_inline_script('ake-marketing','window.AKE_MARKETING='.wp_json_encode(array('siteId'=>AKE_MARKETING_SITE_ID,'apiBase'=>AKE_MARKETING_PUBLIC_URL,'policyVersion'=>'1')).';','before');
});
add_shortcode('ake_inquiry',function($attrs){$a=shortcode_atts(array('id'=>''),$attrs);if(!preg_match('/^[0-9a-f-]{36}$/',$a['id']))return '';return '<div class="ake-marketing-form" data-form-id="'.esc_attr($a['id']).'"></div>';});
add_shortcode('ake_marketing_consent',function(){return '<button type="button" data-ake-consent="analytics">允许浏览分析</button> <button type="button" data-ake-consent="denied">拒绝 / 撤回分析</button>';});
// The site CMP calls AKEMarketing.setConsent with four independent consent choices.
// Existing form backends call this hook ONLY after persisting a genuine receipt.
require_once __DIR__.'/receipt-outbox.php';
