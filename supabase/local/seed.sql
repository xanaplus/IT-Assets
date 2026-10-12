-- Local test data, loaded after schema.sql by `npm run db:start` / `db:reset`.
-- Nothing here comes from production rows: choices replay the repo's
-- migrations (0008, 0012, 0018, 0027, 0034) and assets are the committed
-- golden-test fixture (scanner-app/test/fixtures/assets.json).

-- Storage buckets (0005, 0025)
insert into storage.buckets (id, name, public) values
  ('asset-images', 'asset-images', true),
  ('it-documents', 'it-documents', true)
on conflict (id) do nothing;

-- Dropdown choices, final state after the migrations
insert into public.app_choices (category, value, sort_order) values
  ('asset_type','Laptop',1), ('asset_type','CPU',3), ('asset_type','Monitor',4),
  ('asset_type','Printer',5), ('asset_type','Scanner',6), ('asset_type','Mouse',7),
  ('asset_type','Keyboard',8), ('asset_type','Phone',9), ('asset_type','POS',10),
  ('asset_type','Cash Drawer',11), ('asset_type','Scale',12), ('asset_type','Speaker/Mic',13),
  ('asset_type','Router',14), ('asset_type','Switch',15), ('asset_type','UNVR',16),
  ('asset_type','Tablet',17), ('asset_type','Server',18), ('asset_type','Tower',19),
  ('status','In Use',1), ('status','Available',2), ('status','Retired',3),
  ('status','Left With',4), ('status','Lost',5),
  ('status','In Repair',6), ('status','Under Investigation',7),
  ('location','Syokimau',1), ('location','Katani',2), ('location','Ruiru',3),
  ('location','Githurai',4), ('location','Lumumba Dr',5), ('location','TRM Dr',6),
  ('region','Nairobi',1), ('region','Kiambu',2),
  ('department','Pharmacy',1), ('department','IT',2), ('department','Operations',3),
  ('department','Finance and Admin',4), ('department','Back Office',5),
  ('department','Project Management',6), ('department','Marketing',7), ('department','C-Suite',8)
on conflict (category, value) do nothing;

update public.app_choices c set useful_life = v.years
from (values
  ('Laptop', 3), ('CPU', 4), ('Monitor', 5), ('Printer', 4), ('Scanner', 4), ('Phone', 3),
  ('POS', 5), ('Cash Drawer', 8), ('Scale', 8), ('Speaker/Mic', 5), ('Router', 5),
  ('Switch', 5), ('UNVR', 5), ('Keyboard', 3), ('Mouse', 2)
) as v(value, years)
where c.category = 'asset_type' and c.value = v.value;

-- Assets: fixture rows plus local-only price, purchase date, department and a
-- spread of statuses (the live schema requires a price or "estimate pending").
insert into public.assets (item_id, title, asset_tag, asset_type, model, serial, employee, status, location, extra) values
  ('LOCAL-1', 'MICL0045', 'MICL0045', 'Laptop', 'Lenovo L13', 'PW0MGGLA', 'Roystone Licha Were', 'In Use', 'Syokimau', '{"purchase_price":"95000","department":"IT","purchase_date":"2021-01-15","warranty_months":"24","region":"Nairobi","condition":"new","last_verified":"2026-08-11T09:02:43.0000000Z"}'::jsonb),
  ('LOCAL-4', 'MICL0046', 'MICL0046', 'CPU', 'HP Prodesk 600 G6Microtower', 'MXL2153DKN', 'TRM drive Pharmacy', 'In Use', 'TRM Dr', '{"purchase_price":"68000","department":"Pharmacy","purchase_date":"2022-06-15","warranty_months":"24","region":"Nairobi","condition":"New and working"}'::jsonb),
  ('LOCAL-5', 'XL-L005', 'XL-L005', 'Monitor', 'Dell p2419p', '4P09PF3', 'TRM drive Pharmacy', 'In Use', 'TRM Dr', '{"purchase_price":"21000","department":"Operations","purchase_date":"2023-11-15","warranty_months":"24","region":"Nairobi","condition":"New and Working"}'::jsonb),
  ('LOCAL-6', 'MICL0047', 'MICL0047', 'CPU', 'HP Prodesk 400 G67 Microtower', 'CZC2067JQT', 'Server Room', 'In Use', 'Syokimau', '{"purchase_price":"68000","department":"Finance and Admin","purchase_date":"2024-04-15","warranty_months":"24","region":"Nairobi","condition":"New and Working","last_verified":"2026-08-11T09:03:47.0000000Z"}'::jsonb),
  ('LOCAL-7', 'XL-L007', 'XL-L007', 'Monitor', 'Dell P2018H ', 'CN-09094X', 'Server Room', 'In Use', 'Syokimau', '{"department":"Back Office","purchase_date":"2025-09-15","warranty_months":"24","region":"Nairobi","condition":"New ","estimate_pending":"true"}'::jsonb),
  ('LOCAL-8', 'XL-L008', 'XL-L008', 'CPU', 'HP Pro Tower 290', '4CE514B42Q', 'Server Room ', 'Available', 'Syokimau', '{"purchase_price":"68000","department":"IT","purchase_date":"2021-02-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb),
  ('LOCAL-9', 'XL-L009', 'XL-L009', 'Monitor', 'HP p24v G6', 'CNK4260PDW', 'Server Room', 'In Use', 'Syokimau', '{"purchase_price":"21000","department":"Pharmacy","purchase_date":"2022-07-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb),
  ('LOCAL-10', 'XL-L010', 'XL-L010', 'CPU', 'HP Pro Tower 290 G9 Desktop PC', '4CE547DHGJ', 'Githurai Pharmacy', 'In Use', 'Githurai', '{"purchase_price":"68000","department":"Operations","purchase_date":"2023-12-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb),
  ('LOCAL-11', 'XL-L011', 'XL-L011', 'Monitor', 'HP TPA-L001K', '3C053010L', 'Erastus Maina', 'In Use', 'Ruiru', '{"purchase_price":"21000","department":"Finance and Admin","purchase_date":"2024-05-15","warranty_months":"24","region":"Kiambu","condition":"New"}'::jsonb),
  ('LOCAL-12', 'XL-L012', 'XL-L012', 'Mouse', 'HP TPAD001M', '9CT54104Q2', 'Erastus Maina', 'In Use', 'Ruiru', '{"purchase_price":"1500","department":"Back Office","purchase_date":"2025-10-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-13', 'XL-L013', 'XL-L013', 'CPU', 'HP Pro Tower 400 G9 PCI Desktop PC', '4CE543C751', 'Erastus Maina', 'In Use', 'Ruiru', '{"purchase_price":"68000","department":"IT","purchase_date":"2021-03-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-14', 'XL-L014', 'XL-L014', 'Keyboard', 'Hp TPA-L001K', null, 'Erastus Maina', 'In Repair', 'Ruiru', '{"purchase_price":"2500","department":"Pharmacy","purchase_date":"2022-08-15","warranty_months":"24","region":"Kiambu","condition":"New"}'::jsonb),
  ('LOCAL-15', 'XL-L015', 'XL-L015', 'Monitor', 'HP Pro Tower 400 G9 PCI Desktop', '3CM5370401', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"purchase_price":"21000","department":"Operations","purchase_date":"2023-01-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-16', 'XL-L016', 'XL-L016', 'Mouse', 'HP', '9CP536240Z', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"department":"Finance and Admin","purchase_date":"2024-06-15","warranty_months":"24","region":"Kiambu","estimate_pending":"true"}'::jsonb),
  ('LOCAL-17', 'XL-L017', 'XL-L017', 'Keyboard', 'HP', '9CP541RLNV', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"purchase_price":"2500","department":"Back Office","purchase_date":"2025-11-15","warranty_months":"24","region":"Kiambu","condition":"New"}'::jsonb),
  ('LOCAL-18', 'XL-L018', 'XL-L018', 'CPU', 'HP Pro Tower 400 G9 PCI Desktop PC', '4CE543BWTT', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"purchase_price":"68000","department":"IT","purchase_date":"2021-04-15","warranty_months":"24","region":"Kiambu","condition":"New"}'::jsonb),
  ('LOCAL-19', 'XL-L019', 'XL-L019', 'Monitor', 'HP M24fw', '3CM3301605SN', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"purchase_price":"21000","department":"Pharmacy","purchase_date":"2022-09-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-20', 'XL-L020', 'XL-L020', 'Mouse', 'HP', '9CP3507YCP', 'Ruiru Pharmacy', 'Retired', 'Ruiru', '{"purchase_price":"1500","department":"Operations","purchase_date":"2023-02-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-21', 'XL-L021', 'XL-L021', 'Keyboard', 'HP TPA-P001K', '9CP541RLNX', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"purchase_price":"2500","department":"Finance and Admin","purchase_date":"2024-07-15","warranty_months":"24","region":"Kiambu"}'::jsonb),
  ('LOCAL-22', 'XL-L022', 'XL-L022', 'CPU', 'Hp Desktop 290 G9', '4CE449C38Q', 'Ruiru Pharmacy', 'In Use', 'Ruiru', '{"purchase_price":"68000","department":"Back Office","purchase_date":"2025-12-15","warranty_months":"24","region":"Kiambu","condition":"New"}'::jsonb),
  ('LOCAL-23', 'XL-L023', 'XL-L023', 'Monitor', 'HP v22v', '3CQ53102Q3', 'Ruiru Customer Service', 'In Use', 'Ruiru', '{"purchase_price":"21000","department":"IT","purchase_date":"2021-05-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-24', 'XL-L024', 'XL-L024', 'Mouse', 'HP TPAP001M', '9CP536240Y', 'Ruiru Customer Service', 'In Use', 'Ruiru', '{"purchase_price":"1500","department":"Pharmacy","purchase_date":"2022-10-15","warranty_months":"24","region":"Kiambu"}'::jsonb),
  ('LOCAL-25', 'XL-L025', 'XL-L025', 'Keyboard', 'HP TPA-D005K', '9CT422013V', 'Ruiru Customer Service', 'In Use', 'Ruiru', '{"department":"Operations","purchase_date":"2023-03-15","warranty_months":"24","region":"Kiambu","condition":"new","estimate_pending":"true"}'::jsonb),
  ('LOCAL-26', 'XL-L026', 'XL-L026', 'CPU', 'Hp Desktop 290 G9', 'CZC4387SLF', 'Ruiru Customer Service', 'Lost', 'Ruiru', '{"purchase_price":"68000","department":"Finance and Admin","purchase_date":"2024-08-15","warranty_months":"24","region":"Kiambu","condition":"new"}'::jsonb),
  ('LOCAL-27', 'XL-L027', 'XL-L027', 'CPU', 'Lenovo 10TV002VUM', 'PC152NPW', 'Syokimau Back Office', 'In Use', 'Syokimau', '{"purchase_price":"68000","department":"Back Office","purchase_date":"2025-01-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb),
  ('LOCAL-28', 'XL-L028', 'XL-L028', 'Monitor', 'HP P24V', 'CNK4260PDZ', 'Syokimau Back Office ', 'In Use', 'Syokimau', '{"purchase_price":"21000","department":"IT","purchase_date":"2021-06-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-29', 'XL-L029', 'XL-L029', 'Keyboard', 'Lenovo KUI601', '3557423', 'Syokimau Back Office ', 'In Use', 'Syokimau', '{"purchase_price":"2500","department":"Pharmacy","purchase_date":"2022-11-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-30', 'XL-L030', 'XL-L030', 'Mouse', 'Lenovo', '00BEHFL', 'Syokimau Back Office', 'In Use', 'Syokimau', '{"purchase_price":"1500","department":"Operations","purchase_date":"2023-04-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-31', 'XL-L031', 'XL-L031', 'CPU', 'HP Pro Tower 290 E PCI', '4CE543C7F8', 'Pharmacy Procurement', 'In Use', 'Syokimau', '{"purchase_price":"68000","department":"Finance and Admin","purchase_date":"2024-09-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-32', 'XL-L032', 'XL-L032', 'Monitor', 'HP24V G5', 'CNK4260PD6', 'Pharmacy Procurement', 'Left With', 'Syokimau', '{"purchase_price":"21000","department":"Back Office","purchase_date":"2025-02-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-33', 'XL-L033', 'XL-L033', 'Keyboard', 'TPA-P001K', null, 'Pharmacy Procurement', 'In Use', 'Syokimau', '{"purchase_price":"2500","department":"IT","purchase_date":"2021-07-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-34', 'XL-L034', 'XL-L034', 'Mouse', 'TPA-P001N', '9CP5362LOY', 'Pharmacy Procurement', 'In Use', 'Syokimau', '{"department":"Pharmacy","purchase_date":"2022-12-15","warranty_months":"24","region":"Nairobi","condition":"New","estimate_pending":"true"}'::jsonb),
  ('LOCAL-35', 'XL-L035', 'XL-L035', 'CPU', 'HP Pro Tower 290 G9 ', '4CE513D1TG', 'Syokimau Procurement', 'In Use', 'Syokimau', '{"purchase_price":"68000","department":"Operations","purchase_date":"2023-05-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb),
  ('LOCAL-36', 'XL-L036', 'XL-L036', 'Monitor', 'HP P24 G5', '1H3414057M', 'Syokimau Procurement', 'In Use', 'Syokimau', '{"purchase_price":"21000","department":"Finance and Admin","purchase_date":"2024-10-15","warranty_months":"24","region":"Nairobi"}'::jsonb),
  ('LOCAL-37', 'XL-L037', 'XL-L037', 'Keyboard', 'TPA-P001K HP ', null, 'Syokimau Procurement', 'In Use', 'Syokimau', '{"purchase_price":"2500","department":"Back Office","purchase_date":"2025-03-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb),
  ('LOCAL-38', 'XL-L038', 'XL-L038', 'Mouse', 'HP', null, 'Syokimau Procurement', 'Under Investigation', 'Syokimau', '{"purchase_price":"1500","department":"IT","purchase_date":"2021-08-15","warranty_months":"24","region":"Nairobi","condition":"New"}'::jsonb)
on conflict (item_id) do nothing;
