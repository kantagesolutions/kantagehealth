-- Workforce identities use immutable Cognito usernames. Patient identities remain tied to patient pool subjects.
UPDATE clinical.users
SET cognito_sub = 'dentalemsstaff'
WHERE lower(email) = 'staff@kantage.solutions'
  AND cognito_sub <> 'dentalemsstaff';
