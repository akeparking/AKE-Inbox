# The restored office copy is a review surface until the authoritative host cutover.
# Login is permitted; never queue customer sends from this copy.
Rails.application.config.to_prepare do
  ApplicationController.prepend_before_action do
    if ENV['AKE_OFFICE_STAGING_READ_ONLY'] == 'true'
      allowed = request.get? || request.head? || request.options? || %w[/auth/sign_in /auth/sign_out].include?(request.path)
      render json: { error: '本机为迁移预备环境，尚未切换真实渠道；暂不允许发送消息或修改业务数据。' }, status: :forbidden unless allowed
    end
  end
end
