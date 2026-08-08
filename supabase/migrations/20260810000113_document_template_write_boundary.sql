-- ============================================================
-- S32-C FIX: 文档模板写入边界收口(Documents Security, P0-A)
-- ------------------------------------------------------------
-- 审计问题(S3.2-Final-Full-Code-Audit #28~#37):
--   1. document_templates 对 authenticated 开放 INSERT/UPDATE/DELETE,
--      可绕过 Hono validateTemplateHtml() 直接写恶意 HTML → Stored XSS;
--   2. document_history SELECT 无 documents.view 权限要求,普通租户成员
--      可看到职责外的文档历史索引;
--   3. 历史未保存渲染快照哈希,合规重放无法校验内容一致性。
--
-- 修复:
--   1. 收回 document_templates 的 authenticated INSERT/UPDATE/DELETE 策略,
--      仅保留 SELECT;模板写入只能经 Hono(service role)完成;
--   2. document_history SELECT 追加 documents.view 权限要求;
--   3. document_history 新增 render_hash(渲染 HTML SHA-256),渲染/打印时写入。
-- ============================================================

set search_path = public;

-- ===== 1. document_templates:收回 authenticated 写策略 =====
-- 系统默认模板(tenant_id is null)本就只读;现在租户/门店模板也统一只读,
-- 写入一律经 Hono Command(service role),保证 validateTemplateHtml 不可被绕过。
drop policy if exists "document_templates_insert" on public.document_templates;
drop policy if exists "document_templates_update" on public.document_templates;
drop policy if exists "document_templates_delete" on public.document_templates;

comment on table public.document_templates is
  '业务文档模板。写入仅允许经 Hono(service role)执行,authenticated 只读,防止绕过 HTML 净化校验。';

-- ===== 2. document_history:SELECT 追加 documents.view 权限 =====
-- 仅拥有 documents.view 的租户成员可读取历史索引(门店范围仍收敛)。
drop policy if exists "document_history_select" on public.document_history;
create policy "document_history_select" on public.document_history
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, store_id, 'documents.view')
    and (store_id is null or public.can_access_store(tenant_id, store_id))
  );

-- ===== 3. document_history:渲染快照哈希(合规重放校验) =====
alter table public.document_history
  add column if not exists render_hash text;

comment on column public.document_history.render_hash is
  '渲染结果 HTML 的 SHA-256(十六进制),用于后续版本重建/合规校验';
