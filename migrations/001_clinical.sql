CREATE SCHEMA clinical;
REVOKE ALL ON SCHEMA clinical FROM PUBLIC;
GRANT USAGE ON SCHEMA clinical TO kh_request;
CREATE FUNCTION clinical.org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.current_org',true),'')::uuid $$;
CREATE FUNCTION clinical.location_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.current_location',true),'')::uuid $$;
CREATE FUNCTION clinical.actor_sub() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.actor_sub',true),'') $$;

CREATE TABLE clinical.organizations (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL, status text NOT NULL CHECK(status IN ('provisioning','active','suspended')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE clinical.locations (id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES clinical.organizations(id), name text NOT NULL, timezone text NOT NULL, address text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), UNIQUE(organization_id,id));
CREATE TABLE clinical.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES clinical.organizations(id), cognito_sub text NOT NULL, email text NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), UNIQUE(organization_id,id), UNIQUE(organization_id,cognito_sub));
CREATE TABLE clinical.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('owner','clinician','front_desk','billing','auditor')), location_id uuid, FOREIGN KEY(organization_id,user_id) REFERENCES clinical.users(organization_id,id), FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id));
CREATE UNIQUE INDEX user_roles_unique ON clinical.user_roles(organization_id,user_id,role,coalesce(location_id,'00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE clinical.patients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, first_name text NOT NULL, last_name text NOT NULL, phone text NOT NULL, email text, allergies text NOT NULL DEFAULT '', insurance text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id), FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id));
CREATE TABLE clinical.patient_locations (organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL, PRIMARY KEY(organization_id,location_id,patient_id), FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id), FOREIGN KEY(organization_id,patient_id) REFERENCES clinical.patients(organization_id,id));
CREATE TABLE clinical.care_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL, record_type text NOT NULL, note text NOT NULL DEFAULT '', provider_user_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(organization_id,location_id,patient_id) REFERENCES clinical.patient_locations(organization_id,location_id,patient_id), FOREIGN KEY(organization_id,provider_user_id) REFERENCES clinical.users(organization_id,id));
CREATE TABLE clinical.appointments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL, provider_user_id uuid NOT NULL, service text NOT NULL, start_time timestamptz NOT NULL, duration_minutes integer NOT NULL CHECK(duration_minutes BETWEEN 5 AND 480), status text NOT NULL DEFAULT 'confirmed', FOREIGN KEY(organization_id,location_id,patient_id) REFERENCES clinical.patient_locations(organization_id,location_id,patient_id), FOREIGN KEY(organization_id,provider_user_id) REFERENCES clinical.users(organization_id,id));
CREATE TABLE clinical.documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL, object_key text NOT NULL UNIQUE, name text NOT NULL, status text NOT NULL DEFAULT 'pending', content_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 20971520), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(organization_id,location_id,patient_id) REFERENCES clinical.patient_locations(organization_id,location_id,patient_id));
CREATE TABLE clinical.payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, location_id uuid NOT NULL, patient_id uuid NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents >= 0), care_code uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), description text NOT NULL, status text NOT NULL DEFAULT 'due', created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(organization_id,location_id,patient_id) REFERENCES clinical.patient_locations(organization_id,location_id,patient_id));
CREATE TABLE clinical.audit_log (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, organization_id uuid NOT NULL, location_id uuid NOT NULL, actor_user_id uuid NOT NULL, actor_role text NOT NULL, action text NOT NULL CHECK(action IN ('patients.list','patients.read','patients.create','records.read','records.create','appointments.read','appointments.create','documents.read','documents.upload','payments.read','payments.create','locations.read')), subject_type text NOT NULL, subject_id uuid, ip inet, user_agent text NOT NULL DEFAULT '', at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}', FOREIGN KEY(organization_id,location_id) REFERENCES clinical.locations(organization_id,id), FOREIGN KEY(organization_id,actor_user_id) REFERENCES clinical.users(organization_id,id));

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','locations','users','user_roles','patients','patient_locations','care_records','appointments','documents','payments','audit_log'] LOOP
  EXECUTE format('ALTER TABLE clinical.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE clinical.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['patient_locations','care_records','appointments','documents','payments','audit_log'] LOOP
  EXECUTE format('CREATE POLICY scoped ON clinical.%I USING (organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id())) WITH CHECK (organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id()))',t);
  EXECUTE format('CREATE INDEX ON clinical.%I(organization_id,location_id)',t);
 END LOOP;
END $$;
CREATE POLICY org_scope ON clinical.organizations USING(id=(SELECT clinical.org_id()));
CREATE POLICY location_scope ON clinical.locations USING(organization_id=(SELECT clinical.org_id()) AND id=(SELECT clinical.location_id()));
CREATE POLICY own_identity ON clinical.users USING(organization_id=(SELECT clinical.org_id()) AND cognito_sub=(SELECT clinical.actor_sub()));
CREATE POLICY own_roles ON clinical.user_roles USING(organization_id=(SELECT clinical.org_id()) AND user_id IN (SELECT id FROM clinical.users));
CREATE POLICY patient_read ON clinical.patients FOR SELECT USING(organization_id=(SELECT clinical.org_id()) AND (location_id=(SELECT clinical.location_id()) OR id IN (SELECT patient_id FROM clinical.patient_locations)));
CREATE POLICY patient_write ON clinical.patients FOR INSERT WITH CHECK(organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id()));
CREATE POLICY patient_update ON clinical.patients FOR UPDATE USING(organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id())) WITH CHECK(organization_id=(SELECT clinical.org_id()) AND location_id=(SELECT clinical.location_id()));
CREATE INDEX patients_scope_created_idx ON clinical.patients(organization_id,location_id,created_at DESC,id);
CREATE INDEX patient_locations_patient_idx ON clinical.patient_locations(organization_id,patient_id,location_id);
CREATE INDEX care_records_patient_occurred_idx ON clinical.care_records(organization_id,location_id,patient_id,occurred_at DESC);
CREATE INDEX appointments_patient_start_idx ON clinical.appointments(organization_id,location_id,patient_id,start_time DESC);
CREATE INDEX documents_patient_created_idx ON clinical.documents(organization_id,location_id,patient_id,created_at DESC);
CREATE INDEX payments_patient_created_idx ON clinical.payments(organization_id,location_id,patient_id,created_at DESC);
CREATE INDEX audit_log_scope_at_idx ON clinical.audit_log(organization_id,location_id,at DESC);
GRANT SELECT ON ALL TABLES IN SCHEMA clinical TO kh_request;
GRANT INSERT, UPDATE ON clinical.patients,clinical.patient_locations,clinical.care_records,clinical.appointments,clinical.documents,clinical.payments TO kh_request;
GRANT INSERT ON clinical.audit_log TO kh_request;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA clinical TO kh_request;
REVOKE UPDATE,DELETE,TRUNCATE ON clinical.audit_log FROM kh_request;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA clinical FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA clinical FROM PUBLIC;
