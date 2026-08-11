-- ============================================================
-- 20260811000002_tenants_address.sql
-- R-A1(3.1-04):tenants 增加医院地址 / 详细地址列
-- 仅新增可空列,不触碰既有数据;address 存医院门牌/主地址,detail_address 存补充说明
-- ============================================================
alter table public.tenants
  add column if not exists address text,
  add column if not exists detail_address text;

comment on column public.tenants.address is '医院地址(主地址,如门牌号/街道)';
comment on column public.tenants.detail_address is '医院详细地址(补充说明,如楼栋/楼层)';
