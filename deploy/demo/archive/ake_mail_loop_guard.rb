# Chatwoot 4.18: preserve delivery reports, but never turn them into more mail.
# Scope is the configured AKE account; ordinary customer notifications still run.
module AkeMailLoopGuard
  # Optional installation-specific notification exclusion; no real mailbox in source.
  DEMO_RECIPIENT = ENV.fetch('AKE_SUPPRESS_NOTIFICATION_EMAIL', '').strip.freeze
  SYSTEM_SENDER = /\A(?:mailer-daemon|postmaster)@/i

  def self.scoped?(account_id)
    account_id.to_i == ENV.fetch('AKE_INBOX_ACCOUNT_ID', '1').to_i
  end

  def self.system_sender?(address)
    address.to_s.strip.match?(SYSTEM_SENDER)
  end

  def self.automatic_conversation?(conversation, message = nil)
    return false unless conversation && scoped?(conversation.account_id) && conversation.inbox.email?
    return true if system_sender?(conversation.contact&.email)

    # Use the triggering incoming message when available. For assignment jobs,
    # inspect the latest incoming message, so a later human reply restores mail.
    unless message.is_a?(Message) && message.incoming? && message.conversation_id == conversation.id
      message = conversation.messages.incoming.reorder(created_at: :desc, id: :desc).first
    end
    return conversation.additional_attributes['auto_reply'] == true unless message

    email = message.content_attributes['email'] || {}
    email['auto_reply'] == true || email['content_type'].to_s.match?(%r{\Amultipart/report\b}i)
  end

  def self.suppress_notification?(conversation, user, message = nil)
    return false unless conversation && scoped?(conversation.account_id)

    (!DEMO_RECIPIENT.empty? && user&.email.to_s.casecmp?(DEMO_RECIPIENT)) || automatic_conversation?(conversation, message)
  end

  # The original MIME and inbox message remain available. Mark DSNs correctly
  # even when a provider omits Auto-Submitted, as observed with Feishu bounces.
  module MailClassification
    def auto_reply?
      return super unless @account && AkeMailLoopGuard.scoped?(@account.id)

      super || Array(@mail.from).any? { |address| AkeMailLoopGuard.system_sender?(address) } || bounced?
    end
  end

  # Check before enqueueing a mail job or consuming the account's mail quota.
  # Native inbox/bell notifications and ingestion are deliberately preserved.
  module EmailNotificationService
    def perform
      return if AkeMailLoopGuard.suppress_notification?(notification.primary_actor, notification.user, notification.secondary_actor)

      super
    end
  end

  # Recheck at render/delivery time: jobs queued before a preference change can
  # bypass EmailNotificationService. All native conversation mail actions pass
  # through this method, including enterprise notification actions.
  module ConversationMailer
    private

    def send_mail_with_liquid(*args)
      return if AkeMailLoopGuard.suppress_notification?(@conversation, @agent, @message)

      result = super
      if result && @conversation && AkeMailLoopGuard.scoped?(@conversation.account_id)
        result['Auto-Submitted'] = 'auto-generated'
        result['X-Auto-Response-Suppress'] = 'All'
      end
      result
    end
  end

  def self.install!
    {
      MailPresenter => MailClassification,
      Notification::EmailNotificationService => EmailNotificationService,
      AgentNotifications::ConversationNotificationsMailer => ConversationMailer
    }.each do |klass, extension|
      klass.prepend(extension) unless klass < extension
    end
  end
end
