# Customer records reuse native Inbox ownership; OKKI remains the CRM authority.
class Api::V1::Accounts::AkeCustomersController < Api::V1::Accounts::BaseController
  before_action :ake_enabled

  def index
    scope = contacts
    query = params[:q].to_s.strip[0,120]
    if query.present?
      word = '%' + Contact.sanitize_sql_like(query) + '%'
      scope = scope.where('name ILIKE :q OR email ILIKE :q OR additional_attributes::text ILIKE :q', q: word)
    end
    channel = params[:channel].to_s
    types = {'website' => 'Channel::WebWidget', 'email' => 'Channel::Email', 'whatsapp' => 'Channel::Api'}
    scope = scope.where(id: conversations.joins(:inbox).where(inboxes: {channel_type: types[channel]}).select(:contact_id)) if types[channel]
    scope = scope.tagged_with(params[:label].to_s[0,60]) if params[:label].present?
    page = [params[:page].to_i, 1].max
    count = scope.count
    records = scope.order(last_activity_at: :desc, id: :desc).offset((page-1)*30).limit(30).to_a
    crm, crm_available = crm_records(records.map(&:id))
    render json: { customers: records.map { |c| customer(c).merge(crm: crm[c.id]) }, total: count, page: page,
                   crm_available: crm_available, role: Current.account_user.role }
  end

  def show
    contact = contacts.find(params[:id])
    crm, available = crm_records([contact.id], refresh: params[:refresh] == 'true')
    convs = conversations.where(contact_id: contact.id).includes(:inbox, :assignee).order(last_activity_at: :desc).limit(30)
    render json: customer(contact).merge(crm: crm[contact.id], crm_available: available,
      conversations: convs.map { |c| {id: c.display_id, inbox: c.inbox.name, status: c.status, owner: c.assignee&.name, updated_at: c.last_activity_at} })
  end

  private

  def ake_enabled
    raise Pundit::NotAuthorizedError unless AkeSeatRouting.enabled?(Current.account.id) && Current.user.is_a?(User) && Current.user.confirmed?
  end

  def conversations
    @conversations ||= AkeSeatRouting.conversations(Current.account.conversations, Current.user, Current.account)
  end

  def contacts
    # Only contacts with visible conversations appear in this reception workspace.
    Current.account.contacts.where(id: conversations.select(:contact_id))
  end

  def crm_records(ids, refresh: false)
    return [{}, false] unless ENV['AKE_INBOX_V2_ENABLED'] == 'true'
    result = AkeInboxControl.call('customer-data', {accountId: Current.account.id, contactIds: ids, refresh: refresh})
    [result.fetch('records').index_by { |r| r['contactId'].to_i }, true]
  rescue StandardError
    [{}, false]
  end

  def customer(contact)
    visible = conversations.where(contact_id: contact.id).includes(:inbox, :assignee).order(last_activity_at: :desc)
    latest = visible.first
    attrs = contact.additional_attributes || {}
    email = contact.email.to_s
    masked = email.include?('@') ? email[0] + '***@' + email.split('@').last : ''
    {id: contact.id, name: contact.name, company: attrs['company_name'], country: attrs['country'], email_hint: masked,
     labels: contact.label_list, owners: visible.filter_map { |c| c.assignee&.name }.uniq,
     channels: visible.map { |c| c.inbox.channel_type }.uniq, last_activity_at: latest&.last_activity_at,
     conversation_id: latest&.display_id}
  end
end

Rails.application.routes.prepend do
  get '/ake/customers', to: 'ake_seat_assets#customers'
  get '/api/v1/accounts/:account_id/ake_customers', to: 'api/v1/accounts/ake_customers#index'
  get '/api/v1/accounts/:account_id/ake_customers/:id', to: 'api/v1/accounts/ake_customers#show'
end
