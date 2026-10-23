# InstallationConfig remains the source; the pinned deployment brand overrides
# stale cached defaults on every boot without touching customer records.
if ENV['AKE_INBOX_BRAND']
  module AkeInboxBrand
    def get(*args)
      result=super
      return result unless result.is_a?(Hash)
      names={ 'INSTALLATION_NAME'=>ENV.fetch('AKE_INBOX_BRAND'), 'BRAND_NAME'=>ENV.fetch('AKE_WIDGET_BRAND', 'AKE Parking'),
        'LOGO'=>ENV.fetch('AKE_LOGO_URL', '/ake-mark.svg'), 'LOGO_DARK'=>ENV.fetch('AKE_LOGO_URL', '/ake-mark.svg'), 'LOGO_THUMBNAIL'=>'/ake-mark.svg',
        'WIDGET_BRAND_URL'=>ENV.fetch('AKE_BRAND_URL',''), 'BRAND_URL'=>ENV.fetch('AKE_BRAND_URL','') }
      result.merge(names.select{|k,_|result.key?(k)})
    end
  end
  # The widget substitutes INSTALLATION_NAME into its translated powered-by copy.
  # Keep the dashboard name independent and style inside the iframe itself.
  module AkeWidgetBrand
    private

    def set_global_config
      super
      @global_config['INSTALLATION_NAME'] = ENV.fetch('AKE_WIDGET_BRAND', 'AKE Parking')
    end

    def ake_widget_brand_layout
      return unless response.media_type == 'text/html'

      css = '<style id="ake-widget-brand">.branding--link{white-space:nowrap!important;flex-wrap:nowrap!important;flex-shrink:0;max-width:100%;width:max-content;gap:4px;line-height:1.4;filter:none!important}.branding--link span{white-space:nowrap!important;flex-shrink:0}.branding--link img{width:12px!important;height:12px!important;flex:0 0 12px;object-fit:contain;margin:0!important}</style>'
      response.body = response.body.sub('</head>', "#{css}</head>")
      response.headers.delete('Content-Length')
    end
  end
  Rails.application.config.to_prepare do
    GlobalConfig.singleton_class.prepend(AkeInboxBrand) unless GlobalConfig.singleton_class < AkeInboxBrand
    unless WidgetsController < AkeWidgetBrand
      WidgetsController.prepend(AkeWidgetBrand)
      WidgetsController.after_action :ake_widget_brand_layout
    end
  end
end
