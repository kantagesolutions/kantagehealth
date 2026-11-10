-- Clinic specific request days. Existing clinics retain the current Monday through Thursday rule.
ALTER TABLE clinical.locations
  ADD COLUMN booking_open_weekdays integer[] NOT NULL DEFAULT ARRAY[1,2,3,4],
  ADD COLUMN booking_blocked_dates date[] NOT NULL DEFAULT ARRAY[]::date[];
ALTER TABLE clinical.locations ADD CONSTRAINT locations_booking_weekdays_check CHECK (
  cardinality(booking_open_weekdays) BETWEEN 1 AND 7
  AND booking_open_weekdays <@ ARRAY[0,1,2,3,4,5,6]
  AND array_position(booking_open_weekdays,NULL) IS NULL
);
ALTER TABLE clinical.locations ADD CONSTRAINT locations_booking_blocked_dates_check CHECK (
  cardinality(booking_blocked_dates) <= 366 AND array_position(booking_blocked_dates,NULL) IS NULL
);

CREATE FUNCTION clinical.booking_schedule(p_organization_id uuid,p_location_id uuid)
RETURNS TABLE(open_weekdays integer[],blocked_dates date[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT l.booking_open_weekdays,l.booking_blocked_dates FROM clinical.locations l
  WHERE l.organization_id=p_organization_id AND l.id=p_location_id;
$$;

CREATE FUNCTION clinical.booking_date_open(p_organization_id uuid,p_location_id uuid,p_date date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
  SELECT EXISTS(SELECT 1 FROM clinical.locations l
    JOIN clinical.organizations o ON o.id=l.organization_id AND o.status='active'
    WHERE l.organization_id=p_organization_id AND l.id=p_location_id AND l.status='active'
      AND extract(dow FROM p_date)::integer=ANY(l.booking_open_weekdays)
      AND NOT p_date=ANY(l.booking_blocked_dates));
$$;

CREATE FUNCTION clinical.platform_set_booking_schedule(
  p_organization_id uuid,p_location_id uuid,p_open_weekdays integer[],p_blocked_dates date[]
) RETURNS TABLE(clinic_name text,previous_weekdays integer[],previous_blocked_dates date[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,clinical AS $$
BEGIN
  IF p_open_weekdays IS NULL OR cardinality(p_open_weekdays) NOT BETWEEN 1 AND 7
     OR NOT p_open_weekdays <@ ARRAY[0,1,2,3,4,5,6]
     OR array_position(p_open_weekdays,NULL) IS NOT NULL
     OR cardinality(ARRAY(SELECT DISTINCT unnest(p_open_weekdays)))<>cardinality(p_open_weekdays)
     OR p_blocked_dates IS NULL OR cardinality(p_blocked_dates)>366
     OR array_position(p_blocked_dates,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid booking schedule' USING ERRCODE='P0001';
  END IF;
  RETURN QUERY SELECT l.name,l.booking_open_weekdays,l.booking_blocked_dates
    FROM clinical.locations l WHERE l.organization_id=p_organization_id AND l.id=p_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clinic not found' USING ERRCODE='P0001'; END IF;
  UPDATE clinical.locations SET booking_open_weekdays=p_open_weekdays,
    booking_blocked_dates=ARRAY(SELECT DISTINCT unnest(p_blocked_dates) ORDER BY 1)
    WHERE organization_id=p_organization_id AND id=p_location_id;
END; $$;

ALTER TABLE clinical.platform_audit_log DROP CONSTRAINT IF EXISTS platform_audit_log_action_check;
ALTER TABLE clinical.platform_audit_log ADD CONSTRAINT platform_audit_log_action_check CHECK (action IN (
  'organizations.create','organizations.update','organizations.suspend','organizations.activate','organizations.archive','organizations.delete',
  'clinics.create','clinics.update','clinics.deactivate','clinics.activate','clinics.schedule_update',
  'staff.invite','staff.update','staff.deactivate','staff.activate','staff.archive','staff.delete','staff.login_remove',
  'staff.password_link','staff.password_set',
  'patients.login_remove','patients.delete'
));

REVOKE ALL ON FUNCTION clinical.booking_schedule(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.booking_date_open(uuid,uuid,date) FROM PUBLIC;
REVOKE ALL ON FUNCTION clinical.platform_set_booking_schedule(uuid,uuid,integer[],date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clinical.booking_schedule(uuid,uuid) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.booking_date_open(uuid,uuid,date) TO kh_request;
GRANT EXECUTE ON FUNCTION clinical.platform_set_booking_schedule(uuid,uuid,integer[],date[]) TO kh_request;
