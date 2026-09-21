-- SaaS operations layer. Existing clinical tables remain location-scoped;
-- these tables add the control-plane concepts required by organizations with
-- one or many clinics.

ALTER TABLE clinical.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE clinical.user_roles ADD CONSTRAINT user_roles_role_check CHECK(role IN (
  'owner','clinician','front_desk','billing','auditor',
  'organization_owner','clinic_administrator','provider','hygienist_assistant','billing_specialist','kantage_support'
));

CREATE TABLE clinical.capabilities (
  key text PRIMARY KEY,
  description text NOT NULL
);
CREATE TABLE clinical.role_capabilities (
  role text NOT NULL,
  capability_key text NOT NULL REFERENCES clinical.capabilities(key),
  PRIMARY KEY(role,capability_key)
);
CREATE TABLE clinical.user_capabilities (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  location_id uuid,
  capability_key text NOT NULL REFERENCES clinical.capabilities(key),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id,location_id,capability_key),
  FOREIGN KEY(organization_id,user_id) REFERENCES clinical.users(organization_id,id),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id)
);

INSERT INTO clinical.capabilities(key,description) VALUES
 ('patients.read','Read operational patient information'),('patients.edit','Create and edit operational patient information'),
 ('clinical.read','Read treatment notes'),('clinical.write','Create treatment notes'),
 ('schedule.read','View schedules'),('schedule.manage','Manage appointments and availability'),
 ('payments.read','View financial records'),('payments.manage','Create and manage payment arrangements'),
 ('documents.read','View documents'),('documents.upload','Upload documents'),
 ('team.manage','Manage clinic staff access'),('organization.manage','Manage organization and clinic configuration'),
 ('audit.read','View audit history'),('support.break_glass','Request audited, time-limited support access')
ON CONFLICT(key) DO NOTHING;

INSERT INTO clinical.role_capabilities(role,capability_key)
SELECT role,key FROM (VALUES
 ('owner'),('organization_owner'),('clinic_administrator')
) roles(role) CROSS JOIN clinical.capabilities
ON CONFLICT DO NOTHING;
INSERT INTO clinical.role_capabilities(role,capability_key) VALUES
 ('clinician','patients.read'),('clinician','patients.edit'),('clinician','clinical.read'),('clinician','clinical.write'),('clinician','schedule.read'),
 ('provider','patients.read'),('provider','patients.edit'),('provider','clinical.read'),('provider','clinical.write'),('provider','schedule.read'),
 ('hygienist_assistant','patients.read'),('hygienist_assistant','clinical.read'),('hygienist_assistant','clinical.write'),('hygienist_assistant','schedule.read'),('hygienist_assistant','documents.upload'),
 ('front_desk','patients.read'),('front_desk','patients.edit'),('front_desk','schedule.read'),('front_desk','schedule.manage'),('front_desk','documents.upload'),
 ('billing','patients.read'),('billing','payments.read'),('billing','payments.manage'),
 ('billing_specialist','patients.read'),('billing_specialist','payments.read'),('billing_specialist','payments.manage'),
 ('auditor','audit.read'),('kantage_support','support.break_glass')
ON CONFLICT DO NOTHING;

CREATE TABLE clinical.organization_members (
  organization_id uuid NOT NULL REFERENCES clinical.organizations(id),
  user_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES clinical.users(organization_id,id)
);
CREATE TABLE clinical.location_members (
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  user_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,location_id,user_id),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES clinical.users(organization_id,id)
);
CREATE TABLE clinical.providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
  user_id uuid NOT NULL, display_name text NOT NULL, active boolean NOT NULL DEFAULT true,
  UNIQUE(organization_id,id), UNIQUE(organization_id,location_id,user_id),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES clinical.users(organization_id,id)
);
CREATE TABLE clinical.operatories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
  name text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(organization_id,id), UNIQUE(organization_id,location_id,name),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id)
);
CREATE TABLE clinical.appointment_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
  name text NOT NULL, duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480), active boolean NOT NULL DEFAULT true,
  UNIQUE(organization_id,id), UNIQUE(organization_id,location_id,name),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id)
);
CREATE TABLE clinical.office_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
  day_of_week integer NOT NULL CHECK(day_of_week BETWEEN 0 AND 6), opens_at time, closes_at time,
  UNIQUE(organization_id,location_id,day_of_week), FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id)
);
CREATE TABLE clinical.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents >= 0), balance_cents bigint NOT NULL CHECK(balance_cents >= 0), status text NOT NULL DEFAULT 'open' CHECK(status IN ('draft','open','paid','void')),
  due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,location_id,patient_id) REFERENCES clinical.patient_locations(organization_id,location_id,patient_id)
);
CREATE TABLE clinical.payment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents > 0), installment_cents bigint NOT NULL CHECK(installment_cents > 0), cadence text NOT NULL CHECK(cadence IN ('weekly','monthly')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','paused','completed','cancelled')), provider_reference text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,location_id,patient_id) REFERENCES clinical.patient_locations(organization_id,location_id,patient_id)
);
CREATE TABLE clinical.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL,
  title text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')), assigned_user_id uuid, due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id), FOREIGN KEY(organization_id,assigned_user_id) REFERENCES clinical.users(organization_id,id)
);
CREATE TABLE clinical.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES clinical.organizations(id),
  plan text NOT NULL DEFAULT 'base' CHECK(plan IN ('base','base_ai')), location_quantity integer NOT NULL DEFAULT 1 CHECK(location_quantity > 0),
  monthly_amount_cents bigint NOT NULL DEFAULT 19900 CHECK(monthly_amount_cents >= 0), provider_customer_reference text UNIQUE, status text NOT NULL DEFAULT 'active' CHECK(status IN ('trial','active','past_due','cancelled')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE clinical.support_access_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES clinical.organizations(id), location_id uuid,
  requested_by_user_id uuid NOT NULL, support_user_sub text NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','expired','revoked')), starts_at timestamptz, expires_at timestamptz, approved_by_user_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id), FOREIGN KEY(organization_id,requested_by_user_id) REFERENCES clinical.users(organization_id,id), FOREIGN KEY(organization_id,approved_by_user_id) REFERENCES clinical.users(organization_id,id)
);

ALTER TABLE clinical.documents ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE clinical.documents ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'uploaded_record' CHECK(document_kind IN ('intake_form','insurance_card','identity','consent','treatment','uploaded_record','practice'));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['location_members','providers','operatories','appointment_types','office_hours','invoices','payment_plans','tasks'] LOOP
  EXECUTE format('ALTER TABLE clinical.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE clinical.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY scoped ON clinical.%I USING (organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id())) WITH CHECK (organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id()))',t);
  EXECUTE format('CREATE INDEX ON clinical.%I(organization_id,location_id)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['organization_members','user_capabilities','subscriptions','support_access_sessions'] LOOP
  EXECUTE format('ALTER TABLE clinical.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE clinical.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY org_scoped ON clinical.%I USING (organization_id=(SELECT clinical.org_id())) WITH CHECK (organization_id=(SELECT clinical.org_id()))',t);
 END LOOP;
END $$;

GRANT SELECT ON ALL TABLES IN SCHEMA clinical TO kh_request;
GRANT INSERT,UPDATE ON clinical.organization_members,clinical.location_members,clinical.providers,clinical.operatories,clinical.appointment_types,clinical.office_hours,clinical.invoices,clinical.payment_plans,clinical.tasks,clinical.user_capabilities,clinical.support_access_sessions TO kh_request;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA clinical TO kh_request;
