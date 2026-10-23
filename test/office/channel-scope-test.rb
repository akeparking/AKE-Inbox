require 'json'
source = File.expand_path('../../deploy/demo/archive/ake_inbox_control.rb', __dir__)
eval(File.read(source).split('  def self.call').first + "\nend\n", TOPLEVEL_BINDING, source)
ENV.update('AKE_INBOX_V2_ENABLED'=>'true','AKE_INBOX_ACCOUNT_ID'=>'1','AKE_INBOX_IDS'=>'1','AKE_OFFICE_RECEPTION_ENABLED'=>'true','AKE_INBOX_EXCLUDED'=>'')
inbox = Struct.new(:account_id,:auto_assignment_config,:member_ids,:channel_type,:channel).new(1,{'ake_owner_id'=>7},[7],'Channel::Email',nil)
conversation = Struct.new(:account_id,:inbox_id,:display_id,:inbox).new(1,22,999,inbox)
raise 'owned mailbox excluded' unless AkeInboxControl.enabled?(conversation)
inbox.member_ids=[];raise 'missing member accepted' if AkeInboxControl.enabled?(conversation);inbox.member_ids=[7]
inbox.account_id=2;raise 'cross-account inbox accepted' if AkeInboxControl.enabled?(conversation);inbox.account_id=1
inbox.channel_type='Channel::WebWidget';raise 'unconfigured website accepted' if AkeInboxControl.enabled?(conversation)
inbox.channel_type='Channel::Api';inbox.channel=Struct.new(:additional_attributes).new({'ake_instance'=>'ake-seat-7'})
raise 'owned connector excluded' unless AkeInboxControl.enabled?(conversation)
inbox.channel.additional_attributes['ake_instance']='arbitrary';raise 'unknown API accepted' if AkeInboxControl.enabled?(conversation)
conversation.account_id=2;raise 'cross account accepted' if AkeInboxControl.enabled?(conversation);conversation.account_id=1
ENV['AKE_INBOX_IDS']='22';ENV['AKE_INBOX_EXCLUDED']='999';raise 'exclusion ignored' if AkeInboxControl.enabled?(conversation)
ENV['AKE_INBOX_EXCLUDED']='';ENV['AKE_OFFICE_RECEPTION_ENABLED']='false';raise 'legacy scope lost' unless AkeInboxControl.enabled?(conversation)
puts JSON.generate({checks:9,passed:true})
