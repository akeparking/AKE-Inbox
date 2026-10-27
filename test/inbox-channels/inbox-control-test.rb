require 'minitest/autorun'
require 'ostruct'
require 'active_support/all'

# Load the real guard without booting Rails, channels, a queue or a database.
module Rails
  def self.application = OpenStruct.new(config: self)
  def self.to_prepare; end
end
class Message
  def self.find(_id); end
  def self.find_by(id:); end
end
module Messages
  class StatusUpdateService
    def initialize(message, status, reason)
      @message, @status, @reason = message, status, reason
    end
    def perform
      @message.status = @status
      @message.content_attributes['external_error'] = @reason
    end
  end
end
require_relative '../../deploy/demo/archive/ake_inbox_control'

class InboxControlTest < Minitest::Test
  class Provider
    attr_reader :calls
    attr_accessor :provider_error
    def initialize = @calls = 0
    def perform(_id)
      @calls += 1
      raise provider_error if provider_error
    end
  end
  class SendJob < Provider
    prepend AkeInboxControl::SendJob
  end
  def setup
    ENV.update('AKE_INBOX_V2_ENABLED'=>'true', 'AKE_INBOX_ACCOUNT_ID'=>'1', 'AKE_INBOX_IDS'=>'22', 'AKE_INBOX_EXCLUDED'=>'')
    contact = OpenStruct.new(blocked?: false)
    @conversation = OpenStruct.new(account_id: 1, inbox_id: 22, display_id: 7, contact: contact)
    @message = OpenStruct.new(conversation: @conversation, content_attributes: {}, status: 'sent')
    @job = SendJob.new
  end
  def perform_with(admission)
    Message.stub(:find, @message) { AkeInboxControl.stub(:call, admission) { @job.perform(123) } }
  end
  def test_outage_before_delivery_retries_then_calls_provider_once
    assert_raises(AkeInboxControl::Unavailable) { perform_with(->(*) { raise Net::ReadTimeout }) }
    assert_equal 0, @job.calls
    perform_with('allowed'=>true)
    assert_equal 1, @job.calls
  end
  def test_explicit_denial_is_visible_and_does_not_call_provider
    perform_with('allowed'=>false)
    assert_equal 0, @job.calls
    assert_equal 'failed', @message.status
    assert_match(/prevented/, @message.content_attributes['external_error'])
  end
  def test_retry_rechecks_human_takeover_instead_of_sending_stale_work
    assert_raises(AkeInboxControl::Unavailable) { perform_with(->(*) { raise Net::OpenTimeout }) }
    perform_with('allowed'=>false)
    assert_equal 0, @job.calls
    assert_equal 'failed', @message.status
  end
  def test_malformed_admission_is_retryable_not_a_policy_denial
    [{}, {'allowed'=>'true'}, nil].each do |response|
      assert_raises(AkeInboxControl::Unavailable) { perform_with(response) }
    end
    assert_equal 0, @job.calls
  end
  def test_unknown_provider_result_is_not_caught_or_replayed_by_admission_guard
    @job.provider_error = IOError.new('fictional provider result unknown')
    assert_raises(IOError) { perform_with('allowed'=>true) }
    assert_equal 1, @job.calls
  end
  def test_mail_interceptor_denial_cannot_be_mistaken_for_successful_delivery
    mail = OpenStruct.new(perform_deliveries: true)
    mail.define_singleton_method(:[]) { |_name| OpenStruct.new(value: '123') }
    Message.stub(:find_by, @message) do
      AkeInboxControl.stub(:call, {'allowed'=>false}) do
        assert_raises(AkeInboxControl::Denied) { AkeInboxControl::DeliveryGuard.delivering_email(mail) }
      end
    end
    refute mail.perform_deliveries
  end
  def test_mail_interceptor_outage_raises_before_transport
    mail = OpenStruct.new(perform_deliveries: true)
    mail.define_singleton_method(:[]) { |_name| OpenStruct.new(value: '123') }
    Message.stub(:find_by, @message) do
      AkeInboxControl.stub(:call, ->(*) { raise Net::ReadTimeout }) do
        assert_raises(AkeInboxControl::Unavailable) { AkeInboxControl::DeliveryGuard.delivering_email(mail) }
      end
    end
  end
end
