"use client";
import {
  useEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  TrayIcon,
  ChartBarIcon,
  BuildingsIcon,
  KanbanIcon,
  CalendarCheckIcon,
  GearSixIcon,
  ChartLineUpIcon,
  PlusIcon,
  ArrowRightIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";

type Row = Record<string, any>;
type Field = {
  key: string;
  label: string;
  type?: string;
  value?: any;
  required?: boolean;
  options?: { value: string; label: string }[];
};
type Modal = {
  title: string;
  description?: string;
  fields: Field[];
  save: (v: Row, key: string) => Promise<any>;
};
const tabs = [
  ["inbox", "收件箱", TrayIcon],
  ["marketing", "营销", ChartLineUpIcon],
  ["customers", "客户", BuildingsIcon],
  ["deals", "商机", KanbanIcon],
  ["tasks", "跟进", CalendarCheckIcon],
  ["reports", "报表", ChartBarIcon],
  ["settings", "设置", GearSixIcon],
] as const;
const stageNames: Row = {
  discovery: "需求确认",
  solution_fit: "方案沟通",
  quotation: "报价",
  negotiation: "商务洽谈",
  won: "赢单",
  lost: "输单",
};
const roleNames: Row = {
  admin: "管理员",
  marketing: "营销",
  sales: "销售",
  viewer: "只读",
};
const stateNames: Row = {
  new: "待处理",
  qualified: "已确认有效",
  persisted: "已收件",
  open: "待跟进",
  done: "已完成",
  cancelled: "已取消",
  mock_verified: "Mock 已同步",
  verified: "已同步",
  unverified: "待验证",
  running: "同步中",
  complete: "完成",
  retrying: "待重试",
  review: "待核对",
  accepted: "平台受理",
  validated: "仅校验",
  pending: "待处理",
  skipped: "未发送",
  authorization_revoked: "授权失效",
  rate_limited: "平台限流",
  network_unavailable: "网络中断",
  sync_failed: "同步失败",
  draft: "草稿",
  approved: "已批准",
  retired: "已停用",
};
const date = (v: any) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
const money = (v: any, c?: string) =>
  v === null || v === undefined
    ? "未填写"
    : `${c || ""} ${Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
const friendly: Row = {
  record_changed: "记录已被修改，请刷新后重试。",
  record_changed_or_unavailable: "记录已更新或不可访问，请刷新。",
  record_conflict_or_unavailable: "记录关联冲突，请核对所属客户和项目。",
  invalid_login: "组织、邮箱或密码不正确。",
  invitation_required: "请使用该组织的邀请完成开通。",
  organization_membership_required: "当前账号不属于此组织。",
  role_not_allowed: "您的角色没有此操作权限。",
  quote_version_changed: "已有更新的报价，请刷新后基于最新版本修改。",
  idempotency_conflict: "该操作已提交不同内容，请刷新后重新发起。",
  chatwoot_unavailable: "会话服务暂时不可用，CRM 数据仍可查看。",
  monthly_ai_quota_reached: "本月 AI 使用次数已达组织配额。",
};
async function api(path: string, body?: any) {
  const r = await fetch(
    (process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api/saas/" + path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    },
  );
  const d = await r.json();
  if (!r.ok)
    throw new Error(
      friendly[d.message] ||
        (d.fields ? "请检查必填项、金额及日期格式。" : d.message) ||
        "操作失败",
    );
  return d;
}
function Badge({ value }: { value: any }) {
  return (
    <span
      className={
        "sx-badge " +
        (["qualified", "won", "approved", "verified", "complete"].includes(
          value,
        )
          ? "good"
          : ["review", "retrying", "lost", "authorization_revoked"].includes(
                value,
              )
            ? "warn"
            : "")
      }
    >
      {stageNames[value] || stateNames[value] || value || "未知"}
    </span>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="sx-empty">{children}</div>;
}
function Editor({
  modal,
  close,
  done,
}: {
  modal: Modal;
  close: () => void;
  done: () => Promise<void>;
}) {
  const key = useRef(crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const data = new FormData(e.currentTarget),
      v: Row = {};
    for (const f of modal.fields) {
      const raw = data.get(f.key);
      v[f.key] =
        f.type === "checkbox"
          ? raw === "on"
          : f.type === "number"
            ? raw === ""
              ? null
              : Number(raw)
            : f.type === "datetime-local"
              ? raw
                ? new Date(String(raw)).toISOString()
                : null
              : raw === ""
                ? null
                : raw;
    }
    try {
      await modal.save(v, key.current);
      await done();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="sx-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        className="sx-modal"
        role="dialog"
        aria-modal="true"
        aria-label={modal.title}
      >
        <header>
          <h2>{modal.title}</h2>
          <button onClick={close} disabled={busy} aria-label="关闭">
            ×
          </button>
        </header>
        {modal.description && <p className="sx-muted">{modal.description}</p>}
        <form onSubmit={submit}>
          {modal.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.required && <span className="sx-required"> *</span>}
              {f.options ? (
                <select
                  name={f.key}
                  defaultValue={f.value ?? ""}
                  required={f.required}
                >
                  <option value="">请选择</option>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  name={f.key}
                  rows={4}
                  defaultValue={f.value ?? ""}
                  required={f.required}
                />
              ) : (
                <input
                  name={f.key}
                  type={f.type || "text"}
                  defaultValue={
                    f.type === "checkbox" ? undefined : (f.value ?? "")
                  }
                  defaultChecked={
                    f.type === "checkbox" ? Boolean(f.value) : undefined
                  }
                  required={f.required}
                  min={f.type === "number" ? 0 : undefined}
                  step={f.type === "number" ? "any" : undefined}
                  autoComplete={f.type === "password" ? "new-password" : "off"}
                />
              )}
            </label>
          ))}
          {error && (
            <p role="alert" className="sx-error">
              {error}
            </p>
          )}
          <footer>
            <button type="button" onClick={close} disabled={busy}>
              取消
            </button>
            <button className="sx-primary" disabled={busy}>
              {busy ? "正在保存…" : "保存"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function SaasWorkspace() {
  const [actor, setActor] = useState<Row | null>(null),
    [checking, setChecking] = useState(true),
    [tab, setTab] = useState("inbox"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [rows, setRows] = useState<Row[]>([]),
    [resource, setResource] = useState("companies"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [detail, setDetail] = useState<Row | null>(null),
    [selected, setSelected] = useState(""),
    [members, setMembers] = useState<Row[]>([]),
    [modal, setModal] = useState<Modal | null>(null),
    [connections, setConnections] = useState<Row[]>([]),
    [runs, setRuns] = useState<Row[]>([]),
    [report, setReport] = useState<Row | null>(null),
    [health, setHealth] = useState<Row | null>(null),
    [channels, setChannels] = useState<Row | null>(null),
    [knowledge, setKnowledge] = useState<Row[]>([]),
    [feedback, setFeedback] = useState<Row[]>([]),
    [ai, setAi] = useState<Row | null>(null),
    [conversation, setConversation] = useState<Row | null>(null),
    [reply, setReply] = useState(""),
    [customer, setCustomer] = useState<Row | null>(null);
  const now = new Date().toISOString().slice(0, 10),
    [from, setFrom] = useState(now),
    [to, setTo] = useState(now),
    [mode, setMode] = useState("live"),
    [model, setModel] = useState("last_non_direct"),
    [pipeline, setPipeline] = useState<Row[]>([]);
  const sequence = useRef(0),
    write = actor && actor.role !== "viewer",
    sales = actor && ["admin", "sales"].includes(actor.role),
    admin = actor?.role === "admin";
  const ownerField: Field = {
    key: "ownerId",
    label: "负责人",
    required: true,
    value: actor?.userId,
    options: members
      .filter((m) => m.active)
      .map((m) => ({
        value: m.user_id,
        label: `${m.user_id} · ${roleNames[m.role]}`,
      })),
  };
  const commonMoney: Field[] = [
    { key: "amount", label: "金额（未知时留空）", type: "number" },
    { key: "currency", label: "币种（如 USD）" },
  ];
  useEffect(() => {
    api("session")
      .then(setActor)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!actor) return;
    api("members")
      .then(setMembers)
      .catch((e) => setError(e.message));
    api("pipeline")
      .then(setPipeline)
      .catch(() => undefined);
    api("health")
      .then(setHealth)
      .catch(() => undefined);
  }, [actor]);
  useEffect(() => {
    setSelected("");
    setDetail(null);
    setAi(null);
    setConversation(null);
    setCustomer(null);
    setPage(1);
    setSearch("");
  }, [tab, resource]);
  async function load() {
    if (!actor) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      if (["inbox", "customers", "deals", "tasks"].includes(tab)) {
        const r = await api(
          `records/${tab === "inbox" ? "leads" : tab === "customers" ? resource : tab === "deals" ? "opportunities" : "tasks"}?q=${encodeURIComponent(search)}&page=${page}`,
        );
        if (ticket === sequence.current) {
          setRows(r.items);
          setTotal(r.total);
        }
      }
      if (tab === "marketing") {
        const [c, r, f] = await Promise.all([
          api("ad-connections"),
          api("sync-runs"),
          api("feedback"),
        ]);
        if (ticket === sequence.current) {
          setConnections(c);
          setRuns(r);
          setFeedback(f.items);
        }
      }
      if (tab === "reports") {
        const r = await api(
          `reports?from=${from}&to=${to}&mode=${mode}&model=${model}`,
        );
        if (ticket === sequence.current) setReport(r);
      }
      if (tab === "settings") {
        const [c, h, k] = await Promise.all([
          api("channels"),
          api("health"),
          api("records/knowledge"),
        ]);
        if (ticket === sequence.current) {
          setChannels(c);
          setHealth(h);
          setKnowledge(k.items);
        }
      }
      if (selected && tab === "inbox")
        setDetail(await api("leads/" + selected));
    } catch (e) {
      if (ticket === sequence.current) setError((e as Error).message);
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
  }, [actor, tab, resource, search, page, from, to, mode, model]);
  async function act(fn: () => Promise<any>, message = "已保存") {
    setError("");
    try {
      const result = await fn();
      setNotice(message);
      await load();
      return result;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function openLead(id: string) {
    setSelected(id);
    setDetail(null);
    setAi(null);
    setConversation(null);
    try {
      setDetail(await api("leads/" + id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function openDeal(d: Row) {
    setTab("inbox");
    setTimeout(() => void openLead(d.primary_source_lead_id), 200);
  }
  function company(row?: Row) {
    setModal({
      title: row ? "编辑客户" : "新建客户",
      fields: [
        { key: "name", label: "公司名称", required: true, value: row?.name },
        { key: "country", label: "国家代码（如 AE）", value: row?.country },
        { key: "website", label: "网站", type: "url", value: row?.website },
        { key: "industry", label: "行业", value: row?.industry },
        { ...ownerField, value: row?.owner_id || actor?.userId },
      ],
      save: (v) =>
        api("companies" + (row ? "/" + row.id : ""), {
          ...v,
          fields: row?.custom_fields || {},
          expectedVersion: row?.version,
        }),
    });
  }
  async function person(row?: Row) {
    const companies = await api("records/companies");
    setModal({
      title: row ? "编辑联系人" : "新建联系人",
      fields: [
        {
          key: "displayName",
          label: "联系人姓名",
          required: true,
          value: row?.display_name,
        },
        {
          key: "companyId",
          label: "所属公司",
          value: row?.company_id,
          options: companies.items.map((c: Row) => ({
            value: c.id,
            label: c.name,
          })),
        },
        {
          key: "email",
          label: "邮箱",
          type: "email",
          value: row?.normalized_email,
        },
        {
          key: "phone",
          label: "电话（含国家代码）",
          value: row?.normalized_phone,
        },
        {
          key: "language",
          label: "沟通语言",
          value: row?.language || "en",
          required: true,
        },
        { key: "buyingRole", label: "采购角色", value: row?.buying_role },
        { ...ownerField, value: row?.owner_id || actor?.userId },
      ],
      save: (v) =>
        api("people" + (row ? "/" + row.id : ""), {
          ...v,
          expectedVersion: row?.version,
        }),
    });
  }
  function newDeal() {
    if (!detail) return;
    setModal({
      title: "创建新项目商机",
      description:
        "同一客户的不同项目分别建档。创建商机后，仍需独立确认询盘是否有效。",
      fields: [
        { key: "name", label: "项目名称", required: true },
        { key: "direction", label: "项目需求 / 产品方向" },
        { key: "country", label: "项目国家代码", value: detail.lead.country },
        { ...ownerField },
        { key: "nextAction", label: "下一步", required: true },
        ...commonMoney,
      ],
      save: (v, key) =>
        api("opportunities", {
          ...v,
          primarySourceLeadId: detail.lead.id,
          idempotencyKey: key,
        }),
    });
  }
  function qualify() {
    setModal({
      title: "确认有效询盘",
      description:
        "请根据已核实的沟通内容逐项确认。此操作会记录操作者和有效事件，发送广告回传是后续独立操作。",
      fields: [
        {
          key: "contactReachable",
          label: "已验证联系方式可达",
          type: "checkbox",
          required: true,
        },
        {
          key: "relevantNeed",
          label: "需求与本公司业务相关",
          type: "checkbox",
          required: true,
        },
        {
          key: "targetBuyer",
          label: "符合目标客户条件",
          type: "checkbox",
          required: true,
        },
        { key: "nextAction", label: "已明确的下一步", required: true },
      ],
      save: (v) => api(`leads/${detail?.lead.id}/qualify`, v),
    });
  }
  function editDeal(d: Row) {
    setModal({
      title: "编辑商机",
      fields: [
        { key: "name", label: "项目名称", required: true, value: d.name },
        { ...ownerField, value: d.owner_id },
        {
          key: "nextAction",
          label: "下一步",
          required: true,
          value: d.next_action,
        },
        {
          key: "amount",
          label: "预计商机金额",
          type: "number",
          value: d.amount,
        },
        { key: "currency", label: "币种", value: d.currency },
      ],
      save: (v) =>
        api("opportunities/" + d.id, { ...v, expectedVersion: d.version }),
    });
  }
  function configureModel() {
    setModal({
      title: "组织 AI 模型",
      description:
        "访问密钥加密保存。只有本组织的消息和已批准知识会参与建议生成。",
      fields: [
        {
          key: "provider",
          label: "模式",
          value: "mock",
          required: true,
          options: [
            { value: "mock", label: "Mock 测试" },
            { value: "openai-compatible", label: "OpenAI 兼容 API" },
          ],
        },
        {
          key: "baseUrl",
          label: "API 地址",
          value: "https://api.openai.com/v1",
          type: "url",
        },
        { key: "model", label: "模型名称" },
        { key: "apiKey", label: "API 密钥", type: "password" },
      ],
      save: (v) =>
        api(
          "integrations/model",
          Object.fromEntries(Object.entries(v).filter(([, v]) => v !== null)),
        ),
    });
  }
  function configureFeedback(provider: string) {
    setModal({
      title: provider === "meta" ? "Meta 回传配置" : "Google 回传配置",
      description:
        "配置影响之后产生的业务事件。旧 Mock 事件不会转成真实发送；Google 默认仅校验。另一平台的配置会保留。",
      fields: [
        {
          key: "mode",
          label: "事件模式",
          value: "mock",
          required: true,
          options: [
            { value: "mock", label: "Mock 测试" },
            { value: "live", label: "真实业务" },
          ],
        },
        { key: "enabled", label: "允许经人工确认的真实回传", type: "checkbox" },
        {
          key: "accessToken",
          label: "平台回传访问令牌",
          type: "password",
          required: true,
        },
        ...(provider === "meta"
          ? [
              { key: "datasetId", label: "Meta 数据集 ID", required: true },
              { key: "graphVersion", label: "Graph API 版本", required: true },
              {
                key: "leadEventSource",
                label: "CRM 来源名称",
                required: true,
                value: "Inbox CRM",
              },
            ]
          : [
              {
                key: "adsAccountId",
                label: "Google 广告账户 ID",
                required: true,
              },
              {
                key: "conversionActionId",
                label: "有效询盘转化动作 ID",
                required: true,
              },
              {
                key: "wonConversionActionId",
                label: "赢单转化动作 ID",
                required: true,
              },
              {
                key: "validateOnly",
                label: "只校验，不正式上传",
                type: "checkbox",
                value: true,
              },
            ]),
      ],
      save: (v) => {
        const { mode, enabled, ...config } = v;
        return api("integrations/feedback", {
          mode,
          enabled,
          [provider]: config,
        });
      },
    });
  }
  function quote(d: Row) {
    const last = detail?.quotes
      .filter((q: Row) => q.opportunity_id === d.id)
      .sort((a: Row, b: Row) => b.version - a.version)[0];
    setModal({
      title: last ? "创建下一版报价" : "记录首次报价",
      description:
        "报价版本会完整保留。报价金额与预计商机金额、实际赢单金额分别记录。",
      fields: [
        {
          key: "title",
          label: "报价名称 / 编号",
          value: last?.title,
          required: true,
        },
        {
          key: "amount",
          label: "报价金额（未知时留空）",
          type: "number",
          value: last?.amount,
        },
        { key: "currency", label: "币种", value: last?.currency || d.currency },
        {
          key: "notes",
          label: "报价说明与附件位置",
          type: "textarea",
          value: last?.notes,
        },
      ],
      save: (v, key) =>
        api("quotes", {
          ...v,
          notes: v.notes || "",
          opportunityId: d.id,
          previousId: last?.id || null,
          idempotencyKey: key,
        }),
    });
  }
  function outcome(d: Row, status: string) {
    setModal({
      title:
        status === "won"
          ? "确认赢单"
          : status === "lost"
            ? "记录输单"
            : "撤回成交并重开",
      description:
        "保留所有历史。撤回或修正成交将重算报表，已发送的广告事件不会自动重发。",
      fields: [
        ...(status === "won"
          ? [
              {
                key: "amount",
                label: "确认成交金额",
                type: "number",
                required: true,
              },
              {
                key: "currency",
                label: "成交币种",
                required: true,
                value: d.currency,
              },
            ]
          : []),
        {
          key: "occurredAt",
          label: "业务发生时间",
          type: "datetime-local",
          required: true,
          value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16),
        },
        {
          key: "evidence",
          label: status === "lost" ? "流失原因" : "确认依据 / 修改原因",
          type: "textarea",
          required: true,
        },
      ],
      save: (v, key) =>
        api(`opportunities/${d.id}/outcome`, {
          ...v,
          status,
          expectedVersion: d.version,
          idempotencyKey: key,
        }),
    });
  }
  function task(row?: Row) {
    setModal({
      title: row ? "更新跟进" : "安排下一次跟进",
      fields: [
        { key: "title", label: "跟进事项", required: true, value: row?.title },
        ownerField,
        {
          key: "dueAt",
          label: "计划时间",
          type: "datetime-local",
          value: row?.due_at
            ? new Date(
                new Date(row.due_at).getTime() -
                  new Date().getTimezoneOffset() * 60000,
              )
                .toISOString()
                .slice(0, 16)
            : undefined,
        },
        ...(row
          ? [
              {
                key: "status",
                label: "状态",
                value: row.status,
                required: true,
                options: ["open", "done", "cancelled"].map((s) => ({
                  value: s,
                  label: stateNames[s],
                })),
              },
              {
                key: "result",
                label: "完成情况",
                type: "textarea",
                value: row.result,
              },
            ]
          : []),
      ],
      save: (v) =>
        api("tasks" + (row ? "/" + row.id : ""), {
          ...v,
          ...(row
            ? { expectedVersion: row.version }
            : { leadId: detail?.lead.id, dueAt: v.dueAt || undefined }),
        }),
    });
  }
  function note() {
    setModal({
      title: "记录沟通",
      fields: [
        { key: "body", label: "跟进内容", type: "textarea", required: true },
      ],
      save: (v) => api("notes", { ...v, leadId: detail?.lead.id }),
    });
  }
  async function link() {
    const people = await api("records/people");
    setModal({
      title: "关联客户与联系人",
      description: "先在客户页维护联系人归属。已有商机的询盘保持原项目关系。",
      fields: [
        {
          key: "personId",
          label: "联系人",
          required: true,
          value: detail?.lead.personId,
          options: people.items.map((p: Row) => ({
            value: p.id,
            label: p.display_name,
          })),
        },
      ],
      save: (v) =>
        api(`leads/${detail?.lead.id}/link`, {
          ...v,
          companyId:
            people.items.find((p: Row) => p.id === v.personId)?.company_id ||
            null,
          expectedRevision: detail?.lead.qualificationRevision || 0,
        }),
    });
  }
  function addConnection() {
    setModal({
      title: "连接广告账户",
      description:
        "请填写正式授权的账户。Mock 会产生明确标记的测试数据；真实数据需账户授权后验证。",
      fields: [
        {
          key: "provider",
          label: "平台",
          required: true,
          options: [
            { value: "meta", label: "Meta" },
            { value: "google", label: "Google" },
          ],
        },
        { key: "name", label: "连接名称", required: true },
        { key: "accountId", label: "广告账户 ID（数字）", required: true },
        { key: "currency", label: "账户原币种", required: true },
        { key: "timezone", label: "账户时区", required: true, value: "UTC" },
        { key: "apiVersion", label: "API 版本", required: true },
        { key: "conversionMetric", label: "Meta 平台转化动作名称（可留空）" },
        {
          key: "mode",
          label: "连接模式",
          required: true,
          value: "mock",
          options: [
            { value: "mock", label: "Mock 测试" },
            { value: "live", label: "真实平台" },
          ],
        },
        {
          key: "accessToken",
          label: "访问令牌（加密保存）",
          type: "password",
          required: true,
        },
        { key: "developerToken", label: "Google 开发者令牌", type: "password" },
        { key: "loginCustomerId", label: "Google 管理账户 ID" },
        { key: "enabled", label: "启用每小时同步", type: "checkbox" },
      ],
      save: (v) => {
        const { accessToken, developerToken, loginCustomerId, ...rest } = v;
        return api("ad-connections", {
          ...rest,
          conversionMetric: rest.conversionMetric || "",
          credentials: {
            accessToken,
            ...(developerToken ? { developerToken } : {}),
            ...(loginCustomerId ? { loginCustomerId } : {}),
          },
        });
      },
    });
  }
  async function download(r: string) {
    const data = await api("export/" + r),
      url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${actor?.slug}-${r}-${now}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (checking)
    return (
      <div className="sx-login">
        <p>正在验证组织会话…</p>
      </div>
    );
  if (!actor)
    return (
      <div className="sx-login">
        <main>
          <div className="sx-wordmark">
            INBOX <span>WORKSPACE</span>
          </div>
          <h1>
            从第一条询盘，
            <br />
            到下一笔成交。
          </h1>
          <p className="sx-muted">使用您的组织标识和 Inbox 个人账号登录。</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const v = Object.fromEntries(new FormData(e.currentTarget));
              try {
                await api("session", v);
                setActor(await api("session"));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              组织标识
              <input name="slug" required autoComplete="organization" />
            </label>
            <label>
              工作邮箱
              <input
                type="email"
                name="email"
                required
                autoComplete="username"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
              />
            </label>
            <details>
              <summary>首次使用邀请</summary>
              <label>
                邀请码
                <input name="invitation" autoComplete="off" />
              </label>
            </details>
            {error && (
              <p className="sx-error" role="alert">
                {error}
              </p>
            )}
            <button className="sx-primary" disabled={busy}>
              {busy ? "正在登录…" : "进入工作台"} <ArrowRightIcon />
            </button>
          </form>
        </main>
        <aside>
          <span>MARKETING → INBOX → CRM</span>
          <p>
            每一次沟通，
            <br />
            都有清晰的下一步。
          </p>
          <small>客户 · 项目 · 跟进 · 成交归因</small>
        </aside>
      </div>
    );
  return (
    <div className="sx-shell">
      <aside className="sx-nav">
        <div className="sx-wordmark">
          INBOX <span>WORKSPACE</span>
        </div>
        <div className="sx-org">
          <strong>{actor.name}</strong>
          <small>{actor.slug}</small>
        </div>
        <nav aria-label="主导航">
          {tabs.map(([key, label, Icon]) => (
            <button
              key={key}
              className={tab === key ? "selected" : ""}
              onClick={() => {
                setTab(key);
                setError("");
                setNotice("");
              }}
            >
              <Icon size={19} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sx-user">
          <span>
            {roleNames[actor.role]} · {actor.userId}
          </span>
          <button
            onClick={() =>
              void act(async () => {
                await api("logout", {});
                setActor(null);
                setRows([]);
                setDetail(null);
              }, "")
            }
          >
            退出
          </button>
        </div>
      </aside>
      <main className="sx-main">
        <header className="sx-top">
          <div>
            <small>营销与销售工作台</small>
            <h1>{tabs.find((t) => t[0] === tab)?.[1]}</h1>
          </div>
          <div className="sx-top-actions">
            <span className="sx-muted">
              新业务启用 {date(actor.effectiveFrom).split(" ")[0]}
            </span>
            <button onClick={() => void load()} disabled={busy}>
              {busy ? "加载中…" : "刷新"}
            </button>
          </div>
        </header>
        {error && (
          <div className="sx-error sx-banner" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="sx-banner" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {["inbox", "customers", "deals", "tasks"].includes(tab) && (
          <div className="sx-toolbar">
            <div className="sx-search">
              <MagnifyingGlassIcon />
              <input
                aria-label="搜索记录"
                placeholder={
                  tab === "customers" ? "搜索客户或联系人姓名" : "搜索当前记录"
                }
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <span className="sx-muted">{total} 条记录</span>
            {tab === "customers" && (
              <>
                <button
                  className={resource === "companies" ? "sx-primary" : ""}
                  onClick={() => setResource("companies")}
                >
                  公司
                </button>
                <button
                  className={resource === "people" ? "sx-primary" : ""}
                  onClick={() => setResource("people")}
                >
                  联系人
                </button>
                {sales && (
                  <button
                    onClick={() =>
                      resource === "companies" ? company() : void person()
                    }
                  >
                    <PlusIcon />
                    新建
                  </button>
                )}
              </>
            )}
            {write && (
              <button
                onClick={() =>
                  void act(
                    () =>
                      download(
                        tab === "inbox"
                          ? "leads"
                          : tab === "deals"
                            ? "opportunities"
                            : tab === "tasks"
                              ? "tasks"
                              : resource,
                      ),
                    "导出已生成",
                  )
                }
              >
                导出
              </button>
            )}
          </div>
        )}
        {tab === "inbox" && (
          <div className="sx-inbox">
            <section className="sx-lead-list" aria-label="询盘列表">
              {rows.length ? (
                rows.map((r) => (
                  <button
                    key={r.id}
                    className={selected === r.id ? "selected" : ""}
                    onClick={() => void openLead(r.id)}
                  >
                    <div>
                      <strong>{r.display_name}</strong>
                      <Badge value={r.status} />
                    </div>
                    <p>
                      {r.provider === "organic"
                        ? "未归因"
                        : r.provider.toUpperCase()}{" "}
                      · {r.source_kind}
                      {r.is_test ? " · Mock" : ""}
                    </p>
                    <small>{date(r.received_at || r.created_at)}</small>
                  </button>
                ))
              ) : (
                <Empty>
                  暂无收件。连接渠道后，成功持久保存的新询盘会出现在这里。
                </Empty>
              )}
            </section>
            <section className="sx-detail">
              {detail ? (
                <>
                  <div className="sx-detail-head">
                    <div>
                      <h2>{detail.lead.displayName}</h2>
                      <p className="sx-muted">
                        {detail.lead.companyName || "尚未关联公司"} ·{" "}
                        {detail.lead.country || "国家未填写"}
                        {detail.lead.isTest ? " · Mock 测试" : ""}
                      </p>
                    </div>
                    <Badge value={detail.lead.status} />
                  </div>
                  <div className="sx-actions">
                    {sales && (
                      <>
                        <button onClick={() => void link()}>关联客户</button>
                        <button onClick={newDeal}>创建商机</button>
                        <button onClick={() => task()}>安排跟进</button>
                      </>
                    )}
                    {write && (
                      <>
                        <button onClick={note}>记录沟通</button>
                        <button
                          className="sx-primary"
                          disabled={detail.lead.status === "qualified"}
                          onClick={qualify}
                        >
                          确认有效
                        </button>
                      </>
                    )}
                  </div>
                  <h3>来源与收件</h3>
                  <div className="sx-timeline">
                    {detail.touches.map((t: Row) => (
                      <div key={t.id}>
                        <small>{date(t.occurred_at)}</small>
                        <strong>
                          {t.provider === "organic" ? "未归因" : t.provider} ·{" "}
                          {t.source_kind}
                        </strong>
                        <span>
                          {t.utm?.utm_source ||
                            t.referrer ||
                            "UTM / 引荐页未提供"}
                          {t.metadata?.campaignId
                            ? " · 系列 " + t.metadata.campaignId
                            : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                  {detail.messages.map((m: Row) => (
                    <article className="sx-message" key={m.id}>
                      <small>
                        {m.channel} · {date(m.occurredAt)}
                      </small>
                      <p>{m.message}</p>
                    </article>
                  ))}
                  {detail.conversations.length > 0 && (
                    <section className="sx-section">
                      <h3>原生会话</h3>
                      {detail.conversations.map((c: Row) => (
                        <button
                          key={c.conversation_id}
                          onClick={() =>
                            void act(
                              async () =>
                                setConversation({
                                  id: c.conversation_id,
                                  ...(await api(
                                    `conversations/${c.conversation_id}/messages`,
                                  )),
                                }),
                              "会话已加载",
                            )
                          }
                        >
                          打开会话 #{c.conversation_id}
                        </button>
                      ))}
                      {conversation && (
                        <>
                          <div className="sx-native-messages">
                            {(conversation.payload || []).map((m: Row) => (
                              <article key={m.id} className="sx-message">
                                <small>
                                  {m.message_type === 0
                                    ? "客户"
                                    : m.private
                                      ? "内部备注"
                                      : "团队"}
                                </small>
                                <p>{m.content || "附件消息"}</p>
                                {(m.attachments || []).map((a: Row) => (
                                  <a
                                    key={a.id}
                                    href={a.data_url}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    查看附件
                                  </a>
                                ))}
                              </article>
                            ))}
                          </div>
                          {sales && (
                            <>
                              <textarea
                                aria-label="回复内容"
                                value={reply}
                                onChange={(e) => setReply(e.target.value)}
                                placeholder="人工确认回复内容后发送"
                              />
                              <div className="sx-actions">
                                <button
                                  onClick={() =>
                                    void act(
                                      () =>
                                        api(
                                          `conversations/${conversation.id}/takeover`,
                                          {},
                                        ),
                                      "已分配给您",
                                    )
                                  }
                                >
                                  人工接管
                                </button>
                                <button
                                  className="sx-primary"
                                  disabled={!reply.trim()}
                                  onClick={() =>
                                    setModal({
                                      title: "确认发送回复",
                                      description:
                                        "请核对收件会话与回复内容。发送后会记录平台回执。",
                                      fields: [
                                        {
                                          key: "content",
                                          label: "回复内容",
                                          type: "textarea",
                                          required: true,
                                          value: reply,
                                        },
                                        {
                                          key: "private",
                                          label: "保存为内部备注",
                                          type: "checkbox",
                                        },
                                      ],
                                      save: async (v, key) => {
                                        const r = await api(
                                          `conversations/${conversation.id}/messages`,
                                          { ...v, idempotencyKey: key },
                                        );
                                        setNotice(
                                          r.state === "accepted"
                                            ? "会话已受理回复"
                                            : "发送结果待核对，请先检查原会话",
                                        );
                                        setReply("");
                                      },
                                    })
                                  }
                                >
                                  确认回复
                                </button>
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </section>
                  )}
                  {detail.messagesTruncated && (
                    <p className="sx-muted">
                      当前显示最近 200 条收件。更早沟通请在原生会话查看。
                    </p>
                  )}
                  <h3>
                    项目商机{" "}
                    <span className="sx-muted">
                      {detail.opportunities.length}
                    </span>
                  </h3>
                  {detail.opportunities.length ? (
                    detail.opportunities.map((d: Row) => (
                      <article className="sx-deal" key={d.id}>
                        <header>
                          <strong>{d.name}</strong>
                          <Badge value={d.stage} />
                        </header>
                        <p>
                          负责人 {d.owner_id} · 预计金额{" "}
                          {money(d.amount, d.currency)}
                        </p>
                        <p>下一步：{d.next_action || "尚未安排"}</p>
                        {sales && (
                          <div className="sx-actions">
                            <select
                              aria-label={"阶段 " + d.name}
                              value={d.stage}
                              disabled={["won", "lost"].includes(d.stage)}
                              onChange={(e) =>
                                void act(() =>
                                  api(`opportunities/${d.id}/stage`, {
                                    stage: e.target.value,
                                    expectedVersion: d.version,
                                  }),
                                )
                              }
                            >
                              {(pipeline.length
                                ? pipeline
                                : Object.entries(stageNames).map(
                                    ([id, label]) => ({ id, label }),
                                  )
                              ).map((s) => (
                                <option
                                  key={s.id}
                                  value={s.id}
                                  disabled={["won", "lost"].includes(s.id)}
                                >
                                  {s.label}
                                </option>
                              ))}
                            </select>
                            <button onClick={() => editDeal(d)}>编辑</button>
                            <button onClick={() => quote(d)}>报价版本</button>
                            {["won", "lost"].includes(d.stage) ? (
                              <>
                                <button onClick={() => outcome(d, "reopened")}>
                                  撤回并重开
                                </button>
                                {d.stage === "won" && (
                                  <button onClick={() => outcome(d, "won")}>
                                    修正成交
                                  </button>
                                )}
                              </>
                            ) : (
                              <>
                                <button onClick={() => outcome(d, "won")}>
                                  确认赢单
                                </button>
                                <button onClick={() => outcome(d, "lost")}>
                                  记录输单
                                </button>
                              </>
                            )}
                          </div>
                        )}
                        {detail.quotes
                          .filter((q: Row) => q.opportunity_id === d.id)
                          .map((q: Row) => (
                            <p className="sx-history" key={q.id}>
                              报价 v{q.version} · {q.title} ·{" "}
                              {money(q.amount, q.currency)}
                              <small>{q.notes}</small>
                            </p>
                          ))}
                        {detail.outcomes
                          .filter((o: Row) => o.opportunity_id === d.id)
                          .map((o: Row) => (
                            <p className="sx-history" key={o.id}>
                              {o.status === "reopened"
                                ? "重开"
                                : o.status === "won"
                                  ? "确认赢单"
                                  : "输单"}{" "}
                              ·{" "}
                              {o.status === "won"
                                ? money(o.amount, o.currency)
                                : ""}{" "}
                              · {date(o.occurred_at)}
                              <small>{o.evidence}</small>
                            </p>
                          ))}
                      </article>
                    ))
                  ) : (
                    <Empty>尚未创建项目商机</Empty>
                  )}
                  <h3>跟进与活动</h3>
                  {(detail.history || []).map((h: Row) => (
                    <p className="sx-history" key={h.id}>
                      {date(h.occurred_at)} · {h.actor_id} ·{" "}
                      {stageNames[h.from_stage] || "新建"} →{" "}
                      {stageNames[h.to_stage] || h.to_stage}
                    </p>
                  ))}
                  {detail.tasks.map((t: Row) => (
                    <button
                      className="sx-task-row"
                      key={t.id}
                      onClick={() => sales && task(t)}
                    >
                      <span>
                        {t.title}
                        <small>
                          {date(t.due_at)} · {t.owner_id}
                        </small>
                      </span>
                      <Badge value={t.status} />
                    </button>
                  ))}
                  {detail.notes.map((n: Row) => (
                    <article key={n.id} className="sx-message">
                      <small>
                        {n.author_id} · {date(n.created_at)}
                      </small>
                      <p>{n.body}</p>
                    </article>
                  ))}
                  {write && (
                    <section className="sx-section">
                      <h3>AI 辅助</h3>
                      <p className="sx-muted">
                        建议单独保存，人工确认后再用于客户沟通。
                      </p>
                      <div className="sx-actions">
                        {[
                          ["summary", "摘要"],
                          ["fields", "字段建议"],
                          ["translation", "翻译"],
                          ["draft", "回复草稿"],
                        ].map(([kind, label]) => (
                          <button
                            key={kind}
                            onClick={() =>
                              void act(
                                async () =>
                                  setAi(
                                    await api(`leads/${detail.lead.id}/ai`, {
                                      kind,
                                      language:
                                        kind === "draft"
                                          ? "English"
                                          : "简体中文",
                                    }),
                                  ),
                                "AI 建议已单独保存",
                              )
                            }
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {ai && (
                        <div className="sx-ai">
                          <Badge value={ai.provider} />
                          <pre>{ai.result}</pre>
                          <small>
                            引用已批准知识 {ai.sources.length} 项 ·
                            未写入人工字段
                          </small>
                        </div>
                      )}
                    </section>
                  )}
                </>
              ) : (
                <Empty>选择左侧询盘，查看来源、项目和下一步。</Empty>
              )}
            </section>
          </div>
        )}
        {tab === "customers" && (
          <div className="sx-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{resource === "companies" ? "公司" : "联系人"}</th>
                  <th>
                    {resource === "companies"
                      ? "国家 / 行业"
                      : "邮箱 / 采购角色"}
                  </th>
                  <th>负责人</th>
                  <th>建立时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {resource === "companies" ? (
                        <button
                          onClick={() =>
                            void act(
                              async () =>
                                setCustomer(await api("companies/" + r.id)),
                              "",
                            )
                          }
                        >
                          {r.name}
                        </button>
                      ) : (
                        <strong>{r.display_name}</strong>
                      )}
                      <small>{r.website || r.language || ""}</small>
                    </td>
                    <td>
                      {r.country || r.normalized_email || "—"}
                      <small>{r.industry || r.buying_role || "—"}</small>
                    </td>
                    <td>{r.owner_id || "未分配"}</td>
                    <td>{date(r.created_at)}</td>
                    <td>
                      {sales && (
                        <button
                          onClick={() =>
                            resource === "companies"
                              ? company(r)
                              : void person(r)
                          }
                        >
                          编辑
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <Empty>暂无客户记录。可从询盘关联客户，或在这里创建。</Empty>
            )}
          </div>
        )}
        {tab === "customers" && customer && (
          <section className="sx-section">
            <div className="sx-section-title">
              <h2>{customer.company.name}</h2>
              <button onClick={() => setCustomer(null)}>收起</button>
            </div>
            <p>
              联系人 {customer.contacts.length} · 询盘 {customer.leads.length} ·
              商机 {customer.opportunities.length}
              {customer.truncated
                ? " · 已显示前 200 条，请使用导出查看完整记录"
                : ""}
            </p>
            {customer.contacts.map((c: Row) => (
              <div className="sx-task-row" key={c.id}>
                <span>
                  {c.display_name}
                  <small>
                    {c.normalized_email ||
                      c.normalized_phone ||
                      "联系方式待完善"}
                  </small>
                </span>
                <span>{c.buying_role || "采购角色待填写"}</span>
              </div>
            ))}
            {customer.opportunities.map((d: Row) => (
              <button
                className="sx-task-row"
                key={d.id}
                onClick={() => openDeal(d)}
              >
                <span>
                  {d.name}
                  <small>{d.next_action}</small>
                </span>
                <Badge value={d.stage} />
              </button>
            ))}
          </section>
        )}
        {tab === "deals" && (
          <>
            <p className="sx-muted">
              看板展示当前页商机。每个项目单独跟进，点击卡片进入来源询盘。
            </p>
            <div className="sx-kanban">
              {(pipeline.length
                ? pipeline
                : Object.entries(stageNames).map(([id, label]) => ({
                    id,
                    label,
                  }))
              ).map((s) => (
                <section key={s.id}>
                  <h3>
                    {s.label}
                    <span>{rows.filter((d) => d.stage === s.id).length}</span>
                  </h3>
                  {rows
                    .filter((d) => d.stage === s.id)
                    .map((d) => (
                      <button key={d.id} onClick={() => openDeal(d)}>
                        <strong>{d.name}</strong>
                        <p>{money(d.amount, d.currency)}</p>
                        <small>{d.next_action || "待安排下一步"}</small>
                        <footer>负责人 {d.owner_id}</footer>
                      </button>
                    ))}
                </section>
              ))}
            </div>
          </>
        )}
        {tab === "tasks" && (
          <div className="sx-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>跟进事项</th>
                  <th>计划时间</th>
                  <th>负责人</th>
                  <th>状态</th>
                  <th>完成情况</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <button onClick={() => sales && task(t)}>
                        {t.title}
                      </button>
                    </td>
                    <td
                      className={
                        t.status === "open" && new Date(t.due_at) < new Date()
                          ? "sx-late"
                          : ""
                      }
                    >
                      {date(t.due_at)}
                    </td>
                    <td>{t.owner_id}</td>
                    <td>
                      <Badge value={t.status} />
                    </td>
                    <td>{t.result || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <Empty>暂无跟进事项。请在询盘详情中安排下一步。</Empty>
            )}
          </div>
        )}
        {["inbox", "customers", "deals", "tasks"].includes(tab) && (
          <div className="sx-pagination">
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              上一页
            </button>
            <span>第 {page} 页 · 每页 50 条</span>
            <button
              disabled={page * 50 >= total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        )}
        {tab === "marketing" && (
          <>
            <div className="sx-section-title">
              <div>
                <h2>广告账户与同步</h2>
                <p className="sx-muted">
                  每小时同步，每天重查最近 30
                  天。原币种、时区和缺失状态独立保存。
                </p>
              </div>
              {admin && (
                <button className="sx-primary" onClick={addConnection}>
                  <PlusIcon />
                  连接账户
                </button>
              )}
            </div>
            <div className="sx-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>连接</th>
                    <th>币种 / 时区</th>
                    <th>状态</th>
                    <th>最后同步</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {connections.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <strong>{c.name}</strong>
                        <small>
                          {c.provider} · {c.account_id} ·{" "}
                          {c.mode === "mock" ? "Mock 测试" : "真实平台"}
                        </small>
                      </td>
                      <td>
                        {c.currency}
                        <small>{c.timezone}</small>
                      </td>
                      <td>
                        <Badge value={c.enabled ? c.status : "已暂停"} />
                      </td>
                      <td>{date(c.last_sync_at)}</td>
                      <td>
                        <div className="sx-actions">
                          {["admin", "marketing"].includes(actor.role) && (
                            <button
                              disabled={!c.enabled}
                              onClick={() =>
                                void act(
                                  () => api(`ad-connections/${c.id}/sync`, {}),
                                  "已安排同步，可在同步记录中查看进度",
                                )
                              }
                            >
                              重新同步
                            </button>
                          )}
                          {admin && (
                            <button
                              onClick={() =>
                                void act(() =>
                                  api(`ad-connections/${c.id}/toggle`, {
                                    enabled: !c.enabled,
                                    expectedVersion: c.version,
                                  }),
                                )
                              }
                            >
                              {c.enabled ? "暂停" : "启用"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!connections.length && (
                <Empty>尚未配置广告账户。没有数据时不会填零。</Empty>
              )}
            </div>
            <h3>同步记录</h3>
            <div className="sx-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>日期范围</th>
                    <th>状态</th>
                    <th>行数</th>
                    <th>开始 / 完成</th>
                    <th>诊断</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {String(r.date_from).slice(0, 10)} →{" "}
                        {String(r.date_to).slice(0, 10)}
                      </td>
                      <td>
                        <Badge value={r.state} />
                      </td>
                      <td>{r.row_count ?? "—"}</td>
                      <td>
                        {date(r.started_at)}
                        <small>{date(r.finished_at)}</small>
                      </td>
                      <td>{stateNames[r.error_code] || r.error_code || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>有效询盘与成交回传</h3>
            <p className="sx-muted">
              本地事件、平台受理、处理和匹配分别记录。结果未知时先核对，不自动重发。
            </p>
            <div className="sx-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>业务事件</th>
                    <th>平台 / 模式</th>
                    <th>发送状态</th>
                    <th>处理 / 匹配</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {feedback.map((f) => (
                    <tr key={f.kind + f.id}>
                      <td>
                        {f.kind === "qualified" ? "有效询盘" : "赢单"}
                        <small>{date(f.occurredAt)}</small>
                      </td>
                      <td>
                        {f.provider} · {f.mode}
                      </td>
                      <td>
                        <Badge value={f.state} />
                      </td>
                      <td>
                        {f.receipt?.processing || "未知"} /{" "}
                        {f.receipt?.matching || "未知"}
                      </td>
                      <td>
                        {["admin", "marketing"].includes(actor.role) && (
                          <button
                            disabled={!f.sendable}
                            onClick={() =>
                              setModal({
                                title: "确认发送业务事件",
                                description: `平台：${f.provider}；模式：${f.mode}。请确认这是获授权的业务事实。`,
                                fields: [
                                  {
                                    key: "confirmed",
                                    label: "确认发送该事件",
                                    type: "checkbox",
                                    required: true,
                                  },
                                ],
                                save: (v) =>
                                  api(`feedback/${f.kind}/${f.id}/send`, v),
                              })
                            }
                          >
                            核对并发送
                          </button>
                        )}
                        {["admin", "marketing"].includes(actor.role) &&
                          f.state === "rejected" &&
                          [
                            "HTTP_401",
                            "HTTP_403",
                            "HTTP_429",
                            "UNAUTHENTICATED",
                            "PERMISSION_DENIED",
                            "RESOURCE_EXHAUSTED",
                          ].includes(f.errorCode) && (
                            <button
                              onClick={() =>
                                setModal({
                                  title: "恢复已明确拒绝的回传",
                                  description:
                                    "请先修复授权或限流问题。原失败回执将保留，结果未知的发送不适用此操作。",
                                  fields: [
                                    {
                                      key: "reason",
                                      label: "修复依据",
                                      required: true,
                                    },
                                    {
                                      key: "confirmed",
                                      label: "确认平台此前明确拒绝",
                                      type: "checkbox",
                                      required: true,
                                    },
                                  ],
                                  save: (v) =>
                                    api(`feedback/${f.kind}/${f.id}/retry`, v),
                                })
                              }
                            >
                              恢复待发送
                            </button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "reports" && (
          <>
            <div className="sx-toolbar">
              <label>
                收件起日
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                止日
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label>
                归因视图
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="last_non_direct">末次非直接触点</option>
                  <option value="first">首次触点</option>
                </select>
              </label>
              <label>
                数据模式
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="live">真实业务</option>
                  <option value="mock">Mock 测试</option>
                </select>
              </label>
            </div>
            {report && (
              <>
                <p className="sx-muted">
                  按 {report.cohortTimezone}{" "}
                  收件日期形成询盘群组；成交取该群组当前有效事实。截止{" "}
                  {date(report.asOf)}
                </p>
                <div className="sx-stats">
                  {[
                    ["inquiries", "真实询盘"],
                    ["qualified", "人工有效"],
                    ["opportunities", "商机"],
                    ["won", "赢单"],
                    ["unattributed", "未归因"],
                  ].map(([k, l]) => (
                    <div key={k}>
                      <span>{l}</span>
                      <strong>{report.summary[k]}</strong>
                    </div>
                  ))}
                </div>
                <p>
                  归因赢单金额 /
                  广告消耗按原币种与账户时区展示。此比值不等同财务收入或利润
                  ROI。
                </p>
                <div className="sx-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>广告系列</th>
                        <th>消耗</th>
                        <th>展示 / 点击</th>
                        <th>平台转化</th>
                        <th>询盘 / 有效</th>
                        <th>商机 / 赢单</th>
                        <th>归因赢单金额</th>
                        <th>赢单金额 / 消耗</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.campaigns.map((r: Row) => (
                        <tr key={r.id + r.campaign_id}>
                          <td>
                            <strong>{r.campaign_name}</strong>
                            <small>
                              {r.provider} · {r.account_id}
                              <br />
                              {r.currency} · {r.timezone}
                            </small>
                          </td>
                          <td>
                            {money(r.spend, r.currency)}
                            <small>{r.complete ? "完整" : "同步不完整"}</small>
                          </td>
                          <td>
                            {r.impressions ?? "—"} / {r.clicks ?? "—"}
                          </td>
                          <td>{r.platform_conversions ?? "—"}</td>
                          <td>
                            {r.leads} / {r.qualified}
                          </td>
                          <td>
                            {r.opportunities} / {r.won}
                          </td>
                          <td>{money(r.wonAmount, r.currency)}</td>
                          <td>
                            {r.wonToSpend === null
                              ? "—"
                              : r.wonToSpend.toFixed(2) + "×"}
                            <small>
                              {r.ratioUnavailableReason === "sync_incomplete"
                                ? "同步不完整"
                                : r.ratioUnavailableReason ===
                                    "currency_or_timezone_mismatch"
                                  ? "币种或时区不一致"
                                  : r.ratioUnavailableReason
                                    ? "缺少可计算事实"
                                    : ""}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!report.campaigns.length && (
                    <Empty>
                      本区间尚无可用广告指标。询盘仍可在上方独立统计。
                    </Empty>
                  )}
                </div>
                <p className="sx-muted">
                  全部当前赢单按币种：
                  {Object.entries(report.summary.wonAmountByCurrency)
                    .map(([c, v]) => money(v, c))
                    .join(" · ") || "尚无成交事实"}
                </p>
              </>
            )}
          </>
        )}
        {tab === "settings" && (
          <>
            <section className="sx-section">
              <div className="sx-section-title">
                <h2>组织与成员</h2>
                <button
                  onClick={() =>
                    void act(async () => {
                      await api("logout", {});
                      setActor(null);
                      setRows([]);
                      setDetail(null);
                    }, "")
                  }
                >
                  退出工作台
                </button>
              </div>
              <p>
                {actor.name} · {actor.slug} · {roleNames[actor.role]}
              </p>
              <p className="sx-muted">
                仅承接启用后的新项目。旧项目的新回复仍按旧项目归属处理。
              </p>
              {health && (
                <p>
                  本月询盘 {health.usage.inquiries} / {health.limits.inquiries}{" "}
                  · AI {health.usage.ai} / {health.limits.ai} · 待跟进{" "}
                  {health.usage.overdue} · 待核对发送{" "}
                  {health.usage.outbound_review}
                </p>
              )}
              <div className="sx-actions">
                {admin && (
                  <>
                    <button
                      onClick={() =>
                        setModal({
                          title: "邀请组织成员",
                          description:
                            "成员须先属于对应 Chatwoot Account；生成的一次性邀请码请通过您的授权渠道转交。",
                          fields: [
                            {
                              key: "userId",
                              label: "成员用户 ID",
                              required: true,
                            },
                            {
                              key: "role",
                              label: "角色",
                              required: true,
                              options: Object.entries(roleNames).map(
                                ([value, label]) => ({ value, label }),
                              ),
                            },
                          ],
                          save: async (v) => {
                            const r = await api("invitations", v);
                            setNotice(`邀请码（7 天内有效）：${r.invitation}`);
                          },
                        })
                      }
                    >
                      邀请成员
                    </button>
                    <button
                      onClick={() =>
                        setModal({
                          title: "配置商机阶段名称",
                          description:
                            "阶段名称可调整，进行中、赢单和输单的业务语义保持稳定。",
                          fields: pipeline.map((s) => ({
                            key: s.id,
                            label: stageNames[s.id],
                            required: true,
                            value: s.label,
                          })),
                          save: async (v) => {
                            const result = await api(
                              "pipeline",
                              pipeline.map((s) => ({
                                id: s.id,
                                label: v[s.id],
                              })),
                            );
                            setPipeline(result);
                          },
                        })
                      }
                    >
                      阶段名称
                    </button>
                  </>
                )}
              </div>
              <div className="sx-members">
                {members.map((m) => (
                  <div key={m.user_id}>
                    <strong>{m.user_id}</strong>
                    <span>
                      {roleNames[m.role]} · {m.active ? "启用" : "停用"}
                    </span>
                    {admin && m.user_id !== actor.userId && (
                      <button
                        onClick={() =>
                          setModal({
                            title: "更新成员权限",
                            fields: [
                              {
                                key: "role",
                                label: "角色",
                                value: m.role,
                                required: true,
                                options: Object.entries(roleNames).map(
                                  ([value, label]) => ({ value, label }),
                                ),
                              },
                              {
                                key: "active",
                                label: "启用成员",
                                type: "checkbox",
                                value: m.active,
                              },
                            ],
                            save: async (v) => {
                              await api("members/" + m.user_id, v);
                              setMembers(await api("members"));
                            },
                          })
                        }
                      >
                        修改
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
            {admin && (
              <section className="sx-section">
                <h2>组织集成</h2>
                <p className="sx-muted">
                  各组织独立保存模型及广告回传目标，密钥不会返回浏览器。
                </p>
                <div className="sx-actions">
                  <button onClick={configureModel}>AI 模型</button>
                  <button onClick={() => configureFeedback("meta")}>
                    Meta 回传
                  </button>
                  <button onClick={() => configureFeedback("google")}>
                    Google 回传
                  </button>
                </div>
              </section>
            )}
            <section className="sx-section">
              <h2>接待渠道</h2>
              <p className="sx-muted">
                启用已有 Inbox 渠道后，新收件可关联到本组织 CRM。
              </p>
              {channels?.available.map((c: Row) => {
                const enrolled = channels.enrolled.find(
                  (x: Row) => Number(x.inbox_id) === Number(c.id),
                );
                return (
                  <div className="sx-task-row" key={c.id}>
                    <span>
                      {c.name}
                      <small>
                        {c.channelType} · #{c.id}
                      </small>
                    </span>
                    <Badge value={enrolled?.enabled ? "已启用" : "未启用"} />
                    {admin && (
                      <button
                        onClick={() =>
                          setModal({
                            title: "配置渠道",
                            fields: [
                              {
                                key: "channel",
                                label: "渠道类型",
                                value: enrolled?.channel || "website",
                                required: true,
                                options: [
                                  { value: "website", label: "网站" },
                                  { value: "email", label: "邮件" },
                                  { value: "whatsapp", label: "WhatsApp" },
                                ],
                              },
                              {
                                key: "enabled",
                                label: "启用 CRM 收件",
                                type: "checkbox",
                                value: enrolled?.enabled,
                              },
                            ],
                            save: (v) =>
                              api("channels", { ...v, inboxId: Number(c.id) }),
                          })
                        }
                      >
                        配置
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
            <section className="sx-section">
              <div className="sx-section-title">
                <h2>组织知识</h2>
                {admin && (
                  <button
                    onClick={() =>
                      setModal({
                        title: "新增知识条目",
                        description:
                          "只有已批准的知识会提供给 AI。请填写来源，避免将推测当作产品承诺。",
                        fields: [
                          { key: "title", label: "标题", required: true },
                          {
                            key: "body",
                            label: "知识正文",
                            type: "textarea",
                            required: true,
                          },
                          {
                            key: "source",
                            label: "来源 / 版本",
                            required: true,
                          },
                          {
                            key: "state",
                            label: "状态",
                            value: "draft",
                            required: true,
                            options: ["draft", "approved", "retired"].map(
                              (v) => ({ value: v, label: stateNames[v] }),
                            ),
                          },
                        ],
                        save: (v) => api("knowledge", v),
                      })
                    }
                  >
                    新增知识
                  </button>
                )}
              </div>
              {knowledge.map((k) => (
                <article className="sx-message" key={k.id}>
                  <strong>{k.title}</strong> <Badge value={k.state} />
                  <p>{k.body}</p>
                  <small>
                    {k.source} · v{k.version}
                  </small>
                  {admin && (
                    <button
                      onClick={() =>
                        void act(() =>
                          api("knowledge/" + k.id, {
                            title: k.title,
                            body: k.body,
                            source: k.source,
                            state:
                              k.state === "approved" ? "retired" : "approved",
                            expectedVersion: k.version,
                          }),
                        )
                      }
                    >
                      {k.state === "approved" ? "停用" : "批准"}
                    </button>
                  )}
                </article>
              ))}
              {!knowledge.length && (
                <Empty>暂无组织知识。外部公司默认使用通用 B2B 模板。</Empty>
              )}
            </section>
          </>
        )}
      </main>
      {modal && (
        <Editor modal={modal} close={() => setModal(null)} done={load} />
      )}
    </div>
  );
}
