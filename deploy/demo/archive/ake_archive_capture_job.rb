class AkeArchiveCaptureJob < ApplicationJob
  queue_as :low
  retry_on ActiveStorage::FileNotFoundError, wait: 5.seconds, attempts: 6

  def perform(message_id)
    message = Message.unscoped.find_by(id: message_id, account_id: AkeArchive::ACCOUNT_ID)
    AkeArchive.capture_message(message, require_files: true) if message
  end
end
