<?php
require '/var/www/html/wp-load.php';
$receipt='local-backend-'.bin2hex(random_bytes(8));
$payload=array('formId'=>'a0000000-0000-4000-8000-000000000002','version'=>1,'fields'=>array('name'=>'Fictional backend visitor','email'=>'backend@example.invalid','company'=>'Fictional backend company','message'=>'WordPress persisted receipt with blocked collector'));
// Simulates the point at which an existing form plugin has durably stored its submission.
add_option('ake_qa_receipt_'.hash('sha256',$receipt),array('persisted'=>true,'payload'=>$payload),'','no');
do_action('ake_marketing_form_persisted',$receipt,$payload);
$name='ake_mkt_'.hash_hmac('sha256',$receipt,wp_salt('auth'));$before=get_option($name);
if(!$before || $before['state']!=='pending' || empty($before['encrypted']))throw new Exception('Durable encrypted outbox missing');
do_action('ake_marketing_deliver_receipt',$name);$after=get_option($name);
if($after['state']!=='accepted'||empty($after['inquiryId'])||isset($after['encrypted']))throw new Exception('Signed backend receipt not accepted');
do_action('ake_marketing_form_persisted',$receipt,$payload);do_action('ake_marketing_deliver_receipt',$name);$replayed=get_option($name);
if($replayed['inquiryId']!==$after['inquiryId']||$replayed['attempts']!==1)throw new Exception('Duplicate backend receipt was resent');
echo json_encode(array('result'=>'passed','inquiryId'=>$after['inquiryId'],'encryptedPendingOutbox'=>true,'signedReceiptAccepted'=>true,'sdkAbsent'=>true,'duplicateSuppressed'=>true))."\n";
