<?php
define('WP_INSTALLING',true);
require '/var/www/html/wp-load.php';
require_once ABSPATH.'wp-admin/includes/upgrade.php';
require_once ABSPATH.'wp-admin/includes/plugin.php';
if(!is_blog_installed())wp_install('AKE Marketing Local Acceptance','local-admin','local-wp@example.invalid',false,'',getenv('WP_ADMIN_PASSWORD'));
activate_plugin('ake-marketing/ake-marketing.php');
$content='<h1>WordPress 本地插件验收</h1><p>仅使用虚构测试数据。允许分析后采集浏览路径。</p>[ake_marketing_consent][ake_inquiry id="a0000000-0000-4000-8000-000000000002"]';
$page=get_page_by_path('marketing-acceptance');
if(!$page){$id=wp_insert_post(array('post_title'=>'营销插件验收','post_name'=>'marketing-acceptance','post_content'=>$content,'post_status'=>'publish','post_type'=>'page','post_author'=>1));update_option('show_on_front','page');update_option('page_on_front',$id);}
else wp_update_post(array('ID'=>$page->ID,'post_content'=>$content));
echo 'WordPress local fixture installed; version '.$GLOBALS['wp_version'].PHP_EOL;
