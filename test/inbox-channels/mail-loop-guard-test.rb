# Standalone privacy/configuration regression; no Rails database or email transport.
require 'minitest/autorun'
require 'ostruct'
ENV['AKE_SUPPRESS_NOTIFICATION_EMAIL'] = 'fixture-owner@example.invalid'
require_relative '../../deploy/demo/archive/ake_mail_loop_guard'

class Message
  attr_reader :conversation_id, :content_attributes
  def initialize(id)
    @conversation_id = id
    @content_attributes = {}
  end
  def incoming? = true
end

class MailLoopGuardTest < Minitest::Test
  def conversation(email = 'fixture-customer@example.invalid', account = 1)
    OpenStruct.new(id: 1, account_id: account, inbox: OpenStruct.new(email?: true), contact: OpenStruct.new(email: email))
  end

  def test_configured_mailbox_is_excluded
    assert AkeMailLoopGuard.suppress_notification?(conversation, OpenStruct.new(email: 'FIXTURE-owner@example.invalid'), Message.new(1))
  end

  def test_other_mailboxes_keep_normal_notifications
    refute AkeMailLoopGuard.suppress_notification?(conversation, OpenStruct.new(email: 'agent@example.invalid'), Message.new(1))
  end

  def test_system_delivery_reports_remain_suppressed
    assert AkeMailLoopGuard.suppress_notification?(conversation('mailer-daemon@example.invalid'), OpenStruct.new(email: 'agent@example.invalid'), Message.new(1))
  end

  def test_other_accounts_are_unchanged
    refute AkeMailLoopGuard.suppress_notification?(conversation('mailer-daemon@example.invalid', 2), OpenStruct.new(email: 'fixture-owner@example.invalid'), Message.new(1))
  end

  def test_blank_configuration_does_not_suppress_a_blank_user
    previous = AkeMailLoopGuard::DEMO_RECIPIENT
    AkeMailLoopGuard.send(:remove_const, :DEMO_RECIPIENT)
    AkeMailLoopGuard.const_set(:DEMO_RECIPIENT, '')
    refute AkeMailLoopGuard.suppress_notification?(conversation, nil, Message.new(1))
  ensure
    AkeMailLoopGuard.send(:remove_const, :DEMO_RECIPIENT)
    AkeMailLoopGuard.const_set(:DEMO_RECIPIENT, previous)
  end
end
