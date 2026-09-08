-- Synthetic test data only. Loaded exclusively into a disposable cluster.
BEGIN;
CREATE SCHEMA test_support;
CREATE FUNCTION test_support.tid(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
CREATE FUNCTION test_support.assert(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS
  $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%',message; END IF; END $$;
SET search_path=gocoach,test_support,public;
INSERT INTO workspaces(id,slug,name) VALUES(tid(1),'test-one','Test practice'),(tid(2),'test-two','Other practice');
INSERT INTO buyers(workspace_id,id,company,contact_name,contact_email,billing_email) VALUES
  (tid(1),tid(10),'Acme','Buyer A','buyer@acme.example','billing@acme.example'),
  (tid(1),tid(11),'Other Company','Buyer B','buyer@other.example','billing@other.example'),
  (tid(2),tid(12),'Other Tenant','Buyer C','buyer@tenant.example','billing@tenant.example');
INSERT INTO users(workspace_id,id,name,email,role,buyer_id) VALUES
  (tid(1),tid(20),'Coach','coach@example.test','coach',NULL),
  (tid(1),tid(21),'Buyer A','buyer@acme.example','buyer',tid(10)),
  (tid(1),tid(22),'Alex','alex@example.test','participant',NULL),
  (tid(1),tid(23),'Jamie','jamie@example.test','participant',NULL),
  (tid(1),tid(24),'Buyer B','buyer@other.example','buyer',tid(11)),
  (tid(1),tid(25),'Taylor','taylor@example.test','participant',NULL),
  (tid(1),tid(26),'Second Coach','coach2@example.test','coach',NULL),
  (tid(2),tid(20),'Other tenant coach','coach@example.test','coach',NULL);
INSERT INTO cohorts(workspace_id,id,buyer_id,name,starts_on,ends_on,time_zone,capacity,price_minor,status) VALUES
  (tid(1),tid(30),tid(10),'Acme program','2030-01-01','2030-04-01','America/Chicago',7,10000,'active'),
  (tid(1),tid(31),tid(11),'Other program','2030-01-01','2030-04-01','America/Chicago',7,10000,'active'),
  (tid(1),tid(32),tid(10),'Capacity race','2030-01-01','2030-04-01','America/Chicago',2,10000,'enrolling');
INSERT INTO cohort_coaches(workspace_id,cohort_id,coach_id,is_lead) VALUES(tid(1),tid(30),tid(20),true);
INSERT INTO enrollments(workspace_id,cohort_id,participant_id,status) VALUES
  (tid(1),tid(30),tid(22),'enrolled'),(tid(1),tid(30),tid(23),'enrolled'),
  (tid(1),tid(31),tid(25),'enrolled'),(tid(1),tid(32),tid(25),'enrolled');
INSERT INTO reports(workspace_id,id,cohort_id,participant_id,author_id,kind,title,highlights,progress,next_steps,status,share_buyer) VALUES
  (tid(1),tid(50),tid(30),tid(22),tid(20),'coach-evaluation','Alex progress','Clear communication','Growing confidence','Practice delegation','published',true),
  (tid(1),tid(51),tid(30),tid(22),tid(20),'coach-evaluation','Draft evaluation','DRAFT SECRET','','','draft',true),
  (tid(1),tid(52),tid(30),tid(22),tid(20),'coach-evaluation','Private evaluation','PRIVATE SECRET','','','published',false),
  (tid(1),tid(53),tid(30),tid(22),tid(22),'reflection','My reflection','SELF REFLECTION','','','published',true),
  (tid(1),tid(54),tid(31),tid(25),tid(20),'coach-evaluation','Other buyer evaluation','OTHER BUYER SECRET','','','published',true),
  (tid(1),tid(55),tid(30),NULL,tid(20),'cohort','Cohort summary','Shared cohort progress','','','published',true);
INSERT INTO invoices(workspace_id,id,cohort_id,buyer_id,number,title,subtotal_minor,total_minor,due_on) VALUES
  (tid(1),tid(60),tid(30),tid(10),'GC-2030-001','Program',10000,10000,'2030-02-01'),
  (tid(1),tid(61),tid(30),tid(10),'GC-2030-002','Payment race',10000,10000,'2030-02-01');
INSERT INTO invoice_lines(workspace_id,invoice_id,position,description,unit_price_minor) VALUES
  (tid(1),tid(60),1,'Program',10000),(tid(1),tid(61),1,'Program',10000);
UPDATE invoices SET status='issued';
INSERT INTO sessions(workspace_id,id,cohort_id,coach_id,title,kind,status,starts_at,duration_minutes,time_zone) VALUES
  (tid(1),tid(70),tid(30),tid(20),'Session one','cohort','scheduled','2030-01-08T16:00Z',90,'America/Chicago');
INSERT INTO availability_polls(workspace_id,id,cohort_id,title,deadline) VALUES
  (tid(1),tid(80),tid(30),'Best time','2029-12-01T00:00Z'),
  (tid(1),tid(140),tid(31),'Other poll','2029-12-01T00:00Z');
INSERT INTO poll_slots(workspace_id,id,poll_id,position,starts_at)
  SELECT tid(1),tid(81+n),tid(80),n,'2030-01-01T15:00Z'::timestamptz+n*interval '1 day' FROM generate_series(0,4) n;
INSERT INTO poll_slots(workspace_id,id,poll_id,position,starts_at)
  SELECT tid(1),tid(141+n),tid(140),n,'2030-01-01T15:00Z'::timestamptz+n*interval '1 day' FROM generate_series(0,4) n;
INSERT INTO poll_responses(workspace_id,poll_id,cohort_id,participant_id) VALUES(tid(1),tid(80),tid(30),tid(22));
INSERT INTO poll_choices(workspace_id,poll_id,participant_id,slot_id,rank)
  SELECT tid(1),tid(80),tid(22),tid(81+n),n+1 FROM generate_series(0,4) n;
INSERT INTO surveys(workspace_id,id,cohort_id,title,stage,status,deadline) VALUES
  (tid(1),tid(100),tid(30),'Baseline','pre','open','2030-01-01T00:00Z');
INSERT INTO survey_questions(workspace_id,id,survey_id,position,prompt) VALUES
  (tid(1),tid(101),tid(100),0,'Confidence?'),(tid(1),tid(102),tid(100),1,'Communication?');
INSERT INTO survey_responses(workspace_id,survey_id,cohort_id,participant_id,reflection) VALUES
  (tid(1),tid(100),tid(30),tid(22),'PRIVATE SURVEY REFLECTION');
INSERT INTO survey_answers(workspace_id,survey_id,participant_id,question_id,rating) VALUES
  (tid(1),tid(100),tid(22),tid(101),4),(tid(1),tid(100),tid(22),tid(102),3);
INSERT INTO file_objects(workspace_id,id,storage_backend,object_key,original_name,mime_type,size_bytes,scan_status) VALUES
  (tid(1),tid(110),'local','test/resource.pdf','resource.pdf','application/pdf',100,'clean');
INSERT INTO documents(workspace_id,id,cohort_id,participant_id,file_id,uploaded_by,title,scope) VALUES
  (tid(1),tid(111),tid(30),NULL,tid(110),tid(20),'Shared','cohort'),
  (tid(1),tid(112),tid(30),NULL,tid(110),tid(20),'Buyer only','buyer'),
  (tid(1),tid(113),tid(30),NULL,tid(110),tid(20),'Private','private'),
  (tid(1),tid(114),tid(30),tid(22),tid(110),tid(20),'Alex only','individual'),
  (tid(1),tid(115),tid(30),tid(23),tid(110),tid(20),'Jamie only','individual');
INSERT INTO contracts(workspace_id,id,cohort_id,buyer_id,title,terms,amount_minor,program_name,company_name,starts_on,ends_on,status,content_hash,requested_at)
  VALUES(tid(1),tid(120),tid(30),tid(10),'Agreement','Agreed terms',10000,'Acme program','Acme','2030-01-01','2030-04-01','in-review',repeat('a',64),now());
CREATE ROLE gocoach_test_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA gocoach,test_support TO gocoach_test_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA gocoach TO gocoach_test_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA gocoach,test_support TO gocoach_test_runtime;
COMMIT;
